import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  UIEvent as ReactUIEvent,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { open } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import {
  IPC_VERSION,
  KubernetesEventItem,
  KubernetesClusterOverviewResponse,
  KubeconfigContext,
  KubeconfigListResponse,
  KubeconfigSource,
  KubectlInstallation,
  KubectlRunResponse,
  KubernetesGetResourceDetailResponse,
  KubernetesListNamespacesResponse,
  KubernetesListMetricsResponse,
  KubernetesListResourcesResponse,
  NamespaceItem,
  ResourceItem,
  ResourceMetricItem,
  ResourceKindItem,
} from "./contracts";
import { createTransport } from "./transport";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const transport = createTransport();
const RESOURCE_ROW_HEIGHT = 44;
const RESOURCE_VIRTUAL_OVERSCAN = 8;
const RESOURCE_VIRTUAL_THRESHOLD = 80;

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object") {
    const value = reason as { code?: unknown; message?: unknown };
    if (typeof value.message === "string") {
      return typeof value.code === "string" ? `${value.code}: ${value.message}` : value.message;
    }
    try {
      return JSON.stringify(reason);
    } catch {
      return "Unknown backend error";
    }
  }
  return String(reason);
}

function parseCommandArguments(value: string): string[] {
  const argumentsList: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        argumentsList.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Command contains an unterminated quote");
  if (current) argumentsList.push(current);
  return argumentsList;
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodeUtf8Base64(value: string): string | undefined {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function yamlKey(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : JSON.stringify(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function updateSecretDataYaml(yaml: string, data: Array<{ name: string; value: string }>): string {
  const dataBlock = [
    "data:",
    ...data.map((item) => `  ${yamlKey(item.name)}: ${item.value}`),
  ];
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const dataIndex = lines.findIndex((line) => line === "data:");
  if (dataIndex >= 0) {
    let endIndex = dataIndex + 1;
    while (endIndex < lines.length && (/^\s+/.test(lines[endIndex]) || lines[endIndex] === "")) {
      endIndex += 1;
    }
    lines.splice(dataIndex, endIndex - dataIndex, ...dataBlock);
    return lines.join("\n").replace(/\n*$/, "\n");
  }
  const withoutTrailingBlanks = lines.filter((line, index) => line !== "" || index < lines.length - 1);
  return [...withoutTrailingBlanks, ...dataBlock, ""].join("\n");
}

function updateConfigMapDataYaml(yaml: string, data: Array<{ name: string; value: string }>): string {
  const dataBlock = [
    "data:",
    ...data.map((item) => `  ${yamlKey(item.name)}: ${yamlString(item.value)}`),
  ];
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const dataIndex = lines.findIndex((line) => line === "data:");
  if (dataIndex >= 0) {
    let endIndex = dataIndex + 1;
    while (endIndex < lines.length && (/^\s+/.test(lines[endIndex]) || lines[endIndex] === "")) {
      endIndex += 1;
    }
    lines.splice(dataIndex, endIndex - dataIndex, ...dataBlock);
    return lines.join("\n").replace(/\n*$/, "\n");
  }
  const withoutTrailingBlanks = lines.filter((line, index) => line !== "" || index < lines.length - 1);
  return [...withoutTrailingBlanks, ...dataBlock, ""].join("\n");
}

function normalizeKubeconfigSource(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function uniqueKubeconfigSources(sources: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources.map(normalizeKubeconfigSource).filter(Boolean)) {
    const key = source.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

const FAVORITES_GROUP_LABEL = "Favorites";

const RESOURCE_GROUPS = [
  {
    label: "Cluster",
    kinds: ["Node"],
  },
  {
    label: "Workloads",
    kinds: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"],
  },
  {
    label: "Network",
    kinds: ["Service", "Ingress"],
  },
  {
    label: "Config",
    kinds: ["ConfigMap", "Secret"],
  },
  {
    label: "Storage",
    kinds: ["PersistentVolumeClaim", "PersistentVolume"],
  },
];

type NavigationIcon = "overview" | "events" | "favorites" | "cluster" | "workloads" | "network" | "config" | "storage" | "more" | "collapseAll" | "expandAll";
type ActiveView = "contexts" | "overview" | "events" | "health" | "resources";
type ContextDisplayMode = "list" | "grid";

const GROUP_ICONS: Record<string, NavigationIcon> = {
  Favorites: "favorites",
  Cluster: "cluster",
  Workloads: "workloads",
  Network: "network",
  Config: "config",
  Storage: "storage",
  "More Resources": "more",
};

function NavigationIcon({ name }: { name: NavigationIcon }) {
  const paths: Record<NavigationIcon, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    events: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
    favorites: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>,
    cluster: <><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M10.8 7.2 6.3 15.8M13.2 7.2l4.5 8.6M7.5 18h9"/></>,
    workloads: <><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z"/><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5"/></>,
    network: <><circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="m7 11 10-5M7 13l10 5"/></>,
    config: <><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="18" r="2"/></>,
    storage: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    more: <><path d="M9 3h6l1 3 3 1v6l-3 1-1 3H9l-1-3-3-1V7l3-1 1-3Z"/><circle cx="12" cy="10" r="2"/><path d="M12 12v5"/></>,
    collapseAll: <><path d="m8 10 4-4 4 4M8 14l4 4 4-4"/><path d="M5 12h14"/></>,
    expandAll: <><path d="m8 6 4 4 4-4M8 18l4-4 4 4"/><path d="M5 12h14"/></>,
  };
  return <svg className="navigation-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg className="pin-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m14 4 6 6-3.5 1.2-3.1 3.1 1.1 3.6-1.4 1.4-3.6-3.6L5 20l4.3-4.5-3.6-3.6 1.4-1.4 3.6 1.1 3.1-3.1L14 4Z" />
      {pinned && <path d="M4 4l16 16" />}
    </svg>
  );
}

function ResourceIcon({ kind }: { kind: string }) {
  const letters = kind
    .replace(/[^A-Z]/g, "")
    .slice(0, 2) || kind.slice(0, 2).toUpperCase();
  return <span className={`resource-icon resource-icon-${kind.toLowerCase()}`}>{letters}</span>;
}

interface YamlParsedLine {
  raw: string;
  indent: number;
  text: string;
  body: string;
  isBlank: boolean;
  isComment: boolean;
  isListItem: boolean;
  dashPrefix: string;
  key?: string;
  value?: string;
  hasMapping: boolean;
  literal: boolean;
}

function splitKeyValue(s: string): { key?: string; value?: string } {
  if (s === "") return {};
  let inSingle = false;
  let inDouble = false;
  let inFlow = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "[" || c === "{") inFlow++;
    else if (c === "]" || c === "}") inFlow--;
    else if (c === ":" && inFlow === 0) {
      const next = s[i + 1];
      if (next === undefined || next === " " || next === "\t") {
        return { key: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
      }
    }
  }
  return { value: s };
}

function parseYamlLine(raw: string): YamlParsedLine {
  const indent = raw.length - raw.trimStart().length;
  const text = raw.trim();
  if (text === "") {
    return { raw, indent: 0, text: "", body: "", isBlank: true, isComment: false, isListItem: false, dashPrefix: "", hasMapping: false, literal: false };
  }
  if (text.startsWith("#")) {
    return { raw, indent, text, body: text, isBlank: false, isComment: true, isListItem: false, dashPrefix: "", hasMapping: false, literal: false };
  }
  let body = text;
  let dashPrefix = "";
  let isListItem = false;
  if (text.startsWith("- ")) {
    isListItem = true;
    dashPrefix = "- ";
    body = text.slice(2).trim();
  } else if (text === "-") {
    isListItem = true;
    dashPrefix = "- ";
    body = "";
  }
  const split = splitKeyValue(body);
  return {
    raw,
    indent,
    text,
    body,
    isBlank: false,
    isComment: false,
    isListItem,
    dashPrefix,
    key: split.key,
    value: split.value,
    hasMapping: split.key !== undefined,
    literal: false,
  };
}

function annotateLiteral(lines: YamlParsedLine[]): void {
  let literalIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (literalIndent >= 0) {
      if (line.isBlank) continue;
      if (line.indent > literalIndent) {
        line.literal = true;
        continue;
      }
      literalIndent = -1;
    }
    if (
      literalIndent < 0 &&
      !line.isBlank &&
      !line.isComment &&
      line.hasMapping &&
      line.value &&
      /^[|>][-+]?[0-9]*$/.test(line.value)
    ) {
      literalIndent = line.indent;
    }
  }
}

function filterManagedFields(parsed: YamlParsedLine[]): YamlParsedLine[] {
  const result: YamlParsedLine[] = [];
  let i = 0;
  while (i < parsed.length) {
    const line = parsed[i];
    if (!line.isBlank && !line.isComment && line.hasMapping && line.key === "managedFields") {
      const blockIndent = line.indent;
      i++;
      while (i < parsed.length) {
        const next = parsed[i];
        if (next.isBlank) { i++; continue; }
        if (next.indent > blockIndent) { i++; continue; }
        if (next.indent === blockIndent && next.isListItem) { i++; continue; }
        break;
      }
      continue;
    }
    result.push(line);
    i++;
  }
  return result;
}

function renderYamlLineContent(line: YamlParsedLine): ReactNode {
  if (line.isBlank) return null;
  if (line.isComment) return <span className="yaml-comment">{line.text}</span>;
  if (line.literal) return <span className="yaml-value">{line.text}</span>;
  const parts: ReactNode[] = [];
  if (line.indent > 0) parts.push(<span key="ind" className="yaml-indent" aria-hidden="true">{"·".repeat(line.indent)}</span>);
  if (line.dashPrefix) parts.push(<span key="dash" className="yaml-dash">{line.dashPrefix}</span>);
  if (line.hasMapping && line.key !== undefined) {
    parts.push(<span key="key" className="yaml-key">{line.key}:</span>);
    if (line.value && line.value !== "") {
      parts.push(" ");
      parts.push(<span key="val" className="yaml-value">{line.value}</span>);
    }
  } else {
    parts.push(<span key="val" className="yaml-value">{line.body}</span>);
  }
  return parts;
}

function YamlView({ yaml, showManagedFields }: { yaml: string; showManagedFields: boolean }) {
  const parsed = useMemo(() => {
    const lines = yaml.split("\n").map(parseYamlLine);
    annotateLiteral(lines);
    return showManagedFields ? lines : filterManagedFields(lines);
  }, [yaml, showManagedFields]);

  const isContainer = useMemo(() => {
    const arr = new Array<boolean>(parsed.length).fill(false);
    for (let i = 0; i < parsed.length; i++) {
      const line = parsed[i];
      if (line.isBlank || line.isComment) continue;
      let j = i + 1;
      while (j < parsed.length && (parsed[j].isBlank || parsed[j].isComment)) j++;
      if (j < parsed.length) {
        const next = parsed[j];
        if (next.indent > line.indent) {
          arr[i] = true;
        } else if (next.indent === line.indent && next.isListItem && !line.isListItem && line.hasMapping && !line.value) {
          arr[i] = true;
        }
      }
    }
    return arr;
  }, [parsed]);

  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  useEffect(() => { setCollapsed(new Set()); }, [yaml, showManagedFields]);

  const visible = useMemo(() => {
    const idx: number[] = [];
    const stack: number[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const line = parsed[i];
      if (!line.isBlank) {
        while (stack.length) {
          const top = parsed[stack[stack.length - 1]];
          if (top.indent < line.indent) break;
          if (top.indent === line.indent && line.isListItem && !top.isListItem) break;
          stack.pop();
        }
      }
      if (stack.length === 0) idx.push(i);
      if (isContainer[i] && collapsed.has(i)) stack.push(i);
    }
    return idx;
  }, [parsed, isContainer, collapsed]);

  const toggle = (i: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });

  const handleCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString().replace(/·/g, " ");
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
  };

  return (
    <div className="yaml-view" onCopy={handleCopy}>
      {visible.map((i, displayNo) => {
        const line = parsed[i];
        const isCollapsed = collapsed.has(i);
        return (
          <div key={i} className="yaml-row">
            <span className="yaml-line-no">{displayNo + 1}</span>
            <span className="yaml-fold">
              {isContainer[i] && (
                <button
                  type="button"
                  className={`yaml-fold-btn${isCollapsed ? " is-collapsed" : ""}`}
                  aria-label={isCollapsed ? "Expand" : "Collapse"}
                  onClick={() => toggle(i)}
                >
                  {isCollapsed ? "▸" : "▾"}
                </button>
              )}
            </span>
            <span className="yaml-content">{renderYamlLineContent(line)}</span>
          </div>
        );
      })}
    </div>
  );
}

const RESOURCE_API_VERSIONS: Record<string, string> = {
  Pod: "v1",
  Deployment: "apps/v1",
  StatefulSet: "apps/v1",
  DaemonSet: "apps/v1",
  Job: "batch/v1",
  CronJob: "batch/v1",
  Service: "v1",
  Ingress: "networking.k8s.io/v1",
  ConfigMap: "v1",
  Secret: "v1",
  PersistentVolumeClaim: "v1",
  PersistentVolume: "v1",
  Node: "v1",
};

const FALLBACK_RESOURCE_KINDS: ResourceKindItem[] = RESOURCE_GROUPS.flatMap((group) =>
  group.kinds.map((kind) => {
    const apiVersion = RESOURCE_API_VERSIONS[kind];
    const [apiGroup, version] = apiVersion.includes("/") ? apiVersion.split("/", 2) : ["", apiVersion];
    return {
      group: apiGroup,
      version,
      kind,
      plural: resourceKindLabel(kind).toLowerCase(),
      scope: kind === "PersistentVolume" || kind === "Node" ? "Cluster" : "Namespaced",
      namespaced: kind !== "PersistentVolume" && kind !== "Node",
      columns: [],
    };
  })
);

const RESOURCE_COLUMNS: Record<string, Array<{ key: string; label: string }>> = {
  Pod: [
    { key: "status", label: "Status" },
    { key: "ready", label: "Ready" },
    { key: "restarts", label: "Restarts" },
    { key: "node", label: "Node" },
  ],
  Deployment: [
    { key: "ready", label: "Ready" },
    { key: "upToDate", label: "Up-to-date" },
    { key: "available", label: "Available" },
  ],
  StatefulSet: [
    { key: "ready", label: "Ready" },
    { key: "upToDate", label: "Updated" },
    { key: "available", label: "Available" },
  ],
  DaemonSet: [
    { key: "desired", label: "Desired" },
    { key: "current", label: "Current" },
    { key: "ready", label: "Ready" },
    { key: "available", label: "Available" },
  ],
  Job: [
    { key: "completions", label: "Completions" },
    { key: "active", label: "Active" },
    { key: "failed", label: "Failed" },
  ],
  CronJob: [
    { key: "schedule", label: "Schedule" },
    { key: "suspend", label: "Suspend" },
    { key: "active", label: "Active" },
    { key: "lastSchedule", label: "Last Schedule" },
  ],
  Service: [
    { key: "type", label: "Type" },
    { key: "clusterIP", label: "Cluster IP" },
    { key: "ports", label: "Ports" },
  ],
  Ingress: [
    { key: "class", label: "Class" },
    { key: "hosts", label: "Hosts" },
  ],
  ConfigMap: [{ key: "data", label: "Data" }],
  Secret: [
    { key: "type", label: "Type" },
    { key: "data", label: "Data" },
  ],
  PersistentVolumeClaim: [
    { key: "status", label: "Status" },
    { key: "capacity", label: "Capacity" },
    { key: "storageClass", label: "Storage Class" },
  ],
  PersistentVolume: [
    { key: "status", label: "Status" },
    { key: "capacity", label: "Capacity" },
    { key: "storageClass", label: "Storage Class" },
  ],
  Node: [
    { key: "status", label: "Status" },
    { key: "roles", label: "Roles" },
    { key: "version", label: "Version" },
    { key: "internalIP", label: "Internal IP" },
    { key: "externalIP", label: "External IP" },
    { key: "osImage", label: "OS Image" },
    { key: "kernelVersion", label: "Kernel Version" },
    { key: "containerRuntime", label: "Container Runtime" },
  ],
};

function resourceKindLabel(kind: string): string {
  if (kind.endsWith("s") || kind.endsWith("x") || kind.endsWith("ch") || kind.endsWith("sh")) {
    return `${kind}es`;
  }
  if (kind.endsWith("y") && !/[aeiou]y$/i.test(kind)) return `${kind.slice(0, -1)}ies`;
  return `${kind}s`;
}

function resourceApiVersion(resource: ResourceKindItem): string {
  return resource.group ? `${resource.group}/${resource.version}` : resource.version;
}

function resourceKey(resource: ResourceKindItem): string {
  return `${resourceApiVersion(resource)}:${resource.kind}`;
}

function formatAge(created: string | null): string {
  if (!created) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(created).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`;
}

function formatCpu(value: number | null | undefined): string {
  return value == null ? "-" : `${value}m`;
}

function formatMemory(value: number | null | undefined): string {
  if (value == null) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function App() {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem("freelens.sidebarWidth"));
    return Number.isFinite(saved) && saved >= 180 && saved <= 420 ? saved : 220;
  });
  const [favoriteResourceKeys, setFavoriteResourceKeys] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem("freelens.favoriteResources") ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const sidebarResizeRef = useRef(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const settingsRestorePendingRef = useRef(0);
  const preferredNamespaceRef = useRef("");
  const preferredResourceRef = useRef("");
  const [kubeconfig, setKubeconfig] = useState<KubeconfigListResponse>();
  const [kubeconfigError, setKubeconfigError] = useState<string>();
  const [kubeconfigSources, setKubeconfigSources] = useState<string[]>([]);
  const [kubeconfigSearch, setKubeconfigSearch] = useState("");
  const [kubeconfigSettingsOpen, setKubeconfigSettingsOpen] = useState(false);
  const [kubeconfigSourceDraft, setKubeconfigSourceDraft] = useState("");
  const [contextDisplayMode, setContextDisplayMode] = useState<ContextDisplayMode>("list");
  const [pendingContext, setPendingContext] = useState("");
  const [selectedContext, setSelectedContext] = useState<string>("");
  const selectedContextRef = useRef(selectedContext);
  const setSelectedContextAndRef = (value: string) => {
    selectedContextRef.current = value;
    setSelectedContext(value);
  };
  const finishSettingsRestore = () => {
    if (settingsRestorePendingRef.current === 0) return;
    settingsRestorePendingRef.current -= 1;
    if (settingsRestorePendingRef.current === 0) setSettingsReady(true);
  };

  const [namespaces, setNamespaces] = useState<NamespaceItem[]>([]);
  const [namespacesError, setNamespacesError] = useState<string>();
  const [selectedNamespace, setSelectedNamespace] = useState<string>("");
  const [resourceKinds, setResourceKinds] = useState<ResourceKindItem[]>(FALLBACK_RESOURCE_KINDS);
  const [activeView, setActiveView] = useState<ActiveView>("contexts");
  const [resourceDiscoveryError, setResourceDiscoveryError] = useState<string>();
  const [resourceCatalogSearch, setResourceCatalogSearch] = useState("");
  const [selectedResource, setSelectedResource] = useState<ResourceKindItem>(FALLBACK_RESOURCE_KINDS[0]);
  const selectedKind = selectedResource.kind;
  const selectedApiVersion = resourceApiVersion(selectedResource);
  const selectedColumns = RESOURCE_COLUMNS[selectedKind]
    ?? selectedResource.columns
      .filter((column) => column.priority === 0)
      .map((column) => ({ key: column.name, label: column.name }));

  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string>();
  const [overview, setOverview] = useState<KubernetesClusterOverviewResponse>();
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string>();
  const overviewRequestRef = useRef(0);
  const [healthTitle, setHealthTitle] = useState("");
  const [healthItems, setHealthItems] = useState<ResourceItem[]>([]);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string>();
  const healthRequestRef = useRef(0);
  const [events, setEvents] = useState<KubernetesEventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string>();
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [eventSortKey, setEventSortKey] = useState<string>("");
  const [eventSortDirection, setEventSortDirection] = useState<"asc" | "desc">("asc");
  const eventsRequestRef = useRef(0);
  const [metrics, setMetrics] = useState<Record<string, ResourceMetricItem>>({});
  const [metricsError, setMetricsError] = useState<string>();
  const metricsRequestRef = useRef(0);
  const [continueToken, setContinueToken] = useState<string | null>(null);
  const resourceRequestRef = useRef(0);
  const [resourceSearch, setResourceSearch] = useState("");
  const searchPaginationRef = useRef<{ key: string; tokens: Set<string> }>({
    key: "",
    tokens: new Set(),
  });
  const [sortKey, setSortKey] = useState("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const resourceListRef = useRef<HTMLDivElement | null>(null);
  const resourceTableRef = useRef<HTMLTableElement | null>(null);
  const [resourceScrollTop, setResourceScrollTop] = useState(0);
  const [resourceViewportHeight, setResourceViewportHeight] = useState(0);
  const [resourceTableTop, setResourceTableTop] = useState(0);
  const [refreshSeconds, setRefreshSeconds] = useState(0);
  const [watchStatus, setWatchStatus] = useState<"connecting" | "live" | "retrying" | "off">("off");
  const resourceWatchOperationRef = useRef<string | undefined>(undefined);
  const resourceWatchRefreshRef = useRef<number | undefined>(undefined);
  const watchRefreshActionRef = useRef<() => void>(() => {});

  const [detail, setDetail] = useState<KubernetesGetResourceDetailResponse>();
  const [detailTab, setDetailTab] = useState<"overview" | "yaml">("overview");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [yamlDraft, setYamlDraft] = useState("");
  const [yamlEditing, setYamlEditing] = useState(false);
  const [yamlShowManagedFields, setShowYamlManagedFields] = useState(false);
  const [yamlCopyHint, setYamlCopyHint] = useState<string>();
  const yamlCopyHintTimer = useRef<number | undefined>(undefined);
  const [configMapDataDraft, setConfigMapDataDraft] = useState<Record<string, string>>({});
  const [secretDataDraft, setSecretDataDraft] = useState<Record<string, string>>({});
  const [revealedSecretData, setRevealedSecretData] = useState<Set<string>>(() => new Set());
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();
  const [resourceActionKey, setResourceActionKey] = useState<string>();
  const [openResourceActionMenu, setOpenResourceActionMenu] = useState<string>();
  const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
  const topbarMenuRef = useRef<HTMLDivElement>(null);
  const detailRequestRef = useRef(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createYaml, setCreateYaml] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string>();

  const [logOperationId, setLogOperationId] = useState<string>();
  const logOperationIdRef = useRef<string | undefined>(undefined);
  const [logs, setLogs] = useState<string[]>([]);
  const [logResource, setLogResource] = useState<{ namespace: string; name: string }>();
  const [logContainers, setLogContainers] = useState<string[]>([]);
  const [selectedLogContainer, setSelectedLogContainer] = useState("");
  const [logPreparing, setLogPreparing] = useState(false);
  const [logError, setLogError] = useState<string>();
  const logPrepareRequestRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [execResource, setExecResource] = useState<ResourceItem>();
  const [execContainers, setExecContainers] = useState<string[]>([]);
  const [execContainer, setExecContainer] = useState("");
  const [execLoading, setExecLoading] = useState(false);
  const [execError, setExecError] = useState<string>();
  const [terminalSessionId, setTerminalSessionId] = useState<string>();
  const terminalSessionIdRef = useRef<string | undefined>(undefined);
  const terminalReadyRef = useRef(false);
  const terminalInputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const xtermFitRef = useRef<FitAddon | null>(null);
  const [portForwards, setPortForwards] = useState<Record<string, {
    operationId: string;
    localPort: number;
    remotePort: number;
  }>>({});
  const portForwardsRef = useRef(portForwards);
  const [kubectlOpen, setKubectlOpen] = useState(false);
  const [kubectlInstallations, setKubectlInstallations] = useState<KubectlInstallation[]>([]);
  const [kubectlExecutable, setKubectlExecutable] = useState("");
  const [kubectlCommand, setKubectlCommand] = useState("get pods");
  const [kubectlOperationId, setKubectlOperationId] = useState<string>();
  const kubectlOperationIdRef = useRef<string | undefined>(undefined);
  const [kubectlResult, setKubectlResult] = useState<KubectlRunResponse>();
  const [kubectlError, setKubectlError] = useState<string>();
  const [kubectlLoading, setKubectlLoading] = useState(false);
  const [localTerminalOpen, setLocalTerminalOpen] = useState(false);
  const [localTerminalSessionId, setLocalTerminalSessionId] = useState<string>();
  const localTerminalSessionIdRef = useRef<string | undefined>(undefined);
  const [localTerminalShell, setLocalTerminalShell] = useState("");
  const [localTerminalError, setLocalTerminalError] = useState<string>();
  const localTerminalHostRef = useRef<HTMLDivElement | null>(null);
  const localXtermRef = useRef<Terminal | null>(null);
  const localXtermFitRef = useRef<FitAddon | null>(null);
  const localTerminalInputQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!sidebarResizeRef.current) return;
      const width = Math.min(420, Math.max(180, event.clientX));
      setSidebarWidth(width);
    };
    const stop = () => {
      if (!sidebarResizeRef.current) return;
      sidebarResizeRef.current = false;
      document.body.classList.remove("resizing-sidebar");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("freelens.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem("freelens.favoriteResources", JSON.stringify(favoriteResourceKeys));
  }, [favoriteResourceKeys]);

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    sidebarResizeRef.current = true;
    document.body.classList.add("resizing-sidebar");
  };

  const toggleNavigationGroup = (label: string) => {
    setCollapsedGroups((current) => ({ ...current, [label]: !current[label] }));
  };

  const selectResource = (resource: ResourceKindItem) => {
    setSelectedResource(resource);
    setActiveView("resources");
    if (!resource.namespaced) setSelectedNamespace("");
    resourceRequestRef.current += 1;
    setDetail(undefined);
  };

  const toggleFavoriteResource = (resource: ResourceKindItem) => {
    const key = resourceKey(resource);
    setFavoriteResourceKeys((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ));
  };

  const updatePortForwards = useCallback((next: Record<string, {
    operationId: string;
    localPort: number;
    remotePort: number;
  }>) => {
    portForwardsRef.current = next;
    setPortForwards(next);
  }, []);

  const writeTerminal = useCallback((data: string) => {
    xtermRef.current?.write(data);
  }, []);

  const focusTerminal = useCallback(() => {
    if (!terminalReadyRef.current) return;
    xtermRef.current?.focus();
  }, []);

  const terminalSize = useCallback(() => {
    const terminal = xtermRef.current;
    const fit = xtermFitRef.current;
    if (!terminal) return { cols: 80, rows: 24 };
    try {
      fit?.fit();
    } catch {
    }
    return {
      cols: Math.max(1, terminal.cols || 80),
      rows: Math.max(1, terminal.rows || 24),
    };
  }, []);

  const syncTerminalSize = useCallback(() => {
    const sessionId = terminalSessionIdRef.current;
    const { cols, rows } = terminalSize();
    if (!sessionId || !terminalReadyRef.current) return;
    void transport.kubernetesResizePodTerminal({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      sessionId,
      cols,
      rows,
    }).catch((reason: unknown) => setExecError(errorMessage(reason)));
  }, [terminalSize]);

  const localTerminalSize = useCallback(() => {
    const terminal = localXtermRef.current;
    if (!terminal) return { cols: 80, rows: 24 };
    try {
      localXtermFitRef.current?.fit();
    } catch {
    }
    return { cols: Math.max(1, terminal.cols), rows: Math.max(1, terminal.rows) };
  }, []);

  const syncLocalTerminalSize = useCallback(() => {
    const sessionId = localTerminalSessionIdRef.current;
    if (!sessionId) return;
    const { rows, cols } = localTerminalSize();
    void transport.localTerminalResize({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      sessionId,
      rows,
      cols,
    }).catch((reason) => setLocalTerminalError(errorMessage(reason)));
  }, [localTerminalSize]);

  useEffect(() => {
    transport.settingsLoad({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      }).catch((reason: unknown) => {
        setActionError(errorMessage(reason));
        return {
          version: IPC_VERSION,
          requestId: "settings-fallback",
          settings: {
            context: null,
            namespace: null,
            resourceKind: null,
            resourceApiVersion: null,
            refreshSeconds: 0,
            kubeconfigSources: [],
          },
        };
      })
      .then((saved) => {
        const savedSources = uniqueKubeconfigSources(saved.settings.kubeconfigSources ?? []);
        setKubeconfigSources(savedSources);
        return transport.kubeconfigList({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          sources: savedSources,
        }).then((response) => ({ response, saved }));
      })
      .then(({ response, saved }) => {
        setKubeconfig(response);
        const savedContext = saved.settings.context;
        const context = response.contexts.some((item) => item.name === savedContext)
          ? savedContext ?? ""
          : response.currentContext ?? response.contexts[0]?.name ?? "";
        preferredNamespaceRef.current = saved.settings.namespace ?? "";
        preferredResourceRef.current = saved.settings.resourceKind && saved.settings.resourceApiVersion
          ? `${saved.settings.resourceApiVersion}:${saved.settings.resourceKind}`
          : "";
        setRefreshSeconds([0, 5, 15, 30].includes(saved.settings.refreshSeconds)
          ? saved.settings.refreshSeconds
          : 0);
        settingsRestorePendingRef.current = 2;
        setSelectedContextAndRef(context);
        setPendingContext(context);
        if (!context) {
          settingsRestorePendingRef.current = 0;
          setSettingsReady(true);
        }
      })
      .catch((reason: unknown) => {
        setKubeconfigError(errorMessage(reason));
      });

    let unlistenLog: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenResourceWatch: (() => void) | undefined;
    let unlistenTerminal: (() => void) | undefined;
    let unlistenTerminalDone: (() => void) | undefined;
    let unlistenLocalTerminalOutput: (() => void) | undefined;
    let unlistenLocalTerminalDone: (() => void) | undefined;

    transport.onLogEvent((event) => {
      if (event.operationId === logOperationIdRef.current) {
        setLogs((prev) => [...prev, event.line]);
      }
    }).then((unlisten) => {
      unlistenLog = unlisten;
    });

    transport.onLogDone((event) => {
      if (event.operationId === logOperationIdRef.current) {
        logOperationIdRef.current = undefined;
        setLogOperationId(undefined);
      }
    }).then((unlisten) => {
      unlistenDone = unlisten;
    });

    transport.onResourceWatchEvent((event) => {
      if (event.operationId !== resourceWatchOperationRef.current) return;
      if (event.type === "error") {
        setWatchStatus("retrying");
        return;
      }
      setWatchStatus("live");
      if (resourceWatchRefreshRef.current) window.clearTimeout(resourceWatchRefreshRef.current);
      resourceWatchRefreshRef.current = window.setTimeout(() => watchRefreshActionRef.current(), 250);
    }).then((unlisten) => {
      unlistenResourceWatch = unlisten;
    });

    transport.onTerminalEvent((event) => {
      if (event.sessionId === terminalSessionIdRef.current) {
        writeTerminal(event.data);
      }
    }).then((unlisten) => {
      unlistenTerminal = unlisten;
    });

    transport.onTerminalDone((event) => {
      if (event.sessionId === terminalSessionIdRef.current) {
        terminalReadyRef.current = false;
        terminalSessionIdRef.current = undefined;
        setTerminalSessionId(undefined);
        setExecError(undefined);
        writeTerminal("\r\n[Terminal session ended]\r\n");
      }
    }).then((unlisten) => {
      unlistenTerminalDone = unlisten;
    });

    transport.onLocalTerminalOutput(() => {}).then((unlisten) => {
      unlistenLocalTerminalOutput = unlisten;
    });

    transport.onLocalTerminalDone((event) => {
      if (event.sessionId === localTerminalSessionIdRef.current) {
        localTerminalSessionIdRef.current = undefined;
        setLocalTerminalSessionId(undefined);
        localXtermRef.current?.writeln("\r\n[PowerShell session ended]");
      }
    }).then((unlisten) => {
      unlistenLocalTerminalDone = unlisten;
    });

    return () => {
      const operationId = logOperationIdRef.current;
      if (operationId) {
        void transport.kubernetesStopPodLogs({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          operationId,
        });
      }
      const sessionId = terminalSessionIdRef.current;
      if (sessionId) {
        terminalReadyRef.current = false;
        void transport.kubernetesStopPodTerminal({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          sessionId,
        });
      }
      for (const forward of Object.values(portForwardsRef.current)) {
        void transport.kubernetesStopPodPortForward({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          operationId: forward.operationId,
        });
      }
      const kubectlId = kubectlOperationIdRef.current;
      if (kubectlId) {
        void transport.kubectlCancel({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          operationId: kubectlId,
        });
      }
      const localSessionId = localTerminalSessionIdRef.current;
      if (localSessionId) {
        void transport.localTerminalStop({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          sessionId: localSessionId,
        });
      }
      unlistenLog?.();
      unlistenDone?.();
      unlistenResourceWatch?.();
      unlistenTerminal?.();
      unlistenTerminalDone?.();
      unlistenLocalTerminalOutput?.();
      unlistenLocalTerminalDone?.();
      if (resourceWatchRefreshRef.current) window.clearTimeout(resourceWatchRefreshRef.current);
    };
  }, []);

  useEffect(() => {
    if (!settingsReady || !selectedContext) return;
    const timer = window.setTimeout(() => {
      void transport.settingsSave({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        settings: {
          context: selectedContext,
          namespace: selectedNamespace || null,
          resourceKind: selectedResource.kind || null,
          resourceApiVersion: resourceApiVersion(selectedResource) || null,
          refreshSeconds,
          kubeconfigSources,
        },
      }).catch((reason) => setActionError(errorMessage(reason)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [settingsReady, selectedContext, selectedNamespace, selectedResource, refreshSeconds, kubeconfigSources]);

  useEffect(() => {
    const terminalElement = terminalHostRef.current;
    if (!execResource || !terminalElement) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#0f1419",
        foreground: "#d7e0e8",
        cursor: "#8ab4f8",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalElement);
    xtermRef.current = terminal;
    xtermFitRef.current = fit;
    terminal.writeln("Select a container and start a terminal session.");
    window.setTimeout(() => terminalSize(), 0);
    const dataDisposable = terminal.onData((data) => {
      const sessionId = terminalSessionIdRef.current;
      if (!sessionId) return;
      terminalInputQueueRef.current = terminalInputQueueRef.current
        .then(async () => {
          const response = await transport.kubernetesTerminalInput({
            meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
            sessionId,
            input: data,
          });
          if (response.output) terminal.write(response.output);
        })
        .catch((reason: unknown) => {
          terminalReadyRef.current = false;
          terminalSessionIdRef.current = undefined;
          setTerminalSessionId(undefined);
          setExecError(errorMessage(reason));
          terminal.writeln("\r\n[Terminal session ended]");
        });
    });
    const pollTimer = window.setInterval(() => {
      const sessionId = terminalSessionIdRef.current;
      if (!sessionId || !terminalReadyRef.current) return;
      terminalInputQueueRef.current = terminalInputQueueRef.current
        .then(async () => {
          const response = await transport.kubernetesTerminalInput({
            meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
            sessionId,
            input: "",
          });
          if (response.output) terminal.write(response.output);
        })
        .catch((reason: unknown) => {
          terminalReadyRef.current = false;
          terminalSessionIdRef.current = undefined;
          setTerminalSessionId(undefined);
          setExecError(errorMessage(reason));
          terminal.writeln("\r\n[Terminal session ended]");
        });
    }, 50);
    const observer = new ResizeObserver(() => syncTerminalSize());
    observer.observe(terminalElement);
    window.addEventListener("resize", syncTerminalSize);
    return () => {
      dataDisposable.dispose();
      window.clearInterval(pollTimer);
      observer.disconnect();
      window.removeEventListener("resize", syncTerminalSize);
      terminal.dispose();
      xtermRef.current = null;
      xtermFitRef.current = null;
    };
  }, [execResource, syncTerminalSize, terminalSize]);

  useEffect(() => {
    const terminalElement = localTerminalHostRef.current;
    if (!localTerminalOpen || !terminalElement || !selectedContext) return;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#0f1419",
        foreground: "#d7e0e8",
        cursor: "#8ab4f8",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalElement);
    localXtermRef.current = terminal;
    localXtermFitRef.current = fit;
    setLocalTerminalError(undefined);
    setLocalTerminalShell("");
    const sessionId = crypto.randomUUID();
    localTerminalSessionIdRef.current = sessionId;
    setLocalTerminalSessionId(sessionId);
    const start = async () => {
      const { rows, cols } = localTerminalSize();
      try {
        const response = await transport.localTerminalStart({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          sessionId,
          context: selectedContext,
          namespace: selectedNamespace || null,
          rows,
          cols,
        });
        setLocalTerminalShell(response.shell);
        terminal.focus();
      } catch (reason) {
        if (localTerminalSessionIdRef.current === sessionId) {
          localTerminalSessionIdRef.current = undefined;
          setLocalTerminalSessionId(undefined);
          setLocalTerminalError(errorMessage(reason));
          terminal.writeln("\r\n[Failed to start PowerShell]");
        }
      }
    };
    void start();
    const dataDisposable = terminal.onData((data) => {
      if (localTerminalSessionIdRef.current !== sessionId) return;
      localTerminalInputQueueRef.current = localTerminalInputQueueRef.current
        .then(async () => {
          const response = await transport.localTerminalInput({
            meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
            sessionId,
            input: data,
          });
          if (response.output) terminal.write(response.output);
          if (!response.active) localTerminalSessionIdRef.current = undefined;
        })
        .catch((reason) => setLocalTerminalError(errorMessage(reason)));
    });
    const pollTimer = window.setInterval(() => {
      if (localTerminalSessionIdRef.current !== sessionId) return;
      localTerminalInputQueueRef.current = localTerminalInputQueueRef.current
        .then(async () => {
          const response = await transport.localTerminalInput({
            meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
            sessionId,
            input: "",
          });
          if (response.output) terminal.write(response.output);
          if (!response.active) {
            localTerminalSessionIdRef.current = undefined;
            setLocalTerminalSessionId(undefined);
          }
        })
        .catch((reason) => {
          if (localTerminalSessionIdRef.current === sessionId) setLocalTerminalError(errorMessage(reason));
        });
    }, 50);
    const observer = new ResizeObserver(() => syncLocalTerminalSize());
    observer.observe(terminalElement);
    window.addEventListener("resize", syncLocalTerminalSize);
    return () => {
      dataDisposable.dispose();
      window.clearInterval(pollTimer);
      observer.disconnect();
      window.removeEventListener("resize", syncLocalTerminalSize);
      if (localTerminalSessionIdRef.current === sessionId) {
        localTerminalSessionIdRef.current = undefined;
        void transport.localTerminalStop({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          sessionId,
        });
      }
      setLocalTerminalSessionId(undefined);
      terminal.dispose();
      localXtermRef.current = null;
      localXtermFitRef.current = null;
    };
  }, [localTerminalOpen, localTerminalSize, selectedContext, selectedNamespace, syncLocalTerminalSize]);

  useEffect(() => {
    if (!selectedContext) return;
    setResourceDiscoveryError(undefined);
    transport
      .kubernetesDiscoverResources({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
      })
      .then((response) => {
        if (selectedContextRef.current !== selectedContext) return;
        const discovered = response.kinds.length > 0 ? response.kinds : FALLBACK_RESOURCE_KINDS;
        setResourceKinds(discovered);
        setSelectedResource((current) => {
          const preferred = preferredResourceRef.current;
          preferredResourceRef.current = "";
          return discovered.find((item) => resourceKey(item) === preferred)
            ?? discovered.find((item) => resourceKey(item) === resourceKey(current))
            ?? discovered.find((item) => item.kind === "Pod" && resourceApiVersion(item) === "v1")
            ?? discovered[0];
        });
        finishSettingsRestore();
      })
      .catch((reason: unknown) => {
        if (selectedContextRef.current !== selectedContext) return;
        setResourceKinds(FALLBACK_RESOURCE_KINDS);
        setResourceDiscoveryError(errorMessage(reason));
        finishSettingsRestore();
      });
    transport
      .kubernetesListNamespaces({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
      })
      .then((response: KubernetesListNamespacesResponse) => {
        setNamespaces(response.namespaces);
        setNamespacesError(undefined);
        const preferred = preferredNamespaceRef.current;
        preferredNamespaceRef.current = "";
        setSelectedNamespace(response.namespaces.some((item) => item.name === preferred) ? preferred : "");
        finishSettingsRestore();
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setNamespaces([]);
        setNamespacesError(message);
        preferredNamespaceRef.current = "";
        finishSettingsRestore();
      });
  }, [selectedContext]);

  const availableNamespaces = useMemo(() => {
    const names = new Set<string>(namespaces.map((ns) => ns.name));
    resources.forEach((resource) => {
      if (resource.namespace) names.add(resource.namespace);
    });
    events.forEach((event) => {
      if (event.namespace) names.add(event.namespace);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [namespaces, resources, events]);

  useEffect(() => {
    if (activeView === "resources" && !selectedResource.namespaced && selectedNamespace) {
      setSelectedNamespace("");
    }
  }, [activeView, selectedResource, selectedNamespace]);

  useEffect(() => {
    if (activeView !== "resources" || !selectedContext || !selectedKind) return;
    watchRefreshActionRef.current = loadResources;
    loadResources();
  }, [activeView, selectedContext, selectedKind, selectedApiVersion, selectedNamespace]);

  useEffect(() => {
    if (activeView !== "overview" || !selectedContext) return;
    loadOverview();
  }, [activeView, selectedContext]);

  useEffect(() => {
    if (activeView !== "events" || !selectedContext) return;
    watchRefreshActionRef.current = loadEvents;
    loadEvents();
  }, [activeView, selectedContext, selectedNamespace]);

  useEffect(() => {
    if ((activeView !== "resources" && activeView !== "events") || !selectedContext) return;
    const operationId = crypto.randomUUID();
    const watchKind = activeView === "events" ? "Event" : selectedKind;
    const watchApiVersion = activeView === "events" ? "v1" : selectedApiVersion;
    const previous = resourceWatchOperationRef.current;
    resourceWatchOperationRef.current = operationId;
    setWatchStatus("connecting");
    if (previous) {
      void transport.kubernetesStopResourceWatch({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        operationId: previous,
      });
    }
    transport.kubernetesStartResourceWatch({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      operationId,
      context: selectedContext,
      kind: watchKind,
      apiVersion: watchApiVersion,
      namespace: selectedNamespace || null,
    }).then(() => {
      if (resourceWatchOperationRef.current === operationId) setWatchStatus("live");
    }).catch(() => {
      if (resourceWatchOperationRef.current === operationId) setWatchStatus("retrying");
    });
    return () => {
      if (resourceWatchOperationRef.current === operationId) {
        resourceWatchOperationRef.current = undefined;
        setWatchStatus("off");
      }
      void transport.kubernetesStopResourceWatch({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        operationId,
      });
    };
  }, [activeView, selectedContext, selectedKind, selectedApiVersion, selectedNamespace]);

  useEffect(() => {
    if (!refreshSeconds || !selectedContext) return;
    if (activeView === "contexts") return;
    const interval = window.setInterval(
      () => activeView === "overview" ? loadOverview()
        : activeView === "events" ? loadEvents()
          : activeView === "health" && healthTitle === "Abnormal Pods" ? openAbnormalPods()
            : activeView === "health" && healthTitle === "Unavailable Workloads" ? openUnavailableWorkloads()
              : loadResources(),
      refreshSeconds * 1000,
    );
    return () => window.clearInterval(interval);
  }, [activeView, refreshSeconds, selectedContext, selectedKind, selectedApiVersion, selectedNamespace]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const loadResources = (
    token: string | null = null,
    resource: ResourceKindItem = selectedResource,
    namespaceOverride: string = selectedNamespace,
  ) => {
    if (!selectedContext || !resource.kind) return;
    if (!token) {
      searchPaginationRef.current = { key: "", tokens: new Set() };
      const metricsKind = resource.kind === "Pod" || resource.kind === "Node" ? resource.kind : undefined;
      const metricsRequest = ++metricsRequestRef.current;
      setMetrics({});
      setMetricsError(undefined);
      if (metricsKind) {
        transport.kubernetesListMetrics({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          context: selectedContext,
          kind: metricsKind,
          namespace: metricsKind === "Pod" ? namespaceOverride || null : null,
        }).then((response: KubernetesListMetricsResponse) => {
          if (metricsRequest !== metricsRequestRef.current) return;
          setMetrics(Object.fromEntries(response.items.map((item) => [
            `${item.namespace ?? ""}/${item.name}`,
            item,
          ])));
        }).catch((reason: unknown) => {
          if (metricsRequest === metricsRequestRef.current) setMetricsError(errorMessage(reason));
        });
      }
    }
    const requestNumber = ++resourceRequestRef.current;
    const context = selectedContext;
    const kind = resource.kind;
    const namespace = namespaceOverride;
    setResourcesLoading(true);
    setResourcesError(undefined);
    transport
      .kubernetesListResources({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context,
        kind,
        apiVersion: resourceApiVersion(resource),
        columns: resource.columns,
        namespace: namespace || null,
        limit: 50,
        continueToken: token,
      })
      .then((response: KubernetesListResourcesResponse) => {
        if (requestNumber !== resourceRequestRef.current) return;
        if (token) {
          setResources((prev) => [...prev, ...response.items]);
        } else {
          setResources(response.items);
        }
        setContinueToken(response.continueToken);
      })
      .catch((reason: unknown) => {
        if (requestNumber === resourceRequestRef.current) {
          setResourcesError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (requestNumber === resourceRequestRef.current) {
          setResourcesLoading(false);
        }
      });
  };

  const loadOverview = () => {
    if (!selectedContext) return;
    const requestNumber = ++overviewRequestRef.current;
    setOverviewLoading(true);
    setOverviewError(undefined);
    transport.kubernetesClusterOverview({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      context: selectedContext,
    }).then((response) => {
      if (requestNumber === overviewRequestRef.current) setOverview(response);
    }).catch((reason: unknown) => {
      if (requestNumber === overviewRequestRef.current) setOverviewError(errorMessage(reason));
    }).finally(() => {
      if (requestNumber === overviewRequestRef.current) setOverviewLoading(false);
    });
  };

  const loadEvents = () => {
    if (!selectedContext) return;
    const requestNumber = ++eventsRequestRef.current;
    setEventsLoading(true);
    setEventsError(undefined);
    transport.kubernetesListEvents({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      context: selectedContext,
      namespace: selectedNamespace || null,
    }).then((response) => {
      if (requestNumber === eventsRequestRef.current) setEvents(response.items);
    }).catch((reason: unknown) => {
      if (requestNumber === eventsRequestRef.current) setEventsError(errorMessage(reason));
    }).finally(() => {
      if (requestNumber === eventsRequestRef.current) setEventsLoading(false);
    });
  };

  const resourceForKind = (kind: string) =>
    resourceKinds.find((item) => item.kind === kind)
      ?? FALLBACK_RESOURCE_KINDS.find((item) => item.kind === kind);

  const listAllResourcesForKind = async (kind: string, namespace: string | null = selectedNamespace || null): Promise<ResourceItem[]> => {
    const resource = resourceForKind(kind);
    if (!resource || !selectedContext) return [];
    const response = await transport.kubernetesListResources({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      context: selectedContext,
      kind,
      apiVersion: resourceApiVersion(resource),
      columns: resource.columns,
      namespace: resource.namespaced ? namespace : null,
      limit: null,
      continueToken: null,
    });
    return response.items;
  };

  const openAbnormalPods = () => {
    if (!selectedContext) return;
    const requestNumber = ++healthRequestRef.current;
    setHealthTitle("Abnormal Pods");
    setHealthItems([]);
    setHealthLoading(true);
    setHealthError(undefined);
    setActiveView("health");
    listAllResourcesForKind("Pod", null)
      .then((items) => {
        if (requestNumber !== healthRequestRef.current) return;
        setHealthItems(items.filter((item) => {
          const status = item.columns.status ?? "";
          return status !== "Running" && status !== "Succeeded";
        }));
      })
      .catch((reason: unknown) => {
        if (requestNumber === healthRequestRef.current) setHealthError(errorMessage(reason));
      })
      .finally(() => {
        if (requestNumber === healthRequestRef.current) setHealthLoading(false);
      });
  };

  const openUnavailableWorkloads = () => {
    if (!selectedContext) return;
    const requestNumber = ++healthRequestRef.current;
    setHealthTitle("Unavailable Workloads");
    setHealthItems([]);
    setHealthLoading(true);
    setHealthError(undefined);
    setActiveView("health");
    Promise.all([
      listAllResourcesForKind("Deployment", null),
      listAllResourcesForKind("StatefulSet", null),
      listAllResourcesForKind("DaemonSet", null),
    ])
      .then(([deployments, statefulSets, daemonSets]) => {
        if (requestNumber !== healthRequestRef.current) return;
        const replicaUnavailable = (item: ResourceItem) => {
          const [ready, desired] = (item.columns.ready ?? "0/0")
            .split("/", 2)
            .map((value) => Number(value));
          return Number.isFinite(ready) && Number.isFinite(desired) && ready < desired;
        };
        const daemonUnavailable = (item: ResourceItem) => {
          const desired = Number(item.columns.desired ?? 0);
          const available = Number(item.columns.available ?? item.columns.ready ?? 0);
          return Number.isFinite(desired) && Number.isFinite(available) && available < desired;
        };
        setHealthItems([
          ...deployments.filter(replicaUnavailable),
          ...statefulSets.filter(replicaUnavailable),
          ...daemonSets.filter(daemonUnavailable),
        ]);
      })
      .catch((reason: unknown) => {
        if (requestNumber === healthRequestRef.current) setHealthError(errorMessage(reason));
      })
      .finally(() => {
        if (requestNumber === healthRequestRef.current) setHealthLoading(false);
      });
  };

  const openResourceKind = (kind: string) => {
    const resource = resourceForKind(kind);
    if (!resource) return;
    setSelectedResource(resource);
    if (!resource.namespaced) setSelectedNamespace("");
    setActiveView("resources");
    setDetail(undefined);
  };

  useEffect(() => {
    const query = resourceSearch.trim().toLowerCase();
    if (!query) {
      searchPaginationRef.current = { key: "", tokens: new Set() };
      return;
    }
    if (resourcesLoading || !continueToken) return;

    const searchKey = [
      selectedContext,
      resourceKey(selectedResource),
      selectedNamespace,
      query,
    ].join("|");
    if (searchPaginationRef.current.key !== searchKey) {
      searchPaginationRef.current = { key: searchKey, tokens: new Set() };
    }
    if (searchPaginationRef.current.tokens.has(continueToken)) return;
    searchPaginationRef.current.tokens.add(continueToken);
    loadResources(continueToken);
  }, [
    continueToken,
    resourceSearch,
    resources,
    resourcesLoading,
    selectedContext,
    selectedNamespace,
    selectedResource,
  ]);

  const openDetail = (item: ResourceItem) => {
    if (!selectedContext) return;
    const requestNumber = ++detailRequestRef.current;
    setDetail(undefined);
    setDetailLoading(true);
    setDetailError(undefined);
    setDetailTab("overview");
    setYamlEditing(false);
    setShowYamlManagedFields(false);
    setConfigMapDataDraft({});
    setSecretDataDraft({});
    setRevealedSecretData(new Set());
    transport
      .kubernetesGetResourceDetail({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        kind: item.kind,
        apiVersion: item.apiVersion,
        namespace: item.namespace,
        name: item.name,
      })
      .then((response) => {
        if (requestNumber === detailRequestRef.current) {
          setDetail(response);
          setYamlDraft(response.yaml);
          setConfigMapDataDraft(Object.fromEntries(response.configMapData.map((item) => [item.name, item.value])));
          setSecretDataDraft(Object.fromEntries(response.secretData.map((item) => [item.name, item.value])));
          setRevealedSecretData(new Set());
        }
      })
      .catch((reason: unknown) => {
        if (requestNumber === detailRequestRef.current) {
          setDetailError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (requestNumber === detailRequestRef.current) setDetailLoading(false);
      });
  };

  const beginLogStream = (container: string) => {
    if (!selectedContext || !logResource || !container) return;
    const operationId = crypto.randomUUID();
    logOperationIdRef.current = operationId;
    setLogOperationId(operationId);
    setLogs([]);
    setLogError(undefined);
    transport
      .kubernetesStreamPodLogs({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        operationId,
        context: selectedContext,
        namespace: logResource.namespace,
        pod: logResource.name,
        container,
        follow: true,
        tailLines: null,
      })
      .then((response) => {
        if (operationId === logOperationIdRef.current) {
          setLogs((current) => [...response.initialLines, ...current]);
        }
      })
      .catch((reason: unknown) => {
        if (operationId === logOperationIdRef.current) {
          setLogError(errorMessage(reason));
          logOperationIdRef.current = undefined;
          setLogOperationId(undefined);
        }
      });
  };

  const startLogs = (item: ResourceItem) => {
    if (!selectedContext || !item.namespace) return;
    const requestNumber = ++logPrepareRequestRef.current;
    void stopLogs();
    const resource = { namespace: item.namespace, name: item.name };
    setLogResource(resource);
    setLogContainers([]);
    setSelectedLogContainer("");
    setLogs([]);
    setLogError(undefined);
    setLogPreparing(true);
    transport
      .kubernetesGetPodContainers({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        namespace: item.namespace,
        pod: item.name,
      })
      .then((response) => {
        if (requestNumber !== logPrepareRequestRef.current) return;
        setLogContainers(response.containers);
        setSelectedLogContainer(response.defaultContainer ?? response.containers[0] ?? "");
        if (response.containers.length === 0) {
          setLogError("Pod has no loggable containers");
        }
      })
      .catch((reason: unknown) => {
        if (requestNumber === logPrepareRequestRef.current) {
          setLogError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (requestNumber === logPrepareRequestRef.current) setLogPreparing(false);
      });
  };

  const stopLogs = () => {
    const operationId = logOperationIdRef.current;
    if (!operationId) return Promise.resolve();
    logOperationIdRef.current = undefined;
    setLogOperationId(undefined);
    return transport
      .kubernetesStopPodLogs({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        operationId,
      })
      .catch((reason: unknown) => {
        setLogError(errorMessage(reason));
      });
  };

  const closeLogs = () => {
    logPrepareRequestRef.current += 1;
    void stopLogs();
    setLogResource(undefined);
    setLogContainers([]);
    setSelectedLogContainer("");
    setLogs([]);
    setLogError(undefined);
    setLogPreparing(false);
  };

  const closeDetail = () => {
    detailRequestRef.current += 1;
    setDetail(undefined);
    setDetailLoading(false);
    setDetailError(undefined);
    setActionError(undefined);
    setActionMessage(undefined);
    setConfigMapDataDraft({});
    setSecretDataDraft({});
    setRevealedSecretData(new Set());
  };

  const applyYaml = async (nextYaml = yamlDraft) => {
    if (!detail || !selectedContext) return;
    setActionLoading(true);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      const response = await transport.kubernetesApplyResource({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        kind: detail.kind,
        apiVersion: detail.apiVersion,
        namespace: detail.namespace,
        name: detail.name,
        yaml: nextYaml,
      });
      setYamlDraft(response.yaml);
      setDetail((current) => current ? { ...current, yaml: response.yaml } : current);
      setActionMessage("Resource applied successfully");
      loadResources();
      return true;
    } catch (reason) {
      setActionError(errorMessage(reason));
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  const copyYaml = async () => {
    const lines = yamlDraft.split("\n").map(parseYamlLine);
    annotateLiteral(lines);
    const text = (yamlShowManagedFields ? lines : filterManagedFields(lines))
      .map((line) => line.raw)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setYamlCopyHint("Copied!");
    } catch {
      setYamlCopyHint("Copy failed");
    }
    if (yamlCopyHintTimer.current) window.clearTimeout(yamlCopyHintTimer.current);
    yamlCopyHintTimer.current = window.setTimeout(() => setYamlCopyHint(undefined), 1500);
  };

  const editConfigMapData = (name: string, value: string) => {
    setConfigMapDataDraft((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const saveConfigMapData = async () => {
    if (!detail) return;
    const nextData = Object.entries(configMapDataDraft)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, value }));
    const nextYaml = updateConfigMapDataYaml(detail.yaml, nextData);
    if (await applyYaml(nextYaml)) {
      setDetail((current) => current ? { ...current, yaml: nextYaml, configMapData: nextData } : current);
    }
  };

  const editSecretData = (name: string, value: string) => {
    setSecretDataDraft((current) => ({
      ...current,
      [name]: revealedSecretData.has(name) ? encodeUtf8Base64(value) : value,
    }));
  };

  const toggleSecretDataReveal = (name: string) => {
    setRevealedSecretData((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const saveSecretData = async () => {
    if (!detail) return;
    const nextData = Object.entries(secretDataDraft)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, value }));
    const nextYaml = updateSecretDataYaml(detail.yaml, nextData);
    if (await applyYaml(nextYaml)) {
      setDetail((current) => current ? { ...current, yaml: nextYaml, secretData: nextData } : current);
    }
  };

  const openCreate = () => {
    const namespace = selectedNamespace || "default";
    setCreateYaml(
      `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: new-configmap\n  namespace: ${namespace}\ndata: {}\n`
    );
    setCreateError(undefined);
    setCreateOpen(true);
  };

  const createResource = async () => {
    if (!selectedContext || !createYaml.trim()) return;
    setCreateLoading(true);
    setCreateError(undefined);
    try {
      const response = await transport.kubernetesCreateResource({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        yaml: createYaml,
      });
      const resource = resourceKinds.find((item) =>
        item.kind === response.kind && resourceApiVersion(item) === response.apiVersion
      );
      const targetResource = resource ?? selectedResource;
      const targetNamespace = response.namespace ?? "";
      if (resource) setSelectedResource(resource);
      setSelectedNamespace(targetNamespace);
      setResourceSearch(response.name);
      setActionMessage(`${response.kind} ${response.name} applied successfully`);
      setCreateOpen(false);
      loadResources(null, targetResource, targetNamespace);
    } catch (reason) {
      setCreateError(errorMessage(reason));
    } finally {
      setCreateLoading(false);
    }
  };

  const deleteResource = async (item: ResourceItem) => {
    if (!selectedContext) return;
    if (!window.confirm(`Delete ${item.kind} ${item.namespace ? `${item.namespace}/` : ""}${item.name}?`)) return;
    const actionKey = `${item.kind}/${item.namespace ?? ""}/${item.name}/delete`;
    setResourceActionKey(actionKey);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      await transport.kubernetesDeleteResource({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        kind: item.kind,
        apiVersion: item.apiVersion,
        namespace: item.namespace,
        name: item.name,
      });
      if (detail?.kind === item.kind && detail.apiVersion === item.apiVersion
        && detail.name === item.name && detail.namespace === item.namespace) {
        closeDetail();
      }
      setActionMessage(`${item.kind} deletion requested`);
      loadResources();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setResourceActionKey(undefined);
    }
  };

  const scaleWorkload = async (item: ResourceItem) => {
    if (!selectedContext || !item.namespace) return;
    const current = item.columns.ready?.split("/")[1] ?? "1";
    const value = window.prompt(`Desired replicas for ${item.kind} ${item.namespace}/${item.name}`, current);
    if (value === null) return;
    const replicas = Number(value);
    if (!Number.isInteger(replicas) || replicas < 0) {
      setActionError("Replicas must be a non-negative integer");
      setActionMessage(undefined);
      return;
    }
    const actionKey = `${item.kind}/${item.namespace}/${item.name}/scale`;
    setResourceActionKey(actionKey);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      await transport.kubernetesScaleWorkload({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        kind: item.kind as "Deployment" | "StatefulSet",
        namespace: item.namespace,
        name: item.name,
        replicas,
      });
      setActionMessage(`${item.kind} ${item.name} scaled to ${replicas} replicas`);
      loadResources();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setResourceActionKey(undefined);
    }
  };

  const restartWorkload = async (item: ResourceItem) => {
    if (!selectedContext || !item.namespace) return;
    if (!window.confirm(`Rollout restart ${item.kind} ${item.namespace}/${item.name}?`)) return;
    const actionKey = `${item.kind}/${item.namespace}/${item.name}/restart`;
    setResourceActionKey(actionKey);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      await transport.kubernetesRestartWorkload({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        kind: item.kind as "Deployment" | "StatefulSet" | "DaemonSet",
        namespace: item.namespace,
        name: item.name,
      });
      setActionMessage(`${item.kind} ${item.name} rolling restart requested`);
      loadResources();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setResourceActionKey(undefined);
    }
  };

  const triggerCronJob = async (item: ResourceItem) => {
    if (!selectedContext || !item.namespace) return;
    if (!window.confirm(`Create a Job from CronJob ${item.namespace}/${item.name}?`)) return;
    const actionKey = `${item.kind}/${item.namespace}/${item.name}/trigger`;
    setResourceActionKey(actionKey);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      const response = await transport.kubernetesTriggerCronJob({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        namespace: item.namespace,
        name: item.name,
      });
      setActionMessage(`Job ${response.jobName} created from CronJob ${item.name}`);
      loadResources();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setResourceActionKey(undefined);
    }
  };

  const openExec = async (item: ResourceItem) => {
    if (!selectedContext || !item.namespace) return;
    setExecResource(item);
    setExecContainers([]);
    setExecContainer("");
    setExecError(undefined);
    setExecLoading(true);
    try {
      const response = await transport.kubernetesGetPodContainers({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        namespace: item.namespace,
        pod: item.name,
      });
      setExecContainers(response.containers);
      setExecContainer(response.defaultContainer ?? response.containers[0] ?? "");
      if (response.containers.length === 0) {
        setExecError("Pod has no containers available for terminal sessions");
      }
    } catch (reason) {
      setExecError(errorMessage(reason));
    } finally {
      setExecLoading(false);
    }
  };

  const startTerminal = async () => {
    if (!selectedContext || !execResource?.namespace || !execContainer) return;
    setExecLoading(true);
    setExecError(undefined);
    const terminal = xtermRef.current;
    terminal?.clear();
    terminal?.writeln(`Connecting to ${execResource.namespace}/${execResource.name} (${execContainer})...`);
    const { cols, rows } = terminalSize();
    const sessionId = crypto.randomUUID();
    terminalReadyRef.current = false;
    terminalSessionIdRef.current = sessionId;
    try {
      const response = await transport.kubernetesStartPodTerminal({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        sessionId,
        context: selectedContext,
        namespace: execResource.namespace,
        pod: execResource.name,
        container: execContainer,
        rows,
        cols,
      });
      terminal?.clear();
      if (response.initialOutput) writeTerminal(response.initialOutput);
      if (response.active) {
        terminalReadyRef.current = true;
        setTerminalSessionId(sessionId);
        window.setTimeout(() => {
          xtermRef.current?.focus();
          syncTerminalSize();
        }, 0);
      } else {
        terminalReadyRef.current = false;
        terminalSessionIdRef.current = undefined;
        setTerminalSessionId(undefined);
      }
    } catch (reason) {
      terminalReadyRef.current = false;
      terminalSessionIdRef.current = undefined;
      setTerminalSessionId(undefined);
      terminal?.writeln("\r\n[Terminal session failed]");
      setExecError(errorMessage(reason));
    } finally {
      setExecLoading(false);
    }
  };

  const stopTerminal = async () => {
    const sessionId = terminalSessionIdRef.current;
    terminalReadyRef.current = false;
    terminalSessionIdRef.current = undefined;
    setTerminalSessionId(undefined);
    if (!sessionId) return;
    await transport.kubernetesStopPodTerminal({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      sessionId,
    }).catch((reason) => setExecError(errorMessage(reason)));
  };

  const closeTerminal = () => {
    void stopTerminal();
    setExecResource(undefined);
  };

  const portForwardKey = (item: ResourceItem) => `${item.namespace ?? ""}/${item.name}`;

  const startPortForward = async (item: ResourceItem) => {
    if (!selectedContext || !item.namespace) return;
    const suggestedRemote = item.columns.ports?.match(/\d+/)?.[0] ?? "8080";
    const remoteValue = window.prompt(`Remote port for ${item.name}`, suggestedRemote);
    if (remoteValue === null) return;
    const remotePort = Number(remoteValue);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      setActionError("Remote port must be between 1 and 65535");
      return;
    }
    const localValue = window.prompt("Local port (0 selects an available port)", String(remotePort));
    if (localValue === null) return;
    const localPort = Number(localValue);
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
      setActionError("Local port must be between 0 and 65535");
      return;
    }
    setActionError(undefined);
    const operationId = crypto.randomUUID();
    try {
      const response = await transport.kubernetesStartPodPortForward({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        operationId,
        context: selectedContext,
        namespace: item.namespace,
        pod: item.name,
        remotePort,
        localPort,
      });
      const key = portForwardKey(item);
      updatePortForwards({
        ...portForwardsRef.current,
        [key]: {
          operationId,
          localPort: response.localPort,
          remotePort: response.remotePort,
        },
      });
      setActionMessage(`Forwarding 127.0.0.1:${response.localPort} to ${item.name}:${response.remotePort}`);
    } catch (reason) {
      setActionError(errorMessage(reason));
    }
  };

  const stopPortForward = async (item: ResourceItem) => {
    const key = portForwardKey(item);
    const forward = portForwardsRef.current[key];
    if (!forward) return;
    try {
      await transport.kubernetesStopPodPortForward({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        operationId: forward.operationId,
      });
      const next = { ...portForwardsRef.current };
      delete next[key];
      updatePortForwards(next);
      setActionMessage(`Stopped port forward for ${item.name}`);
    } catch (reason) {
      setActionError(errorMessage(reason));
    }
  };

  const openKubectl = async () => {
    setKubectlOpen(true);
    setKubectlError(undefined);
    try {
      const response = await transport.kubectlInfo({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      });
      setKubectlInstallations(response.installations);
      setKubectlExecutable((current) => current || response.installations[0]?.path || "");
      if (response.installations.length === 0) {
        setKubectlError("kubectl was not found on PATH");
      }
    } catch (reason) {
      setKubectlError(errorMessage(reason));
    }
  };

  const runKubectl = async () => {
    if (!selectedContext || !kubectlExecutable) return;
    let argumentsList: string[];
    try {
      argumentsList = parseCommandArguments(kubectlCommand);
    } catch (reason) {
      setKubectlError(errorMessage(reason));
      return;
    }
    if (argumentsList[0]?.toLowerCase() === "kubectl") argumentsList.shift();
    if (argumentsList.length === 0) {
      setKubectlError("Enter a command, for example: get pods");
      return;
    }
    const operationId = crypto.randomUUID();
    kubectlOperationIdRef.current = operationId;
    setKubectlOperationId(operationId);
    setKubectlLoading(true);
    setKubectlError(undefined);
    setKubectlResult(undefined);
    try {
      const response = await transport.kubectlRun({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        operationId,
        executable: kubectlExecutable,
        context: selectedContext,
        namespace: selectedNamespace || null,
        arguments: argumentsList,
      });
      setKubectlResult(response);
    } catch (reason) {
      if (kubectlOperationIdRef.current === operationId) setKubectlError(errorMessage(reason));
    } finally {
      if (kubectlOperationIdRef.current === operationId) {
        kubectlOperationIdRef.current = undefined;
        setKubectlOperationId(undefined);
        setKubectlLoading(false);
      }
    }
  };

  const cancelKubectl = async () => {
    const operationId = kubectlOperationIdRef.current;
    if (!operationId) return;
    kubectlOperationIdRef.current = undefined;
    setKubectlOperationId(undefined);
    setKubectlLoading(false);
    await transport.kubectlCancel({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      operationId,
    }).catch((reason) => setKubectlError(errorMessage(reason)));
  };

  const closeKubectl = () => {
    void cancelKubectl();
    setKubectlOpen(false);
  };

  const stopLocalTerminal = async () => {
    const sessionId = localTerminalSessionIdRef.current;
    if (!sessionId) return;
    localTerminalSessionIdRef.current = undefined;
    setLocalTerminalSessionId(undefined);
    await transport.localTerminalStop({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      sessionId,
    }).catch((reason) => setLocalTerminalError(errorMessage(reason)));
    localXtermRef.current?.writeln("\r\n[PowerShell session stopped]");
  };

  const closeLocalTerminal = () => {
    void stopLocalTerminal();
    setLocalTerminalOpen(false);
  };

  const visibleResources = useMemo(() => {
    const query = resourceSearch.trim().toLowerCase();
    const filtered = query
      ? resources.filter((item) =>
          [item.name, item.namespace ?? "", ...Object.values(item.columns)]
            .some((value) => value.toLowerCase().includes(query))
        )
      : resources;
    const valueFor = (item: ResourceItem) => {
      if (sortKey === "name") return item.name;
      if (sortKey === "namespace") return item.namespace ?? "";
      if (sortKey === "age") return item.created ?? "";
      return item.columns[sortKey] ?? "";
    };
    return [...filtered].sort((left, right) => {
      const result = valueFor(left).localeCompare(valueFor(right), undefined, { numeric: true });
      return sortDirection === "asc" ? result : -result;
    });
  }, [resources, resourceSearch, sortKey, sortDirection]);

  const visibleHealthItems = useMemo(() => {
    const query = resourceSearch.trim().toLowerCase();
    if (!query) return healthItems;
    return healthItems.filter((item) =>
      [item.kind, item.name, item.namespace ?? "", ...Object.values(item.columns)]
        .some((value) => value.toLowerCase().includes(query))
    );
  }, [healthItems, resourceSearch]);

  useEffect(() => {
    if (activeView !== "resources") return;
    const container = resourceListRef.current;
    const table = resourceTableRef.current;
    if (!container || !table) return;
    const measure = () => {
      setResourceViewportHeight(container.clientHeight);
      setResourceTableTop(table.offsetTop);
      setResourceScrollTop(container.scrollTop);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(table);
    return () => observer.disconnect();
  }, [activeView, selectedKind, selectedColumns.length, actionError, actionMessage, metricsError]);

  useEffect(() => {
    if (activeView !== "resources") return;
    if (resourceListRef.current) resourceListRef.current.scrollTop = 0;
    setResourceScrollTop(0);
  }, [activeView, resourceSearch, selectedKind, selectedNamespace, sortKey, sortDirection]);

  useEffect(() => {
    closeResourceActionMenu();
  }, [activeView, resourceSearch, selectedKind, selectedNamespace, sortKey, sortDirection, resources.length, healthItems.length]);

  const resourceColumnCount = selectedKind === "Node"
    ? selectedColumns.length + 4
    : selectedColumns.length + (selectedKind === "Pod" ? 6 : 4);
  const virtualizeResources = visibleResources.length > RESOURCE_VIRTUAL_THRESHOLD;
  const resourceScrollInsideTable = Math.max(0, resourceScrollTop - resourceTableTop);
  const virtualStartIndex = virtualizeResources
    ? Math.max(0, Math.floor(resourceScrollInsideTable / RESOURCE_ROW_HEIGHT) - RESOURCE_VIRTUAL_OVERSCAN)
    : 0;
  const virtualVisibleCount = virtualizeResources
    ? Math.ceil(resourceViewportHeight / RESOURCE_ROW_HEIGHT) + RESOURCE_VIRTUAL_OVERSCAN * 2
    : visibleResources.length;
  const virtualEndIndex = virtualizeResources
    ? Math.min(visibleResources.length, virtualStartIndex + virtualVisibleCount)
    : visibleResources.length;
  const renderedResources = virtualizeResources
    ? visibleResources.slice(virtualStartIndex, virtualEndIndex)
    : visibleResources;
  const resourceTopSpacerHeight = virtualStartIndex * RESOURCE_ROW_HEIGHT;
  const resourceBottomSpacerHeight = Math.max(0, (visibleResources.length - virtualEndIndex) * RESOURCE_ROW_HEIGHT);
  const handleResourceListScroll = (event: ReactUIEvent<HTMLElement>) => {
    setResourceScrollTop(event.currentTarget.scrollTop);
  };

  const visibleEvents = useMemo(() => {
    const query = resourceSearch.trim().toLowerCase();
    const filtered = events.filter((event) => {
      if (eventTypeFilter && event.eventType !== eventTypeFilter) return false;
      if (!query) return true;
      return [
        event.reason ?? "",
        event.message ?? "",
        event.namespace ?? "",
        event.objectKind ?? "",
        event.objectName ?? "",
      ].some((value) => value.toLowerCase().includes(query));
    });

    if (!eventSortKey) return filtered;

    return [...filtered].sort((left, right) => {
      const valueFor = (event: KubernetesEventItem) => {
        switch (eventSortKey) {
          case "type":
            return event.eventType ?? "";
          case "reason":
            return event.reason ?? "";
          case "namespace":
            return event.namespace ?? event.objectNamespace ?? "";
          case "object":
            return `${event.objectKind ?? ""}/${event.objectName ?? ""}`;
          case "count":
            return String(event.count ?? "");
          case "lastSeen":
            return event.timestamp ?? "";
          default:
            return "";
        }
      };
      const result = valueFor(left).localeCompare(valueFor(right), undefined, { numeric: true });
      return eventSortDirection === "asc" ? result : -result;
    });
  }, [events, eventTypeFilter, resourceSearch, eventSortKey, eventSortDirection]);

  const changeEventSort = (key: string) => {
    if (eventSortKey === key) {
      setEventSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setEventSortKey(key);
      setEventSortDirection("asc");
    }
  };

  const renderSortButton = (
    key: string,
    label: string,
    activeKey: string,
    direction: "asc" | "desc",
    onChange: (key: string) => void,
  ) => {
    const active = activeKey === key;
    return (
      <button
        className={`sort-button${active ? " active" : ""} ${active && direction === "desc" ? "descending" : "ascending"}`}
        onClick={() => onChange(key)}
        aria-label={`Sort by ${label}${active ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
      >
        <span className="sort-label">{label}</span>
        <span className="sort-indicator" aria-hidden="true" />
      </button>
    );
  };

  const openEventObject = (event: KubernetesEventItem) => {
    if (!event.objectKind || !event.objectApiVersion || !event.objectName) return;
    openDetail({
      kind: event.objectKind,
      apiVersion: event.objectApiVersion,
      name: event.objectName,
      namespace: event.objectNamespace,
      uid: null,
      created: null,
      columns: {},
    });
  };

  const changeSort = (key: string) => {
    if (sortKey === key) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };

  const renderResourceSortButton = (key: string, label: string) =>
    renderSortButton(key, label, sortKey, sortDirection, changeSort);

  const renderEventSortButton = (key: string, label: string) =>
    renderSortButton(key, label, eventSortKey, eventSortDirection, changeEventSort);

  const renderConfigMapDataSection = () => {
    if (!detail || detail.kind !== "ConfigMap" || detail.apiVersion !== "v1") return null;
    const entries = Object.entries(configMapDataDraft).sort(([left], [right]) => left.localeCompare(right));
    const originalEntries = detail.configMapData
      .map((item) => [item.name, item.value] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    const changed = JSON.stringify(entries) !== JSON.stringify(originalEntries);

    return (
      <section className="detail-section secret-data-section">
        <h4>Data</h4>
        {entries.length === 0 ? (
          <p>No data</p>
        ) : (
          <>
            {entries.map(([name, value]) => (
              <div key={name} className="secret-data-entry">
                <label htmlFor={`config-map-data-${name}`}>{name}</label>
                <div className="secret-data-value no-toggle">
                  <textarea
                    id={`config-map-data-${name}`}
                    value={value}
                    onChange={(event) => editConfigMapData(name, event.target.value)}
                    disabled={actionLoading}
                    spellCheck={false}
                    rows={Math.max(1, Math.min(8, value.split("\n").length))}
                  />
                </div>
              </div>
            ))}
            <button className="primary-button" onClick={() => void saveConfigMapData()} disabled={actionLoading || !changed}>
              {actionLoading ? "Saving..." : "Save"}
            </button>
          </>
        )}
      </section>
    );
  };

  const renderSecretDataSection = () => {
    if (!detail || detail.kind !== "Secret" || detail.apiVersion !== "v1") return null;
    const entries = Object.entries(secretDataDraft).sort(([left], [right]) => left.localeCompare(right));
    const originalEntries = detail.secretData
      .map((item) => [item.name, item.value] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    const changed = JSON.stringify(entries) !== JSON.stringify(originalEntries);

    return (
      <section className="detail-section secret-data-section">
        <h4>Data</h4>
        {entries.length === 0 ? (
          <p>No data</p>
        ) : (
          <>
            {entries.map(([name, encodedValue]) => {
              const decodedValue = decodeUtf8Base64(encodedValue);
              const canReveal = typeof decodedValue === "string";
              const revealed = canReveal && revealedSecretData.has(name);
              const displayValue = revealed ? decodedValue : encodedValue;
              return (
                <div key={name} className="secret-data-entry">
                  <label htmlFor={`secret-data-${name}`}>{name}</label>
                  <div className="secret-data-value">
                    <textarea
                      id={`secret-data-${name}`}
                      value={displayValue}
                      onChange={(event) => editSecretData(name, event.target.value)}
                      disabled={actionLoading}
                      spellCheck={false}
                      rows={Math.max(1, Math.min(6, displayValue.split("\n").length))}
                    />
                    {canReveal && (
                      <button
                        type="button"
                        className={`secret-visibility-button ${revealed ? "revealed" : ""}`}
                        onClick={() => toggleSecretDataReveal(name)}
                        title={revealed ? "Hide" : "Show"}
                        aria-label={`${revealed ? "Hide" : "Show"} ${name}`}
                        disabled={actionLoading}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          {revealed ? (
                            <>
                              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                              <circle cx="12" cy="12" r="3" />
                            </>
                          ) : (
                            <>
                              <path d="M3 3l18 18" />
                              <path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a17.2 17.2 0 0 1-3.1 3.7" />
                              <path d="M6.2 6.9C3.8 8.5 2.5 12 2.5 12s3.5 6 9.5 6a9.7 9.7 0 0 0 4.1-.9" />
                              <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                            </>
                          )}
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <button className="primary-button" onClick={() => void saveSecretData()} disabled={actionLoading || !changed}>
              {actionLoading ? "Saving..." : "Save"}
            </button>
          </>
        )}
      </section>
    );
  };

  const resourceActionMenuKey = (item: ResourceItem) =>
    `${item.apiVersion}/${item.kind}/${item.namespace ?? ""}/${item.name}`;

  const closeResourceActionMenu = () => setOpenResourceActionMenu(undefined);

  const runTopbarMenuAction = (action: () => void) => {
    setTopbarMenuOpen(false);
    action();
  };

  useEffect(() => {
    if (!topbarMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (topbarMenuRef.current && !topbarMenuRef.current.contains(event.target as Node)) {
        setTopbarMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [topbarMenuOpen]);

  const toggleResourceActionMenu = (event: ReactMouseEvent, item: ResourceItem) => {
    event.stopPropagation();
    const key = resourceActionMenuKey(item);
    setOpenResourceActionMenu((current) => current === key ? undefined : key);
  };

  const runResourceMenuAction = (event: ReactMouseEvent, action: () => void) => {
    event.stopPropagation();
    closeResourceActionMenu();
    action();
  };

  const renderResourceActionsMenu = (item: ResourceItem) => {
    const key = resourceActionMenuKey(item);
    const isOpen = openResourceActionMenu === key;
    return (
      <td className="actions" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="action-menu-trigger"
          aria-label={`Actions for ${item.kind} ${item.name}`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          onClick={(event) => toggleResourceActionMenu(event, item)}
        >
          <span aria-hidden="true" />
        </button>
        {isOpen && (
          <div className="action-menu" role="menu">
            {item.kind === "Pod" && item.apiVersion === "v1" && item.namespace && (
              <>
                <button type="button" role="menuitem" onClick={(event) => runResourceMenuAction(event, () => startLogs(item))}>
                  Logs
                </button>
                <button type="button" role="menuitem" onClick={(event) => runResourceMenuAction(event, () => void openExec(item))}>
                  Terminal
                </button>
                {portForwards[portForwardKey(item)] ? (
                  <button type="button" role="menuitem" onClick={(event) => runResourceMenuAction(event, () => void stopPortForward(item))}>
                    Stop {portForwards[portForwardKey(item)].localPort}:{portForwards[portForwardKey(item)].remotePort}
                  </button>
                ) : (
                  <button type="button" role="menuitem" onClick={(event) => runResourceMenuAction(event, () => void startPortForward(item))}>
                    Port Forward
                  </button>
                )}
              </>
            )}
            {(item.kind === "Deployment" || item.kind === "StatefulSet")
              && item.apiVersion === "apps/v1" && item.namespace
              && <button type="button" role="menuitem" disabled={Boolean(resourceActionKey)} onClick={(event) => runResourceMenuAction(event, () => void scaleWorkload(item))}>
                {resourceActionKey === `${item.kind}/${item.namespace}/${item.name}/scale` ? "Scaling..." : "Scale"}
              </button>}
            {(item.kind === "Deployment" || item.kind === "StatefulSet" || item.kind === "DaemonSet")
              && item.apiVersion === "apps/v1" && item.namespace
              && <button type="button" role="menuitem" disabled={Boolean(resourceActionKey)} onClick={(event) => runResourceMenuAction(event, () => void restartWorkload(item))}>
                {resourceActionKey === `${item.kind}/${item.namespace}/${item.name}/restart` ? "Restarting..." : "Restart"}
              </button>}
            {item.kind === "CronJob" && item.apiVersion === "batch/v1" && item.namespace
              && <button type="button" role="menuitem" disabled={Boolean(resourceActionKey)} onClick={(event) => runResourceMenuAction(event, () => void triggerCronJob(item))}>
                {resourceActionKey === `${item.kind}/${item.namespace}/${item.name}/trigger` ? "Starting..." : "Run now"}
              </button>}
            <button
              type="button"
              role="menuitem"
              className="danger-button"
              disabled={Boolean(resourceActionKey)}
              onClick={(event) => runResourceMenuAction(event, () => void deleteResource(item))}
            >
              {resourceActionKey === `${item.kind}/${item.namespace ?? ""}/${item.name}/delete` ? "Deleting..." : "Delete"}
            </button>
          </div>
        )}
      </td>
    );
  };

  const renderResourceRow = (item: ResourceItem) => (
    <tr
      key={`${item.apiVersion}/${item.namespace ?? ""}/${item.name}`}
      className="clickable-resource-row"
      tabIndex={0}
      onClick={() => {
        closeResourceActionMenu();
        openDetail(item);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        closeResourceActionMenu();
        openDetail(item);
      }}
    >
      <td>{item.name}</td>
      {selectedKind === "Node" ? <>
        {selectedColumns.slice(0, 2).map((column) => <td key={column.key}>{item.columns[column.key] ?? "-"}</td>)}
        <td title={item.created ? new Date(item.created).toLocaleString() : undefined}>{formatAge(item.created)}</td>
        {selectedColumns.slice(2).map((column) => <td key={column.key}>{item.columns[column.key] ?? "-"}</td>)}
        <td>{formatCpu(metrics[`/${item.name}`]?.cpuMillicores)}</td>
        <td>{formatMemory(metrics[`/${item.name}`]?.memoryBytes)}</td>
      </> : <>
        <td>{item.namespace ?? "-"}</td>
        {selectedColumns.map((column) => <td key={column.key}>{item.columns[column.key] ?? "-"}</td>)}
        {selectedKind === "Pod" && <>
          <td>{formatCpu(metrics[`${item.namespace ?? ""}/${item.name}`]?.cpuMillicores)}</td>
          <td>{formatMemory(metrics[`${item.namespace ?? ""}/${item.name}`]?.memoryBytes)}</td>
        </>}
        <td title={item.created ? new Date(item.created).toLocaleString() : undefined}>{formatAge(item.created)}</td>
      </>}
      {renderResourceActionsMenu(item)}
    </tr>
  );

  const navigationGroups = useMemo(() => {
    const query = resourceCatalogSearch.trim().toLowerCase();
    const matchesQuery = (resource: ResourceKindItem) => !query || [
      resource.kind,
      resource.plural,
      resource.group,
      resource.version,
    ].some((value) => value.toLowerCase().includes(query));
    const coreKeys = new Set(FALLBACK_RESOURCE_KINDS.map(resourceKey));
    const coreGroups = RESOURCE_GROUPS.map((group) => ({
      label: group.label,
      resources: group.kinds.flatMap((kind) => {
        const expected = FALLBACK_RESOURCE_KINDS.find((item) => item.kind === kind);
        if (!expected) return [];
        const discovered = resourceKinds.find((item) => resourceKey(item) === resourceKey(expected));
        return discovered && matchesQuery(discovered) ? [discovered] : [];
      }),
    })).filter((group) => group.resources.length > 0);
    const moreResources = resourceKinds
      .filter((item) => !coreKeys.has(resourceKey(item)))
      .filter(matchesQuery)
      .sort((left, right) =>
        left.group.localeCompare(right.group) || left.kind.localeCompare(right.kind)
      );
    return moreResources.length > 0
      ? [...coreGroups, { label: "More Resources", resources: moreResources }]
      : coreGroups;
  }, [resourceKinds, resourceCatalogSearch]);
  const favoriteResources = useMemo(() => {
    const query = resourceCatalogSearch.trim().toLowerCase();
    const resourcesByKey = new Map<string, ResourceKindItem>();
    for (const resource of [...FALLBACK_RESOURCE_KINDS, ...resourceKinds]) {
      resourcesByKey.set(resourceKey(resource), resource);
    }
    return favoriteResourceKeys
      .flatMap((key) => {
        const resource = resourcesByKey.get(key);
        if (!resource) return [];
        if (!query) return [resource];
        const values = [
          resource.kind,
          resourceKindLabel(resource.kind),
          resource.plural,
          resource.group,
          resource.version,
        ];
        return values.some((value) => value.toLowerCase().includes(query)) ? [resource] : [];
      });
  }, [favoriteResourceKeys, resourceKinds, resourceCatalogSearch]);
  const filteredKubeconfigContexts = useMemo(() => {
    const query = kubeconfigSearch.trim().toLocaleLowerCase();
    if (!kubeconfig) return [];
    if (!query) return kubeconfig.contexts;
    return kubeconfig.contexts.filter((ctx) =>
      [ctx.name, ctx.cluster, ctx.user ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(query)
      )
    );
  }, [kubeconfig, kubeconfigSearch]);
  const switchContext = (context: string) => {
    if (!context) return;
    void cancelKubectl();
    closeLocalTerminal();
    for (const forward of Object.values(portForwardsRef.current)) {
      void transport.kubernetesStopPodPortForward({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        operationId: forward.operationId,
      });
    }
    updatePortForwards({});
    setSelectedContextAndRef(context);
    setPendingContext(context);
    setNamespaces([]);
    setSelectedNamespace("");
    setResources([]);
    setDetail(undefined);
    closeTerminal();
    setLogs([]);
    resourceRequestRef.current += 1;
    closeLogs();
  };
  const reloadKubeconfigFromSources = async (sources: string[]) => {
    const nextSources = uniqueKubeconfigSources(sources);
    setKubeconfigError(undefined);
    setKubeconfigSources(nextSources);
    const response = await transport.kubeconfigList({
      meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      sources: nextSources,
    });
    setKubeconfig(response);
    const nextContext = response.contexts.some((item) => item.name === selectedContext)
      ? selectedContext
      : response.currentContext ?? response.contexts[0]?.name ?? "";
    setSelectedContextAndRef(nextContext);
    setPendingContext(nextContext);
    setNamespaces([]);
    setSelectedNamespace("");
    setResources([]);
    setDetail(undefined);
    setLogs([]);
    resourceRequestRef.current += 1;
    closeLogs();
    closeTerminal();
    closeLocalTerminal();
  };
  const addKubeconfigSource = (source: string) => {
    const normalized = normalizeKubeconfigSource(source);
    if (!normalized) return;
    setKubeconfigSourceDraft("");
    void reloadKubeconfigFromSources([...kubeconfigSources, normalized]).catch((reason) =>
      setKubeconfigError(errorMessage(reason))
    );
  };
  const addKubeconfigSources = (sources: string[]) => {
    const normalized = uniqueKubeconfigSources(sources);
    if (normalized.length === 0) return;
    setKubeconfigSourceDraft("");
    void reloadKubeconfigFromSources([...kubeconfigSources, ...normalized]).catch((reason) =>
      setKubeconfigError(errorMessage(reason))
    );
  };
  const chooseKubeconfigFiles = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Select kubeconfig files",
    });
    if (!selected) return;
    addKubeconfigSources(Array.isArray(selected) ? selected : [selected]);
  };
  const chooseKubeconfigFolder = async () => {
    const selected = await open({
      multiple: false,
      directory: true,
      title: "Select kubeconfig folder",
    });
    if (!selected || Array.isArray(selected)) return;
    addKubeconfigSources([selected]);
  };
  const removeKubeconfigSource = (source: string) => {
    void reloadKubeconfigFromSources(kubeconfigSources.filter((item) => item !== source)).catch((reason) =>
      setKubeconfigError(errorMessage(reason))
    );
  };
  const reloadContexts = () => {
    void reloadKubeconfigFromSources(kubeconfigSources).catch((reason) =>
      setKubeconfigError(errorMessage(reason))
    );
  };
  const hasResourceCatalogSearch = Boolean(resourceCatalogSearch.trim());
  const allNavigationGroupsExpanded = !collapsedGroups[FAVORITES_GROUP_LABEL]
    && navigationGroups.every((group) => !collapsedGroups[group.label]);
  const toggleAllNavigationGroups = () => {
    const nextCollapsed = allNavigationGroupsExpanded;
    setCollapsedGroups((current) => ({
      ...current,
      [FAVORITES_GROUP_LABEL]: nextCollapsed,
      ...Object.fromEntries(navigationGroups.map((group) => [group.label, nextCollapsed])),
    }));
  };
  const renderResourceNavigationItem = (resource: ResourceKindItem, groupLabel: string) => {
    const key = resourceKey(resource);
    const isFavorite = favoriteResourceKeys.includes(key);
    return (
      <li key={key}>
        <div className="nav-resource-row">
          <button
            type="button"
            className={`nav-resource-link ${activeView === "resources" && resourceKey(selectedResource) === key ? "active" : ""}`}
            title={resourceApiVersion(resource)}
            onClick={() => selectResource(resource)}
          >
            <ResourceIcon kind={resource.kind} />
            <span>{groupLabel === "More Resources" && resource.group
              ? `${resourceKindLabel(resource.kind)} (${resource.group})`
              : resourceKindLabel(resource.kind)}</span>
          </button>
          <button
            type="button"
            className={`nav-pin-button ${isFavorite ? "pinned" : ""}`}
            onClick={() => toggleFavoriteResource(resource)}
            aria-label={`${isFavorite ? "Remove from" : "Add to"} favorites: ${resourceKindLabel(resource.kind)}`}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <PinIcon pinned={isFavorite} />
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className="app-shell">
      {activeView !== "contexts" && (
        <>
          <aside className="sidebar" style={{ width: sidebarWidth }}>
            <div className="sidebar-header">
              <h1>Freelens</h1>
              <button
                type="button"
                className="sidebar-context-card"
                onClick={() => setActiveView("contexts")}
                title="Back to contexts"
              >
                <span className="sidebar-context-home">{"<"}</span>
                <span className="sidebar-context-name">{selectedContext || "No context"}</span>
              </button>
              <input
                className="resource-catalog-search"
                type="search"
                placeholder="Find resource type"
                value={resourceCatalogSearch}
                onChange={(event) => setResourceCatalogSearch(event.target.value)}
              />
            </div>

            <nav className="sidebar-nav">
              <div className="nav-group overview-navigation">
                <ul>
                  <li>
                    <button
                      className={activeView === "overview" ? "active" : ""}
                      onClick={() => setActiveView("overview")}
                    >
                      <NavigationIcon name="overview" />
                      <span>Overview</span>
                    </button>
                  </li>
                  <li>
                    <button
                      className={activeView === "events" ? "active" : ""}
                      onClick={() => setActiveView("events")}
                    >
                      <NavigationIcon name="events" />
                      <span>Events</span>
                    </button>
                  </li>
                </ul>
              </div>
              <div className="nav-group-tools">
                <button
                  type="button"
                  className="nav-icon-button"
                  onClick={toggleAllNavigationGroups}
                  disabled={hasResourceCatalogSearch || (navigationGroups.length === 0 && favoriteResourceKeys.length === 0)}
                  aria-label={allNavigationGroupsExpanded ? "Collapse all resource groups" : "Expand all resource groups"}
                  title={allNavigationGroupsExpanded ? "Collapse all" : "Expand all"}
                >
                  <NavigationIcon name={allNavigationGroupsExpanded ? "collapseAll" : "expandAll"} />
                </button>
              </div>
              <div className="nav-group favorites-navigation">
                <button
                  className="nav-group-header"
                  onClick={() => toggleNavigationGroup(FAVORITES_GROUP_LABEL)}
                  aria-expanded={!collapsedGroups[FAVORITES_GROUP_LABEL] || hasResourceCatalogSearch}
                >
                  <NavigationIcon name="favorites" />
                  <span>Favorites</span>
                  <span className="nav-chevron">{collapsedGroups[FAVORITES_GROUP_LABEL] && !hasResourceCatalogSearch ? ">" : "v"}</span>
                </button>
                <ul hidden={collapsedGroups[FAVORITES_GROUP_LABEL] && !hasResourceCatalogSearch}>
                  {favoriteResources.length > 0 ? (
                    favoriteResources.map((resource) => renderResourceNavigationItem(resource, FAVORITES_GROUP_LABEL))
                  ) : (
                    <li className="nav-empty-state">{hasResourceCatalogSearch ? "No matching favorites" : "No favorites yet"}</li>
                  )}
                </ul>
              </div>
              {navigationGroups.map((group) => (
                <div key={group.label} className="nav-group">
                  <button
                    className="nav-group-header"
                    onClick={() => toggleNavigationGroup(group.label)}
                    aria-expanded={!collapsedGroups[group.label] || hasResourceCatalogSearch}
                  >
                    <NavigationIcon name={GROUP_ICONS[group.label] ?? "more"} />
                    <span>{group.label}</span>
                    <span className="nav-chevron">{collapsedGroups[group.label] && !hasResourceCatalogSearch ? ">" : "v"}</span>
                  </button>
                  <ul hidden={collapsedGroups[group.label] && !hasResourceCatalogSearch}>
                    {group.resources.map((resource) => renderResourceNavigationItem(resource, group.label))}
                  </ul>
                </div>
              ))}
              {resourceDiscoveryError && (
                <p className="sidebar-warning" title={resourceDiscoveryError}>Using built-in resource catalog</p>
              )}
            </nav>
          </aside>
          <div
            className="sidebar-resizer"
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            onPointerDown={startSidebarResize}
          />
        </>
      )}

      <main className="main">
        {activeView !== "contexts" && <header className="topbar">
          <div className="title-with-status">
            <h2>{activeView === "overview" ? "Cluster Overview" : activeView === "events" ? "Events" : activeView === "health" ? healthTitle : resourceKindLabel(selectedKind)}</h2>
            {(activeView === "resources" || activeView === "events") && <span className={`watch-status ${watchStatus}`}>Watch: {watchStatus}</span>}
            {activeView === "overview" && overview?.metricsError && (
              <span className="metrics-warning" title={overview.metricsError}>
                Metrics are unavailable. Resource and health summaries are still available.
              </span>
            )}
            {activeView === "resources" && metricsError && (selectedKind === "Pod" || selectedKind === "Node") && (
              <span className="metrics-warning" title={metricsError}>
                Metrics are unavailable. Resource browsing is unaffected.
              </span>
            )}
          </div>
          <div className="topbar-controls">
            {activeView === "resources" && <>
              <input
                type="search"
                placeholder="Search resources"
                value={resourceSearch}
                onChange={(event) => setResourceSearch(event.target.value)}
              />
              <select
                value={selectedNamespace}
                onChange={(event) => {
                  resourceRequestRef.current += 1;
                  setSelectedNamespace(event.target.value);
                }}
                disabled={!selectedResource.namespaced}
                title={namespacesError ? `Failed to load namespaces: ${namespacesError}` : undefined}
              >
                <option value="">All namespaces</option>
                {availableNamespaces.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </>}
            {activeView === "events" && <>
              <input
                type="search"
                placeholder="Search events"
                value={resourceSearch}
                onChange={(event) => setResourceSearch(event.target.value)}
              />
              <select
                value={selectedNamespace}
                onChange={(event) => setSelectedNamespace(event.target.value)}
                title={namespacesError ? `Failed to load namespaces: ${namespacesError}` : undefined}
              >
                <option value="">All namespaces</option>
                {availableNamespaces.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <select value={eventTypeFilter} onChange={(event) => setEventTypeFilter(event.target.value)}>
                <option value="">All event types</option>
                <option value="Normal">Normal</option>
                <option value="Warning">Warning</option>
              </select>
            </>}
            {activeView === "health" && (
              <input
                type="search"
                placeholder={`Search ${healthTitle.toLowerCase()}`}
                value={resourceSearch}
                onChange={(event) => setResourceSearch(event.target.value)}
              />
            )}
            <select value={refreshSeconds} onChange={(event) => setRefreshSeconds(Number(event.target.value))}>
              <option value={0}>Auto refresh: Off</option>
              <option value={5}>Every 5s</option>
              <option value={15}>Every 15s</option>
              <option value={30}>Every 30s</option>
            </select>
            <button
              onClick={() => activeView === "overview" ? loadOverview()
                : activeView === "events" ? loadEvents()
                  : activeView === "health" && healthTitle === "Abnormal Pods" ? openAbnormalPods()
                    : activeView === "health" && healthTitle === "Unavailable Workloads" ? openUnavailableWorkloads()
                      : loadResources()}
              disabled={activeView === "overview" ? overviewLoading : activeView === "events" ? eventsLoading : activeView === "health" ? healthLoading : resourcesLoading}
            >
              Refresh
            </button>
            <div className="topbar-action-menu" ref={topbarMenuRef}>
              <button
                type="button"
                className="action-menu-trigger"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={topbarMenuOpen}
                onClick={() => setTopbarMenuOpen((current) => !current)}
              >
                <span aria-hidden="true" />
              </button>
              {topbarMenuOpen && (
                <div className="action-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => runTopbarMenuAction(openCreate)}>
                    Create Resource
                  </button>
                  <button type="button" role="menuitem" onClick={() => runTopbarMenuAction(() => void openKubectl())}>
                    Kubectl
                  </button>
                  <button type="button" role="menuitem" onClick={() => runTopbarMenuAction(() => setLocalTerminalOpen(true))}>
                    Shell
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>}

        {activeView === "contexts" ? (
          <section className="context-home">
            <button
              type="button"
              className="context-settings-top"
              onClick={() => setKubeconfigSettingsOpen(true)}
            >
              Settings
            </button>
            <div className="context-home-inner">
              <div className="context-home-header">
                <div>
                  <h2>Freelens</h2>
                  <p>Select one context to get started.</p>
                  {kubeconfig && kubeconfig.duplicateContexts.length > 0 && (
                    <div className="kubeconfig-duplicates-warning">
                      <p>You have {kubeconfig.duplicateContexts.length} duplicate contexts in your Kubeconfig files.</p>
                      <p>To avoid mistakes and accidental connections to the wrong cluster, it's recommended to delete or rename them.</p>
                      <p>Duplicate: {kubeconfig.duplicateContexts.join(", ")}</p>
                    </div>
                  )}
                  {kubeconfigError && <p className="error-message compact-error">{kubeconfigError}</p>}
                </div>
                <div className="context-home-tools">
                  <input
                    type="search"
                    placeholder="Search contexts"
                    value={kubeconfigSearch}
                    onChange={(event) => setKubeconfigSearch(event.target.value)}
                  />
                  <div className="context-view-toggle" role="group" aria-label="Context display mode">
                    <button
                      type="button"
                      className={contextDisplayMode === "grid" ? "active" : ""}
                      onClick={() => setContextDisplayMode("grid")}
                      title="Grid view"
                    >
                      Grid
                    </button>
                    <button
                      type="button"
                      className={contextDisplayMode === "list" ? "active" : ""}
                      onClick={() => setContextDisplayMode("list")}
                      title="List view"
                    >
                      List
                    </button>
                  </div>
                  <button type="button" onClick={reloadContexts}>
                    Reload
                  </button>
                </div>
              </div>

              <div className={`context-results context-results-${contextDisplayMode}`}>
                {filteredKubeconfigContexts.map((ctx) => (
                  <button
                    key={ctx.name}
                    type="button"
                    className={`context-result ${pendingContext === ctx.name ? "active" : ""}`}
                    onClick={() => setPendingContext(ctx.name)}
                    onDoubleClick={() => {
                      switchContext(ctx.name);
                      setActiveView("overview");
                    }}
                  >
                    <span className="context-result-icon">K8s</span>
                    <span className="context-result-name">{ctx.name}</span>
                    <span className="context-result-cluster">{ctx.cluster}</span>
                  </button>
                ))}
                {kubeconfig && filteredKubeconfigContexts.length === 0 && (
                  <p className="empty-state">No matching contexts.</p>
                )}
                {!kubeconfig && <p>Loading contexts...</p>}
              </div>

              <div className="context-home-footer">
                <button
                  type="button"
                  onClick={() => {
                    const context = pendingContext || selectedContext;
                    switchContext(context);
                    if (context) setActiveView("overview");
                  }}
                  disabled={!pendingContext && !selectedContext}
                >
                  Connect {"->"}
                </button>
              </div>
            </div>
          </section>
        ) : activeView === "overview" ? (
          <section className="dashboard">
            {overviewError ? <p className="error-message">{overviewError}</p> : overviewLoading && !overview ? (
              <p>Loading cluster overview…</p>
            ) : overview && (
              <>
                <div className="dashboard-grid">
                  <button className="dashboard-card" onClick={() => openResourceKind("Node")}>
                    <span>Nodes</span><strong>{overview.readyNodes}/{overview.nodes}</strong><small>Ready</small>
                  </button>
                  <button className="dashboard-card" onClick={() => openResourceKind("Pod")}>
                    <span>Pods</span><strong>{overview.runningPods}/{overview.pods}</strong><small>Running</small>
                  </button>
                  <button className="dashboard-card" onClick={() => openResourceKind("Deployment")}>
                    <span>Workloads</span><strong>{overview.workloads}</strong><small>Deployments, StatefulSets, DaemonSets</small>
                  </button>
                  <div className="dashboard-card">
                    <span>Namespaces</span><strong>{overview.namespaces}</strong><small>Cluster total</small>
                  </div>
                  <div className="dashboard-card">
                    <span>CPU Usage</span><strong>{formatCpu(overview.cpuMillicores)}</strong><small>Across nodes</small>
                  </div>
                  <div className="dashboard-card">
                    <span>Memory Usage</span><strong>{formatMemory(overview.memoryBytes)}</strong><small>Across nodes</small>
                  </div>
                </div>
                <section className="dashboard-health">
                  <h3>Cluster Health</h3>
                  <button onClick={openAbnormalPods} className={overview.abnormalPods ? "has-issues" : ""}>
                    <strong>{overview.abnormalPods}</strong><span>Abnormal Pods</span>
                  </button>
                  <button onClick={openUnavailableWorkloads} className={overview.unavailableWorkloads ? "has-issues" : ""}>
                    <strong>{overview.unavailableWorkloads}</strong><span>Unavailable Workloads</span>
                  </button>
                </section>
              </>
            )}
          </section>
        ) : activeView === "health" ? (
          healthError ? <p className="error-message">{healthError}</p> : (
            <section className="resource-list health-drilldown">
              <div className="resource-list-scroll">
                <table>
                  <thead><tr><th>Kind</th><th>Name</th><th>Namespace</th><th>Status</th><th>Ready</th><th>Age</th><th>Actions</th></tr></thead>
                  <tbody>
                    {visibleHealthItems.map((item) => (
                      <tr
                        key={`${item.kind}/${item.namespace ?? ""}/${item.name}`}
                        className="clickable-resource-row"
                        tabIndex={0}
                        onClick={() => {
                          closeResourceActionMenu();
                          openDetail(item);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          closeResourceActionMenu();
                          openDetail(item);
                        }}
                      >
                        <td>{item.kind}</td>
                        <td>{item.name}</td>
                        <td>{item.namespace ?? "-"}</td>
                        <td>{item.columns.status ?? item.columns.available ?? "-"}</td>
                        <td>{item.columns.ready ?? item.columns.available ?? "-"}</td>
                        <td title={item.created ? new Date(item.created).toLocaleString() : undefined}>{formatAge(item.created)}</td>
                        {renderResourceActionsMenu(item)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(healthLoading && healthItems.length === 0) || (!healthLoading && visibleHealthItems.length === 0) ? (
                <div className="resource-list-footer">
                  {healthLoading && healthItems.length === 0 && <p>Loading {healthTitle.toLowerCase()}…</p>}
                  {!healthLoading && visibleHealthItems.length === 0 && <p>No matching {healthTitle.toLowerCase()}.</p>}
                </div>
              ) : null}
            </section>
          )
        ) : activeView === "events" ? (
          eventsError ? <p className="error-message">{eventsError}</p> : (
            <section className="resource-list events-list">
              <div className="resource-list-scroll">
                <table>
                  <thead><tr><th>Last Seen</th><th>{renderEventSortButton("type", "Type")}</th><th>Reason</th><th>Object</th><th>Namespace</th><th>Message</th><th>Count</th></tr></thead>
                  <tbody>
                    {visibleEvents.map((event, index) => (
                      <tr key={`${event.timestamp ?? ""}-${event.objectKind ?? ""}-${event.objectName ?? ""}-${index}`}>
                        <td title={event.timestamp ? new Date(event.timestamp).toLocaleString() : undefined}>{formatAge(event.timestamp)}</td>
                        <td><span className={`event-type ${event.eventType?.toLowerCase() ?? ""}`}>{event.eventType ?? "-"}</span></td>
                        <td>{event.reason ?? "-"}</td>
                        <td>
                          {event.objectKind && event.objectName ? (
                            <button className="event-object" onClick={() => openEventObject(event)}>
                              {event.objectKind}/{event.objectName}
                            </button>
                          ) : "-"}
                        </td>
                        <td>{event.namespace ?? event.objectNamespace ?? "-"}</td>
                        <td className="event-message">{event.message ?? "-"}</td>
                        <td>{event.count ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(eventsLoading && events.length === 0) || (!eventsLoading && visibleEvents.length === 0) ? (
                <div className="resource-list-footer">
                  {eventsLoading && events.length === 0 && <p>Loading events…</p>}
                  {!eventsLoading && visibleEvents.length === 0 && <p>No matching events.</p>}
                </div>
              ) : null}
            </section>
          )
        ) : resourcesError ? (
          <p className="error-message">{resourcesError}</p>
        ) : (
          <section className="resource-list">
            {(actionError || actionMessage) && (
              <div className="resource-list-banner">
                {actionError && <p className="inline-message error-message">{actionError}</p>}
                {actionMessage && <p className="inline-message success-message">{actionMessage}</p>}
              </div>
            )}
            <div className="resource-list-scroll" ref={resourceListRef} onScroll={handleResourceListScroll}>
              <table ref={resourceTableRef} className={virtualizeResources ? "virtualized-table" : undefined}>
                <thead>
                  <tr>
                    <th>{renderResourceSortButton("name", "Name")}</th>
                    {selectedKind === "Node" ? <>
                      {selectedColumns.slice(0, 2).map((column) => (
                        <th key={column.key}>{renderResourceSortButton(column.key, column.label)}</th>
                      ))}
                      <th>{renderResourceSortButton("age", "Age")}</th>
                      {selectedColumns.slice(2).map((column) => (
                        <th key={column.key}>{renderResourceSortButton(column.key, column.label)}</th>
                      ))}
                      <th>CPU</th><th>Memory</th>
                    </> : <>
                      <th>{renderResourceSortButton("namespace", "Namespace")}</th>
                      {selectedColumns.map((column) => (
                        <th key={column.key}>{renderResourceSortButton(column.key, column.label)}</th>
                      ))}
                      {selectedKind === "Pod" && <><th>CPU</th><th>Memory</th></>}
                      <th>{renderResourceSortButton("age", "Age")}</th>
                    </>}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {resourceTopSpacerHeight > 0 && (
                    <tr className="virtual-spacer-row" aria-hidden="true">
                      <td colSpan={resourceColumnCount} style={{ height: resourceTopSpacerHeight }} />
                    </tr>
                  )}
                  {renderedResources.map(renderResourceRow)}
                  {resourceBottomSpacerHeight > 0 && (
                    <tr className="virtual-spacer-row" aria-hidden="true">
                      <td colSpan={resourceColumnCount} style={{ height: resourceBottomSpacerHeight }} />
                    </tr>
                  )}
                </tbody>
              </table>
              {resourcesLoading && resources.length === 0 && <p className="resource-list-placeholder">Loading…</p>}
            </div>
            {(continueToken || (resourceSearch.trim() && continueToken)) && (
              <div className="resource-list-footer">
                {continueToken && !resourceSearch.trim() && (
                  <button
                    className="load-more"
                    onClick={() => loadResources(continueToken)}
                    disabled={resourcesLoading}
                  >
                    Load more
                  </button>
                )}
                {resourceSearch.trim() && continueToken && (
                  <p className="pagination-status">
                    {resourcesLoading ? "Searching remaining pages..." : "Preparing next search page..."}
                  </p>
                )}
              </div>
            )}
          </section>
        )}
      </main>

      {(detail || detailLoading || detailError) && (
        <div className="detail-panel-overlay" onClick={closeDetail}>
          <div className="detail-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>
                {detail ? `${detail.kind}: ${detail.name}` : detailLoading ? "Loading…" : "Error"}
              </h3>
              <div>
                {detail && (
                  <button onClick={() => openDetail({
                    kind: detail.kind,
                    apiVersion: detail.apiVersion,
                    name: detail.name,
                    namespace: detail.namespace,
                    uid: null,
                    created: null,
                    columns: {},
                  })}>Refresh</button>
                )}
                <button onClick={closeDetail}>Close</button>
              </div>
            </header>
            {detailError ? (
              <p className="error-message">{detailError}</p>
            ) : detailLoading ? (
              <p>Loading YAML…</p>
            ) : detail ? (
              <>
                <div className="detail-tabs">
                  <button className={detailTab === "overview" ? "active" : ""} onClick={() => setDetailTab("overview")}>Overview</button>
                  <button className={detailTab === "yaml" ? "active" : ""} onClick={() => setDetailTab("yaml")}>YAML</button>
                </div>
                {actionError && <p className="inline-message error-message">{actionError}</p>}
                {actionMessage && <p className="inline-message success-message">{actionMessage}</p>}
                {detailTab === "yaml" ? (
                  <div className="yaml-editor">
                    {yamlEditing ? (
                      <textarea value={yamlDraft} onChange={(event) => setYamlDraft(event.target.value)} spellCheck={false} autoFocus />
                    ) : (
                      <>
                        <p className="yaml-hint">Read-only — click Edit to modify</p>
                        <YamlView yaml={yamlDraft} showManagedFields={yamlShowManagedFields} />
                      </>
                    )}
                    <div className="editor-actions">
                      <div className="editor-actions-left">
                        <button onClick={() => setYamlEditing((current) => !current)}>
                          {yamlEditing ? "Done" : "Edit"}
                        </button>
                        <button onClick={() => void copyYaml()}>
                          {yamlCopyHint ?? "Copy"}
                        </button>
                        {!yamlEditing && (
                          <label className="yaml-checkbox">
                            <input
                              type="checkbox"
                              checked={yamlShowManagedFields}
                              onChange={(event) => setShowYamlManagedFields(event.target.checked)}
                            />
                            Managed Fields
                          </label>
                        )}
                      </div>
                      <div className="editor-actions-right">
                        <button onClick={() => setYamlDraft(detail.yaml)} disabled={actionLoading}>Reset</button>
                        <button onClick={() => void applyYaml()} disabled={actionLoading || yamlDraft === detail.yaml}>
                          {actionLoading ? "Applying..." : "Apply"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="detail-overview">
                    {detail.sections.map((section) => (
                      <section key={section.title} className="detail-section">
                        <h4>{section.title}</h4>
                        <dl>{section.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
                      </section>
                    ))}
                    {renderConfigMapDataSection()}
                    {renderSecretDataSection()}
                    {detail.containers.length > 0 && (
                      <section className="detail-section"><h4>Containers</h4><table><thead><tr><th>Name</th><th>Image</th><th>State</th><th>Ready</th><th>Restarts</th></tr></thead><tbody>{detail.containers.map((container) => <tr key={container.name}><td>{container.name}</td><td>{container.image}</td><td>{container.state}</td><td>{container.ready ? "Yes" : "No"}</td><td>{container.restarts}</td></tr>)}</tbody></table></section>
                    )}
                    <section className="detail-section"><h4>Events</h4>{detail.events.length === 0 ? <p>No events</p> : <table><thead><tr><th>Type</th><th>Reason</th><th>Message</th><th>Count</th><th>Last seen</th></tr></thead><tbody>{detail.events.map((event, index) => <tr key={`${event.reason}-${index}`}><td>{event.eventType ?? "-"}</td><td>{event.reason ?? "-"}</td><td>{event.message ?? "-"}</td><td>{event.count ?? "-"}</td><td>{event.timestamp ? new Date(event.timestamp).toLocaleString() : "-"}</td></tr>)}</tbody></table>}</section>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {createOpen && (
        <div className="detail-panel-overlay" onClick={() => !createLoading && setCreateOpen(false)}>
          <div className="detail-panel create-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>Create Resource</h3>
              <button onClick={() => setCreateOpen(false)} disabled={createLoading}>Close</button>
            </header>
            <p className="panel-hint">Apply one Kubernetes resource to {selectedContext}.</p>
            {createError && <p className="inline-message error-message">{createError}</p>}
            <div className="yaml-editor">
              <textarea
                value={createYaml}
                onChange={(event) => setCreateYaml(event.target.value)}
                spellCheck={false}
                autoFocus
              />
              <div className="editor-actions">
                <div className="editor-actions-right">
                  <button onClick={() => void createResource()} disabled={createLoading || !createYaml.trim()}>
                    {createLoading ? "Applying..." : "Apply Resource"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {localTerminalOpen && (
        <div className="detail-panel-overlay" onClick={closeLocalTerminal}>
          <div className="detail-panel local-terminal-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>PowerShell: {selectedContext}</h3>
              <div>
                {localTerminalSessionId && <button onClick={() => void stopLocalTerminal()}>Stop</button>}
                <button onClick={closeLocalTerminal}>Close</button>
              </div>
            </header>
            <div className="local-terminal-status">
              <span>{localTerminalShell || "Starting PowerShell..."}</span>
              <span>FREELENS_CONTEXT={selectedContext}</span>
              {selectedNamespace && <span>FREELENS_NAMESPACE={selectedNamespace}</span>}
            </div>
            {localTerminalError && <p className="error-message">{localTerminalError}</p>}
            <div
              ref={localTerminalHostRef}
              className="exec-output local-terminal-output"
              role="application"
              aria-label="Local PowerShell terminal"
              tabIndex={0}
              onClick={() => localXtermRef.current?.focus()}
            />
          </div>
        </div>
      )}

      {kubectlOpen && (
        <div className="detail-panel-overlay" onClick={closeKubectl}>
          <div className="detail-panel kubectl-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>Kubectl: {selectedContext}</h3>
              <div>
                {kubectlOperationId && <button onClick={() => void cancelKubectl()}>Stop</button>}
                <button onClick={closeKubectl}>Close</button>
              </div>
            </header>
            <div className="kubectl-controls">
              <select
                value={kubectlExecutable}
                onChange={(event) => setKubectlExecutable(event.target.value)}
                disabled={kubectlLoading}
              >
                {kubectlInstallations.map((installation) => (
                  <option key={installation.path} value={installation.path}>
                    {installation.version} - {installation.path}
                  </option>
                ))}
              </select>
              <div className="kubectl-command-row">
                <span>kubectl</span>
                <input
                  value={kubectlCommand}
                  onChange={(event) => setKubectlCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !kubectlLoading) void runKubectl();
                  }}
                  placeholder="get pods -o wide"
                  disabled={kubectlLoading}
                  autoFocus
                />
                <button
                  onClick={() => void runKubectl()}
                  disabled={kubectlLoading || !kubectlExecutable || !kubectlCommand.trim()}
                >
                  {kubectlLoading ? "Running..." : "Run"}
                </button>
              </div>
              <p>
                Context: {selectedContext}; namespace: {selectedNamespace || "all namespaces"}
              </p>
            </div>
            {kubectlError && <p className="error-message">{kubectlError}</p>}
            <pre className="kubectl-output">
              {kubectlResult
                ? `${kubectlResult.stdout}${kubectlResult.stderr}${kubectlResult.outputTruncated ? "\n[Output truncated at 1 MiB]\n" : ""}\n[Exit code: ${kubectlResult.exitCode ?? "terminated"}]`
                : kubectlLoading ? "Running kubectl..." : "Enter a command to run kubectl."}
            </pre>
          </div>
        </div>
      )}

      {logResource && (
        <div className="detail-panel-overlay" onClick={closeLogs}>
          <div className="detail-panel log-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>Logs: {logResource.namespace}/{logResource.name}</h3>
              <div>
                {logOperationId ? (
                  <button onClick={() => void stopLogs()}>Stop</button>
                ) : (
                  <button onClick={() => logResource && setLogs([])}>Clear</button>
                )}
                <button onClick={closeLogs}>Close</button>
              </div>
            </header>
            <div className="log-controls">
              {logPreparing ? (
                <span>Loading containers…</span>
              ) : (
                <>
                  <select
                    value={selectedLogContainer}
                    onChange={(event) => setSelectedLogContainer(event.target.value)}
                    disabled={logContainers.length === 0 || Boolean(logOperationId)}
                  >
                    {logContainers.map((container) => (
                      <option key={container} value={container}>
                        {container}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => beginLogStream(selectedLogContainer)}
                    disabled={!selectedLogContainer || Boolean(logOperationId)}
                  >
                    {logOperationId ? "Streaming" : "Start logs"}
                  </button>
                </>
              )}
            </div>
            {logError && <p className="error-message">{logError}</p>}
            <div className="log-content">
              {logOperationId && logs.length === 0 && (
                <div className="log-empty">Waiting for log output…</div>
              )}
              {logs.map((line, index) => (
                <div key={index} className="log-line">
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      )}

      {execResource && (
        <div className="detail-panel-overlay" onClick={closeTerminal}>
          <div className="detail-panel exec-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>Terminal: {execResource.namespace}/{execResource.name}</h3>
              <div>
                {terminalSessionId && <button onClick={() => void stopTerminal()}>Stop</button>}
                <button onClick={closeTerminal}>Close</button>
              </div>
            </header>
            <div className="exec-controls">
              <select value={execContainer} onChange={(event) => setExecContainer(event.target.value)} disabled={execLoading || Boolean(terminalSessionId)}>
                {execContainers.map((container) => <option key={container} value={container}>{container}</option>)}
              </select>
              {terminalSessionId ? (
                <span className="terminal-hint">Connected. Type directly in the terminal.</span>
              ) : (
                <button type="button" onClick={() => void startTerminal()} disabled={execLoading || !execContainer || execContainers.length === 0}>
                  {execLoading ? "Starting..." : "Start Terminal"}
                </button>
              )}
            </div>
            {execError && <p className="error-message">{execError}</p>}
            <div
              ref={terminalHostRef}
              className="exec-output"
              role="application"
              aria-label="Pod terminal"
              tabIndex={0}
              onClick={focusTerminal}
              onDoubleClick={focusTerminal}
            />
          </div>
        </div>
      )}

      {kubeconfigSettingsOpen && (
        <div className="detail-panel-overlay" onClick={() => setKubeconfigSettingsOpen(false)}>
          <div className="detail-panel kubeconfig-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h3>Kubeconfig Sources</h3>
                <p className="panel-hint">
                  Add kubeconfig files or folders, or enter a path directly. Empty sources use kubectl's default location.
                </p>
              </div>
              <button onClick={() => setKubeconfigSettingsOpen(false)}>Close</button>
            </header>
            <div className="kubeconfig-source-list">
              {kubeconfig && kubeconfig.duplicateContexts.length > 0 && (
                <div className="kubeconfig-duplicates-warning">
                  <p>You have {kubeconfig.duplicateContexts.length} duplicate contexts in your Kubeconfig files.</p>
                  <p>To avoid mistakes and accidental connections to the wrong cluster, it's recommended to delete or rename them.</p>
                  <p>Duplicate: {kubeconfig.duplicateContexts.join(", ")}</p>
                </div>
              )}
              {(kubeconfig?.sources ?? []).map((source: KubeconfigSource) => (
                <div key={source.path} className="kubeconfig-source-item">
                  <span className="kubeconfig-source-icon">{source.kind === "directory" ? "[dir]" : "[file]"}</span>
                  <div>
                    <div className="kubeconfig-source-path">{source.path}</div>
                    <div className="kubeconfig-source-meta">
                      {source.fileCount} {source.fileCount === 1 ? "file" : "files"} / {source.contextCount} contexts
                    </div>
                  </div>
                  {kubeconfigSources.includes(source.path) && (
                    <button type="button" className="plain-danger-button" onClick={() => removeKubeconfigSource(source.path)}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {kubeconfigError && <p className="error-message">{kubeconfigError}</p>}
            </div>
            <form
              className="kubeconfig-source-form"
              onSubmit={(event) => {
                event.preventDefault();
                addKubeconfigSource(kubeconfigSourceDraft);
              }}
            >
              <div className="kubeconfig-source-row">
                <input
                  value={kubeconfigSourceDraft}
                  onChange={(event) => setKubeconfigSourceDraft(event.target.value)}
                  placeholder="C:\\Users\\MaBing\\.kube\\config or C:\\Users\\MaBing\\.kube\\configs"
                />
                <button type="submit" disabled={!kubeconfigSourceDraft.trim()}>
                  Enter Path
                </button>
              </div>
              <div className="kubeconfig-source-row">
                <input value="kubectl default: ~/.kube/config" readOnly />
                <button type="button" onClick={() => void reloadKubeconfigFromSources([]).catch((reason) => setKubeconfigError(errorMessage(reason)))}>
                  Use Default
                </button>
              </div>
              <div className="kubeconfig-source-actions">
                <button
                  type="button"
                  onClick={() => void chooseKubeconfigFiles().catch((reason) => setKubeconfigError(errorMessage(reason)))}
                >
                  Add Files
                </button>
                <button
                  type="button"
                  onClick={() => void chooseKubeconfigFolder().catch((reason) => setKubeconfigError(errorMessage(reason)))}
                >
                  Add Folder
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

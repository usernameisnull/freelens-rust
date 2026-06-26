import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  UIEvent as ReactUIEvent,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { open } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { basicSetup } from "codemirror";
import { yaml as yamlLanguage } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  searchKeymap,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import type { DecorationSet, Panel } from "@codemirror/view";
import { Decoration, EditorView, keymap, ViewPlugin, ViewUpdate } from "@codemirror/view";
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
  OwnerReferenceItem,
  ResourceMetricItem,
  ResourceKindItem,
  PodContainerSummary,
} from "./contracts";
import { createTransport } from "./transport";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const transport = createTransport();
const RESOURCE_ROW_HEIGHT = 44;
const RESOURCE_VIRTUAL_OVERSCAN = 8;
const RESOURCE_VIRTUAL_THRESHOLD = 80;
const MIN_PANEL_WIDTH = 420;
type AdjustablePanelKind = "detail" | "logs" | "terminal";
const DEFAULT_PANEL_WIDTHS: Record<AdjustablePanelKind, number> = {
  detail: 720,
  logs: 900,
  terminal: 1000,
};

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
    kinds: ["Service", "EndpointSlice", "Endpoints", "Ingress", "IngressClass", "NetworkPolicy"],
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

// Well-known Kubernetes API groups served by the core apiserver. Resources whose
// group is in this set (or the empty core group) are treated as built-in; any
// other group is a custom resource (CRD / aggregated API) and is grouped under
// its API group in the sidebar, mirroring the Freelens categorization.
const BUILTIN_API_GROUPS = new Set<string>([
  "",
  "apps",
  "batch",
  "networking.k8s.io",
  "discovery.k8s.io",
  "rbac.authorization.k8s.io",
  "autoscaling",
  "policy",
  "storage.k8s.io",
  "apiextensions.k8s.io",
  "scheduling.k8s.io",
  "node.k8s.io",
  "coordination.k8s.io",
  "events.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "metrics.k8s.io",
  "admissionregistration.k8s.io",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "certificates.k8s.io",
]);

const CLUSTER_SCOPED_BUILTIN_KINDS = new Set<string>([
  "Node",
  "PersistentVolume",
  "IngressClass",
]);

interface NavigationSubgroup {
  label: string;
  resources: ResourceKindItem[];
}

interface NavigationGroup {
  label: string;
  resources: ResourceKindItem[];
  subgroups?: NavigationSubgroup[];
}

type NavigationIcon = "overview" | "events" | "favorites" | "cluster" | "workloads" | "network" | "config" | "storage" | "more" | "customResources" | "collapseAll" | "expandAll";
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
  "Custom Resources": "customResources",
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
    customResources: <><path d="M6 4h7l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M13 4v5h5"/><path d="M9 13h6M9 17h4"/></>,
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

function NamespaceCombobox({
  namespaces,
  value,
  onChange,
  title,
  onOpen,
}: {
  namespaces: string[];
  value: string;
  onChange: (namespace: string) => void;
  title?: string;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const displayValue = inputValue;
  const filterValue = displayValue.trim().toLowerCase();
  const filteredNamespaces = useMemo(() => {
    if (!filterValue) return namespaces;
    return namespaces.filter((namespace) => namespace.toLowerCase().includes(filterValue));
  }, [filterValue, namespaces]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setInputValue("");
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const chooseNamespace = (namespace: string) => {
    setInputValue("");
    onChange(namespace);
    setOpen(false);
  };

  return (
    <div className="namespace-combobox" ref={rootRef} title={title}>
      <input
        type="text"
        value={displayValue}
        placeholder={value || "All namespaces"}
        onFocus={() => {
          onOpen?.();
          setOpen(true);
        }}
        onChange={(event) => {
          const next = event.target.value;
          setInputValue(next);
          onChange(next.trim());
          onOpen?.();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setInputValue("");
            setOpen(false);
          } else if (event.key === "Enter") {
            setInputValue("");
            setOpen(false);
          }
        }}
        aria-label="Namespace"
        aria-haspopup="listbox"
        aria-expanded={open}
      />
      {open && (
        <div className="namespace-combobox-menu" role="listbox">
          <button
            type="button"
            className={!value ? "active" : undefined}
            onClick={() => chooseNamespace("")}
          >
            All namespaces
          </button>
          {filteredNamespaces.length === 0 ? (
            <p>No namespaces found</p>
          ) : filteredNamespaces.map((namespace) => (
            <button
              type="button"
              key={namespace}
              className={namespace === value ? "active" : undefined}
              onClick={() => chooseNamespace(namespace)}
            >
              {namespace}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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


function yamlForManagedFieldsPreference(yaml: string, showManagedFields: boolean): string {
  if (showManagedFields) return yaml;
  const lines = yaml.split("\n").map(parseYamlLine);
  annotateLiteral(lines);
  return filterManagedFields(lines).map((line) => line.raw).join("\n");
}

function buttonElement(name: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.name = name;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function optionButtonElement(
  label: string,
  title: string,
  pressed: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const button = buttonElement("option", label, title, onClick);
  button.setAttribute("aria-pressed", String(pressed));
  return button;
}

class YamlSearchPanel implements Panel {
  readonly dom: HTMLDivElement;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly countLabel: HTMLSpanElement;
  private readonly replaceToggle: HTMLButtonElement;
  private readonly replaceRow: HTMLDivElement;
  private readonly caseButton: HTMLButtonElement;
  private readonly regexpButton: HTMLButtonElement;
  private readonly wordButton: HTMLButtonElement;
  private query: SearchQuery;
  private replaceOpen = false;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.dom = document.createElement("div");
    this.dom.className = "cm-search yaml-search-panel";
    this.dom.addEventListener("keydown", (event) => this.handleKeydown(event));

    this.replaceToggle = buttonElement("toggleReplace", "\u203a", "Show replace", () => {
      if (this.view.state.readOnly) return;
      this.replaceOpen = !this.replaceOpen;
      this.renderReplaceState();
      if (this.replaceOpen) this.replaceField.focus();
    });
    this.dom.append(this.replaceToggle);

    const fields = document.createElement("div");
    fields.className = "yaml-search-fields";

    const searchRow = document.createElement("div");
    searchRow.className = "yaml-search-row";
    this.searchField = document.createElement("input");
    this.searchField.name = "yaml-find-query";
    this.searchField.placeholder = "Find";
    this.searchField.setAttribute("aria-label", "Find");
    this.searchField.autocomplete = "off";
    this.searchField.autocapitalize = "off";
    this.searchField.spellcheck = false;
    this.searchField.setAttribute("data-lpignore", "true");
    this.searchField.setAttribute("data-form-type", "other");
    this.searchField.value = this.query.search;
    this.searchField.addEventListener("input", () => this.commit());
    searchRow.append(this.searchField);
    fields.append(searchRow);

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "yaml-search-row yaml-replace-row";
    this.replaceField = document.createElement("input");
    this.replaceField.name = "yaml-find-replace";
    this.replaceField.placeholder = "Replace";
    this.replaceField.setAttribute("aria-label", "Replace");
    this.replaceField.autocomplete = "off";
    this.replaceField.autocapitalize = "off";
    this.replaceField.spellcheck = false;
    this.replaceField.setAttribute("data-lpignore", "true");
    this.replaceField.setAttribute("data-form-type", "other");
    this.replaceField.value = this.query.replace;
    this.replaceField.addEventListener("input", () => this.commit());
    this.replaceRow.append(
      this.replaceField,
      buttonElement("replace", "AB", "Replace", () => replaceNext(this.view)),
      buttonElement("replaceAll", "AB*", "Replace all", () => replaceAll(this.view)),
    );
    fields.append(this.replaceRow);
    this.dom.append(fields);

    this.countLabel = document.createElement("span");
    this.countLabel.className = "yaml-search-count";
    const actions = document.createElement("div");
    actions.className = "yaml-search-actions";
    actions.append(
      this.countLabel,
      buttonElement("prev", "\u2191", "Previous match", () => findPrevious(this.view)),
      buttonElement("next", "\u2193", "Next match", () => findNext(this.view)),
      buttonElement("select", "\u2261", "Select all matches", () => selectMatches(this.view)),
    );

    this.caseButton = optionButtonElement("Aa", "Match case", this.query.caseSensitive, () => {
      this.updateQuery({ caseSensitive: !this.query.caseSensitive });
    });
    this.regexpButton = optionButtonElement(".*", "Use regular expression", this.query.regexp, () => {
      this.updateQuery({ regexp: !this.query.regexp });
    });
    this.wordButton = optionButtonElement("W", "Match whole word", this.query.wholeWord, () => {
      this.updateQuery({ wholeWord: !this.query.wholeWord });
    });
    actions.append(
      this.caseButton,
      this.regexpButton,
      this.wordButton,
      buttonElement("close", "\u00d7", "Close search", () => closeSearchPanel(this.view)),
    );
    this.dom.append(actions);

    this.renderReplaceState();
    this.updateCount();
  }

  mount() {
    this.searchField.select();
  }

  update() {
    const query = getSearchQuery(this.view.state);
    if (!query.eq(this.query)) this.setQuery(query);
    this.updateCount();
    this.renderReplaceState();
  }

  get top() {
    return true;
  }

  private commit() {
    this.updateQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
    });
  }

  private updateQuery(update: Partial<ConstructorParameters<typeof SearchQuery>[0]>) {
    const query = new SearchQuery({
      search: this.query.search,
      replace: this.query.replace,
      caseSensitive: this.query.caseSensitive,
      regexp: this.query.regexp,
      wholeWord: this.query.wholeWord,
      ...update,
    });
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.setQuery(query);
  }

  private setQuery(query: SearchQuery) {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseButton.setAttribute("aria-pressed", String(query.caseSensitive));
    this.regexpButton.setAttribute("aria-pressed", String(query.regexp));
    this.wordButton.setAttribute("aria-pressed", String(query.wholeWord));
    this.updateCount();
  }

  private updateCount() {
    if (!this.query.valid) {
      this.countLabel.textContent = "0/0";
      return;
    }
    const selection = this.view.state.selection.main;
    let total = 0;
    let current = 0;
    const cursor = this.query.getCursor(this.view.state);
    for (let cursorResult = cursor.next(); !cursorResult.done; cursorResult = cursor.next()) {
      const match = cursorResult.value;
      total += 1;
      if (match.from === selection.from && match.to === selection.to) current = total;
    }
    this.countLabel.textContent = total === 0 ? "0/0" : `${current || 1}/${total}`;
  }

  private renderReplaceState() {
    const canReplace = !this.view.state.readOnly;
    this.replaceToggle.disabled = !canReplace;
    this.replaceToggle.textContent = this.replaceOpen ? "\u2304" : "\u203a";
    this.replaceToggle.title = this.replaceOpen ? "Hide replace" : "Show replace";
    this.replaceRow.hidden = !canReplace || !this.replaceOpen;
  }

  private handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.key === "Enter" && event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(this.view);
    }
  }
}

interface YamlCodeEditorHandle {
  focus: () => void;
  openSearch: () => void;
  goToLine: (lineNumber: number) => void;
}

function selectedIndentDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    const firstLine = view.state.doc.lineAt(range.from).number;
    const lastLine = view.state.doc.lineAt(range.to).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
      const line = view.state.doc.line(lineNumber);
      const indentLength = line.text.match(/^[ \t]+/)?.[0].length ?? 0;
      const from = Math.max(range.from, line.from);
      const to = Math.min(range.to, line.from + indentLength);
      if (from < to) decorations.push(Decoration.mark({ class: "cm-selected-indent" }).range(from, to));
    }
  }
  return Decoration.set(decorations, true);
}

const selectedIndentMarkers = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = selectedIndentDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) {
      this.decorations = selectedIndentDecorations(update.view);
    }
  }
}, {
  decorations: (plugin) => plugin.decorations,
});

function yamlStructureSelectionDecorations(state: EditorState, lineNumber?: number): DecorationSet {
  if (!lineNumber || lineNumber < 1 || lineNumber > state.doc.lines) return Decoration.none;
  const line = state.doc.line(lineNumber);
  const decorations: Range<Decoration>[] = [
    Decoration.line({ class: "cm-structure-selected-line" }).range(line.from),
  ];
  const keyMatch = /^(\s*(?:-\s*)?)([^:#\n][^:\n]*)(:)/.exec(line.text);
  if (keyMatch) {
    const keyStart = line.from + keyMatch[1].length;
    const keyEnd = keyStart + keyMatch[2].trimEnd().length;
    if (keyStart < keyEnd) {
      decorations.push(Decoration.mark({ class: "cm-structure-selected-key" }).range(keyStart, keyEnd));
    }
  }
  return Decoration.set(decorations, true);
}

const YamlCodeEditor = forwardRef<YamlCodeEditorHandle, {
  value: string;
  editable: boolean;
  selectedLineNumber?: number;
  onChange: (value: string) => void;
  onCursorLineChange?: (lineNumber: number) => void;
}>(function YamlCodeEditor({ value, editable, selectedLineNumber, onChange, onCursorLineChange }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableCompartmentRef = useRef(new Compartment());
  const structureSelectionCompartmentRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  const syncingValueRef = useRef(false);
  onChangeRef.current = onChange;
  onCursorLineChangeRef.current = onCursorLineChange;

  const emitCursorLine = useCallback((view: EditorView) => {
    onCursorLineChangeRef.current?.(view.state.doc.lineAt(view.state.selection.main.head).number);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    openSearch: () => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      openSearchPanel(view);
    },
    goToLine: (lineNumber: number) => {
      const view = viewRef.current;
      if (!view) return;
      const line = view.state.doc.line(Math.min(Math.max(lineNumber, 1), view.state.doc.lines));
      const target = line.from;
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: "center", x: "nearest" }),
      });
      view.focus();
      emitCursorLine(view);
    },
  }), [emitCursorLine]);

  useEffect(() => {
    if (!hostRef.current) return;
    const editableCompartment = editableCompartmentRef.current;
    const structureSelectionCompartment = structureSelectionCompartmentRef.current;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(keymap.of([
            {
              key: "Mod-f",
              run: openSearchPanel,
              scope: "editor search-panel",
            },
            ...searchKeymap,
          ])),
          basicSetup,
          search({ top: true, createPanel: (view) => new YamlSearchPanel(view) }),
          yamlLanguage(),
          selectedIndentMarkers,
          structureSelectionCompartment.of(
            EditorView.decorations.of((view) => yamlStructureSelectionDecorations(view.state, selectedLineNumber))
          ),
          syntaxHighlighting(HighlightStyle.define([
            { tag: [tags.keyword, tags.propertyName, tags.typeName], color: "#58d1b5" },
            { tag: [tags.string, tags.number, tags.bool, tags.null], color: "#79a8ff" },
            { tag: tags.comment, color: "#63717e" },
          ])),
          editableCompartment.of([
            EditorState.readOnly.of(!editable),
            EditorView.editable.of(editable),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncingValueRef.current) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              emitCursorLine(update.view);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    emitCursorLine(view);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
    if (editable) view.focus();
  }, [editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    syncingValueRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    syncingValueRef.current = false;
    emitCursorLine(view);
  }, [value, emitCursorLine]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: structureSelectionCompartmentRef.current.reconfigure(
        EditorView.decorations.of((currentView) => yamlStructureSelectionDecorations(currentView.state, selectedLineNumber))
      ),
    });
  }, [selectedLineNumber]);

  return <div className="yaml-code-editor" ref={hostRef} />;
});

interface YamlOutlineNode {
  id: string;
  label: string;
  lineNumber: number;
  indent: number;
  path: string[];
  idPath: string[];
  isListItem: boolean;
  isBlockParent: boolean;
  children: YamlOutlineNode[];
}

function yamlOutlineLabel(line: YamlParsedLine): string | undefined {
  if (line.hasMapping && line.key) return line.isListItem ? `- ${line.key}` : line.key;
  if (line.isListItem && line.body) return "-";
  return undefined;
}

function parseYamlOutline(yaml: string): YamlOutlineNode[] {
  const lines = yaml.split("\n").map(parseYamlLine);
  annotateLiteral(lines);
  const roots: YamlOutlineNode[] = [];
  const stack: YamlOutlineNode[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.isBlank || line.isComment || line.literal) continue;
    const label = yamlOutlineLabel(line);
    if (!label) continue;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const sameIndentListChild = line.isListItem && top.isBlockParent && top.indent === line.indent;
      if (sameIndentListChild || top.indent < line.indent) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const id = `${index + 1}:${line.indent}:${label}`;
    const node: YamlOutlineNode = {
      id,
      label,
      lineNumber: index + 1,
      indent: line.indent,
      path: [...(parent?.path ?? []), label],
      idPath: [...(parent?.idPath ?? []), id],
      isListItem: line.isListItem,
      isBlockParent: line.hasMapping && (!line.value || line.value === ""),
      children: [],
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function flattenYamlOutline(nodes: YamlOutlineNode[]): YamlOutlineNode[] {
  return nodes.flatMap((node) => [node, ...flattenYamlOutline(node.children)]);
}

function yamlPathForLine(outline: YamlOutlineNode[], lineNumber: number): YamlOutlineNode[] {
  const allNodes = flattenYamlOutline(outline);
  const candidate = [...allNodes].reverse().find((node) => node.lineNumber <= lineNumber);
  if (!candidate) return [];
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  return candidate.idPath.map((id) => byId.get(id)).filter((node): node is YamlOutlineNode => Boolean(node));
}

function YamlStructureNode({
  node,
  activePath,
  collapsed,
  onToggle,
  onJump,
}: {
  node: YamlOutlineNode;
  activePath: string;
  collapsed: Set<string>;
  onToggle: (nodeId: string) => void;
  onJump: (lineNumber: number) => void;
}) {
  const nodePath = JSON.stringify(node.idPath);
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  return (
    <li>
      <div className={`yaml-structure-row${nodePath === activePath ? " active" : ""}`} style={{ paddingLeft: `${8 + (node.path.length - 1) * 14}px` }}>
        <button
          type="button"
          className="yaml-structure-toggle"
          onClick={() => hasChildren && onToggle(node.id)}
          disabled={!hasChildren}
          aria-label={hasChildren ? (isCollapsed ? "Expand node" : "Collapse node") : undefined}
          aria-expanded={hasChildren ? !isCollapsed : undefined}
        >
          {hasChildren ? (isCollapsed ? "▸" : "▾") : ""}
        </button>
        <button
          type="button"
          className="yaml-structure-label"
          onClick={() => onJump(node.lineNumber)}
          title={`Line ${node.lineNumber}`}
        >
          {node.label}
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <ul>
          {node.children.map((child) => (
            <YamlStructureNode
              key={child.id}
              node={child}
              activePath={activePath}
              collapsed={collapsed}
              onToggle={onToggle}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function YamlStructurePanel({
  outline,
  activePath,
  onJump,
  resetKey,
}: {
  outline: YamlOutlineNode[];
  activePath: string;
  onJump: (lineNumber: number) => void;
  resetKey: unknown;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setCollapsed(new Set(flattenYamlOutline(outline).filter((node) => node.children.length > 0).map((node) => node.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (!activePath) return;
    try {
      const activeIds = JSON.parse(activePath) as string[];
      const ancestorIds = activeIds.slice(0, -1);
      if (ancestorIds.length === 0) return;
      setCollapsed((current) => {
        const next = new Set(current);
        ancestorIds.forEach((id) => next.delete(id));
        return next;
      });
    } catch {
      // Ignore malformed active paths; they are derived locally and should not fail rendering.
    }
  }, [activePath]);

  const toggle = useCallback((nodeId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  return (
    <aside className="yaml-structure-panel" aria-label="YAML structure">
      <div className="yaml-structure-heading">Structure</div>
      {outline.length === 0 ? (
        <p>No YAML structure</p>
      ) : (
        <ul>
          {outline.map((node) => (
            <YamlStructureNode
              key={node.id}
              node={node}
              activePath={activePath}
              collapsed={collapsed}
              onToggle={toggle}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function YamlBreadcrumb({ path, activeLine, onJump }: { path: YamlOutlineNode[]; activeLine: number; onJump: (lineNumber: number) => void }) {
  return (
    <div className="yaml-breadcrumb" aria-label="YAML cursor path">
      <span>Line {activeLine}</span>
      {path.length === 0 ? (
        <span>Document</span>
      ) : path.map((node) => (
        <button key={node.id} type="button" onClick={() => onJump(node.lineNumber)} title={`Line ${node.lineNumber}`}>
          {node.label}
        </button>
      ))}
    </div>
  );
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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      const container = event.currentTarget;
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };

  return (
    <div className="yaml-view" tabIndex={-1} onCopy={handleCopy} onKeyDown={handleKeyDown}>
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
  EndpointSlice: "discovery.k8s.io/v1",
  Endpoints: "v1",
  Ingress: "networking.k8s.io/v1",
  IngressClass: "networking.k8s.io/v1",
  NetworkPolicy: "networking.k8s.io/v1",
  ConfigMap: "v1",
  Secret: "v1",
  PersistentVolumeClaim: "v1",
  PersistentVolume: "v1",
  Node: "v1",
};

const ALREADY_PLURAL_KINDS = new Set<string>(["Endpoints"]);

const FALLBACK_RESOURCE_KINDS: ResourceKindItem[] = RESOURCE_GROUPS.flatMap((group) =>
  group.kinds.map((kind) => {
    const apiVersion = RESOURCE_API_VERSIONS[kind];
    const [apiGroup, version] = apiVersion.includes("/") ? apiVersion.split("/", 2) : ["", apiVersion];
    return {
      group: apiGroup,
      version,
      kind,
      plural: resourceKindLabel(kind).toLowerCase(),
      scope: CLUSTER_SCOPED_BUILTIN_KINDS.has(kind) ? "Cluster" : "Namespaced",
      namespaced: !CLUSTER_SCOPED_BUILTIN_KINDS.has(kind),
      columns: [],
    };
  })
);

const RESOURCE_COLUMNS: Record<string, Array<{ key: string; label: string }>> = {
  Pod: [
    { key: "status", label: "Status" },
    { key: "ready", label: "Ready" },
    { key: "containers", label: "Containers" },
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

type ResourceStatusTone = "success" | "warning" | "error" | "info" | "muted" | "neutral";

function parseReplicaPair(value: string | undefined): { current: number; desired: number } | undefined {
  const [current, desired] = (value ?? "").split("/", 2).map((part) => Number(part));
  if (!Number.isFinite(current) || !Number.isFinite(desired)) return undefined;
  return { current, desired };
}

function replicaTone(current: number, desired: number): ResourceStatusTone {
  if (desired <= 0) return "muted";
  if (current >= desired) return "success";
  if (current <= 0) return "error";
  return "warning";
}

function statusTextTone(value: string): ResourceStatusTone {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "-") return "neutral";
  if (["running", "ready", "active", "bound", "available", "complete", "completed", "succeeded", "scheduled"].includes(normalized)) {
    return "success";
  }
  if (["pending", "waiting", "restarted", "suspended", "unschedulable"].includes(normalized)) {
    return "warning";
  }
  if (
    ["failed", "error", "evicted", "notready", "not ready", "crashloopbackoff", "crash-loop-back-off", "replicafailure", "failuretarget"].includes(normalized)
    || normalized.includes("error")
    || normalized.includes("fail")
    || normalized.includes("crash")
  ) {
    return "error";
  }
  if (["containercreating", "container-creating", "progressing"].includes(normalized)) {
    return "info";
  }
  if (["terminating", "terminated", "finalizing", "unknown", "<none>"].includes(normalized)) {
    return "muted";
  }
  return "neutral";
}

function resourceColumnTone(kind: string, columnKey: string, columns: Record<string, string>): ResourceStatusTone {
  const value = columns[columnKey] ?? "";

  if (columnKey === "status") {
    return statusTextTone(value);
  }

  if ((kind === "Deployment" || kind === "StatefulSet") && columnKey === "ready") {
    const pair = parseReplicaPair(value);
    return pair ? replicaTone(pair.current, pair.desired) : "neutral";
  }

  if ((kind === "Deployment" || kind === "StatefulSet") && (columnKey === "available" || columnKey === "upToDate")) {
    const pair = parseReplicaPair(columns.ready);
    const desired = pair?.desired ?? Number(columns.ready ?? 0);
    const current = Number(value);
    return Number.isFinite(current) && Number.isFinite(desired) ? replicaTone(current, desired) : "neutral";
  }

  if (kind === "DaemonSet" && ["current", "ready", "available"].includes(columnKey)) {
    const desired = Number(columns.desired ?? 0);
    const current = Number(value);
    return Number.isFinite(current) && Number.isFinite(desired) ? replicaTone(current, desired) : "neutral";
  }

  if (kind === "Job") {
    if (columnKey === "failed") return Number(value) > 0 ? "error" : "muted";
    if (columnKey === "active") return Number(value) > 0 ? "info" : "muted";
    if (columnKey === "completions") {
      const pair = parseReplicaPair(value);
      return pair ? replicaTone(pair.current, pair.desired) : "neutral";
    }
  }

  if (kind === "CronJob" && columnKey === "suspend") {
    return value === "true" ? "muted" : "success";
  }

  return "neutral";
}

function renderResourceStatusValue(kind: string, columnKey: string, columns: Record<string, string>, fallback = "-") {
  const value = columns[columnKey] ?? fallback;
  const tone = resourceColumnTone(kind, columnKey, columns);
  return <span className={`resource-status resource-status-${tone}`}>{value}</span>;
}

function activeContainerStateKey(container: PodContainerSummary): keyof PodContainerSummary["state"] | "" {
  return Object.keys(container.state ?? {})[0] as keyof PodContainerSummary["state"] | "";
}

function lastContainerStateKey(container: PodContainerSummary): keyof PodContainerSummary["lastState"] | "" {
  return Object.keys(container.lastState ?? {})[0] as keyof PodContainerSummary["lastState"] | "";
}

function podContainerStatusClassName(container: PodContainerSummary): string {
  const state = activeContainerStateKey(container);
  const lastState = lastContainerStateKey(container);

  if (state === "terminated") return "terminated";
  if (container.type === "ephemeralContainers" && lastState === "terminated") return "terminated";
  if (container.type === "ephemeralContainers") return "container-ephemeral";
  if (container.ready && container.restartCount > 0) return "restarted";
  if (container.ready) return "running";
  if (state === "running") return "waiting";
  return state;
}

function startCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatContainerDetailValue(value: string | number | boolean | null): string {
  if (value === null) return "";
  return String(value);
}

function renderPodContainerTooltip(container: PodContainerSummary) {
  const state = activeContainerStateKey(container);
  if (!state) return null;
  const stateDetails = container.state[state] ?? {};
  const terminated = state === "terminated" ? container.state.terminated : undefined;
  const terminatedReason = terminated?.reason;
  const terminatedExitCode = terminated?.exitCode;

  return (
    <div className="pod-container-tooltip" role="tooltip">
      <div className="title">
        {container.name}{" "}
        <span className="text-secondary">
          {state}
          {container.type === "initContainers" ? ", init" : ""}
          {container.type === "ephemeralContainers" ? ", ephemeral" : ""}
          {container.restartCount ? ", restarted" : ""}
          {container.ready ? ", ready" : ""}
          {terminated ? ` - ${terminatedReason ?? ""} (exit code: ${terminatedExitCode ?? ""})` : ""}
        </span>
      </div>
      {Object.entries(stateDetails).map(([name, value]) => (
        <span key={name} className="pod-container-tooltip-row">
          <span className="name">{startCase(name)}</span>
          <span className="value">{formatContainerDetailValue(value)}</span>
        </span>
      ))}
    </div>
  );
}

function renderPodContainers(containers: PodContainerSummary[] | undefined) {
  if (!containers?.length) return "-";
  return (
    <span className="pod-containers">
      {containers.map((container) => {
        const tooltip = renderPodContainerTooltip(container);
        return (
          <span key={`${container.type}/${container.name}`} className="pod-container-brick-wrap">
            <span className={`pod-container-brick ${podContainerStatusClassName(container)}`} aria-label={container.name} />
            {tooltip}
          </span>
        );
      })}
    </span>
  );
}

function renderResourceColumnValue(item: ResourceItem, columnKey: string) {
  if (item.kind === "Pod" && columnKey === "containers") {
    return renderPodContainers(item.podContainers);
  }
  return renderResourceStatusValue(item.kind, columnKey, item.columns);
}

interface OwnerChainEntry {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
  uid: string | null;
  controller?: boolean | null;
  object?: ResourceItem;
}

interface OwnerChain {
  entries: OwnerChainEntry[];
  complete: boolean;
}

function ownerReferenceKey(apiVersion: string, kind: string, namespace: string | null | undefined, name: string): string {
  return `${apiVersion}/${kind}/${namespace ?? ""}/${name}`;
}

function ownerLookupKey(reference: OwnerReferenceItem, namespace: string | null | undefined): string {
  return ownerReferenceKey(reference.apiVersion, reference.kind, namespace, reference.name);
}

function resourceLookupKey(item: ResourceItem): string {
  return ownerReferenceKey(item.apiVersion, item.kind, item.namespace, item.name);
}

function ownerReferenceToEntry(reference: OwnerReferenceItem, namespace: string | null | undefined, object?: ResourceItem): OwnerChainEntry {
  return {
    apiVersion: reference.apiVersion,
    kind: reference.kind,
    name: reference.name,
    namespace: object?.namespace ?? namespace ?? null,
    uid: reference.uid,
    controller: reference.controller,
    object,
  };
}

function buildOwnerLookup(items: ResourceItem[]): Map<string, ResourceItem> {
  const lookup = new Map<string, ResourceItem>();
  for (const item of items) {
    lookup.set(resourceLookupKey(item), item);
    if (item.uid) lookup.set(item.uid, item);
  }
  return lookup;
}

function ownerEntryLabel(entry: OwnerChainEntry): string {
  return `${entry.kind}(${entry.name})`;
}

function ownerChainLabel(chain: OwnerChain): string {
  return chain.entries.map(ownerEntryLabel).join(" -> ");
}

function ownerChainDisplayEntry(chain: OwnerChain): OwnerChainEntry | undefined {
  return chain.entries[0];
}

function buildOwnerChains(item: ResourceItem, ownerLookup: Map<string, ResourceItem>): OwnerChain[] {
  return item.ownerReferences.map((reference) => {
    const entries: OwnerChainEntry[] = [];
    const seen = new Set<string>();
    let currentReference: OwnerReferenceItem | undefined = reference;
    let currentNamespace = item.namespace;
    let complete = true;

    while (currentReference) {
      const lookupKey = ownerLookupKey(currentReference, currentNamespace);
      const object: ResourceItem | undefined = ownerLookup.get(currentReference.uid) ?? ownerLookup.get(lookupKey);
      const entry = ownerReferenceToEntry(currentReference, currentNamespace, object);
      const cycleKey = currentReference.uid || lookupKey;

      if (seen.has(cycleKey)) {
        complete = false;
        break;
      }

      seen.add(cycleKey);
      entries.push(entry);

      if (!object) {
        complete = false;
        break;
      }

      currentReference = object.ownerReferences.find((owner: OwnerReferenceItem) => owner.controller) ?? object.ownerReferences[0];
      currentNamespace = object.namespace;
    }

    return { entries, complete };
  });
}

function podControlledBySortValue(item: ResourceItem, ownerLookup: Map<string, ResourceItem>): string {
  return buildOwnerChains(item, ownerLookup)
    .map(ownerChainDisplayEntry)
    .filter((entry): entry is OwnerChainEntry => Boolean(entry))
    .map((entry) => `${entry.kind}/${entry.name}`)
    .join(", ");
}

function resourceKindLabel(kind: string): string {
  if (ALREADY_PLURAL_KINDS.has(kind)) return kind;
  if (kind.endsWith("s") || kind.endsWith("x") || kind.endsWith("ch") || kind.endsWith("sh")) {
    return `${kind}es`;
  }
  if (kind.endsWith("y") && !/[aeiou]y$/i.test(kind)) return `${kind.slice(0, -1)}ies`;
  return `${kind}s`;
}

// Built-in kubectl short names keyed by Kubernetes kind (singular).
// Custom resources are intentionally omitted (no stable short names).
const RESOURCE_SHORT_NAMES: Record<string, string> = {
  Pod: "po",
  Deployment: "deploy",
  StatefulSet: "sts",
  DaemonSet: "ds",
  ReplicaSet: "rs",
  ReplicationController: "rc",
  CronJob: "cj",
  Service: "svc",
  Ingress: "ing",
  ConfigMap: "cm",
  PersistentVolumeClaim: "pvc",
  PersistentVolume: "pv",
  Node: "no",
  Namespace: "ns",
  Endpoints: "ep",
  EndpointSlice: "eps",
  Event: "ev",
  ServiceAccount: "sa",
  HorizontalPodAutoscaler: "hpa",
  PodDisruptionBudget: "pdb",
  NetworkPolicy: "netpol",
  StorageClass: "sc",
  VolumeSnapshot: "vs",
  PriorityClass: "pc",
  LimitRange: "limits",
  ResourceQuota: "quota",
  CustomResourceDefinition: "crd",
  ControllerRevision: "ctrlrev",
};

function resourceShortName(kind: string): string | undefined {
  return RESOURCE_SHORT_NAMES[kind];
}

function resourceKindLabelWithShortName(kind: string): string {
  const label = resourceKindLabel(kind);
  const shortName = resourceShortName(kind);
  return shortName ? `${label} (${shortName})` : label;
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

function formatClusterEndpoint(server: string | null | undefined): string | null {
  if (!server) return null;
  try {
    const url = new URL(server);
    if (url.hostname) return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    // Some kubeconfig variants store host:port without a URL scheme.
  }
  return server.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "") || server;
}

type RefreshControlProps = {
  refreshSeconds: number;
  onRefreshSecondsChange: (value: number) => void;
  onRefresh: () => void | Promise<void>;
  disabled: boolean;
  ariaLabel?: string;
};

function RefreshControl({
  refreshSeconds,
  onRefreshSecondsChange,
  onRefresh,
  disabled,
  ariaLabel = "Refresh resources",
}: RefreshControlProps) {
  return (
    <div className="refresh-control" aria-label={ariaLabel}>
      <select
        value={refreshSeconds}
        onChange={(event) => onRefreshSecondsChange(Number(event.target.value))}
        aria-label="Auto refresh interval"
      >
        <option value={0}>Auto refresh: Off</option>
        <option value={5}>Every 5s</option>
        <option value={15}>Every 15s</option>
        <option value={30}>Every 30s</option>
      </select>
      <button type="button" onClick={onRefresh} disabled={disabled}>
        Refresh
      </button>
    </div>
  );
}

export function App() {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem("freelens.sidebarWidth"));
    return Number.isFinite(saved) && saved >= 180 && saved <= 420 ? saved : 220;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    window.localStorage.getItem("freelens.sidebarCollapsed") === "true"
  );
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
  const [panelWidths, setPanelWidths] = useState<Record<AdjustablePanelKind, number>>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("freelens.panelWidths") ?? "{}") as Partial<Record<AdjustablePanelKind, number>>;
      return Object.fromEntries(Object.entries(DEFAULT_PANEL_WIDTHS).map(([kind, fallback]) => {
        const width = saved[kind as AdjustablePanelKind];
        return [kind, Number.isFinite(width) && width! >= MIN_PANEL_WIDTH ? width : fallback];
      })) as Record<AdjustablePanelKind, number>;
    } catch {
      return { ...DEFAULT_PANEL_WIDTHS };
    }
  });
  const [maximizedPanels, setMaximizedPanels] = useState<Record<AdjustablePanelKind, boolean>>({
    detail: false,
    logs: false,
    terminal: false,
  });
  const panelResizeRef = useRef<AdjustablePanelKind | undefined>(undefined);
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
  const [sidebarContextOpen, setSidebarContextOpen] = useState(false);
  const [sidebarContextSearch, setSidebarContextSearch] = useState("");
  const [sidebarContextActiveIndex, setSidebarContextActiveIndex] = useState(0);
  const sidebarContextPickerRef = useRef<HTMLDetailsElement>(null);
  const sidebarContextSearchRef = useRef<HTMLInputElement>(null);
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
  const [namespaceReloadToken, setNamespaceReloadToken] = useState(0);
  const contextLoadRequestRef = useRef(0);
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
  const [ownerLookupItems, setOwnerLookupItems] = useState<ResourceItem[]>([]);
  const [ownerChainOpenKey, setOwnerChainOpenKey] = useState<string | null>(null);
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
  const resourceScrollLockRef = useRef<number | null>(null);
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
  const [yamlCursorLine, setYamlCursorLine] = useState(1);
  const [yamlStructureWidth, setYamlStructureWidth] = useState(300);
  const yamlCopyHintTimer = useRef<number | undefined>(undefined);
  const yamlEditorRef = useRef<YamlCodeEditorHandle | null>(null);
  const [metadataCopyHint, setMetadataCopyHint] = useState<string>();
  const metadataCopyHintTimer = useRef<number | undefined>(undefined);
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

  const resourcePanelOpen = Boolean(
    detail || detailLoading || detailError
    || logResource || execResource
    || createOpen || localTerminalOpen || kubectlOpen || kubeconfigSettingsOpen
  );

  useLayoutEffect(() => {
    const container = resourceListRef.current;
    if (activeView !== "resources" || !resourcePanelOpen || !container) {
      resourceScrollLockRef.current = null;
      return;
    }

    if (resourceScrollLockRef.current === null) {
      resourceScrollLockRef.current = container.scrollTop;
    }
    const lockedScrollTop = resourceScrollLockRef.current;
    if (container.scrollTop !== lockedScrollTop) container.scrollTop = lockedScrollTop;
    if (resourceScrollTop !== lockedScrollTop) setResourceScrollTop(lockedScrollTop);
  });

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
    const move = (event: PointerEvent) => {
      const kind = panelResizeRef.current;
      if (!kind) return;
      const width = Math.min(window.innerWidth, Math.max(MIN_PANEL_WIDTH, window.innerWidth - event.clientX));
      setPanelWidths((current) => current[kind] === width ? current : { ...current, [kind]: width });
    };
    const stop = () => {
      if (!panelResizeRef.current) return;
      panelResizeRef.current = undefined;
      document.body.classList.remove("resizing-panel");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("freelens.panelWidths", JSON.stringify(panelWidths));
  }, [panelWidths]);

  useEffect(() => {
    window.localStorage.setItem("freelens.sidebarCollapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem("freelens.favoriteResources", JSON.stringify(favoriteResourceKeys));
  }, [favoriteResourceKeys]);

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    sidebarResizeRef.current = true;
    document.body.classList.add("resizing-sidebar");
  };

  const startPanelResize = (event: ReactPointerEvent<HTMLDivElement>, kind: AdjustablePanelKind) => {
    if (maximizedPanels[kind]) return;
    event.preventDefault();
    event.stopPropagation();
    panelResizeRef.current = kind;
    document.body.classList.add("resizing-panel");
  };

  const togglePanelMaximized = (kind: AdjustablePanelKind) => {
    setMaximizedPanels((current) => ({ ...current, [kind]: !current[kind] }));
  };

  const toggleNavigationGroup = (label: string) => {
    setCollapsedGroups((current) => ({ ...current, [label]: !current[label] }));
  };

  const selectResource = (resource: ResourceKindItem) => {
    preferredResourceRef.current = "";
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
    const loadRequest = ++contextLoadRequestRef.current;
    if (!selectedContext) return;
    setResourceDiscoveryError(undefined);
    transport
      .kubernetesDiscoverResources({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
      })
      .then((response) => {
        if (selectedContextRef.current !== selectedContext || contextLoadRequestRef.current !== loadRequest) return;
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
        if (selectedContextRef.current !== selectedContext || contextLoadRequestRef.current !== loadRequest) return;
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
        if (selectedContextRef.current !== selectedContext || contextLoadRequestRef.current !== loadRequest) return;
        setNamespaces(response.namespaces);
        setNamespacesError(undefined);
        const preferred = preferredNamespaceRef.current;
        preferredNamespaceRef.current = "";
        setSelectedNamespace(response.namespaces.some((item) => item.name === preferred) ? preferred : "");
        finishSettingsRestore();
      })
      .catch((reason: unknown) => {
        if (selectedContextRef.current !== selectedContext || contextLoadRequestRef.current !== loadRequest) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setNamespaces([]);
        setNamespacesError(message);
        preferredNamespaceRef.current = "";
        finishSettingsRestore();
      });
  }, [selectedContext, namespaceReloadToken]);

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


  useEffect(() => {
    if (activeView !== "resources" || selectedKind !== "Pod" || !selectedContext) {
      setOwnerLookupItems([]);
      return;
    }

    let cancelled = false;
    const namespace = selectedNamespace || null;

    const ownerKinds = ["ReplicaSet", "Job", "StatefulSet", "DaemonSet", "Deployment", "CronJob"];

    Promise.all(ownerKinds.map((kind) => listAllResourcesForKind(kind, namespace).catch(() => [])))
      .then((ownerItems) => {
        if (!cancelled) setOwnerLookupItems(ownerItems.flat());
      });

    return () => {
      cancelled = true;
    };
  }, [activeView, selectedKind, selectedContext, selectedNamespace, resourceKinds]);

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
    selectResource(resource);
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
    setMetadataCopyHint(undefined);
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

  const displayedYamlDraft = yamlForManagedFieldsPreference(yamlDraft, yamlShowManagedFields);
  const displayedDetailYaml = detail ? yamlForManagedFieldsPreference(detail.yaml, yamlShowManagedFields) : "";
  const yamlOutline = useMemo(() => parseYamlOutline(displayedYamlDraft), [displayedYamlDraft]);
  const yamlBreadcrumbPath = useMemo(() => yamlPathForLine(yamlOutline, yamlCursorLine), [yamlOutline, yamlCursorLine]);
  const yamlActivePath = yamlBreadcrumbPath.at(-1) ? JSON.stringify(yamlBreadcrumbPath.at(-1)?.idPath) : "";
  const jumpToYamlLine = useCallback((lineNumber: number) => {
    setYamlCursorLine(lineNumber);
    yamlEditorRef.current?.goToLine(lineNumber);
  }, []);
  const startYamlStructureResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = event.currentTarget.parentElement;
    if (!workspace) return;
    event.preventDefault();
    const bounds = workspace.getBoundingClientRect();
    const resize = (moveEvent: PointerEvent) => {
      setYamlStructureWidth(Math.min(520, Math.max(220, bounds.right - moveEvent.clientX)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing-panel");
    };
    document.body.classList.add("resizing-panel");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
  }, []);

  useEffect(() => {
    setYamlCursorLine(1);
  }, [detail]);

  useEffect(() => {
    if (!detail || detailTab !== "yaml") return;
    const openYamlSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      event.stopPropagation();
      yamlEditorRef.current?.openSearch();
    };
    window.addEventListener("keydown", openYamlSearch, { capture: true });
    return () => window.removeEventListener("keydown", openYamlSearch, { capture: true });
  }, [detail, detailTab]);

  const toggleYamlEditing = () => {
    setYamlEditing((current) => {
      if (!current) {
        setYamlDraft(yamlForManagedFieldsPreference(yamlDraft, yamlShowManagedFields));
      }
      return !current;
    });
  };

  const cancelYamlEditing = () => {
    setYamlDraft(detail?.yaml ?? "");
    setYamlEditing(false);
  };

  const applyYamlDraft = async () => {
    const applied = await applyYaml(displayedYamlDraft);
    if (applied) setYamlEditing(false);
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

  const copyMetadataSection = async (
    section: { title: string; fields: Array<{ label: string; value: string }> },
  ) => {
    const text = section.fields.map((field) => `${field.label}: ${field.value}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setMetadataCopyHint(section.title);
    } catch {
      setMetadataCopyHint("failed");
    }
    if (metadataCopyHintTimer.current) window.clearTimeout(metadataCopyHintTimer.current);
    metadataCopyHintTimer.current = window.setTimeout(() => setMetadataCopyHint(undefined), 1500);
  };

  const renderDetailSection = (section: { title: string; fields: Array<{ label: string; value: string }> }) => {
    const isMetadata = section.title === "Labels" || section.title === "Annotations";
    if (!isMetadata) {
      return (
        <section key={section.title} className="detail-section">
          <h4>{section.title}</h4>
          <dl>{section.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
        </section>
      );
    }

    const copied = metadataCopyHint === section.title;
    const copyFailed = metadataCopyHint === "failed";
    return (
      <section key={section.title} className="detail-section metadata-section">
        <div className="detail-section-heading">
          <h4>{section.title}</h4>
          <button
            type="button"
            onClick={() => void copyMetadataSection(section)}
            disabled={section.fields.length === 0}
          >
            {copied ? "Copied" : copyFailed ? "Copy failed" : "Copy"}
          </button>
        </div>
        {section.fields.length === 0 ? (
          <p>No {section.title.toLowerCase()}</p>
        ) : (
          <div className="metadata-list">
            {section.fields.map((field) => {
              const line = `${field.label}: ${field.value}`;
              return (
                <div key={field.label} className="metadata-row" title={line}>
                  <span className="metadata-key">{field.label}</span>
                  <span className="metadata-separator">:</span>
                  <span className="metadata-value">{field.value}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
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

  const ownerLookup = useMemo(() => buildOwnerLookup([...resources, ...ownerLookupItems]), [resources, ownerLookupItems]);

  const visibleResources = useMemo(() => {
    const query = resourceSearch.trim().toLowerCase();
    const filtered = query
      ? resources.filter((item) => item.name.toLowerCase().includes(query))
      : resources;
    const valueFor = (item: ResourceItem) => {
      if (sortKey === "name") return item.name;
      if (sortKey === "namespace") return item.namespace ?? "";
      if (sortKey === "age") return item.created ?? "";
      if (sortKey === "controlledBy") return podControlledBySortValue(item, ownerLookup);
      if (sortKey === "containers") return String(item.podContainers?.length ?? 0);
      return item.columns[sortKey] ?? "";
    };
    return [...filtered].sort((left, right) => {
      const result = valueFor(left).localeCompare(valueFor(right), undefined, { numeric: true });
      return sortDirection === "asc" ? result : -result;
    });
  }, [resources, resourceSearch, sortKey, sortDirection, ownerLookup]);

  const visibleHealthItems = useMemo(() => {
    const query = resourceSearch.trim().toLowerCase();
    if (!query) return healthItems;
    return healthItems.filter((item) => item.name.toLowerCase().includes(query));
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
    setOwnerChainOpenKey(null);
  }, [activeView, resourceSearch, selectedKind, selectedNamespace, sortKey, sortDirection, resources.length, healthItems.length]);

  const resourceColumnCount = selectedKind === "Node"
    ? selectedColumns.length + 4
    : selectedColumns.length + (selectedKind === "Pod" ? 7 : 4);
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
    const lockedScrollTop = resourceScrollLockRef.current;
    if (lockedScrollTop !== null) {
      if (event.currentTarget.scrollTop !== lockedScrollTop) {
        event.currentTarget.scrollTop = lockedScrollTop;
      }
      return;
    }
    setResourceScrollTop(event.currentTarget.scrollTop);
  };

  const visibleEvents = useMemo(() => {
    const query = resourceSearch.trim().toLowerCase();
    const filtered = events.filter((event) => {
      if (eventTypeFilter && event.eventType !== eventTypeFilter) return false;
      if (!query) return true;
      return (event.objectName ?? "").toLowerCase().includes(query);
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
      ownerReferences: [],
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
                    className="config-map-data-editor"
                    id={`config-map-data-${name}`}
                    value={value}
                    onChange={(event) => editConfigMapData(name, event.target.value)}
                    disabled={actionLoading}
                    spellCheck={false}
                    wrap="off"
                    rows={Math.max(6, Math.min(20, value.split("\n").length))}
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
                      className="secret-data-editor"
                      id={`secret-data-${name}`}
                      value={displayValue}
                      onChange={(event) => editSecretData(name, event.target.value)}
                      disabled={actionLoading}
                      spellCheck={false}
                      wrap="off"
                      rows={Math.max(1, Math.min(12, displayValue.split("\n").length))}
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
      <td className={`actions${isOpen ? " action-menu-open" : ""}`} onClick={(event) => event.stopPropagation()}>
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


  const openOwnerEntry = (event: ReactMouseEvent, entry: OwnerChainEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const resource = resourceForKind(entry.kind);
    if (!resource) return;
    const targetNamespace = resource.namespaced ? entry.namespace ?? selectedNamespace : "";
    const targetItem: ResourceItem = entry.object ?? {
      kind: entry.kind,
      apiVersion: entry.apiVersion,
      name: entry.name,
      namespace: targetNamespace || null,
      uid: entry.uid,
      created: null,
      ownerReferences: [],
      columns: {},
    };

    setSelectedResource(resource);
    setSelectedNamespace(targetNamespace ?? "");
    setResourceSearch(entry.name);
    setActiveView("resources");
    loadResources(null, resource, targetNamespace ?? "");
    openDetail(targetItem);
  };

  const renderControlledBy = (item: ResourceItem) => {
    const chains = buildOwnerChains(item, ownerLookup);
    if (chains.length === 0) return "-";

    return (
      <div className="owner-chain-list">
        {chains.map((chain, index) => {
          const displayEntry = ownerChainDisplayEntry(chain);
          if (!displayEntry) return null;
          const label = ownerChainLabel(chain);
          const hasDetails = chain.entries.length > 1 || !chain.complete;
          const chainKey = `${item.apiVersion}/${item.namespace ?? ""}/${item.name}/${index}`;

          return (
            <div className="owner-chain" key={`${displayEntry.kind}/${displayEntry.name}/${index}`} title={label}>
              <button type="button" className="owner-chain-link" onClick={(event) => openOwnerEntry(event, displayEntry)}>
                <span>{displayEntry.kind}(</span>
                <span className="owner-chain-name">{displayEntry.name}</span>
                <span>)</span>
              </button>
              {hasDetails && (
                <details
                  className="owner-chain-details"
                  open={ownerChainOpenKey === chainKey}
                  onClick={(event) => event.stopPropagation()}
                  onToggle={(event) => {
                    event.stopPropagation();
                    const isOpen = event.currentTarget.open;
                    setOwnerChainOpenKey((current) => isOpen ? chainKey : current === chainKey ? null : current);
                  }}
                >
                  <summary>{chain.entries.length > 1 ? `+${chain.entries.length - 1}` : "?"}</summary>
                  <div className="owner-chain-menu">
                    {chain.entries.map((entry) => (
                      <button
                        type="button"
                        key={`${entry.kind}/${entry.name}/${entry.uid ?? ""}`}
                        onClick={(event) => openOwnerEntry(event, entry)}
                      >
                        <span>{entry.kind}(</span>
                        <span>{entry.name}</span>
                        <span>)</span>
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
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
      <td className="resource-name-cell" title={item.name}>{item.name}</td>
      {selectedKind === "Node" ? <>
        {selectedColumns.slice(0, 2).map((column) => <td key={column.key} className={column.key === "containers" ? "containers-cell" : undefined}>{renderResourceColumnValue(item, column.key)}</td>)}
        <td title={item.created ? new Date(item.created).toLocaleString() : undefined}>{formatAge(item.created)}</td>
        {selectedColumns.slice(2).map((column) => <td key={column.key} className={column.key === "containers" ? "containers-cell" : undefined}>{renderResourceColumnValue(item, column.key)}</td>)}
        <td>{formatCpu(metrics[`/${item.name}`]?.cpuMillicores)}</td>
        <td>{formatMemory(metrics[`/${item.name}`]?.memoryBytes)}</td>
      </> : <>
        <td>{item.namespace ?? "-"}</td>
        {selectedColumns.map((column) => <td key={column.key} className={column.key === "containers" ? "containers-cell" : undefined}>{renderResourceColumnValue(item, column.key)}</td>)}
        {selectedKind === "Pod" && <td className="controlled-by-cell">{renderControlledBy(item)}</td>}
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
      resourceShortName(resource.kind),
    ].some((value) => value ? value.toLowerCase().includes(query) : false);
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

    // Split non-core resources into built-in (residual "More Resources") and
    // custom resources (CRDs/aggregated APIs), which are grouped by API group
    // under a dedicated "Custom Resources" category — mirroring Freelens.
    const builtinNonCore: ResourceKindItem[] = [];
    const customByGroup = new Map<string, ResourceKindItem[]>();
    for (const item of resourceKinds) {
      if (coreKeys.has(resourceKey(item)) || !matchesQuery(item)) continue;
      if (BUILTIN_API_GROUPS.has(item.group)) {
        builtinNonCore.push(item);
      } else {
        const bucket = customByGroup.get(item.group) ?? [];
        bucket.push(item);
        customByGroup.set(item.group, bucket);
      }
    }
    builtinNonCore.sort((left, right) =>
      left.group.localeCompare(right.group) || left.kind.localeCompare(right.kind)
    );

    const groups: NavigationGroup[] = [...coreGroups];
    if (builtinNonCore.length > 0) {
      groups.push({ label: "More Resources", resources: builtinNonCore });
    }
    if (customByGroup.size > 0) {
      const subgroups = Array.from(customByGroup.entries())
        .map(([label, resources]) => ({
          label,
          resources: resources.sort((left, right) => left.kind.localeCompare(right.kind)),
        }))
        .filter((subgroup) => subgroup.resources.length > 0)
        .sort((left, right) => left.label.localeCompare(right.label));
      if (subgroups.length > 0) {
        groups.push({ label: "Custom Resources", resources: [], subgroups });
      }
    }
    return groups;
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
          resourceShortName(resource.kind),
        ];
        return values.some((value) => value ? value.toLowerCase().includes(query) : false) ? [resource] : [];
      });
  }, [favoriteResourceKeys, resourceKinds, resourceCatalogSearch]);
  const filteredKubeconfigContexts = useMemo(() => {
    const query = kubeconfigSearch.trim().toLocaleLowerCase();
    if (!kubeconfig) return [];
    if (!query) return kubeconfig.contexts;
    return kubeconfig.contexts.filter((ctx) =>
      [
        ctx.name,
        ctx.cluster,
        ctx.clusterServer ?? "",
        formatClusterEndpoint(ctx.clusterServer) ?? "",
        ctx.user ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(query))
    );
  }, [kubeconfig, kubeconfigSearch]);
  const sidebarContextOptions = useMemo(() => {
    if (!kubeconfig) return [];
    const query = sidebarContextSearch.trim().toLocaleLowerCase();
    const current = kubeconfig.contexts.find((context) => context.name === selectedContext);
    const matches = kubeconfig.contexts.filter((context) =>
      context.name !== selectedContext
      && (!query || context.name.toLocaleLowerCase().includes(query))
    );
    return current ? [current, ...matches] : matches;
  }, [kubeconfig, selectedContext, sidebarContextSearch]);
  const sidebarContextHasSearchMatch = useMemo(() => {
    const query = sidebarContextSearch.trim().toLocaleLowerCase();
    if (!query) return true;
    return sidebarContextOptions.some((context) => context.name.toLocaleLowerCase().includes(query));
  }, [sidebarContextOptions, sidebarContextSearch]);
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
    setNamespaceReloadToken((n) => n + 1);
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
    setNamespaceReloadToken((n) => n + 1);
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
  const subgroupKey = (groupLabel: string, subgroupLabel: string) => `${groupLabel}::${subgroupLabel}`;
  const allNavigationGroupsExpanded = !collapsedGroups[FAVORITES_GROUP_LABEL]
    && navigationGroups.every((group) =>
      !collapsedGroups[group.label]
      && (group.subgroups ?? []).every((subgroup) => !collapsedGroups[subgroupKey(group.label, subgroup.label)])
    );
  const toggleAllNavigationGroups = () => {
    const nextCollapsed = allNavigationGroupsExpanded;
    setCollapsedGroups((current) => ({
      ...current,
      [FAVORITES_GROUP_LABEL]: nextCollapsed,
      ...Object.fromEntries(navigationGroups.flatMap((group) => [
        [group.label, nextCollapsed],
        ...(group.subgroups ?? []).map((subgroup) => [subgroupKey(group.label, subgroup.label), nextCollapsed]),
      ])),
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
              ? `${resourceKindLabelWithShortName(resource.kind)} (${resource.group})`
              : resourceKindLabelWithShortName(resource.kind)}</span>
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
          {!sidebarCollapsed && (
            <>
              <aside className="sidebar" style={{ width: sidebarWidth }}>
                <div className="sidebar-header">
                  <div className="sidebar-title-row">
                    <h1>Freelens</h1>
                    <button
                      type="button"
                      className="sidebar-toggle"
                      onClick={() => setSidebarCollapsed(true)}
                      aria-label="Collapse sidebar"
                      title="Collapse sidebar"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m15 6-6 6 6 6" />
                      </svg>
                    </button>
                  </div>
                  <div className="sidebar-context-row">
                    <button
                      type="button"
                      className="sidebar-context-back"
                      onClick={() => setActiveView("contexts")}
                      aria-label="Back to contexts"
                      title="Back to contexts"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M19 12H5M11 6l-6 6 6 6" />
                      </svg>
                    </button>
                    <details
                      ref={sidebarContextPickerRef}
                      className="sidebar-context-picker"
                      onToggle={(event) => {
                        const open = event.currentTarget.open;
                        setSidebarContextOpen(open);
                        setSidebarContextSearch("");
                        setSidebarContextActiveIndex(0);
                        if (open) requestAnimationFrame(() => sidebarContextSearchRef.current?.focus());
                      }}
                    >
                      <summary className="sidebar-context-card" title="Switch context">
                        <span className="sidebar-context-name">
                          <span className="sidebar-context-cluster-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                              <circle cx="12" cy="12" r="10" />
                              <path d="M12 4v16M5.1 8l13.8 8M18.9 8 5.1 16M8 6.4l8 11.2M16 6.4 8 17.6" />
                            </svg>
                          </span>
                          {sidebarContextOpen ? (
                            <input
                              ref={sidebarContextSearchRef}
                              className="sidebar-context-search"
                              type="search"
                              role="combobox"
                              aria-label="Search contexts"
                              aria-expanded="true"
                              aria-controls="sidebar-context-options"
                              aria-activedescendant={sidebarContextOptions[sidebarContextActiveIndex] ? "sidebar-context-option-" + sidebarContextActiveIndex : undefined}
                              placeholder={selectedContext || "Search contexts"}
                              value={sidebarContextSearch}
                              onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                              onChange={(event) => { setSidebarContextSearch(event.target.value); setSidebarContextActiveIndex(0); }}
                              onKeyDown={(event) => {
                                if (event.key === "ArrowDown") { event.preventDefault(); setSidebarContextActiveIndex((index) => Math.min(index + 1, Math.max(0, sidebarContextOptions.length - 1))); }
                                else if (event.key === "ArrowUp") { event.preventDefault(); setSidebarContextActiveIndex((index) => Math.max(index - 1, 0)); }
                                else if (event.key === "Enter") { event.preventDefault(); const context = sidebarContextOptions[sidebarContextActiveIndex]; if (!context) return; if (context.name !== selectedContext) switchContext(context.name); sidebarContextPickerRef.current?.removeAttribute("open"); }
                                else if (event.key === "Escape") { event.preventDefault(); sidebarContextPickerRef.current?.removeAttribute("open"); }
                              }}
                            />
                          ) : (
                            <span className="sidebar-context-label">{selectedContext || "No context"}</span>
                          )}
                        </span>
                        <svg className="sidebar-context-chevron" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m7 9 5 5 5-5" />
                        </svg>
                      </summary>
                      <div id="sidebar-context-options" className="sidebar-context-options" role="listbox" aria-label="Switch context">
                        {sidebarContextOptions.map((context, index) => (
                          <button
                            id={"sidebar-context-option-" + index}
                            type="button"
                            role="option"
                            aria-selected={context.name === selectedContext}
                            key={context.name}
                            title={context.name}
                            className={[context.name === selectedContext ? "current" : "", index === sidebarContextActiveIndex ? "keyboard-active" : ""].filter(Boolean).join(" ")}
                            onMouseEnter={() => setSidebarContextActiveIndex(index)}
                            onClick={(event) => {
                              if (context.name !== selectedContext) switchContext(context.name);
                              event.currentTarget.closest("details")?.removeAttribute("open");
                            }}
                          >
                            <span className="sidebar-context-cluster-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="10" />
                                <path d="M12 4v16M5.1 8l13.8 8M18.9 8 5.1 16M8 6.4l8 11.2M16 6.4 8 17.6" />
                              </svg>
                            </span>
                            <span className="sidebar-context-option-name">{context.name}</span>
                            {context.name === selectedContext && <span className="sidebar-context-current">Current</span>}
                          </button>
                        ))}
                        {kubeconfig && !sidebarContextHasSearchMatch && <span className="sidebar-context-options-empty">No matching contexts</span>}
                        {kubeconfig && kubeconfig.contexts.length === 0 && <span className="sidebar-context-options-empty">No contexts</span>}
                      </div>
                    </details>
                  </div>
                  <input
                    className="resource-catalog-search"
                    type="search"
                    placeholder="Type or shortname (pod, svc, cm...)"
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
                      <span className="nav-chevron">{collapsedGroups[FAVORITES_GROUP_LABEL] && !hasResourceCatalogSearch ? "▸" : "▾"}</span>
                    </button>
                    <ul hidden={collapsedGroups[FAVORITES_GROUP_LABEL] && !hasResourceCatalogSearch}>
                      {favoriteResources.length > 0 ? (
                        favoriteResources.map((resource) => renderResourceNavigationItem(resource, FAVORITES_GROUP_LABEL))
                      ) : (
                        <li className="nav-empty-state">{hasResourceCatalogSearch ? "No matching favorites" : "No favorites yet"}</li>
                      )}
                    </ul>
                  </div>
                  {navigationGroups.map((group) => {
                    const groupCollapsed = collapsedGroups[group.label] && !hasResourceCatalogSearch;
                    return (
                    <div key={group.label} className="nav-group">
                      <button
                        className="nav-group-header"
                        onClick={() => toggleNavigationGroup(group.label)}
                        aria-expanded={!collapsedGroups[group.label] || hasResourceCatalogSearch}
                      >
                        <NavigationIcon name={GROUP_ICONS[group.label] ?? "more"} />
                        <span>{group.label}</span>
                        <span className="nav-chevron">{groupCollapsed ? "▸" : "▾"}</span>
                      </button>
                      <ul hidden={groupCollapsed}>
                        {group.resources.map((resource) => renderResourceNavigationItem(resource, group.label))}
                        {(group.subgroups ?? []).map((subgroup) => {
                          const key = subgroupKey(group.label, subgroup.label);
                          const subgroupCollapsed = collapsedGroups[key] && !hasResourceCatalogSearch;
                          return (
                            <li key={key} className="nav-subgroup">
                              <button
                                className="nav-subgroup-header"
                                onClick={() => toggleNavigationGroup(key)}
                                aria-expanded={!collapsedGroups[key] || hasResourceCatalogSearch}
                              >
                                <span className="nav-subgroup-title">{subgroup.label}</span>
                                <span className="nav-chevron">{subgroupCollapsed ? "▸" : "▾"}</span>
                              </button>
                              <ul hidden={subgroupCollapsed}>
                                {subgroup.resources.map((resource) => renderResourceNavigationItem(resource, "Custom Resources"))}
                              </ul>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    );
                  })}
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
          {sidebarCollapsed && (
            <div className="sidebar-toggle-rail collapsed">
              <button
                type="button"
                className="sidebar-toggle"
                onClick={() => setSidebarCollapsed(false)}
                aria-label="Expand sidebar"
                title="Expand sidebar"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            </div>
          )}
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
                placeholder="Search name"
                value={resourceSearch}
                onChange={(event) => setResourceSearch(event.target.value)}
              />
              {selectedResource.namespaced && (
                <NamespaceCombobox
                  namespaces={availableNamespaces}
                  value={selectedNamespace}
                  onChange={(namespace) => {
                    resourceRequestRef.current += 1;
                    setSelectedNamespace(namespace);
                  }}
                  onOpen={() => setOwnerChainOpenKey(null)}
                  title={namespacesError ? `Failed to load namespaces: ${namespacesError}` : undefined}
                />
              )}
            </>}
            {activeView === "events" && <>
              <input
                type="search"
                placeholder="Search name"
                value={resourceSearch}
                onChange={(event) => setResourceSearch(event.target.value)}
              />
              <NamespaceCombobox
                namespaces={availableNamespaces}
                value={selectedNamespace}
                onChange={setSelectedNamespace}
                title={namespacesError ? `Failed to load namespaces: ${namespacesError}` : undefined}
              />
              <select value={eventTypeFilter} onChange={(event) => setEventTypeFilter(event.target.value)}>
                <option value="">All event types</option>
                <option value="Normal">Normal</option>
                <option value="Warning">Warning</option>
              </select>
            </>}
            {activeView === "health" && (
              <input
                type="search"
                placeholder="Search name"
                value={resourceSearch}
                onChange={(event) => setResourceSearch(event.target.value)}
              />
            )}
            <RefreshControl
              refreshSeconds={refreshSeconds}
              onRefreshSecondsChange={setRefreshSeconds}
              onRefresh={() => activeView === "overview" ? loadOverview()
                : activeView === "events" ? loadEvents()
                  : activeView === "health" && healthTitle === "Abnormal Pods" ? openAbnormalPods()
                    : activeView === "health" && healthTitle === "Unavailable Workloads" ? openUnavailableWorkloads()
                      : loadResources()
              }
              disabled={activeView === "overview" ? overviewLoading : activeView === "events" ? eventsLoading : activeView === "health" ? healthLoading : resourcesLoading}
            />
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
                    Apply
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
                {filteredKubeconfigContexts.map((ctx) => {
                  const clusterEndpoint = formatClusterEndpoint(ctx.clusterServer);
                  return (
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
                      <span
                        className="context-result-cluster"
                        title={ctx.clusterServer ? `${ctx.cluster} (${ctx.clusterServer})` : ctx.cluster}
                      >
                        {clusterEndpoint ?? ctx.cluster}
                      </span>
                    </button>
                  );
                })}
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
                <table className="resource-table">
                  <thead><tr><th>Kind</th><th className="resource-name-cell">Name</th><th>Namespace</th><th>Status</th><th>Ready</th><th>Age</th><th className="actions">Actions</th></tr></thead>
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
                        <td className="resource-name-cell" title={item.name}>{item.name}</td>
                        <td>{item.namespace ?? "-"}</td>
                        <td>
                          {item.columns.status !== undefined
                            ? renderResourceStatusValue(item.kind, "status", item.columns)
                            : renderResourceStatusValue(item.kind, "available", item.columns)}
                        </td>
                        <td>
                          {item.columns.ready !== undefined
                            ? renderResourceStatusValue(item.kind, "ready", item.columns)
                            : renderResourceStatusValue(item.kind, "available", item.columns)}
                        </td>
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
              <table
                ref={resourceTableRef}
                className={[
                  "resource-table",
                  virtualizeResources ? "virtualized-table" : "",
                ].filter(Boolean).join(" ")}
              >
                <thead>
                  <tr>
                    <th className="resource-name-cell">{renderResourceSortButton("name", "Name")}</th>
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
                      {selectedKind === "Pod" && <><th>{renderResourceSortButton("controlledBy", "Controlled By")}</th><th>CPU</th><th>Memory</th></>}
                      <th>{renderResourceSortButton("age", "Age")}</th>
                    </>}
                    <th className="actions">Actions</th>
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
          <div
            className={`detail-panel resizable-panel${maximizedPanels.detail ? " is-maximized" : ""}`}
            style={{ width: maximizedPanels.detail ? "100vw" : `min(${panelWidths.detail}px, 100vw)` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="panel-resizer"
              role="separator"
              aria-label="Resize resource details"
              aria-orientation="vertical"
              onPointerDown={(event) => startPanelResize(event, "detail")}
              onDoubleClick={() => togglePanelMaximized("detail")}
            />
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
                    ownerReferences: [],
                    columns: {},
                  })}>Refresh</button>
                )}
                <button onClick={() => togglePanelMaximized("detail")}>
                  {maximizedPanels.detail ? "Restore" : "Maximize"}
                </button>
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
                    <div className="yaml-mode-bar">
                      <span>{yamlEditing ? "Editing mode" : "Read-only — click Edit to modify"}</span>
                      {yamlEditing ? (
                        <div className="yaml-save-group">
                          <button type="button" onClick={cancelYamlEditing} disabled={actionLoading}>Cancel</button>
                          <button
                            type="button"
                            onClick={() => void applyYamlDraft()}
                            disabled={
                              actionLoading ||
                              displayedYamlDraft === displayedDetailYaml
                            }
                          >
                            {actionLoading ? "Applying..." : "Apply"}
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={toggleYamlEditing}>Edit</button>
                      )}
                    </div>
                    <div className="yaml-workspace" style={{ gridTemplateColumns: `minmax(0, 1fr) 7px ${yamlStructureWidth}px` }}>
                      <div className="yaml-main-pane">
                        {yamlEditing ? (
                          <YamlCodeEditor
                            ref={yamlEditorRef}
                            value={displayedYamlDraft}
                            editable
                            selectedLineNumber={yamlCursorLine}
                            onChange={setYamlDraft}
                            onCursorLineChange={setYamlCursorLine}
                          />
                        ) : (
                          <YamlCodeEditor
                            ref={yamlEditorRef}
                            value={displayedYamlDraft}
                            editable={false}
                            selectedLineNumber={yamlCursorLine}
                            onChange={() => undefined}
                            onCursorLineChange={setYamlCursorLine}
                          />
                        )}
                        <YamlBreadcrumb path={yamlBreadcrumbPath} activeLine={yamlCursorLine} onJump={jumpToYamlLine} />
                      </div>
                      <div
                        className="yaml-structure-resizer"
                        role="separator"
                        aria-label="Resize YAML structure"
                        aria-orientation="vertical"
                        onPointerDown={startYamlStructureResize}
                      />
                      <YamlStructurePanel outline={yamlOutline} activePath={yamlActivePath} onJump={jumpToYamlLine} resetKey={detail?.yaml} />
                    </div>
                    <div className="editor-actions">
                      <div className="editor-actions-left">
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
                      {yamlEditing && (
                        <div className="editor-actions-right">
                          <button onClick={() => setYamlDraft(detail.yaml)} disabled={actionLoading}>Revert Changes</button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="detail-overview">
                    {detail.sections.map(renderDetailSection)}
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
              <h3>Apply</h3>
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
          <div
            className={`detail-panel log-panel resizable-panel${maximizedPanels.logs ? " is-maximized" : ""}`}
            style={{ width: maximizedPanels.logs ? "100vw" : `min(${panelWidths.logs}px, 100vw)` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="panel-resizer"
              role="separator"
              aria-label="Resize logs"
              aria-orientation="vertical"
              onPointerDown={(event) => startPanelResize(event, "logs")}
              onDoubleClick={() => togglePanelMaximized("logs")}
            />
            <header>
              <h3>Logs: {logResource.namespace}/{logResource.name}</h3>
              <div>
                {logOperationId ? (
                  <button onClick={() => void stopLogs()}>Stop</button>
                ) : (
                  <button onClick={() => logResource && setLogs([])}>Clear</button>
                )}
                <button onClick={() => togglePanelMaximized("logs")}>
                  {maximizedPanels.logs ? "Restore" : "Maximize"}
                </button>
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
          <div
            className={`detail-panel exec-panel resizable-panel${maximizedPanels.terminal ? " is-maximized" : ""}`}
            style={{ width: maximizedPanels.terminal ? "100vw" : `min(${panelWidths.terminal}px, 100vw)` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="panel-resizer"
              role="separator"
              aria-label="Resize terminal"
              aria-orientation="vertical"
              onPointerDown={(event) => startPanelResize(event, "terminal")}
              onDoubleClick={() => togglePanelMaximized("terminal")}
            />
            <header>
              <h3>Terminal: {execResource.namespace}/{execResource.name}</h3>
              <div>
                {terminalSessionId && <button onClick={() => void stopTerminal()}>Stop</button>}
                <button onClick={() => togglePanelMaximized("terminal")}>
                  {maximizedPanels.terminal ? "Restore" : "Maximize"}
                </button>
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

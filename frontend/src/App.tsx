import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  IPC_VERSION,
  KubeconfigContext,
  KubeconfigListResponse,
  KubectlInstallation,
  KubectlRunResponse,
  KubernetesGetResourceDetailResponse,
  KubernetesListNamespacesResponse,
  KubernetesListResourcesResponse,
  NamespaceItem,
  ResourceItem,
  ResourceKindItem,
} from "./contracts";
import { createTransport } from "./transport";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const transport = createTransport();

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

const RESOURCE_GROUPS = [
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
      scope: kind === "PersistentVolume" ? "Cluster" : "Namespaced",
      namespaced: kind !== "PersistentVolume",
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

export function App() {
  const [settingsReady, setSettingsReady] = useState(false);
  const settingsRestorePendingRef = useRef(0);
  const preferredNamespaceRef = useRef("");
  const preferredResourceRef = useRef("");
  const [kubeconfig, setKubeconfig] = useState<KubeconfigListResponse>();
  const [kubeconfigError, setKubeconfigError] = useState<string>();
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
  const [selectedNamespace, setSelectedNamespace] = useState<string>("");
  const [resourceKinds, setResourceKinds] = useState<ResourceKindItem[]>(FALLBACK_RESOURCE_KINDS);
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
  const [continueToken, setContinueToken] = useState<string | null>(null);
  const resourceRequestRef = useRef(0);
  const [resourceSearch, setResourceSearch] = useState("");
  const searchPaginationRef = useRef<{ key: string; tokens: Set<string> }>({
    key: "",
    tokens: new Set(),
  });
  const [sortKey, setSortKey] = useState("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [refreshSeconds, setRefreshSeconds] = useState(0);
  const [watchStatus, setWatchStatus] = useState<"connecting" | "live" | "retrying" | "off">("off");
  const resourceWatchOperationRef = useRef<string | undefined>(undefined);
  const resourceWatchRefreshRef = useRef<number | undefined>(undefined);

  const [detail, setDetail] = useState<KubernetesGetResourceDetailResponse>();
  const [detailTab, setDetailTab] = useState<"overview" | "yaml">("overview");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [yamlDraft, setYamlDraft] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();
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
    Promise.all([
      transport.kubeconfigList({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      }),
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
          },
        };
      }),
    ])
      .then(([response, saved]) => {
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
      resourceWatchRefreshRef.current = window.setTimeout(() => loadResources(), 250);
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
        },
      }).catch((reason) => setActionError(errorMessage(reason)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [settingsReady, selectedContext, selectedNamespace, selectedResource, refreshSeconds]);

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
        const preferred = preferredNamespaceRef.current;
        preferredNamespaceRef.current = "";
        setSelectedNamespace(response.namespaces.some((item) => item.name === preferred) ? preferred : "");
        finishSettingsRestore();
      })
      .catch(() => {
        setNamespaces([]);
        preferredNamespaceRef.current = "";
        finishSettingsRestore();
      });
  }, [selectedContext]);

  useEffect(() => {
    if (!selectedResource.namespaced && selectedNamespace) setSelectedNamespace("");
  }, [selectedResource, selectedNamespace]);

  useEffect(() => {
    if (!selectedContext || !selectedKind) return;
    loadResources();
  }, [selectedContext, selectedKind, selectedApiVersion, selectedNamespace]);

  useEffect(() => {
    if (!selectedContext || !selectedKind) return;
    const operationId = crypto.randomUUID();
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
      kind: selectedKind,
      apiVersion: selectedApiVersion,
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
  }, [selectedContext, selectedKind, selectedApiVersion, selectedNamespace]);

  useEffect(() => {
    if (!refreshSeconds || !selectedContext || !selectedKind) return;
    const interval = window.setInterval(() => loadResources(), refreshSeconds * 1000);
    return () => window.clearInterval(interval);
  }, [refreshSeconds, selectedContext, selectedKind, selectedApiVersion, selectedNamespace]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const loadResources = (
    token: string | null = null,
    resource: ResourceKindItem = selectedResource,
    namespaceOverride: string = selectedNamespace,
  ) => {
    if (!selectedContext || !resource.kind) return;
    if (!token) searchPaginationRef.current = { key: "", tokens: new Set() };
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
  };

  const applyYaml = async () => {
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
        yaml: yamlDraft,
      });
      setYamlDraft(response.yaml);
      setDetail((current) => current ? { ...current, yaml: response.yaml } : current);
      setActionMessage("Resource applied successfully");
      loadResources();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setActionLoading(false);
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
    }
  };

  const scaleDeployment = async (item: ResourceItem) => {
    if (!selectedContext || !item.namespace) return;
    const current = item.columns.ready?.split("/")[1] ?? "1";
    const value = window.prompt(`Desired replicas for ${item.name}`, current);
    if (value === null) return;
    const replicas = Number(value);
    if (!Number.isInteger(replicas) || replicas < 0) {
      setActionError("Replicas must be a non-negative integer");
      return;
    }
    setActionError(undefined);
    try {
      await transport.kubernetesScaleDeployment({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        namespace: item.namespace,
        name: item.name,
        replicas,
      });
      setActionMessage(`Deployment scaled to ${replicas}`);
      loadResources();
    } catch (reason) {
      setActionError(errorMessage(reason));
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

  const changeSort = (key: string) => {
    if (sortKey === key) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };

  const sortLabel = (key: string, label: string) =>
    `${label}${sortKey === key ? (sortDirection === "asc" ? " ^" : " v") : ""}`;

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Freelens</h1>
          {kubeconfig ? (
            <select
              value={selectedContext}
              onChange={(event) => {
                void cancelKubectl();
                closeLocalTerminal();
                for (const forward of Object.values(portForwardsRef.current)) {
                  void transport.kubernetesStopPodPortForward({
                    meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
                    operationId: forward.operationId,
                  });
                }
                updatePortForwards({});
                setSelectedContextAndRef(event.target.value);
                setNamespaces([]);
                setSelectedNamespace("");
                setResources([]);
                setDetail(undefined);
                closeTerminal();
                setLogs([]);
                resourceRequestRef.current += 1;
                closeLogs();
              }}
            >
              {kubeconfig.contexts.map((ctx: KubeconfigContext) => (
                <option key={ctx.name} value={ctx.name}>
                  {ctx.name}
                </option>
              ))}
            </select>
          ) : (
            <p>{kubeconfigError ?? "Loading contexts…"}</p>
          )}
          <input
            className="resource-catalog-search"
            type="search"
            placeholder="Find resource type"
            value={resourceCatalogSearch}
            onChange={(event) => setResourceCatalogSearch(event.target.value)}
          />
        </div>

        <nav className="sidebar-nav">
          {navigationGroups.map((group) => (
            <div key={group.label} className="nav-group">
              <h3>{group.label}</h3>
              <ul>
                {group.resources.map((resource) => (
                  <li key={resourceKey(resource)}>
                    <button
                      className={resourceKey(selectedResource) === resourceKey(resource) ? "active" : ""}
                      title={resourceApiVersion(resource)}
                      onClick={() => {
                        setSelectedResource(resource);
                        if (!resource.namespaced) setSelectedNamespace("");
                        resourceRequestRef.current += 1;
                        setDetail(undefined);
                      }}
                    >
                      {group.label === "More Resources" && resource.group
                        ? `${resourceKindLabel(resource.kind)} (${resource.group})`
                        : resourceKindLabel(resource.kind)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {resourceDiscoveryError && (
            <p className="sidebar-warning" title={resourceDiscoveryError}>Using built-in resource catalog</p>
          )}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="title-with-status">
            <h2>{resourceKindLabel(selectedKind)}</h2>
            <span className={`watch-status ${watchStatus}`}>Watch: {watchStatus}</span>
          </div>
          <div className="topbar-controls">
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
            >
              <option value="">All namespaces</option>
              {namespaces.map((ns: NamespaceItem) => (
                <option key={ns.name} value={ns.name}>
                  {ns.name}
                </option>
              ))}
            </select>
            <select value={refreshSeconds} onChange={(event) => setRefreshSeconds(Number(event.target.value))}>
              <option value={0}>Auto refresh: Off</option>
              <option value={5}>Every 5s</option>
              <option value={15}>Every 15s</option>
              <option value={30}>Every 30s</option>
            </select>
            <button onClick={() => loadResources()} disabled={resourcesLoading}>
              Refresh
            </button>
            <button onClick={openCreate}>Create Resource</button>
            <button onClick={() => void openKubectl()}>Kubectl</button>
            <button onClick={() => setLocalTerminalOpen(true)}>Shell</button>
          </div>
        </header>

        {resourcesError ? (
          <p className="error-message">{resourcesError}</p>
        ) : (
          <section className="resource-list">
            {actionError && <p className="inline-message error-message">{actionError}</p>}
            {actionMessage && <p className="inline-message success-message">{actionMessage}</p>}
            <table>
              <thead>
                <tr>
                  <th><button className="sort-button" onClick={() => changeSort("name")}>{sortLabel("name", "Name")}</button></th>
                  <th><button className="sort-button" onClick={() => changeSort("namespace")}>{sortLabel("namespace", "Namespace")}</button></th>
                  {selectedColumns.map((column) => (
                    <th key={column.key}><button className="sort-button" onClick={() => changeSort(column.key)}>{sortLabel(column.key, column.label)}</button></th>
                  ))}
                  <th><button className="sort-button" onClick={() => changeSort("age")}>{sortLabel("age", "Age")}</button></th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleResources.map((item: ResourceItem) => (
                  <tr key={`${item.apiVersion}/${item.namespace ?? ""}/${item.name}`}>
                    <td>{item.name}</td>
                    <td>{item.namespace ?? "-"}</td>
                    {selectedColumns.map((column) => <td key={column.key}>{item.columns[column.key] ?? "-"}</td>)}
                    <td title={item.created ? new Date(item.created).toLocaleString() : undefined}>{formatAge(item.created)}</td>
                    <td className="actions">
                      <button onClick={() => openDetail(item)}>Details</button>
                      {item.kind === "Pod" && item.apiVersion === "v1" && item.namespace && (
                        <>
                          <button onClick={() => startLogs(item)}>Logs</button>
                          <button onClick={() => void openExec(item)}>Terminal</button>
                          {portForwards[portForwardKey(item)] ? (
                            <button onClick={() => void stopPortForward(item)}>
                              Stop {portForwards[portForwardKey(item)].localPort}:{portForwards[portForwardKey(item)].remotePort}
                            </button>
                          ) : (
                            <button onClick={() => void startPortForward(item)}>Port Forward</button>
                          )}
                        </>
                      )}
                      {item.kind === "Deployment" && item.apiVersion === "apps/v1"
                        && <button onClick={() => void scaleDeployment(item)}>Scale</button>}
                      <button className="danger-button" onClick={() => void deleteResource(item)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            {resourcesLoading && resources.length === 0 && <p>Loading…</p>}
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
                    <textarea value={yamlDraft} onChange={(event) => setYamlDraft(event.target.value)} spellCheck={false} />
                    <div className="editor-actions">
                      <button onClick={() => setYamlDraft(detail.yaml)} disabled={actionLoading}>Reset</button>
                      <button onClick={() => void applyYaml()} disabled={actionLoading || yamlDraft === detail.yaml}>
                        {actionLoading ? "Applying..." : "Apply"}
                      </button>
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
                    {detail.containers.length > 0 && (
                      <section className="detail-section"><h4>Containers</h4><table><thead><tr><th>Name</th><th>Image</th><th>State</th><th>Ready</th><th>Restarts</th></tr></thead><tbody>{detail.containers.map((container) => <tr key={container.name}><td>{container.name}</td><td>{container.image}</td><td>{container.state}</td><td>{container.ready ? "Yes" : "No"}</td><td>{container.restarts}</td></tr>)}</tbody></table></section>
                    )}
                    {detail.kind === "Pod" && detail.apiVersion === "v1" && (
                      <section className="detail-section"><h4>Events</h4>{detail.events.length === 0 ? <p>No events</p> : <table><thead><tr><th>Type</th><th>Reason</th><th>Message</th><th>Count</th><th>Last seen</th></tr></thead><tbody>{detail.events.map((event, index) => <tr key={`${event.reason}-${index}`}><td>{event.eventType ?? "-"}</td><td>{event.reason ?? "-"}</td><td>{event.message ?? "-"}</td><td>{event.count ?? "-"}</td><td>{event.timestamp ? new Date(event.timestamp).toLocaleString() : "-"}</td></tr>)}</tbody></table>}</section>
                    )}
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
                <button onClick={() => void createResource()} disabled={createLoading || !createYaml.trim()}>
                  {createLoading ? "Applying..." : "Apply Resource"}
                </button>
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
    </div>
  );
}

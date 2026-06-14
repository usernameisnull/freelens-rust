import { useEffect, useMemo, useRef, useState } from "react";
import {
  IPC_VERSION,
  KubeconfigContext,
  KubeconfigListResponse,
  KubernetesGetResourceDetailResponse,
  KubernetesListNamespacesResponse,
  KubernetesListResourcesResponse,
  NamespaceItem,
  ResourceItem,
  ResourceKindItem,
} from "./contracts";
import { createTransport } from "./transport";
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
  const [kubeconfig, setKubeconfig] = useState<KubeconfigListResponse>();
  const [kubeconfigError, setKubeconfigError] = useState<string>();
  const [selectedContext, setSelectedContext] = useState<string>("");
  const selectedContextRef = useRef(selectedContext);
  const setSelectedContextAndRef = (value: string) => {
    selectedContextRef.current = value;
    setSelectedContext(value);
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
  const [execCommand, setExecCommand] = useState("pwd");
  const [execOutput, setExecOutput] = useState("");
  const [execLoading, setExecLoading] = useState(false);
  const [execError, setExecError] = useState<string>();

  useEffect(() => {
    transport
      .kubeconfigList({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      })
      .then((response) => {
        setKubeconfig(response);
        const fallback = response.contexts[0]?.name ?? "";
        setSelectedContextAndRef(response.currentContext ?? fallback);
      })
      .catch((reason: unknown) => {
        setKubeconfigError(errorMessage(reason));
      });

    let unlistenLog: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenResourceWatch: (() => void) | undefined;

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

    return () => {
      const operationId = logOperationIdRef.current;
      if (operationId) {
        void transport.kubernetesStopPodLogs({
          meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
          operationId,
        });
      }
      unlistenLog?.();
      unlistenDone?.();
      unlistenResourceWatch?.();
      if (resourceWatchRefreshRef.current) window.clearTimeout(resourceWatchRefreshRef.current);
    };
  }, []);

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
        setSelectedResource((current) =>
          discovered.find((item) => resourceKey(item) === resourceKey(current))
          ?? discovered.find((item) => item.kind === "Pod" && resourceApiVersion(item) === "v1")
          ?? discovered[0]
        );
      })
      .catch((reason: unknown) => {
        if (selectedContextRef.current !== selectedContext) return;
        setResourceKinds(FALLBACK_RESOURCE_KINDS);
        setResourceDiscoveryError(errorMessage(reason));
      });
    transport
      .kubernetesListNamespaces({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
      })
      .then((response: KubernetesListNamespacesResponse) => {
        setNamespaces(response.namespaces);
      })
      .catch(() => setNamespaces([]));
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

  const loadResources = (token: string | null = null) => {
    if (!selectedContext || !selectedKind) return;
    const requestNumber = ++resourceRequestRef.current;
    const context = selectedContext;
    const kind = selectedKind;
    const namespace = selectedNamespace;
    setResourcesLoading(true);
    setResourcesError(undefined);
    transport
      .kubernetesListResources({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context,
        kind,
        apiVersion: selectedApiVersion,
        columns: selectedResource.columns,
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
    setExecOutput("");
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
    } catch (reason) {
      setExecError(errorMessage(reason));
    } finally {
      setExecLoading(false);
    }
  };

  const runExec = async () => {
    if (!selectedContext || !execResource?.namespace || !execContainer || !execCommand.trim()) return;
    setExecLoading(true);
    setExecError(undefined);
    try {
      const response = await transport.kubernetesExecPod({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: selectedContext,
        namespace: execResource.namespace,
        pod: execResource.name,
        container: execContainer,
        command: execCommand,
      });
      setExecOutput((current) => `${current}$ ${execCommand}\n${response.stdout}${response.stderr}${response.success ? "" : `[${response.status ?? "Failed"}]\n`}`);
    } catch (reason) {
      setExecError(errorMessage(reason));
    } finally {
      setExecLoading(false);
    }
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
                setSelectedContextAndRef(event.target.value);
                setNamespaces([]);
                setSelectedNamespace("");
                setResources([]);
                setDetail(undefined);
                setExecResource(undefined);
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
                          <button onClick={() => void openExec(item)}>Exec</button>
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
            {continueToken && (
              <button
                className="load-more"
                onClick={() => loadResources(continueToken)}
                disabled={resourcesLoading}
              >
                Load more
              </button>
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
        <div className="detail-panel-overlay" onClick={() => setExecResource(undefined)}>
          <div className="detail-panel exec-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>Exec: {execResource.namespace}/{execResource.name}</h3>
              <button onClick={() => setExecResource(undefined)}>Close</button>
            </header>
            <div className="exec-controls">
              <select value={execContainer} onChange={(event) => setExecContainer(event.target.value)} disabled={execLoading}>
                {execContainers.map((container) => <option key={container} value={container}>{container}</option>)}
              </select>
              <input
                value={execCommand}
                onChange={(event) => setExecCommand(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void runExec(); }}
                placeholder="Command, for example: ls -la"
                disabled={execLoading}
              />
              <button onClick={() => void runExec()} disabled={execLoading || !execContainer || !execCommand.trim()}>
                {execLoading ? "Running..." : "Run"}
              </button>
            </div>
            {execError && <p className="error-message">{execError}</p>}
            <pre className="exec-output">{execOutput || "Command output will appear here."}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

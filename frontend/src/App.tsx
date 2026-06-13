import { useEffect, useRef, useState } from "react";
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
    kinds: ["Pod", "Deployment"],
  },
  {
    label: "Network",
    kinds: ["Service"],
  },
];

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
  const [selectedKind, setSelectedKind] = useState<string>("Pod");

  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string>();
  const [continueToken, setContinueToken] = useState<string | null>(null);
  const resourceRequestRef = useRef(0);

  const [detail, setDetail] = useState<KubernetesGetResourceDetailResponse>();
  const [detailTab, setDetailTab] = useState<"overview" | "yaml">("overview");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
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
    };
  }, []);

  useEffect(() => {
    if (!selectedContext) return;
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
    if (!selectedContext || !selectedKind) return;
    loadResources();
  }, [selectedContext, selectedKind, selectedNamespace]);

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
    if (!selectedContext || !item.namespace) return;
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
        namespace: item.namespace,
        name: item.name,
      })
      .then((response) => {
        if (requestNumber === detailRequestRef.current) setDetail(response);
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
  };

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
        </div>

        <nav className="sidebar-nav">
          {RESOURCE_GROUPS.map((group) => (
            <div key={group.label} className="nav-group">
              <h3>{group.label}</h3>
              <ul>
                {group.kinds.map((kind) => (
                  <li key={kind}>
                    <button
                      className={selectedKind === kind ? "active" : ""}
                      onClick={() => {
                        setSelectedKind(kind);
                        resourceRequestRef.current += 1;
                        setDetail(undefined);
                      }}
                    >
                      {kind}s
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{selectedKind}s</h2>
          <div className="topbar-controls">
            <select
              value={selectedNamespace}
              onChange={(event) => {
                resourceRequestRef.current += 1;
                setSelectedNamespace(event.target.value);
              }}
            >
              <option value="">All namespaces</option>
              {namespaces.map((ns: NamespaceItem) => (
                <option key={ns.name} value={ns.name}>
                  {ns.name}
                </option>
              ))}
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
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Namespace</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((item: ResourceItem) => (
                  <tr key={`${item.namespace ?? ""}/${item.name}`}>
                    <td>{item.name}</td>
                    <td>{item.namespace ?? "—"}</td>
                    <td>{item.created ? new Date(item.created).toLocaleString() : "—"}</td>
                    <td className="actions">
                      <button onClick={() => openDetail(item)}>Details</button>
                      {item.kind === "Pod" && item.namespace && (
                        <button onClick={() => startLogs(item)}>Logs</button>
                      )}
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
                    apiVersion: "",
                    name: detail.name,
                    namespace: detail.namespace,
                    uid: null,
                    created: null,
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
                {detailTab === "yaml" ? <pre>{detail.yaml}</pre> : (
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
                    {detail.kind === "Pod" && (
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
    </div>
  );
}

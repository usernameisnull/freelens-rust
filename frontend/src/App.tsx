import { useEffect, useRef, useState } from "react";
import {
  HealthCheckResponse,
  IPC_VERSION,
  KubeconfigContext,
  KubeconfigListResponse,
  KubernetesVersionResponse,
  NamespaceItem,
  SystemInfoResponse,
} from "./contracts";
import { createTransport } from "./transport";
import "./styles.css";

const transport = createTransport();

export function App() {
  const [health, setHealth] = useState<HealthCheckResponse>();
  const [system, setSystem] = useState<SystemInfoResponse>();
  const [kubeconfig, setKubeconfig] = useState<KubeconfigListResponse>();
  const [kubeconfigError, setKubeconfigError] = useState<string>();
  const [selectedContext, setSelectedContext] = useState<string>("");
  const selectedContextRef = useRef(selectedContext);
  const setSelectedContextAndRef = (value: string) => {
    selectedContextRef.current = value;
    setSelectedContext(value);
  };
  const [namespaces, setNamespaces] = useState<NamespaceItem[]>();
  const [namespacesError, setNamespacesError] = useState<string>();
  const [namespacesLoading, setNamespacesLoading] = useState(false);
  const [version, setVersion] = useState<KubernetesVersionResponse>();
  const [versionError, setVersionError] = useState<string>();
  const [versionLoading, setVersionLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const requestId = crypto.randomUUID();

    Promise.all([
      transport.healthCheck({
        meta: { version: IPC_VERSION, requestId },
      }),
      transport.systemInfo(),
    ])
      .then(([healthResponse, systemResponse]) => {
        setHealth(healthResponse);
        setSystem(systemResponse);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    transport
      .kubeconfigList({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
      })
      .then((kubeconfigResponse) => {
        setKubeconfig(kubeconfigResponse);
        const fallback = kubeconfigResponse.contexts[0]?.name ?? "";
        setSelectedContextAndRef(kubeconfigResponse.currentContext ?? fallback);
      })
      .catch((reason: unknown) => {
        setKubeconfigError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const withSelectedContext = <T,>(
    call: (context: string) => Promise<T>,
    onSuccess: (result: T) => void,
    setLoading: (loading: boolean) => void,
    onError?: (error: string | undefined) => void
  ) => {
    const context = selectedContext || kubeconfig?.currentContext;
    if (!context) {
      onError?.("No context selected");
      return;
    }
    setLoading(true);
    onError?.(undefined);
    call(context)
      .then((result) => {
        if (context === selectedContextRef.current) {
          onSuccess(result);
        }
      })
      .catch((reason: unknown) => {
        if (context === selectedContextRef.current) {
          onError?.(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (context === selectedContextRef.current) {
          setLoading(false);
        }
      });
  };

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Migration milestone 3</p>
        <h1>Freelens Rust Prototype</h1>
        <p className="summary">
          React renderer connected to a versioned Rust service contract through
          a replaceable transport. Select a kubeconfig context and list cluster
          namespaces from the Rust backend.
        </p>
      </header>

      {error ? (
        <section className="card error">
          <h2>Backend unavailable</h2>
          <p>{error}</p>
        </section>
      ) : (
        <>
          <section className="grid">
            <article className="card">
              <span className={`status ${health?.status ?? "pending"}`} />
              <h2>Service health</h2>
              <strong>{health?.status ?? "checking"}</strong>
              <dl>
                <dt>Service</dt>
                <dd>{health?.service ?? "..."}</dd>
                <dt>IPC version</dt>
                <dd>{health?.version ?? "..."}</dd>
              </dl>
            </article>

            <article className="card">
              <h2>Runtime</h2>
              <dl>
                <dt>Platform</dt>
                <dd>{system ? `${system.os} / ${system.arch}` : "..."}</dd>
                <dt>Application data</dt>
                <dd>{system?.appDataDir ?? "..."}</dd>
                <dt>Logs</dt>
                <dd>{system?.logDir ?? "..."}</dd>
              </dl>
            </article>
          </section>

          <section className="card contexts">
            <h2>Kubeconfig contexts</h2>
            {kubeconfigError ? (
              <p className="version-error">{kubeconfigError}</p>
            ) : kubeconfig ? (
              <>
                <label className="context-label" htmlFor="context-select">
                  Active context
                </label>
                <select
                  id="context-select"
                  className="context-select"
                  value={selectedContext}
                  onChange={(event) => {
                    setSelectedContextAndRef(event.target.value);
                    setNamespaces(undefined);
                    setNamespacesError(undefined);
                    setNamespacesLoading(false);
                    setVersion(undefined);
                    setVersionError(undefined);
                    setVersionLoading(false);
                  }}
                >
                  {kubeconfig.contexts.map((ctx: KubeconfigContext) => (
                    <option key={ctx.name} value={ctx.name}>
                      {ctx.name} ({ctx.cluster})
                    </option>
                  ))}
                </select>
                <table className="context-table">
                  <thead>
                    <tr>
                      <th>Current</th>
                      <th>Context</th>
                      <th>Cluster</th>
                      <th>User</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kubeconfig.contexts.map((ctx: KubeconfigContext) => (
                      <tr key={ctx.name} className={ctx.isCurrent ? "current" : ""}>
                        <td>{ctx.isCurrent ? "●" : ""}</td>
                        <td>{ctx.name}</td>
                        <td>{ctx.cluster}</td>
                        <td>{ctx.user ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p>Loading contexts…</p>
            )}
          </section>

          <section className="card contexts">
            <h2>Cluster explorer</h2>
            <p className="summary">
              Connect to{" "}
              <strong>{selectedContext || kubeconfig?.currentContext || "..."}</strong>{" "}
              and query the cluster.
            </p>
            <div className="button-row">
              <button
                className="check-button"
                onClick={() =>
                  withSelectedContext(
                    (context) =>
                      transport.kubernetesListNamespaces({
                        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
                        context,
                      }),
                    (response) => setNamespaces(response.namespaces),
                    setNamespacesLoading,
                    setNamespacesError
                  )
                }
                disabled={namespacesLoading || !kubeconfig}
              >
                {namespacesLoading ? "Loading…" : "List namespaces"}
              </button>
              <button
                className="check-button secondary"
                onClick={() =>
                  withSelectedContext(
                    (context) =>
                      transport.kubernetesVersion({
                        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
                        context,
                      }),
                    (response) => setVersion(response),
                    setVersionLoading,
                    setVersionError
                  )
                }
                disabled={versionLoading || !kubeconfig}
              >
                {versionLoading ? "Checking…" : "Check /version"}
              </button>
            </div>

            {namespacesError ? (
              <p className="version-error">{namespacesError}</p>
            ) : namespaces ? (
              <div className="namespace-list">
                <h3>Namespaces</h3>
                <ul>
                  {namespaces.map((ns: NamespaceItem) => (
                    <li key={ns.name}>
                      <span className="namespace-name">{ns.name}</span>
                      {ns.status ? (
                        <span className="namespace-status">{ns.status}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {versionError ? (
              <p className="version-error">{versionError}</p>
            ) : version ? (
              <dl>
                <dt>Git version</dt>
                <dd>{version.gitVersion}</dd>
                <dt>Major</dt>
                <dd>{version.major}</dd>
                <dt>Minor</dt>
                <dd>{version.minor}</dd>
              </dl>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}

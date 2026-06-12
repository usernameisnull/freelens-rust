import { useEffect, useState } from "react";
import {
  HealthCheckResponse,
  IPC_VERSION,
  KubeconfigContext,
  KubeconfigListResponse,
  KubernetesVersionResponse,
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
      })
      .catch((reason: unknown) => {
        setKubeconfigError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const checkVersion = () => {
    setVersionLoading(true);
    setVersionError(undefined);
    transport
      .kubernetesVersion({
        meta: { version: IPC_VERSION, requestId: crypto.randomUUID() },
        context: kubeconfig?.currentContext ?? null,
      })
      .then((response) => {
        setVersion(response);
        setVersionLoading(false);
      })
      .catch((reason: unknown) => {
        setVersionError(reason instanceof Error ? reason.message : String(reason));
        setVersionLoading(false);
      });
  };

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Migration milestone 2</p>
        <h1>Freelens Rust Prototype</h1>
        <p className="summary">
          React renderer connected to a versioned Rust service contract through
          a replaceable transport. Kubeconfig discovery runs in the Rust backend.
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
            <p className="summary">
              Current context: <strong>{kubeconfig?.currentContext ?? "..."}</strong>
            </p>
            {kubeconfigError ? (
              <p className="version-error">{kubeconfigError}</p>
            ) : kubeconfig ? (
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
            ) : (
              <p>Loading contexts…</p>
            )}
          </section>

          <section className="card contexts">
            <h2>Cluster health</h2>
            <p className="summary">
              Connect to the current context and query the Kubernetes API server
              <code>/version</code> endpoint.
            </p>
            <button
              className="check-button"
              onClick={checkVersion}
              disabled={versionLoading || !kubeconfig}
            >
              {versionLoading ? "Checking…" : "Check /version"}
            </button>
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

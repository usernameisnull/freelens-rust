import { useEffect, useState } from "react";
import { HealthCheckResponse, IPC_VERSION, SystemInfoResponse } from "./contracts";
import { createTransport } from "./transport";
import "./styles.css";

const transport = createTransport();

export function App() {
  const [health, setHealth] = useState<HealthCheckResponse>();
  const [system, setSystem] = useState<SystemInfoResponse>();
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
  }, []);

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Migration milestone 1</p>
        <h1>Freelens Rust Prototype</h1>
        <p className="summary">
          React renderer connected to a versioned Rust service contract through
          a replaceable transport.
        </p>
      </header>

      {error ? (
        <section className="card error">
          <h2>Backend unavailable</h2>
          <p>{error}</p>
        </section>
      ) : (
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
      )}
    </main>
  );
}


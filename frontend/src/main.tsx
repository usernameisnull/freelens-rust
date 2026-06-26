import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Render crashed:", error, info);
  }
  render() {
    if (this.state.error) {
      const { name, message, stack } = this.state.error;
      return (
        <pre style={{ whiteSpace: "pre-wrap", padding: 16, color: "#ff8080", background: "#1a0000", fontFamily: "monospace", fontSize: 13 }}>
          {`${name}: ${message}\n\n${stack ?? ""}`}
        </pre>
      );
    }
    return this.props.children;
  }
}

const showFatal = (error: unknown) => {
  const root = document.getElementById("root");
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;padding:16px;color:#ff8080;background:#1a0000;font-family:monospace;font-size:13px";
  pre.textContent = error instanceof Error
    ? `${error.name}: ${error.message}\n\n${error.stack ?? ""}`
    : `Fatal: ${String(error)}`;
  (root ?? document.body).replaceChildren(pre);
};

let bootCompleted = false;

try {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (error) {
  showFatal(error);
}

queueMicrotask(() => { bootCompleted = true; });

window.addEventListener("error", (event) => {
  if (!bootCompleted && event.error) showFatal(event.error);
});
window.addEventListener("unhandledrejection", (event) => {
  if (!bootCompleted) {
    showFatal(event.reason);
  } else {
    console.error("Unhandled promise rejection:", event.reason);
  }
});
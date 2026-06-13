import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  HealthCheckRequest,
  HealthCheckResponse,
  IPC_VERSION,
  KubeconfigListRequest,
  KubeconfigListResponse,
  KubernetesDiscoverResourcesRequest,
  KubernetesDiscoverResourcesResponse,
  KubernetesGetResourceYamlRequest,
  KubernetesGetResourceYamlResponse,
  KubernetesGetPodContainersRequest,
  KubernetesGetPodContainersResponse,
  KubernetesListNamespacesRequest,
  KubernetesListNamespacesResponse,
  KubernetesListResourcesRequest,
  KubernetesListResourcesResponse,
  KubernetesStopPodLogsRequest,
  KubernetesStreamPodLogsRequest,
  KubernetesStreamPodLogsResponse,
  KubernetesVersionRequest,
  KubernetesVersionResponse,
  LogDoneEvent,
  LogEvent,
  SystemInfoResponse,
} from "./contracts";

export interface Transport {
  healthCheck(request: HealthCheckRequest): Promise<HealthCheckResponse>;
  systemInfo(): Promise<SystemInfoResponse>;
  kubeconfigList(request: KubeconfigListRequest): Promise<KubeconfigListResponse>;
  kubernetesVersion(request: KubernetesVersionRequest): Promise<KubernetesVersionResponse>;
  kubernetesListNamespaces(
    request: KubernetesListNamespacesRequest
  ): Promise<KubernetesListNamespacesResponse>;
  kubernetesDiscoverResources(
    request: KubernetesDiscoverResourcesRequest
  ): Promise<KubernetesDiscoverResourcesResponse>;
  kubernetesListResources(
    request: KubernetesListResourcesRequest
  ): Promise<KubernetesListResourcesResponse>;
  kubernetesGetResourceYaml(
    request: KubernetesGetResourceYamlRequest
  ): Promise<KubernetesGetResourceYamlResponse>;
  kubernetesGetPodContainers(
    request: KubernetesGetPodContainersRequest
  ): Promise<KubernetesGetPodContainersResponse>;
  kubernetesStreamPodLogs(
    request: KubernetesStreamPodLogsRequest
  ): Promise<KubernetesStreamPodLogsResponse>;
  kubernetesStopPodLogs(request: KubernetesStopPodLogsRequest): Promise<void>;
  onLogEvent(callback: (event: LogEvent) => void): Promise<UnlistenFn>;
  onLogDone(callback: (event: LogDoneEvent) => void): Promise<UnlistenFn>;
}

class TauriTransport implements Transport {
  healthCheck(request: HealthCheckRequest): Promise<HealthCheckResponse> {
    return invoke("health_check", { request });
  }

  systemInfo(): Promise<SystemInfoResponse> {
    return invoke("system_info");
  }

  kubeconfigList(request: KubeconfigListRequest): Promise<KubeconfigListResponse> {
    return invoke("kubeconfig_list", { request });
  }

  kubernetesVersion(request: KubernetesVersionRequest): Promise<KubernetesVersionResponse> {
    return invoke("kubernetes_version", { request });
  }

  kubernetesListNamespaces(
    request: KubernetesListNamespacesRequest
  ): Promise<KubernetesListNamespacesResponse> {
    return invoke("kubernetes_list_namespaces", { request });
  }

  kubernetesDiscoverResources(
    request: KubernetesDiscoverResourcesRequest
  ): Promise<KubernetesDiscoverResourcesResponse> {
    return invoke("kubernetes_discover_resources", { request });
  }

  kubernetesListResources(
    request: KubernetesListResourcesRequest
  ): Promise<KubernetesListResourcesResponse> {
    return invoke("kubernetes_list_resources", { request });
  }

  kubernetesGetResourceYaml(
    request: KubernetesGetResourceYamlRequest
  ): Promise<KubernetesGetResourceYamlResponse> {
    return invoke("kubernetes_get_resource_yaml", { request });
  }

  kubernetesGetPodContainers(
    request: KubernetesGetPodContainersRequest
  ): Promise<KubernetesGetPodContainersResponse> {
    return invoke("kubernetes_get_pod_containers", { request });
  }

  kubernetesStreamPodLogs(
    request: KubernetesStreamPodLogsRequest
  ): Promise<KubernetesStreamPodLogsResponse> {
    return invoke("kubernetes_stream_pod_logs", { request });
  }

  kubernetesStopPodLogs(request: KubernetesStopPodLogsRequest): Promise<void> {
    return invoke("kubernetes_stop_pod_logs", { request });
  }

  onLogEvent(callback: (event: LogEvent) => void): Promise<UnlistenFn> {
    return listen<LogEvent>("kubernetes:log", (event) => callback(event.payload));
  }

  onLogDone(callback: (event: LogDoneEvent) => void): Promise<UnlistenFn> {
    return listen<LogDoneEvent>("kubernetes:log:done", (event) => callback(event.payload));
  }
}

class MockTransport implements Transport {
  async healthCheck(request: HealthCheckRequest): Promise<HealthCheckResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      status: "ok",
      service: "freelens-mock",
    };
  }

  async systemInfo(): Promise<SystemInfoResponse> {
    return {
      version: IPC_VERSION,
      os: navigator.platform || "browser",
      arch: "development",
      appDataDir: "Available in the Tauri desktop shell",
      logDir: "Available in the Tauri desktop shell",
    };
  }

  async kubeconfigList(request: KubeconfigListRequest): Promise<KubeconfigListResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      currentContext: "mock-dev",
      contexts: [
        {
          name: "mock-dev",
          cluster: "mock-dev-cluster",
          user: "mock-dev-user",
          isCurrent: true,
        },
        {
          name: "mock-prod",
          cluster: "mock-prod-cluster",
          user: "mock-prod-user",
          isCurrent: false,
        },
      ],
    };
  }

  async kubernetesVersion(request: KubernetesVersionRequest): Promise<KubernetesVersionResponse> {
    return {
      version: IPC_VERSION,
      requestId: "",
      major: "1",
      minor: "mock",
      gitVersion: "v1.mock.0",
    };
  }

  async kubernetesListNamespaces(
    request: KubernetesListNamespacesRequest
  ): Promise<KubernetesListNamespacesResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      namespaces: [
        { name: "default", status: "Active" },
        { name: "kube-system", status: "Active" },
        { name: "mock-namespace", status: "Active" },
      ],
    };
  }

  async kubernetesDiscoverResources(
    request: KubernetesDiscoverResourcesRequest
  ): Promise<KubernetesDiscoverResourcesResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      kinds: [
        { group: "", version: "v1", kind: "Pod", plural: "pods", scope: "Namespaced", namespaced: true },
        { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", scope: "Namespaced", namespaced: true },
        { group: "", version: "v1", kind: "Service", plural: "services", scope: "Namespaced", namespaced: true },
      ],
    };
  }

  async kubernetesListResources(
    request: KubernetesListResourcesRequest
  ): Promise<KubernetesListResourcesResponse> {
    const base = [
      { name: "nginx-1", namespace: "default" },
      { name: "nginx-2", namespace: "default" },
      { name: "redis", namespace: "default" },
    ];
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      kind: request.kind,
      items: base.map((item, index) => ({
        kind: request.kind,
        apiVersion: request.kind === "Deployment" ? "apps/v1" : "v1",
        name: `${request.kind.toLowerCase()}-${item.name}-${index + 1}`,
        namespace: request.namespace,
        uid: `uid-${index}`,
        created: new Date().toISOString(),
      })),
      continueToken: null,
    };
  }

  async kubernetesGetResourceYaml(
    request: KubernetesGetResourceYamlRequest
  ): Promise<KubernetesGetResourceYamlResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      kind: request.kind,
      name: request.name,
      yaml: `apiVersion: ${request.kind === "Deployment" ? "apps/v1" : "v1"}\nkind: ${request.kind}\nmetadata:\n  name: ${request.name}\n  namespace: ${request.namespace ?? "default"}\n`,
    };
  }

  async kubernetesGetPodContainers(
    request: KubernetesGetPodContainersRequest
  ): Promise<KubernetesGetPodContainersResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      namespace: request.namespace,
      pod: request.pod,
      containers: request.pod.includes("nginx") ? ["app", "sidecar"] : ["app"],
      defaultContainer: "app",
    };
  }

  async kubernetesStreamPodLogs(
    request: KubernetesStreamPodLogsRequest
  ): Promise<KubernetesStreamPodLogsResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      operationId: request.operationId,
      initialLines: ["Existing log line"],
    };
  }

  async kubernetesStopPodLogs(request: KubernetesStopPodLogsRequest): Promise<void> {
    return;
  }

  async onLogEvent(): Promise<UnlistenFn> {
    return () => {};
  }

  async onLogDone(): Promise<UnlistenFn> {
    return () => {};
  }
}

export function createTransport(): Transport {
  return "__TAURI_INTERNALS__" in window ? new TauriTransport() : new MockTransport();
}

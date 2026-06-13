import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  HealthCheckRequest,
  HealthCheckResponse,
  IPC_VERSION,
  KubeconfigListRequest,
  KubeconfigListResponse,
  KubernetesApplyResourceRequest,
  KubernetesApplyResourceResponse,
  KubernetesDeleteResourceRequest,
  KubernetesDiscoverResourcesRequest,
  KubernetesDiscoverResourcesResponse,
  KubernetesExecPodRequest,
  KubernetesExecPodResponse,
  KubernetesGetResourceDetailRequest,
  KubernetesGetResourceDetailResponse,
  KubernetesGetResourceYamlRequest,
  KubernetesGetResourceYamlResponse,
  KubernetesGetPodContainersRequest,
  KubernetesGetPodContainersResponse,
  KubernetesListNamespacesRequest,
  KubernetesListNamespacesResponse,
  KubernetesListResourcesRequest,
  KubernetesListResourcesResponse,
  KubernetesScaleDeploymentRequest,
  KubernetesStartResourceWatchRequest,
  KubernetesStopPodLogsRequest,
  KubernetesStopResourceWatchRequest,
  KubernetesStreamPodLogsRequest,
  KubernetesStreamPodLogsResponse,
  KubernetesVersionRequest,
  KubernetesVersionResponse,
  LogDoneEvent,
  LogEvent,
  ResourceWatchEvent,
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
  kubernetesStartResourceWatch(request: KubernetesStartResourceWatchRequest): Promise<void>;
  kubernetesStopResourceWatch(request: KubernetesStopResourceWatchRequest): Promise<void>;
  onResourceWatchEvent(callback: (event: ResourceWatchEvent) => void): Promise<UnlistenFn>;
  kubernetesGetResourceYaml(
    request: KubernetesGetResourceYamlRequest
  ): Promise<KubernetesGetResourceYamlResponse>;
  kubernetesGetResourceDetail(
    request: KubernetesGetResourceDetailRequest
  ): Promise<KubernetesGetResourceDetailResponse>;
  kubernetesApplyResource(
    request: KubernetesApplyResourceRequest
  ): Promise<KubernetesApplyResourceResponse>;
  kubernetesDeleteResource(request: KubernetesDeleteResourceRequest): Promise<void>;
  kubernetesScaleDeployment(request: KubernetesScaleDeploymentRequest): Promise<void>;
  kubernetesExecPod(request: KubernetesExecPodRequest): Promise<KubernetesExecPodResponse>;
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

  kubernetesStartResourceWatch(request: KubernetesStartResourceWatchRequest): Promise<void> {
    return invoke("kubernetes_start_resource_watch", { request });
  }

  kubernetesStopResourceWatch(request: KubernetesStopResourceWatchRequest): Promise<void> {
    return invoke("kubernetes_stop_resource_watch", { request });
  }

  onResourceWatchEvent(callback: (event: ResourceWatchEvent) => void): Promise<UnlistenFn> {
    return listen<ResourceWatchEvent>("kubernetes:resource-watch", (event) => callback(event.payload));
  }

  kubernetesGetResourceYaml(
    request: KubernetesGetResourceYamlRequest
  ): Promise<KubernetesGetResourceYamlResponse> {
    return invoke("kubernetes_get_resource_yaml", { request });
  }

  kubernetesGetResourceDetail(
    request: KubernetesGetResourceDetailRequest
  ): Promise<KubernetesGetResourceDetailResponse> {
    return invoke("kubernetes_get_resource_detail", { request });
  }

  kubernetesApplyResource(
    request: KubernetesApplyResourceRequest
  ): Promise<KubernetesApplyResourceResponse> {
    return invoke("kubernetes_apply_resource", { request });
  }

  kubernetesDeleteResource(request: KubernetesDeleteResourceRequest): Promise<void> {
    return invoke("kubernetes_delete_resource", { request });
  }

  kubernetesScaleDeployment(request: KubernetesScaleDeploymentRequest): Promise<void> {
    return invoke("kubernetes_scale_deployment", { request });
  }

  kubernetesExecPod(request: KubernetesExecPodRequest): Promise<KubernetesExecPodResponse> {
    return invoke("kubernetes_exec_pod", { request });
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
      items: base.map((item, index) => {
        const columns: Record<string, string> = request.kind === "Pod"
          ? { status: "Running", ready: "1/1", restarts: "0", node: "worker-1" }
          : request.kind === "Deployment"
            ? { ready: "3/3", upToDate: "3", available: "3" }
            : { type: "ClusterIP", clusterIP: "10.96.0.10", ports: "80/TCP" };
        return {
          kind: request.kind,
          apiVersion: request.kind === "Deployment" ? "apps/v1" : "v1",
          name: `${request.kind.toLowerCase()}-${item.name}-${index + 1}`,
          namespace: request.namespace ?? item.namespace,
          uid: `uid-${index}`,
          created: new Date().toISOString(),
          columns,
        };
      }),
      continueToken: null,
    };
  }

  async kubernetesStartResourceWatch(): Promise<void> {}

  async kubernetesStopResourceWatch(): Promise<void> {}

  async onResourceWatchEvent(): Promise<UnlistenFn> {
    return () => {};
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

  async kubernetesGetResourceDetail(
    request: KubernetesGetResourceDetailRequest
  ): Promise<KubernetesGetResourceDetailResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      kind: request.kind,
      name: request.name,
      namespace: request.namespace,
      sections: [{
        title: request.kind === "Deployment" ? "Replicas" : "Status",
        fields: [{ label: "Ready", value: "1" }, { label: "Desired", value: "1" }],
      }],
      containers: request.kind === "Pod" ? [{
        name: "app", image: "nginx:latest", ready: true, restarts: 0, state: "Running",
      }] : [],
      events: request.kind === "Pod" ? [{
        eventType: "Normal", reason: "Started", message: "Started container app", count: 1,
        timestamp: new Date().toISOString(),
      }] : [],
      yaml: `apiVersion: v1\nkind: ${request.kind}\nmetadata:\n  name: ${request.name}\n`,
    };
  }

  async kubernetesApplyResource(
    request: KubernetesApplyResourceRequest
  ): Promise<KubernetesApplyResourceResponse> {
    return { version: IPC_VERSION, requestId: request.meta.requestId, yaml: request.yaml };
  }

  async kubernetesDeleteResource(): Promise<void> {}

  async kubernetesScaleDeployment(): Promise<void> {}

  async kubernetesExecPod(request: KubernetesExecPodRequest): Promise<KubernetesExecPodResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      stdout: "mock command output\n",
      stderr: "",
      success: true,
      status: "Success",
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

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AppSettings,
  HealthCheckRequest,
  HealthCheckResponse,
  IPC_VERSION,
  KubeconfigListRequest,
  KubeconfigListResponse,
  KubectlCancelRequest,
  KubectlInfoRequest,
  KubectlInfoResponse,
  KubectlRunRequest,
  KubectlRunResponse,
  KubernetesApplyResourceRequest,
  KubernetesApplyResourceResponse,
  KubernetesClusterOverviewRequest,
  KubernetesClusterOverviewResponse,
  KubernetesDeleteResourceRequest,
  KubernetesCreateResourceRequest,
  KubernetesCreateResourceResponse,
  KubernetesDiscoverResourcesRequest,
  KubernetesDiscoverResourcesResponse,
  KubernetesExecPodRequest,
  KubernetesExecPodResponse,
  KubernetesListEventsRequest,
  KubernetesListEventsResponse,
  KubernetesGetResourceDetailRequest,
  KubernetesGetResourceDetailResponse,
  KubernetesGetResourceYamlRequest,
  KubernetesGetResourceYamlResponse,
  KubernetesGetPodContainersRequest,
  KubernetesGetPodContainersResponse,
  KubernetesListNamespacesRequest,
  KubernetesListNamespacesResponse,
  KubernetesListMetricsRequest,
  KubernetesListMetricsResponse,
  KubernetesListResourcesRequest,
  KubernetesListResourcesResponse,
  KubernetesRestartWorkloadRequest,
  KubernetesScaleWorkloadRequest,
  KubernetesResizePodTerminalRequest,
  KubernetesStartResourceWatchRequest,
  KubernetesStartPodTerminalRequest,
  KubernetesStartPodTerminalResponse,
  KubernetesStartPodPortForwardRequest,
  KubernetesStartPodPortForwardResponse,
  KubernetesStopPodTerminalRequest,
  KubernetesStopPodPortForwardRequest,
  KubernetesStopPodLogsRequest,
  KubernetesStopResourceWatchRequest,
  KubernetesStreamPodLogsRequest,
  KubernetesStreamPodLogsResponse,
  KubernetesTerminalInputRequest,
  KubernetesTerminalInputResponse,
  KubernetesTriggerCronJobRequest,
  KubernetesTriggerCronJobResponse,
  KubernetesVersionRequest,
  KubernetesVersionResponse,
  LogDoneEvent,
  LogEvent,
  LocalTerminalDoneEvent,
  LocalTerminalInputRequest,
  LocalTerminalInputResponse,
  LocalTerminalOutputEvent,
  LocalTerminalResizeRequest,
  LocalTerminalStartRequest,
  LocalTerminalStartResponse,
  LocalTerminalStopRequest,
  ResourceWatchEvent,
  SettingsLoadRequest,
  SettingsLoadResponse,
  SettingsSaveRequest,
  TerminalDoneEvent,
  TerminalEvent,
  SystemInfoResponse,
} from "./contracts";

export interface Transport {
  healthCheck(request: HealthCheckRequest): Promise<HealthCheckResponse>;
  systemInfo(): Promise<SystemInfoResponse>;
  settingsLoad(request: SettingsLoadRequest): Promise<SettingsLoadResponse>;
  settingsSave(request: SettingsSaveRequest): Promise<void>;
  kubeconfigList(request: KubeconfigListRequest): Promise<KubeconfigListResponse>;
  kubectlInfo(request: KubectlInfoRequest): Promise<KubectlInfoResponse>;
  kubectlRun(request: KubectlRunRequest): Promise<KubectlRunResponse>;
  kubectlCancel(request: KubectlCancelRequest): Promise<void>;
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
  kubernetesListMetrics(request: KubernetesListMetricsRequest): Promise<KubernetesListMetricsResponse>;
  kubernetesClusterOverview(
    request: KubernetesClusterOverviewRequest
  ): Promise<KubernetesClusterOverviewResponse>;
  kubernetesListEvents(request: KubernetesListEventsRequest): Promise<KubernetesListEventsResponse>;
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
  kubernetesCreateResource(
    request: KubernetesCreateResourceRequest
  ): Promise<KubernetesCreateResourceResponse>;
  kubernetesDeleteResource(request: KubernetesDeleteResourceRequest): Promise<void>;
  kubernetesScaleWorkload(request: KubernetesScaleWorkloadRequest): Promise<void>;
  kubernetesRestartWorkload(request: KubernetesRestartWorkloadRequest): Promise<void>;
  kubernetesTriggerCronJob(request: KubernetesTriggerCronJobRequest): Promise<KubernetesTriggerCronJobResponse>;
  kubernetesExecPod(request: KubernetesExecPodRequest): Promise<KubernetesExecPodResponse>;
  kubernetesStartPodTerminal(request: KubernetesStartPodTerminalRequest): Promise<KubernetesStartPodTerminalResponse>;
  kubernetesTerminalInput(request: KubernetesTerminalInputRequest): Promise<KubernetesTerminalInputResponse>;
  kubernetesResizePodTerminal(request: KubernetesResizePodTerminalRequest): Promise<void>;
  kubernetesStopPodTerminal(request: KubernetesStopPodTerminalRequest): Promise<void>;
  kubernetesStartPodPortForward(request: KubernetesStartPodPortForwardRequest): Promise<KubernetesStartPodPortForwardResponse>;
  kubernetesStopPodPortForward(request: KubernetesStopPodPortForwardRequest): Promise<void>;
  onTerminalEvent(callback: (event: TerminalEvent) => void): Promise<UnlistenFn>;
  onTerminalDone(callback: (event: TerminalDoneEvent) => void): Promise<UnlistenFn>;
  kubernetesGetPodContainers(
    request: KubernetesGetPodContainersRequest
  ): Promise<KubernetesGetPodContainersResponse>;
  kubernetesStreamPodLogs(
    request: KubernetesStreamPodLogsRequest
  ): Promise<KubernetesStreamPodLogsResponse>;
  kubernetesStopPodLogs(request: KubernetesStopPodLogsRequest): Promise<void>;
  onLogEvent(callback: (event: LogEvent) => void): Promise<UnlistenFn>;
  onLogDone(callback: (event: LogDoneEvent) => void): Promise<UnlistenFn>;
  localTerminalStart(request: LocalTerminalStartRequest): Promise<LocalTerminalStartResponse>;
  localTerminalInput(request: LocalTerminalInputRequest): Promise<LocalTerminalInputResponse>;
  localTerminalResize(request: LocalTerminalResizeRequest): Promise<void>;
  localTerminalStop(request: LocalTerminalStopRequest): Promise<void>;
  onLocalTerminalOutput(callback: (event: LocalTerminalOutputEvent) => void): Promise<UnlistenFn>;
  onLocalTerminalDone(callback: (event: LocalTerminalDoneEvent) => void): Promise<UnlistenFn>;
}

class TauriTransport implements Transport {
  healthCheck(request: HealthCheckRequest): Promise<HealthCheckResponse> {
    return invoke("health_check", { request });
  }

  systemInfo(): Promise<SystemInfoResponse> {
    return invoke("system_info");
  }

  settingsLoad(request: SettingsLoadRequest): Promise<SettingsLoadResponse> {
    return invoke("settings_load", { request });
  }

  settingsSave(request: SettingsSaveRequest): Promise<void> {
    return invoke("settings_save", { request });
  }

  kubeconfigList(request: KubeconfigListRequest): Promise<KubeconfigListResponse> {
    return invoke("kubeconfig_list", { request });
  }

  kubectlInfo(request: KubectlInfoRequest): Promise<KubectlInfoResponse> {
    return invoke("kubectl_info", { request });
  }

  kubectlRun(request: KubectlRunRequest): Promise<KubectlRunResponse> {
    return invoke("kubectl_run", { request });
  }

  kubectlCancel(request: KubectlCancelRequest): Promise<void> {
    return invoke("kubectl_cancel", { request });
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

  kubernetesListMetrics(request: KubernetesListMetricsRequest): Promise<KubernetesListMetricsResponse> {
    return invoke("kubernetes_list_metrics", { request });
  }

  kubernetesClusterOverview(
    request: KubernetesClusterOverviewRequest
  ): Promise<KubernetesClusterOverviewResponse> {
    return invoke("kubernetes_cluster_overview", { request });
  }

  kubernetesListEvents(request: KubernetesListEventsRequest): Promise<KubernetesListEventsResponse> {
    return invoke("kubernetes_list_events", { request });
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

  kubernetesCreateResource(
    request: KubernetesCreateResourceRequest
  ): Promise<KubernetesCreateResourceResponse> {
    return invoke("kubernetes_create_resource", { request });
  }

  kubernetesDeleteResource(request: KubernetesDeleteResourceRequest): Promise<void> {
    return invoke("kubernetes_delete_resource", { request });
  }

  kubernetesScaleWorkload(request: KubernetesScaleWorkloadRequest): Promise<void> {
    return invoke("kubernetes_scale_workload", { request });
  }

  kubernetesRestartWorkload(request: KubernetesRestartWorkloadRequest): Promise<void> {
    return invoke("kubernetes_restart_workload", { request });
  }

  kubernetesTriggerCronJob(request: KubernetesTriggerCronJobRequest): Promise<KubernetesTriggerCronJobResponse> {
    return invoke("kubernetes_trigger_cronjob", { request });
  }

  kubernetesExecPod(request: KubernetesExecPodRequest): Promise<KubernetesExecPodResponse> {
    return invoke("kubernetes_exec_pod", { request });
  }

  kubernetesStartPodTerminal(request: KubernetesStartPodTerminalRequest): Promise<KubernetesStartPodTerminalResponse> {
    return invoke("kubernetes_start_pod_terminal", { request });
  }

  kubernetesTerminalInput(request: KubernetesTerminalInputRequest): Promise<KubernetesTerminalInputResponse> {
    return invoke("kubernetes_terminal_input", { request });
  }

  kubernetesResizePodTerminal(request: KubernetesResizePodTerminalRequest): Promise<void> {
    return invoke("kubernetes_resize_pod_terminal", { request });
  }

  kubernetesStopPodTerminal(request: KubernetesStopPodTerminalRequest): Promise<void> {
    return invoke("kubernetes_stop_pod_terminal", { request });
  }

  kubernetesStartPodPortForward(request: KubernetesStartPodPortForwardRequest): Promise<KubernetesStartPodPortForwardResponse> {
    return invoke("kubernetes_start_pod_port_forward", { request });
  }

  kubernetesStopPodPortForward(request: KubernetesStopPodPortForwardRequest): Promise<void> {
    return invoke("kubernetes_stop_pod_port_forward", { request });
  }

  onTerminalEvent(callback: (event: TerminalEvent) => void): Promise<UnlistenFn> {
    return listen<TerminalEvent>("kubernetes:terminal", (event) => callback(event.payload));
  }

  onTerminalDone(callback: (event: TerminalDoneEvent) => void): Promise<UnlistenFn> {
    return listen<TerminalDoneEvent>("kubernetes:terminal:done", (event) => callback(event.payload));
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

  localTerminalStart(request: LocalTerminalStartRequest): Promise<LocalTerminalStartResponse> {
    return invoke("local_terminal_start", { request });
  }

  localTerminalInput(request: LocalTerminalInputRequest): Promise<LocalTerminalInputResponse> {
    return invoke("local_terminal_input", { request });
  }

  localTerminalResize(request: LocalTerminalResizeRequest): Promise<void> {
    return invoke("local_terminal_resize", { request });
  }

  localTerminalStop(request: LocalTerminalStopRequest): Promise<void> {
    return invoke("local_terminal_stop", { request });
  }

  onLocalTerminalOutput(callback: (event: LocalTerminalOutputEvent) => void): Promise<UnlistenFn> {
    return listen<LocalTerminalOutputEvent>("local-terminal:output", (event) => callback(event.payload));
  }

  onLocalTerminalDone(callback: (event: LocalTerminalDoneEvent) => void): Promise<UnlistenFn> {
    return listen<LocalTerminalDoneEvent>("local-terminal:done", (event) => callback(event.payload));
  }
}

class MockTransport implements Transport {
  private settings: AppSettings = {
    context: null,
    namespace: null,
    resourceKind: null,
    resourceApiVersion: null,
    refreshSeconds: 0,
    kubeconfigSources: [],
  };
  private terminalSessionId?: string;
  private terminalCallback?: (event: TerminalEvent) => void;
  private terminalDoneCallback?: (event: TerminalDoneEvent) => void;
  private localTerminalSessionId?: string;
  private localTerminalOutputCallback?: (event: LocalTerminalOutputEvent) => void;
  private localTerminalDoneCallback?: (event: LocalTerminalDoneEvent) => void;
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

  async settingsLoad(request: SettingsLoadRequest): Promise<SettingsLoadResponse> {
    return { version: IPC_VERSION, requestId: request.meta.requestId, settings: this.settings };
  }

  async settingsSave(request: SettingsSaveRequest): Promise<void> {
    this.settings = request.settings;
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
          sourcePath: "mock-kubeconfig",
        },
        {
          name: "mock-prod",
          cluster: "mock-prod-cluster",
          user: "mock-prod-user",
          isCurrent: false,
          sourcePath: "mock-kubeconfig",
        },
      ],
      sources: request.sources.length > 0
        ? request.sources.map((source) => ({
            path: source,
            kind: source.endsWith("\\") || source.endsWith("/") ? "directory" : "file",
            fileCount: 1,
            contextCount: 2,
          }))
        : [{
            path: "mock-kubeconfig",
            kind: "file",
            fileCount: 1,
            contextCount: 2,
          }],
      duplicateContexts: [],
    };
  }

  async kubectlInfo(request: KubectlInfoRequest): Promise<KubectlInfoResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      installations: [{ path: "kubectl", version: "v1.mock.0" }],
    };
  }

  async kubectlRun(request: KubectlRunRequest): Promise<KubectlRunResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      operationId: request.operationId,
      stdout: `mock kubectl ${request.arguments.join(" ")}\n`,
      stderr: "",
      exitCode: 0,
      outputTruncated: false,
    };
  }

  async kubectlCancel(): Promise<void> {}

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
        ...[
          ["", "v1", "Pod", "pods", true], ["apps", "v1", "Deployment", "deployments", true],
          ["apps", "v1", "StatefulSet", "statefulsets", true], ["apps", "v1", "DaemonSet", "daemonsets", true],
          ["batch", "v1", "Job", "jobs", true], ["batch", "v1", "CronJob", "cronjobs", true],
          ["", "v1", "Service", "services", true], ["networking.k8s.io", "v1", "Ingress", "ingresses", true],
          ["", "v1", "ConfigMap", "configmaps", true], ["", "v1", "Secret", "secrets", true],
          ["", "v1", "PersistentVolumeClaim", "persistentvolumeclaims", true],
          ["", "v1", "PersistentVolume", "persistentvolumes", false],
          ["", "v1", "Node", "nodes", false],
        ].map(([group, version, kind, plural, namespaced]) => ({
          group: String(group), version: String(version), kind: String(kind), plural: String(plural),
          scope: namespaced ? "Namespaced" : "Cluster", namespaced: Boolean(namespaced), columns: [],
        })),
        {
          group: "example.freelens.dev", version: "v1alpha1", kind: "Widget", plural: "widgets",
          scope: "Namespaced", namespaced: true,
          columns: [
            { name: "Ready", jsonPath: ".status.ready", priority: 0 },
            { name: "Replicas", jsonPath: ".spec.replicas", priority: 0 },
          ],
        },
      ],
    };
  }

  async kubernetesListResources(
    request: KubernetesListResourcesRequest
  ): Promise<KubernetesListResourcesResponse> {
    const largeKinds = new Set(["Pod", "Secret", "ConfigMap"]);
    const itemCount = largeKinds.has(request.kind) ? 1200 : 3;
    const namespaces = [request.namespace ?? "default", "kube-system", "mock-namespace"];
    const base = Array.from({ length: itemCount }, (_, index) => ({
      name: itemCount > 3 ? `${request.kind.toLowerCase()}-${String(index + 1).padStart(4, "0")}` : ["nginx-1", "nginx-2", "redis"][index],
      namespace: namespaces[index % namespaces.length],
    }));
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      kind: request.kind,
      items: base.map((item, index) => {
        const columnsByKind: Record<string, Record<string, string>> = {
          Pod: { status: "Running", ready: "1/1", restarts: "0", node: "worker-1" },
          Deployment: { ready: "3/3", upToDate: "3", available: "3" },
          StatefulSet: { ready: "3/3", upToDate: "3", available: "3" },
          DaemonSet: { desired: "3", current: "3", ready: "3", available: "3" },
          Job: { completions: "1/1", active: "0", failed: "0" },
          CronJob: { schedule: "*/5 * * * *", suspend: "false", active: "0", lastSchedule: "-" },
          Service: { type: "ClusterIP", clusterIP: "10.96.0.10", ports: "80/TCP" },
          Ingress: { class: "nginx", hosts: "example.test" },
          ConfigMap: { data: "3" },
          Secret: { type: "Opaque", data: "2" },
          PersistentVolumeClaim: { status: "Bound", capacity: "10Gi", storageClass: "standard" },
          PersistentVolume: { status: "Bound", capacity: "10Gi", storageClass: "standard" },
          Node: {
            status: "Ready", roles: index === 0 ? "control-plane" : "<none>",
            version: "v1.mock.0", internalIP: `10.0.0.${index + 10}`, externalIP: "<none>",
            osImage: "Mock Linux", kernelVersion: "6.8.0-mock", containerRuntime: "containerd://2.0.0",
          },
          Widget: { Ready: "True", Replicas: "2" },
        };
        const created = new Date(Date.now() - index * 60_000).toISOString();
        const apiVersions: Record<string, string> = {
          Deployment: "apps/v1", StatefulSet: "apps/v1", DaemonSet: "apps/v1",
          Job: "batch/v1", CronJob: "batch/v1", Ingress: "networking.k8s.io/v1",
        };
        return {
          kind: request.kind,
          apiVersion: request.apiVersion || apiVersions[request.kind] || "v1",
          name: item.name,
          namespace: request.kind === "PersistentVolume" || request.kind === "Node"
            ? null
            : request.namespace ?? item.namespace,
          uid: `uid-${index}`,
          created,
          columns: columnsByKind[request.kind] ?? {},
          podContainers: request.kind === "Pod"
            ? [
                {
                  name: "app",
                  type: "containers" as const,
                  ready: true,
                  restartCount: index % 5 === 0 ? 1 : 0,
                  state: { running: { startedAt: created } },
                  lastState: {},
                },
                {
                  name: "init-db",
                  type: "initContainers" as const,
                  ready: false,
                  restartCount: 0,
                  state: { terminated: { reason: "Completed", exitCode: 0 } },
                  lastState: {},
                },
              ]
            : undefined,
        };
      }),
      continueToken: null,
    };
  }

  async kubernetesListMetrics(
    request: KubernetesListMetricsRequest
  ): Promise<KubernetesListMetricsResponse> {
    const names = request.kind === "Node"
      ? ["node-nginx-1-1", "node-nginx-2-2", "node-redis-3"]
      : ["pod-nginx-1-1", "pod-nginx-2-2", "pod-redis-3"];
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      kind: request.kind,
      items: names.map((name, index) => ({
        name,
        namespace: request.kind === "Pod" ? request.namespace ?? "default" : null,
        cpuMillicores: 25 + index * 10,
        memoryBytes: (64 + index * 16) * 1024 * 1024,
      })),
    };
  }

  async kubernetesClusterOverview(
    request: KubernetesClusterOverviewRequest
  ): Promise<KubernetesClusterOverviewResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      namespaces: 4,
      nodes: 3,
      readyNodes: 3,
      pods: 18,
      runningPods: 16,
      abnormalPods: 1,
      workloads: 9,
      unavailableWorkloads: 1,
      cpuMillicores: 840,
      memoryBytes: 3_221_225_472,
      metricsError: null,
    };
  }

  async kubernetesListEvents(
    request: KubernetesListEventsRequest
  ): Promise<KubernetesListEventsResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      items: [
        {
          namespace: "default", eventType: "Warning", reason: "BackOff",
          message: "Back-off restarting failed container", count: 4,
          timestamp: new Date().toISOString(), objectKind: "Pod", objectApiVersion: "v1",
          objectName: "pod-nginx-1-1", objectNamespace: "default",
        },
        {
          namespace: "kube-system", eventType: "Normal", reason: "Scheduled",
          message: "Successfully assigned pod to worker-1", count: 1,
          timestamp: new Date(Date.now() - 60_000).toISOString(), objectKind: "Pod",
          objectApiVersion: "v1", objectName: "coredns-mock", objectNamespace: "kube-system",
        },
      ],
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
    const namespace = request.namespace ? `  namespace: ${request.namespace}\n` : "";
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      context: request.context,
      kind: request.kind,
      name: request.name,
      yaml: `apiVersion: ${request.apiVersion}\nkind: ${request.kind}\nmetadata:\n  name: ${request.name}\n${namespace}`,
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
      apiVersion: request.apiVersion,
      name: request.name,
      namespace: request.namespace,
      sections: [{
        title: request.kind === "Deployment" ? "Replicas" : "Status",
        fields: [{ label: "Ready", value: "1" }, { label: "Desired", value: "1" }],
      }],
      configMapData: request.kind === "ConfigMap" ? [
        { name: "app.properties", value: "debug=true\nworkers=2" },
        { name: "LOG_LEVEL", value: "info" },
      ] : [],
      secretData: request.kind === "Secret" ? [
        { name: "password", value: "cm9vdEAxMjMh" },
        { name: "username", value: "cm9vdA==" },
      ] : [],
      containers: request.kind === "Pod" ? [{
        name: "app", image: "nginx:latest", ready: true, restarts: 0, state: "Running",
      }] : [],
      events: [{
        eventType: "Normal", reason: "Synced", message: `${request.kind} ${request.name} observed`, count: 1,
        timestamp: new Date().toISOString(),
      }],
      yaml: request.kind === "Secret"
        ? `apiVersion: ${request.apiVersion}\nkind: Secret\nmetadata:\n  name: ${request.name}\ntype: Opaque\ndata:\n  password: cm9vdEAxMjMh\n  username: cm9vdA==\n`
        : request.kind === "ConfigMap"
          ? `apiVersion: ${request.apiVersion}\nkind: ConfigMap\nmetadata:\n  name: ${request.name}\ndata:\n  app.properties: "debug=true\\nworkers=2"\n  LOG_LEVEL: "info"\n`
          : `apiVersion: ${request.apiVersion}\nkind: ${request.kind}\nmetadata:\n  name: ${request.name}\n`,
    };
  }

  async kubernetesApplyResource(
    request: KubernetesApplyResourceRequest
  ): Promise<KubernetesApplyResourceResponse> {
    return { version: IPC_VERSION, requestId: request.meta.requestId, yaml: request.yaml };
  }

  async kubernetesCreateResource(
    request: KubernetesCreateResourceRequest
  ): Promise<KubernetesCreateResourceResponse> {
    const apiVersion = request.yaml.match(/^apiVersion:\s*(\S+)/m)?.[1] ?? "v1";
    const kind = request.yaml.match(/^kind:\s*(\S+)/m)?.[1] ?? "ConfigMap";
    const name = request.yaml.match(/^\s*name:\s*(\S+)/m)?.[1] ?? "created-resource";
    const namespace = request.yaml.match(/^\s*namespace:\s*(\S+)/m)?.[1] ?? null;
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      apiVersion,
      kind,
      name,
      namespace,
      yaml: request.yaml,
    };
  }

  async kubernetesDeleteResource(): Promise<void> {}

  async kubernetesScaleWorkload(): Promise<void> {}

  async kubernetesRestartWorkload(): Promise<void> {}

  async kubernetesTriggerCronJob(request: KubernetesTriggerCronJobRequest): Promise<KubernetesTriggerCronJobResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      jobName: `${request.name}-manual-mock`,
    };
  }

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

  async kubernetesStartPodTerminal(request: KubernetesStartPodTerminalRequest): Promise<KubernetesStartPodTerminalResponse> {
    this.terminalSessionId = request.sessionId;
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      sessionId: request.sessionId,
      active: true,
      initialOutput: `Connected to ${request.pod}/${request.container}\n$ `,
    };
  }

  async kubernetesTerminalInput(request: KubernetesTerminalInputRequest): Promise<KubernetesTerminalInputResponse> {
    if (request.sessionId !== this.terminalSessionId) throw new Error("terminal session is not active");
    const response = {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      sessionId: request.sessionId,
      output: "",
    };
    queueMicrotask(() => this.terminalCallback?.({
      sessionId: request.sessionId,
      stream: "stdout",
      data: request.input === "\r" ? "\r\nmock terminal output\r\n$ " : request.input,
    }));
    return response;
  }

  async kubernetesResizePodTerminal(): Promise<void> {}

  async kubernetesStopPodTerminal(request: KubernetesStopPodTerminalRequest): Promise<void> {
    if (request.sessionId === this.terminalSessionId) {
      this.terminalSessionId = undefined;
      queueMicrotask(() => this.terminalDoneCallback?.({ sessionId: request.sessionId }));
    }
  }

  async kubernetesStartPodPortForward(request: KubernetesStartPodPortForwardRequest): Promise<KubernetesStartPodPortForwardResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      operationId: request.operationId,
      localPort: request.localPort || request.remotePort,
      remotePort: request.remotePort,
    };
  }

  async kubernetesStopPodPortForward(): Promise<void> {}

  async onTerminalEvent(callback: (event: TerminalEvent) => void): Promise<UnlistenFn> {
    this.terminalCallback = callback;
    return () => { this.terminalCallback = undefined; };
  }

  async onTerminalDone(callback: (event: TerminalDoneEvent) => void): Promise<UnlistenFn> {
    this.terminalDoneCallback = callback;
    return () => { this.terminalDoneCallback = undefined; };
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

  async localTerminalStart(request: LocalTerminalStartRequest): Promise<LocalTerminalStartResponse> {
    this.localTerminalSessionId = request.sessionId;
    queueMicrotask(() => this.localTerminalOutputCallback?.({
      sessionId: request.sessionId,
      data: `PowerShell mock\r\nFREELENS_CONTEXT=${request.context}\r\nPS> `,
    }));
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      sessionId: request.sessionId,
      shell: "pwsh.exe",
    };
  }

  async localTerminalInput(request: LocalTerminalInputRequest): Promise<LocalTerminalInputResponse> {
    if (request.sessionId !== this.localTerminalSessionId) throw new Error("local terminal session is not active");
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      sessionId: request.sessionId,
      output: request.input,
      active: true,
    };
  }

  async localTerminalResize(): Promise<void> {}

  async localTerminalStop(request: LocalTerminalStopRequest): Promise<void> {
    if (request.sessionId === this.localTerminalSessionId) {
      this.localTerminalSessionId = undefined;
      this.localTerminalDoneCallback?.({ sessionId: request.sessionId });
    }
  }

  async onLocalTerminalOutput(callback: (event: LocalTerminalOutputEvent) => void): Promise<UnlistenFn> {
    this.localTerminalOutputCallback = callback;
    return () => { this.localTerminalOutputCallback = undefined; };
  }

  async onLocalTerminalDone(callback: (event: LocalTerminalDoneEvent) => void): Promise<UnlistenFn> {
    this.localTerminalDoneCallback = callback;
    return () => { this.localTerminalDoneCallback = undefined; };
  }
}

export function createTransport(): Transport {
  return "__TAURI_INTERNALS__" in window ? new TauriTransport() : new MockTransport();
}

export const IPC_VERSION = 1;

export interface HealthCheckRequest {
  meta: {
    version: number;
    requestId: string;
  };
}

export interface HealthCheckResponse {
  version: number;
  requestId: string;
  status: "ok";
  service: string;
}

export interface SystemInfoResponse {
  version: number;
  os: string;
  arch: string;
  appDataDir: string;
  logDir: string;
}

export interface AppSettings {
  context: string | null;
  namespace: string | null;
  resourceKind: string | null;
  resourceApiVersion: string | null;
  refreshSeconds: number;
  kubeconfigSources: string[];
}

export interface SettingsLoadRequest {
  meta: { version: number; requestId: string };
}

export interface SettingsLoadResponse {
  version: number;
  requestId: string;
  settings: AppSettings;
}

export interface SettingsSaveRequest {
  meta: { version: number; requestId: string };
  settings: AppSettings;
}

export interface KubeconfigListRequest {
  meta: {
    version: number;
    requestId: string;
  };
  sources: string[];
}

export interface KubeconfigContext {
  name: string;
  cluster: string;
  user: string | null;
  isCurrent: boolean;
  sourcePath: string | null;
}

export interface KubeconfigListResponse {
  version: number;
  requestId: string;
  currentContext: string | null;
  contexts: KubeconfigContext[];
  sources: KubeconfigSource[];
  duplicateContexts: string[];
}

export interface KubeconfigSource {
  path: string;
  kind: "file" | "directory";
  fileCount: number;
  contextCount: number;
}

export interface KubernetesVersionRequest {
  meta: {
    version: number;
    requestId: string;
  };
  context: string | null;
}

export interface KubernetesVersionResponse {
  version: number;
  requestId: string;
  major: string;
  minor: string;
  gitVersion: string;
}

export interface KubernetesListNamespacesRequest {
  meta: {
    version: number;
    requestId: string;
  };
  context: string;
}

export interface NamespaceItem {
  name: string;
  status: string | null;
}

export interface KubernetesListNamespacesResponse {
  version: number;
  requestId: string;
  context: string;
  namespaces: NamespaceItem[];
}

export interface KubernetesDiscoverResourcesRequest {
  meta: {
    version: number;
    requestId: string;
  };
  context: string;
}

export interface ResourceKindItem {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string;
  namespaced: boolean;
  columns: ResourceColumnItem[];
}

export interface ResourceColumnItem {
  name: string;
  jsonPath: string;
  priority: number;
}

export interface KubernetesDiscoverResourcesResponse {
  version: number;
  requestId: string;
  context: string;
  kinds: ResourceKindItem[];
}

export interface KubernetesListResourcesRequest {
  meta: {
    version: number;
    requestId: string;
  };
  context: string;
  kind: string;
  apiVersion: string;
  columns: ResourceColumnItem[];
  namespace: string | null;
  limit: number | null;
  continueToken: string | null;
}

export interface ResourceItem {
  kind: string;
  apiVersion: string;
  name: string;
  namespace: string | null;
  uid: string | null;
  created: string | null;
  columns: Record<string, string>;
}

export interface KubernetesListResourcesResponse {
  version: number;
  requestId: string;
  context: string;
  kind: string;
  items: ResourceItem[];
  continueToken: string | null;
}

export interface KubernetesListMetricsRequest {
  meta: { version: number; requestId: string };
  context: string;
  kind: "Pod" | "Node";
  namespace: string | null;
}

export interface ResourceMetricItem {
  name: string;
  namespace: string | null;
  cpuMillicores: number | null;
  memoryBytes: number | null;
}

export interface KubernetesListMetricsResponse {
  version: number;
  requestId: string;
  context: string;
  kind: string;
  items: ResourceMetricItem[];
}

export interface KubernetesClusterOverviewRequest {
  meta: { version: number; requestId: string };
  context: string;
}

export interface KubernetesClusterOverviewResponse {
  version: number;
  requestId: string;
  context: string;
  namespaces: number;
  nodes: number;
  readyNodes: number;
  pods: number;
  runningPods: number;
  abnormalPods: number;
  workloads: number;
  unavailableWorkloads: number;
  cpuMillicores: number | null;
  memoryBytes: number | null;
  metricsError: string | null;
}

export interface KubernetesListEventsRequest {
  meta: { version: number; requestId: string };
  context: string;
  namespace: string | null;
}

export interface KubernetesEventItem {
  namespace: string | null;
  eventType: string | null;
  reason: string | null;
  message: string | null;
  count: number | null;
  timestamp: string | null;
  objectKind: string | null;
  objectApiVersion: string | null;
  objectName: string | null;
  objectNamespace: string | null;
}

export interface KubernetesListEventsResponse {
  version: number;
  requestId: string;
  context: string;
  items: KubernetesEventItem[];
}

export interface KubernetesStartResourceWatchRequest {
  meta: { version: number; requestId: string };
  operationId: string;
  context: string;
  kind: string;
  apiVersion: string;
  namespace: string | null;
}

export interface KubernetesStopResourceWatchRequest {
  meta: { version: number; requestId: string };
  operationId: string;
}

export interface ResourceWatchEvent {
  operationId: string;
  type: "changed" | "error";
  message?: string;
}

export interface KubernetesGetResourceYamlRequest {
  meta: {
    version: number;
    requestId: string;
  };
  context: string;
  kind: string;
  apiVersion: string;
  namespace: string | null;
  name: string;
}

export interface KubernetesGetResourceYamlResponse {
  version: number;
  requestId: string;
  context: string;
  kind: string;
  name: string;
  yaml: string;
}

export interface KubernetesGetResourceDetailRequest {
  meta: { version: number; requestId: string };
  context: string;
  kind: string;
  apiVersion: string;
  namespace: string | null;
  name: string;
}

export interface KubernetesGetResourceDetailResponse {
  version: number;
  requestId: string;
  context: string;
  kind: string;
  apiVersion: string;
  name: string;
  namespace: string | null;
  sections: Array<{ title: string; fields: Array<{ label: string; value: string }> }>;
  secretData: Array<{ name: string; value: string }>;
  containers: Array<{
    name: string;
    image: string;
    ready: boolean;
    restarts: number;
    state: string;
  }>;
  events: Array<{
    eventType: string | null;
    reason: string | null;
    message: string | null;
    count: number | null;
    timestamp: string | null;
  }>;
  yaml: string;
}

export interface KubernetesApplyResourceRequest {
  meta: { version: number; requestId: string };
  context: string;
  kind: string;
  apiVersion: string;
  namespace: string | null;
  name: string;
  yaml: string;
}

export interface KubernetesApplyResourceResponse {
  version: number;
  requestId: string;
  yaml: string;
}

export interface KubernetesCreateResourceRequest {
  meta: { version: number; requestId: string };
  context: string;
  yaml: string;
}

export interface KubernetesCreateResourceResponse {
  version: number;
  requestId: string;
  kind: string;
  apiVersion: string;
  name: string;
  namespace: string | null;
  yaml: string;
}

export interface KubernetesDeleteResourceRequest {
  meta: { version: number; requestId: string };
  context: string;
  kind: string;
  apiVersion: string;
  namespace: string | null;
  name: string;
}

export interface KubernetesScaleWorkloadRequest {
  meta: { version: number; requestId: string };
  context: string;
  kind: "Deployment" | "StatefulSet";
  namespace: string;
  name: string;
  replicas: number;
}

export interface KubernetesRestartWorkloadRequest {
  meta: { version: number; requestId: string };
  context: string;
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  namespace: string;
  name: string;
}

export interface KubernetesTriggerCronJobRequest {
  meta: { version: number; requestId: string };
  context: string;
  namespace: string;
  name: string;
}

export interface KubernetesTriggerCronJobResponse {
  version: number;
  requestId: string;
  jobName: string;
}

export interface KubernetesExecPodRequest {
  meta: { version: number; requestId: string };
  context: string;
  namespace: string;
  pod: string;
  container: string;
  command: string;
}

export interface KubernetesExecPodResponse {
  version: number;
  requestId: string;
  stdout: string;
  stderr: string;
  success: boolean;
  status: string | null;
}

export interface KubernetesStartPodTerminalRequest {
  meta: { version: number; requestId: string };
  sessionId: string;
  context: string;
  namespace: string;
  pod: string;
  container: string;
  rows: number;
  cols: number;
}

export interface KubernetesStartPodTerminalResponse {
  version: number;
  requestId: string;
  sessionId: string;
  active: boolean;
  initialOutput: string;
}

export interface KubernetesTerminalInputRequest {
  meta: { version: number; requestId: string };
  sessionId: string;
  input: string;
}

export interface KubernetesTerminalInputResponse {
  version: number;
  requestId: string;
  sessionId: string;
  output: string;
}

export interface KubernetesResizePodTerminalRequest {
  meta: { version: number; requestId: string };
  sessionId: string;
  rows: number;
  cols: number;
}

export interface KubernetesStopPodTerminalRequest {
  meta: { version: number; requestId: string };
  sessionId: string;
}

export interface KubectlInfoRequest {
  meta: { version: number; requestId: string };
}

export interface KubectlInstallation {
  path: string;
  version: string;
}

export interface KubectlInfoResponse {
  version: number;
  requestId: string;
  installations: KubectlInstallation[];
}

export interface KubectlRunRequest {
  meta: { version: number; requestId: string };
  operationId: string;
  executable: string;
  context: string;
  namespace: string | null;
  arguments: string[];
}

export interface KubectlRunResponse {
  version: number;
  requestId: string;
  operationId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  outputTruncated: boolean;
}

export interface KubectlCancelRequest {
  meta: { version: number; requestId: string };
  operationId: string;
}

export interface KubernetesStartPodPortForwardRequest {
  meta: { version: number; requestId: string };
  operationId: string;
  context: string;
  namespace: string;
  pod: string;
  remotePort: number;
  localPort: number;
}

export interface KubernetesStartPodPortForwardResponse {
  version: number;
  requestId: string;
  operationId: string;
  localPort: number;
  remotePort: number;
}

export interface KubernetesStopPodPortForwardRequest {
  meta: { version: number; requestId: string };
  operationId: string;
}

export interface TerminalEvent {
  sessionId: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface TerminalDoneEvent {
  sessionId: string;
}

export interface LocalTerminalStartRequest {
  meta: { version: number; requestId: string };
  sessionId: string;
  context: string;
  namespace: string | null;
  rows: number;
  cols: number;
}

export interface LocalTerminalStartResponse {
  version: number;
  requestId: string;
  sessionId: string;
  shell: string;
}

export interface LocalTerminalInputRequest {
  meta: { version: number; requestId: string };
  sessionId: string;
  input: string;
}

export interface LocalTerminalInputResponse {
  version: number;
  requestId: string;
  sessionId: string;
  output: string;
  active: boolean;
}

export interface LocalTerminalResizeRequest {
  meta: { version: number; requestId: string };
  sessionId: string;
  rows: number;
  cols: number;
}

export interface LocalTerminalStopRequest {
  meta: { version: number; requestId: string };
  sessionId: string;
}

export interface LocalTerminalOutputEvent {
  sessionId: string;
  data: string;
}

export interface LocalTerminalDoneEvent {
  sessionId: string;
}

export interface KubernetesGetPodContainersRequest {
  meta: {
    version: number;
    requestId: string;
  };
  context: string;
  namespace: string;
  pod: string;
}

export interface KubernetesGetPodContainersResponse {
  version: number;
  requestId: string;
  context: string;
  namespace: string;
  pod: string;
  containers: string[];
  defaultContainer: string | null;
}

export interface KubernetesStreamPodLogsRequest {
  meta: {
    version: number;
    requestId: string;
  };
  operationId: string;
  context: string;
  namespace: string;
  pod: string;
  container: string | null;
  follow: boolean;
  tailLines: number | null;
}

export interface KubernetesStreamPodLogsResponse {
  version: number;
  requestId: string;
  operationId: string;
  initialLines: string[];
}

export interface KubernetesStopPodLogsRequest {
  meta: {
    version: number;
    requestId: string;
  };
  operationId: string;
}

export interface LogEvent {
  operationId: string;
  line: string;
}

export interface LogDoneEvent {
  operationId: string;
}

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const IPC_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestMeta {
    pub version: u16,
    pub request_id: String,
}

impl RequestMeta {
    pub fn new(request_id: impl Into<String>) -> Self {
        Self {
            version: IPC_VERSION,
            request_id: request_id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckRequest {
    pub meta: RequestMeta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckResponse {
    pub version: u16,
    pub request_id: String,
    pub status: HealthStatus,
    pub service: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfoResponse {
    pub version: u16,
    pub os: String,
    pub arch: String,
    pub app_data_dir: String,
    pub log_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub resource_kind: Option<String>,
    pub resource_api_version: Option<String>,
    pub refresh_seconds: u32,
    #[serde(default)]
    pub kubeconfig_sources: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadRequest {
    pub meta: RequestMeta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadResponse {
    pub version: u16,
    pub request_id: String,
    pub settings: AppSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSaveRequest {
    pub meta: RequestMeta,
    pub settings: AppSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigListRequest {
    pub meta: RequestMeta,
    #[serde(default)]
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigContext {
    pub name: String,
    pub cluster: String,
    pub cluster_server: Option<String>,
    pub user: Option<String>,
    pub is_current: bool,
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigListResponse {
    pub version: u16,
    pub request_id: String,
    pub current_context: Option<String>,
    pub contexts: Vec<KubeconfigContext>,
    pub sources: Vec<KubeconfigSource>,
    pub duplicate_contexts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigSource {
    pub path: String,
    pub kind: String,
    pub file_count: usize,
    pub context_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesVersionRequest {
    pub meta: RequestMeta,
    pub context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesVersionResponse {
    pub version: u16,
    pub request_id: String,
    pub major: String,
    pub minor: String,
    pub git_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesListNamespacesRequest {
    pub meta: RequestMeta,
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceItem {
    pub name: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesListNamespacesResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub namespaces: Vec<NamespaceItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesDiscoverResourcesRequest {
    pub meta: RequestMeta,
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceKindItem {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub scope: String,
    pub namespaced: bool,
    pub columns: Vec<ResourceColumnItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceColumnItem {
    pub name: String,
    pub json_path: String,
    pub priority: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesDiscoverResourcesResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub kinds: Vec<ResourceKindItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesListResourcesRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub kind: String,
    pub api_version: String,
    pub columns: Vec<ResourceColumnItem>,
    pub namespace: Option<String>,
    pub limit: Option<u32>,
    pub continue_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceItem {
    pub kind: String,
    pub api_version: String,
    pub name: String,
    pub namespace: Option<String>,
    pub uid: Option<String>,
    pub created: Option<String>,
    #[serde(default)]
    pub owner_references: Vec<OwnerReferenceItem>,
    pub columns: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pod_containers: Option<Vec<PodContainerSummary>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerReferenceItem {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub uid: String,
    pub controller: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodContainerSummary {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub ready: bool,
    pub restart_count: i32,
    pub state: BTreeMap<String, serde_json::Value>,
    pub last_state: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesListResourcesResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub kind: String,
    pub items: Vec<ResourceItem>,
    pub continue_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesListMetricsRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub kind: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetricItem {
    pub name: String,
    pub namespace: Option<String>,
    pub cpu_millicores: Option<u64>,
    pub memory_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesListMetricsResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub kind: String,
    pub items: Vec<ResourceMetricItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesClusterOverviewRequest {
    pub meta: RequestMeta,
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesClusterOverviewResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub namespaces: u64,
    pub nodes: u64,
    pub ready_nodes: u64,
    pub pods: u64,
    pub running_pods: u64,
    pub abnormal_pods: u64,
    pub workloads: u64,
    pub unavailable_workloads: u64,
    pub cpu_millicores: Option<u64>,
    pub memory_bytes: Option<u64>,
    pub metrics_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesListEventsRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesEventItem {
    pub namespace: Option<String>,
    pub event_type: Option<String>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub count: Option<i32>,
    pub timestamp: Option<String>,
    pub object_kind: Option<String>,
    pub object_api_version: Option<String>,
    pub object_name: Option<String>,
    pub object_namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesListEventsResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub items: Vec<KubernetesEventItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStartResourceWatchRequest {
    pub meta: RequestMeta,
    pub operation_id: String,
    pub context: String,
    pub kind: String,
    pub api_version: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStopResourceWatchRequest {
    pub meta: RequestMeta,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesGetResourceYamlRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub kind: String,
    pub api_version: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesGetResourceYamlResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub kind: String,
    pub name: String,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesGetResourceDetailRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub kind: String,
    pub api_version: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailFieldItem {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSectionItem {
    pub title: String,
    pub fields: Vec<DetailFieldItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetailItem {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub restarts: i32,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDetailItem {
    pub event_type: Option<String>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub count: Option<i32>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretDataDetailItem {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMapDataDetailItem {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesGetResourceDetailResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub kind: String,
    pub api_version: String,
    pub name: String,
    pub namespace: Option<String>,
    pub sections: Vec<DetailSectionItem>,
    pub config_map_data: Vec<ConfigMapDataDetailItem>,
    pub secret_data: Vec<SecretDataDetailItem>,
    pub containers: Vec<ContainerDetailItem>,
    pub events: Vec<EventDetailItem>,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesApplyResourceRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub kind: String,
    pub api_version: String,
    pub namespace: Option<String>,
    pub name: String,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesApplyResourceResponse {
    pub version: u16,
    pub request_id: String,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesCreateResourceRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesCreateResourceResponse {
    pub version: u16,
    pub request_id: String,
    pub kind: String,
    pub api_version: String,
    pub name: String,
    pub namespace: Option<String>,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesDeleteResourceRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub kind: String,
    pub api_version: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesScaleWorkloadRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub replicas: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesRestartWorkloadRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesTriggerCronJobRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub namespace: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesTriggerCronJobResponse {
    pub version: u16,
    pub request_id: String,
    pub job_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesExecPodRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesExecPodResponse {
    pub version: u16,
    pub request_id: String,
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStartPodTerminalRequest {
    pub meta: RequestMeta,
    pub session_id: String,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStartPodTerminalResponse {
    pub version: u16,
    pub request_id: String,
    pub session_id: String,
    pub active: bool,
    pub initial_output: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesTerminalInputRequest {
    pub meta: RequestMeta,
    pub session_id: String,
    pub input: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesTerminalInputResponse {
    pub version: u16,
    pub request_id: String,
    pub session_id: String,
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesResizePodTerminalRequest {
    pub meta: RequestMeta,
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStopPodTerminalRequest {
    pub meta: RequestMeta,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalStartRequest {
    pub meta: RequestMeta,
    pub session_id: String,
    pub context: String,
    pub namespace: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalStartResponse {
    pub version: u16,
    pub request_id: String,
    pub session_id: String,
    pub shell: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalInputRequest {
    pub meta: RequestMeta,
    pub session_id: String,
    pub input: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalInputResponse {
    pub version: u16,
    pub request_id: String,
    pub session_id: String,
    pub output: String,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalResizeRequest {
    pub meta: RequestMeta,
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalStopRequest {
    pub meta: RequestMeta,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStartPodPortForwardRequest {
    pub meta: RequestMeta,
    pub operation_id: String,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub remote_port: u16,
    pub local_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStartPodPortForwardResponse {
    pub version: u16,
    pub request_id: String,
    pub operation_id: String,
    pub local_port: u16,
    pub remote_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStopPodPortForwardRequest {
    pub meta: RequestMeta,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KubectlInfoRequest {
    pub meta: RequestMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KubectlInstallation {
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KubectlInfoResponse {
    pub version: u16,
    pub request_id: String,
    pub installations: Vec<KubectlInstallation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KubectlRunRequest {
    pub meta: RequestMeta,
    pub operation_id: String,
    pub executable: String,
    pub context: String,
    pub namespace: Option<String>,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KubectlRunResponse {
    pub version: u16,
    pub request_id: String,
    pub operation_id: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub output_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KubectlCancelRequest {
    pub meta: RequestMeta,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesGetPodContainersRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub namespace: String,
    pub pod: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesGetPodContainersResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub containers: Vec<String>,
    pub default_container: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStreamPodLogsRequest {
    pub meta: RequestMeta,
    pub operation_id: String,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
    pub follow: bool,
    pub tail_lines: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStreamPodLogsResponse {
    pub version: u16,
    pub request_id: String,
    pub operation_id: String,
    pub initial_lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesStopPodLogsRequest {
    pub meta: RequestMeta,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workload_action_requests_serialize_camel_case_fields() {
        let scale = KubernetesScaleWorkloadRequest {
            meta: RequestMeta::new("r-scale"),
            context: "dev".into(),
            kind: "StatefulSet".into(),
            namespace: "default".into(),
            name: "database".into(),
            replicas: 3,
        };
        let restart = KubernetesRestartWorkloadRequest {
            meta: RequestMeta::new("r-restart"),
            context: "dev".into(),
            kind: "DaemonSet".into(),
            namespace: "monitoring".into(),
            name: "agent".into(),
        };
        let scale_json = serde_json::to_value(scale).unwrap();
        let restart_json = serde_json::to_value(restart).unwrap();
        assert_eq!(scale_json["meta"]["requestId"], "r-scale");
        assert_eq!(scale_json["kind"], "StatefulSet");
        assert_eq!(scale_json["replicas"], 3);
        assert_eq!(restart_json["meta"]["requestId"], "r-restart");
        assert_eq!(restart_json["kind"], "DaemonSet");
    }

    #[test]
    fn trigger_cronjob_response_serializes_job_name() {
        let response = KubernetesTriggerCronJobResponse {
            version: IPC_VERSION,
            request_id: "r-trigger".into(),
            job_name: "backup-abc12".into(),
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["requestId"], "r-trigger");
        assert_eq!(json["jobName"], "backup-abc12");
    }

    #[test]
    fn health_request_uses_stable_camel_case_json() {
        let request = HealthCheckRequest {
            meta: RequestMeta::new("request-1"),
        };

        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["meta"]["version"], IPC_VERSION);
        assert_eq!(json["meta"]["requestId"], "request-1");
    }

    #[test]
    fn health_status_serializes_as_lowercase() {
        assert_eq!(serde_json::to_string(&HealthStatus::Ok).unwrap(), "\"ok\"");
    }

    #[test]
    fn settings_serialize_stable_resource_selection() {
        let request = SettingsSaveRequest {
            meta: RequestMeta::new("settings-1"),
            settings: AppSettings {
                context: Some("dev".into()),
                namespace: Some("default".into()),
                resource_kind: Some("Deployment".into()),
                resource_api_version: Some("apps/v1".into()),
                refresh_seconds: 15,
                kubeconfig_sources: vec!["C:\\Users\\demo\\.kube\\config".into()],
            },
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["settings"]["resourceKind"], "Deployment");
        assert_eq!(json["settings"]["resourceApiVersion"], "apps/v1");
        assert_eq!(json["settings"]["refreshSeconds"], 15);
        assert_eq!(
            json["settings"]["kubeconfigSources"][0],
            "C:\\Users\\demo\\.kube\\config"
        );
    }

    #[test]
    fn kubeconfig_list_response_serializes_camel_case() {
        let response = KubeconfigListResponse {
            version: IPC_VERSION,
            request_id: "r2".into(),
            current_context: Some("dev".into()),
            contexts: vec![KubeconfigContext {
                name: "dev".into(),
                cluster: "dev-cluster".into(),
                cluster_server: Some("https://10.0.0.1:6443".into()),
                user: Some("dev-user".into()),
                is_current: true,
                source_path: Some("config".into()),
            }],
            sources: vec![KubeconfigSource {
                path: "config".into(),
                kind: "file".into(),
                file_count: 1,
                context_count: 1,
            }],
            duplicate_contexts: vec!["dev".into()],
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["currentContext"], "dev");
        assert_eq!(json["requestId"], "r2");
        assert_eq!(json["contexts"][0]["isCurrent"], true);
        assert_eq!(
            json["contexts"][0]["clusterServer"],
            "https://10.0.0.1:6443"
        );
        assert_eq!(json["contexts"][0]["user"], "dev-user");
        assert_eq!(json["sources"][0]["contextCount"], 1);
        assert_eq!(json["duplicateContexts"][0], "dev");
    }

    #[test]
    fn kubernetes_version_request_serializes_optional_context() {
        let request = KubernetesVersionRequest {
            meta: RequestMeta::new("r3"),
            context: Some("prod".into()),
        };

        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["context"], "prod");
        assert_eq!(json["meta"]["requestId"], "r3");
    }

    #[test]
    fn list_namespaces_response_serializes_camel_case() {
        let response = KubernetesListNamespacesResponse {
            version: IPC_VERSION,
            request_id: "r4".into(),
            context: "dev".into(),
            namespaces: vec![NamespaceItem {
                name: "default".into(),
                status: Some("Active".into()),
            }],
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["context"], "dev");
        assert_eq!(json["requestId"], "r4");
        assert_eq!(json["namespaces"][0]["name"], "default");
        assert_eq!(json["namespaces"][0]["status"], "Active");
    }

    #[test]
    fn resource_list_response_serializes_pod_containers_as_camel_case() {
        let response = KubernetesListResourcesResponse {
            version: IPC_VERSION,
            request_id: "r-resources".into(),
            context: "dev".into(),
            kind: "Pod".into(),
            items: vec![ResourceItem {
                kind: "Pod".into(),
                api_version: "v1".into(),
                name: "web-0".into(),
                namespace: Some("default".into()),
                uid: Some("uid-web".into()),
                created: Some("2026-06-18T10:00:00Z".into()),
                owner_references: vec![OwnerReferenceItem {
                    api_version: "apps/v1".into(),
                    kind: "ReplicaSet".into(),
                    name: "web-765d".into(),
                    uid: "uid-rs".into(),
                    controller: Some(true),
                }],
                columns: BTreeMap::from([("status".into(), "Running".into())]),
                pod_containers: Some(vec![PodContainerSummary {
                    name: "app".into(),
                    type_: "containers".into(),
                    ready: true,
                    restart_count: 1,
                    state: BTreeMap::from([(
                        "running".into(),
                        serde_json::json!({ "startedAt": "2026-06-18T10:00:00Z" }),
                    )]),
                    last_state: BTreeMap::new(),
                }]),
            }],
            continue_token: None,
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["requestId"], "r-resources");
        assert_eq!(json["items"][0]["apiVersion"], "v1");
        assert_eq!(json["items"][0]["podContainers"][0]["type"], "containers");
        assert_eq!(
            json["items"][0]["ownerReferences"][0]["apiVersion"],
            "apps/v1"
        );
        assert_eq!(json["items"][0]["ownerReferences"][0]["kind"], "ReplicaSet");
        assert_eq!(json["items"][0]["podContainers"][0]["restartCount"], 1);
        assert_eq!(
            json["items"][0]["podContainers"][0]["state"]["running"]["startedAt"],
            "2026-06-18T10:00:00Z"
        );
    }

    #[test]
    fn pod_containers_response_serializes_camel_case() {
        let response = KubernetesGetPodContainersResponse {
            version: IPC_VERSION,
            request_id: "r5".into(),
            context: "dev".into(),
            namespace: "default".into(),
            pod: "web".into(),
            containers: vec!["app".into(), "sidecar".into()],
            default_container: Some("app".into()),
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["requestId"], "r5");
        assert_eq!(json["containers"][1], "sidecar");
        assert_eq!(json["defaultContainer"], "app");
    }

    #[test]
    fn exec_pod_response_serializes_camel_case() {
        let response = KubernetesExecPodResponse {
            version: IPC_VERSION,
            request_id: "r6".into(),
            stdout: "ok\n".into(),
            stderr: String::new(),
            success: true,
            status: Some("Success".into()),
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["requestId"], "r6");
        assert_eq!(json["stdout"], "ok\n");
        assert_eq!(json["success"], true);
    }

    #[test]
    fn terminal_start_request_serializes_camel_case() {
        let request = KubernetesStartPodTerminalRequest {
            meta: RequestMeta::new("r-terminal"),
            session_id: "session-1".into(),
            context: "dev".into(),
            namespace: "default".into(),
            pod: "web".into(),
            container: "app".into(),
            rows: 24,
            cols: 80,
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["sessionId"], "session-1");
        assert_eq!(json["meta"]["requestId"], "r-terminal");
        assert_eq!(json["container"], "app");
        assert_eq!(json["rows"], 24);
        assert_eq!(json["cols"], 80);
    }

    #[test]
    fn terminal_start_response_serializes_initial_output() {
        let response = KubernetesStartPodTerminalResponse {
            version: IPC_VERSION,
            request_id: "r-terminal".into(),
            session_id: "session-1".into(),
            active: true,
            initial_output: "sh-5.1# ".into(),
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["requestId"], "r-terminal");
        assert_eq!(json["sessionId"], "session-1");
        assert_eq!(json["initialOutput"], "sh-5.1# ");
        assert_eq!(json["active"], true);
    }

    #[test]
    fn local_terminal_start_request_serializes_context_and_size() {
        let request = LocalTerminalStartRequest {
            meta: RequestMeta::new("r-local-terminal"),
            session_id: "local-1".into(),
            context: "dev".into(),
            namespace: Some("default".into()),
            rows: 30,
            cols: 120,
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["sessionId"], "local-1");
        assert_eq!(json["context"], "dev");
        assert_eq!(json["namespace"], "default");
        assert_eq!(json["rows"], 30);
        assert_eq!(json["cols"], 120);
    }

    #[test]
    fn port_forward_request_serializes_ports() {
        let request = KubernetesStartPodPortForwardRequest {
            meta: RequestMeta::new("r-forward"),
            operation_id: "forward-1".into(),
            context: "dev".into(),
            namespace: "default".into(),
            pod: "web".into(),
            remote_port: 8080,
            local_port: 0,
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["operationId"], "forward-1");
        assert_eq!(json["remotePort"], 8080);
        assert_eq!(json["localPort"], 0);
    }

    #[test]
    fn kubectl_run_request_serializes_arguments_without_a_shell_command() {
        let request = KubectlRunRequest {
            meta: RequestMeta::new("r-kubectl"),
            operation_id: "kubectl-1".into(),
            executable: r"C:\tools\kubectl.exe".into(),
            context: "dev".into(),
            namespace: Some("default".into()),
            arguments: vec!["get".into(), "pods".into(), "-o".into(), "wide".into()],
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["operationId"], "kubectl-1");
        assert_eq!(json["arguments"][1], "pods");
        assert_eq!(json["namespace"], "default");
    }

    #[test]
    fn resource_request_preserves_custom_api_version() {
        let request = KubernetesListResourcesRequest {
            meta: RequestMeta::new("r7"),
            context: "dev".into(),
            kind: "Widget".into(),
            api_version: "example.freelens.dev/v1alpha1".into(),
            columns: vec![ResourceColumnItem {
                name: "Ready".into(),
                json_path: ".status.ready".into(),
                priority: 0,
            }],
            namespace: Some("default".into()),
            limit: Some(50),
            continue_token: None,
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["apiVersion"], "example.freelens.dev/v1alpha1");
        assert_eq!(json["kind"], "Widget");
        assert_eq!(json["columns"][0]["jsonPath"], ".status.ready");
    }

    #[test]
    fn metrics_response_serializes_usage_units() {
        let response = KubernetesListMetricsResponse {
            version: IPC_VERSION,
            request_id: "r-metrics".into(),
            context: "dev".into(),
            kind: "Pod".into(),
            items: vec![ResourceMetricItem {
                name: "web-0".into(),
                namespace: Some("default".into()),
                cpu_millicores: Some(125),
                memory_bytes: Some(67_108_864),
            }],
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["requestId"], "r-metrics");
        assert_eq!(json["items"][0]["cpuMillicores"], 125);
        assert_eq!(json["items"][0]["memoryBytes"], 67_108_864);
    }

    #[test]
    fn cluster_overview_serializes_health_counts() {
        let response = KubernetesClusterOverviewResponse {
            version: IPC_VERSION,
            request_id: "r-overview".into(),
            context: "dev".into(),
            namespaces: 4,
            nodes: 3,
            ready_nodes: 2,
            pods: 18,
            running_pods: 16,
            abnormal_pods: 1,
            workloads: 9,
            unavailable_workloads: 2,
            cpu_millicores: Some(840),
            memory_bytes: Some(3_221_225_472),
            metrics_error: None,
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["readyNodes"], 2);
        assert_eq!(json["abnormalPods"], 1);
        assert_eq!(json["unavailableWorkloads"], 2);
        assert_eq!(json["cpuMillicores"], 840);
    }

    #[test]
    fn event_response_serializes_associated_object() {
        let response = KubernetesListEventsResponse {
            version: IPC_VERSION,
            request_id: "r-events".into(),
            context: "dev".into(),
            items: vec![KubernetesEventItem {
                namespace: Some("default".into()),
                event_type: Some("Warning".into()),
                reason: Some("BackOff".into()),
                message: Some("Back-off restarting container".into()),
                count: Some(3),
                timestamp: Some("2026-06-15T12:00:00Z".into()),
                object_kind: Some("Pod".into()),
                object_api_version: Some("v1".into()),
                object_name: Some("web-0".into()),
                object_namespace: Some("default".into()),
            }],
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["items"][0]["eventType"], "Warning");
        assert_eq!(json["items"][0]["objectKind"], "Pod");
        assert_eq!(json["items"][0]["objectName"], "web-0");
    }
}

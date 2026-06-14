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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigListRequest {
    pub meta: RequestMeta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigContext {
    pub name: String,
    pub cluster: String,
    pub user: Option<String>,
    pub is_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigListResponse {
    pub version: u16,
    pub request_id: String,
    pub current_context: Option<String>,
    pub contexts: Vec<KubeconfigContext>,
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
    pub columns: BTreeMap<String, String>,
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
pub struct KubernetesGetResourceDetailResponse {
    pub version: u16,
    pub request_id: String,
    pub context: String,
    pub kind: String,
    pub api_version: String,
    pub name: String,
    pub namespace: Option<String>,
    pub sections: Vec<DetailSectionItem>,
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
pub struct KubernetesScaleDeploymentRequest {
    pub meta: RequestMeta,
    pub context: String,
    pub namespace: String,
    pub name: String,
    pub replicas: i32,
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
    fn kubeconfig_list_response_serializes_camel_case() {
        let response = KubeconfigListResponse {
            version: IPC_VERSION,
            request_id: "r2".into(),
            current_context: Some("dev".into()),
            contexts: vec![KubeconfigContext {
                name: "dev".into(),
                cluster: "dev-cluster".into(),
                user: Some("dev-user".into()),
                is_current: true,
            }],
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["currentContext"], "dev");
        assert_eq!(json["requestId"], "r2");
        assert_eq!(json["contexts"][0]["isCurrent"], true);
        assert_eq!(json["contexts"][0]["user"], "dev-user");
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
}

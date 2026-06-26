use futures::{AsyncBufReadExt, SinkExt, StreamExt};
use jsonpath_rust::JsonPath;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Event, Namespace, Node, Pod, Service};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{
    Api, AttachParams, DeleteParams, DynamicObject, ListParams, LogParams, Patch, PatchParams,
    TerminalSize, WatchEvent, WatchParams,
};
use kube::config::{KubeConfigOptions, Kubeconfig as KubeconfigFile};
use kube::core::{ApiResource, GroupVersion, GroupVersionKind};
use kube::discovery::{pinned_group, verbs};
use kube::{Resource, ResourceExt};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use thiserror::Error;

/// Stable error codes surfaced to callers and the UI.
#[derive(Debug, Error)]
pub enum KubernetesError {
    #[error("failed to load kubernetes config: {0}")]
    ConfigFailed(String),
    #[error("failed to create kubernetes client: {0}")]
    ClientFailed(String),
    #[error("failed to list namespaces: {0}")]
    ListNamespacesFailed(String),
    #[error("failed to discover resources: {0}")]
    DiscoveryFailed(String),
    #[error("resource kind '{kind}' is not supported or not found on the cluster")]
    UnsupportedResourceKind { kind: String },
    #[error("failed to list resources: {0}")]
    ListResourcesFailed(String),
    #[error("failed to list resource metrics: {0}")]
    ListMetricsFailed(String),
    #[error("failed to get resource: {0}")]
    GetResourceFailed(String),
    #[error("failed to stream pod logs: {0}")]
    StreamLogsFailed(String),
    #[error("failed to apply resource: {0}")]
    ApplyResourceFailed(String),
    #[error("failed to delete resource: {0}")]
    DeleteResourceFailed(String),
    #[error("failed to scale workload: {0}")]
    ScaleWorkloadFailed(String),
    #[error("failed to restart workload: {0}")]
    RestartWorkloadFailed(String),
    #[error("failed to trigger cronjob: {0}")]
    TriggerCronJobFailed(String),
    #[error("failed to execute pod command: {0}")]
    ExecPodFailed(String),
    #[error("failed to forward pod port: {0}")]
    PortForwardFailed(String),
}

impl KubernetesError {
    pub fn code(&self) -> &'static str {
        match self {
            KubernetesError::ConfigFailed(..) => "kubernetes_config_failed",
            KubernetesError::ClientFailed(..) => "kubernetes_client_failed",
            KubernetesError::ListNamespacesFailed(..) => "kubernetes_list_namespaces_failed",
            KubernetesError::DiscoveryFailed(..) => "kubernetes_discovery_failed",
            KubernetesError::UnsupportedResourceKind { .. } => {
                "kubernetes_unsupported_resource_kind"
            }
            KubernetesError::ListResourcesFailed(..) => "kubernetes_list_resources_failed",
            KubernetesError::ListMetricsFailed(..) => "kubernetes_list_metrics_failed",
            KubernetesError::GetResourceFailed(..) => "kubernetes_get_resource_failed",
            KubernetesError::StreamLogsFailed(..) => "kubernetes_stream_logs_failed",
            KubernetesError::ApplyResourceFailed(..) => "kubernetes_apply_resource_failed",
            KubernetesError::DeleteResourceFailed(..) => "kubernetes_delete_resource_failed",
            KubernetesError::ScaleWorkloadFailed(..) => "kubernetes_scale_workload_failed",
            KubernetesError::RestartWorkloadFailed(..) => "kubernetes_restart_workload_failed",
            KubernetesError::TriggerCronJobFailed(..) => "kubernetes_trigger_cronjob_failed",
            KubernetesError::ExecPodFailed(..) => "kubernetes_exec_pod_failed",
            KubernetesError::PortForwardFailed(..) => "kubernetes_port_forward_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceSummary {
    pub name: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceKind {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub scope: ResourceScope,
    pub namespaced: bool,
    pub columns: Vec<ResourceColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceColumn {
    pub name: String,
    pub json_path: String,
    pub priority: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceScope {
    Namespaced,
    Cluster,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSummary {
    pub kind: String,
    pub api_version: String,
    pub name: String,
    pub namespace: Option<String>,
    pub uid: Option<String>,
    pub created: Option<String>,
    pub owner_references: Vec<OwnerReferenceSummary>,
    pub columns: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pod_containers: Option<Vec<PodContainerSummary>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerReferenceSummary {
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
pub struct ResourceList {
    pub kind: String,
    pub items: Vec<ResourceSummary>,
    pub continue_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetric {
    pub name: String,
    pub namespace: Option<String>,
    pub cpu_millicores: Option<u64>,
    pub memory_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverview {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedResource {
    pub kind: String,
    pub api_version: String,
    pub name: String,
    pub namespace: Option<String>,
    pub yaml: String,
}

#[derive(Debug)]
struct ParsedResourceYaml {
    object: DynamicObject,
    kind: String,
    api_version: String,
    name: String,
    namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStreamOptions {
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
    pub follow: bool,
    pub tail_lines: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PodContainers {
    pub names: Vec<String>,
    pub default_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailField {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSection {
    pub title: String,
    pub fields: Vec<DetailField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetail {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub restarts: i32,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDetail {
    pub event_type: Option<String>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub count: Option<i32>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretDataDetail {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMapDataDetail {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterEvent {
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
pub struct ResourceDetail {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub sections: Vec<DetailSection>,
    pub config_map_data: Vec<ConfigMapDataDetail>,
    pub secret_data: Vec<SecretDataDetail>,
    pub containers: Vec<ContainerDetail>,
    pub events: Vec<EventDetail>,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOutput {
    pub stream: &'static str,
    pub data: String,
}

pub struct PodTerminal {
    pub input: tokio::sync::mpsc::Sender<String>,
    pub resize: tokio::sync::mpsc::Sender<(u16, u16)>,
    pub output: tokio::sync::mpsc::Receiver<TerminalOutput>,
    pub abort: tokio::task::AbortHandle,
}

pub struct PodPortForward {
    pub local_port: u16,
    pub abort: tokio::task::AbortHandle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceWatchNotification {
    Changed,
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResourceWatchState {
    resource_version: String,
    retry_delay: std::time::Duration,
}

impl Default for ResourceWatchState {
    fn default() -> Self {
        Self {
            resource_version: "0".into(),
            retry_delay: std::time::Duration::from_secs(1),
        }
    }
}

impl ResourceWatchState {
    fn observe_version(&mut self, version: Option<String>) {
        if let Some(version) = version.filter(|value| !value.is_empty()) {
            self.resource_version = version;
            self.retry_delay = std::time::Duration::from_secs(1);
        }
    }

    fn retry_after_error(&mut self, gone: bool) -> std::time::Duration {
        if gone {
            self.resource_version = "0".into();
        }
        let current = self.retry_delay;
        self.retry_delay = (self.retry_delay * 2).min(std::time::Duration::from_secs(16));
        current
    }
}

fn is_expired_watch_error(code: Option<u16>, message: &str) -> bool {
    code == Some(410) || message.contains("too old resource version")
}

fn watch_event_resource_version(event: &WatchEvent<DynamicObject>) -> Option<String> {
    match event {
        WatchEvent::Added(object) | WatchEvent::Modified(object) | WatchEvent::Deleted(object) => {
            object.resource_version()
        }
        WatchEvent::Bookmark(bookmark) => Some(bookmark.metadata.resource_version.clone()),
        WatchEvent::Error(_) => None,
    }
}

fn field(label: &str, value: impl ToString) -> DetailField {
    DetailField {
        label: label.into(),
        value: value.to_string(),
    }
}

fn append_metadata_sections(
    sections: &mut Vec<DetailSection>,
    labels: Option<&BTreeMap<String, String>>,
    annotations: Option<&BTreeMap<String, String>>,
) {
    if let Some(labels) = labels.filter(|values| !values.is_empty()) {
        sections.push(DetailSection {
            title: "Labels".into(),
            fields: labels
                .iter()
                .map(|(label, value)| field(label, value))
                .collect(),
        });
    }
    if let Some(annotations) = annotations.filter(|values| !values.is_empty()) {
        sections.push(DetailSection {
            title: "Annotations".into(),
            fields: annotations
                .iter()
                .map(|(label, value)| field(label, value))
                .collect(),
        });
    }
}

fn container_state(status: &k8s_openapi::api::core::v1::ContainerStatus) -> String {
    let Some(state) = &status.state else {
        return "Unknown".into();
    };
    if state.running.is_some() {
        "Running".into()
    } else if let Some(waiting) = &state.waiting {
        waiting.reason.clone().unwrap_or_else(|| "Waiting".into())
    } else if let Some(terminated) = &state.terminated {
        terminated
            .reason
            .clone()
            .unwrap_or_else(|| format!("Terminated ({})", terminated.exit_code))
    } else {
        "Unknown".into()
    }
}

fn json_i64(value: &serde_json::Value, path: &[&str]) -> i64 {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0)
}

fn json_string(value: &serde_json::Value, path: &[&str]) -> String {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-")
        .to_string()
}

fn pod_status_message(data: &serde_json::Value) -> String {
    if data
        .pointer("/status/reason")
        .and_then(serde_json::Value::as_str)
        == Some("Evicted")
    {
        return "Evicted".into();
    }

    if data
        .pointer("/metadata/deletionTimestamp")
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        let has_running_or_waiting_container = data
            .pointer("/status/containerStatuses")
            .and_then(serde_json::Value::as_array)
            .map(|statuses| {
                statuses.iter().any(|status| {
                    status.pointer("/state/running").is_some()
                        || status.pointer("/state/waiting").is_some()
                })
            })
            .unwrap_or(false);
        if has_running_or_waiting_container {
            return "Terminating".into();
        }

        let has_finalizers = data
            .pointer("/metadata/finalizers")
            .and_then(serde_json::Value::as_array)
            .map(|finalizers| !finalizers.is_empty())
            .unwrap_or(false);
        if has_finalizers {
            return "Finalizing".into();
        }
    }

    data.pointer("/status/phase")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Waiting")
        .to_string()
}

fn json_object_map(value: Option<&serde_json::Value>) -> BTreeMap<String, serde_json::Value> {
    value
        .and_then(serde_json::Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn pod_container_summaries(data: &serde_json::Value) -> Vec<PodContainerSummary> {
    [
        (
            "containers",
            "/spec/containers",
            "/status/containerStatuses",
        ),
        (
            "initContainers",
            "/spec/initContainers",
            "/status/initContainerStatuses",
        ),
        (
            "ephemeralContainers",
            "/spec/ephemeralContainers",
            "/status/ephemeralContainerStatuses",
        ),
    ]
    .into_iter()
    .flat_map(|(type_, spec_path, status_path)| {
        let statuses = data
            .pointer(status_path)
            .and_then(serde_json::Value::as_array);
        data.pointer(spec_path)
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(move |container| {
                let name = container.get("name")?.as_str()?.to_string();
                let status = statuses.into_iter().flatten().find(|status| {
                    status.get("name").and_then(serde_json::Value::as_str) == Some(&name)
                });
                Some(PodContainerSummary {
                    name,
                    type_: type_.into(),
                    ready: status
                        .and_then(|status| status.get("ready"))
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    restart_count: status
                        .and_then(|status| status.get("restartCount"))
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(0)
                        .try_into()
                        .unwrap_or(0),
                    state: json_object_map(status.and_then(|status| status.get("state"))),
                    last_state: json_object_map(status.and_then(|status| status.get("lastState"))),
                })
            })
    })
    .collect()
}

fn resource_columns(kind: &str, data: &serde_json::Value) -> BTreeMap<String, String> {
    let mut columns = BTreeMap::new();
    match kind {
        "Pod" => {
            let statuses = data
                .pointer("/status/containerStatuses")
                .and_then(serde_json::Value::as_array);
            let total = statuses.map_or(0, Vec::len);
            let ready = statuses.map_or(0, |items| {
                items
                    .iter()
                    .filter(|item| {
                        item.get("ready").and_then(serde_json::Value::as_bool) == Some(true)
                    })
                    .count()
            });
            let restarts: i64 = statuses.map_or(0, |items| {
                items
                    .iter()
                    .map(|item| json_i64(item, &["restartCount"]))
                    .sum()
            });
            columns.insert("status".into(), pod_status_message(data));
            columns.insert("ready".into(), format!("{ready}/{total}"));
            columns.insert("restarts".into(), restarts.to_string());
            columns.insert("node".into(), json_string(data, &["spec", "nodeName"]));
        }
        "Node" => {
            let ready = data
                .pointer("/status/conditions")
                .and_then(serde_json::Value::as_array)
                .and_then(|conditions| {
                    conditions.iter().find(|condition| {
                        condition.get("type").and_then(serde_json::Value::as_str) == Some("Ready")
                    })
                })
                .and_then(|condition| condition.get("status"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Unknown");
            let mut status = if ready == "True" { "Ready" } else { "NotReady" }.to_string();
            if data
                .pointer("/spec/unschedulable")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            {
                status.push_str(",SchedulingDisabled");
            }
            columns.insert("status".into(), status);
            columns.insert(
                "version".into(),
                json_string(data, &["status", "nodeInfo", "kubeletVersion"]),
            );
            let roles = data
                .pointer("/metadata/labels")
                .and_then(serde_json::Value::as_object)
                .map(|labels| {
                    let mut roles = labels
                        .keys()
                        .filter_map(|label| label.strip_prefix("node-role.kubernetes.io/"))
                        .filter(|role| !role.is_empty())
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    if let Some(role) = labels
                        .get("kubernetes.io/role")
                        .and_then(serde_json::Value::as_str)
                    {
                        if !role.is_empty() && !roles.iter().any(|value| value == role) {
                            roles.push(role.into());
                        }
                    }
                    roles.sort();
                    roles.join(",")
                })
                .filter(|roles| !roles.is_empty())
                .unwrap_or_else(|| "<none>".into());
            columns.insert("roles".into(), roles);
            let addresses = data
                .pointer("/status/addresses")
                .and_then(serde_json::Value::as_array);
            let address = |address_type: &str| {
                addresses
                    .into_iter()
                    .flatten()
                    .find(|address| {
                        address.get("type").and_then(serde_json::Value::as_str)
                            == Some(address_type)
                    })
                    .and_then(|address| address.get("address"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("<none>")
                    .to_string()
            };
            columns.insert("internalIP".into(), address("InternalIP"));
            columns.insert("externalIP".into(), address("ExternalIP"));
            columns.insert(
                "osImage".into(),
                json_string(data, &["status", "nodeInfo", "osImage"]),
            );
            columns.insert(
                "kernelVersion".into(),
                json_string(data, &["status", "nodeInfo", "kernelVersion"]),
            );
            columns.insert(
                "containerRuntime".into(),
                json_string(data, &["status", "nodeInfo", "containerRuntimeVersion"]),
            );
        }
        "Deployment" | "StatefulSet" => {
            let desired = data
                .pointer("/spec/replicas")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(1);
            let ready = json_i64(data, &["status", "readyReplicas"]);
            columns.insert("ready".into(), format!("{ready}/{desired}"));
            columns.insert(
                "upToDate".into(),
                json_i64(data, &["status", "updatedReplicas"]).to_string(),
            );
            columns.insert(
                "available".into(),
                json_i64(data, &["status", "availableReplicas"]).to_string(),
            );
        }
        "DaemonSet" => {
            columns.insert(
                "desired".into(),
                json_i64(data, &["status", "desiredNumberScheduled"]).to_string(),
            );
            columns.insert(
                "current".into(),
                json_i64(data, &["status", "currentNumberScheduled"]).to_string(),
            );
            columns.insert(
                "ready".into(),
                json_i64(data, &["status", "numberReady"]).to_string(),
            );
            columns.insert(
                "available".into(),
                json_i64(data, &["status", "numberAvailable"]).to_string(),
            );
        }
        "Job" => {
            columns.insert(
                "completions".into(),
                format!(
                    "{}/{}",
                    json_i64(data, &["status", "succeeded"]),
                    json_i64(data, &["spec", "completions"]).max(1)
                ),
            );
            columns.insert(
                "active".into(),
                json_i64(data, &["status", "active"]).to_string(),
            );
            columns.insert(
                "failed".into(),
                json_i64(data, &["status", "failed"]).to_string(),
            );
        }
        "CronJob" => {
            columns.insert("schedule".into(), json_string(data, &["spec", "schedule"]));
            columns.insert(
                "suspend".into(),
                data.pointer("/spec/suspend")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                    .to_string(),
            );
            columns.insert(
                "active".into(),
                data.pointer("/status/active")
                    .and_then(serde_json::Value::as_array)
                    .map_or(0, Vec::len)
                    .to_string(),
            );
            columns.insert(
                "lastSchedule".into(),
                json_string(data, &["status", "lastScheduleTime"]),
            );
        }
        "Ingress" => {
            columns.insert(
                "class".into(),
                json_string(data, &["spec", "ingressClassName"]),
            );
            let hosts = data
                .pointer("/spec/rules")
                .and_then(serde_json::Value::as_array)
                .map(|rules| {
                    rules
                        .iter()
                        .filter_map(|rule| rule.get("host").and_then(serde_json::Value::as_str))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "-".into());
            columns.insert("hosts".into(), hosts);
        }
        "ConfigMap" | "Secret" => {
            columns.insert(
                "data".into(),
                data.get("data")
                    .and_then(serde_json::Value::as_object)
                    .map_or(0, serde_json::Map::len)
                    .to_string(),
            );
            if kind == "Secret" {
                columns.insert("type".into(), json_string(data, &["type"]));
            }
        }
        "PersistentVolume" | "PersistentVolumeClaim" => {
            columns.insert("status".into(), json_string(data, &["status", "phase"]));
            let capacity = data
                .pointer("/spec/resources/requests/storage")
                .or_else(|| data.pointer("/spec/capacity/storage"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-");
            columns.insert("capacity".into(), capacity.into());
            columns.insert(
                "storageClass".into(),
                json_string(data, &["spec", "storageClassName"]),
            );
        }
        "Service" => {
            columns.insert("type".into(), json_string(data, &["spec", "type"]));
            columns.insert(
                "clusterIP".into(),
                json_string(data, &["spec", "clusterIP"]),
            );
            let ports = data
                .pointer("/spec/ports")
                .and_then(serde_json::Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|port| {
                            let number = port
                                .get("port")
                                .and_then(serde_json::Value::as_i64)
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "-".into());
                            let protocol = port
                                .get("protocol")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("TCP");
                            format!("{number}/{protocol}")
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "-".into());
            columns.insert("ports".into(), ports);
        }
        _ => {}
    }
    columns
}

fn custom_resource_columns(
    data: &serde_json::Value,
    definitions: &[ResourceColumn],
) -> BTreeMap<String, String> {
    definitions
        .iter()
        .filter(|column| column.priority == 0)
        .map(|column| {
            let query = if column.json_path.starts_with('$') {
                column.json_path.clone()
            } else {
                format!("${}", column.json_path)
            };
            let value = JsonPath::try_from(query.as_str())
                .map(|path| format_jsonpath_value(path.find(data)))
                .unwrap_or_else(|_| "-".into());
            (column.name.clone(), value)
        })
        .collect()
}

fn format_jsonpath_value(value: serde_json::Value) -> String {
    let values = match value {
        serde_json::Value::Array(values) => values,
        serde_json::Value::Null => return "-".into(),
        value => vec![value],
    };
    let rendered = values
        .into_iter()
        .filter_map(|value| match value {
            serde_json::Value::Null => None,
            serde_json::Value::String(value) => Some(value),
            serde_json::Value::Bool(value) => Some(value.to_string()),
            serde_json::Value::Number(value) => Some(value.to_string()),
            value => serde_json::to_string(&value).ok(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    if rendered.is_empty() {
        "-".into()
    } else {
        rendered
    }
}

fn gvk_for_kind(kind: &str) -> Option<GroupVersionKind> {
    match kind {
        "Pod" => Some(GroupVersionKind::gvk("", "v1", "Pod")),
        "Event" => Some(GroupVersionKind::gvk("", "v1", "Event")),
        "Node" => Some(GroupVersionKind::gvk("", "v1", "Node")),
        "Deployment" => Some(GroupVersionKind::gvk("apps", "v1", "Deployment")),
        "Service" => Some(GroupVersionKind::gvk("", "v1", "Service")),
        "StatefulSet" => Some(GroupVersionKind::gvk("apps", "v1", "StatefulSet")),
        "DaemonSet" => Some(GroupVersionKind::gvk("apps", "v1", "DaemonSet")),
        "Job" => Some(GroupVersionKind::gvk("batch", "v1", "Job")),
        "CronJob" => Some(GroupVersionKind::gvk("batch", "v1", "CronJob")),
        "Ingress" => Some(GroupVersionKind::gvk("networking.k8s.io", "v1", "Ingress")),
        "ConfigMap" => Some(GroupVersionKind::gvk("", "v1", "ConfigMap")),
        "Secret" => Some(GroupVersionKind::gvk("", "v1", "Secret")),
        "PersistentVolume" => Some(GroupVersionKind::gvk("", "v1", "PersistentVolume")),
        "PersistentVolumeClaim" => Some(GroupVersionKind::gvk("", "v1", "PersistentVolumeClaim")),
        _ => None,
    }
}

fn gvk_for_resource(kind: &str, api_version: &str) -> Option<GroupVersionKind> {
    if api_version.is_empty() {
        return gvk_for_kind(kind);
    }
    let (group, version) = api_version
        .split_once('/')
        .map_or(("", api_version), |(group, version)| (group, version));
    if version.is_empty() {
        return None;
    }
    Some(GroupVersionKind::gvk(group, version, kind))
}

fn is_builtin_resource(kind: &str, api_version: &str) -> bool {
    gvk_for_kind(kind).is_some_and(|expected| {
        gvk_for_resource(kind, api_version).is_some_and(|actual| actual == expected)
    })
}

/// Create a Kubernetes client for the given context.
pub async fn create_client(context: Option<String>) -> Result<kube::Client, KubernetesError> {
    create_client_from_kubeconfig(context, None).await
}

pub async fn create_client_from_kubeconfig(
    context: Option<String>,
    kubeconfig_path: Option<PathBuf>,
) -> Result<kube::Client, KubernetesError> {
    let options = KubeConfigOptions {
        context,
        ..Default::default()
    };
    let config = if let Some(path) = kubeconfig_path {
        let kubeconfig = KubeconfigFile::read_from(&path)
            .map_err(|error| KubernetesError::ConfigFailed(error.to_string()))?;
        kube::Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|error| KubernetesError::ConfigFailed(error.to_string()))?
    } else {
        kube::Config::from_kubeconfig(&options)
            .await
            .map_err(|error| KubernetesError::ConfigFailed(error.to_string()))?
    };
    kube::Client::try_from(config).map_err(|error| KubernetesError::ClientFailed(error.to_string()))
}

/// List all namespaces in the cluster connected by `client`.
pub async fn list_namespaces(
    client: kube::Client,
) -> Result<Vec<NamespaceSummary>, KubernetesError> {
    let api: Api<Namespace> = Api::all(client);
    let mut all_namespaces = Vec::new();
    let mut continue_token: Option<String> = None;

    loop {
        let mut params = ListParams::default().limit(500);
        if let Some(token) = &continue_token {
            params = params.continue_token(token);
        }

        let list = api
            .list(&params)
            .await
            .map_err(|error| KubernetesError::ListNamespacesFailed(error.to_string()))?;

        continue_token = list.metadata.continue_.clone().filter(|s| !s.is_empty());
        all_namespaces.extend(list.into_iter().map(|ns| NamespaceSummary {
            name: ns.name_any(),
            status: ns.status.and_then(|s| s.phase),
        }));

        if continue_token.is_none() {
            break;
        }
    }

    Ok(all_namespaces)
}

/// Discover resource kinds available on the cluster.
pub async fn discover_resources(
    client: kube::Client,
) -> Result<Vec<ResourceKind>, KubernetesError> {
    let api_groups = client
        .list_api_groups()
        .await
        .map_err(|error| KubernetesError::DiscoveryFailed(error.to_string()))?;
    let mut kinds = Vec::new();
    let group_discovery = futures::stream::iter(api_groups.groups.into_iter().map(|group| {
        let client = client.clone();
        async move {
            let group_name = group.name.clone();
            let mut versions = group.versions;
            if let Some(preferred) = group.preferred_version {
                versions.sort_by_key(|version| version.version != preferred.version);
            }
            for version in versions {
                let group_version = GroupVersion::gv(&group_name, &version.version);
                match tokio::time::timeout(
                    std::time::Duration::from_secs(8),
                    pinned_group(&client, &group_version),
                )
                .await
                {
                    Ok(Ok(discovered)) => return Some(discovered),
                    Ok(Err(error)) => tracing::warn!(
                        group = %group_name,
                        version = %version.version,
                        error = %error,
                        "skipping unavailable Kubernetes API group version"
                    ),
                    Err(_) => tracing::warn!(
                        group = %group_name,
                        version = %version.version,
                        "timed out discovering Kubernetes API group version"
                    ),
                }
            }
            None
        }
    }))
    .buffer_unordered(8);
    futures::pin_mut!(group_discovery);
    while let Some(Some(discovered)) = group_discovery.next().await {
        append_discovered_resources(&mut kinds, &discovered);
    }

    append_registered_custom_resources(client.clone(), &mut kinds).await;

    let core_versions = client
        .list_core_api_versions()
        .await
        .map_err(|error| KubernetesError::DiscoveryFailed(error.to_string()))?;
    for version in core_versions.versions {
        let group_version = GroupVersion::gv("", &version);
        match tokio::time::timeout(
            std::time::Duration::from_secs(8),
            pinned_group(&client, &group_version),
        )
        .await
        {
            Ok(Ok(discovered)) => {
                append_discovered_resources(&mut kinds, &discovered);
                break;
            }
            Ok(Err(error)) => tracing::warn!(
                version = %version,
                error = %error,
                "skipping unavailable core Kubernetes API version"
            ),
            Err(_) => tracing::warn!(
                version = %version,
                "timed out discovering core Kubernetes API version"
            ),
        }
    }

    if kinds.is_empty() {
        return Err(KubernetesError::DiscoveryFailed(
            "no listable Kubernetes resources were discovered".into(),
        ));
    }

    Ok(kinds)
}

fn append_discovered_resources(kinds: &mut Vec<ResourceKind>, group: &kube::discovery::ApiGroup) {
    let group_name = group.name().to_string();
    for (ar, caps) in group.recommended_resources() {
        if !caps.supports_operation(verbs::LIST) {
            continue;
        }
        let namespaced = caps.scope == kube::discovery::Scope::Namespaced;
        push_resource_kind(
            kinds,
            ResourceKind {
                group: group_name.clone(),
                version: ar.version.clone(),
                kind: ar.kind.clone(),
                plural: ar.plural.clone(),
                scope: if namespaced {
                    ResourceScope::Namespaced
                } else {
                    ResourceScope::Cluster
                },
                namespaced,
                columns: Vec::new(),
            },
        );
    }
}

async fn append_registered_custom_resources(client: kube::Client, kinds: &mut Vec<ResourceKind>) {
    let crds: Api<CustomResourceDefinition> = Api::all(client);
    let listed = match tokio::time::timeout(
        std::time::Duration::from_secs(20),
        crds.list(&ListParams::default()),
    )
    .await
    {
        Ok(Ok(listed)) => listed,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "failed to list custom resource definitions");
            return;
        }
        Err(_) => {
            tracing::warn!("timed out listing custom resource definitions");
            return;
        }
    };

    for crd in listed {
        let Some(version) = crd
            .spec
            .versions
            .iter()
            .find(|version| version.storage && version.served)
            .or_else(|| crd.spec.versions.iter().find(|version| version.served))
        else {
            continue;
        };
        let namespaced = crd.spec.scope == "Namespaced";
        push_resource_kind(
            kinds,
            ResourceKind {
                group: crd.spec.group,
                version: version.name.clone(),
                kind: crd.spec.names.kind,
                plural: crd.spec.names.plural,
                scope: if namespaced {
                    ResourceScope::Namespaced
                } else {
                    ResourceScope::Cluster
                },
                namespaced,
                columns: version
                    .additional_printer_columns
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|column| !is_standard_resource_column(&column.name))
                    .map(|column| ResourceColumn {
                        name: column.name,
                        json_path: column.json_path,
                        priority: column.priority.unwrap_or(0),
                    })
                    .collect(),
            },
        );
    }
}

fn is_standard_resource_column(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "name" | "namespace" | "age"
    )
}

fn push_resource_kind(kinds: &mut Vec<ResourceKind>, resource: ResourceKind) {
    if let Some(existing) = kinds.iter_mut().find(|item| {
        item.group == resource.group
            && item.version == resource.version
            && item.kind == resource.kind
    }) {
        if existing.columns.is_empty() && !resource.columns.is_empty() {
            existing.columns = resource.columns;
        }
        return;
    }
    kinds.push(resource);
}

/// List resources of a given kind.
pub async fn list_resources(
    client: kube::Client,
    kind: &str,
    api_version: &str,
    column_definitions: &[ResourceColumn],
    namespace: Option<&str>,
    limit: Option<u32>,
    continue_token: Option<&str>,
) -> Result<ResourceList, KubernetesError> {
    let gvk = gvk_for_resource(kind, api_version)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;

    let (ar, caps) = kube::discovery::pinned_kind(&client, &gvk)
        .await
        .map_err(|error| KubernetesError::UnsupportedResourceKind {
            kind: format!("{}: {}", kind, error),
        })?;

    let mut params = ListParams::default();
    if let Some(limit) = limit {
        params = params.limit(limit);
    }
    if let Some(token) = continue_token {
        params = params.continue_token(token);
    }

    let api: Api<DynamicObject> =
        match namespace.filter(|_| caps.scope == kube::discovery::Scope::Namespaced) {
            Some(ns) => Api::namespaced_with(client, ns, &ar),
            None => Api::all_with(client, &ar),
        };

    let list = api
        .list(&params)
        .await
        .map_err(|error| KubernetesError::ListResourcesFailed(error.to_string()))?;

    let continue_token = list.metadata.continue_.clone().filter(|s| !s.is_empty());
    let items = list
        .into_iter()
        .map(|obj| {
            let item_kind = obj
                .types
                .as_ref()
                .map(|t| t.kind.clone())
                .unwrap_or_else(|| kind.into());
            let columns = if column_definitions.is_empty() {
                resource_columns(&item_kind, &obj.data)
            } else {
                custom_resource_columns(&obj.data, column_definitions)
            };
            let pod_containers = (item_kind == "Pod").then(|| pod_container_summaries(&obj.data));
            ResourceSummary {
                kind: item_kind,
                api_version: obj
                    .types
                    .as_ref()
                    .map(|t| t.api_version.clone())
                    .unwrap_or_else(|| api_version.into()),
                name: obj.name_any(),
                namespace: obj.namespace(),
                uid: obj.uid(),
                created: obj.creation_timestamp().map(|t| t.0.to_rfc3339()),
                owner_references: obj
                    .meta()
                    .owner_references
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|reference| OwnerReferenceSummary {
                        api_version: reference.api_version,
                        kind: reference.kind,
                        name: reference.name,
                        uid: reference.uid,
                        controller: reference.controller,
                    })
                    .collect(),
                columns,
                pod_containers,
            }
        })
        .collect();

    Ok(ResourceList {
        kind: kind.into(),
        items,
        continue_token,
    })
}

fn parse_quantity(value: &str, suffixes: &[(&str, f64)], default_multiplier: f64) -> Option<u64> {
    for (suffix, multiplier) in suffixes {
        if let Some(number) = value.strip_suffix(suffix) {
            let result = (number.parse::<f64>().ok()? * multiplier).max(0.0).round();
            return result.is_finite().then_some(result as u64);
        }
    }
    value.parse::<f64>().ok().and_then(|number| {
        let result = (number * default_multiplier).max(0.0).round();
        result.is_finite().then_some(result as u64)
    })
}

fn cpu_millicores(value: &str) -> Option<u64> {
    parse_quantity(value, &[("n", 0.000_001), ("u", 0.001), ("m", 1.0)], 1000.0)
}

fn memory_bytes(value: &str) -> Option<u64> {
    parse_quantity(
        value,
        &[
            ("Ei", 1_152_921_504_606_846_976.0),
            ("Pi", 1_125_899_906_842_624.0),
            ("Ti", 1_099_511_627_776.0),
            ("Gi", 1_073_741_824.0),
            ("Mi", 1_048_576.0),
            ("Ki", 1024.0),
            ("E", 1e18),
            ("P", 1e15),
            ("T", 1e12),
            ("G", 1e9),
            ("M", 1e6),
            ("K", 1e3),
        ],
        1.0,
    )
}

/// List Pod or Node usage from metrics.k8s.io/v1beta1.
pub async fn list_metrics(
    client: kube::Client,
    kind: &str,
    namespace: Option<&str>,
) -> Result<Vec<ResourceMetric>, KubernetesError> {
    let (metrics_kind, plural, namespaced) = match kind {
        "Pod" => ("PodMetrics", "pods", true),
        "Node" => ("NodeMetrics", "nodes", false),
        _ => return Err(KubernetesError::UnsupportedResourceKind { kind: kind.into() }),
    };
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", metrics_kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, plural);
    let api: Api<DynamicObject> = if namespaced {
        namespace.map_or_else(
            || Api::all_with(client.clone(), &ar),
            |ns| Api::namespaced_with(client.clone(), ns, &ar),
        )
    } else {
        Api::all_with(client, &ar)
    };
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|error| KubernetesError::ListMetricsFailed(error.to_string()))?;

    Ok(list
        .into_iter()
        .map(|object| {
            let usages = if namespaced {
                object
                    .data
                    .get("containers")
                    .and_then(serde_json::Value::as_array)
                    .map(|containers| {
                        containers
                            .iter()
                            .filter_map(|container| container.get("usage"))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            } else {
                object.data.get("usage").into_iter().collect()
            };
            let cpu_values = usages
                .iter()
                .filter_map(|usage| {
                    usage
                        .get("cpu")
                        .and_then(serde_json::Value::as_str)
                        .and_then(cpu_millicores)
                })
                .collect::<Vec<_>>();
            let memory_values = usages
                .iter()
                .filter_map(|usage| {
                    usage
                        .get("memory")
                        .and_then(serde_json::Value::as_str)
                        .and_then(memory_bytes)
                })
                .collect::<Vec<_>>();
            ResourceMetric {
                name: object.name_any(),
                namespace: object.namespace(),
                cpu_millicores: (!cpu_values.is_empty()).then(|| cpu_values.into_iter().sum()),
                memory_bytes: (!memory_values.is_empty()).then(|| memory_values.into_iter().sum()),
            }
        })
        .collect())
}

fn node_is_ready(node: &Node) -> bool {
    node.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .into_iter()
        .flatten()
        .any(|condition| condition.type_ == "Ready" && condition.status == "True")
}

/// Build a cluster-wide summary for the dashboard.
pub async fn cluster_overview(client: kube::Client) -> Result<ClusterOverview, KubernetesError> {
    let params = ListParams::default();
    let namespace_api = Api::<Namespace>::all(client.clone());
    let node_api = Api::<Node>::all(client.clone());
    let pod_api = Api::<Pod>::all(client.clone());
    let deployment_api = Api::<Deployment>::all(client.clone());
    let stateful_set_api = Api::<StatefulSet>::all(client.clone());
    let daemon_set_api = Api::<DaemonSet>::all(client.clone());
    let namespaces = namespace_api.list(&params);
    let nodes = node_api.list(&params);
    let pods = pod_api.list(&params);
    let deployments = deployment_api.list(&params);
    let stateful_sets = stateful_set_api.list(&params);
    let daemon_sets = daemon_set_api.list(&params);
    let (namespaces, nodes, pods, deployments, stateful_sets, daemon_sets) = tokio::try_join!(
        namespaces,
        nodes,
        pods,
        deployments,
        stateful_sets,
        daemon_sets,
    )
    .map_err(|error| KubernetesError::ListResourcesFailed(error.to_string()))?;

    let running_pods = pods
        .items
        .iter()
        .filter(|pod| {
            pod.status
                .as_ref()
                .and_then(|status| status.phase.as_deref())
                == Some("Running")
        })
        .count() as u64;
    let abnormal_pods = pods
        .items
        .iter()
        .filter(|pod| {
            !matches!(
                pod.status
                    .as_ref()
                    .and_then(|status| status.phase.as_deref()),
                Some("Running" | "Succeeded")
            )
        })
        .count() as u64;
    let unavailable_deployments = deployments
        .items
        .iter()
        .filter(|item| {
            let desired = item
                .spec
                .as_ref()
                .and_then(|spec| spec.replicas)
                .unwrap_or(1);
            let available = item
                .status
                .as_ref()
                .and_then(|status| status.available_replicas)
                .unwrap_or(0);
            available < desired
        })
        .count() as u64;
    let unavailable_stateful_sets = stateful_sets
        .items
        .iter()
        .filter(|item| {
            let desired = item
                .spec
                .as_ref()
                .and_then(|spec| spec.replicas)
                .unwrap_or(1);
            let ready = item
                .status
                .as_ref()
                .and_then(|status| status.ready_replicas)
                .unwrap_or(0);
            ready < desired
        })
        .count() as u64;
    let unavailable_daemon_sets = daemon_sets
        .items
        .iter()
        .filter(|item| {
            item.status
                .as_ref()
                .is_none_or(|status| status.number_ready < status.desired_number_scheduled)
        })
        .count() as u64;

    let (cpu_millicores, memory_bytes, metrics_error) =
        match list_metrics(client, "Node", None).await {
            Ok(metrics) => (
                Some(
                    metrics
                        .iter()
                        .filter_map(|metric| metric.cpu_millicores)
                        .sum(),
                ),
                Some(
                    metrics
                        .iter()
                        .filter_map(|metric| metric.memory_bytes)
                        .sum(),
                ),
                None,
            ),
            Err(error) => (None, None, Some(error.to_string())),
        };
    let workload_count =
        deployments.items.len() + stateful_sets.items.len() + daemon_sets.items.len();

    Ok(ClusterOverview {
        namespaces: namespaces.items.len() as u64,
        nodes: nodes.items.len() as u64,
        ready_nodes: nodes
            .items
            .iter()
            .filter(|node| node_is_ready(node))
            .count() as u64,
        pods: pods.items.len() as u64,
        running_pods,
        abnormal_pods,
        workloads: workload_count as u64,
        unavailable_workloads: unavailable_deployments
            + unavailable_stateful_sets
            + unavailable_daemon_sets,
        cpu_millicores,
        memory_bytes,
        metrics_error,
    })
}

/// List Kubernetes events with their associated object identity.
pub async fn list_events(
    client: kube::Client,
    namespace: Option<&str>,
) -> Result<Vec<ClusterEvent>, KubernetesError> {
    let api = namespace.map_or_else(
        || Api::<Event>::all(client.clone()),
        |namespace| Api::<Event>::namespaced(client.clone(), namespace),
    );
    let listed = api
        .list(&ListParams::default())
        .await
        .map_err(|error| KubernetesError::ListResourcesFailed(error.to_string()))?;
    let mut events = listed
        .into_iter()
        .map(|event| {
            let timestamp = event_timestamp(&event);
            ClusterEvent {
                namespace: event.namespace(),
                event_type: event.type_,
                reason: event.reason,
                message: event.message,
                count: event.count,
                timestamp,
                object_kind: event.involved_object.kind,
                object_api_version: event.involved_object.api_version,
                object_name: event.involved_object.name,
                object_namespace: event.involved_object.namespace,
            }
        })
        .collect::<Vec<_>>();
    events.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    Ok(events)
}

fn event_timestamp(event: &Event) -> Option<String> {
    event
        .event_time
        .as_ref()
        .map(|time| time.0.to_rfc3339())
        .or_else(|| {
            event
                .last_timestamp
                .as_ref()
                .map(|time| time.0.to_rfc3339())
        })
        .or_else(|| {
            event
                .first_timestamp
                .as_ref()
                .map(|time| time.0.to_rfc3339())
        })
        .or_else(|| event.creation_timestamp().map(|time| time.0.to_rfc3339()))
}

/// Get a resource as YAML.
pub async fn get_resource_yaml(
    client: kube::Client,
    kind: &str,
    api_version: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<String, KubernetesError> {
    let gvk = gvk_for_resource(kind, api_version)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;

    let (ar, caps) = kube::discovery::pinned_kind(&client, &gvk)
        .await
        .map_err(|error| KubernetesError::UnsupportedResourceKind {
            kind: format!("{}: {}", kind, error),
        })?;

    if caps.scope == kube::discovery::Scope::Namespaced && namespace.is_none() {
        return Err(KubernetesError::GetResourceFailed(format!(
            "{kind} namespace is required"
        )));
    }

    let namespace = namespace.filter(|_| caps.scope == kube::discovery::Scope::Namespaced);
    let url = <DynamicObject as kube::Resource>::url_path(&ar, namespace);
    let http_req = kube::core::Request::new(url)
        .get(name, &kube::api::GetParams::default())
        .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
    let text = client
        .request_text(http_req)
        .await
        .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;

    serde_yaml_ng::to_string(&value)
        .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))
}

/// Get a structured overview and YAML for the supported resource kinds.
pub async fn get_resource_detail(
    client: kube::Client,
    kind: &str,
    api_version: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<ResourceDetail, KubernetesError> {
    let yaml = get_resource_yaml(client.clone(), kind, api_version, namespace, name).await?;
    let mut sections = Vec::new();
    let mut config_map_data = Vec::new();
    let mut secret_data = Vec::new();
    let mut containers = Vec::new();
    let mut events = Vec::new();

    match kind {
        "Pod" if is_builtin_resource(kind, api_version) => {
            let namespace = namespace.ok_or_else(|| {
                KubernetesError::GetResourceFailed("Pod namespace is required".into())
            })?;
            let pod: Pod = Api::namespaced(client.clone(), namespace)
                .get(name)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let status = pod.status.as_ref();
            sections.push(DetailSection {
                title: "Status".into(),
                fields: vec![
                    field(
                        "Phase",
                        status.and_then(|s| s.phase.as_deref()).unwrap_or("Unknown"),
                    ),
                    field(
                        "Node",
                        pod.spec
                            .as_ref()
                            .and_then(|s| s.node_name.as_deref())
                            .unwrap_or("-"),
                    ),
                    field(
                        "Pod IP",
                        status.and_then(|s| s.pod_ip.as_deref()).unwrap_or("-"),
                    ),
                    field(
                        "Host IP",
                        status.and_then(|s| s.host_ip.as_deref()).unwrap_or("-"),
                    ),
                    field(
                        "QoS Class",
                        status.and_then(|s| s.qos_class.as_deref()).unwrap_or("-"),
                    ),
                ],
            });
            append_metadata_sections(
                &mut sections,
                pod.metadata.labels.as_ref(),
                pod.metadata.annotations.as_ref(),
            );
            let images: HashMap<String, String> = pod
                .spec
                .as_ref()
                .map(|spec| {
                    spec.containers
                        .iter()
                        .map(|container| {
                            (
                                container.name.clone(),
                                container.image.clone().unwrap_or_default(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            containers = status
                .and_then(|s| s.container_statuses.as_ref())
                .into_iter()
                .flatten()
                .map(|container| ContainerDetail {
                    name: container.name.clone(),
                    image: images.get(&container.name).cloned().unwrap_or_default(),
                    ready: container.ready,
                    restarts: container.restart_count,
                    state: container_state(container),
                })
                .collect();

            if let Some(uid) = pod.uid() {
                events = list_object_events(client, Some(namespace), &uid).await?;
            }
        }
        "Deployment" if is_builtin_resource(kind, api_version) => {
            let namespace = namespace.ok_or_else(|| {
                KubernetesError::GetResourceFailed("Deployment namespace is required".into())
            })?;
            let deployment: Deployment = Api::namespaced(client.clone(), namespace)
                .get(name)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let desired = deployment
                .spec
                .as_ref()
                .and_then(|s| s.replicas)
                .unwrap_or(1);
            let status = deployment.status.as_ref();
            sections.push(DetailSection {
                title: "Replicas".into(),
                fields: vec![
                    field("Desired", desired),
                    field("Current", status.and_then(|s| s.replicas).unwrap_or(0)),
                    field("Ready", status.and_then(|s| s.ready_replicas).unwrap_or(0)),
                    field(
                        "Updated",
                        status.and_then(|s| s.updated_replicas).unwrap_or(0),
                    ),
                    field(
                        "Available",
                        status.and_then(|s| s.available_replicas).unwrap_or(0),
                    ),
                    field(
                        "Unavailable",
                        status.and_then(|s| s.unavailable_replicas).unwrap_or(0),
                    ),
                ],
            });
            sections.push(DetailSection {
                title: "Strategy".into(),
                fields: vec![field(
                    "Type",
                    deployment
                        .spec
                        .as_ref()
                        .and_then(|s| s.strategy.as_ref())
                        .and_then(|s| s.type_.as_deref())
                        .unwrap_or("RollingUpdate"),
                )],
            });
            append_metadata_sections(
                &mut sections,
                deployment.metadata.labels.as_ref(),
                deployment.metadata.annotations.as_ref(),
            );
            if let Some(uid) = deployment.uid() {
                events = list_object_events(client, Some(namespace), &uid).await?;
            }
        }
        "Service" if is_builtin_resource(kind, api_version) => {
            let namespace = namespace.ok_or_else(|| {
                KubernetesError::GetResourceFailed("Service namespace is required".into())
            })?;
            let service: Service = Api::namespaced(client.clone(), namespace)
                .get(name)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let spec = service.spec.as_ref();
            sections.push(DetailSection {
                title: "Service".into(),
                fields: vec![
                    field(
                        "Type",
                        spec.and_then(|s| s.type_.as_deref()).unwrap_or("ClusterIP"),
                    ),
                    field(
                        "Cluster IP",
                        spec.and_then(|s| s.cluster_ip.as_deref()).unwrap_or("-"),
                    ),
                    field(
                        "External IPs",
                        spec.and_then(|s| s.external_ips.as_ref())
                            .map(|values| values.join(", "))
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| "-".into()),
                    ),
                ],
            });
            let selector = spec
                .and_then(|s| s.selector.as_ref())
                .map(|values| {
                    values
                        .iter()
                        .map(|(k, v)| format!("{k}={v}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "-".into());
            sections.push(DetailSection {
                title: "Routing".into(),
                fields: vec![
                    field("Selector", selector),
                    field(
                        "Ports",
                        spec.and_then(|s| s.ports.as_ref())
                            .map(|ports| {
                                ports
                                    .iter()
                                    .map(|port| {
                                        let target = port.target_port.as_ref().map(|target| match target {
                                            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(value) => value.to_string(),
                                            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(value) => value.clone(),
                                        }).unwrap_or_else(|| port.port.to_string());
                                        format!(
                                            "{}/{} -> {}",
                                            port.port,
                                            port.protocol.as_deref().unwrap_or("TCP"),
                                            target
                                        )
                                    })
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            })
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| "-".into()),
                    ),
                ],
            });
            append_metadata_sections(
                &mut sections,
                service.metadata.labels.as_ref(),
                service.metadata.annotations.as_ref(),
            );
            if let Some(uid) = service.uid() {
                events = list_object_events(client, Some(namespace), &uid).await?;
            }
        }
        _ => {
            let gvk = gvk_for_resource(kind, api_version)
                .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;
            let (ar, caps) = kube::discovery::pinned_kind(&client, &gvk)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let api: Api<DynamicObject> =
                match namespace.filter(|_| caps.scope == kube::discovery::Scope::Namespaced) {
                    Some(namespace) => Api::namespaced_with(client.clone(), namespace, &ar),
                    None => Api::all_with(client.clone(), &ar),
                };
            let object = api
                .get(name)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let object_namespace = object.namespace();
            if let Some(uid) = object.uid() {
                events =
                    list_object_events(client.clone(), object_namespace.as_deref(), &uid).await?;
            }
            let data = object.data;
            if kind == "ConfigMap" {
                config_map_data = data
                    .get("data")
                    .and_then(|value| value.as_object())
                    .map(|values| {
                        let mut values: Vec<ConfigMapDataDetail> = values
                            .iter()
                            .flat_map(|(name, value)| {
                                value.as_str().map(|value| ConfigMapDataDetail {
                                    name: name.clone(),
                                    value: value.to_owned(),
                                })
                            })
                            .collect();
                        values.sort_by(|left, right| left.name.cmp(&right.name));
                        values
                    })
                    .unwrap_or_default();
            }
            if kind == "Secret" {
                secret_data = data
                    .get("data")
                    .and_then(|value| value.as_object())
                    .map(|values| {
                        let mut values: Vec<SecretDataDetail> = values
                            .iter()
                            .flat_map(|(name, value)| {
                                value.as_str().map(|value| SecretDataDetail {
                                    name: name.clone(),
                                    value: value.to_owned(),
                                })
                            })
                            .collect();
                        values.sort_by(|left, right| left.name.cmp(&right.name));
                        values
                    })
                    .unwrap_or_default();
            }
            let columns = resource_columns(kind, &data);
            let mut overview = vec![field("API Version", api_version)];
            overview.extend(
                columns
                    .into_iter()
                    .map(|(label, value)| field(&label, value)),
            );
            sections.push(DetailSection {
                title: "Overview".into(),
                fields: overview,
            });
            append_metadata_sections(
                &mut sections,
                object.metadata.labels.as_ref(),
                object.metadata.annotations.as_ref(),
            );
        }
    }

    Ok(ResourceDetail {
        kind: kind.into(),
        name: name.into(),
        namespace: namespace.map(str::to_owned),
        sections,
        config_map_data,
        secret_data,
        containers,
        events,
        yaml,
    })
}

async fn list_object_events(
    client: kube::Client,
    namespace: Option<&str>,
    uid: &str,
) -> Result<Vec<EventDetail>, KubernetesError> {
    let params = ListParams::default().fields(&format!("involvedObject.uid={uid}"));
    let listed = match namespace {
        Some(namespace) => {
            Api::<Event>::namespaced(client, namespace)
                .list(&params)
                .await
        }
        None => Api::<Event>::all(client).list(&params).await,
    }
    .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
    let mut events: Vec<EventDetail> = listed
        .into_iter()
        .map(|event| EventDetail {
            event_type: event.type_,
            reason: event.reason,
            message: event.message,
            count: event.count,
            timestamp: event
                .last_timestamp
                .map(|time| time.0.to_rfc3339())
                .or_else(|| event.event_time.map(|time| time.0.to_rfc3339())),
        })
        .collect();
    events.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    Ok(events)
}

async fn dynamic_api(
    client: kube::Client,
    kind: &str,
    api_version: &str,
    namespace: Option<&str>,
) -> Result<(Api<DynamicObject>, kube::discovery::Scope), KubernetesError> {
    let gvk = gvk_for_resource(kind, api_version)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;
    let (ar, caps) = kube::discovery::pinned_kind(&client, &gvk)
        .await
        .map_err(|error| KubernetesError::UnsupportedResourceKind {
            kind: format!("{}: {}", kind, error),
        })?;
    let scope = caps.scope;
    let api = match namespace.filter(|_| scope == kube::discovery::Scope::Namespaced) {
        Some(namespace) => Api::namespaced_with(client, namespace, &ar),
        None => Api::all_with(client, &ar),
    };
    Ok((api, scope))
}

/// Watch a supported resource collection and reconnect after transient failures.
pub async fn watch_resources(
    client: kube::Client,
    kind: &str,
    api_version: &str,
    namespace: Option<&str>,
) -> Result<
    (
        tokio::sync::mpsc::Receiver<ResourceWatchNotification>,
        tokio::task::AbortHandle,
    ),
    KubernetesError,
> {
    let gvk = gvk_for_resource(kind, api_version)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;
    let (ar, caps) = kube::discovery::pinned_kind(&client, &gvk)
        .await
        .map_err(|error| KubernetesError::UnsupportedResourceKind {
            kind: format!("{}: {}", kind, error),
        })?;
    let api: Api<DynamicObject> =
        match namespace.filter(|_| caps.scope == kube::discovery::Scope::Namespaced) {
            Some(namespace) => Api::namespaced_with(client, namespace, &ar),
            None => Api::all_with(client, &ar),
        };
    let (tx, rx) = tokio::sync::mpsc::channel(32);
    let task = tokio::spawn(async move {
        let mut state = ResourceWatchState::default();
        loop {
            let params = WatchParams::default().timeout(30);
            match api.watch(&params, &state.resource_version).await {
                Ok(stream) => {
                    futures::pin_mut!(stream);
                    while let Some(event) = stream.next().await {
                        match event {
                            Ok(
                                event @ (WatchEvent::Added(_)
                                | WatchEvent::Modified(_)
                                | WatchEvent::Deleted(_)),
                            ) => {
                                state.observe_version(watch_event_resource_version(&event));
                                if tx.send(ResourceWatchNotification::Changed).await.is_err() {
                                    return;
                                }
                            }
                            Ok(WatchEvent::Error(error)) => {
                                let gone = is_expired_watch_error(Some(error.code), &error.message);
                                let _ = tx
                                    .send(ResourceWatchNotification::Error(error.message))
                                    .await;
                                let delay = state.retry_after_error(gone);
                                tokio::time::sleep(delay).await;
                                break;
                            }
                            Ok(event @ WatchEvent::Bookmark(_)) => {
                                state.observe_version(watch_event_resource_version(&event));
                            }
                            Err(error) => {
                                let _ = tx
                                    .send(ResourceWatchNotification::Error(error.to_string()))
                                    .await;
                                let delay = state.retry_after_error(false);
                                tokio::time::sleep(delay).await;
                                break;
                            }
                        }
                    }
                }
                Err(error) => {
                    if tx
                        .send(ResourceWatchNotification::Error(error.to_string()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    let delay = state.retry_after_error(false);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    });
    Ok((rx, task.abort_handle()))
}

/// Apply edited YAML to the same resource using a merge patch.
pub async fn apply_resource_yaml(
    client: kube::Client,
    expected_kind: &str,
    expected_api_version: &str,
    expected_namespace: Option<&str>,
    expected_name: &str,
    yaml: &str,
) -> Result<String, KubernetesError> {
    let mut object: DynamicObject = serde_yaml_ng::from_str(yaml)
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))?;
    let actual_kind = object
        .types
        .as_ref()
        .map(|types| types.kind.as_str())
        .unwrap_or_default();
    let actual_api_version = object
        .types
        .as_ref()
        .map(|types| types.api_version.as_str())
        .unwrap_or_default();
    let actual_name = object.name_any();
    let actual_namespace = object.namespace();
    if actual_kind != expected_kind
        || actual_api_version != expected_api_version
        || actual_name != expected_name
        || actual_namespace.as_deref() != expected_namespace
    {
        return Err(KubernetesError::ApplyResourceFailed(format!(
            "YAML identity {actual_api_version} {actual_kind} {}/{actual_name} does not match {expected_api_version} {expected_kind} {}/{}",
            actual_namespace.as_deref().unwrap_or("<cluster>"),
            expected_namespace.unwrap_or("<cluster>"),
            expected_name,
        )));
    }
    let (api, scope) = dynamic_api(
        client,
        expected_kind,
        expected_api_version,
        expected_namespace,
    )
    .await?;
    if scope == kube::discovery::Scope::Namespaced && expected_namespace.is_none() {
        return Err(KubernetesError::ApplyResourceFailed(format!(
            "{expected_kind} namespace is required"
        )));
    }
    sanitize_apply_object(&mut object);
    let applied = api
        .patch(
            expected_name,
            &PatchParams::default(),
            &Patch::Merge(&object),
        )
        .await
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))?;
    serde_yaml_ng::to_string(&applied)
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))
}

fn sanitize_apply_object(object: &mut DynamicObject) {
    object.metadata.managed_fields = None;
    object.metadata.resource_version = None;
    object.metadata.uid = None;
    object.metadata.generation = None;
    object.metadata.creation_timestamp = None;
    object.metadata.deletion_timestamp = None;
    object.metadata.deletion_grace_period_seconds = None;
    object.metadata.self_link = None;
    if let Some(data) = object.data.as_object_mut() {
        data.remove("status");
    }
}

/// Create a resource from YAML using server-side apply and return its resolved identity.
pub async fn create_resource_yaml(
    client: kube::Client,
    yaml: &str,
) -> Result<AppliedResource, KubernetesError> {
    let parsed = parse_resource_yaml(yaml)?;
    let ParsedResourceYaml {
        object,
        kind,
        api_version,
        name,
        namespace,
    } = parsed;
    let (api, scope) = dynamic_api(client, &kind, &api_version, namespace.as_deref()).await?;
    if scope == kube::discovery::Scope::Namespaced && namespace.is_none() {
        return Err(KubernetesError::ApplyResourceFailed(format!(
            "{kind} metadata.namespace is required"
        )));
    }
    if scope == kube::discovery::Scope::Cluster && namespace.is_some() {
        return Err(KubernetesError::ApplyResourceFailed(format!(
            "{kind} is cluster-scoped and cannot have metadata.namespace"
        )));
    }
    let applied = api
        .patch(
            &name,
            &PatchParams::apply("freelens-rust"),
            &Patch::Apply(&object),
        )
        .await
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))?;
    let yaml = serde_yaml_ng::to_string(&applied)
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))?;
    Ok(AppliedResource {
        kind,
        api_version,
        name,
        namespace,
        yaml,
    })
}

fn parse_resource_yaml(yaml: &str) -> Result<ParsedResourceYaml, KubernetesError> {
    let object: DynamicObject = serde_yaml_ng::from_str(yaml)
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))?;
    let types = object.types.as_ref().ok_or_else(|| {
        KubernetesError::ApplyResourceFailed("apiVersion and kind are required".into())
    })?;
    let kind = types.kind.clone();
    let api_version = types.api_version.clone();
    let name = object
        .metadata
        .name
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| KubernetesError::ApplyResourceFailed("metadata.name is required".into()))?;
    let namespace = object.namespace();
    Ok(ParsedResourceYaml {
        object,
        kind,
        api_version,
        name,
        namespace,
    })
}

/// Delete a supported namespaced resource.
pub async fn delete_resource(
    client: kube::Client,
    kind: &str,
    api_version: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<(), KubernetesError> {
    let (api, scope) = dynamic_api(client, kind, api_version, namespace).await?;
    if scope == kube::discovery::Scope::Namespaced && namespace.is_none() {
        return Err(KubernetesError::DeleteResourceFailed(format!(
            "{kind} namespace is required"
        )));
    }
    api.delete(name, &DeleteParams::default())
        .await
        .map_err(|error| KubernetesError::DeleteResourceFailed(error.to_string()))?;
    Ok(())
}

/// Update the desired replica count of a Deployment or StatefulSet.
pub async fn scale_workload(
    client: kube::Client,
    kind: &str,
    namespace: &str,
    name: &str,
    replicas: i32,
) -> Result<(), KubernetesError> {
    if replicas < 0 {
        return Err(KubernetesError::ScaleWorkloadFailed(
            "replicas cannot be negative".into(),
        ));
    }
    let patch = Patch::Merge(serde_json::json!({ "spec": { "replicas": replicas } }));
    match kind {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            api.patch(name, &PatchParams::default(), &patch)
                .await
                .map(|_| ())
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            api.patch(name, &PatchParams::default(), &patch)
                .await
                .map(|_| ())
        }
        _ => {
            return Err(KubernetesError::ScaleWorkloadFailed(format!(
                "{kind} does not support scaling"
            )));
        }
    }
    .map_err(|error| KubernetesError::ScaleWorkloadFailed(error.to_string()))?;
    Ok(())
}

/// Trigger a rolling restart by changing the Pod template annotation.
pub async fn restart_workload(
    client: kube::Client,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<(), KubernetesError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| KubernetesError::RestartWorkloadFailed(error.to_string()))?;
    let restarted_at = format!("{}.{:09}", now.as_secs(), now.subsec_nanos());
    let patch = Patch::Merge(serde_json::json!({
        "spec": { "template": { "metadata": { "annotations": {
            "freelens.dev/restartedAt": restarted_at
        } } } }
    }));
    match kind {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            api.patch(name, &PatchParams::default(), &patch)
                .await
                .map(|_| ())
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            api.patch(name, &PatchParams::default(), &patch)
                .await
                .map(|_| ())
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client, namespace);
            api.patch(name, &PatchParams::default(), &patch)
                .await
                .map(|_| ())
        }
        _ => {
            return Err(KubernetesError::RestartWorkloadFailed(format!(
                "{kind} does not support rolling restart"
            )));
        }
    }
    .map_err(|error| KubernetesError::RestartWorkloadFailed(error.to_string()))?;
    Ok(())
}

/// Create a one-off Job from a CronJob's job template.
pub async fn trigger_cronjob(
    client: kube::Client,
    namespace: &str,
    name: &str,
) -> Result<String, KubernetesError> {
    let cronjobs: Api<CronJob> = Api::namespaced(client.clone(), namespace);
    let cronjob = cronjobs
        .get(name)
        .await
        .map_err(|error| KubernetesError::TriggerCronJobFailed(error.to_string()))?;
    let job_template = cronjob
        .spec
        .map(|spec| spec.job_template)
        .ok_or_else(|| KubernetesError::TriggerCronJobFailed("job template is missing".into()))?;
    let spec = job_template.spec.ok_or_else(|| {
        KubernetesError::TriggerCronJobFailed("job template spec is missing".into())
    })?;
    let template_metadata = job_template.metadata.unwrap_or_default();
    let prefix_len = name.len().min(57);
    let job = Job {
        metadata: kube::core::ObjectMeta {
            generate_name: Some(format!("{}-", &name[..prefix_len])),
            namespace: Some(namespace.into()),
            labels: template_metadata.labels,
            annotations: template_metadata.annotations,
            ..Default::default()
        },
        spec: Some(spec),
        status: None,
    };
    let jobs: Api<Job> = Api::namespaced(client, namespace);
    let created = jobs
        .create(&Default::default(), &job)
        .await
        .map_err(|error| KubernetesError::TriggerCronJobFailed(error.to_string()))?;
    Ok(created.name_any())
}

/// Execute a shell command in a Pod container and collect its output.
pub async fn exec_pod_command(
    client: kube::Client,
    namespace: &str,
    pod: &str,
    container: &str,
    command: &str,
) -> Result<ExecResult, KubernetesError> {
    use tokio::io::AsyncReadExt;

    if command.trim().is_empty() {
        return Err(KubernetesError::ExecPodFailed(
            "command cannot be empty".into(),
        ));
    }
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let params = AttachParams::default()
        .container(container)
        .stdin(false)
        .stdout(true)
        .stderr(true);
    let mut process = api
        .exec(pod, ["sh", "-c", command], &params)
        .await
        .map_err(|error| KubernetesError::ExecPodFailed(error.to_string()))?;
    let mut stdout_reader = process
        .stdout()
        .ok_or_else(|| KubernetesError::ExecPodFailed("stdout is unavailable".into()))?;
    let mut stderr_reader = process
        .stderr()
        .ok_or_else(|| KubernetesError::ExecPodFailed("stderr is unavailable".into()))?;
    let status_future = process.take_status();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let (stdout_result, stderr_result, status, joined) = tokio::join!(
        stdout_reader.read_to_string(&mut stdout),
        stderr_reader.read_to_string(&mut stderr),
        async {
            match status_future {
                Some(status) => status.await,
                None => None,
            }
        },
        process.join(),
    );
    stdout_result.map_err(|error| KubernetesError::ExecPodFailed(error.to_string()))?;
    stderr_result.map_err(|error| KubernetesError::ExecPodFailed(error.to_string()))?;
    joined.map_err(|error| KubernetesError::ExecPodFailed(error.to_string()))?;
    let status_text = status.as_ref().and_then(|value| value.status.clone());
    let success = status_text
        .as_deref()
        .is_none_or(|value| value == "Success");
    Ok(ExecResult {
        stdout,
        stderr,
        success,
        status: status_text,
    })
}

/// Start a persistent shell in a Pod container with line-oriented input and streamed output.
pub async fn start_pod_terminal(
    client: kube::Client,
    namespace: &str,
    pod: &str,
    container: &str,
    shell: &str,
) -> Result<PodTerminal, KubernetesError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let api: Api<Pod> = Api::namespaced(client, namespace);
    let params = AttachParams::interactive_tty().container(container);
    let mut process = api
        .exec(pod, [shell, "-i"], &params)
        .await
        .map_err(|error| KubernetesError::ExecPodFailed(error.to_string()))?;
    let mut stdin = process
        .stdin()
        .ok_or_else(|| KubernetesError::ExecPodFailed("stdin is unavailable".into()))?;
    let mut stdout = process
        .stdout()
        .ok_or_else(|| KubernetesError::ExecPodFailed("stdout is unavailable".into()))?;
    let status = process.take_status();
    let mut terminal_size = process
        .terminal_size()
        .ok_or_else(|| KubernetesError::ExecPodFailed("terminal resize is unavailable".into()))?;
    let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<String>(32);
    let (resize_tx, mut resize_rx) = tokio::sync::mpsc::channel::<(u16, u16)>(8);
    let (output_tx, output_rx) = tokio::sync::mpsc::channel::<TerminalOutput>(128);

    let task = tokio::spawn(async move {
        let join = process.join();
        tokio::pin!(join);
        let status = async move {
            match status {
                Some(status) => status.await,
                None => None,
            }
        };
        tokio::pin!(status);
        let mut stdout_buffer = [0u8; 4096];
        let mut stdout_open = true;
        loop {
            tokio::select! {
                biased;
                input = input_rx.recv() => match input {
                    Some(input) => {
                        if let Err(error) = stdin.write_all(input.as_bytes()).await {
                            let _ = output_tx.send(TerminalOutput {
                                stream: "stderr",
                                data: format!("terminal input failed: {error}\n"),
                            }).await;
                            break;
                        }
                        let _ = stdin.flush().await;
                    }
                    None => break,
                },
                size = resize_rx.recv() => match size {
                    Some((rows, cols)) => {
                        if terminal_size.send(TerminalSize {
                            height: rows,
                            width: cols,
                        }).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                result = stdout.read(&mut stdout_buffer), if stdout_open => match result {
                    Ok(0) => stdout_open = false,
                    Ok(size) => {
                        if output_tx.send(TerminalOutput {
                            stream: "stdout",
                            data: String::from_utf8_lossy(&stdout_buffer[..size]).into_owned(),
                        }).await.is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = output_tx.send(TerminalOutput {
                            stream: "stderr",
                            data: format!("terminal stdout failed: {error}\n"),
                        }).await;
                        stdout_open = false;
                    }
                },
                remote_status = &mut status => {
                    if let Some(remote_status) = remote_status {
                        if remote_status.status.as_deref() == Some("Failure") {
                            let message = remote_status.message
                                .or(remote_status.reason)
                                .unwrap_or_else(|| "terminal command failed".into());
                            let _ = output_tx.send(TerminalOutput {
                                stream: "stderr",
                                data: format!("{message}\n"),
                            }).await;
                        }
                    }
                    break;
                },
                result = &mut join => {
                    if let Err(error) = result {
                        let _ = output_tx.send(TerminalOutput {
                            stream: "stderr",
                            data: format!("terminal session failed: {error}\n"),
                        }).await;
                    }
                    break;
                }
            }
        }
    });

    Ok(PodTerminal {
        input: input_tx,
        resize: resize_tx,
        output: output_rx,
        abort: task.abort_handle(),
    })
}

/// Bind a loopback TCP port and forward each accepted connection to a Pod port.
pub async fn start_pod_port_forward(
    client: kube::Client,
    namespace: &str,
    pod: &str,
    remote_port: u16,
    local_port: u16,
) -> Result<PodPortForward, KubernetesError> {
    use tokio::io::copy_bidirectional;
    use tokio::net::TcpListener;

    if remote_port == 0 {
        return Err(KubernetesError::PortForwardFailed(
            "remote port must be between 1 and 65535".into(),
        ));
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, local_port))
        .await
        .map_err(|error| KubernetesError::PortForwardFailed(error.to_string()))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| KubernetesError::PortForwardFailed(error.to_string()))?
        .port();
    let namespace = namespace.to_owned();
    let pod = pod.to_owned();
    let task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (mut socket, _) = match accepted {
                        Ok(connection) => connection,
                        Err(error) => {
                            tracing::warn!(%error, "pod port-forward listener stopped");
                            break;
                        }
                    };
                    let client = client.clone();
                    let namespace = namespace.clone();
                    let pod = pod.clone();
                    connections.spawn(async move {
                        let api: Api<Pod> = Api::namespaced(client, &namespace);
                        let mut forwarder = match api.portforward(&pod, &[remote_port]).await {
                            Ok(forwarder) => forwarder,
                            Err(error) => {
                                tracing::warn!(%error, %pod, remote_port, "failed to open pod port-forward");
                                return;
                            }
                        };
                        let Some(mut stream) = forwarder.take_stream(remote_port) else {
                            tracing::warn!(%pod, remote_port, "pod port-forward stream is unavailable");
                            return;
                        };
                        if let Err(error) = copy_bidirectional(&mut socket, &mut stream).await {
                            tracing::debug!(%error, %pod, remote_port, "pod port-forward connection closed");
                        }
                    });
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {
                    // Completed connections are removed from the session task set.
                }
            }
        }
    });
    Ok(PodPortForward {
        local_port: bound_port,
        abort: task.abort_handle(),
    })
}

/// Return the loggable containers declared by a Pod.
pub async fn get_pod_containers(
    client: kube::Client,
    namespace: &str,
    pod: &str,
) -> Result<PodContainers, KubernetesError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let pod = api
        .get(pod)
        .await
        .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
    let annotated_default = pod
        .metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get("kubectl.kubernetes.io/default-container"))
        .cloned();
    let Some(spec) = pod.spec else {
        return Ok(PodContainers {
            names: Vec::new(),
            default_name: None,
        });
    };

    let regular_containers: Vec<String> =
        spec.containers.into_iter().map(|item| item.name).collect();
    let default_name = annotated_default
        .filter(|name| regular_containers.contains(name))
        .or_else(|| regular_containers.first().cloned());
    let mut names = regular_containers;
    if let Some(init_containers) = spec.init_containers {
        names.extend(init_containers.into_iter().map(|item| item.name));
    }
    Ok(PodContainers {
        names,
        default_name,
    })
}

/// Stream logs from a Pod container.
pub async fn stream_pod_logs(
    client: kube::Client,
    options: LogStreamOptions,
) -> Result<
    (
        Vec<String>,
        tokio::sync::mpsc::Receiver<String>,
        tokio::task::AbortHandle,
    ),
    KubernetesError,
> {
    let api: Api<Pod> = Api::namespaced(client, &options.namespace);
    let snapshot_params = LogParams {
        follow: false,
        tail_lines: options.tail_lines,
        container: options.container.clone(),
        ..Default::default()
    };
    let snapshot = api
        .logs(&options.pod, &snapshot_params)
        .await
        .map_err(|error| KubernetesError::StreamLogsFailed(error.to_string()))?;
    let initial_lines = snapshot.lines().map(str::to_owned).collect();

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(256);
    let follow = options.follow;
    let pod = options.pod;
    let container = options.container;

    let task = tokio::spawn(async move {
        if !follow {
            return;
        }
        let follow_params = LogParams {
            follow: true,
            tail_lines: Some(0),
            container,
            ..Default::default()
        };
        let stream = match api.log_stream(&pod, &follow_params).await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = tx
                    .send(format!("ERROR: failed to start log stream: {}", error))
                    .await;
                return;
            }
        };
        let mut lines = stream.lines();
        while let Some(result) = lines.next().await {
            match result {
                Ok(line) => {
                    if tx.send(line).await.is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = tx
                        .send(format!("ERROR: log stream failed: {}", error))
                        .await;
                    return;
                }
            }
        }
    });

    Ok((initial_lines, rx, task.abort_handle()))
}

/// Simple cache that reuses Kubernetes clients and discovery by context name.
#[derive(Default)]
pub struct ClientCache {
    clients: Mutex<HashMap<String, kube::Client>>,
    context_kubeconfigs: Mutex<HashMap<String, PathBuf>>,
}

impl ClientCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&self) {
        self.clients.lock().unwrap().clear();
    }

    pub fn set_context_kubeconfigs<I>(&self, contexts: I)
    where
        I: IntoIterator<Item = (String, PathBuf)>,
    {
        let mut context_kubeconfigs = self.context_kubeconfigs.lock().unwrap();
        context_kubeconfigs.clear();
        context_kubeconfigs.extend(contexts);
        self.clients.lock().unwrap().clear();
    }

    /// Get or create a client for the given context.
    pub async fn client(&self, context: Option<String>) -> Result<kube::Client, KubernetesError> {
        let kubeconfig_path = context.as_ref().and_then(|context| {
            self.context_kubeconfigs
                .lock()
                .unwrap()
                .get(context)
                .cloned()
        });
        let context_key = context.clone().unwrap_or_default();
        let key = kubeconfig_path
            .as_ref()
            .map(|path| format!("{}@{}", context_key, path.display()))
            .unwrap_or_else(|| context_key.clone());
        {
            let clients = self.clients.lock().unwrap();
            if let Some(client) = clients.get(&key) {
                tracing::debug!(context = %context_key, cache_key = %key, "reusing cached kubernetes client");
                return Ok(client.clone());
            }
        }

        let client = create_client_from_kubeconfig(context, kubeconfig_path).await?;
        self.clients
            .lock()
            .unwrap()
            .insert(key.clone(), client.clone());
        tracing::debug!(context = %context_key, cache_key = %key, "created and cached kubernetes client");
        Ok(client)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubernetes_error_codes_are_stable() {
        assert_eq!(
            KubernetesError::ConfigFailed("x".into()).code(),
            "kubernetes_config_failed"
        );
        assert_eq!(
            KubernetesError::ClientFailed("x".into()).code(),
            "kubernetes_client_failed"
        );
        assert_eq!(
            KubernetesError::ListNamespacesFailed("x".into()).code(),
            "kubernetes_list_namespaces_failed"
        );
        assert_eq!(
            KubernetesError::DiscoveryFailed("x".into()).code(),
            "kubernetes_discovery_failed"
        );
        assert_eq!(
            KubernetesError::UnsupportedResourceKind { kind: "x".into() }.code(),
            "kubernetes_unsupported_resource_kind"
        );
        assert_eq!(
            KubernetesError::ListResourcesFailed("x".into()).code(),
            "kubernetes_list_resources_failed"
        );
        assert_eq!(
            KubernetesError::ListMetricsFailed("x".into()).code(),
            "kubernetes_list_metrics_failed"
        );
        assert_eq!(
            KubernetesError::GetResourceFailed("x".into()).code(),
            "kubernetes_get_resource_failed"
        );
        assert_eq!(
            KubernetesError::StreamLogsFailed("x".into()).code(),
            "kubernetes_stream_logs_failed"
        );
        assert_eq!(
            KubernetesError::ApplyResourceFailed("x".into()).code(),
            "kubernetes_apply_resource_failed"
        );
        assert_eq!(
            KubernetesError::DeleteResourceFailed("x".into()).code(),
            "kubernetes_delete_resource_failed"
        );
        assert_eq!(
            KubernetesError::ScaleWorkloadFailed("x".into()).code(),
            "kubernetes_scale_workload_failed"
        );
        assert_eq!(
            KubernetesError::RestartWorkloadFailed("x".into()).code(),
            "kubernetes_restart_workload_failed"
        );
        assert_eq!(
            KubernetesError::TriggerCronJobFailed("x".into()).code(),
            "kubernetes_trigger_cronjob_failed"
        );
        assert_eq!(
            KubernetesError::ExecPodFailed("x".into()).code(),
            "kubernetes_exec_pod_failed"
        );
    }

    #[test]
    fn metric_quantities_are_converted_to_display_units() {
        assert_eq!(cpu_millicores("250m"), Some(250));
        assert_eq!(cpu_millicores("125000000n"), Some(125));
        assert_eq!(cpu_millicores("0.5"), Some(500));
        assert_eq!(memory_bytes("64Mi"), Some(67_108_864));
        assert_eq!(memory_bytes("1Gi"), Some(1_073_741_824));
        assert_eq!(memory_bytes("4096"), Some(4096));
    }

    #[test]
    fn node_ready_condition_requires_true_status() {
        let ready: Node = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Node",
            "metadata": { "name": "worker-1" },
            "status": { "conditions": [{ "type": "Ready", "status": "True" }] }
        }))
        .unwrap();
        let not_ready: Node = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Node",
            "metadata": { "name": "worker-2" },
            "status": { "conditions": [{ "type": "Ready", "status": "False" }] }
        }))
        .unwrap();
        assert!(node_is_ready(&ready));
        assert!(!node_is_ready(&not_ready));
    }

    #[test]
    fn event_timestamp_falls_back_to_creation_time() {
        let event: Event = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Event",
            "metadata": {
                "name": "web-warning",
                "namespace": "default",
                "creationTimestamp": "2026-06-15T12:00:00Z"
            },
            "involvedObject": { "apiVersion": "v1", "kind": "Pod", "name": "web-0" }
        }))
        .unwrap();
        assert_eq!(
            event_timestamp(&event).as_deref(),
            Some("2026-06-15T12:00:00+00:00")
        );
    }

    #[test]
    fn watch_state_tracks_resource_version_and_resets_backoff_on_progress() {
        let mut state = ResourceWatchState::default();
        assert_eq!(state.resource_version, "0");
        assert_eq!(
            state.retry_after_error(false),
            std::time::Duration::from_secs(1)
        );
        assert_eq!(
            state.retry_after_error(false),
            std::time::Duration::from_secs(2)
        );

        state.observe_version(Some("42".into()));
        assert_eq!(state.resource_version, "42");
        assert_eq!(
            state.retry_after_error(false),
            std::time::Duration::from_secs(1)
        );
    }

    #[test]
    fn expired_watch_errors_reset_to_initial_resource_version() {
        let mut state = ResourceWatchState::default();
        state.observe_version(Some("99".into()));
        assert_eq!(
            state.retry_after_error(true),
            std::time::Duration::from_secs(1)
        );
        assert_eq!(state.resource_version, "0");
        assert!(is_expired_watch_error(Some(410), "Gone"));
        assert!(is_expired_watch_error(
            None,
            "too old resource version: 123"
        ));
    }

    #[test]
    fn watch_event_resource_version_reads_object_and_bookmark_versions() {
        let object: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "web", "resourceVersion": "7" }
        }))
        .unwrap();
        let bookmark: WatchEvent<DynamicObject> = serde_json::from_value(serde_json::json!({
            "type": "BOOKMARK",
            "object": {
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": { "resourceVersion": "8" }
            }
        }))
        .unwrap();
        assert_eq!(
            watch_event_resource_version(&WatchEvent::Modified(object)).as_deref(),
            Some("7")
        );
        assert_eq!(
            watch_event_resource_version(&bookmark).as_deref(),
            Some("8")
        );
    }

    #[test]
    fn sanitize_apply_object_removes_server_owned_fields() {
        let mut object: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": "db-secret",
                "namespace": "default",
                "uid": "uid-1",
                "resourceVersion": "42",
                "generation": 7,
                "creationTimestamp": "2026-06-15T12:00:00Z",
                "deletionTimestamp": "2026-06-16T12:00:00Z",
                "deletionGracePeriodSeconds": 30,
                "managedFields": [{ "manager": "kubectl" }],
                "selfLink": "/api/v1/namespaces/default/secrets/db-secret"
            },
            "data": { "username": "cm9vdA==" },
            "status": { "phase": "Active" }
        }))
        .unwrap();

        sanitize_apply_object(&mut object);

        assert!(object.metadata.managed_fields.is_none());
        assert!(object.metadata.resource_version.is_none());
        assert!(object.metadata.uid.is_none());
        assert!(object.metadata.generation.is_none());
        assert!(object.metadata.creation_timestamp.is_none());
        assert!(object.metadata.deletion_timestamp.is_none());
        assert!(object.metadata.deletion_grace_period_seconds.is_none());
        assert!(object.metadata.self_link.is_none());
        assert!(object.data.get("status").is_none());
        assert_eq!(
            object
                .data
                .pointer("/data/username")
                .and_then(|value| value.as_str()),
            Some("cm9vdA==")
        );
    }

    #[test]
    fn namespace_summary_serializes_camel_case() {
        let summary = NamespaceSummary {
            name: "default".into(),
            status: Some("Active".into()),
        };
        let json = k8s_openapi::serde_json::to_value(summary).unwrap();
        assert_eq!(json["name"], "default");
        assert_eq!(json["status"], "Active");
    }

    #[test]
    fn resource_summary_serializes_camel_case() {
        let summary = ResourceSummary {
            kind: "Pod".into(),
            api_version: "v1".into(),
            name: "nginx".into(),
            namespace: Some("default".into()),
            uid: Some("uid-1".into()),
            created: Some("2024-01-01T00:00:00Z".into()),
            owner_references: Vec::new(),
            columns: BTreeMap::from([("status".into(), "Running".into())]),
            pod_containers: None,
        };
        let json = k8s_openapi::serde_json::to_value(summary).unwrap();
        assert_eq!(json["apiVersion"], "v1");
        assert_eq!(json["columns"]["status"], "Running");
        assert_eq!(json["namespace"], "default");
        assert!(json.get("podContainers").is_none());
    }

    #[test]
    fn extended_resource_kinds_have_expected_scope() {
        for kind in [
            "StatefulSet",
            "DaemonSet",
            "Job",
            "CronJob",
            "Ingress",
            "ConfigMap",
            "Secret",
            "PersistentVolumeClaim",
            "PersistentVolume",
        ] {
            assert!(gvk_for_kind(kind).is_some(), "missing GVK for {kind}");
        }
        assert_eq!(
            gvk_for_resource("Widget", "example.freelens.dev/v1alpha1"),
            Some(GroupVersionKind::gvk(
                "example.freelens.dev",
                "v1alpha1",
                "Widget"
            ))
        );
        assert!(is_builtin_resource("Pod", "v1"));
        assert!(!is_builtin_resource("Pod", "example.freelens.dev/v1"));
    }

    #[test]
    fn secret_columns_only_expose_metadata() {
        let secret = serde_json::json!({
            "type": "Opaque",
            "data": {"username": "dXNlcg==", "password": "c2VjcmV0"}
        });
        let columns = resource_columns("Secret", &secret);
        assert_eq!(columns.get("type").map(String::as_str), Some("Opaque"));
        assert_eq!(columns.get("data").map(String::as_str), Some("2"));
        assert!(!columns.values().any(|value| value.contains("c2VjcmV0")));
    }

    #[test]
    fn node_columns_match_kubectl_wide_fields() {
        let node = serde_json::json!({
            "metadata": { "labels": { "node-role.kubernetes.io/control-plane": "" } },
            "spec": { "unschedulable": false },
            "status": {
                "conditions": [{ "type": "Ready", "status": "True" }],
                "addresses": [
                    { "type": "InternalIP", "address": "10.6.178.178" }
                ],
                "nodeInfo": {
                    "kubeletVersion": "v1.30.14",
                    "osImage": "Ubuntu 22.04.5 LTS",
                    "kernelVersion": "5.15.0-168-generic",
                    "containerRuntimeVersion": "docker://28.3.3"
                }
            }
        });
        let columns = resource_columns("Node", &node);
        assert_eq!(columns["status"], "Ready");
        assert_eq!(columns["roles"], "control-plane");
        assert_eq!(columns["version"], "v1.30.14");
        assert_eq!(columns["internalIP"], "10.6.178.178");
        assert_eq!(columns["externalIP"], "<none>");
        assert_eq!(columns["osImage"], "Ubuntu 22.04.5 LTS");
        assert_eq!(columns["kernelVersion"], "5.15.0-168-generic");
        assert_eq!(columns["containerRuntime"], "docker://28.3.3");
    }

    #[test]
    fn pod_status_matches_freelens_status_message_priority() {
        let evicted = serde_json::json!({
            "metadata": {},
            "status": {
                "phase": "Failed",
                "reason": "Evicted",
                "containerStatuses": []
            }
        });
        let terminating = serde_json::json!({
            "metadata": { "deletionTimestamp": "2026-06-18T10:00:00Z" },
            "status": {
                "phase": "Running",
                "containerStatuses": [{
                    "ready": true,
                    "restartCount": 0,
                    "state": { "running": { "startedAt": "2026-06-18T09:00:00Z" } }
                }]
            }
        });
        let finalizing = serde_json::json!({
            "metadata": {
                "deletionTimestamp": "2026-06-18T10:00:00Z",
                "finalizers": ["example.com/finalizer"]
            },
            "status": {
                "phase": "Running",
                "containerStatuses": []
            }
        });
        let waiting = serde_json::json!({
            "metadata": {},
            "status": {}
        });

        assert_eq!(resource_columns("Pod", &evicted)["status"], "Evicted");
        assert_eq!(
            resource_columns("Pod", &terminating)["status"],
            "Terminating"
        );
        assert_eq!(resource_columns("Pod", &finalizing)["status"], "Finalizing");
        assert_eq!(resource_columns("Pod", &waiting)["status"], "Waiting");
    }

    #[test]
    fn pod_container_summaries_include_all_container_types_in_freelens_order() {
        let pod = serde_json::json!({
            "spec": {
                "containers": [{ "name": "app" }],
                "initContainers": [{ "name": "setup" }],
                "ephemeralContainers": [{ "name": "debug" }]
            },
            "status": {
                "containerStatuses": [{
                    "name": "app",
                    "ready": true,
                    "restartCount": 2,
                    "state": { "running": { "startedAt": "2026-06-18T09:00:00Z" } },
                    "lastState": {}
                }],
                "initContainerStatuses": [{
                    "name": "setup",
                    "ready": false,
                    "restartCount": 0,
                    "state": { "terminated": { "reason": "Completed", "exitCode": 0 } },
                    "lastState": {}
                }],
                "ephemeralContainerStatuses": [{
                    "name": "debug",
                    "ready": false,
                    "restartCount": 0,
                    "state": { "running": { "startedAt": "2026-06-18T10:00:00Z" } },
                    "lastState": { "terminated": { "reason": "Completed", "exitCode": 0 } }
                }]
            }
        });

        let containers = pod_container_summaries(&pod);
        assert_eq!(containers.len(), 3);
        assert_eq!(containers[0].name, "app");
        assert_eq!(containers[0].type_, "containers");
        assert!(containers[0].ready);
        assert_eq!(containers[0].restart_count, 2);
        assert!(containers[0].state.contains_key("running"));
        assert_eq!(containers[1].name, "setup");
        assert_eq!(containers[1].type_, "initContainers");
        assert!(containers[1].state.contains_key("terminated"));
        assert_eq!(containers[2].name, "debug");
        assert_eq!(containers[2].type_, "ephemeralContainers");
        assert!(containers[2].last_state.contains_key("terminated"));
    }

    #[test]
    fn discovered_resources_are_deduplicated_by_gvk() {
        let resource = ResourceKind {
            group: "mysql.presslabs.org".into(),
            version: "v1alpha1".into(),
            kind: "MysqlCluster".into(),
            plural: "mysqlclusters".into(),
            scope: ResourceScope::Namespaced,
            namespaced: true,
            columns: Vec::new(),
        };
        let mut kinds = Vec::new();
        push_resource_kind(&mut kinds, resource.clone());
        push_resource_kind(&mut kinds, resource);
        assert_eq!(kinds.len(), 1);
    }

    #[test]
    fn custom_resource_columns_follow_printer_jsonpaths() {
        let resource = serde_json::json!({
            "spec": {"replicas": 2},
            "status": {"conditions": [
                {"type": "Ready", "status": "True"},
                {"type": "Synced", "status": "True"}
            ]}
        });
        let columns = custom_resource_columns(
            &resource,
            &[
                ResourceColumn {
                    name: "READY".into(),
                    json_path: ".status.conditions[?(@.type == 'Ready')].status".into(),
                    priority: 0,
                },
                ResourceColumn {
                    name: "REPLICAS".into(),
                    json_path: ".spec.replicas".into(),
                    priority: 0,
                },
                ResourceColumn {
                    name: "DETAIL".into(),
                    json_path: ".status.detail".into(),
                    priority: 1,
                },
            ],
        );
        assert_eq!(columns.get("READY").map(String::as_str), Some("True"));
        assert_eq!(columns.get("REPLICAS").map(String::as_str), Some("2"));
        assert!(!columns.contains_key("DETAIL"));
        assert!(is_standard_resource_column("Age"));
        assert!(!is_standard_resource_column("Ready"));
    }

    #[test]
    fn create_yaml_identity_is_parsed() {
        let parsed = parse_resource_yaml(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n  namespace: default\n",
        )
        .unwrap();
        assert_eq!(parsed.api_version, "v1");
        assert_eq!(parsed.kind, "ConfigMap");
        assert_eq!(parsed.name, "demo");
        assert_eq!(parsed.namespace.as_deref(), Some("default"));
    }

    #[test]
    fn create_yaml_requires_name() {
        let error =
            parse_resource_yaml("apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n").unwrap_err();
        assert!(error.to_string().contains("metadata.name is required"));
    }
}

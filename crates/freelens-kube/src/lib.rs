use futures::{AsyncBufReadExt, StreamExt};
use jsonpath_rust::JsonPath;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Event, Namespace, Pod, Service};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::ResourceExt;
use kube::api::{
    Api, AttachParams, DeleteParams, DynamicObject, ListParams, LogParams, Patch, PatchParams,
    WatchEvent, WatchParams,
};
use kube::config::KubeConfigOptions;
use kube::core::{GroupVersion, GroupVersionKind};
use kube::discovery::{pinned_group, verbs};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
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
    #[error("failed to get resource: {0}")]
    GetResourceFailed(String),
    #[error("failed to stream pod logs: {0}")]
    StreamLogsFailed(String),
    #[error("failed to apply resource: {0}")]
    ApplyResourceFailed(String),
    #[error("failed to delete resource: {0}")]
    DeleteResourceFailed(String),
    #[error("failed to scale deployment: {0}")]
    ScaleDeploymentFailed(String),
    #[error("failed to execute pod command: {0}")]
    ExecPodFailed(String),
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
            KubernetesError::GetResourceFailed(..) => "kubernetes_get_resource_failed",
            KubernetesError::StreamLogsFailed(..) => "kubernetes_stream_logs_failed",
            KubernetesError::ApplyResourceFailed(..) => "kubernetes_apply_resource_failed",
            KubernetesError::DeleteResourceFailed(..) => "kubernetes_delete_resource_failed",
            KubernetesError::ScaleDeploymentFailed(..) => "kubernetes_scale_deployment_failed",
            KubernetesError::ExecPodFailed(..) => "kubernetes_exec_pod_failed",
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
    pub columns: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceList {
    pub kind: String,
    pub items: Vec<ResourceSummary>,
    pub continue_token: Option<String>,
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
pub struct ResourceDetail {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub sections: Vec<DetailSection>,
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
pub enum ResourceWatchNotification {
    Changed,
    Error(String),
}

fn field(label: &str, value: impl ToString) -> DetailField {
    DetailField {
        label: label.into(),
        value: value.to_string(),
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
            columns.insert("status".into(), json_string(data, &["status", "phase"]));
            columns.insert("ready".into(), format!("{ready}/{total}"));
            columns.insert("restarts".into(), restarts.to_string());
            columns.insert("node".into(), json_string(data, &["spec", "nodeName"]));
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
    let options = KubeConfigOptions {
        context,
        ..Default::default()
    };
    let config = kube::Config::from_kubeconfig(&options)
        .await
        .map_err(|error| KubernetesError::ConfigFailed(error.to_string()))?;
    kube::Client::try_from(config).map_err(|error| KubernetesError::ClientFailed(error.to_string()))
}

/// List namespaces in the cluster connected by `client`.
pub async fn list_namespaces(
    client: kube::Client,
) -> Result<Vec<NamespaceSummary>, KubernetesError> {
    let api: Api<Namespace> = Api::all(client);
    let namespaces = api
        .list(&ListParams::default())
        .await
        .map_err(|error| KubernetesError::ListNamespacesFailed(error.to_string()))?;

    Ok(namespaces
        .into_iter()
        .map(|ns| NamespaceSummary {
            name: ns.name_any(),
            status: ns.status.and_then(|s| s.phase),
        })
        .collect())
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
                columns,
            }
        })
        .collect();

    Ok(ResourceList {
        kind: kind.into(),
        items,
        continue_token,
    })
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
    let api: Api<DynamicObject> =
        match namespace.filter(|_| caps.scope == kube::discovery::Scope::Namespaced) {
            Some(ns) => Api::namespaced_with(client, ns, &ar),
            None => Api::all_with(client, &ar),
        };

    let obj = api
        .get(name)
        .await
        .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;

    serde_yaml_ng::to_string(&obj)
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
                let params = ListParams::default().fields(&format!("involvedObject.uid={uid}"));
                let listed = Api::<Event>::namespaced(client, namespace)
                    .list(&params)
                    .await
                    .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
                events = listed
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
            }
        }
        "Deployment" if is_builtin_resource(kind, api_version) => {
            let namespace = namespace.ok_or_else(|| {
                KubernetesError::GetResourceFailed("Deployment namespace is required".into())
            })?;
            let deployment: Deployment = Api::namespaced(client, namespace)
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
        }
        "Service" if is_builtin_resource(kind, api_version) => {
            let namespace = namespace.ok_or_else(|| {
                KubernetesError::GetResourceFailed("Service namespace is required".into())
            })?;
            let service: Service = Api::namespaced(client, namespace)
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
        }
        _ => {
            let gvk = gvk_for_resource(kind, api_version)
                .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;
            let (ar, caps) = kube::discovery::pinned_kind(&client, &gvk)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let api: Api<DynamicObject> =
                match namespace.filter(|_| caps.scope == kube::discovery::Scope::Namespaced) {
                    Some(namespace) => Api::namespaced_with(client, namespace, &ar),
                    None => Api::all_with(client, &ar),
                };
            let object = api
                .get(name)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let data = object.data;
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
            let labels = object.metadata.labels.unwrap_or_default();
            if !labels.is_empty() {
                sections.push(DetailSection {
                    title: "Labels".into(),
                    fields: labels
                        .into_iter()
                        .map(|(label, value)| field(&label, value))
                        .collect(),
                });
            }
        }
    }

    Ok(ResourceDetail {
        kind: kind.into(),
        name: name.into(),
        namespace: namespace.map(str::to_owned),
        sections,
        containers,
        events,
        yaml,
    })
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
        loop {
            let params = WatchParams::default().timeout(30);
            match api.watch(&params, "0").await {
                Ok(stream) => {
                    futures::pin_mut!(stream);
                    while let Some(event) = stream.next().await {
                        match event {
                            Ok(
                                WatchEvent::Added(_)
                                | WatchEvent::Modified(_)
                                | WatchEvent::Deleted(_),
                            ) => {
                                if tx.send(ResourceWatchNotification::Changed).await.is_err() {
                                    return;
                                }
                            }
                            Ok(WatchEvent::Error(error)) => {
                                let _ = tx
                                    .send(ResourceWatchNotification::Error(error.message))
                                    .await;
                                break;
                            }
                            Ok(WatchEvent::Bookmark(_)) => {}
                            Err(error) => {
                                let _ = tx
                                    .send(ResourceWatchNotification::Error(error.to_string()))
                                    .await;
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
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
    Ok((rx, task.abort_handle()))
}

/// Apply edited YAML to the same resource using server-side apply.
pub async fn apply_resource_yaml(
    client: kube::Client,
    expected_kind: &str,
    expected_api_version: &str,
    expected_namespace: Option<&str>,
    expected_name: &str,
    yaml: &str,
) -> Result<String, KubernetesError> {
    let object: DynamicObject = serde_yaml_ng::from_str(yaml)
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
    let applied = api
        .patch(
            expected_name,
            &PatchParams::apply("freelens-rust"),
            &Patch::Apply(&object),
        )
        .await
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))?;
    serde_yaml_ng::to_string(&applied)
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))
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

/// Update the desired replica count of a Deployment.
pub async fn scale_deployment(
    client: kube::Client,
    namespace: &str,
    name: &str,
    replicas: i32,
) -> Result<(), KubernetesError> {
    if replicas < 0 {
        return Err(KubernetesError::ScaleDeploymentFailed(
            "replicas cannot be negative".into(),
        ));
    }
    let api: Api<Deployment> = Api::namespaced(client, namespace);
    api.patch(
        name,
        &PatchParams::default(),
        &Patch::Merge(serde_json::json!({ "spec": { "replicas": replicas } })),
    )
    .await
    .map_err(|error| KubernetesError::ScaleDeploymentFailed(error.to_string()))?;
    Ok(())
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
}

impl ClientCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get or create a client for the given context.
    pub async fn client(&self, context: Option<String>) -> Result<kube::Client, KubernetesError> {
        let key = context.clone().unwrap_or_default();
        {
            let clients = self.clients.lock().unwrap();
            if let Some(client) = clients.get(&key) {
                tracing::debug!(context = %key, "reusing cached kubernetes client");
                return Ok(client.clone());
            }
        }

        let client = create_client(context).await?;
        self.clients
            .lock()
            .unwrap()
            .insert(key.clone(), client.clone());
        tracing::debug!(context = %key, "created and cached kubernetes client");
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
            KubernetesError::ScaleDeploymentFailed("x".into()).code(),
            "kubernetes_scale_deployment_failed"
        );
        assert_eq!(
            KubernetesError::ExecPodFailed("x".into()).code(),
            "kubernetes_exec_pod_failed"
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
            columns: BTreeMap::from([("status".into(), "Running".into())]),
        };
        let json = k8s_openapi::serde_json::to_value(summary).unwrap();
        assert_eq!(json["apiVersion"], "v1");
        assert_eq!(json["columns"]["status"], "Running");
        assert_eq!(json["namespace"], "default");
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

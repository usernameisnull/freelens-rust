use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Event, Namespace, Pod, Service};
use kube::ResourceExt;
use kube::api::{
    Api, AttachParams, DeleteParams, DynamicObject, ListParams, LogParams, Patch, PatchParams,
    WatchEvent, WatchParams,
};
use kube::config::KubeConfigOptions;
use kube::core::GroupVersionKind;
use kube::discovery::{Discovery, verbs};
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

fn is_namespaced_kind(kind: &str) -> bool {
    kind != "PersistentVolume"
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
    let discovery = Discovery::new(client.clone())
        .run()
        .await
        .map_err(|error| KubernetesError::DiscoveryFailed(error.to_string()))?;

    let mut kinds = Vec::new();
    for group in discovery.groups() {
        let group_name = group.name().to_string();
        for (ar, caps) in group.recommended_resources() {
            if !caps.supports_operation(verbs::LIST) {
                continue;
            }
            let scope = if caps.scope == kube::discovery::Scope::Namespaced {
                ResourceScope::Namespaced
            } else {
                ResourceScope::Cluster
            };
            kinds.push(ResourceKind {
                group: group_name.clone(),
                version: ar.version.clone(),
                kind: ar.kind.clone(),
                plural: ar.plural.clone(),
                scope,
                namespaced: caps.scope == kube::discovery::Scope::Namespaced,
            });
        }
    }

    Ok(kinds)
}

/// List resources of a given kind.
pub async fn list_resources(
    client: kube::Client,
    kind: &str,
    namespace: Option<&str>,
    limit: Option<u32>,
    continue_token: Option<&str>,
) -> Result<ResourceList, KubernetesError> {
    let gvk = gvk_for_kind(kind)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;

    let (ar, _caps) = kube::discovery::pinned_kind(&client, &gvk)
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

    let api: Api<DynamicObject> = match namespace.filter(|_| is_namespaced_kind(kind)) {
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
            let columns = resource_columns(&item_kind, &obj.data);
            ResourceSummary {
                kind: item_kind,
                api_version: obj
                    .types
                    .as_ref()
                    .map(|t| t.api_version.clone())
                    .unwrap_or_default(),
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
    namespace: Option<&str>,
    name: &str,
) -> Result<String, KubernetesError> {
    if is_namespaced_kind(kind) && namespace.is_none() {
        return Err(KubernetesError::GetResourceFailed(format!(
            "{kind} namespace is required"
        )));
    }
    let gvk = gvk_for_kind(kind)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;

    let (ar, _caps) = kube::discovery::pinned_kind(&client, &gvk)
        .await
        .map_err(|error| KubernetesError::UnsupportedResourceKind {
            kind: format!("{}: {}", kind, error),
        })?;

    let api: Api<DynamicObject> = match namespace.filter(|_| is_namespaced_kind(kind)) {
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
    namespace: Option<&str>,
    name: &str,
) -> Result<ResourceDetail, KubernetesError> {
    let yaml = get_resource_yaml(client.clone(), kind, namespace, name).await?;
    let mut sections = Vec::new();
    let mut containers = Vec::new();
    let mut events = Vec::new();

    match kind {
        "Pod" => {
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
        "Deployment" => {
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
        "Service" => {
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
            let gvk = gvk_for_kind(kind)
                .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;
            let (ar, _) = kube::discovery::pinned_kind(&client, &gvk)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let api: Api<DynamicObject> = match namespace.filter(|_| is_namespaced_kind(kind)) {
                Some(namespace) => Api::namespaced_with(client, namespace, &ar),
                None => Api::all_with(client, &ar),
            };
            let object = api
                .get(name)
                .await
                .map_err(|error| KubernetesError::GetResourceFailed(error.to_string()))?;
            let data = object.data;
            let columns = resource_columns(kind, &data);
            sections.push(DetailSection {
                title: "Overview".into(),
                fields: columns
                    .into_iter()
                    .map(|(label, value)| field(&label, value))
                    .collect(),
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
    namespace: Option<&str>,
) -> Result<Api<DynamicObject>, KubernetesError> {
    let gvk = gvk_for_kind(kind)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;
    let (ar, _) = kube::discovery::pinned_kind(&client, &gvk)
        .await
        .map_err(|error| KubernetesError::UnsupportedResourceKind {
            kind: format!("{}: {}", kind, error),
        })?;
    Ok(match namespace.filter(|_| is_namespaced_kind(kind)) {
        Some(namespace) => Api::namespaced_with(client, namespace, &ar),
        None => Api::all_with(client, &ar),
    })
}

/// Watch a supported resource collection and reconnect after transient failures.
pub async fn watch_resources(
    client: kube::Client,
    kind: &str,
    namespace: Option<&str>,
) -> Result<
    (
        tokio::sync::mpsc::Receiver<ResourceWatchNotification>,
        tokio::task::AbortHandle,
    ),
    KubernetesError,
> {
    let gvk = gvk_for_kind(kind)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;
    let (ar, _) = kube::discovery::pinned_kind(&client, &gvk)
        .await
        .map_err(|error| KubernetesError::UnsupportedResourceKind {
            kind: format!("{}: {}", kind, error),
        })?;
    let api: Api<DynamicObject> = match namespace.filter(|_| is_namespaced_kind(kind)) {
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
    expected_namespace: Option<&str>,
    expected_name: &str,
    yaml: &str,
) -> Result<String, KubernetesError> {
    if is_namespaced_kind(expected_kind) && expected_namespace.is_none() {
        return Err(KubernetesError::ApplyResourceFailed(format!(
            "{expected_kind} namespace is required"
        )));
    }
    let object: DynamicObject = serde_yaml_ng::from_str(yaml)
        .map_err(|error| KubernetesError::ApplyResourceFailed(error.to_string()))?;
    let actual_kind = object
        .types
        .as_ref()
        .map(|types| types.kind.as_str())
        .unwrap_or_default();
    let actual_name = object.name_any();
    let actual_namespace = object.namespace();
    if actual_kind != expected_kind
        || actual_name != expected_name
        || actual_namespace.as_deref() != expected_namespace
    {
        return Err(KubernetesError::ApplyResourceFailed(format!(
            "YAML identity {actual_kind} {}/{actual_name} does not match {expected_kind} {}/{}",
            actual_namespace.as_deref().unwrap_or("<cluster>"),
            expected_namespace.unwrap_or("<cluster>"),
            expected_name,
        )));
    }
    let api = dynamic_api(client, expected_kind, expected_namespace).await?;
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

/// Delete a supported namespaced resource.
pub async fn delete_resource(
    client: kube::Client,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<(), KubernetesError> {
    if is_namespaced_kind(kind) && namespace.is_none() {
        return Err(KubernetesError::DeleteResourceFailed(format!(
            "{kind} namespace is required"
        )));
    }
    dynamic_api(client, kind, namespace)
        .await?
        .delete(name, &DeleteParams::default())
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
        assert!(!is_namespaced_kind("PersistentVolume"));
        assert!(is_namespaced_kind("PersistentVolumeClaim"));
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
}

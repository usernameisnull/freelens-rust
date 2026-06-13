use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Event, Namespace, Pod, Service};
use kube::ResourceExt;
use kube::api::{Api, DynamicObject, ListParams, LogParams};
use kube::config::KubeConfigOptions;
use kube::core::GroupVersionKind;
use kube::discovery::{Discovery, verbs};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

fn gvk_for_kind(kind: &str) -> Option<GroupVersionKind> {
    match kind {
        "Pod" => Some(GroupVersionKind::gvk("", "v1", "Pod")),
        "Deployment" => Some(GroupVersionKind::gvk("apps", "v1", "Deployment")),
        "Service" => Some(GroupVersionKind::gvk("", "v1", "Service")),
        _ => None,
    }
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

    let api: Api<DynamicObject> = match namespace {
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
        .map(|obj| ResourceSummary {
            kind: obj
                .types
                .as_ref()
                .map(|t| t.kind.clone())
                .unwrap_or_else(|| kind.into()),
            api_version: obj
                .types
                .as_ref()
                .map(|t| t.api_version.clone())
                .unwrap_or_default(),
            name: obj.name_any(),
            namespace: obj.namespace(),
            uid: obj.uid(),
            created: obj.creation_timestamp().map(|t| t.0.to_rfc3339()),
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
    let gvk = gvk_for_kind(kind)
        .ok_or_else(|| KubernetesError::UnsupportedResourceKind { kind: kind.into() })?;

    let (ar, _caps) = kube::discovery::pinned_kind(&client, &gvk)
        .await
        .map_err(|error| KubernetesError::UnsupportedResourceKind {
            kind: format!("{}: {}", kind, error),
        })?;

    let api: Api<DynamicObject> = match namespace {
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
    namespace: &str,
    name: &str,
) -> Result<ResourceDetail, KubernetesError> {
    let yaml = get_resource_yaml(client.clone(), kind, Some(namespace), name).await?;
    let mut sections = Vec::new();
    let mut containers = Vec::new();
    let mut events = Vec::new();

    match kind {
        "Pod" => {
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
        _ => return Err(KubernetesError::UnsupportedResourceKind { kind: kind.into() }),
    }

    Ok(ResourceDetail {
        kind: kind.into(),
        name: name.into(),
        namespace: Some(namespace.into()),
        sections,
        containers,
        events,
        yaml,
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
        };
        let json = k8s_openapi::serde_json::to_value(summary).unwrap();
        assert_eq!(json["apiVersion"], "v1");
        assert_eq!(json["namespace"], "default");
    }
}

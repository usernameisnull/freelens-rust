#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use freelens_ipc::{
    ContainerDetailItem, DetailFieldItem, DetailSectionItem, EventDetailItem, HealthCheckRequest,
    HealthCheckResponse, HealthStatus, IPC_VERSION, IpcError, KubeconfigListRequest,
    KubeconfigListResponse, KubernetesApplyResourceRequest, KubernetesApplyResourceResponse,
    KubernetesCreateResourceRequest, KubernetesCreateResourceResponse,
    KubernetesDeleteResourceRequest, KubernetesDiscoverResourcesRequest,
    KubernetesDiscoverResourcesResponse, KubernetesExecPodRequest, KubernetesExecPodResponse,
    KubernetesGetPodContainersRequest, KubernetesGetPodContainersResponse,
    KubernetesGetResourceDetailRequest, KubernetesGetResourceDetailResponse,
    KubernetesGetResourceYamlRequest, KubernetesGetResourceYamlResponse,
    KubernetesListNamespacesRequest, KubernetesListNamespacesResponse,
    KubernetesListResourcesRequest, KubernetesListResourcesResponse,
    KubernetesResizePodTerminalRequest, KubernetesScaleDeploymentRequest,
    KubernetesStartPodPortForwardRequest, KubernetesStartPodPortForwardResponse,
    KubernetesStartPodTerminalRequest, KubernetesStartPodTerminalResponse,
    KubernetesStartResourceWatchRequest, KubernetesStopPodLogsRequest,
    KubernetesStopPodPortForwardRequest, KubernetesStopPodTerminalRequest,
    KubernetesStopResourceWatchRequest, KubernetesStreamPodLogsRequest,
    KubernetesStreamPodLogsResponse, KubernetesTerminalInputRequest,
    KubernetesTerminalInputResponse, KubernetesVersionRequest, KubernetesVersionResponse,
    NamespaceItem, ResourceItem, ResourceKindItem, SystemInfoResponse,
};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, path::BaseDirectory};

fn validate_ipc_version(version: u16) -> Result<(), IpcError> {
    if version == IPC_VERSION {
        Ok(())
    } else {
        Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!("IPC version {version} is not supported; expected {IPC_VERSION}"),
        })
    }
}

#[tauri::command]
fn health_check(request: HealthCheckRequest) -> Result<HealthCheckResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    Ok(HealthCheckResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        status: HealthStatus::Ok,
        service: "freelens-app".into(),
    })
}

#[tauri::command]
fn system_info(app: tauri::AppHandle) -> Result<SystemInfoResponse, IpcError> {
    let app_data_dir = app.path().app_data_dir().map_err(path_error)?;
    let log_dir = app
        .path()
        .resolve("logs", BaseDirectory::AppData)
        .map_err(path_error)?;

    Ok(SystemInfoResponse {
        version: IPC_VERSION,
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        app_data_dir: app_data_dir.display().to_string(),
        log_dir: log_dir.display().to_string(),
    })
}

fn path_error(error: tauri::Error) -> IpcError {
    IpcError {
        code: "path_discovery_failed".into(),
        message: error.to_string(),
    }
}

#[tauri::command]
fn kubeconfig_list(request: KubeconfigListRequest) -> Result<KubeconfigListResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    let summary = freelens_kubeconfig::list_contexts(None).map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })?;

    Ok(KubeconfigListResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        current_context: summary.current_context,
        contexts: summary
            .contexts
            .into_iter()
            .map(|ctx| freelens_ipc::KubeconfigContext {
                name: ctx.name,
                cluster: ctx.cluster,
                user: ctx.user,
                is_current: ctx.is_current,
            })
            .collect(),
    })
}

#[tauri::command]
async fn kubernetes_version(
    request: KubernetesVersionRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesVersionResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    let client = cache
        .client(request.context)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    let version = client.apiserver_version().await.map_err(|error| IpcError {
        code: "kubernetes_version_failed".into(),
        message: error.to_string(),
    })?;

    Ok(KubernetesVersionResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        major: version.major,
        minor: version.minor,
        git_version: version.git_version,
    })
}

#[tauri::command]
async fn kubernetes_list_namespaces(
    request: KubernetesListNamespacesRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesListNamespacesResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    let namespaces = freelens_kube::list_namespaces(client)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    Ok(KubernetesListNamespacesResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        namespaces: namespaces
            .into_iter()
            .map(|ns| NamespaceItem {
                name: ns.name,
                status: ns.status,
            })
            .collect(),
    })
}

#[tauri::command]
async fn kubernetes_discover_resources(
    request: KubernetesDiscoverResourcesRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesDiscoverResourcesResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    let kinds = freelens_kube::discover_resources(client)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    Ok(KubernetesDiscoverResourcesResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        kinds: kinds
            .into_iter()
            .map(|k| ResourceKindItem {
                group: k.group,
                version: k.version,
                kind: k.kind,
                plural: k.plural,
                scope: match k.scope {
                    freelens_kube::ResourceScope::Namespaced => "Namespaced".into(),
                    freelens_kube::ResourceScope::Cluster => "Cluster".into(),
                },
                namespaced: k.namespaced,
                columns: k
                    .columns
                    .into_iter()
                    .map(|column| freelens_ipc::ResourceColumnItem {
                        name: column.name,
                        json_path: column.json_path,
                        priority: column.priority,
                    })
                    .collect(),
            })
            .collect(),
    })
}

#[tauri::command]
async fn kubernetes_list_resources(
    request: KubernetesListResourcesRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesListResourcesResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    let columns = request
        .columns
        .iter()
        .map(|column| freelens_kube::ResourceColumn {
            name: column.name.clone(),
            json_path: column.json_path.clone(),
            priority: column.priority,
        })
        .collect::<Vec<_>>();
    let list = freelens_kube::list_resources(
        client,
        &request.kind,
        &request.api_version,
        &columns,
        request.namespace.as_deref(),
        request.limit,
        request.continue_token.as_deref(),
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })?;

    Ok(KubernetesListResourcesResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        kind: list.kind,
        items: list
            .items
            .into_iter()
            .map(|item| ResourceItem {
                kind: item.kind,
                api_version: item.api_version,
                name: item.name,
                namespace: item.namespace,
                uid: item.uid,
                created: item.created,
                columns: item.columns,
            })
            .collect(),
        continue_token: list.continue_token,
    })
}

#[tauri::command]
async fn kubernetes_get_resource_yaml(
    request: KubernetesGetResourceYamlRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesGetResourceYamlResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    let yaml = freelens_kube::get_resource_yaml(
        client,
        &request.kind,
        &request.api_version,
        request.namespace.as_deref(),
        &request.name,
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })?;

    Ok(KubernetesGetResourceYamlResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        kind: request.kind,
        name: request.name,
        yaml,
    })
}

#[tauri::command]
async fn kubernetes_get_resource_detail(
    request: KubernetesGetResourceDetailRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesGetResourceDetailResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }
    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let detail = freelens_kube::get_resource_detail(
        client,
        &request.kind,
        &request.api_version,
        request.namespace.as_deref(),
        &request.name,
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })?;

    Ok(KubernetesGetResourceDetailResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        kind: detail.kind,
        api_version: request.api_version,
        name: detail.name,
        namespace: detail.namespace,
        sections: detail
            .sections
            .into_iter()
            .map(|section| DetailSectionItem {
                title: section.title,
                fields: section
                    .fields
                    .into_iter()
                    .map(|item| DetailFieldItem {
                        label: item.label,
                        value: item.value,
                    })
                    .collect(),
            })
            .collect(),
        containers: detail
            .containers
            .into_iter()
            .map(|item| ContainerDetailItem {
                name: item.name,
                image: item.image,
                ready: item.ready,
                restarts: item.restarts,
                state: item.state,
            })
            .collect(),
        events: detail
            .events
            .into_iter()
            .map(|item| EventDetailItem {
                event_type: item.event_type,
                reason: item.reason,
                message: item.message,
                count: item.count,
                timestamp: item.timestamp,
            })
            .collect(),
        yaml: detail.yaml,
    })
}

#[tauri::command]
async fn kubernetes_apply_resource(
    request: KubernetesApplyResourceRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesApplyResourceResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let yaml = freelens_kube::apply_resource_yaml(
        client,
        &request.kind,
        &request.api_version,
        request.namespace.as_deref(),
        &request.name,
        &request.yaml,
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })?;
    Ok(KubernetesApplyResourceResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        yaml,
    })
}

#[tauri::command]
async fn kubernetes_create_resource(
    request: KubernetesCreateResourceRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesCreateResourceResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let applied = freelens_kube::create_resource_yaml(client, &request.yaml)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    Ok(KubernetesCreateResourceResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        kind: applied.kind,
        api_version: applied.api_version,
        name: applied.name,
        namespace: applied.namespace,
        yaml: applied.yaml,
    })
}

#[tauri::command]
async fn kubernetes_delete_resource(
    request: KubernetesDeleteResourceRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    freelens_kube::delete_resource(
        client,
        &request.kind,
        &request.api_version,
        request.namespace.as_deref(),
        &request.name,
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })
}

#[tauri::command]
async fn kubernetes_scale_deployment(
    request: KubernetesScaleDeploymentRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    freelens_kube::scale_deployment(client, &request.namespace, &request.name, request.replicas)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })
}

#[tauri::command]
async fn kubernetes_exec_pod(
    request: KubernetesExecPodRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesExecPodResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let result = freelens_kube::exec_pod_command(
        client,
        &request.namespace,
        &request.pod,
        &request.container,
        &request.command,
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })?;
    Ok(KubernetesExecPodResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.success,
        status: result.status,
    })
}

#[tauri::command]
async fn kubernetes_get_pod_containers(
    request: KubernetesGetPodContainersRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesGetPodContainersResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let containers = freelens_kube::get_pod_containers(client, &request.namespace, &request.pod)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    Ok(KubernetesGetPodContainersResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        namespace: request.namespace,
        pod: request.pod,
        containers: containers.names,
        default_container: containers.default_name,
    })
}

#[derive(Default, Clone)]
struct LogStreamManager {
    streams: std::sync::Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
}

#[derive(Default, Clone)]
struct ResourceWatchManager {
    watches: std::sync::Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
}

#[derive(Default, Clone)]
struct PortForwardManager {
    forwards: std::sync::Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
}

impl PortForwardManager {
    fn insert(&self, id: String, abort: tokio::task::AbortHandle) {
        if let Some(previous) = self.forwards.lock().unwrap().insert(id, abort) {
            previous.abort();
        }
    }

    fn stop(&self, id: &str) {
        if let Some(abort) = self.forwards.lock().unwrap().remove(id) {
            abort.abort();
        }
    }
}

struct TerminalSession {
    input: tokio::sync::mpsc::Sender<String>,
    resize: tokio::sync::mpsc::Sender<(u16, u16)>,
    output: std::sync::Arc<
        tokio::sync::Mutex<tokio::sync::mpsc::Receiver<freelens_kube::TerminalOutput>>,
    >,
    abort: tokio::task::AbortHandle,
}

#[derive(Default, Clone)]
struct TerminalSessionManager {
    sessions: std::sync::Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalSessionManager {
    fn insert(&self, id: String, session: TerminalSession) {
        if let Some(previous) = self.sessions.lock().unwrap().insert(id, session) {
            previous.abort.abort();
        }
    }

    fn input(&self, id: &str) -> Option<tokio::sync::mpsc::Sender<String>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|session| session.input.clone())
    }

    fn resize(&self, id: &str) -> Option<tokio::sync::mpsc::Sender<(u16, u16)>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|session| session.resize.clone())
    }

    fn output(
        &self,
        id: &str,
    ) -> Option<
        std::sync::Arc<
            tokio::sync::Mutex<tokio::sync::mpsc::Receiver<freelens_kube::TerminalOutput>>,
        >,
    > {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|session| session.output.clone())
    }

    fn stop(&self, id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().remove(id) {
            session.abort.abort();
        }
    }
}

impl ResourceWatchManager {
    fn insert(&self, id: String, handle: tokio::task::AbortHandle) {
        if let Some(previous) = self.watches.lock().unwrap().insert(id, handle) {
            previous.abort();
        }
    }

    fn stop(&self, id: &str) {
        if let Some(handle) = self.watches.lock().unwrap().remove(id) {
            handle.abort();
        }
    }
}

impl LogStreamManager {
    fn insert(&self, id: String, handle: tokio::task::AbortHandle) {
        self.streams.lock().unwrap().insert(id, handle);
    }

    fn stop(&self, id: &str) {
        if let Some(handle) = self.streams.lock().unwrap().remove(id) {
            handle.abort();
        }
    }
}

#[tauri::command]
async fn kubernetes_start_resource_watch(
    request: KubernetesStartResourceWatchRequest,
    cache: State<'_, freelens_kube::ClientCache>,
    watches: State<'_, ResourceWatchManager>,
    app: AppHandle,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let (mut rx, abort) = freelens_kube::watch_resources(
        client,
        &request.kind,
        &request.api_version,
        request.namespace.as_deref(),
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })?;
    let operation_id = request.operation_id;
    watches.insert(operation_id.clone(), abort);
    let manager = watches.inner().clone();
    tokio::spawn(async move {
        while let Some(notification) = rx.recv().await {
            let payload = match notification {
                freelens_kube::ResourceWatchNotification::Changed => serde_json::json!({
                    "operationId": operation_id,
                    "type": "changed",
                }),
                freelens_kube::ResourceWatchNotification::Error(message) => serde_json::json!({
                    "operationId": operation_id,
                    "type": "error",
                    "message": message,
                }),
            };
            let _ = app.emit("kubernetes:resource-watch", payload);
        }
        manager.stop(&operation_id);
    });
    Ok(())
}

#[tauri::command]
fn kubernetes_stop_resource_watch(
    request: KubernetesStopResourceWatchRequest,
    watches: State<'_, ResourceWatchManager>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    watches.stop(&request.operation_id);
    Ok(())
}

#[tauri::command]
async fn kubernetes_stream_pod_logs(
    request: KubernetesStreamPodLogsRequest,
    cache: State<'_, freelens_kube::ClientCache>,
    streams: State<'_, LogStreamManager>,
    app: AppHandle,
) -> Result<KubernetesStreamPodLogsResponse, IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    let options = freelens_kube::LogStreamOptions {
        namespace: request.namespace,
        pod: request.pod,
        container: request.container,
        follow: request.follow,
        tail_lines: request.tail_lines,
    };

    let (initial_lines, mut rx, abort) = freelens_kube::stream_pod_logs(client, options)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;

    let operation_id = request.operation_id.clone();
    streams.insert(operation_id.clone(), abort);
    let manager = streams.inner().clone();

    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            let payload = serde_json::json!({
                "operationId": operation_id,
                "line": line,
            });
            let _ = app.emit("kubernetes:log", payload);
        }
        manager.stop(&operation_id);
        let _ = app.emit(
            "kubernetes:log:done",
            serde_json::json!({ "operationId": operation_id }),
        );
    });

    Ok(KubernetesStreamPodLogsResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        operation_id: request.operation_id,
        initial_lines,
    })
}

#[tauri::command]
fn kubernetes_stop_pod_logs(
    request: KubernetesStopPodLogsRequest,
    streams: State<'_, LogStreamManager>,
) -> Result<(), IpcError> {
    if request.meta.version != IPC_VERSION {
        return Err(IpcError {
            code: "unsupported_ipc_version".into(),
            message: format!(
                "IPC version {} is not supported; expected {}",
                request.meta.version, IPC_VERSION
            ),
        });
    }

    streams.stop(&request.operation_id);
    Ok(())
}

#[tauri::command]
async fn kubernetes_start_pod_terminal(
    request: KubernetesStartPodTerminalRequest,
    cache: State<'_, freelens_kube::ClientCache>,
    sessions: State<'_, TerminalSessionManager>,
) -> Result<KubernetesStartPodTerminalResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let request_id = request.meta.request_id;
    let session_id = request.session_id;
    let mut selected_terminal = None;
    let mut initial_output = String::new();
    for shell in ["bash", "sh", "ash", "zsh"] {
        let mut terminal = freelens_kube::start_pod_terminal(
            client.clone(),
            &request.namespace,
            &request.pod,
            &request.container,
            shell,
        )
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
        match tokio::time::timeout(std::time::Duration::from_secs(2), terminal.output.recv()).await
        {
            Ok(Some(chunk)) if chunk.stream == "stderr" => {
                initial_output = chunk.data;
                terminal.abort.abort();
            }
            Ok(Some(chunk)) => {
                initial_output = chunk.data;
                selected_terminal = Some(terminal);
                break;
            }
            Ok(None) => {
                terminal.abort.abort();
            }
            Err(_) => {
                selected_terminal = Some(terminal);
                break;
            }
        }
    }
    let active = selected_terminal.is_some();
    if !active && initial_output.is_empty() {
        initial_output =
            "No supported interactive shell (bash, sh, ash, or zsh) was found in this container."
                .into();
    }
    if let Some(terminal) = selected_terminal {
        let input = terminal.input;
        let resize = terminal.resize;
        let output = std::sync::Arc::new(tokio::sync::Mutex::new(terminal.output));
        let _ = resize.send((request.rows, request.cols)).await;
        sessions.insert(
            session_id.clone(),
            TerminalSession {
                input,
                resize,
                output,
                abort: terminal.abort,
            },
        );
    }
    Ok(KubernetesStartPodTerminalResponse {
        version: IPC_VERSION,
        request_id,
        session_id,
        active,
        initial_output,
    })
}

#[tauri::command]
async fn kubernetes_terminal_input(
    request: KubernetesTerminalInputRequest,
    sessions: State<'_, TerminalSessionManager>,
) -> Result<KubernetesTerminalInputResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let request_id = request.meta.request_id;
    let session_id = request.session_id;
    let input = sessions.input(&session_id).ok_or_else(|| IpcError {
        code: "kubernetes_terminal_not_found".into(),
        message: "terminal session is not active".into(),
    })?;
    if !request.input.is_empty() {
        input.send(request.input).await.map_err(|_| IpcError {
            code: "kubernetes_terminal_closed".into(),
            message: "terminal session is closed".into(),
        })?;
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    }
    let output = sessions.output(&session_id).ok_or_else(|| IpcError {
        code: "kubernetes_terminal_not_found".into(),
        message: "terminal session is not active".into(),
    })?;
    let mut receiver = output.lock().await;
    let mut combined = String::new();
    loop {
        match receiver.try_recv() {
            Ok(chunk) => combined.push_str(&chunk.data),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                sessions.stop(&session_id);
                break;
            }
        }
    }
    Ok(KubernetesTerminalInputResponse {
        version: IPC_VERSION,
        request_id,
        session_id,
        output: combined,
    })
}

#[tauri::command]
async fn kubernetes_resize_pod_terminal(
    request: KubernetesResizePodTerminalRequest,
    sessions: State<'_, TerminalSessionManager>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    let resize = sessions
        .resize(&request.session_id)
        .ok_or_else(|| IpcError {
            code: "kubernetes_terminal_not_found".into(),
            message: "terminal session is not active".into(),
        })?;
    resize
        .send((request.rows.max(1), request.cols.max(1)))
        .await
        .map_err(|_| IpcError {
            code: "kubernetes_terminal_closed".into(),
            message: "terminal session is closed".into(),
        })
}

#[tauri::command]
fn kubernetes_stop_pod_terminal(
    request: KubernetesStopPodTerminalRequest,
    sessions: State<'_, TerminalSessionManager>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    sessions.stop(&request.session_id);
    Ok(())
}

#[tauri::command]
async fn kubernetes_start_pod_port_forward(
    request: KubernetesStartPodPortForwardRequest,
    cache: State<'_, freelens_kube::ClientCache>,
    forwards: State<'_, PortForwardManager>,
) -> Result<KubernetesStartPodPortForwardResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let forward = freelens_kube::start_pod_port_forward(
        client,
        &request.namespace,
        &request.pod,
        request.remote_port,
        request.local_port,
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })?;
    forwards.insert(request.operation_id.clone(), forward.abort);
    Ok(KubernetesStartPodPortForwardResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        operation_id: request.operation_id,
        local_port: forward.local_port,
        remote_port: request.remote_port,
    })
}

#[tauri::command]
fn kubernetes_stop_pod_port_forward(
    request: KubernetesStopPodPortForwardRequest,
    forwards: State<'_, PortForwardManager>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    forwards.stop(&request.operation_id);
    Ok(())
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "freelens_app=info".into()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                "Freelens prototype starting"
            );
            app.get_webview_window("main")
                .expect("main window must exist");
            Ok(())
        })
        .manage(freelens_kube::ClientCache::new())
        .manage(LogStreamManager::default())
        .manage(ResourceWatchManager::default())
        .manage(TerminalSessionManager::default())
        .manage(PortForwardManager::default())
        .invoke_handler(tauri::generate_handler![
            health_check,
            system_info,
            kubeconfig_list,
            kubernetes_version,
            kubernetes_list_namespaces,
            kubernetes_discover_resources,
            kubernetes_list_resources,
            kubernetes_get_resource_yaml,
            kubernetes_get_resource_detail,
            kubernetes_apply_resource,
            kubernetes_create_resource,
            kubernetes_delete_resource,
            kubernetes_scale_deployment,
            kubernetes_exec_pod,
            kubernetes_start_pod_terminal,
            kubernetes_terminal_input,
            kubernetes_resize_pod_terminal,
            kubernetes_stop_pod_terminal,
            kubernetes_start_pod_port_forward,
            kubernetes_stop_pod_port_forward,
            kubernetes_start_resource_watch,
            kubernetes_stop_resource_watch,
            kubernetes_get_pod_containers,
            kubernetes_stream_pod_logs,
            kubernetes_stop_pod_logs
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Freelens prototype");
}

#[cfg(test)]
mod tests {
    use super::*;
    use freelens_ipc::RequestMeta;

    #[test]
    fn health_check_echoes_request_id() {
        let response = health_check(HealthCheckRequest {
            meta: RequestMeta::new("test-request"),
        })
        .unwrap();

        assert_eq!(response.request_id, "test-request");
        assert_eq!(response.status, HealthStatus::Ok);
    }

    #[test]
    fn health_check_rejects_unknown_version() {
        let error = health_check(HealthCheckRequest {
            meta: RequestMeta {
                version: IPC_VERSION + 1,
                request_id: "test-request".into(),
            },
        })
        .unwrap_err();

        assert_eq!(error.code, "unsupported_ipc_version");
    }
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use freelens_ipc::{
    ContainerDetailItem, DetailFieldItem, DetailSectionItem, EventDetailItem, HealthCheckRequest,
    HealthCheckResponse, HealthStatus, IPC_VERSION, IpcError, KubeconfigListRequest,
    KubeconfigListResponse, KubernetesDiscoverResourcesRequest,
    KubernetesDiscoverResourcesResponse, KubernetesGetPodContainersRequest,
    KubernetesGetPodContainersResponse, KubernetesGetResourceDetailRequest,
    KubernetesGetResourceDetailResponse, KubernetesGetResourceYamlRequest,
    KubernetesGetResourceYamlResponse, KubernetesListNamespacesRequest,
    KubernetesListNamespacesResponse, KubernetesListResourcesRequest,
    KubernetesListResourcesResponse, KubernetesStopPodLogsRequest, KubernetesStreamPodLogsRequest,
    KubernetesStreamPodLogsResponse, KubernetesVersionRequest, KubernetesVersionResponse,
    NamespaceItem, ResourceItem, ResourceKindItem, SystemInfoResponse,
};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, path::BaseDirectory};

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

    let list = freelens_kube::list_resources(
        client,
        &request.kind,
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
        &request.namespace,
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

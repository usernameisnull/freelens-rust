#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use freelens_ipc::{
    AppSettings, ContainerDetailItem, DetailFieldItem, DetailSectionItem, EventDetailItem,
    HealthCheckRequest, HealthCheckResponse, HealthStatus, IPC_VERSION, IpcError,
    KubeconfigListRequest, KubeconfigListResponse, KubectlCancelRequest, KubectlInfoRequest,
    KubectlInfoResponse, KubectlInstallation, KubectlRunRequest, KubectlRunResponse,
    KubernetesApplyResourceRequest, KubernetesApplyResourceResponse,
    KubernetesClusterOverviewRequest, KubernetesClusterOverviewResponse,
    KubernetesCreateResourceRequest, KubernetesCreateResourceResponse,
    KubernetesDeleteResourceRequest, KubernetesDiscoverResourcesRequest,
    KubernetesDiscoverResourcesResponse, KubernetesEventItem, KubernetesExecPodRequest,
    KubernetesExecPodResponse, KubernetesGetPodContainersRequest,
    KubernetesGetPodContainersResponse, KubernetesGetResourceDetailRequest,
    KubernetesGetResourceDetailResponse, KubernetesGetResourceYamlRequest,
    KubernetesGetResourceYamlResponse, KubernetesListEventsRequest, KubernetesListEventsResponse,
    KubernetesListMetricsRequest, KubernetesListMetricsResponse, KubernetesListNamespacesRequest,
    KubernetesListNamespacesResponse, KubernetesListResourcesRequest,
    KubernetesListResourcesResponse, KubernetesResizePodTerminalRequest,
    KubernetesRestartWorkloadRequest, KubernetesScaleWorkloadRequest,
    KubernetesStartPodPortForwardRequest, KubernetesStartPodPortForwardResponse,
    KubernetesStartPodTerminalRequest, KubernetesStartPodTerminalResponse,
    KubernetesStartResourceWatchRequest, KubernetesStopPodLogsRequest,
    KubernetesStopPodPortForwardRequest, KubernetesStopPodTerminalRequest,
    KubernetesStopResourceWatchRequest, KubernetesStreamPodLogsRequest,
    KubernetesStreamPodLogsResponse, KubernetesTerminalInputRequest,
    KubernetesTerminalInputResponse, KubernetesTriggerCronJobRequest,
    KubernetesTriggerCronJobResponse, KubernetesVersionRequest, KubernetesVersionResponse,
    LocalTerminalInputRequest, LocalTerminalInputResponse, LocalTerminalResizeRequest,
    LocalTerminalStartRequest, LocalTerminalStartResponse, LocalTerminalStopRequest, NamespaceItem,
    ResourceItem, ResourceKindItem, ResourceMetricItem, SettingsLoadRequest, SettingsLoadResponse,
    SettingsSaveRequest, SystemInfoResponse,
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, path::BaseDirectory};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

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

const SETTINGS_FILE_VERSION: u16 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    version: u16,
    settings: AppSettings,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, IpcError> {
    app.path()
        .resolve("settings.json", BaseDirectory::AppData)
        .map_err(path_error)
}

#[tauri::command]
fn settings_load(
    request: SettingsLoadRequest,
    app: AppHandle,
) -> Result<SettingsLoadResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let path = settings_path(&app)?;
    let settings = match std::fs::read(&path) {
        Ok(data) => {
            let stored: StoredSettings =
                serde_json::from_slice(&data).map_err(|error| IpcError {
                    code: "settings_parse_failed".into(),
                    message: format!("failed to parse {}: {error}", path.display()),
                })?;
            if stored.version != SETTINGS_FILE_VERSION {
                return Err(IpcError {
                    code: "settings_version_unsupported".into(),
                    message: format!(
                        "settings version {} is not supported; expected {}",
                        stored.version, SETTINGS_FILE_VERSION
                    ),
                });
            }
            stored.settings
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppSettings::default(),
        Err(error) => {
            return Err(IpcError {
                code: "settings_read_failed".into(),
                message: error.to_string(),
            });
        }
    };
    Ok(SettingsLoadResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        settings,
    })
}

#[tauri::command]
fn settings_save(request: SettingsSaveRequest, app: AppHandle) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    let path = settings_path(&app)?;
    let parent = path.parent().ok_or_else(|| IpcError {
        code: "settings_path_invalid".into(),
        message: "settings path has no parent directory".into(),
    })?;
    std::fs::create_dir_all(parent).map_err(|error| IpcError {
        code: "settings_write_failed".into(),
        message: error.to_string(),
    })?;
    let data = serde_json::to_vec_pretty(&StoredSettings {
        version: SETTINGS_FILE_VERSION,
        settings: request.settings,
    })
    .map_err(|error| IpcError {
        code: "settings_serialize_failed".into(),
        message: error.to_string(),
    })?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, data).map_err(|error| IpcError {
        code: "settings_write_failed".into(),
        message: error.to_string(),
    })?;
    let backup = path.with_extension("json.bak");
    let had_existing = path.exists();
    if backup.exists() {
        let _ = std::fs::remove_file(&backup);
    }
    if had_existing {
        std::fs::rename(&path, &backup).map_err(|error| IpcError {
            code: "settings_write_failed".into(),
            message: error.to_string(),
        })?;
    }
    if let Err(error) = std::fs::rename(&temporary, &path) {
        if had_existing {
            let _ = std::fs::rename(&backup, &path);
        }
        return Err(IpcError {
            code: "settings_write_failed".into(),
            message: error.to_string(),
        });
    }
    if had_existing {
        let _ = std::fs::remove_file(&backup);
    }
    Ok(())
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
async fn kubernetes_list_metrics(
    request: KubernetesListMetricsRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesListMetricsResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let items = freelens_kube::list_metrics(client, &request.kind, request.namespace.as_deref())
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    Ok(KubernetesListMetricsResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        kind: request.kind,
        items: items
            .into_iter()
            .map(|item| ResourceMetricItem {
                name: item.name,
                namespace: item.namespace,
                cpu_millicores: item.cpu_millicores,
                memory_bytes: item.memory_bytes,
            })
            .collect(),
    })
}

#[tauri::command]
async fn kubernetes_cluster_overview(
    request: KubernetesClusterOverviewRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesClusterOverviewResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let overview = freelens_kube::cluster_overview(client)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    Ok(KubernetesClusterOverviewResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        namespaces: overview.namespaces,
        nodes: overview.nodes,
        ready_nodes: overview.ready_nodes,
        pods: overview.pods,
        running_pods: overview.running_pods,
        abnormal_pods: overview.abnormal_pods,
        workloads: overview.workloads,
        unavailable_workloads: overview.unavailable_workloads,
        cpu_millicores: overview.cpu_millicores,
        memory_bytes: overview.memory_bytes,
        metrics_error: overview.metrics_error,
    })
}

#[tauri::command]
async fn kubernetes_list_events(
    request: KubernetesListEventsRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesListEventsResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context.clone()))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let items = freelens_kube::list_events(client, request.namespace.as_deref())
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    Ok(KubernetesListEventsResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        context: request.context,
        items: items
            .into_iter()
            .map(|item| KubernetesEventItem {
                namespace: item.namespace,
                event_type: item.event_type,
                reason: item.reason,
                message: item.message,
                count: item.count,
                timestamp: item.timestamp,
                object_kind: item.object_kind,
                object_api_version: item.object_api_version,
                object_name: item.object_name,
                object_namespace: item.object_namespace,
            })
            .collect(),
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
async fn kubernetes_scale_workload(
    request: KubernetesScaleWorkloadRequest,
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
    freelens_kube::scale_workload(
        client,
        &request.kind,
        &request.namespace,
        &request.name,
        request.replicas,
    )
    .await
    .map_err(|error| IpcError {
        code: error.code().into(),
        message: error.to_string(),
    })
}

#[tauri::command]
async fn kubernetes_restart_workload(
    request: KubernetesRestartWorkloadRequest,
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
    freelens_kube::restart_workload(client, &request.kind, &request.namespace, &request.name)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })
}

#[tauri::command]
async fn kubernetes_trigger_cronjob(
    request: KubernetesTriggerCronJobRequest,
    cache: State<'_, freelens_kube::ClientCache>,
) -> Result<KubernetesTriggerCronJobResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let client = cache
        .client(Some(request.context))
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    let job_name = freelens_kube::trigger_cronjob(client, &request.namespace, &request.name)
        .await
        .map_err(|error| IpcError {
            code: error.code().into(),
            message: error.to_string(),
        })?;
    Ok(KubernetesTriggerCronJobResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        job_name,
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

#[derive(Default, Clone)]
struct KubectlProcessManager {
    processes: std::sync::Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
}

enum LocalTerminalCommand {
    Input(Vec<u8>),
    Resize(PtySize),
    Stop,
}

#[derive(Default, Clone)]
struct LocalTerminalManager {
    sessions: std::sync::Arc<Mutex<HashMap<String, LocalTerminalSession>>>,
}

struct LocalTerminalSession {
    commands: std::sync::mpsc::Sender<LocalTerminalCommand>,
    output: std::sync::Arc<Mutex<std::sync::mpsc::Receiver<String>>>,
}

impl LocalTerminalManager {
    fn insert(&self, id: String, session: LocalTerminalSession) {
        if let Some(previous) = self.sessions.lock().unwrap().insert(id, session) {
            let _ = previous.commands.send(LocalTerminalCommand::Stop);
        }
    }

    fn send(&self, id: &str, command: LocalTerminalCommand) -> Result<(), IpcError> {
        let sender = self
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|session| session.commands.clone());
        sender
            .ok_or_else(|| IpcError {
                code: "local_terminal_not_found".into(),
                message: "local terminal session is not active".into(),
            })?
            .send(command)
            .map_err(|_| IpcError {
                code: "local_terminal_closed".into(),
                message: "local terminal session is closed".into(),
            })
    }

    fn output(&self, id: &str) -> Option<std::sync::Arc<Mutex<std::sync::mpsc::Receiver<String>>>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|session| session.output.clone())
    }

    fn stop(&self, id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().remove(id) {
            let _ = session.commands.send(LocalTerminalCommand::Stop);
        }
    }

    fn stop_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for session in sessions.into_values() {
            let _ = session.commands.send(LocalTerminalCommand::Stop);
        }
    }
}

impl KubectlProcessManager {
    fn insert(&self, id: String, abort: tokio::task::AbortHandle) {
        if let Some(previous) = self.processes.lock().unwrap().insert(id, abort) {
            previous.abort();
        }
    }

    fn remove(&self, id: &str) {
        self.processes.lock().unwrap().remove(id);
    }

    fn cancel(&self, id: &str) {
        if let Some(process) = self.processes.lock().unwrap().remove(id) {
            process.abort();
        }
    }

    fn cancel_all(&self) {
        let processes = std::mem::take(&mut *self.processes.lock().unwrap());
        for process in processes.into_values() {
            process.abort();
        }
    }
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

    fn stop_all(&self) {
        let forwards = std::mem::take(&mut *self.forwards.lock().unwrap());
        for forward in forwards.into_values() {
            forward.abort();
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

    fn stop_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for session in sessions.into_values() {
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

    fn stop_all(&self) {
        let watches = std::mem::take(&mut *self.watches.lock().unwrap());
        for watch in watches.into_values() {
            watch.abort();
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

    fn stop_all(&self) {
        let streams = std::mem::take(&mut *self.streams.lock().unwrap());
        for stream in streams.into_values() {
            stream.abort();
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

const KUBECTL_OUTPUT_LIMIT: usize = 1024 * 1024;

fn display_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{value}"))
    } else if let Some(value) = value.strip_prefix(r"\\?\") {
        PathBuf::from(value)
    } else {
        path.to_path_buf()
    }
}

fn kubectl_candidates() -> Vec<PathBuf> {
    let executable_names: &[&str] = if cfg!(windows) {
        &["kubectl.exe", "kubectl"]
    } else {
        &["kubectl"]
    };
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in executable_names {
                let candidate = directory.join(name);
                if candidate.is_file() {
                    let canonical = candidate.canonicalize().unwrap_or(candidate);
                    let identity = canonical.to_string_lossy().to_lowercase();
                    if seen.insert(identity) {
                        candidates.push(display_path(&canonical));
                    }
                }
            }
        }
    }
    candidates
}

async fn kubectl_version(path: &Path) -> String {
    let mut command = Command::new(path);
    command
        .args(["version", "--client", "--output=json"])
        .kill_on_drop(true);
    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(5), command.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => return format!("Unavailable: {error}"),
            Err(_) => return "Version check timed out".into(),
        };
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        && let Some(version) = value
            .pointer("/clientVersion/gitVersion")
            .and_then(|value| value.as_str())
    {
        return version.into();
    }
    let text = String::from_utf8_lossy(if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    });
    text.lines()
        .next()
        .unwrap_or("Unknown version")
        .trim()
        .into()
}

#[tauri::command]
async fn kubectl_info(request: KubectlInfoRequest) -> Result<KubectlInfoResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let mut installations = Vec::new();
    for path in kubectl_candidates() {
        installations.push(KubectlInstallation {
            version: kubectl_version(&path).await,
            path: path.display().to_string(),
        });
    }
    Ok(KubectlInfoResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        installations,
    })
}

async fn read_limited<R>(mut reader: R) -> std::io::Result<(Vec<u8>, bool)>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = KUBECTL_OUTPUT_LIMIT.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..read.min(remaining)]);
        truncated |= read > remaining;
    }
    Ok((output, truncated))
}

async fn run_kubectl_process(request: &KubectlRunRequest) -> Result<KubectlRunResponse, IpcError> {
    if request.arguments.is_empty() {
        return Err(IpcError {
            code: "kubectl_arguments_empty".into(),
            message: "Enter a kubectl command, for example: get pods".into(),
        });
    }
    let requested_path = PathBuf::from(&request.executable);
    let requested_canonical = requested_path.canonicalize().ok();
    let allowed = requested_canonical.as_ref().is_some_and(|requested| {
        kubectl_candidates()
            .into_iter()
            .filter_map(|candidate| candidate.canonicalize().ok())
            .any(|candidate| &candidate == requested)
    });
    if !allowed {
        return Err(IpcError {
            code: "kubectl_executable_not_found".into(),
            message: "The selected kubectl executable is not available on PATH".into(),
        });
    }

    let mut command = Command::new(&requested_path);
    command
        .args(&request.arguments)
        .arg("--context")
        .arg(&request.context)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(namespace) = request
        .namespace
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        command.arg("--namespace").arg(namespace);
    }
    let mut child = command.spawn().map_err(|error| IpcError {
        code: "kubectl_start_failed".into(),
        message: error.to_string(),
    })?;
    let stdout = child.stdout.take().expect("kubectl stdout must be piped");
    let stderr = child.stderr.take().expect("kubectl stderr must be piped");
    let stdout_task = tokio::spawn(read_limited(stdout));
    let stderr_task = tokio::spawn(read_limited(stderr));
    let status = child.wait().await.map_err(|error| IpcError {
        code: "kubectl_wait_failed".into(),
        message: error.to_string(),
    })?;
    let (stdout, stdout_truncated) = stdout_task
        .await
        .map_err(|error| IpcError {
            code: "kubectl_output_failed".into(),
            message: error.to_string(),
        })?
        .map_err(|error| IpcError {
            code: "kubectl_output_failed".into(),
            message: error.to_string(),
        })?;
    let (stderr, stderr_truncated) = stderr_task
        .await
        .map_err(|error| IpcError {
            code: "kubectl_output_failed".into(),
            message: error.to_string(),
        })?
        .map_err(|error| IpcError {
            code: "kubectl_output_failed".into(),
            message: error.to_string(),
        })?;
    Ok(KubectlRunResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id.clone(),
        operation_id: request.operation_id.clone(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code: status.code(),
        output_truncated: stdout_truncated || stderr_truncated,
    })
}

#[tauri::command]
async fn kubectl_run(
    request: KubectlRunRequest,
    processes: State<'_, KubectlProcessManager>,
) -> Result<KubectlRunResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let operation_id = request.operation_id.clone();
    let task = tokio::spawn(async move { run_kubectl_process(&request).await });
    processes.insert(operation_id.clone(), task.abort_handle());
    let result = task.await;
    processes.remove(&operation_id);
    match result {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err(IpcError {
            code: "kubectl_cancelled".into(),
            message: "kubectl command was cancelled".into(),
        }),
        Err(error) => Err(IpcError {
            code: "kubectl_task_failed".into(),
            message: error.to_string(),
        }),
    }
}

#[tauri::command]
fn kubectl_cancel(
    request: KubectlCancelRequest,
    processes: State<'_, KubectlProcessManager>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    processes.cancel(&request.operation_id);
    Ok(())
}

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for name in names {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(display_path(&candidate.canonicalize().unwrap_or(candidate)));
            }
        }
    }
    None
}

#[tauri::command]
fn local_terminal_start(
    request: LocalTerminalStartRequest,
    sessions: State<'_, LocalTerminalManager>,
    app: AppHandle,
) -> Result<LocalTerminalStartResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let shell = find_on_path(&["pwsh.exe", "powershell.exe"]).ok_or_else(|| IpcError {
        code: "local_terminal_shell_not_found".into(),
        message: "Neither pwsh.exe nor powershell.exe was found on PATH".into(),
    })?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows.max(1),
            cols: request.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| IpcError {
            code: "local_terminal_start_failed".into(),
            message: error.to_string(),
        })?;
    let mut command = CommandBuilder::new(&shell);
    command.arg("-NoLogo");
    command.env("FREELENS_CONTEXT", &request.context);
    command.env(
        "FREELENS_NAMESPACE",
        request.namespace.as_deref().unwrap_or(""),
    );
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| IpcError {
            code: "local_terminal_start_failed".into(),
            message: error.to_string(),
        })?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| IpcError {
        code: "local_terminal_start_failed".into(),
        message: error.to_string(),
    })?;
    let mut writer = pair.master.take_writer().map_err(|error| IpcError {
        code: "local_terminal_start_failed".into(),
        message: error.to_string(),
    })?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let (output_sender, output_receiver) = std::sync::mpsc::channel();
    let session_id = request.session_id.clone();
    sessions.insert(
        session_id.clone(),
        LocalTerminalSession {
            commands: sender.clone(),
            output: std::sync::Arc::new(Mutex::new(output_receiver)),
        },
    );

    let control_session_id = session_id.clone();
    std::thread::spawn(move || {
        while let Ok(command) = receiver.recv() {
            let result = match command {
                LocalTerminalCommand::Input(data) => {
                    writer.write_all(&data).and_then(|_| writer.flush())
                }
                LocalTerminalCommand::Resize(size) => {
                    pair.master.resize(size).map_err(std::io::Error::other)
                }
                LocalTerminalCommand::Stop => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            };
            if let Err(error) = result {
                tracing::warn!(%error, session_id = %control_session_id, "local terminal control failed");
                let _ = child.kill();
                break;
            }
        }
    });

    let output_session_id = session_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let _ =
                        output_sender.send(String::from_utf8_lossy(&buffer[..read]).into_owned());
                }
                Err(error) => {
                    tracing::debug!(%error, session_id = %output_session_id, "local terminal output ended");
                    break;
                }
            }
        }
        let _ = sender.send(LocalTerminalCommand::Stop);
        let _ = app.emit(
            "local-terminal:done",
            serde_json::json!({ "sessionId": output_session_id }),
        );
    });

    Ok(LocalTerminalStartResponse {
        version: IPC_VERSION,
        request_id: request.meta.request_id,
        session_id,
        shell: shell.display().to_string(),
    })
}

#[tauri::command]
fn local_terminal_input(
    request: LocalTerminalInputRequest,
    sessions: State<'_, LocalTerminalManager>,
) -> Result<LocalTerminalInputResponse, IpcError> {
    validate_ipc_version(request.meta.version)?;
    let request_id = request.meta.request_id;
    let session_id = request.session_id;
    if !request.input.is_empty() {
        sessions.send(
            &session_id,
            LocalTerminalCommand::Input(request.input.into_bytes()),
        )?;
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let output = sessions.output(&session_id).ok_or_else(|| IpcError {
        code: "local_terminal_not_found".into(),
        message: "local terminal session is not active".into(),
    })?;
    let receiver = output.lock().unwrap();
    let mut combined = String::new();
    let mut active = true;
    loop {
        match receiver.try_recv() {
            Ok(chunk) => combined.push_str(&chunk),
            Err(std::sync::mpsc::TryRecvError::Empty) => break,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                active = false;
                break;
            }
        }
    }
    if !active {
        sessions.stop(&session_id);
    }
    Ok(LocalTerminalInputResponse {
        version: IPC_VERSION,
        request_id,
        session_id,
        output: combined,
        active,
    })
}

#[tauri::command]
fn local_terminal_resize(
    request: LocalTerminalResizeRequest,
    sessions: State<'_, LocalTerminalManager>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    sessions.send(
        &request.session_id,
        LocalTerminalCommand::Resize(PtySize {
            rows: request.rows.max(1),
            cols: request.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        }),
    )
}

#[tauri::command]
fn local_terminal_stop(
    request: LocalTerminalStopRequest,
    sessions: State<'_, LocalTerminalManager>,
) -> Result<(), IpcError> {
    validate_ipc_version(request.meta.version)?;
    sessions.stop(&request.session_id);
    Ok(())
}

fn cleanup_background_tasks(app: &AppHandle) {
    app.state::<LogStreamManager>().stop_all();
    app.state::<ResourceWatchManager>().stop_all();
    app.state::<TerminalSessionManager>().stop_all();
    app.state::<PortForwardManager>().stop_all();
    app.state::<KubectlProcessManager>().cancel_all();
    app.state::<LocalTerminalManager>().stop_all();
    tracing::info!("background tasks stopped");
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "freelens_app=info".into()),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                "Freelens prototype starting"
            );
            let window = app
                .get_webview_window("main")
                .expect("main window must exist");
            let revision = Arc::new(AtomicU64::new(0));
            let app_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if !matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                ) {
                    return;
                }
                let current = revision.fetch_add(1, Ordering::Relaxed) + 1;
                let revision = revision.clone();
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    if revision.load(Ordering::Relaxed) == current
                        && let Err(error) = app_handle.save_window_state(StateFlags::all())
                    {
                        tracing::warn!(%error, "failed to persist window state");
                    }
                });
            });
            Ok(())
        })
        .manage(freelens_kube::ClientCache::new())
        .manage(LogStreamManager::default())
        .manage(ResourceWatchManager::default())
        .manage(TerminalSessionManager::default())
        .manage(PortForwardManager::default())
        .manage(KubectlProcessManager::default())
        .manage(LocalTerminalManager::default())
        .invoke_handler(tauri::generate_handler![
            health_check,
            system_info,
            settings_load,
            settings_save,
            kubeconfig_list,
            kubernetes_version,
            kubernetes_list_namespaces,
            kubernetes_discover_resources,
            kubernetes_list_resources,
            kubernetes_list_metrics,
            kubernetes_cluster_overview,
            kubernetes_list_events,
            kubernetes_get_resource_yaml,
            kubernetes_get_resource_detail,
            kubernetes_apply_resource,
            kubernetes_create_resource,
            kubernetes_delete_resource,
            kubernetes_scale_workload,
            kubernetes_restart_workload,
            kubernetes_trigger_cronjob,
            kubernetes_exec_pod,
            kubernetes_start_pod_terminal,
            kubernetes_terminal_input,
            kubernetes_resize_pod_terminal,
            kubernetes_stop_pod_terminal,
            kubernetes_start_pod_port_forward,
            kubernetes_stop_pod_port_forward,
            kubectl_info,
            kubectl_run,
            kubectl_cancel,
            local_terminal_start,
            local_terminal_input,
            local_terminal_resize,
            local_terminal_stop,
            kubernetes_start_resource_watch,
            kubernetes_stop_resource_watch,
            kubernetes_get_pod_containers,
            kubernetes_stream_pod_logs,
            kubernetes_stop_pod_logs
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Freelens prototype");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            cleanup_background_tasks(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use freelens_ipc::RequestMeta;

    #[test]
    fn abort_managers_clear_all_registered_tasks() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let forwards = PortForwardManager::default();
        let task = runtime.spawn(async {
            std::future::pending::<()>().await;
        });
        let abort = task.abort_handle();
        forwards.insert("forward-1".into(), abort);
        forwards.stop_all();
        assert!(runtime.block_on(task).unwrap_err().is_cancelled());
        assert!(forwards.forwards.lock().unwrap().is_empty());

        let processes = KubectlProcessManager::default();
        let task = runtime.spawn(async {
            std::future::pending::<()>().await;
        });
        let abort = task.abort_handle();
        processes.insert("kubectl-1".into(), abort);
        processes.cancel_all();
        assert!(runtime.block_on(task).unwrap_err().is_cancelled());
        assert!(processes.processes.lock().unwrap().is_empty());

        let watches = ResourceWatchManager::default();
        let task = runtime.spawn(async {
            std::future::pending::<()>().await;
        });
        let abort = task.abort_handle();
        watches.insert("watch-1".into(), abort);
        watches.stop_all();
        assert!(runtime.block_on(task).unwrap_err().is_cancelled());
        assert!(watches.watches.lock().unwrap().is_empty());
    }

    #[test]
    fn display_path_removes_windows_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\D:\tools\kubectl.exe")),
            PathBuf::from(r"D:\tools\kubectl.exe")
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\tools\kubectl.exe")),
            PathBuf::from(r"\\server\tools\kubectl.exe")
        );
    }

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

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use freelens_ipc::{
    HealthCheckRequest, HealthCheckResponse, HealthStatus, IPC_VERSION, IpcError,
    SystemInfoResponse,
};
use tauri::{Manager, path::BaseDirectory};

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
        .invoke_handler(tauri::generate_handler![health_check, system_info])
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

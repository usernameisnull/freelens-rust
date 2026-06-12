use serde::{Deserialize, Serialize};

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
}

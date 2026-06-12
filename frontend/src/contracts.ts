export const IPC_VERSION = 1;

export interface HealthCheckRequest {
  meta: {
    version: number;
    requestId: string;
  };
}

export interface HealthCheckResponse {
  version: number;
  requestId: string;
  status: "ok";
  service: string;
}

export interface SystemInfoResponse {
  version: number;
  os: string;
  arch: string;
  appDataDir: string;
  logDir: string;
}


import { invoke } from "@tauri-apps/api/core";
import {
  HealthCheckRequest,
  HealthCheckResponse,
  IPC_VERSION,
  SystemInfoResponse,
} from "./contracts";

export interface Transport {
  healthCheck(request: HealthCheckRequest): Promise<HealthCheckResponse>;
  systemInfo(): Promise<SystemInfoResponse>;
}

class TauriTransport implements Transport {
  healthCheck(request: HealthCheckRequest): Promise<HealthCheckResponse> {
    return invoke("health_check", { request });
  }

  systemInfo(): Promise<SystemInfoResponse> {
    return invoke("system_info");
  }
}

class MockTransport implements Transport {
  async healthCheck(request: HealthCheckRequest): Promise<HealthCheckResponse> {
    return {
      version: IPC_VERSION,
      requestId: request.meta.requestId,
      status: "ok",
      service: "freelens-mock",
    };
  }

  async systemInfo(): Promise<SystemInfoResponse> {
    return {
      version: IPC_VERSION,
      os: navigator.platform || "browser",
      arch: "development",
      appDataDir: "Available in the Tauri desktop shell",
      logDir: "Available in the Tauri desktop shell",
    };
  }
}

export function createTransport(): Transport {
  return "__TAURI_INTERNALS__" in window
    ? new TauriTransport()
    : new MockTransport();
}


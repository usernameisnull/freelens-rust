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

export interface KubeconfigListRequest {
  meta: {
    version: number;
    requestId: string;
  };
}

export interface KubeconfigContext {
  name: string;
  cluster: string;
  user: string | null;
  isCurrent: boolean;
}

export interface KubeconfigListResponse {
  version: number;
  requestId: string;
  currentContext: string | null;
  contexts: KubeconfigContext[];
}

export interface KubernetesVersionRequest {
  meta: {
    version: number;
    requestId: string;
  };
  context: string | null;
}

export interface KubernetesVersionResponse {
  version: number;
  requestId: string;
  major: string;
  minor: string;
  gitVersion: string;
}

export interface KubernetesListNamespacesRequest {
  meta: {
    version: number;
    requestId: string;
  };
  context: string;
}

export interface NamespaceItem {
  name: string;
  status: string | null;
}

export interface KubernetesListNamespacesResponse {
  version: number;
  requestId: string;
  context: string;
  namespaces: NamespaceItem[];
}


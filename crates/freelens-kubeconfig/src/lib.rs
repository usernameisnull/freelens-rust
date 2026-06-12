use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Stable error codes surfaced to callers and the UI.
#[derive(Debug, Error)]
pub enum KubeconfigError {
    #[error("kubeconfig not found at {path}")]
    NotFound { path: PathBuf },
    #[error("failed to read kubeconfig: {source}")]
    ReadFailed {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse kubeconfig: {source}")]
    ParseFailed {
        path: PathBuf,
        #[source]
        source: serde_yaml_ng::Error,
    },
    #[error("failed to merge kubeconfig files: {0}")]
    MergeFailed(String),
}

impl KubeconfigError {
    pub fn code(&self) -> &'static str {
        match self {
            KubeconfigError::NotFound { .. } => "kubeconfig_not_found",
            KubeconfigError::ReadFailed { .. } => "kubeconfig_read_failed",
            KubeconfigError::ParseFailed { .. } => "kubeconfig_parse_failed",
            KubeconfigError::MergeFailed(..) => "kubeconfig_merge_failed",
        }
    }
}

/// A kubeconfig file subset sufficient for context discovery.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Kubeconfig {
    #[serde(rename = "apiVersion")]
    pub api_version: Option<String>,
    pub kind: Option<String>,
    #[serde(rename = "current-context")]
    pub current_context: Option<String>,
    #[serde(default)]
    pub clusters: Vec<NamedCluster>,
    #[serde(default)]
    pub contexts: Vec<NamedContext>,
    #[serde(default)]
    pub users: Vec<NamedUser>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedCluster {
    pub name: String,
    pub cluster: Cluster,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cluster {
    pub server: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedContext {
    pub name: String,
    pub context: Context,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Context {
    pub cluster: String,
    pub user: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedUser {
    pub name: String,
    pub user: User,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {}

/// Summary returned to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigSummary {
    pub current_context: Option<String>,
    pub contexts: Vec<ContextItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub name: String,
    pub cluster: String,
    pub user: Option<String>,
    pub is_current: bool,
}

/// Discover and parse kubeconfig files.
///
/// * `None` - discover using `KUBECONFIG` env var or the default `%USERPROFILE%\.kube\config` path.
/// * `Some(path)` - treat as a single explicit path (used mainly in tests).
pub fn load_kubeconfig(path_or_env: Option<String>) -> Result<Kubeconfig, KubeconfigError> {
    let paths = resolve_paths(path_or_env)?;
    if paths.is_empty() {
        return Err(KubeconfigError::NotFound {
            path: default_kubeconfig_path(),
        });
    }

    let mut merged = Kubeconfig::default();
    for path in paths {
        let file = load_single_file(&path)?;
        merge_kubeconfig(&mut merged, file, &path)?;
    }

    Ok(merged)
}

/// List contexts in display order with the current context flagged.
pub fn list_contexts(path_or_env: Option<String>) -> Result<KubeconfigSummary, KubeconfigError> {
    let config = load_kubeconfig(path_or_env)?;
    let current = config.current_context.clone();

    let contexts = config
        .contexts
        .into_iter()
        .map(|named| ContextItem {
            is_current: current.as_ref() == Some(&named.name),
            name: named.name,
            cluster: named.context.cluster,
            user: named.context.user,
        })
        .collect();

    Ok(KubeconfigSummary {
        current_context: current,
        contexts,
    })
}

fn resolve_paths(path_or_env: Option<String>) -> Result<Vec<PathBuf>, KubeconfigError> {
    if let Some(value) = path_or_env {
        return Ok(split_kubeconfig_env(&value));
    }

    if let Ok(env_value) = std::env::var("KUBECONFIG") {
        let paths = split_kubeconfig_env(&env_value);
        if !paths.is_empty() {
            return Ok(paths);
        }
    }

    let default = default_kubeconfig_path();
    if default.exists() {
        Ok(vec![default])
    } else {
        Ok(vec![])
    }
}

fn default_kubeconfig_path() -> PathBuf {
    home_dir().join(".kube").join("config")
}

fn home_dir() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default())
    } else {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
    }
}

fn split_kubeconfig_env(value: &str) -> Vec<PathBuf> {
    value
        .split(path_separator())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn path_separator() -> &'static str {
    if cfg!(windows) { ";" } else { ":" }
}

fn load_single_file(path: &Path) -> Result<Kubeconfig, KubeconfigError> {
    if !path.exists() {
        return Err(KubeconfigError::NotFound {
            path: path.to_path_buf(),
        });
    }

    let content = std::fs::read_to_string(path).map_err(|source| KubeconfigError::ReadFailed {
        path: path.to_path_buf(),
        source,
    })?;

    serde_yaml_ng::from_str(&content).map_err(|source| KubeconfigError::ParseFailed {
        path: path.to_path_buf(),
        source,
    })
}

fn merge_kubeconfig(
    into: &mut Kubeconfig,
    file: Kubeconfig,
    path: &Path,
) -> Result<(), KubeconfigError> {
    if let (Some(existing), Some(incoming)) = (&into.kind, &file.kind) {
        if existing != incoming {
            return Err(KubeconfigError::MergeFailed(format!(
                "conflicting kubeconfig kind: '{}' vs '{}' in {}",
                existing,
                incoming,
                path.display()
            )));
        }
    }
    if let (Some(existing), Some(incoming)) = (&into.api_version, &file.api_version) {
        if existing != incoming {
            return Err(KubeconfigError::MergeFailed(format!(
                "conflicting kubeconfig apiVersion: '{}' vs '{}' in {}",
                existing,
                incoming,
                path.display()
            )));
        }
    }

    if into.kind.is_none() && file.kind.is_some() {
        into.kind.clone_from(&file.kind);
    }
    if into.api_version.is_none() && file.api_version.is_some() {
        into.api_version.clone_from(&file.api_version);
    }
    if into.current_context.is_none() && file.current_context.is_some() {
        into.current_context.clone_from(&file.current_context);
    }

    for named in file.clusters {
        merge_named(&mut into.clusters, named, path)?;
    }
    for named in file.contexts {
        merge_named(&mut into.contexts, named, path)?;
    }
    for named in file.users {
        merge_named(&mut into.users, named, path)?;
    }

    Ok(())
}

trait Named {
    fn name(&self) -> &str;
}

impl Named for NamedCluster {
    fn name(&self) -> &str {
        &self.name
    }
}

impl Named for NamedContext {
    fn name(&self) -> &str {
        &self.name
    }
}

impl Named for NamedUser {
    fn name(&self) -> &str {
        &self.name
    }
}

/// Kubernetes merge rule: the first file to set a particular map key wins.
fn merge_named<T: Named>(items: &mut Vec<T>, item: T, path: &Path) -> Result<(), KubeconfigError> {
    let name = item.name().to_owned();
    if items.iter().any(|i| i.name() == name) {
        tracing::debug!(path = %path.display(), name = %name, "skipping duplicate kubeconfig entry (first wins)");
    } else {
        items.push(item);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(content: &str) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(content.as_bytes()).unwrap();
        file.flush().unwrap();
        file
    }

    #[test]
    fn missing_file_returns_not_found() {
        let result = list_contexts(Some("/non/existent/kubeconfig".into()));
        let err = result.unwrap_err();
        assert_eq!(err.code(), "kubeconfig_not_found");
    }

    #[test]
    fn invalid_yaml_returns_parse_failed() {
        let file = write_temp("not: valid: yaml: [");
        let result = list_contexts(Some(file.path().to_string_lossy().into_owned()));
        let err = result.unwrap_err();
        assert_eq!(err.code(), "kubeconfig_parse_failed");
    }

    #[test]
    fn single_file_lists_contexts() {
        let file = write_temp(
            r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
clusters: []
users: []
"#,
        );

        let summary = list_contexts(Some(file.path().to_string_lossy().into_owned())).unwrap();
        assert_eq!(summary.current_context, Some("dev".into()));
        assert_eq!(summary.contexts.len(), 2);
        assert!(summary.contexts[0].is_current);
        assert_eq!(summary.contexts[0].name, "dev");
        assert_eq!(summary.contexts[0].cluster, "dev-cluster");
        assert_eq!(summary.contexts[0].user, Some("dev-user".into()));
        assert!(!summary.contexts[1].is_current);
    }

    #[test]
    fn multi_file_merge_keeps_first_wins() {
        let first = write_temp(
            r#"
apiVersion: v1
kind: Config
current-context: shared
contexts:
  - name: shared
    context:
      cluster: shared-cluster
      user: shared-user
  - name: first-only
    context:
      cluster: first-cluster
      user: first-user
"#,
        );
        let second = write_temp(
            r#"
apiVersion: v1
kind: Config
contexts:
  - name: shared
    context:
      cluster: overridden-cluster
      user: overridden-user
  - name: second-only
    context:
      cluster: second-cluster
      user: second-user
"#,
        );

        let env_value = format!(
            "{}{}{}",
            first.path().to_string_lossy(),
            path_separator(),
            second.path().to_string_lossy()
        );

        let summary = list_contexts(Some(env_value)).unwrap();
        assert_eq!(summary.current_context, Some("shared".into()));
        assert_eq!(summary.contexts.len(), 3);

        let shared = summary
            .contexts
            .iter()
            .find(|c| c.name == "shared")
            .unwrap();
        // First file wins: later definition of "shared" must be ignored.
        assert_eq!(shared.cluster, "shared-cluster");
        assert_eq!(shared.user, Some("shared-user".into()));
        assert!(shared.is_current);
    }

    #[test]
    fn conflicting_kind_returns_merge_failed() {
        let first = write_temp(
            r#"
apiVersion: v1
kind: Config
contexts: []
"#,
        );
        let second = write_temp(
            r#"
apiVersion: v1
kind: ConfigList
contexts: []
"#,
        );

        let env_value = format!(
            "{}{}{}",
            first.path().to_string_lossy(),
            path_separator(),
            second.path().to_string_lossy()
        );

        let result = list_contexts(Some(env_value));
        let err = result.unwrap_err();
        assert_eq!(err.code(), "kubeconfig_merge_failed");
        assert!(err.to_string().contains("conflicting kubeconfig kind"));
    }

    #[test]
    fn conflicting_api_version_returns_merge_failed() {
        let first = write_temp(
            r#"
apiVersion: v1
kind: Config
contexts: []
"#,
        );
        let second = write_temp(
            r#"
apiVersion: v2
kind: Config
contexts: []
"#,
        );

        let env_value = format!(
            "{}{}{}",
            first.path().to_string_lossy(),
            path_separator(),
            second.path().to_string_lossy()
        );

        let result = list_contexts(Some(env_value));
        let err = result.unwrap_err();
        assert_eq!(err.code(), "kubeconfig_merge_failed");
        assert!(
            err.to_string()
                .contains("conflicting kubeconfig apiVersion")
        );
    }
}

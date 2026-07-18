use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    pub sources: Vec<KubeconfigSourceSummary>,
    pub duplicate_contexts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub name: String,
    pub cluster: String,
    pub cluster_server: Option<String>,
    pub user: Option<String>,
    pub is_current: bool,
    pub source_path: Option<String>,
    pub source_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigSourceSummary {
    pub path: String,
    pub kind: String,
    pub file_count: usize,
    pub context_count: usize,
}

/// Discover and parse kubeconfig files.
///
/// * `None` - discover using `KUBECONFIG` env var or the default `%USERPROFILE%\.kube\config` path.
/// * `Some(path)` - treat as a single explicit path (used mainly in tests).
pub fn load_kubeconfig(path_or_env: Option<String>) -> Result<Kubeconfig, KubeconfigError> {
    let paths = resolve_paths(path_or_env)?;
    load_kubeconfig_files(&paths, default_kubeconfig_path())
}

/// List contexts in display order with the current context flagged.
pub fn list_contexts(path_or_env: Option<String>) -> Result<KubeconfigSummary, KubeconfigError> {
    let paths = resolve_paths(path_or_env)?;
    let config = load_kubeconfig_files(&paths, default_kubeconfig_path())?;
    let (context_sources, context_source_paths, context_cluster_servers, duplicate_contexts) =
        context_source_paths_for_files(&paths)?;
    let sources = paths
        .iter()
        .map(|path| summarize_file_source(path))
        .collect::<Result<Vec<_>, _>>()?;
    summarize_contexts(
        config,
        sources,
        context_sources,
        context_source_paths,
        context_cluster_servers,
        duplicate_contexts,
    )
}

/// List contexts from user-selected kubeconfig files or directories.
pub fn list_contexts_from_sources(
    sources: &[String],
) -> Result<KubeconfigSummary, KubeconfigError> {
    if sources.is_empty() {
        return list_contexts(None);
    }

    let mut merged = Kubeconfig::default();
    let mut summaries = Vec::new();
    let mut context_sources = HashMap::new();
    let mut context_source_paths = HashMap::new();
    let mut context_cluster_servers = HashMap::new();
    let mut duplicate_contexts = Vec::new();
    let mut saw_file = false;

    for source in sources {
        let path = PathBuf::from(source);
        if path.is_dir() {
            let files = collect_directory_files(&path)?;
            let mut source_summary = KubeconfigSourceSummary {
                path: path.to_string_lossy().into_owned(),
                kind: "directory".into(),
                file_count: 0,
                context_count: 0,
            };
            for file_path in files {
                let file = match load_single_file(&file_path) {
                    Ok(file) if is_probably_kubeconfig(&file) => file,
                    Ok(_) => continue,
                    Err(KubeconfigError::ParseFailed { .. }) => continue,
                    Err(KubeconfigError::ReadFailed { .. }) => continue,
                    Err(error) => return Err(error),
                };
                collect_context_source_paths(
                    &mut context_sources,
                    &mut context_source_paths,
                    &mut context_cluster_servers,
                    &mut duplicate_contexts,
                    &file_path,
                    &file,
                );
                source_summary.file_count += 1;
                source_summary.context_count += file.contexts.len();
                merge_kubeconfig(&mut merged, file, &file_path)?;
                saw_file = true;
            }
            summaries.push(source_summary);
        } else {
            let file = load_single_file(&path)?;
            collect_context_source_paths(
                &mut context_sources,
                &mut context_source_paths,
                &mut context_cluster_servers,
                &mut duplicate_contexts,
                &path,
                &file,
            );
            let context_count = file.contexts.len();
            merge_kubeconfig(&mut merged, file, &path)?;
            summaries.push(KubeconfigSourceSummary {
                path: path.to_string_lossy().into_owned(),
                kind: "file".into(),
                file_count: 1,
                context_count,
            });
            saw_file = true;
        }
    }

    if !saw_file {
        return Err(KubeconfigError::NotFound {
            path: sources
                .first()
                .map(PathBuf::from)
                .unwrap_or_else(default_kubeconfig_path),
        });
    }

    summarize_contexts(
        merged,
        summaries,
        context_sources,
        context_source_paths,
        context_cluster_servers,
        duplicate_contexts,
    )
}

pub fn resolve_kubeconfig_files_from_sources(
    sources: &[String],
) -> Result<Vec<PathBuf>, KubeconfigError> {
    if sources.is_empty() {
        return resolve_paths(None);
    }

    let mut result = Vec::new();
    for source in sources {
        let path = PathBuf::from(source);
        if path.is_dir() {
            for file_path in collect_directory_files(&path)? {
                match load_single_file(&file_path) {
                    Ok(file) if is_probably_kubeconfig(&file) => result.push(file_path),
                    Ok(_) => {}
                    Err(KubeconfigError::ParseFailed { .. }) => {}
                    Err(KubeconfigError::ReadFailed { .. }) => {}
                    Err(error) => return Err(error),
                }
            }
        } else {
            load_single_file(&path)?;
            result.push(path);
        }
    }
    Ok(result)
}

/// Find the kubeconfig file that defines the given context name.
///
/// Reads `KUBECONFIG` from the environment (or falls back to the default
/// `~/.kube/config`) and returns the first file whose `contexts` list contains
/// `context_name`. This is needed because multiple kubeconfig files often
/// reuse the same cluster/user names (e.g. `kubernetes` / `kubernetes-admin`),
/// and merging them via `KUBECONFIG` causes kubectl to resolve the wrong
/// cluster for a given context.
pub fn resolve_kubeconfig_file_for_context(
    context_name: &str,
) -> Result<Option<PathBuf>, KubeconfigError> {
    let env_value = std::env::var_os("KUBECONFIG");
    let paths: Vec<PathBuf> = if let Some(value) = env_value {
        split_kubeconfig_env(&value.to_string_lossy())
    } else {
        let default = default_kubeconfig_path();
        if default.exists() {
            vec![default]
        } else {
            vec![]
        }
    };

    resolve_kubeconfig_file_for_context_in_paths(context_name, paths)
}

fn resolve_kubeconfig_file_for_context_in_paths(
    context_name: &str,
    paths: Vec<PathBuf>,
) -> Result<Option<PathBuf>, KubeconfigError> {
    for path in paths {
        let file = load_single_file(&path)?;
        if file.contexts.iter().any(|named| named.name == context_name) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn summarize_contexts(
    config: Kubeconfig,
    sources: Vec<KubeconfigSourceSummary>,
    context_sources: HashMap<String, String>,
    context_source_paths: HashMap<String, Vec<String>>,
    context_cluster_servers: HashMap<String, Option<String>>,
    duplicate_contexts: Vec<String>,
) -> Result<KubeconfigSummary, KubeconfigError> {
    let current = config.current_context.clone();

    let contexts = config
        .contexts
        .into_iter()
        .map(|named| {
            let source_path = context_sources.get(&named.name).cloned();
            let source_paths = context_source_paths
                .get(&named.name)
                .cloned()
                .unwrap_or_default();
            let cluster_server = context_cluster_servers.get(&named.name).cloned().flatten();
            ContextItem {
                is_current: current.as_ref() == Some(&named.name),
                name: named.name,
                cluster: named.context.cluster,
                cluster_server,
                user: named.context.user,
                source_path,
                source_paths,
            }
        })
        .collect();

    Ok(KubeconfigSummary {
        current_context: current,
        contexts,
        sources,
        duplicate_contexts,
    })
}

fn load_kubeconfig_files(
    paths: &[PathBuf],
    not_found_path: PathBuf,
) -> Result<Kubeconfig, KubeconfigError> {
    if paths.is_empty() {
        return Err(KubeconfigError::NotFound {
            path: not_found_path,
        });
    }

    let mut merged = Kubeconfig::default();
    for path in paths {
        let file = load_single_file(path)?;
        merge_kubeconfig(&mut merged, file, path)?;
    }

    Ok(merged)
}

fn summarize_file_source(path: &Path) -> Result<KubeconfigSourceSummary, KubeconfigError> {
    let file = load_single_file(path)?;
    Ok(KubeconfigSourceSummary {
        path: path.to_string_lossy().into_owned(),
        kind: "file".into(),
        file_count: 1,
        context_count: file.contexts.len(),
    })
}

fn context_source_paths_for_files(
    paths: &[PathBuf],
) -> Result<
    (
        HashMap<String, String>,
        HashMap<String, Vec<String>>,
        HashMap<String, Option<String>>,
        Vec<String>,
    ),
    KubeconfigError,
> {
    let mut context_sources = HashMap::new();
    let mut context_source_paths = HashMap::new();
    let mut context_cluster_servers = HashMap::new();
    let mut duplicate_contexts = Vec::new();
    for path in paths {
        let file = load_single_file(path)?;
        collect_context_source_paths(
            &mut context_sources,
            &mut context_source_paths,
            &mut context_cluster_servers,
            &mut duplicate_contexts,
            path,
            &file,
        );
    }
    Ok((
        context_sources,
        context_source_paths,
        context_cluster_servers,
        duplicate_contexts,
    ))
}

fn collect_context_source_paths(
    context_sources: &mut HashMap<String, String>,
    context_source_paths: &mut HashMap<String, Vec<String>>,
    context_cluster_servers: &mut HashMap<String, Option<String>>,
    duplicate_contexts: &mut Vec<String>,
    path: &Path,
    file: &Kubeconfig,
) {
    let source_path = path.to_string_lossy().into_owned();
    let cluster_servers = file
        .clusters
        .iter()
        .map(|named| (named.name.as_str(), named.cluster.server.clone()))
        .collect::<HashMap<_, _>>();
    for named in &file.contexts {
        context_source_paths
            .entry(named.name.clone())
            .or_default()
            .push(source_path.clone());
        if context_sources.contains_key(&named.name) {
            duplicate_contexts.push(named.name.clone());
        } else {
            context_sources.insert(named.name.clone(), source_path.clone());
            context_cluster_servers.insert(
                named.name.clone(),
                cluster_servers
                    .get(named.context.cluster.as_str())
                    .cloned()
                    .flatten(),
            );
        }
    }
}
fn collect_directory_files(path: &Path) -> Result<Vec<PathBuf>, KubeconfigError> {
    let mut result = Vec::new();
    collect_directory_files_inner(path, &mut result)?;
    result.sort();
    Ok(result)
}

fn collect_directory_files_inner(
    path: &Path,
    result: &mut Vec<PathBuf>,
) -> Result<(), KubeconfigError> {
    for entry in std::fs::read_dir(path).map_err(|source| KubeconfigError::ReadFailed {
        path: path.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| KubeconfigError::ReadFailed {
            path: path.to_path_buf(),
            source,
        })?;
        let entry_path = entry.path();
        if entry_path.is_dir() {
            collect_directory_files_inner(&entry_path, result)?;
        } else if entry_path.is_file() {
            result.push(entry_path);
        }
    }
    Ok(())
}

fn is_probably_kubeconfig(file: &Kubeconfig) -> bool {
    file.kind.as_deref() == Some("Config") || !file.contexts.is_empty() || !file.clusters.is_empty()
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
    fn contexts_use_cluster_server_from_their_source_file() {
        let first = write_temp(
            r#"
apiVersion: v1
kind: Config
contexts:
  - name: first
    context:
      cluster: kubernetes
      user: first-user
clusters:
  - name: kubernetes
    cluster:
      server: https://10.0.0.1:6443
"#,
        );
        let second = write_temp(
            r#"
apiVersion: v1
kind: Config
contexts:
  - name: second
    context:
      cluster: kubernetes
      user: second-user
clusters:
  - name: kubernetes
    cluster:
      server: https://10.0.0.2:6443
"#,
        );

        let env_value = format!(
            "{}{}{}",
            first.path().to_string_lossy(),
            path_separator(),
            second.path().to_string_lossy()
        );

        let summary = list_contexts(Some(env_value)).unwrap();
        let first_context = summary.contexts.iter().find(|c| c.name == "first").unwrap();
        let second_context = summary
            .contexts
            .iter()
            .find(|c| c.name == "second")
            .unwrap();

        assert_eq!(
            first_context.cluster_server,
            Some("https://10.0.0.1:6443".into())
        );
        assert_eq!(
            second_context.cluster_server,
            Some("https://10.0.0.2:6443".into())
        );
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
        assert_eq!(
            shared.source_path,
            Some(first.path().to_string_lossy().into_owned())
        );
        assert_eq!(summary.duplicate_contexts, vec!["shared"]);
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

    #[test]
    fn resolving_context_file_surfaces_parse_errors() {
        let invalid = write_temp("not: valid: yaml: [");

        let result =
            resolve_kubeconfig_file_for_context_in_paths("dev", vec![invalid.path().to_path_buf()]);

        let err = result.unwrap_err();
        assert_eq!(err.code(), "kubeconfig_parse_failed");
    }
}

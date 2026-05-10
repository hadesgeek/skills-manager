use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::State;
use walkdir::WalkDir;

use crate::core::{
    central_repo,
    error::AppError,
    git_fetcher,
    install_cancel::InstallCancelRegistry,
    installer,
    repo_lock::RepoLock,
    skill_metadata::{self, is_valid_skill_dir},
    skill_store::{SkillRecord, SkillStore, SkillTargetRecord},
    sync_engine, sync_metadata,
};

#[derive(Debug, Serialize)]
pub struct UpdateSkillResult {
    pub skill: ManagedSkillDto,
    /// Whether the skill's file content actually changed.
    /// False when a monorepo commit didn't touch this skill's subdirectory.
    pub content_changed: bool,
}

#[derive(Debug, Serialize)]
pub struct BatchUpdateSkillsResult {
    pub refreshed: usize,
    pub unchanged: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BatchDeleteSkillsResult {
    pub deleted: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ManagedSkillDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub source_ref_resolved: Option<String>,
    pub source_subpath: Option<String>,
    pub source_branch: Option<String>,
    pub source_revision: Option<String>,
    pub remote_revision: Option<String>,
    pub update_status: String,
    pub last_checked_at: Option<i64>,
    pub last_check_error: Option<String>,
    pub central_path: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: String,
    pub targets: Vec<TargetDto>,
    pub scenario_ids: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TargetDto {
    pub id: String,
    pub skill_id: String,
    pub tool: String,
    pub target_path: String,
    pub mode: String,
    pub status: String,
    pub synced_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct SkillDocumentDto {
    pub skill_id: String,
    pub filename: String,
    pub content: String,
    pub central_path: String,
}

#[derive(Debug, Serialize)]
pub struct SourceSkillDocumentDto {
    pub skill_id: String,
    pub filename: String,
    pub content: String,
    pub source_label: String,
    pub revision: String,
}

#[derive(Debug, Clone)]
struct InstallSourceMetadata {
    source_type: String,
    source_ref: Option<String>,
    source_ref_resolved: Option<String>,
    source_subpath: Option<String>,
    source_branch: Option<String>,
    source_revision: Option<String>,
    remote_revision: Option<String>,
    update_status: String,
}

#[derive(Debug, Clone)]
struct GitSkillSource {
    clone_url: String,
    branch: Option<String>,
    subpath: Option<String>,
    locator_skill_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct GitSkillPreview {
    pub dir_name: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct GitPreviewResult {
    pub temp_dir: String,
    pub skills: Vec<GitSkillPreview>,
}

#[derive(Debug, serde::Deserialize)]
pub struct SkillInstallItem {
    pub dir_name: String,
    pub name: String,
}

struct CancelRegistrationGuard {
    registry: Arc<InstallCancelRegistry>,
    key: String,
}

impl CancelRegistrationGuard {
    fn new(registry: Arc<InstallCancelRegistry>, key: String) -> Self {
        Self { registry, key }
    }
}

impl Drop for CancelRegistrationGuard {
    fn drop(&mut self) {
        self.registry.remove(&self.key);
    }
}

#[tauri::command]
pub async fn get_managed_skills(
    store: State<'_, Arc<SkillStore>>,
) -> Result<Vec<ManagedSkillDto>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skills = store.get_all_skills().map_err(AppError::db)?;
        let all_targets = store.get_all_targets().map_err(AppError::db)?;
        let tags_map = store.get_tags_map().map_err(AppError::db)?;
        Ok(skills
            .into_iter()
            .map(|skill| managed_skill_to_dto(&store, skill, &all_targets, &tags_map))
            .collect())
    })
    .await?
}

#[tauri::command]
pub async fn get_skills_for_scenario(
    scenario_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<Vec<ManagedSkillDto>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skills = store
            .get_skills_for_scenario(&scenario_id)
            .map_err(AppError::db)?;
        let all_targets = store.get_all_targets().map_err(AppError::db)?;
        let tags_map = store.get_tags_map().map_err(AppError::db)?;

        Ok(skills
            .into_iter()
            .map(|skill| managed_skill_to_dto(&store, skill, &all_targets, &tags_map))
            .collect())
    })
    .await?
}

#[tauri::command]
pub async fn get_skill_document(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<SkillDocumentDto, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        let (filename, content) = read_skill_document_from_dir(Path::new(&skill.central_path))?;

        Ok(SkillDocumentDto {
            skill_id,
            filename,
            content,
            central_path: skill.central_path,
        })
    })
    .await?
}

#[tauri::command]
pub async fn get_source_skill_document(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<SourceSkillDocumentDto, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        if matches!(skill.source_type.as_str(), "local" | "import") {
            let source_path = skill.source_ref.as_ref().ok_or_else(|| {
                AppError::not_found("Local skill is missing its original source path")
            })?;
            let source_dir = PathBuf::from(source_path);
            if !source_dir.exists() {
                return Err(AppError::not_found("Original source path no longer exists"));
            }
            let (filename, content) = read_skill_document_from_dir(&source_dir)?;
            return Ok(SourceSkillDocumentDto {
                skill_id,
                filename,
                content,
                source_label: source_label_for_skill(&skill),
                revision: "workspace".to_string(),
            });
        }

        if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
            return Err(AppError::invalid_input(
                "Skill does not support source diff preview",
            ));
        }

        let git_source = git_source_from_skill(&skill)?;
        git_fetcher::validate_git_url(&git_source.clone_url).map_err(AppError::git)?;
        let remote_revision = git_fetcher::resolve_remote_revision(
            &git_source.clone_url,
            git_source.branch.as_deref(),
            proxy_url.as_deref(),
        )
        .map_err(AppError::git)?;

        let temp_dir = git_fetcher::clone_repo_ref(
            &git_source.clone_url,
            git_source.branch.as_deref(),
            None,
            proxy_url.as_deref(),
        )
        .map_err(AppError::classify_git_error)?;

        let result = (|| -> Result<SourceSkillDocumentDto, AppError> {
            git_fetcher::checkout_revision(&temp_dir, &remote_revision).map_err(AppError::git)?;
            let skill_dir = resolve_skill_dir(
                &temp_dir,
                git_source.subpath.as_deref(),
                git_source.locator_skill_id.as_deref(),
            )?;
            let (filename, content) = read_skill_document_from_dir(&skill_dir)?;

            Ok(SourceSkillDocumentDto {
                skill_id,
                filename,
                content,
                source_label: source_label_for_skill(&skill),
                revision: remote_revision,
            })
        })();

        git_fetcher::cleanup_temp(&temp_dir);
        result
    })
    .await?
}

fn read_skill_document_from_dir(dir: &Path) -> Result<(String, String), AppError> {
    let candidates = [
        "SKILL.md",
        "skill.md",
        "CLAUDE.md",
        "claude.md",
        "README.md",
        "readme.md",
    ];

    for name in &candidates {
        let path = dir.join(name);
        if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            return Ok((name.to_string(), content));
        }
    }

    for e in WalkDir::new(dir).max_depth(4).into_iter().flatten() {
        let fname = e.file_name().to_string_lossy();
        if candidates.contains(&fname.as_ref()) {
            let content = std::fs::read_to_string(e.path())?;
            return Ok((fname.to_string(), content));
        }
    }

    Err(AppError::not_found("No documentation file found"))
}

fn translation_filename(original: &str, lang_suffix: &str) -> String {
    // SKILL.md -> SKILL_cn.md, skill.md -> skill_cn.md
    if let Some(stem) = original.strip_suffix(".md") {
        format!("{stem}_{lang_suffix}.md")
    } else {
        format!("{original}_{lang_suffix}")
    }
}

fn lang_to_suffix(lang: &str) -> String {
    let lower = lang.to_lowercase();
    match lower.as_str() {
        "chinese" | "zh" | "zh-cn" | "zh_cn" => "cn".to_string(),
        "english" | "en" => "en".to_string(),
        "japanese" | "ja" | "jp" => "ja".to_string(),
        "korean" | "ko" | "kr" => "ko".to_string(),
        "french" | "fr" => "fr".to_string(),
        "german" | "de" => "de".to_string(),
        "spanish" | "es" => "es".to_string(),
        _ => lower,
    }
}

#[derive(Debug, Serialize)]
pub struct TranslationDocumentDto {
    pub skill_id: String,
    pub lang: String,
    pub filename: String,
    pub content: String,
}

#[tauri::command]
pub async fn get_translation_document(
    skill_id: String,
    lang: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<Option<TranslationDocumentDto>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        let dir = Path::new(&skill.central_path);
        let suffix = lang_to_suffix(&lang);

        // Find the original doc filename to derive the translation filename
        let candidates = [
            "SKILL.md",
            "skill.md",
            "CLAUDE.md",
            "claude.md",
            "README.md",
            "readme.md",
        ];

        let original_name = candidates
            .iter()
            .find(|name| dir.join(name).exists())
            .copied();

        let original_name = match original_name {
            Some(name) => name,
            None => return Ok(None),
        };

        let trans_name = translation_filename(original_name, &suffix);
        let trans_path = dir.join(&trans_name);

        if trans_path.exists() {
            let content = std::fs::read_to_string(&trans_path)?;
            Ok(Some(TranslationDocumentDto {
                skill_id,
                lang,
                filename: trans_name,
                content,
            }))
        } else {
            Ok(None)
        }
    })
    .await?
}

#[tauri::command]
pub async fn save_translation_document(
    skill_id: String,
    lang: String,
    content: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<TranslationDocumentDto, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        let dir = Path::new(&skill.central_path);
        let suffix = lang_to_suffix(&lang);

        let candidates = [
            "SKILL.md",
            "skill.md",
            "CLAUDE.md",
            "claude.md",
            "README.md",
            "readme.md",
        ];

        let original_name = candidates
            .iter()
            .find(|name| dir.join(name).exists())
            .copied()
            .unwrap_or("SKILL.md");

        let trans_name = translation_filename(original_name, &suffix);
        let trans_path = dir.join(&trans_name);

        std::fs::write(&trans_path, &content)?;

        Ok(TranslationDocumentDto {
            skill_id,
            lang,
            filename: trans_name,
            content,
        })
    })
    .await?
}

#[tauri::command]
pub async fn get_description_translation(
    skill_id: String,
    lang: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<Option<String>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        let dir = Path::new(&skill.central_path);
        let suffix = lang_to_suffix(&lang);

        // Read the translated SKILL file (e.g. SKILL_cn.md) and extract description from frontmatter
        let candidates = [
            "SKILL.md",
            "skill.md",
            "CLAUDE.md",
            "claude.md",
            "README.md",
            "readme.md",
        ];

        for &original_name in &candidates {
            let trans_name = translation_filename(original_name, &suffix);
            let trans_path = dir.join(&trans_name);
            if trans_path.exists() {
                let content = std::fs::read_to_string(&trans_path)?;
                let meta = skill_metadata::parse_frontmatter(&content);
                return Ok(meta.description);
            }
        }

        Ok(None)
    })
    .await?
}

fn source_label_for_skill(skill: &SkillRecord) -> String {
    match skill.source_type.as_str() {
        "skillssh" => "skills.sh".to_string(),
        "git" => "Git".to_string(),
        "local" => "Local".to_string(),
        "import" => "Imported".to_string(),
        other => other.to_string(),
    }
}

#[tauri::command]
pub async fn delete_managed_skill(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = delete_managed_skills_by_ids(&store, &[skill_id.clone()])?;
        if result.deleted == 0 {
            return Err(AppError::not_found("Skill not found"));
        }
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn delete_managed_skills(
    skill_ids: Vec<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<BatchDeleteSkillsResult, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || delete_managed_skills_by_ids(&store, &skill_ids))
        .await?
}

fn delete_managed_skills_by_ids(
    store: &SkillStore,
    skill_ids: &[String],
) -> Result<BatchDeleteSkillsResult, AppError> {
    sync_metadata::with_repo_lock("delete skills", || {
        let mut deleted = 0;
        let mut failed = Vec::new();

        for skill_id in skill_ids {
            let Some(skill) = store.get_skill_by_id(skill_id)? else {
                failed.push(skill_id.clone());
                continue;
            };

            let targets = store.get_targets_for_skill(skill_id)?;
            for target in &targets {
                let target_path = PathBuf::from(&target.target_path);
                sync_engine::remove_target(&target_path).ok();
            }

            let central = PathBuf::from(&skill.central_path);
            if central.exists() {
                std::fs::remove_dir_all(&central).ok();
            }

            store.delete_skill(skill_id)?;
            deleted += 1;
        }

        if deleted > 0 {
            sync_metadata::write_all_from_db_unlocked(store)?;
        }

        Ok(BatchDeleteSkillsResult { deleted, failed })
    })
    .map_err(AppError::db)
}

#[tauri::command]
pub async fn install_local(
    source_path: String,
    name: Option<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&source_path);
        let active = store.get_active_scenario_id().ok().flatten();
        let metadata = InstallSourceMetadata {
            source_type: "local".to_string(),
            source_ref: Some(source_path),
            source_ref_resolved: None,
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            update_status: "local_only".to_string(),
        };
        let _lock = RepoLock::acquire("install local skill")
            .map_err(AppError::db)?;
        let result = installer::install_from_local(&path, name.as_deref()).map_err(AppError::io)?;
        store_installed_skill_unlocked(&store, &result, &metadata, active.as_deref())?;

        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn install_git(
    repo_url: String,
    name: Option<String>,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppError> {
    git_fetcher::validate_git_url(&repo_url).map_err(AppError::git)?;
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let registry = cancel_registry.inner().clone();
    let cancel_key = repo_url.clone();
    let cancel = registry.register(&cancel_key);
    let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key);

    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let emit_progress = |phase: &str| {
            app_handle
                .emit(
                    "install-progress",
                    serde_json::json!({
                        "skill_id": repo_url,
                        "phase": phase,
                    }),
                )
                .ok();
        };

        emit_progress("cloning");
        let parsed = git_fetcher::parse_git_source(&repo_url);
        let app_for_progress = app_handle.clone();
        let url_for_progress = repo_url.clone();
        let progress_cb: git_fetcher::ProgressCallback = Box::new(move |msg: &str| {
            app_for_progress
                .emit(
                    "install-progress",
                    serde_json::json!({
                        "skill_id": url_for_progress,
                        "phase": "cloning",
                        "detail": msg,
                    }),
                )
                .ok();
        });
        let temp_dir = git_fetcher::clone_repo_ref_with_progress(
            &parsed.clone_url,
            parsed.branch.as_deref(),
            Some(&cancel),
            proxy_url.as_deref(),
            Some(progress_cb),
        )
        .map_err(AppError::classify_git_error)?;

        emit_progress("installing");
        let install_result = (|| -> Result<(), AppError> {
            let _lock = RepoLock::acquire("install git skill")
                .map_err(AppError::db)?;
            let active = store.get_active_scenario_id().ok().flatten();
            let skill_dir = resolve_skill_dir(&temp_dir, parsed.subpath.as_deref(), None)?;
            let revision = git_fetcher::get_head_revision(&temp_dir).map_err(AppError::git)?;
            let result = installer::install_from_git_dir(&skill_dir, name.as_deref())
                .map_err(AppError::io)?;
            let metadata = InstallSourceMetadata {
                source_type: "git".to_string(),
                source_ref: Some(parsed.original_url.clone()),
                source_ref_resolved: Some(parsed.clone_url.clone()),
                source_subpath: git_fetcher::relative_subpath(&temp_dir, &skill_dir),
                source_branch: parsed.branch.clone(),
                source_revision: Some(revision.clone()),
                remote_revision: Some(revision),
                update_status: "up_to_date".to_string(),
            };
            store_installed_skill_unlocked(&store, &result, &metadata, active.as_deref())?;
            Ok(())
        })();

        git_fetcher::cleanup_temp(&temp_dir);

        install_result?;

        emit_progress("done");
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn install_from_skillssh(
    source: String,
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let registry = cancel_registry.inner().clone();
    let cancel_key_owned = format!("{}/{}", source, skill_id);
    let cancel = registry.register(&cancel_key_owned);
    let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key_owned);

    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let skill_key = format!("{}/{}", source, skill_id);
        let emit_progress = |phase: &str| {
            app_handle
                .emit(
                    "install-progress",
                    serde_json::json!({
                        "skill_id": skill_key,
                        "phase": phase,
                    }),
                )
                .ok();
        };

        emit_progress("cloning");
        let repo_url = format!("https://github.com/{}.git", source);
        let app_for_progress = app_handle.clone();
        let skill_key_for_progress = skill_key.clone();
        let progress_cb: git_fetcher::ProgressCallback = Box::new(move |msg: &str| {
            app_for_progress
                .emit(
                    "install-progress",
                    serde_json::json!({
                        "skill_id": skill_key_for_progress,
                        "phase": "cloning",
                        "detail": msg,
                    }),
                )
                .ok();
        });
        let temp_dir = git_fetcher::clone_repo_ref_with_progress(
            &repo_url,
            None,
            Some(&cancel),
            proxy_url.as_deref(),
            Some(progress_cb),
        )
        .map_err(AppError::classify_git_error)?;

        emit_progress("installing");
        let install_result = (|| -> Result<(), AppError> {
            let _lock = RepoLock::acquire("install skillssh skill")
                .map_err(AppError::db)?;
            let active = store.get_active_scenario_id().ok().flatten();
            let skill_dir = resolve_skill_dir(&temp_dir, None, Some(&skill_id))?;
            let revision = git_fetcher::get_head_revision(&temp_dir).map_err(AppError::git)?;
            let source_ref = format!("{}/{}", source, skill_id);
            let (install_name, destination) =
                resolve_skillssh_install_target(&store, &source_ref, &skill_id)?;
            let result = installer::install_skill_dir_to_destination(
                &skill_dir,
                &install_name,
                &destination,
            )
            .map_err(AppError::io)?;
            let metadata = InstallSourceMetadata {
                source_type: "skillssh".to_string(),
                source_ref: Some(source_ref),
                source_ref_resolved: Some(repo_url.clone()),
                source_subpath: git_fetcher::relative_subpath(&temp_dir, &skill_dir),
                source_branch: None,
                source_revision: Some(revision.clone()),
                remote_revision: Some(revision),
                update_status: "up_to_date".to_string(),
            };
            store_installed_skill_unlocked(&store, &result, &metadata, active.as_deref())?;
            Ok(())
        })();

        git_fetcher::cleanup_temp(&temp_dir);

        install_result?;

        emit_progress("done");
        Ok(())
    })
    .await?
}

/// Clone a git repo and return a preview list of skills found, without installing.
/// The caller must follow up with `confirm_git_install` using the returned `temp_dir`.
#[tauri::command]
pub async fn preview_git_install(
    repo_url: String,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
    app_handle: tauri::AppHandle,
) -> Result<GitPreviewResult, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.get_setting("proxy_url").ok().flatten();
    let registry = cancel_registry.inner().clone();
    let cancel_key = repo_url.clone();
    let cancel = registry.register(&cancel_key);
    let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key);

    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        app_handle
            .emit(
                "install-progress",
                serde_json::json!({
                    "skill_id": repo_url,
                    "phase": "cloning",
                }),
            )
            .ok();

        let parsed = git_fetcher::parse_git_source(&repo_url);
        let app_for_progress = app_handle.clone();
        let url_for_progress = repo_url.clone();
        let progress_cb: git_fetcher::ProgressCallback = Box::new(move |msg: &str| {
            app_for_progress
                .emit(
                    "install-progress",
                    serde_json::json!({
                        "skill_id": url_for_progress,
                        "phase": "cloning",
                        "detail": msg,
                    }),
                )
                .ok();
        });
        let temp_dir = git_fetcher::clone_repo_ref_with_progress(
            &parsed.clone_url,
            parsed.branch.as_deref(),
            Some(&cancel),
            proxy_url.as_deref(),
            Some(progress_cb),
        )
        .map_err(AppError::classify_git_error)?;

        let build_preview = || -> Result<GitPreviewResult, AppError> {
            let skill_dir = resolve_skill_dir(&temp_dir, parsed.subpath.as_deref(), None)?;
            let dirs = collect_git_skill_dirs(&skill_dir);

            let skills: Vec<GitSkillPreview> = dirs
                .iter()
                .map(|dir| {
                    let meta = skill_metadata::parse_skill_md(dir);
                    let dir_name = dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "unknown".to_string());
                    let name = meta
                        .name
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| dir_name.clone());
                    GitSkillPreview {
                        dir_name,
                        name,
                        description: meta.description,
                    }
                })
                .collect();

            Ok(GitPreviewResult {
                temp_dir: temp_dir.to_string_lossy().to_string(),
                skills,
            })
        };

        build_preview().inspect_err(|_e| {
            git_fetcher::cleanup_temp(&temp_dir);
        })
    })
    .await?
}

/// Install selected skills from a previously cloned temp directory.
#[tauri::command]
pub async fn confirm_git_install(
    repo_url: String,
    temp_dir: String,
    items: Vec<SkillInstallItem>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let temp_path = validate_clone_temp_path(&temp_dir)?;

        let result: Result<(), AppError> = (|| {
            if items.is_empty() {
                return Ok(());
            }

            let parsed = git_fetcher::parse_git_source(&repo_url);
            let skill_dir = resolve_skill_dir(&temp_path, parsed.subpath.as_deref(), None)?;
            let all_dirs = collect_git_skill_dirs(&skill_dir);
            let revision = git_fetcher::get_head_revision(&temp_path).map_err(AppError::git)?;
            let active = store.get_active_scenario_id().ok().flatten();
            let _lock = RepoLock::acquire("confirm git install")
                .map_err(AppError::db)?;

            for dir in &all_dirs {
                let dir_name_entry = dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let item = match items.iter().find(|i| i.dir_name == dir_name_entry) {
                    Some(i) => i,
                    None => continue,
                };
                let custom_name = item.name.trim();
                let install_name = if custom_name.is_empty() {
                    None
                } else {
                    Some(custom_name)
                };
                let result =
                    installer::install_from_git_dir(dir, install_name).map_err(AppError::io)?;
                let subpath = git_fetcher::relative_subpath(&temp_path, dir);
                let metadata = InstallSourceMetadata {
                    source_type: "git".to_string(),
                    source_ref: Some(repo_url.clone()),
                    source_ref_resolved: Some(parsed.clone_url.clone()),
                    source_subpath: subpath,
                    source_branch: parsed.branch.clone(),
                    source_revision: Some(revision.clone()),
                    remote_revision: Some(revision.clone()),
                    update_status: "up_to_date".to_string(),
                };
                store_installed_skill_unlocked(&store, &result, &metadata, active.as_deref())?;
            }
            Ok(())
        })();

        // Always clean up temp directory, regardless of success or failure.
        git_fetcher::cleanup_temp(&temp_path);
        result
    })
    .await?
}

/// Clean up temp directory from a cancelled preview session.
#[tauri::command]
pub async fn cancel_git_preview(temp_dir: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(temp_path) = validate_clone_temp_path(&temp_dir) {
            git_fetcher::cleanup_temp(&temp_path);
        }
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn check_skill_update(
    skill_id: String,
    force: Option<bool>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<ManagedSkillDto, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    tauri::async_runtime::spawn_blocking(move || {
        check_skill_update_internal(
            &store,
            &skill_id,
            force.unwrap_or(false),
            proxy_url.as_deref(),
        )
    })
    .await?
}

#[tauri::command]
pub async fn check_all_skill_updates(
    force: Option<bool>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    tauri::async_runtime::spawn_blocking(move || {
        let force_check = force.unwrap_or(false);
        let ids: Vec<String> = store
            .get_all_skills()
            .map_err(AppError::db)?
            .into_iter()
            .map(|skill| skill.id)
            .collect();
        let mut failed = Vec::new();

        for skill_id in ids {
            if let Err(err) =
                check_skill_update_internal(&store, &skill_id, force_check, proxy_url.as_deref())
            {
                failed.push(format!("{skill_id}: {err}"));
            }
        }

        if failed.is_empty() {
            Ok(())
        } else {
            Err(AppError::internal(format!(
                "Failed to check {} skill(s): {}",
                failed.len(),
                failed.join("; ")
            )))
        }
    })
    .await?
}

#[tauri::command]
pub async fn update_skill(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
) -> Result<UpdateSkillResult, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let registry = cancel_registry.inner().clone();
    let cancel_key = format!("update:{}", skill_id);
    let cancel = registry.register(&cancel_key);
    let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key);

    tauri::async_runtime::spawn_blocking(move || {
        update_git_skill_internal(&store, &skill_id, proxy_url.as_deref(), Some(&cancel))
    })
    .await?
}

#[tauri::command]
pub async fn reimport_local_skill(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<ManagedSkillDto, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reimport_local_skill_internal(&store, &skill_id))
        .await?
}

#[tauri::command]
pub async fn batch_update_skills(
    skill_ids: Vec<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<BatchUpdateSkillsResult, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    tauri::async_runtime::spawn_blocking(move || {
        let mut refreshed = 0usize;
        let mut unchanged = 0usize;
        let mut failed = Vec::new();

        for skill_id in skill_ids {
            let skill = match store.get_skill_by_id(&skill_id).map_err(AppError::db)? {
                Some(skill) => skill,
                None => {
                    failed.push(format!("{skill_id}: Skill not found"));
                    continue;
                }
            };

            match skill.source_type.as_str() {
                "git" | "skillssh" => {
                    match update_git_skill_internal(&store, &skill_id, proxy_url.as_deref(), None) {
                        Ok(result) => {
                            if result.content_changed {
                                refreshed += 1;
                            } else {
                                unchanged += 1;
                            }
                        }
                        Err(err) => failed.push(format!("{}: {}", skill.name, err.message)),
                    }
                }
                "local" | "import" => match reimport_local_skill_internal(&store, &skill_id) {
                    Ok(_) => refreshed += 1,
                    Err(err) => failed.push(format!("{}: {}", skill.name, err.message)),
                },
                _ => failed.push(format!("{}: Source type cannot be refreshed", skill.name)),
            }
        }

        Ok(BatchUpdateSkillsResult {
            refreshed,
            unchanged,
            failed,
        })
    })
    .await?
}

#[tauri::command]
pub async fn relink_local_skill_source(
    skill_id: String,
    source_path: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<ManagedSkillDto, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        if !matches!(skill.source_type.as_str(), "local" | "import") {
            return Err(AppError::invalid_input(
                "Only local skills can relink source paths",
            ));
        }

        let path = PathBuf::from(&source_path);
        if !path.exists() {
            return Err(AppError::not_found("Selected source path does not exist"));
        }
        if !is_valid_skill_dir(&path) {
            return Err(AppError::invalid_input(
                "Selected source path is not a valid skill directory",
            ));
        }

        store
            .update_skill_update_status(&skill_id, "updating")
            .map_err(AppError::db)?;

        let result = (|| -> Result<(), AppError> {
            let _lock = RepoLock::acquire("relink local skill")
                .map_err(AppError::db)?;
            let staged_path = staged_path_for(&skill.central_path);
            let install_result = installer::install_from_local_to_destination(
                &path,
                Some(&skill.name),
                &staged_path,
            )
            .map_err(AppError::io)?;
            swap_skill_directory(&staged_path, Path::new(&skill.central_path))?;
            store
                .update_skill_after_reinstall(
                    &skill.id,
                    &skill.name,
                    install_result.description.as_deref(),
                    &skill.source_type,
                    Some(&source_path),
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(&install_result.content_hash),
                    "local_only",
                )
                .map_err(AppError::db)?;
            resync_copy_targets(&store, &skill.id)?;
            sync_metadata::write_all_from_db_unlocked(&store).map_err(AppError::db)?;
            Ok(())
        })();

        match result {
            Ok(()) => managed_skill_by_id(&store, &skill_id),
            Err(e) => {
                let _ = store.update_skill_check_state(&skill_id, None, "error", Some(&e.message));
                Err(e)
            }
        }
    })
    .await?
}

#[tauri::command]
pub async fn detach_local_skill_source(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<ManagedSkillDto, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        if !matches!(skill.source_type.as_str(), "local" | "import") {
            return Err(AppError::invalid_input(
                "Only local skills can detach source paths",
            ));
        }

        {
            let _lock = RepoLock::acquire("detach local skill")
                .map_err(AppError::db)?;
            store
                .update_skill_after_reinstall(
                    &skill.id,
                    &skill.name,
                    skill.description.as_deref(),
                    &skill.source_type,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    skill.content_hash.as_deref(),
                    "local_only",
                )
                .map_err(AppError::db)?;
            sync_metadata::write_all_from_db_unlocked(&store).map_err(AppError::db)?;
        }

        managed_skill_by_id(&store, &skill_id)
    })
    .await?
}

fn managed_skill_to_dto(
    store: &SkillStore,
    skill: SkillRecord,
    all_targets: &[SkillTargetRecord],
    tags_map: &std::collections::HashMap<String, Vec<String>>,
) -> ManagedSkillDto {
    let targets = all_targets
        .iter()
        .filter(|target| target.skill_id == skill.id)
        .map(|target| TargetDto {
            id: target.id.clone(),
            skill_id: target.skill_id.clone(),
            tool: target.tool.clone(),
            target_path: target.target_path.clone(),
            mode: target.mode.clone(),
            status: target.status.clone(),
            synced_at: target.synced_at,
        })
        .collect();

    let scenario_ids = store.get_scenarios_for_skill(&skill.id).unwrap_or_default();
    let tags = tags_map.get(&skill.id).cloned().unwrap_or_default();

    ManagedSkillDto {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source_type: skill.source_type,
        source_ref: skill.source_ref,
        source_ref_resolved: skill.source_ref_resolved,
        source_subpath: skill.source_subpath,
        source_branch: skill.source_branch,
        source_revision: skill.source_revision,
        remote_revision: skill.remote_revision,
        update_status: skill.update_status,
        last_checked_at: skill.last_checked_at,
        last_check_error: skill.last_check_error,
        central_path: skill.central_path,
        enabled: skill.enabled,
        created_at: skill.created_at,
        updated_at: skill.updated_at,
        status: skill.status,
        targets,
        scenario_ids,
        tags,
    }
}

fn managed_skill_by_id(store: &SkillStore, skill_id: &str) -> Result<ManagedSkillDto, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;
    let all_targets = store.get_all_targets().map_err(AppError::db)?;
    let tags_map = store.get_tags_map().map_err(AppError::db)?;
    Ok(managed_skill_to_dto(store, skill, &all_targets, &tags_map))
}

fn update_git_skill_internal(
    store: &SkillStore,
    skill_id: &str,
    proxy_url: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<UpdateSkillResult, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;

    if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
        return Err(AppError::invalid_input(
            "Only git-based skills can be updated",
        ));
    }

    let git_source = git_source_from_skill(&skill)?;
    git_fetcher::validate_git_url(&git_source.clone_url).map_err(AppError::git)?;
    let remote_revision = git_fetcher::resolve_remote_revision(
        &git_source.clone_url,
        git_source.branch.as_deref(),
        proxy_url,
    )
    .map_err(|e| {
        let message = e.to_string();
        let _ = store.update_skill_check_state(
            skill_id,
            skill.remote_revision.as_deref(),
            "error",
            Some(&message),
        );
        AppError::git(message)
    })?;

    store
        .update_skill_update_status(skill_id, "updating")
        .map_err(AppError::db)?;

    let temp_dir = git_fetcher::clone_repo_ref(
        &git_source.clone_url,
        git_source.branch.as_deref(),
        cancel,
        proxy_url,
    )
    .map_err(AppError::classify_git_error)?;
    let update_result = (|| -> Result<bool, AppError> {
        git_fetcher::checkout_revision(&temp_dir, &remote_revision).map_err(AppError::git)?;
        let skill_dir = resolve_skill_dir(
            &temp_dir,
            git_source.subpath.as_deref(),
            git_source.locator_skill_id.as_deref(),
        )?;

        let new_hash =
            crate::core::content_hash::hash_directory(&skill_dir).map_err(AppError::io)?;
        let content_changed = skill.content_hash.as_deref() != Some(new_hash.as_str());
        let source_subpath = git_fetcher::relative_subpath(&temp_dir, &skill_dir);
        let _lock = RepoLock::acquire("update installed skill")
            .map_err(AppError::db)?;

        if content_changed {
            let staged_path = staged_path_for(&skill.central_path);
            let install_result =
                installer::install_skill_dir_to_destination(&skill_dir, &skill.name, &staged_path)
                    .map_err(AppError::io)?;
            swap_skill_directory(&staged_path, Path::new(&skill.central_path))?;

            store
                .update_skill_source_metadata(
                    &skill.id,
                    Some(&git_source.clone_url),
                    source_subpath.as_deref(),
                    git_source.branch.as_deref(),
                    Some(&remote_revision),
                )
                .map_err(AppError::db)?;
            store
                .update_skill_after_install(
                    &skill.id,
                    &skill.name,
                    install_result.description.as_deref(),
                    Some(&remote_revision),
                    Some(&remote_revision),
                    Some(&install_result.content_hash),
                    "up_to_date",
                )
                .map_err(AppError::db)?;
            resync_copy_targets(store, &skill.id)?;
            sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
        } else {
            store
                .update_skill_source_metadata(
                    &skill.id,
                    Some(&git_source.clone_url),
                    source_subpath.as_deref(),
                    git_source.branch.as_deref(),
                    Some(&remote_revision),
                )
                .map_err(AppError::db)?;
            store
                .update_skill_check_state(&skill.id, Some(&remote_revision), "up_to_date", None)
                .map_err(AppError::db)?;
            resync_copy_targets(store, &skill.id)?;
            sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
        }
        Ok(content_changed)
    })();
    git_fetcher::cleanup_temp(&temp_dir);

    match update_result {
        Ok(content_changed) => {
            let skill = managed_skill_by_id(store, skill_id)?;
            Ok(UpdateSkillResult {
                skill,
                content_changed,
            })
        }
        Err(e) => {
            let _ = store.update_skill_check_state(
                skill_id,
                Some(&remote_revision),
                "error",
                Some(&e.message),
            );
            Err(e)
        }
    }
}

fn reimport_local_skill_internal(
    store: &SkillStore,
    skill_id: &str,
) -> Result<ManagedSkillDto, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;

    if !matches!(skill.source_type.as_str(), "local" | "import") {
        return Err(AppError::invalid_input(
            "Only local skills can be reimported",
        ));
    }

    let source_path = skill
        .source_ref
        .clone()
        .ok_or_else(|| AppError::not_found("Local skill is missing its original source path"))?;
    let path = PathBuf::from(&source_path);
    if !path.exists() {
        store
            .update_skill_check_state(
                &skill.id,
                None,
                "source_missing",
                Some("Original source path no longer exists"),
            )
            .map_err(AppError::db)?;
        return Err(AppError::not_found("Original source path no longer exists"));
    }

    store
        .update_skill_update_status(skill_id, "updating")
        .map_err(AppError::db)?;

    let result = (|| -> Result<(), AppError> {
        let _lock = RepoLock::acquire("reimport local skill")
            .map_err(AppError::db)?;
        let staged_path = staged_path_for(&skill.central_path);
        let install_result =
            installer::install_from_local_to_destination(&path, Some(&skill.name), &staged_path)
                .map_err(AppError::io)?;
        swap_skill_directory(&staged_path, Path::new(&skill.central_path))?;
        store
            .update_skill_after_install(
                &skill.id,
                &skill.name,
                install_result.description.as_deref(),
                None,
                None,
                Some(&install_result.content_hash),
                "local_only",
            )
            .map_err(AppError::db)?;
        resync_copy_targets(store, &skill.id)?;
        sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
        Ok(())
    })();

    match result {
        Ok(()) => managed_skill_by_id(store, skill_id),
        Err(e) => {
            let _ = store.update_skill_check_state(skill_id, None, "error", Some(&e.message));
            Err(e)
        }
    }
}

fn store_installed_skill_unlocked(
    store: &SkillStore,
    result: &installer::InstallResult,
    metadata: &InstallSourceMetadata,
    active_scenario_id: Option<&str>,
) -> Result<String, AppError> {
    let now = chrono::Utc::now().timestamp_millis();
    let central_path = result.central_path.to_string_lossy().to_string();

    if let Some(existing) = store
        .get_skill_by_central_path(&central_path)
        .map_err(AppError::db)?
    {
        store
            .update_skill_after_reinstall(
                &existing.id,
                &result.name,
                result.description.as_deref(),
                &metadata.source_type,
                metadata.source_ref.as_deref(),
                metadata.source_ref_resolved.as_deref(),
                metadata.source_subpath.as_deref(),
                metadata.source_branch.as_deref(),
                metadata.source_revision.as_deref(),
                metadata.remote_revision.as_deref(),
                Some(&result.content_hash),
                &metadata.update_status,
            )
            .map_err(AppError::db)?;
        if let Some(scenario_id) = active_scenario_id {
            store
                .add_skill_to_scenario(scenario_id, &existing.id)
                .map_err(AppError::db)?;
        }
        sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;

        if let Some(scenario_id) = active_scenario_id {
            if let Err(e) =
                super::scenarios::sync_skill_to_active_scenario(store, scenario_id, &existing.id)
            {
                log::warn!("Failed to sync reinstalled skill to scenario: {e}");
            }
        }

        return Ok(existing.id);
    }

    let id = uuid::Uuid::new_v4().to_string();

    let record = SkillRecord {
        id: id.clone(),
        name: result.name.clone(),
        description: result.description.clone(),
        source_type: metadata.source_type.clone(),
        source_ref: metadata.source_ref.clone(),
        source_ref_resolved: metadata.source_ref_resolved.clone(),
        source_subpath: metadata.source_subpath.clone(),
        source_branch: metadata.source_branch.clone(),
        source_revision: metadata.source_revision.clone(),
        remote_revision: metadata.remote_revision.clone(),
        central_path,
        content_hash: Some(result.content_hash.clone()),
        enabled: true,
        created_at: now,
        updated_at: now,
        status: "ok".to_string(),
        update_status: metadata.update_status.clone(),
        last_checked_at: Some(now),
        last_check_error: None,
    };

    store.insert_skill(&record).map_err(AppError::db)?;
    if let Some(scenario_id) = active_scenario_id {
        store
            .add_skill_to_scenario(scenario_id, &id)
            .map_err(AppError::db)?;
    }
    sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;

    if let Some(scenario_id) = active_scenario_id {
        if let Err(e) = super::scenarios::sync_skill_to_active_scenario(store, scenario_id, &id) {
            log::warn!("Failed to sync newly installed skill to scenario: {e}");
        }
    }

    Ok(id)
}

fn check_skill_update_internal(
    store: &SkillStore,
    skill_id: &str,
    force: bool,
    proxy_url: Option<&str>,
) -> Result<ManagedSkillDto, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;

    if should_skip_update_check(store, &skill, force)? {
        return managed_skill_by_id(store, skill_id);
    }

    match skill.source_type.as_str() {
        "git" | "skillssh" => {
            let git_source = git_source_from_skill(&skill)?;
            let metadata_updated = skill.source_ref_resolved.as_deref()
                != Some(git_source.clone_url.as_str())
                || skill.source_subpath.as_deref() != git_source.subpath.as_deref()
                || skill.source_branch.as_deref() != git_source.branch.as_deref();
            if metadata_updated {
                store
                    .update_skill_source_metadata(
                        &skill.id,
                        Some(&git_source.clone_url),
                        git_source.subpath.as_deref(),
                        git_source.branch.as_deref(),
                        skill.source_revision.as_deref(),
                    )
                    .map_err(AppError::db)?;
            }

            match git_fetcher::resolve_remote_revision(
                &git_source.clone_url,
                git_source.branch.as_deref(),
                proxy_url,
            ) {
                Ok(remote_revision) => {
                    let update_status = match skill.source_revision.as_deref() {
                        Some(current) if current == remote_revision => "up_to_date",
                        Some(_) => "update_available",
                        None => "unknown",
                    };
                    store
                        .update_skill_check_state(
                            &skill.id,
                            Some(&remote_revision),
                            update_status,
                            None,
                        )
                        .map_err(AppError::db)?;
                }
                Err(err) => {
                    let message = err.to_string();
                    store
                        .update_skill_check_state(
                            &skill.id,
                            skill.remote_revision.as_deref(),
                            "error",
                            Some(&message),
                        )
                        .map_err(AppError::db)?;
                    return Err(AppError::git(message));
                }
            }
        }
        "local" | "import" => {
            let (status, error): (&str, Option<String>) = match skill.source_ref.as_deref() {
                Some(path) => {
                    let source_path = Path::new(path);
                    if !source_path.exists() {
                        (
                            "source_missing",
                            Some("Original source path no longer exists".to_string()),
                        )
                    } else {
                        match installer::hash_local_source(source_path) {
                            Ok(live_hash) => match skill.content_hash.as_deref() {
                                Some(stored) if stored == live_hash.as_str() => {
                                    ("up_to_date", None)
                                }
                                Some(_) => ("update_available", None),
                                None => ("local_only", None),
                            },
                            Err(err) => ("error", Some(err.to_string())),
                        }
                    }
                }
                None => ("local_only", None),
            };
            store
                .update_skill_check_state(&skill.id, None, status, error.as_deref())
                .map_err(AppError::db)?;
        }
        _ => {
            store
                .update_skill_check_state(&skill.id, None, "unknown", None)
                .map_err(AppError::db)?;
        }
    }

    managed_skill_by_id(store, skill_id)
}

fn should_skip_update_check(
    store: &SkillStore,
    skill: &SkillRecord,
    force: bool,
) -> Result<bool, AppError> {
    if force {
        return Ok(false);
    }

    let ttl_minutes = store
        .get_setting("update_check_ttl_minutes")
        .map_err(AppError::db)?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(60);
    let ttl_ms = ttl_minutes * 60 * 1000;
    let stable_status = !matches!(
        skill.update_status.as_str(),
        "unknown" | "checking" | "updating" | "error"
    );

    Ok(stable_status
        && skill
            .last_checked_at
            .map(|checked| chrono::Utc::now().timestamp_millis() - checked < ttl_ms)
            .unwrap_or(false))
}

fn git_source_from_skill(skill: &SkillRecord) -> Result<GitSkillSource, AppError> {
    if let Some(resolved) = &skill.source_ref_resolved {
        return Ok(GitSkillSource {
            clone_url: resolved.clone(),
            branch: skill.source_branch.clone(),
            subpath: skill.source_subpath.clone(),
            locator_skill_id: skill_ssh_id(skill),
        });
    }

    match skill.source_type.as_str() {
        "git" => {
            let source_ref = skill
                .source_ref
                .as_ref()
                .ok_or_else(|| AppError::invalid_input("Git skill is missing its source URL"))?;
            let parsed = git_fetcher::parse_git_source(source_ref);
            Ok(GitSkillSource {
                clone_url: parsed.clone_url,
                branch: parsed.branch,
                subpath: skill.source_subpath.clone().or(parsed.subpath),
                locator_skill_id: None,
            })
        }
        "skillssh" => {
            let source_ref = skill.source_ref.as_ref().ok_or_else(|| {
                AppError::invalid_input("skills.sh skill is missing its source reference")
            })?;
            let (repo_source, fallback_skill_id) = source_ref
                .rsplit_once('/')
                .ok_or_else(|| AppError::invalid_input("Invalid skills.sh source reference"))?;
            Ok(GitSkillSource {
                clone_url: format!("https://github.com/{}.git", repo_source),
                branch: skill.source_branch.clone(),
                subpath: skill.source_subpath.clone(),
                locator_skill_id: Some(fallback_skill_id.to_string()),
            })
        }
        _ => Err(AppError::invalid_input(
            "Skill does not support git-based updates",
        )),
    }
}

fn skill_ssh_id(skill: &SkillRecord) -> Option<String> {
    if skill.source_type != "skillssh" {
        return None;
    }

    skill.source_ref.as_deref().and_then(|source_ref| {
        source_ref
            .rsplit_once('/')
            .map(|(_, skill_id)| skill_id.to_string())
    })
}

/// Return the list of individual skill directories to install from a resolved repo dir.
/// If `skill_dir` is itself a valid skill, returns `[skill_dir]`.
/// Otherwise enumerates immediate subdirs that are valid skills; falls back to `[skill_dir]`.
fn collect_git_skill_dirs(skill_dir: &Path) -> Vec<PathBuf> {
    if is_valid_skill_dir(skill_dir) {
        return vec![skill_dir.to_path_buf()];
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(skill_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && is_valid_skill_dir(p))
        .collect();
    dirs.sort();
    if dirs.is_empty() {
        vec![skill_dir.to_path_buf()]
    } else {
        dirs
    }
}

/// Validate and canonicalize a temp directory path used by the git preview/install flow.
/// Returns the canonicalized path if it passes security checks.
fn validate_clone_temp_path(temp_dir: &str) -> Result<PathBuf, AppError> {
    let raw_path = PathBuf::from(temp_dir);
    if !raw_path.exists() {
        return Err(AppError::invalid_input(
            "Clone session expired, please try again",
        ));
    }
    // Canonicalize to resolve symlinks and `..` segments before checking prefix.
    let temp_path = raw_path
        .canonicalize()
        .map_err(|_| AppError::invalid_input("Invalid temp directory"))?;

    // Preview confirmation must operate on an isolated checkout, never the repo cache.
    let expected_prefix = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    if temp_path.starts_with(&expected_prefix) {
        let dir_name_str = temp_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if dir_name_str.starts_with(git_fetcher::CLONE_TEMP_PREFIX) {
            return Ok(temp_path);
        }
    }

    Err(AppError::invalid_input("Invalid temp directory"))
}

fn resolve_skill_dir(
    repo_dir: &Path,
    subpath: Option<&str>,
    skill_id: Option<&str>,
) -> Result<PathBuf, AppError> {
    if let Some(subpath) = subpath {
        let path = repo_dir.join(subpath);
        if path.exists() && path.is_dir() {
            return Ok(path);
        }
    }

    git_fetcher::find_skill_dir(repo_dir, skill_id).map_err(AppError::git)
}

fn resolve_skillssh_install_target(
    store: &SkillStore,
    source_ref: &str,
    skill_id: &str,
) -> Result<(String, PathBuf), AppError> {
    if let Some(existing) = store
        .get_skill_by_source_ref("skillssh", source_ref)
        .map_err(AppError::db)?
    {
        return Ok((existing.name, PathBuf::from(existing.central_path)));
    }

    let base_name = skill_id.trim();
    if base_name.is_empty() {
        return Err(AppError::invalid_input("Skill id is empty"));
    }

    let mut attempt = 1;
    loop {
        let candidate_name = if attempt == 1 {
            base_name.to_string()
        } else {
            format!("{base_name}-{attempt}")
        };
        let candidate_path = central_repo::skills_dir().join(&candidate_name);
        let candidate_path_str = candidate_path.to_string_lossy().to_string();
        let occupied = store
            .get_skill_by_central_path(&candidate_path_str)
            .map_err(AppError::db)?
            .is_some();

        if !occupied {
            return Ok((candidate_name, candidate_path));
        }

        attempt += 1;
    }
}

fn staged_path_for(central_path: &str) -> PathBuf {
    let path = PathBuf::from(central_path);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    path.with_file_name(format!(".{file_name}.staged-{}", uuid::Uuid::new_v4()))
}

fn swap_skill_directory(staged_path: &Path, current_path: &Path) -> Result<(), AppError> {
    let backup_path = current_path.with_file_name(format!(
        ".{}.backup-{}",
        current_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".to_string()),
        uuid::Uuid::new_v4()
    ));

    if current_path.exists() {
        std::fs::rename(current_path, &backup_path)?;
    }

    if let Err(err) = std::fs::rename(staged_path, current_path) {
        if backup_path.exists() {
            let _ = std::fs::rename(&backup_path, current_path);
        }
        let _ = remove_path_if_exists(staged_path);
        return Err(err.into());
    }

    remove_path_if_exists(&backup_path)?;
    Ok(())
}

fn resync_copy_targets(store: &SkillStore, skill_id: &str) -> Result<(), AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;
    let source = PathBuf::from(&skill.central_path);
    let targets = store
        .get_targets_for_skill(skill_id)
        .map_err(AppError::db)?;

    for target in targets {
        if target.mode != "copy" {
            continue;
        }

        sync_engine::sync_skill(
            &source,
            Path::new(&target.target_path),
            sync_engine::SyncMode::Copy,
        )
        .map_err(AppError::io)?;

        let updated_target = SkillTargetRecord {
            synced_at: Some(chrono::Utc::now().timestamp_millis()),
            status: "ok".to_string(),
            last_error: None,
            ..target
        };
        store.insert_target(&updated_target).map_err(AppError::db)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_all_tags(store: State<'_, Arc<SkillStore>>) -> Result<Vec<String>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.get_all_tags().map_err(AppError::db)).await?
}

#[tauri::command]
pub async fn set_skill_tags(
    skill_id: String,
    tags: Vec<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        sync_metadata::with_repo_lock("set skill tags", || {
            store.set_tags_for_skill(&skill_id, &tags)?;
            sync_metadata::ensure_skill_metadata_unlocked(&store, &skill_id)
        })
        .map_err(AppError::db)
    })
    .await?
}

#[tauri::command]
pub async fn cancel_install(
    key: String,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
) -> Result<bool, AppError> {
    Ok(cancel_registry.cancel(&key))
}

#[derive(Debug, Serialize)]
pub struct BatchImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn batch_import_folder(
    folder_path: String,
    store: State<'_, Arc<SkillStore>>,
    app_handle: tauri::AppHandle,
) -> Result<BatchImportResult, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;

        let root = PathBuf::from(&folder_path);
        if !root.is_dir() {
            return Err(AppError::invalid_input("Selected path is not a directory"));
        }

        // Collect valid skill subdirectories (depth=1)
        let mut skill_dirs: Vec<PathBuf> = Vec::new();
        let entries = std::fs::read_dir(&root)?;
        for entry in entries.flatten() {
            let path = entry.path();
            if is_valid_skill_dir(&path) {
                skill_dirs.push(path);
            }
        }

        if skill_dirs.is_empty() {
            return Ok(BatchImportResult {
                imported: 0,
                skipped: 0,
                errors: vec![],
            });
        }

        let total = skill_dirs.len();
        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut errors = Vec::new();
        let active = store.get_active_scenario_id().ok().flatten();

        for (i, dir) in skill_dirs.iter().enumerate() {
            let name = skill_metadata::infer_skill_name(dir);

            app_handle
                .emit(
                    "batch-import-progress",
                    serde_json::json!({
                        "current": i + 1,
                        "total": total,
                        "name": &name,
                    }),
                )
                .ok();

            // Check if already imported by prospective central path
            let prospective_central = central_repo::skills_dir().join(&name);
            let central_str = prospective_central.to_string_lossy().to_string();
            if let Ok(Some(existing)) = store.get_skill_by_central_path(&central_str) {
                if let Some(ref scenario_id) = active {
                    if let Err(e) = store.add_skill_to_scenario(scenario_id, &existing.id) {
                        errors.push(format!("{}: {}", name, e));
                        continue;
                    }
                }
                skipped += 1;
                continue;
            }

            let install_result = (|| -> Result<String, AppError> {
                let _lock = RepoLock::acquire("batch import skill")
                    .map_err(AppError::db)?;
                let result =
                    installer::install_from_local(dir, Some(&name)).map_err(AppError::io)?;
                let metadata = InstallSourceMetadata {
                    source_type: "local".to_string(),
                    source_ref: Some(dir.to_string_lossy().to_string()),
                    source_ref_resolved: None,
                    source_subpath: None,
                    source_branch: None,
                    source_revision: None,
                    remote_revision: None,
                    update_status: "local_only".to_string(),
                };
                store_installed_skill_unlocked(&store, &result, &metadata, active.as_deref())
            })();

            match install_result {
                Ok(_) => imported += 1,
                Err(e) => errors.push(format!("{}: {}", name, e)),
            }
        }

        Ok(BatchImportResult {
            imported,
            skipped,
            errors,
        })
    })
    .await?
}

fn remove_path_if_exists(path: &Path) -> Result<(), AppError> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::{tempdir, TempDir};

    struct TestRepo {
        _lock: std::sync::MutexGuard<'static, ()>,
        _tmp: TempDir,
        store: SkillStore,
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            central_repo::set_test_base_dir_override(None);
        }
    }

    fn test_repo() -> TestRepo {
        let lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();
        TestRepo {
            _lock: lock,
            _tmp: tmp,
            store,
        }
    }

    fn write_skill_dir(name: &str) -> PathBuf {
        let dir = central_repo::skills_dir().join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
        dir
    }

    fn sample_skill(id: &str, name: &str, central_path: &Path) -> SkillRecord {
        SkillRecord {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            source_type: "import".to_string(),
            source_ref: Some(central_path.to_string_lossy().to_string()),
            source_ref_resolved: None,
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            central_path: central_path.to_string_lossy().to_string(),
            content_hash: None,
            enabled: true,
            created_at: 1,
            updated_at: 1,
            status: "ok".to_string(),
            update_status: "local_only".to_string(),
            last_checked_at: None,
            last_check_error: None,
        }
    }

    #[test]
    fn batch_delete_removes_skills_targets_and_stale_metadata_once() {
        let repo = test_repo();
        let skill_one_dir = write_skill_dir("skill-one");
        let skill_two_dir = write_skill_dir("skill-two");
        repo.store
            .insert_skill(&sample_skill("skill-1", "skill-one", &skill_one_dir))
            .unwrap();
        repo.store
            .insert_skill(&sample_skill("skill-2", "skill-two", &skill_two_dir))
            .unwrap();

        let target_dir = repo._tmp.path().join("target-skill-one");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("SKILL.md"), "# target").unwrap();
        repo.store
            .insert_target(&SkillTargetRecord {
                id: "target-1".to_string(),
                skill_id: "skill-1".to_string(),
                tool: "cursor".to_string(),
                target_path: target_dir.to_string_lossy().to_string(),
                mode: "symlink".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
            })
            .unwrap();

        sync_metadata::write_all_from_db_unlocked(&repo.store).unwrap();
        assert!(sync_metadata::metadata_dir()
            .join("skills/skill-1.json")
            .exists());
        assert!(sync_metadata::metadata_dir()
            .join("skills/skill-2.json")
            .exists());

        let result = delete_managed_skills_by_ids(
            &repo.store,
            &["skill-1".to_string(), "missing-skill".to_string()],
        )
        .unwrap();

        assert_eq!(result.deleted, 1);
        assert_eq!(result.failed, vec!["missing-skill".to_string()]);
        assert!(repo.store.get_skill_by_id("skill-1").unwrap().is_none());
        assert!(repo.store.get_skill_by_id("skill-2").unwrap().is_some());
        assert!(!skill_one_dir.exists());
        assert!(skill_two_dir.exists());
        assert!(!target_dir.exists());
        assert!(!sync_metadata::metadata_dir()
            .join("skills/skill-1.json")
            .exists());
        assert!(sync_metadata::metadata_dir()
            .join("skills/skill-2.json")
            .exists());
    }
}

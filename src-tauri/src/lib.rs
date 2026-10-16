//! Application ObsiLan (Windows .exe et Android .apk).
//!
//! Le Rust ne s'occupe que des fichiers : lecture, écriture atomique,
//! renommage, corbeille et surveillance du dossier. Toute l'interface et la
//! recherche sont en TypeScript (dossier client/).

mod vault;

use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use vault::{check_rel, is_note, NoteContent, NoteData, Result, SaveResult, TreeEntry, Vault, VaultError};

/// État partagé entre les commandes.
#[derive(Default)]
struct AppState {
    vault: Mutex<Option<Arc<Vault>>>,
    /// Surveillance du dossier (gardée en vie tant que le coffre est ouvert).
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl AppState {
    fn vault(&self) -> Result<Arc<Vault>> {
        self.vault
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| VaultError::new(503, "no_vault", "Aucun dossier de notes ouvert."))
    }
}

// --------------------------------------------------------- configuration

/// Préférences enregistrées dans le dossier de configuration de l'application.
#[derive(Serialize, Deserialize, Default)]
struct Config {
    vault: Option<String>,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &Config) -> Result<()> {
    let path = config_path(app).ok_or_else(|| VaultError::new(500, "config", "Dossier de configuration introuvable."))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| VaultError::new(500, "config", e.to_string()))?;
    vault::write_atomic(&path, json.as_bytes())?;
    Ok(())
}

// -------------------------------------------------- événements vers l'interface

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum VaultEvent {
    Tree,
    Note { path: String, hash: String },
    Removed { path: String },
}

/// Surveille le dossier et prévient l'interface des changements faits en
/// dehors de l'application (Obsidian, gestionnaire de fichiers, synchro…).
fn start_watcher(app: &AppHandle, vault: Arc<Vault>) -> Option<notify::RecommendedWatcher> {
    let handle = app.clone();
    let v = vault.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for path in &event.paths {
            let Some(rel) = v.rel_of(path) else { continue };
            // Éléments cachés (.trash, .obsidian, temporaires) : ignorés.
            if rel.split('/').any(|seg| seg.starts_with('.')) {
                continue;
            }
            let emit = |e: VaultEvent| {
                let _ = handle.emit("vault-event", e);
            };
            if path.is_dir() {
                emit(VaultEvent::Tree);
            } else if path.is_file() {
                if !is_note(&rel) {
                    continue;
                }
                if let Ok(note) = v.read(&rel) {
                    emit(VaultEvent::Note { path: rel.clone(), hash: note.hash });
                }
                if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))) {
                    emit(VaultEvent::Tree);
                }
            } else {
                // N'existe plus : supprimé, ou ancien nom d'un renommage.
                emit(VaultEvent::Removed { path: rel });
                emit(VaultEvent::Tree);
            }
        }
    })
    .ok()?;
    watcher.watch(&vault.root, RecursiveMode::Recursive).ok()?;
    Some(watcher)
}

// ------------------------------------------------------------- commandes

#[tauri::command]
fn is_mobile() -> bool {
    cfg!(mobile)
}

/// Dossier mémorisé, ou None au premier lancement.
#[tauri::command]
fn vault_root(app: AppHandle) -> Option<String> {
    load_config(&app).vault
}

/// Dossier proposé par défaut : Documents/ObsiLan.
#[tauri::command]
fn vault_default_root(app: AppHandle) -> Result<String> {
    #[cfg(target_os = "android")]
    {
        let _ = &app;
        // Stockage partagé, visible dans le gestionnaire de fichiers
        // (nécessite l'autorisation « Accès à tous les fichiers »).
        Ok("/storage/emulated/0/Documents/ObsiLan".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let docs = app
            .path()
            .document_dir()
            .map_err(|e| VaultError::new(500, "path", e.to_string()))?;
        Ok(docs.join("ObsiLan").to_string_lossy().into_owned())
    }
}

/// Stockage privé de l'application (repli si l'accès aux fichiers est refusé).
#[tauri::command]
fn vault_private_root(app: AppHandle) -> Result<String> {
    let dir = app.path().app_data_dir().map_err(|e| VaultError::new(500, "path", e.to_string()))?;
    Ok(dir.join("notes").to_string_lossy().into_owned())
}

/// Ouvre le coffre, le mémorise et démarre la surveillance du dossier.
#[tauri::command]
async fn vault_open(app: AppHandle, state: State<'_, AppState>, root: String) -> Result<String> {
    let vault = Arc::new(Vault::open(PathBuf::from(&root))?);
    let watcher = start_watcher(&app, vault.clone());
    *state.watcher.lock().unwrap_or_else(|e| e.into_inner()) = watcher;
    *state.vault.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault);
    save_config(&app, &Config { vault: Some(root.clone()) })?;
    Ok(root)
}

#[tauri::command]
async fn vault_tree(state: State<'_, AppState>) -> Result<Vec<TreeEntry>> {
    state.vault()?.tree()
}

#[tauri::command]
async fn vault_load_all(state: State<'_, AppState>) -> Result<Vec<NoteContent>> {
    state.vault()?.load_all()
}

#[tauri::command]
async fn note_read(state: State<'_, AppState>, path: String) -> Result<NoteData> {
    state.vault()?.read(&check_rel(&path)?)
}

#[tauri::command]
async fn note_save(
    state: State<'_, AppState>,
    path: String,
    content: String,
    base_hash: Option<String>,
) -> Result<SaveResult> {
    state.vault()?.save(&check_rel(&path)?, &content, base_hash.as_deref())
}

#[tauri::command]
async fn note_create(
    state: State<'_, AppState>,
    path: Option<String>,
    folder: Option<String>,
    content: Option<String>,
) -> Result<SaveResult> {
    let path = path.map(|p| check_rel(&p)).transpose()?;
    let folder = folder.map(|p| check_rel(&p)).transpose()?;
    state.vault()?.create_note(path.as_deref(), folder.as_deref(), content.as_deref().unwrap_or(""))
}

#[derive(Serialize)]
struct FolderResult {
    path: String,
}

#[tauri::command]
async fn folder_create(
    state: State<'_, AppState>,
    path: Option<String>,
    parent: Option<String>,
) -> Result<FolderResult> {
    let path = path.map(|p| check_rel(&p)).transpose()?;
    let parent = parent.map(|p| check_rel(&p)).transpose()?;
    let path = state.vault()?.create_folder(path.as_deref(), parent.as_deref())?;
    Ok(FolderResult { path })
}

#[tauri::command]
async fn entry_rename(state: State<'_, AppState>, from: String, to: String) -> Result<()> {
    state.vault()?.rename(&check_rel(&from)?, &check_rel(&to)?)
}

#[tauri::command]
async fn entry_trash(state: State<'_, AppState>, path: String) -> Result<String> {
    state.vault()?.trash(&check_rel(&path)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Ouverture du navigateur pour la connexion Discord.
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            is_mobile,
            vault_root,
            vault_default_root,
            vault_private_root,
            vault_open,
            vault_tree,
            vault_load_all,
            note_read,
            note_save,
            note_create,
            folder_create,
            entry_rename,
            entry_trash,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement d'ObsiLan");
}

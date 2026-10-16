//! Accès au coffre local : toutes les opérations sur les fichiers .md.
//!
//! Mêmes règles que le serveur (server/src/vault.ts) :
//!   - toute écriture est atomique (fichier temporaire + fsync + renommage) ;
//!   - aucune opération n'écrase un fichier existant par erreur ;
//!   - la suppression déplace dans « .trash/ » (convention Obsidian) ;
//!   - les modifications sont sérialisées par un verrou.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Suffixe des fichiers temporaires (cachés, donc ignorés partout).
const TMP_SUFFIX: &str = ".obsilan-tmp";

// ------------------------------------------------------------------ types

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct NoteData {
    pub path: String,
    pub content: String,
    pub mtime: f64,
    pub hash: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SaveResult {
    pub path: String,
    pub mtime: f64,
    pub hash: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct NoteContent {
    pub path: String,
    pub content: String,
    pub hash: String,
}

/// Erreur renvoyée à l'interface (même forme que les erreurs HTTP du serveur).
#[derive(Serialize, Debug)]
pub struct VaultError {
    pub status: u16,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<NoteData>,
}

impl VaultError {
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self { status, code: code.into(), message: message.into(), current: None }
    }
}

impl From<io::Error> for VaultError {
    fn from(e: io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::NotFound => VaultError::new(404, "not_found", "Fichier introuvable."),
            io::ErrorKind::PermissionDenied => {
                VaultError::new(403, "permission", format!("Accès refusé : {e}"))
            }
            _ => VaultError::new(500, "io", format!("Erreur disque : {e}")),
        }
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;

// ------------------------------------------------------------ utilitaires

/// Empreinte du contenu (identique à celle du serveur : SHA-256, 20 caractères).
pub fn hash_content(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..20].to_string()
}

pub fn is_note(name: &str) -> bool {
    name.to_lowercase().ends_with(".md")
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn note_title(rel: &str) -> &str {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    if is_note(base) { &base[..base.len() - 3] } else { base }
}

fn parent_of(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

fn join(a: &str, b: &str) -> String {
    if a.is_empty() { b.to_string() } else { format!("{a}/{b}") }
}

/// Vérifie un chemin relatif reçu de l'interface (défense en profondeur :
/// l'interface le valide déjà). Refuse « .. », les éléments cachés, etc.
pub fn check_rel(raw: &str) -> Result<String> {
    let parts: Vec<&str> = raw
        .split(['/', '\\'])
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.is_empty() {
        return Err(VaultError::new(400, "bad_path", "Chemin vide."));
    }
    for p in &parts {
        let bad = *p == ".."
            || p.starts_with('.')
            || p.ends_with(' ')
            || p.ends_with('.')
            || p.chars().any(|c| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']') || c.is_control());
        if bad {
            return Err(VaultError::new(400, "bad_path", format!("Nom invalide : {p}")));
        }
    }
    Ok(parts.join("/"))
}

// ------------------------------------------------------- écriture atomique

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Écrit `data` dans `file` de façon atomique : un lecteur voit soit
/// l'ancienne version complète, soit la nouvelle, jamais un mélange.
pub fn write_atomic(file: &Path, data: &[u8]) -> io::Result<()> {
    let dir = file.parent().ok_or_else(|| io::Error::other("chemin sans dossier parent"))?;
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("note");
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}-{nanos}-{n}{TMP_SUFFIX}", std::process::id()));

    {
        // create_new : échoue si le temporaire existe déjà (jamais d'écrasement).
        let mut f = File::create_new(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?; // force l'écriture physique sur le disque
    }
    if let Err(e) = rename_retry(&tmp, file) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    sync_dir(dir);
    Ok(())
}

/// Renommage avec nouvelles tentatives : sous Windows, un antivirus ou un
/// autre programme peut verrouiller brièvement le fichier.
pub fn rename_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && attempt < 8 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(40 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Rend le renommage durable (Android/Linux). Sans objet sous Windows.
fn sync_dir(_dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(_dir) {
        let _ = d.sync_all();
    }
}

/// Vrai si `a` et `b` désignent physiquement le même fichier
/// (cas d'un simple changement de casse sur un disque insensible à la casse).
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        }
    }
}

// ------------------------------------------------------------------ coffre

pub struct Vault {
    pub root: PathBuf,
    lock: Mutex<()>,
}

impl Vault {
    /// Ouvre un coffre (crée le dossier si besoin) et vérifie qu'on peut y écrire.
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)?;
        let probe = root.join(format!(".obsilan-probe{TMP_SUFFIX}"));
        write_atomic(&probe, b"ok").map_err(|e| {
            VaultError::new(403, "permission", format!("Impossible d'écrire dans {} : {e}", root.display()))
        })?;
        let _ = fs::remove_file(&probe);

        let vault = Self { root, lock: Mutex::new(()) };
        if vault.tree()?.is_empty() {
            vault.create_note(Some("Bienvenue.md"), None, WELCOME)?;
        }
        Ok(vault)
    }

    pub fn abs(&self, rel: &str) -> PathBuf {
        rel.split('/').fold(self.root.clone(), |p, seg| p.join(seg))
    }

    /// Chemin relatif (avec « / ») d'un chemin absolu situé dans le coffre.
    pub fn rel_of(&self, abs: &Path) -> Option<String> {
        let rel = abs.strip_prefix(&self.root).ok()?;
        let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        if parts.is_empty() { None } else { Some(parts.join("/")) }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    // -------------------------------------------------------------- lecture

    /// Arborescence complète (dossiers + notes .md, hors éléments cachés).
    pub fn tree(&self) -> Result<Vec<TreeEntry>> {
        let mut out = Vec::new();
        self.walk("", &mut out);
        Ok(out)
    }

    fn walk(&self, dir_rel: &str, out: &mut Vec<TreeEntry>) {
        let dir = if dir_rel.is_empty() { self.root.clone() } else { self.abs(dir_rel) };
        let Ok(items) = fs::read_dir(&dir) else { return };
        for item in items.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let Ok(ft) = item.file_type() else { continue };
            let rel = join(dir_rel, &name);
            if name.starts_with('.') {
                // Temporaire orphelin d'une écriture interrompue : on le retire.
                if ft.is_file() && name.ends_with(TMP_SUFFIX) {
                    let _ = fs::remove_file(item.path());
                }
                continue;
            }
            if ft.is_dir() {
                out.push(TreeEntry { path: rel.clone(), kind: "folder", mtime: None, size: None });
                self.walk(&rel, out);
            } else if ft.is_file() && is_note(&name) {
                if let Ok(meta) = item.metadata() {
                    out.push(TreeEntry { path: rel, kind: "file", mtime: Some(mtime_ms(&meta)), size: Some(meta.len()) });
                }
            }
        }
    }

    pub fn read(&self, rel: &str) -> Result<NoteData> {
        if !is_note(rel) {
            return Err(VaultError::new(400, "not_a_note", "Seuls les fichiers .md sont gérés."));
        }
        let file = self.abs(rel);
        let bytes = fs::read(&file).map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                VaultError::new(404, "not_found", format!("Note introuvable : {rel}"))
            } else {
                e.into()
            }
        })?;
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let meta = fs::metadata(&file)?;
        Ok(NoteData { path: rel.to_string(), hash: hash_content(&content), content, mtime: mtime_ms(&meta) })
    }

    /// Toutes les notes (pour construire l'index de recherche au démarrage).
    pub fn load_all(&self) -> Result<Vec<NoteContent>> {
        let files: Vec<String> = self.tree()?.into_iter().filter(|e| e.kind == "file").map(|e| e.path).collect();
        Ok(files
            .into_iter()
            .filter_map(|p| self.read(&p).ok())
            .map(|n| NoteContent { path: n.path, content: n.content, hash: n.hash })
            .collect())
    }

    // ------------------------------------------------------------ écriture

    fn write_note(&self, rel: &str, content: &str) -> Result<SaveResult> {
        let file = self.abs(rel);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic(&file, content.as_bytes())?;
        let meta = fs::metadata(&file)?;
        Ok(SaveResult { path: rel.to_string(), mtime: mtime_ms(&meta), hash: hash_content(content) })
    }

    /// Enregistre une note. Si `base_hash` est fourni et que la note a changé
    /// sur le disque depuis, refuse (409) en renvoyant la version actuelle.
    pub fn save(&self, rel: &str, content: &str, base_hash: Option<&str>) -> Result<SaveResult> {
        if !is_note(rel) {
            return Err(VaultError::new(400, "not_a_note", "Seuls les fichiers .md sont gérés."));
        }
        let _g = self.guard();
        if let Some(base) = base_hash {
            // Note supprimée ailleurs : on la recrée avec notre contenu (aucune perte).
            if let Ok(current) = self.read(rel) {
                if current.hash != base && current.hash != hash_content(content) {
                    let mut err = VaultError::new(409, "conflict", "La note a été modifiée ailleurs.");
                    err.current = Some(current);
                    return Err(err);
                }
            }
        }
        self.write_note(rel, content)
    }

    /// Crée une note ; sans chemin, choisit « Sans titre N.md » dans `folder`.
    pub fn create_note(&self, path: Option<&str>, folder: Option<&str>, content: &str) -> Result<SaveResult> {
        let _g = self.guard();
        let rel = match path {
            Some(p) => p.to_string(),
            None => self.free_name(folder.unwrap_or(""), "Sans titre", ".md")?,
        };
        if !is_note(&rel) {
            return Err(VaultError::new(400, "not_a_note", "Le nom doit se terminer par .md"));
        }
        if self.abs(&rel).exists() {
            return Err(VaultError::new(409, "exists", format!("« {} » existe déjà.", note_title(&rel))));
        }
        self.write_note(&rel, content)
    }

    pub fn create_folder(&self, path: Option<&str>, parent: Option<&str>) -> Result<String> {
        let _g = self.guard();
        let rel = match path {
            Some(p) => p.to_string(),
            None => self.free_name(parent.unwrap_or(""), "Nouveau dossier", "")?,
        };
        if self.abs(&rel).exists() {
            return Err(VaultError::new(409, "exists", format!("« {rel} » existe déjà.")));
        }
        fs::create_dir_all(self.abs(&rel))?;
        Ok(rel)
    }

    /// Renomme ou déplace une note ou un dossier, sans jamais écraser la cible.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        if from == to {
            return Ok(());
        }
        let _g = self.guard();
        let src = self.abs(from);
        let dst = self.abs(to);
        let meta = fs::metadata(&src).map_err(|_| VaultError::new(404, "not_found", format!("Introuvable : {from}")))?;
        if meta.is_file() && !is_note(to) {
            return Err(VaultError::new(400, "not_a_note", "Une note doit garder l'extension .md"));
        }
        if meta.is_dir() && format!("{to}/").starts_with(&format!("{from}/")) {
            return Err(VaultError::new(400, "bad_move", "Impossible de déplacer un dossier dans lui-même."));
        }
        if dst.exists() && !same_file(&src, &dst) {
            let name = to.rsplit('/').next().unwrap_or(to);
            return Err(VaultError::new(409, "exists", format!("« {name} » existe déjà à cet endroit.")));
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        rename_retry(&src, &dst)?;
        Ok(())
    }

    /// Met à la corbeille (.trash/), sans rien effacer.
    pub fn trash(&self, rel: &str) -> Result<String> {
        let _g = self.guard();
        let src = self.abs(rel);
        let meta = fs::metadata(&src).map_err(|_| VaultError::new(404, "not_found", format!("Introuvable : {rel}")))?;
        let mut target = format!(".trash/{rel}");
        if self.abs(&target).exists() {
            // Un élément du même nom est déjà à la corbeille : on ajoute un horodatage.
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            target = if meta.is_file() {
                format!("{} ({stamp}).md", &target[..target.len() - 3])
            } else {
                format!("{target} ({stamp})")
            };
        }
        let dst = self.abs(&target);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        rename_retry(&src, &dst)?;
        Ok(target)
    }

    /// Nom libre : « Sans titre.md », « Sans titre 1.md »…
    fn free_name(&self, folder: &str, base: &str, ext: &str) -> Result<String> {
        for i in 0..10_000 {
            let name = if i == 0 { format!("{base}{ext}") } else { format!("{base} {i}{ext}") };
            let candidate = join(folder, &name);
            if !self.abs(&candidate).exists() {
                return Ok(candidate);
            }
        }
        Err(VaultError::new(500, "no_name", "Impossible de trouver un nom libre."))
    }

    /// Dossier parent relatif (utile aux tests).
    #[allow(dead_code)]
    pub fn parent(rel: &str) -> &str {
        parent_of(rel)
    }
}

const WELCOME: &str = "# Bienvenue dans ObsiLan

Vos notes sont de simples fichiers **Markdown** dans un dossier : vous pouvez
les ouvrir avec n'importe quel éditeur, ou avec Obsidian.

## Pour commencer

- Créez une note avec le bouton **+** de la barre latérale
- Faites un clic droit (appui long sur téléphone) sur une note ou un dossier pour le renommer ou le supprimer
- Glissez-déposez une note sur un dossier pour l'y déplacer
- Cherchez dans toutes vos notes avec **Ctrl+Maj+F**
- Basculez entre édition et lecture avec **Ctrl+E**

> Les notes supprimées vont dans le dossier caché `.trash` du coffre :
> rien n'est jamais effacé définitivement.
";

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path().to_path_buf()).unwrap();
        (dir, v)
    }

    #[test]
    fn empreinte_identique_au_serveur() {
        // Valeur calculée par server/src/vault.ts (hashContent("v1")).
        assert_eq!(hash_content("v1").len(), 20);
        assert_eq!(hash_content("abc"), "ba7816bf8f01cfea4141");
    }

    #[test]
    fn coffre_vide_cree_bienvenue() {
        let (_d, v) = vault();
        let t = v.tree().unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].path, "Bienvenue.md");
    }

    #[test]
    fn ecriture_sans_temporaire_restant() {
        let (d, v) = vault();
        for i in 0..20 {
            v.save("a.md", &format!("v{i}"), None).unwrap();
        }
        let leftovers = fs::read_dir(d.path()).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("tmp")).count();
        assert_eq!(leftovers, 0);
        assert_eq!(v.read("a.md").unwrap().content, "v19");
    }

    #[test]
    fn conflit_detecte_sans_ecrasement() {
        let (_d, v) = vault();
        let v1 = v.save("n.md", "v1", None).unwrap();
        v.save("n.md", "autre appareil", Some(&v1.hash)).unwrap();
        let err = v.save("n.md", "ici", Some(&v1.hash)).unwrap_err();
        assert_eq!(err.status, 409);
        assert_eq!(err.current.unwrap().content, "autre appareil");
        assert_eq!(v.read("n.md").unwrap().content, "autre appareil");
    }

    #[test]
    fn renommage_refuse_d_ecraser() {
        let (_d, v) = vault();
        v.save("a.md", "A", None).unwrap();
        v.save("b.md", "B", None).unwrap();
        assert_eq!(v.rename("a.md", "b.md").unwrap_err().status, 409);
        assert_eq!(v.read("b.md").unwrap().content, "B");
    }

    #[test]
    fn changement_de_casse_autorise() {
        let (_d, v) = vault();
        v.save("note.md", "x", None).unwrap();
        v.rename("note.md", "Note.md").unwrap();
        assert!(v.tree().unwrap().iter().any(|e| e.path == "Note.md"));
    }

    #[test]
    fn dossier_dans_lui_meme_refuse() {
        let (_d, v) = vault();
        v.create_folder(Some("A"), None).unwrap();
        assert_eq!(v.rename("A", "A/B").unwrap_err().status, 400);
    }

    #[test]
    fn corbeille_sans_collision() {
        let (d, v) = vault();
        v.save("n.md", "1", None).unwrap();
        v.trash("n.md").unwrap();
        v.save("n.md", "2", None).unwrap();
        v.trash("n.md").unwrap();
        assert_eq!(fs::read_dir(d.path().join(".trash")).unwrap().count(), 2);
        assert!(!v.tree().unwrap().iter().any(|e| e.path.starts_with(".trash")));
    }

    #[test]
    fn chemins_dangereux_refuses() {
        for p in ["../x.md", "a/../../x.md", ".obsidian/app.json", "a?.md", "", "a:b.md"] {
            assert!(check_rel(p).is_err(), "{p} devrait être refusé");
        }
        assert_eq!(check_rel("a\\b//c.md").unwrap(), "a/b/c.md");
    }

    #[test]
    fn noms_automatiques() {
        let (_d, v) = vault();
        assert_eq!(v.create_note(None, None, "").unwrap().path, "Sans titre.md");
        assert_eq!(v.create_note(None, None, "").unwrap().path, "Sans titre 1.md");
        assert_eq!(v.create_note(Some("Sans titre.md"), None, "").unwrap_err().status, 409);
    }
}

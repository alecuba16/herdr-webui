use std::fs;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::server_settings::atomic_write;
use crate::WebState;

/// Server-wide scratchpad entries, shared by every connected client.
/// Content lives in a sidecar next to webui-settings.json so it survives
/// browser reloads, WebUI restarts, and auth session resets (none of those
/// touch the file), and it stays out of webui-settings.json so a debounced
/// note save never rewrites auth/bind config.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NoteEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub language: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub updated_by: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NotesState {
    pub notes: Vec<NoteEntry>,
}

pub(crate) const MAX_NOTES: usize = 200;
const MAX_TITLE_CHARS: usize = 200;
const MAX_CONTENT_BYTES: usize = 32 * 1024;
const NOTE_LANGUAGES: [(&str, &str, &str); 14] = [
    // (value, label, editor extension). The client renders this table as-is:
    // labels for the select, extension for the CodeMirror mount path.
    ("txt", "Text", "txt"),
    ("markdown", "Markdown", "md"),
    ("javascript", "JavaScript", "js"),
    ("typescript", "TypeScript", "ts"),
    ("rust", "Rust", "rs"),
    ("python", "Python", "py"),
    ("go", "Go", "go"),
    ("json", "JSON", "json"),
    ("yaml", "YAML", "yaml"),
    ("css", "CSS", "css"),
    ("html", "HTML", "html"),
    ("xml", "XML", "xml"),
    ("java", "Java", "java"),
    ("sql", "SQL", "sql"),
];

pub(crate) fn routes() -> Router<WebState> {
    Router::new()
        .route("/api/notes", get(notes_list).post(notes_create))
        .route(
            "/api/notes/{note_id}",
            axum::routing::put(notes_update).delete(notes_delete),
        )
        .route("/api/notes/clear", axum::routing::post(notes_clear))
}

#[allow(clippy::result_large_err)]
fn notes_auth(state: &WebState, headers: &HeaderMap, remote: SocketAddr) -> Result<(), Response> {
    crate::require_auth(state, headers, remote)
}

fn notes_json_error(status: StatusCode, message: String) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn notes_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("herdr-webui/notes.json");
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".config/herdr-webui/notes.json"))
        .unwrap_or_else(|_| std::env::temp_dir().join("herdr-webui/notes.json"))
}

pub(crate) fn load_notes() -> NotesState {
    let Ok(raw) = fs::read_to_string(notes_path()) else {
        return NotesState::default();
    };
    serde_json::from_str(&raw).unwrap_or_else(|err| {
        eprintln!("invalid notes.json, starting empty: {err}");
        NotesState::default()
    })
}

pub(crate) fn save_notes(state: &NotesState) -> io::Result<()> {
    let path = notes_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_string(state)?;
    atomic_write(&path, payload.as_bytes())
}

fn broadcast_notes(state: &WebState, snapshot: &NotesState) {
    // Same public shape as GET /api/notes: newest first, display_title
    // resolved, so adopting clients render identically without local logic.
    let mut payload = notes_public_json(snapshot);
    payload["type"] = serde_json::json!("notes_changed");
    let _ = state.notes_tx.send(payload);
}

fn notes_public_json(snapshot: &NotesState) -> serde_json::Value {
    // Server owns the list contract: newest first, display_title resolved,
    // language table attached. Clients render, they do not sort or derive.
    let mut notes = snapshot.notes.clone();
    notes.sort_by_key(|note| std::cmp::Reverse(note.updated_at));
    let notes: Vec<serde_json::Value> = notes
        .iter()
        .map(|note| {
            let mut value = serde_json::to_value(note).unwrap_or_default();
            value["display_title"] = serde_json::json!(note_display_title(note));
            value
        })
        .collect();
    serde_json::json!({
        "notes": notes,
        "languages": note_languages_json(),
    })
}

/// The empty title falls back to the first content line ("Untitled" when
/// the content is empty too), computed server-side so every client renders
/// the same label for the same note.
fn note_display_title(note: &NoteEntry) -> String {
    let title = note.title.trim();
    if !title.is_empty() {
        return title.to_string();
    }
    note.content
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "Untitled".to_string())
}

fn note_languages_json() -> serde_json::Value {
    NOTE_LANGUAGES
        .iter()
        .map(
            |(value, label, ext)| serde_json::json!({ "value": value, "label": label, "ext": ext }),
        )
        .collect::<Vec<_>>()
        .into()
}

/// Note id, same entropy recipe as auth session tokens (OS-seeded
/// RandomState + nanosecond clock, hashed): no new dependency, and two ids
/// minted in the same second still differ.
fn fresh_note_id() -> String {
    use std::hash::BuildHasher;
    let mut seed = Sha256::new();
    let os_entropy = std::hash::RandomState::new().hash_one(SystemTime::now());
    seed.update(os_entropy.to_le_bytes());
    seed.update(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
            .to_le_bytes(),
    );
    seed.update((fresh_note_id as *const () as usize).to_le_bytes());
    seed.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Mutate the store, persist, and broadcast. One lock scope covers
/// mutate+snapshot so the broadcast always matches the disk write; a client
/// that misses the frame self-heals on the next GET.
async fn apply_notes(
    state: &WebState,
    mutate: impl FnOnce(&mut NotesState) -> Result<(), (StatusCode, String)>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let snapshot = {
        let Ok(mut guard) = state.notes.lock() else {
            return Err((StatusCode::SERVICE_UNAVAILABLE, "notes unavailable".into()));
        };
        mutate(&mut guard)?;
        guard.clone()
    };
    let persist = {
        let snapshot = snapshot.clone();
        tokio::task::spawn_blocking(move || save_notes(&snapshot))
    };
    match persist.await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err((StatusCode::INTERNAL_SERVER_ERROR, err.to_string())),
        Err(err) => return Err((StatusCode::INTERNAL_SERVER_ERROR, err.to_string())),
    }
    broadcast_notes(state, &snapshot);
    Ok(notes_public_json(&snapshot))
}

#[derive(Deserialize)]
struct NoteCreateRequest {
    title: Option<String>,
    content: Option<String>,
    language: Option<String>,
}

#[derive(Deserialize)]
struct NoteUpdateRequest {
    title: Option<String>,
    content: Option<String>,
    language: Option<String>,
}

fn validate_title(raw: Option<&str>) -> Result<String, (StatusCode, String)> {
    let trimmed = raw.unwrap_or("").trim().to_string();
    if trimmed.chars().count() > MAX_TITLE_CHARS {
        return Err((StatusCode::BAD_REQUEST, "title too long".into()));
    }
    Ok(trimmed)
}

fn validate_language(raw: Option<&str>) -> Result<String, (StatusCode, String)> {
    let language = raw.unwrap_or("txt").to_string();
    if !NOTE_LANGUAGES
        .iter()
        .any(|(value, _, _)| *value == language)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("unsupported language: {language}"),
        ));
    }
    Ok(language)
}

fn validate_content(raw: &str) -> Result<String, (StatusCode, String)> {
    if raw.len() > MAX_CONTENT_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "content too large".into()));
    }
    Ok(raw.to_string())
}

async fn notes_list(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = notes_auth(&state, &headers, remote) {
        return response;
    }
    let snapshot = state.notes.lock().map(|guard| guard.clone());
    match snapshot {
        Ok(snapshot) => Json(notes_public_json(&snapshot)).into_response(),
        Err(_) => notes_json_error(StatusCode::SERVICE_UNAVAILABLE, "notes unavailable".into()),
    }
}

async fn notes_create(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<NoteCreateRequest>,
) -> Response {
    if let Err(response) = notes_auth(&state, &headers, remote) {
        return response;
    }
    let title = match validate_title(body.title.as_deref()) {
        Ok(title) => title,
        Err(err) => return notes_json_error(err.0, err.1),
    };
    let content = match validate_content(body.content.as_deref().unwrap_or("")) {
        Ok(content) => content,
        Err(err) => return notes_json_error(err.0, err.1),
    };
    let language = match validate_language(body.language.as_deref()) {
        Ok(language) => language,
        Err(err) => return notes_json_error(err.0, err.1),
    };
    let updated_by = updated_by_label(&state);
    let now = crate::unix_now_seconds();
    let created_id = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let id_slot = created_id.clone();
    let result = apply_notes(&state, move |notes| {
        if notes.notes.len() >= MAX_NOTES {
            return Err((StatusCode::UNPROCESSABLE_ENTITY, "too many notes".into()));
        }
        let id = fresh_note_id();
        notes.notes.push(NoteEntry {
            id: id.clone(),
            title,
            content,
            language,
            created_at: now,
            updated_at: now,
            updated_by,
        });
        if let Ok(mut slot) = id_slot.lock() {
            *slot = Some(id);
        }
        Ok(())
    })
    .await;
    match result {
        Ok(mut value) => {
            if let Ok(slot) = created_id.lock() {
                if let Some(id) = slot.as_ref() {
                    value["created_note_id"] = serde_json::json!(id);
                }
            }
            (StatusCode::CREATED, Json(value)).into_response()
        }
        Err((status, message)) => notes_json_error(status, message),
    }
}

async fn notes_update(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Path(note_id): Path<String>,
    Json(body): Json<NoteUpdateRequest>,
) -> Response {
    if let Err(response) = notes_auth(&state, &headers, remote) {
        return response;
    }
    let title = match body.title {
        Some(ref title) => match validate_title(Some(title)) {
            Ok(title) => Some(title),
            Err(err) => return notes_json_error(err.0, err.1),
        },
        None => None,
    };
    let content = match body.content {
        Some(ref content) => match validate_content(content) {
            Ok(content) => Some(content),
            Err(err) => return notes_json_error(err.0, err.1),
        },
        None => None,
    };
    let language = match body.language {
        Some(ref language) => match validate_language(Some(language)) {
            Ok(language) => Some(language),
            Err(err) => return notes_json_error(err.0, err.1),
        },
        None => None,
    };
    let updated_by = updated_by_label(&state);
    let now = crate::unix_now_seconds();
    let result = apply_notes(&state, move |notes| {
        let Some(note) = notes.notes.iter_mut().find(|note| note.id == note_id) else {
            return Err((StatusCode::NOT_FOUND, "note not found".into()));
        };
        if let Some(title) = title {
            note.title = title;
        }
        if let Some(content) = content {
            note.content = content;
        }
        if let Some(language) = language {
            note.language = language;
        }
        note.updated_at = now;
        note.updated_by = updated_by;
        Ok(())
    })
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err((status, message)) => notes_json_error(status, message),
    }
}

async fn notes_delete(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Path(note_id): Path<String>,
) -> Response {
    if let Err(response) = notes_auth(&state, &headers, remote) {
        return response;
    }
    let result = apply_notes(&state, move |notes| {
        let before = notes.notes.len();
        notes.notes.retain(|note| note.id != note_id);
        if notes.notes.len() == before {
            return Err((StatusCode::NOT_FOUND, "note not found".into()));
        }
        Ok(())
    })
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err((status, message)) => notes_json_error(status, message),
    }
}

async fn notes_clear(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = notes_auth(&state, &headers, remote) {
        return response;
    }
    let result = apply_notes(&state, move |notes| {
        notes.notes.clear();
        Ok(())
    })
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err((status, message)) => notes_json_error(status, message),
    }
}

fn updated_by_label(state: &WebState) -> String {
    state
        .auth
        .lock()
        .ok()
        .and_then(|auth| auth.user.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same recipe contract as auth session tokens: ids minted in a tight
    /// loop (well within one second) must still be unique, or the store
    /// would silently overwrite an older note on create.
    #[test]
    fn fresh_note_ids_differ_within_a_tight_loop() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(fresh_note_id()));
        }
    }
}

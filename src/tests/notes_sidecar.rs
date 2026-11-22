//! Notes sidecar tests.

use super::common::*;
use super::*;
use crate::tests::{env_lock, lock_env};

/// Notes CRUD round-trips through the real router: create, list, update,
/// delete, all behind require_auth. Persistence lands in the notes.json
/// sidecar under the isolated XDG_CONFIG_HOME, never webui-settings.json.
#[tokio::test]
// The env lock must span the whole test: XDG_CONFIG_HOME is process-global
// and every await point races the other env-dependent suites. Notes tests
// are the only lock users in this file, so the guard cannot deadlock.
#[allow(clippy::await_holding_lock)]
async fn notes_routes_crud_round_trip() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-notes-crud");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let app = test_app();

    let unauthenticated = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/notes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let create = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "title": "deploy steps", "content": "cargo build", "language": "rust" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);
    let created = response_json(create).await;
    let notes = created["notes"].as_array().expect("notes array");
    assert_eq!(notes.len(), 1);
    let note_id = notes[0]["id"].as_str().expect("note id").to_string();
    assert_eq!(notes[0]["title"], "deploy steps");
    assert_eq!(notes[0]["content"], "cargo build");
    assert_eq!(notes[0]["language"], "rust");
    assert_eq!(notes[0]["updated_by"], "user");

    let update = app
        .clone()
        .oneshot(
            request(Method::PUT, &format!("/api/notes/{note_id}"))
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "content": "cargo build --release", "language": "markdown" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(update.status(), StatusCode::OK);
    let updated = response_json(update).await;
    assert_eq!(updated["notes"][0]["content"], "cargo build --release");
    assert_eq!(updated["notes"][0]["language"], "markdown");
    // Partial update: the title survives a content-only PUT.
    assert_eq!(updated["notes"][0]["title"], "deploy steps");
    // The update stamps the acting user; this was the abc5f46 regression.
    assert_eq!(updated["notes"][0]["updated_by"], "user");

    // Unknown ids are 404, not a silent success.
    let missing = app
        .clone()
        .oneshot(
            request(Method::PUT, "/api/notes/does-not-exist")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "content": "x" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    // The sidecar exists and holds exactly the note; settings stay untouched.
    let sidecar = config_home.join("herdr-webui/notes.json");
    let raw = fs::read_to_string(&sidecar).expect("notes.json sidecar");
    let persisted: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(persisted["notes"].as_array().unwrap().len(), 1);
    assert_eq!(persisted["notes"][0]["content"], "cargo build --release");
    assert!(!config_home.join("herdr-webui/webui-settings.json").exists());

    let delete = app
        .clone()
        .oneshot(
            request(Method::DELETE, &format!("/api/notes/{note_id}"))
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete.status(), StatusCode::OK);
    let deleted = response_json(delete).await;
    assert_eq!(deleted["notes"].as_array().unwrap().len(), 0);

    let redelete = app
        .clone()
        .oneshot(
            request(Method::DELETE, &format!("/api/notes/{note_id}"))
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(redelete.status(), StatusCode::NOT_FOUND);

    std::env::remove_var("XDG_CONFIG_HOME");
}

/// The server owns the list contract: newest-first order, display_title
/// fallback resolved per entry, the language table attached, and the
/// created_note_id pointing at the exact note the client must open.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn notes_list_contract_is_server_owned() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-notes-contract");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Seed the sidecar with insertion order deliberately older-first so a
    // pass-through list would expose it; the server must re-sort newest
    // first regardless of storage order.
    let sidecar_dir = config_home.join("herdr-webui");
    fs::create_dir_all(&sidecar_dir).unwrap();
    let seeded = json!({
        "notes": [
            { "id": "a-old", "title": "titled old", "content": "old body", "language": "txt",
              "created_at": 1000, "updated_at": 1000, "updated_by": "user" },
            { "id": "b-new", "title": "", "content": "first line is the title\nsecond line", "language": "txt",
              "created_at": 2000, "updated_at": 2000, "updated_by": "user" },
            { "id": "c-empty", "title": "", "content": "", "language": "txt",
              "created_at": 3000, "updated_at": 3000, "updated_by": "user" }
        ]
    });
    fs::write(
        sidecar_dir.join("notes.json"),
        serde_json::to_string(&seeded).unwrap(),
    )
    .unwrap();

    // test_state() seeds the store with NotesState::default(); load from
    // the sidecar the same way a reboot would so the GET exercises the
    // seeded entries.
    let mut state = test_state();
    state.notes = Arc::new(Mutex::new(notes::load_notes()));
    let app = app_router(state);
    let response = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/notes")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let payload = response_json(response).await;

    let notes = payload["notes"].as_array().expect("notes array");
    assert_eq!(notes.len(), 3);
    assert_eq!(
        notes[0]["id"], "c-empty",
        "newest first despite storage order"
    );
    assert_eq!(notes[1]["id"], "b-new");
    assert_eq!(notes[2]["id"], "a-old");

    // display_title: explicit title, first content line, Untitled fallback.
    assert_eq!(notes[2]["display_title"], "titled old");
    assert_eq!(notes[1]["display_title"], "first line is the title");
    assert_eq!(notes[0]["display_title"], "Untitled");

    // The language table rides along: value, label, editor extension.
    let languages = payload["languages"].as_array().expect("languages array");
    assert_eq!(languages.len(), 14);
    let rust = languages
        .iter()
        .find(|entry| entry["value"] == "rust")
        .expect("rust entry");
    assert_eq!(rust["label"], "Rust");
    assert_eq!(rust["ext"], "rs");

    // created_note_id names the note the client must open after POST.
    let create = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "title": "", "content": "", "language": "txt" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);
    let created = response_json(create).await;
    let created_id = created["created_note_id"]
        .as_str()
        .expect("created_note_id");
    let listed: Vec<&str> = created["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|note| note["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        listed.first(),
        Some(&created_id),
        "the created note leads the list"
    );
    assert!(listed.contains(&"a-old"), "preexisting notes still listed");

    std::env::remove_var("XDG_CONFIG_HOME");
}

/// Validation caps: oversized titles and content are rejected, unknown
/// languages are rejected, the 200-entry ceiling holds.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn notes_routes_validation_caps() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-notes-caps");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let app = test_app();
    let cookie = "herdr_web_session=token-123";

    let oversized_title = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "title": "x".repeat(201) }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(oversized_title.status(), StatusCode::BAD_REQUEST);

    let oversized_content = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "content": "x".repeat(32 * 1024 + 1) }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(oversized_content.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let bad_language = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "language": "cobol" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_language.status(), StatusCode::BAD_REQUEST);

    // Fill to the cap. The sidecar keeps this fast: entries are tiny.
    for index in 0..notes::MAX_NOTES {
        let created = app
            .clone()
            .oneshot(
                request(Method::POST, "/api/notes")
                    .header(header::COOKIE, cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "title": format!("note {index}") }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED, "fill note {index}");
    }
    let over = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "title": "one too many" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(over.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Clear-all empties the store and the sidecar.
    let clear = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes/clear")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(clear.status(), StatusCode::OK);
    let cleared = response_json(clear).await;
    assert_eq!(cleared["notes"].as_array().unwrap().len(), 0);
    let raw = fs::read_to_string(config_home.join("herdr-webui/notes.json")).unwrap();
    let persisted: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(persisted["notes"].as_array().unwrap().len(), 0);

    // The title cap counts characters, not bytes: 201 multibyte
    // characters must be rejected while 200 still fit, pinning the
    // doc claim of a 200-character cap against a byte-counting
    // regression that would cut accented and CJK titles early. Runs on
    // the cleared store so the fill-to-cap loop above keeps its count.
    let oversized_multibyte_title = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "title": "é".repeat(201) }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(oversized_multibyte_title.status(), StatusCode::BAD_REQUEST);
    let full_multibyte_title = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "title": "é".repeat(200) }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(full_multibyte_title.status(), StatusCode::CREATED);

    std::env::remove_var("XDG_CONFIG_HOME");
}

/// Notes persist across a fresh server state built from the same config
/// dir: load_notes() on boot restores the sidecar (the reset-survival
/// contract).
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn notes_sidecar_survives_state_rebuild() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-notes-persist");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let app = test_app();
    let create = app
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "title": "survivor", "content": "still here" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);

    // Rebuild the store from disk the way a reboot would.
    let reloaded = notes::load_notes();
    assert_eq!(reloaded.notes.len(), 1);
    assert_eq!(reloaded.notes[0].title, "survivor");
    assert_eq!(reloaded.notes[0].content, "still here");

    std::env::remove_var("XDG_CONFIG_HOME");
}

/// A corrupt sidecar must boot to an empty store instead of panicking,
/// and the next save overwrites the garbage so the store recovers.
#[tokio::test]
async fn notes_sidecar_corrupt_boots_empty() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-notes-corrupt");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
    fs::write(
        config_home.join("herdr-webui/notes.json"),
        "{ not valid json",
    )
    .unwrap();

    let reloaded = notes::load_notes();
    assert_eq!(reloaded.notes.len(), 0, "corrupt sidecar boots empty");

    let recovered = notes::save_notes(&reloaded);
    assert!(recovered.is_ok(), "save rewrites the corrupt file");
    let raw = fs::read_to_string(config_home.join("herdr-webui/notes.json")).unwrap();
    let persisted: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(persisted["notes"].as_array().unwrap().len(), 0);

    std::env::remove_var("XDG_CONFIG_HOME");
}

/// Note mutations only ever write the notes.json sidecar: the settings
/// file must stay byte-identical across a full CRUD cycle, pinning the
/// "note writes never rewrite auth config" isolation claim.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn notes_mutations_never_touch_the_settings_sidecar() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-notes-isolation");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
    let settings_path = config_home.join("herdr-webui/webui-settings.json");
    let settings_before = "{ \"user\": \"u\", \"password\": \"p\", \"localhost_no_auth\": false }";
    fs::write(&settings_path, settings_before).unwrap();

    let app = test_app();
    let cookie = "herdr_web_session=token-123";
    let create = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "title": "iso", "content": "body" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);
    let created = response_json(create).await;
    let note_id = created["notes"][0]["id"].as_str().unwrap().to_string();

    let update = app
        .clone()
        .oneshot(
            request(Method::PUT, format!("/api/notes/{note_id}").as_str())
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "title": "iso 2" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(update.status(), StatusCode::OK);

    let delete = app
        .oneshot(
            request(Method::DELETE, format!("/api/notes/{note_id}").as_str())
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete.status(), StatusCode::OK);

    let settings_after = fs::read_to_string(&settings_path).unwrap();
    assert_eq!(
        settings_after, settings_before,
        "settings sidecar untouched"
    );
    let notes_sidecar = config_home.join("herdr-webui/notes.json");
    assert!(notes_sidecar.exists(), "notes sidecar exists");

    std::env::remove_var("XDG_CONFIG_HOME");
}

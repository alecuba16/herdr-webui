//! Live acceptance probe for the search palette (gap 5): opt-in only.
//!
//! Runs the palette's real commit methods (`commit_file_search` /
//! `commit_content_search`) through the real `WebApiClient` against a
//! live herdr-webui session on 127.0.0.1:8787 and asserts the actual
//! API responses parse into palette rows. Set `HERDR_LIVE_PROBE=1` to
//! enable; without it the test returns immediately so normal CI runs
//! (dead port by default) never touch the network.
use herdr_webui::tui::search::{SearchCandidate, SearchPalette};
use herdr_webui::tui::web_api::WebApiClient;

#[test]
fn live_file_and_content_search_parse_real_responses() {
    // Probe guard: skip silently when the live session is not listening.
    if std::env::var("HERDR_LIVE_PROBE").is_err() {
        return;
    }
    let api = WebApiClient::new("127.0.0.1", 8787);
    let cwd = env!("CARGO_MANIFEST_DIR");
    let mut palette = SearchPalette::default();
    palette.query = "search".to_string();

    let files = palette
        .commit_file_search(&api, cwd, "")
        .expect("live file search");
    assert!(palette.results.len() >= 1, "at least one name match");
    assert!(
        palette.results.iter().any(
            |c| matches!(c, SearchCandidate::File { path, .. } if path.ends_with("search.rs"))
        ),
        "search.rs found by name query: {:?}",
        palette.results
    );
    assert_eq!(files, palette.results.len());

    let before = palette.results.len();
    palette
        .commit_content_search(&api, cwd, "")
        .expect("live content search");
    assert!(palette.results.len() > before, "content hits appended");
    assert!(
        palette
            .results
            .iter()
            .any(|c| matches!(c, SearchCandidate::Content { file, line, .. } if *line >= 1 && !file.is_empty())),
        "content rows carry a real jump line: {:?}",
        palette.results
    );
}

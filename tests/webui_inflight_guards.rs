//! WebUI panel duplication regression harness.
//!
//! Loads the real embedded WebUI JS (`worktrees.js`, mobile `actions.js`)
//! in a Node VM with stubbed globals and verifies the in-flight guards on
//! `newTab` / `closeTab` / mobile `createPanel`: rapid re-triggers
//! (double-click on +, held shortcut key auto-repeat, double-tap) must
//! produce exactly one tab.create / tab.close request. This is the WebUI
//! side of the panel multiplication bug: the TUI side was test harness
//! leakage (see src/tui/tests/mod.rs), this side is real UI double-fire.
//!
//! Skips silently when node is not installed so normal CI runs pass.

use std::path::Path;
use std::process::Command;

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[test]
fn webui_inflight_guards_prevent_duplicate_panel_requests() {
    if !node_available() {
        return;
    }
    let manifest = env!("CARGO_MANIFEST_DIR");
    let harness = Path::new(manifest).join("tests/js/webui_inflight_test.js");
    let desktop = Path::new(manifest).join("src/assets/desktop/app_js/worktrees.js");
    let mobile = Path::new(manifest).join("src/assets/mobile/actions.js");
    assert!(harness.is_file(), "harness missing: {}", harness.display());
    assert!(desktop.is_file());
    assert!(mobile.is_file());

    let out = Command::new("node")
        .arg(&harness)
        .arg(&desktop)
        .arg(&mobile)
        .output()
        .expect("run node harness");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success(),
        "in-flight guard harness failed\nstdout:\n{}\nstderr:\n{}",
        stdout,
        stderr
    );
    assert!(
        stdout.contains("desktop newTab drops duplicate while in flight"),
        "missing desktop newTab check in:\n{}",
        stdout
    );
    assert!(
        stdout.contains("desktop newTab guard resets after settle"),
        "missing guard reset check in:\n{}",
        stdout
    );
    assert!(
        stdout.contains("desktop closeTab drops duplicate while in flight"),
        "missing desktop closeTab check in:\n{}",
        stdout
    );
    assert!(
        stdout.contains("mobile createPanel drops duplicates while in flight"),
        "missing mobile createPanel check in:\n{}",
        stdout
    );
    assert!(!stdout.contains("SKIP"), "unexpected skip in:\n{}", stdout);
    assert!(!stdout.contains("FAIL"), "failure in:\n{}", stdout);
}
//! Git worktree helpers for the worktree.* methods.

use super::*;

pub(super) fn run_git(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let output = crate::git_bin::command()
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_output_error(output))
    }
}

pub(super) fn git_output(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::git_bin::command()
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(git_output_error(output))
    }
}

pub(super) fn git_output_error(output: std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
}

pub(super) fn parse_git_worktrees(raw: &str) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut current_path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut detached = false;
    let flush = |rows: &mut Vec<Value>,
                 current_path: &mut Option<String>,
                 branch: &mut Option<String>,
                 detached: &mut bool| {
        if let Some(path) = current_path.take() {
            rows.push(json!({
                "path": path,
                "branch": branch.take(),
                "is_bare": false,
                "is_detached": *detached,
                "is_prunable": false,
                "is_linked_worktree": true,
                "open_workspace_id": null,
                "label": Path::new(&path).file_name().and_then(|name| name.to_str()).unwrap_or(&path),
            }));
            *detached = false;
        }
    };
    for line in raw.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut rows, &mut current_path, &mut branch, &mut detached);
            current_path = Some(path.to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = Some(value.trim_start_matches("refs/heads/").to_string());
        } else if line == "detached" {
            detached = true;
        }
    }
    flush(&mut rows, &mut current_path, &mut branch, &mut detached);
    rows
}

pub(super) fn enrich_worktree_commit_dates(rows: &mut [Value]) {
    for row in rows {
        let Some(path) = row.get("path").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let Ok(text) = git_output(Path::new(&path), &["log", "-1", "--format=%cI%x00%H"]) else {
            continue;
        };
        let mut parts = text.split('\0');
        let date = parts.next().unwrap_or_default().trim();
        let hash = parts.next().unwrap_or_default().trim();
        if let Some(object) = row.as_object_mut() {
            if !date.is_empty() {
                object.insert("last_commit_at".to_string(), json!(date));
            }
            if !hash.is_empty() {
                object.insert("last_commit_hash".to_string(), json!(hash));
            }
        }
    }
}

pub(super) fn worktree_activity_key(row: &Value) -> String {
    row.get("last_commit_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

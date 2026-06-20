use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=HERDR_WEBUI_VERSION");
    println!("cargo:rerun-if-env-changed=GITHUB_REF_TYPE");
    println!("cargo:rerun-if-env-changed=GITHUB_REF_NAME");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../.git/HEAD");

    let version = std::env::var("HERDR_WEBUI_VERSION").unwrap_or_else(|_| detected_version());
    println!("cargo:rustc-env=HERDR_WEBUI_VERSION={version}");
}

fn detected_version() -> String {
    if std::env::var("GITHUB_REF_TYPE").as_deref() == Ok("tag") {
        if let Ok(tag) = std::env::var("GITHUB_REF_NAME") {
            return tag;
        }
    }
    if let Some(tag) = git(&["describe", "--tags", "--exact-match", "HEAD"]) {
        return tag;
    }
    let short_sha = short_sha();
    if std::env::var("GITHUB_REF_TYPE").as_deref() == Ok("branch") {
        if let Ok(branch) = std::env::var("GITHUB_REF_NAME") {
            if branch == "main" || branch == "master" {
                return format!("{branch}-{short_sha}");
            }
        }
    }
    format!("snapshot-{short_sha}")
}

fn short_sha() -> String {
    if let Ok(sha) = std::env::var("GITHUB_SHA") {
        return sha.chars().take(12).collect();
    }
    git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".to_string())
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=HERDR_WEBUI_VERSION");
    println!("cargo:rerun-if-changed=../.git/HEAD");

    let version = std::env::var("HERDR_WEBUI_VERSION").unwrap_or_else(|_| detected_version());
    println!("cargo:rustc-env=HERDR_WEBUI_VERSION={version}");
}

fn detected_version() -> String {
    let package_version =
        std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string());
    if let Some(tag) = git(&["describe", "--tags", "--exact-match", "HEAD"]) {
        if let Some(version) = tag.strip_prefix('v') {
            if is_semver(version) {
                return version.to_string();
            }
        }
        if is_semver(&tag) {
            return tag;
        }
    }
    let short_sha =
        git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    format!("{package_version}+{short_sha}")
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn is_semver(value: &str) -> bool {
    let mut parts = value
        .split('+')
        .next()
        .unwrap_or(value)
        .split('-')
        .next()
        .unwrap_or(value)
        .split('.');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(major), Some(minor), Some(patch), None)
            if major.chars().all(|c| c.is_ascii_digit())
                && minor.chars().all(|c| c.is_ascii_digit())
                && patch.chars().all(|c| c.is_ascii_digit())
    )
}

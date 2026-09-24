use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{TlsMode, WebConfig, HERDR_WEBUI_VERSION, INSTALL_LABEL};

/// Outcome of copying an executable into the install directory.
#[derive(Debug, PartialEq, Eq)]
enum CopyOutcome {
    /// The source bytes were copied to the target path.
    Copied,
    /// Source and target are the same file: nothing was copied.
    SameFile,
}

pub fn install_macos(config: WebConfig) -> io::Result<()> {
    ensure_macos_user_context()?;
    let plist = mac_plist_path()?;
    let domain = mac_domain();
    let service = mac_service_target();
    log_macos_context("install", Some(&plist));
    println!("Installing {INSTALL_LABEL} {HERDR_WEBUI_VERSION}");
    let (install_bin, outcome) = copy_current_exe_to_install_path()?;
    warn_if_noop_self_install(&outcome, "install-mac");
    if let Some((tui_bin, tui_outcome)) =
        copy_sibling_tui_to_install_path(std::env::current_exe()?.parent())?
    {
        print_tui_install_line("Installed", &tui_bin, &tui_outcome);
    }
    print_main_install_line("Installed", &install_bin, &outcome);
    fs::create_dir_all(plist.parent().expect("plist has parent"))?;
    fs::create_dir_all(mac_log_dir()?)?;
    fs::write(&plist, mac_plist_xml(&config, &install_bin)?)?;
    let plist_arg = plist.display().to_string();
    let _ = launchctl_quiet(&["bootout", &service]);
    launchctl_required(&["bootstrap", &domain, &plist_arg])?;
    launchctl_required(&["kickstart", "-k", &service])?;
    println!("Installed {INSTALL_LABEL} at {}", plist.display());
    println!("Open {}://{}", config.tls.scheme(), config.bind);
    Ok(())
}

pub fn update_macos() -> io::Result<()> {
    ensure_macos_user_context()?;
    log_macos_context("update", mac_plist_path().ok().as_deref());
    println!("Updating {INSTALL_LABEL} to {HERDR_WEBUI_VERSION}");
    let (install_bin, outcome) = copy_current_exe_to_install_path()?;
    warn_if_noop_self_install(&outcome, "update-mac");
    if let Some((tui_bin, tui_outcome)) =
        copy_sibling_tui_to_install_path(std::env::current_exe()?.parent())?
    {
        print_tui_install_line("Updated", &tui_bin, &tui_outcome);
    }
    restart_macos_service()?;
    print_main_install_line("Updated", &install_bin, &outcome);
    Ok(())
}

pub fn start_macos_service() -> io::Result<()> {
    ensure_macos_user_context()?;
    let plist = mac_plist_path()?;
    log_macos_context("start", Some(&plist));
    if !plist.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("LaunchAgent plist not found at {}", plist.display()),
        ));
    }
    let domain = mac_domain();
    let service = mac_service_target();
    if !launchctl_quiet(&["kickstart", "-k", &service])? {
        launchctl_required(&["bootstrap", &domain, &plist.display().to_string()])?;
        launchctl_required(&["kickstart", "-k", &service])?;
    }
    println!("Started {INSTALL_LABEL}");
    Ok(())
}

pub fn stop_macos_service() -> io::Result<()> {
    ensure_macos_user_context()?;
    log_macos_context("stop", None);
    let service = mac_service_target();
    let _ = launchctl_quiet(&["bootout", &service]);
    println!("Stopped {INSTALL_LABEL}");
    Ok(())
}

pub fn restart_macos_service() -> io::Result<()> {
    stop_macos_service()?;
    start_macos_service()?;
    println!("Restarted {INSTALL_LABEL}");
    Ok(())
}

pub fn uninstall_macos() -> io::Result<()> {
    ensure_macos_user_context()?;
    let plist = mac_plist_path()?;
    log_macos_context("uninstall", Some(&plist));
    let service = mac_service_target();
    let _ = launchctl_quiet(&["bootout", &service]);
    if plist.exists() {
        fs::remove_file(&plist)?;
    }
    println!("Uninstalled {INSTALL_LABEL}");
    Ok(())
}

pub fn install_linux(config: WebConfig) -> io::Result<()> {
    println!("Installing {INSTALL_LABEL} {HERDR_WEBUI_VERSION}");
    let (install_bin, outcome) = copy_current_exe_to_install_path()?;
    warn_if_noop_self_install(&outcome, "install-linux");
    if let Some((tui_bin, tui_outcome)) =
        copy_sibling_tui_to_install_path(std::env::current_exe()?.parent())?
    {
        print_tui_install_line("Installed", &tui_bin, &tui_outcome);
    }
    let service = linux_service_path()?;
    fs::create_dir_all(service.parent().expect("service path has parent"))?;
    fs::write(&service, linux_service_unit(&config, &install_bin))?;
    systemctl_user(&["daemon-reload"])?;
    systemctl_user(&["enable", "--now", &format!("{INSTALL_LABEL}.service")])?;
    println!("Installed {INSTALL_LABEL} at {}", service.display());
    print_main_install_line("Installed", &install_bin, &outcome);
    println!("Open {}://{}", config.tls.scheme(), config.bind);
    Ok(())
}

pub fn update_linux() -> io::Result<()> {
    println!("Updating {INSTALL_LABEL} to {HERDR_WEBUI_VERSION}");
    let (install_bin, outcome) = copy_current_exe_to_install_path()?;
    warn_if_noop_self_install(&outcome, "update-linux");
    if let Some((tui_bin, tui_outcome)) =
        copy_sibling_tui_to_install_path(std::env::current_exe()?.parent())?
    {
        print_tui_install_line("Updated", &tui_bin, &tui_outcome);
    }
    systemctl_user(&["daemon-reload"])?;
    restart_linux_service()?;
    print_main_install_line("Updated", &install_bin, &outcome);
    Ok(())
}

pub fn start_linux_service() -> io::Result<()> {
    ensure_linux_service_exists()?;
    systemctl_user(&["start", &format!("{INSTALL_LABEL}.service")])?;
    println!("Started {INSTALL_LABEL}");
    Ok(())
}

pub fn stop_linux_service() -> io::Result<()> {
    systemctl_user(&["stop", &format!("{INSTALL_LABEL}.service")])?;
    println!("Stopped {INSTALL_LABEL}");
    Ok(())
}

pub fn restart_linux_service() -> io::Result<()> {
    ensure_linux_service_exists()?;
    systemctl_user(&["restart", &format!("{INSTALL_LABEL}.service")])?;
    println!("Restarted {INSTALL_LABEL}");
    Ok(())
}

pub fn uninstall_linux() -> io::Result<()> {
    let _ = systemctl_user(&["disable", "--now", &format!("{INSTALL_LABEL}.service")]);
    let service = linux_service_path()?;
    if service.exists() {
        fs::remove_file(&service)?;
    }
    let _ = systemctl_user(&["daemon-reload"]);
    println!("Uninstalled {INSTALL_LABEL}");
    Ok(())
}

pub fn start_service() -> io::Result<()> {
    if cfg!(target_os = "linux") {
        start_linux_service()
    } else {
        start_macos_service()
    }
}

pub fn stop_service() -> io::Result<()> {
    if cfg!(target_os = "linux") {
        stop_linux_service()
    } else {
        stop_macos_service()
    }
}

pub fn restart_service() -> io::Result<()> {
    if cfg!(target_os = "linux") {
        restart_linux_service()
    } else {
        restart_macos_service()
    }
}

fn home_dir() -> io::Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is required"))
}

fn local_bin_dir() -> io::Result<PathBuf> {
    Ok(home_dir()?.join(".local").join("bin"))
}

fn install_bin_path() -> io::Result<PathBuf> {
    Ok(local_bin_dir()?.join("herdr-webui"))
}

fn copy_current_exe_to_install_path() -> io::Result<(PathBuf, CopyOutcome)> {
    let source = std::env::current_exe()?;
    let target = install_bin_path()?;
    let outcome = copy_executable(&source, &target)?;
    Ok((target, outcome))
}

fn tui_install_bin_path() -> io::Result<PathBuf> {
    Ok(local_bin_dir()?.join("herdr-webui-tui"))
}

/// Copy the `herdr-webui-tui` binary sitting next to the running main
/// binary (the release tarball layout) into `~/.local/bin`. Returns `None`
/// when no sibling TUI exists, so Makefile/standalone installs behave
/// exactly as before. The TUI stays a separate binary: nothing is embedded
/// in the main executable.
fn copy_sibling_tui_to_install_path(
    source_dir: Option<&Path>,
) -> io::Result<Option<(PathBuf, CopyOutcome)>> {
    let Some(source_dir) = source_dir else {
        return Ok(None);
    };
    let source = source_dir.join("herdr-webui-tui");
    if !source.exists() {
        return Ok(None);
    }
    let target = tui_install_bin_path()?;
    let outcome = copy_executable(&source, &target)?;
    Ok(Some((target, outcome)))
}

/// Warn when the running binary is already the installed one, so a PATH
/// resolved `herdr-webui update-mac` cannot silently reinstall the old
/// version over itself.
fn warn_if_noop_self_install(outcome: &CopyOutcome, command: &str) {
    if matches!(outcome, CopyOutcome::SameFile) {
        eprintln!(
            "warning: running binary is already the installed {HERDR_WEBUI_VERSION}; \
             {command} copied nothing. To refresh from a release tarball, run \
             `./herdr-webui {command}` from the tarball directory."
        );
    }
}

/// Print the TUI install line only when the TUI was actually copied, so a
/// no-op refresh does not claim the TUI was updated when nothing changed.
fn print_tui_install_line(verb: &str, tui_bin: &Path, outcome: &CopyOutcome) {
    match outcome {
        CopyOutcome::Copied => println!("{verb} TUI binary at {}", tui_bin.display()),
        CopyOutcome::SameFile => println!(
            "TUI binary at {} is already {}",
            tui_bin.display(),
            HERDR_WEBUI_VERSION
        ),
    }
}

/// Print the main-binary install line matching the actual copy outcome, so
/// every command reports the same outcome the same way.
fn print_main_install_line(verb: &str, install_bin: &Path, outcome: &CopyOutcome) {
    match outcome {
        CopyOutcome::Copied => println!("{verb} binary at {}", install_bin.display()),
        CopyOutcome::SameFile => println!(
            "Binary at {} is already {}",
            install_bin.display(),
            HERDR_WEBUI_VERSION
        ),
    }
}

fn copy_executable(source: &Path, target: &Path) -> io::Result<CopyOutcome> {
    // Follow a symlinked install path so the refresh writes through it
    // instead of replacing the link with a regular file. resolve_path
    // returns the link's own target for a dangling link, so the refresh
    // recreates the missing destination file instead of clobbering the link.
    let target = resolve_path(target);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let same_file = same_file(source, &target);
    if same_file {
        return Ok(CopyOutcome::SameFile);
    }
    // Copy to a temporary sibling, then rename over the target. A plain
    // fs::copy onto the target fails with ETXTBSY on Linux while the old
    // service binary is still running, and truncates the live process image
    // in place on macOS. The rename swaps the inode atomically instead.
    let temp = target.with_extension(format!("tmp-{}", std::process::id()));
    // A leftover temp from an interrupted copy is stale garbage. If it is
    // somehow a symlink, remove it rather than write through it.
    if fs::symlink_metadata(&temp).is_ok_and(|meta| meta.file_type().is_symlink()) {
        let _ = fs::remove_file(&temp);
    }
    if let Err(err) = fs::copy(source, &temp)
        .and_then(|_| {
            let mut permissions = fs::metadata(&temp)?.permissions();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                permissions.set_mode(0o755);
            }
            fs::set_permissions(&temp, permissions)?;
            Ok(())
        })
        .and_then(|()| fs::rename(&temp, target))
    {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }
    Ok(CopyOutcome::Copied)
}

/// Resolve symlinked path components of `path` the way the kernel would for
/// an open(O_CREAT), so a refresh writes through the link instead of
/// replacing it. rename(2) never follows a symlinked final component, so it
/// must be resolved here; a dangling link keeps the link's own target and the
/// copy recreates the missing destination. Parent components are resolved by
/// the kernel itself, so only the final component needs this treatment.
fn resolve_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("/"));
    let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let Some(name) = path.file_name() else {
        return parent;
    };
    let mut resolved = parent.join(name);
    // Follow a chain of symlinks, with a bound so a link loop cannot spin.
    // A link loop eventually fails at the copy/rename with ELOOP, which is
    // the correct error to surface.
    for _ in 0..8 {
        let Ok(link) = fs::read_link(&resolved) else {
            return resolved;
        };
        resolved = if link.is_absolute() {
            link
        } else {
            resolved
                .parent()
                .unwrap_or_else(|| Path::new("/"))
                .join(link)
        };
    }
    resolved
}

fn same_file(source: &Path, target: &Path) -> bool {
    if !target.exists() {
        return false;
    }
    if let (Ok(source_meta), Ok(target_meta)) = (source.metadata(), target.metadata()) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            source_meta.dev() == target_meta.dev() && source_meta.ino() == target_meta.ino()
        }
        #[cfg(not(unix))]
        {
            let _ = (source_meta, target_meta);
            source.canonicalize().ok() == target.canonicalize().ok()
        }
    } else {
        source.canonicalize().ok() == target.canonicalize().ok()
    }
}

fn mac_plist_path() -> io::Result<PathBuf> {
    Ok(home_dir()?
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{INSTALL_LABEL}.plist")))
}

fn mac_log_dir() -> io::Result<PathBuf> {
    Ok(home_dir()?.join("Library").join("Logs").join("herdr-webui"))
}

fn mac_plist_xml(config: &WebConfig, install_bin: &Path) -> io::Result<String> {
    let log_dir = mac_log_dir()?;
    let mut env_lines = Vec::new();
    if let Ok(herdr_bin) = std::env::var("HERDR_WEB_HERDR_BIN") {
        if !herdr_bin.is_empty() {
            env_lines.push(format!(
                "    <key>HERDR_WEB_HERDR_BIN</key>\n    <string>{}</string>",
                xml_escape(&herdr_bin)
            ));
        }
    }
    let mut args = vec![
        format!(
            "    <string>{}</string>",
            xml_escape(&install_bin.display().to_string())
        ),
        "    <string>--bind</string>".to_string(),
        format!(
            "    <string>{}</string>",
            xml_escape(&config.bind.to_string())
        ),
    ];
    if let Some(session) = &config.session {
        args.push("    <string>--session</string>".to_string());
        args.push(format!("    <string>{}</string>", xml_escape(session)));
    }
    append_mac_tls_args(config, &mut args);
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
{env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{stdout}</string>
  <key>StandardErrorPath</key>
  <string>{stderr}</string>
</dict>
</plist>
"#,
        label = INSTALL_LABEL,
        args = args.join("\n"),
        env = env_lines.join("\n"),
        stdout = xml_escape(&log_dir.join("stdout.log").display().to_string()),
        stderr = xml_escape(&log_dir.join("stderr.log").display().to_string())
    ))
}

fn linux_service_path() -> io::Result<PathBuf> {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or(home_dir()?.join(".config"));
    Ok(config_home
        .join("systemd")
        .join("user")
        .join(format!("{INSTALL_LABEL}.service")))
}

fn linux_service_unit(config: &WebConfig, install_bin: &Path) -> String {
    let mut exec = format!(
        "{} --bind {}",
        systemd_escape_arg(&install_bin.display().to_string()),
        systemd_escape_arg(&config.bind.to_string())
    );
    if let Some(session) = &config.session {
        exec.push_str(" --session ");
        exec.push_str(&systemd_escape_arg(session));
    }
    append_systemd_tls_args(config, &mut exec);
    let env = std::env::var("HERDR_WEB_HERDR_BIN")
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| {
            format!(
                "Environment=HERDR_WEB_HERDR_BIN={}\n",
                systemd_escape_arg(&value)
            )
        })
        .unwrap_or_default();
    format!(
        "[Unit]\nDescription=Herdr WebUI\nAfter=network.target\n\n[Service]\nType=simple\n{env}ExecStart={exec}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n"
    )
}

fn append_mac_tls_args(config: &WebConfig, args: &mut Vec<String>) {
    match config.tls.mode {
        TlsMode::Off => {}
        TlsMode::Auto => {
            args.push("    <string>--https</string>".to_string());
            args.push("    <string>auto</string>".to_string());
            append_mac_tls_file_args(config, args);
        }
        TlsMode::SelfSigned => {
            args.push("    <string>--https</string>".to_string());
            args.push("    <string>self-signed</string>".to_string());
        }
        TlsMode::Files => {
            args.push("    <string>--https</string>".to_string());
            args.push("    <string>files</string>".to_string());
            append_mac_tls_file_args(config, args);
        }
    }
}

fn append_mac_tls_file_args(config: &WebConfig, args: &mut Vec<String>) {
    if let Some(cert) = &config.tls.cert_path {
        args.push("    <string>--tls-cert</string>".to_string());
        args.push(format!(
            "    <string>{}</string>",
            xml_escape(&cert.display().to_string())
        ));
    }
    if let Some(key) = &config.tls.key_path {
        args.push("    <string>--tls-key</string>".to_string());
        args.push(format!(
            "    <string>{}</string>",
            xml_escape(&key.display().to_string())
        ));
    }
}

fn append_systemd_tls_args(config: &WebConfig, exec: &mut String) {
    match config.tls.mode {
        TlsMode::Off => {}
        TlsMode::Auto => {
            exec.push_str(" --https auto");
            append_systemd_tls_file_args(config, exec);
        }
        TlsMode::SelfSigned => exec.push_str(" --https self-signed"),
        TlsMode::Files => {
            exec.push_str(" --https files");
            append_systemd_tls_file_args(config, exec);
        }
    }
}

fn append_systemd_tls_file_args(config: &WebConfig, exec: &mut String) {
    if let Some(cert) = &config.tls.cert_path {
        exec.push_str(" --tls-cert ");
        exec.push_str(&systemd_escape_arg(&cert.display().to_string()));
    }
    if let Some(key) = &config.tls.key_path {
        exec.push_str(" --tls-key ");
        exec.push_str(&systemd_escape_arg(&key.display().to_string()));
    }
}

fn systemd_escape_arg(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-' | ':' | '='))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\\', "\\\\").replace('\'', "'\\''"))
    }
}

fn ensure_linux_service_exists() -> io::Result<()> {
    let path = linux_service_path()?;
    if path.exists() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("systemd user service not found at {}", path.display()),
    ))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn launchctl_quiet(args: &[&str]) -> io::Result<bool> {
    let output = Command::new("launchctl").args(args).output()?;
    log_command_output("launchctl", args, &output);
    Ok(output.status.success())
}

fn launchctl_required(args: &[&str]) -> io::Result<()> {
    let output = Command::new("launchctl").args(args).output()?;
    log_command_output("launchctl", args, &output);
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        format!("exit status {}", output.status)
    } else {
        stderr
    };
    Err(io::Error::other(format!(
        "launchctl {} failed: {detail}",
        args.join(" ")
    )))
}

fn systemctl_user(args: &[&str]) -> io::Result<bool> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()?;
    if status.success() {
        Ok(true)
    } else {
        Err(io::Error::other(format!(
            "systemctl --user {} failed",
            args.join(" ")
        )))
    }
}

fn mac_domain() -> String {
    format!("gui/{}", unsafe { libc_getuid() })
}

fn mac_service_target() -> String {
    format!("{}/{INSTALL_LABEL}", mac_domain())
}

fn service_verbose() -> bool {
    matches!(
        std::env::var("HERDR_WEB_VERBOSE").as_deref(),
        Ok("1" | "true" | "yes" | "on")
    )
}

fn log_macos_context(action: &str, plist: Option<&Path>) {
    if !service_verbose() {
        return;
    }
    eprintln!("herdr-webui {action}-mac debug:");
    eprintln!("  uid: {}", unsafe { libc_getuid() });
    eprintln!("  euid: {}", unsafe { libc_geteuid() });
    eprintln!(
        "  home: {}",
        home_dir().map_or_else(|err| err.to_string(), |path| path.display().to_string())
    );
    eprintln!("  domain: {}", mac_domain());
    eprintln!("  service: {}", mac_service_target());
    if let Some(plist) = plist {
        eprintln!("  plist: {}", plist.display());
        eprintln!("  plist exists: {}", plist.exists());
    }
}

fn log_command_output(command: &str, args: &[&str], output: &std::process::Output) {
    if !service_verbose() {
        return;
    }
    eprintln!("  command: {command} {}", args.join(" "));
    eprintln!("  status: {}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        eprintln!("  stdout: {stdout}");
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        eprintln!("  stderr: {stderr}");
    }
}

fn ensure_macos_user_context() -> io::Result<()> {
    if unsafe { libc_geteuid() } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "macOS LaunchAgent commands must be run without sudo; run `herdr-webui install-mac` as your user",
        ));
    }
    Ok(())
}

#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

#[cfg(unix)]
unsafe fn libc_geteuid() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    geteuid()
}

#[cfg(not(unix))]
unsafe fn libc_getuid() -> u32 {
    0
}

#[cfg(not(unix))]
unsafe fn libc_geteuid() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn test_config(tls: crate::TlsConfig) -> WebConfig {
        WebConfig {
            bind: "127.0.0.1:8787".parse().unwrap(),
            bind_explicit: false,
            session: Some("work".to_string()),
            api_socket: None,
            client_socket: None,
            backend_mode: None,
            tls,
        }
    }

    #[test]
    fn linux_service_unit_contains_binary_and_flags() {
        let config = WebConfig {
            bind: "127.0.0.1:8787".parse().unwrap(),
            bind_explicit: false,
            session: Some("work".to_string()),
            api_socket: None,
            client_socket: None,
            backend_mode: None,
            tls: crate::TlsConfig {
                mode: TlsMode::Off,
                cert_path: None,
                key_path: None,
            },
        };

        let unit = linux_service_unit(&config, Path::new("/tmp/herdr-webui"));

        assert!(unit.contains("ExecStart=/tmp/herdr-webui --bind 127.0.0.1:8787 --session work"));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn linux_service_unit_quotes_shell_sensitive_args() {
        let config = WebConfig {
            bind: "127.0.0.1:8787".parse().unwrap(),
            bind_explicit: false,
            session: Some("work session's path".to_string()),
            api_socket: None,
            client_socket: None,
            backend_mode: None,
            tls: crate::TlsConfig {
                mode: TlsMode::SelfSigned,
                cert_path: None,
                key_path: None,
            },
        };

        let unit = linux_service_unit(&config, Path::new("/tmp/herdr webui"));

        assert!(unit.contains("ExecStart='/tmp/herdr webui' --bind 127.0.0.1:8787 --session 'work session'\\''s path'"));
    }

    #[test]
    fn mac_plist_contains_binary_and_flags() {
        let config = WebConfig {
            bind: "127.0.0.1:8787".parse().unwrap(),
            bind_explicit: false,
            session: Some("work".to_string()),
            api_socket: None,
            client_socket: None,
            backend_mode: None,
            tls: crate::TlsConfig {
                mode: TlsMode::Files,
                cert_path: Some(PathBuf::from("/tmp/cert.pem")),
                key_path: Some(PathBuf::from("/tmp/key.pem")),
            },
        };

        let plist = mac_plist_xml(&config, Path::new("/tmp/herdr-webui")).unwrap();

        assert!(plist.contains("<string>/tmp/herdr-webui</string>"));
        assert!(plist.contains("<string>--bind</string>"));
        assert!(plist.contains("<string>127.0.0.1:8787</string>"));
        assert!(plist.contains("<string>--session</string>"));
        assert!(plist.contains("<string>work</string>"));
        assert!(plist.contains("<string>--https</string>"));
        assert!(plist.contains("<string>files</string>"));
        assert!(plist.contains("<string>--tls-cert</string>"));
        assert!(plist.contains("<string>/tmp/cert.pem</string>"));
        assert!(plist.contains("<string>--tls-key</string>"));
        assert!(plist.contains("<string>/tmp/key.pem</string>"));
    }

    #[test]
    fn escapes_service_file_values() {
        assert_eq!(systemd_escape_arg("plain/path:1"), "plain/path:1");
        assert_eq!(systemd_escape_arg("has space"), "'has space'");
        assert_eq!(systemd_escape_arg("has'quote"), "'has'\\''quote'");
        assert_eq!(systemd_escape_arg("has\\slash"), "'has\\\\slash'");

        assert_eq!(
            xml_escape("<&>\"'"),
            "&lt;&amp;&gt;&quot;&apos;".to_string()
        );
    }

    #[test]
    fn service_files_include_env_and_all_tls_modes() {
        let _guard = env_lock().lock().unwrap();
        std::env::set_var("HERDR_WEB_HERDR_BIN", "herdr & helper");

        let tls = crate::TlsConfig {
            mode: TlsMode::Auto,
            cert_path: Some(PathBuf::from("/tmp/cert path.pem")),
            key_path: Some(PathBuf::from("/tmp/key path.pem")),
        };
        let mut config = test_config(tls);
        config.session = Some("work <session>".to_string());

        let plist = mac_plist_xml(&config, Path::new("/tmp/herdr-webui")).unwrap();
        assert!(plist.contains("<key>HERDR_WEB_HERDR_BIN</key>"));
        assert!(plist.contains("<string>herdr &amp; helper</string>"));
        assert!(plist.contains("<string>work &lt;session&gt;</string>"));
        assert!(plist.contains("<string>auto</string>"));
        assert!(plist.contains("<string>/tmp/cert path.pem</string>"));
        assert!(plist.contains("<string>/tmp/key path.pem</string>"));

        let unit = linux_service_unit(&config, Path::new("/tmp/herdr webui"));
        assert!(unit.contains("Environment=HERDR_WEB_HERDR_BIN='herdr & helper'"));
        assert!(unit.contains("--https auto"));
        assert!(unit.contains("--tls-cert '/tmp/cert path.pem'"));
        assert!(unit.contains("--tls-key '/tmp/key path.pem'"));

        config.tls.mode = TlsMode::Files;
        let files_unit = linux_service_unit(&config, Path::new("/tmp/herdr-webui"));
        assert!(files_unit.contains("--https files"));

        std::env::remove_var("HERDR_WEB_HERDR_BIN");
    }

    #[test]
    fn linux_service_exists_checks_config_home_path() {
        let _guard = env_lock().lock().unwrap();
        let base =
            std::env::temp_dir().join(format!("herdr-webui-service-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        std::env::set_var("XDG_CONFIG_HOME", &base);

        let missing = ensure_linux_service_exists().unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);
        assert!(missing
            .to_string()
            .contains("systemd user service not found"));

        let service = linux_service_path().unwrap();
        fs::create_dir_all(service.parent().unwrap()).unwrap();
        fs::write(&service, "unit").unwrap();
        ensure_linux_service_exists().unwrap();

        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = fs::remove_dir_all(base);
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn copy_executable_copies_content_and_sets_mode() {
        let _guard = env_lock().lock().unwrap();
        let base =
            std::env::temp_dir().join(format!("herdr-webui-copy-exe-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let source = base.join("herdr-webui-tui");
        fs::write(&source, "tui-bytes\n").unwrap();

        let target_dir = base.join("local").join("bin");
        let target = target_dir.join("herdr-webui-tui");
        assert_eq!(
            copy_executable(&source, &target).unwrap(),
            CopyOutcome::Copied
        );

        assert_eq!(fs::read_to_string(&target).unwrap(), "tui-bytes\n");
        assert!(target_dir.exists(), "target parent is created");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&target).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_executable_reports_same_file_without_copying() {
        let _guard = env_lock().lock().unwrap();
        let base = std::env::temp_dir().join(format!(
            "herdr-webui-copy-same-file-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let binary = base.join("herdr-webui");
        fs::write(&binary, "installed-bytes\n").unwrap();

        // Same path: no copy, content untouched.
        assert_eq!(
            copy_executable(&binary, &binary).unwrap(),
            CopyOutcome::SameFile
        );
        assert_eq!(fs::read_to_string(&binary).unwrap(), "installed-bytes\n");

        // Hard link to the same inode: also the same file.
        let linked = base.join("herdr-webui-link");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            fs::hard_link(&binary, &linked).unwrap();
            assert_eq!(
                copy_executable(&linked, &binary).unwrap(),
                CopyOutcome::SameFile
            );
            assert!(fs::metadata(&binary).unwrap().ino() == fs::metadata(&linked).unwrap().ino());
        }

        // Different content at another path: a normal copy.
        let fresh = base.join("herdr-webui-new");
        fs::write(&fresh, "fresh-bytes\n").unwrap();
        assert_eq!(
            copy_executable(&fresh, &binary).unwrap(),
            CopyOutcome::Copied
        );
        assert_eq!(fs::read_to_string(&binary).unwrap(), "fresh-bytes\n");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_executable_writes_through_symlinked_target() {
        let _guard = env_lock().lock().unwrap();
        let base = std::env::temp_dir().join(format!(
            "herdr-webui-copy-symlink-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("real")).unwrap();
        let real = base.join("real").join("herdr-webui");
        fs::write(&real, "installed-bytes\n").unwrap();
        fs::create_dir_all(base.join("linkdir")).unwrap();
        let link = base.join("linkdir").join("herdr-webui");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let fresh = base.join("herdr-webui-new");
        fs::write(&fresh, "fresh-bytes\n").unwrap();

        assert_eq!(copy_executable(&fresh, &link).unwrap(), CopyOutcome::Copied);

        // The link stays a link and points at refreshed content.
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "fresh-bytes\n");
        assert_eq!(
            fs::read_to_string(&link).unwrap(),
            "fresh-bytes\n",
            "reading through the link returns the refreshed bytes"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_executable_recreates_dangling_symlink_target() {
        let _guard = env_lock().lock().unwrap();
        let base = std::env::temp_dir().join(format!(
            "herdr-webui-copy-dangling-link-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("realdir")).unwrap();
        fs::create_dir_all(base.join("linkdir")).unwrap();
        // Dangling link: its target was removed but the link remains.
        let link = base.join("linkdir").join("herdr-webui");
        let real = base.join("realdir").join("herdr-webui");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let fresh = base.join("herdr-webui-new");
        fs::write(&fresh, "fresh-bytes\n").unwrap();

        assert_eq!(copy_executable(&fresh, &link).unwrap(), CopyOutcome::Copied);

        // The link survives and its missing target is recreated.
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "a dangling link must not be replaced by a regular file"
        );
        assert_eq!(fs::read_to_string(&real).unwrap(), "fresh-bytes\n");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_executable_reports_same_file_for_sibling_tui_noop() {
        let _guard = env_lock().lock().unwrap();
        let base = std::env::temp_dir().join(format!(
            "herdr-webui-copy-tui-noop-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let tui = base.join("herdr-webui-tui");
        fs::write(&tui, "tui-bytes\n").unwrap();

        // Refreshing the TUI from itself (PATH-resolved no-op) copies nothing.
        assert_eq!(copy_executable(&tui, &tui).unwrap(), CopyOutcome::SameFile);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_executable_overwrites_stale_temp_file() {
        let _guard = env_lock().lock().unwrap();
        let base = std::env::temp_dir().join(format!(
            "herdr-webui-copy-stale-temp-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        let source = base.join("herdr-webui-new");
        fs::write(&source, "fresh-bytes\n").unwrap();
        let target = base.join("herdr-webui");
        fs::write(&target, "installed-bytes\n").unwrap();

        // Simulate a leftover temp file from an interrupted earlier copy,
        // with the same name our current process would pick.
        let temp = target.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&temp, "garbage-from-crashed-copy\n").unwrap();

        assert_eq!(
            copy_executable(&source, &target).unwrap(),
            CopyOutcome::Copied
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "fresh-bytes\n");
        assert!(!temp.exists(), "temp file is consumed by the rename");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_sibling_tui_installs_present_binary_and_skips_missing() {
        let _guard = env_lock().lock().unwrap();
        let original_home = std::env::var_os("HOME");
        let home = std::env::temp_dir().join(format!(
            "herdr-webui-sibling-tui-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);

        // No sibling next to the exe dir -> None, no ~/.local/bin created.
        let empty_dir = home.join("dist");
        fs::create_dir_all(&empty_dir).unwrap();
        assert_eq!(
            copy_sibling_tui_to_install_path(Some(&empty_dir)).unwrap(),
            None
        );
        assert!(!home.join(".local").join("bin").exists());

        // Sibling present -> copied to ~/.local/bin/herdr-webui-tui.
        let release_dir = home.join("release");
        fs::create_dir_all(&release_dir).unwrap();
        fs::write(release_dir.join("herdr-webui-tui"), "new-tui\n").unwrap();
        let (installed, outcome) = copy_sibling_tui_to_install_path(Some(&release_dir))
            .unwrap()
            .expect("sibling tui is installed");
        assert_eq!(outcome, CopyOutcome::Copied);
        assert_eq!(
            installed,
            home.join(".local").join("bin").join("herdr-webui-tui")
        );
        assert_eq!(
            fs::read_to_string(&installed).unwrap(),
            "new-tui\n",
            "installed copy holds the sibling bytes"
        );

        match original_home {
            Some(home) => std::env::set_var("HOME", home),
            None => std::env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn tui_install_path_targets_local_bin() {
        let _guard = env_lock().lock().unwrap();
        let original_home = std::env::var_os("HOME");
        let home =
            std::env::temp_dir().join(format!("herdr-webui-tui-path-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);

        assert_eq!(
            tui_install_bin_path().unwrap(),
            home.join(".local").join("bin").join("herdr-webui-tui")
        );

        match original_home {
            Some(home) => std::env::set_var("HOME", home),
            None => std::env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(&home);
    }
}

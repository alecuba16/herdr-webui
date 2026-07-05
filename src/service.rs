use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{TlsMode, WebConfig, INSTALL_LABEL};

pub fn install_macos(config: WebConfig) -> io::Result<()> {
    ensure_macos_user_context()?;
    let plist = mac_plist_path()?;
    let domain = mac_domain();
    let service = mac_service_target();
    log_macos_context("install", Some(&plist));
    let install_bin = copy_current_exe_to_install_path()?;
    fs::create_dir_all(plist.parent().expect("plist has parent"))?;
    fs::create_dir_all(mac_log_dir()?)?;
    fs::write(&plist, mac_plist_xml(&config, &install_bin)?)?;
    let plist_arg = plist.display().to_string();
    let _ = launchctl_quiet(&["bootout", &service]);
    launchctl_required(&["bootstrap", &domain, &plist_arg])?;
    launchctl_required(&["kickstart", "-k", &service])?;
    println!("Installed {INSTALL_LABEL} at {}", plist.display());
    println!("Installed binary at {}", install_bin.display());
    println!("Open {}://{}", config.tls.scheme(), config.bind);
    Ok(())
}

pub fn update_macos() -> io::Result<()> {
    ensure_macos_user_context()?;
    log_macos_context("update", mac_plist_path().ok().as_deref());
    let install_bin = copy_current_exe_to_install_path()?;
    restart_macos_service()?;
    println!("Updated binary at {}", install_bin.display());
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
    let install_bin = copy_current_exe_to_install_path()?;
    let service = linux_service_path()?;
    fs::create_dir_all(service.parent().expect("service path has parent"))?;
    fs::write(&service, linux_service_unit(&config, &install_bin))?;
    systemctl_user(&["daemon-reload"])?;
    systemctl_user(&["enable", "--now", &format!("{INSTALL_LABEL}.service")])?;
    println!("Installed {INSTALL_LABEL} at {}", service.display());
    println!("Installed binary at {}", install_bin.display());
    println!("Open {}://{}", config.tls.scheme(), config.bind);
    Ok(())
}

pub fn update_linux() -> io::Result<()> {
    let install_bin = copy_current_exe_to_install_path()?;
    systemctl_user(&["daemon-reload"])?;
    restart_linux_service()?;
    println!("Updated binary at {}", install_bin.display());
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

fn copy_current_exe_to_install_path() -> io::Result<PathBuf> {
    let source = std::env::current_exe()?;
    let target = install_bin_path()?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let same_file = source.canonicalize().ok() == target.canonicalize().ok();
    if !same_file {
        fs::copy(&source, &target)?;
    }
    let mut permissions = fs::metadata(&target)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o755);
    }
    fs::set_permissions(&target, permissions)?;
    Ok(target)
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

    #[test]
    fn linux_service_unit_contains_binary_and_flags() {
        let config = WebConfig {
            bind: "127.0.0.1:8787".parse().unwrap(),
            session: Some("work".to_string()),
            api_socket: None,
            client_socket: None,
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
            session: Some("work session's path".to_string()),
            api_socket: None,
            client_socket: None,
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
            session: Some("work".to_string()),
            api_socket: None,
            client_socket: None,
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
}

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{WebConfig, INSTALL_LABEL};

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
    println!("Open http://{}", config.bind);
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
    println!("Open http://{}", config.bind);
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
    use std::fs;
    use std::sync::MutexGuard;

    struct TestEnv {
        _guard: MutexGuard<'static, ()>,
        root: PathBuf,
        old_home: Option<std::ffi::OsString>,
        old_xdg: Option<std::ffi::OsString>,
        old_path: Option<std::ffi::OsString>,
        old_herdr_bin: Option<std::ffi::OsString>,
    }

    impl TestEnv {
        fn new() -> Self {
            let guard = crate::env_test_lock()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let root = std::env::temp_dir().join(format!(
                "herdr-webui-service-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            let bin = root.join("bin");
            fs::create_dir_all(&bin).unwrap();
            write_fake_command(&bin.join("systemctl"));
            write_fake_command(&bin.join("launchctl"));

            let old_home = std::env::var_os("HOME");
            let old_xdg = std::env::var_os("XDG_CONFIG_HOME");
            let old_path = std::env::var_os("PATH");
            let old_herdr_bin = std::env::var_os("HERDR_WEB_HERDR_BIN");

            std::env::set_var("HOME", &root);
            std::env::set_var("XDG_CONFIG_HOME", root.join("xdg"));
            let path = old_path
                .as_ref()
                .map(|value| format!("{}:{}", bin.display(), value.to_string_lossy()))
                .unwrap_or_else(|| bin.display().to_string());
            std::env::set_var("PATH", path);
            std::env::set_var("HERDR_WEB_HERDR_BIN", "/tmp/herdr bin");

            Self {
                _guard: guard,
                root,
                old_home,
                old_xdg,
                old_path,
                old_herdr_bin,
            }
        }

        fn config(&self) -> WebConfig {
            WebConfig {
                bind: "127.0.0.1:8787".parse().unwrap(),
                session: Some("mobile git".to_string()),
                api_socket: None,
                client_socket: None,
            }
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            restore_env("HOME", self.old_home.take());
            restore_env("XDG_CONFIG_HOME", self.old_xdg.take());
            restore_env("PATH", self.old_path.take());
            restore_env("HERDR_WEB_HERDR_BIN", self.old_herdr_bin.take());
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn restore_env(key: &str, value: Option<std::ffi::OsString>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    fn write_fake_command(path: &Path) {
        fs::write(
            path,
            "#!/bin/sh\nprintf '%s\\n' \"$0 $*\" >> \"$HOME/commands.log\"\nexit 0\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn linux_service_unit_contains_binary_and_flags() {
        let config = WebConfig {
            bind: "127.0.0.1:8787".parse().unwrap(),
            session: Some("work".to_string()),
            api_socket: None,
            client_socket: None,
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
        };

        let plist = mac_plist_xml(&config, Path::new("/tmp/herdr-webui")).unwrap();

        assert!(plist.contains("<string>/tmp/herdr-webui</string>"));
        assert!(plist.contains("<string>--bind</string>"));
        assert!(plist.contains("<string>127.0.0.1:8787</string>"));
        assert!(plist.contains("<string>--session</string>"));
        assert!(plist.contains("<string>work</string>"));
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
    fn linux_service_lifecycle_uses_user_systemd_files() {
        let env = TestEnv::new();

        install_linux(env.config()).unwrap();
        let service_path = linux_service_path().unwrap();
        let unit = fs::read_to_string(&service_path).unwrap();
        assert!(unit.contains("Environment=HERDR_WEB_HERDR_BIN='/tmp/herdr bin'"));
        assert!(unit.contains("--session 'mobile git'"));
        assert!(install_bin_path().unwrap().exists());

        start_linux_service().unwrap();
        stop_linux_service().unwrap();
        restart_linux_service().unwrap();
        update_linux().unwrap();
        uninstall_linux().unwrap();

        assert!(!service_path.exists());
        let commands = fs::read_to_string(env.root.join("commands.log")).unwrap();
        assert!(commands.contains("systemctl --user daemon-reload"));
        assert!(commands.contains("systemctl --user enable --now herdr-web.service"));
        assert!(commands.contains("systemctl --user start herdr-web.service"));
        assert!(commands.contains("systemctl --user stop herdr-web.service"));
        assert!(commands.contains("systemctl --user restart herdr-web.service"));
        assert!(commands.contains("systemctl --user disable --now herdr-web.service"));
    }

    #[test]
    fn linux_service_start_and_restart_require_installed_unit() {
        let _env = TestEnv::new();

        let start = start_linux_service().unwrap_err();
        assert_eq!(start.kind(), io::ErrorKind::NotFound);
        assert!(start.to_string().contains("systemd user service not found"));

        let restart = restart_linux_service().unwrap_err();
        assert_eq!(restart.kind(), io::ErrorKind::NotFound);
        assert!(restart
            .to_string()
            .contains("systemd user service not found"));
    }

    #[test]
    fn mac_service_lifecycle_uses_launchagent_files() {
        let env = TestEnv::new();

        install_macos(env.config()).unwrap();
        let plist = mac_plist_path().unwrap();
        let plist_xml = fs::read_to_string(&plist).unwrap();
        assert!(plist_xml.contains("<key>HERDR_WEB_HERDR_BIN</key>"));
        assert!(plist_xml.contains("<string>/tmp/herdr bin</string>"));
        assert!(plist_xml.contains("<string>mobile git</string>"));
        assert!(mac_log_dir().unwrap().exists());

        start_macos_service().unwrap();
        stop_macos_service().unwrap();
        restart_macos_service().unwrap();
        update_macos().unwrap();
        uninstall_macos().unwrap();

        assert!(!plist.exists());
        let commands = fs::read_to_string(env.root.join("commands.log")).unwrap();
        assert!(commands.contains("launchctl bootout gui/"));
        assert!(commands.contains("launchctl bootstrap gui/"));
        assert!(commands.contains("launchctl kickstart -k gui/"));
    }

    #[test]
    fn mac_service_start_requires_launchagent() {
        let _env = TestEnv::new();

        let err = start_macos_service().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(err.to_string().contains("LaunchAgent plist not found"));
    }
}

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output};

use crate::{WebConfig, INSTALL_LABEL};

trait ServiceCommandRunner {
    fn output(&self, command: &str, args: &[&str]) -> io::Result<Output>;
    fn status(&self, command: &str, args: &[&str]) -> io::Result<ExitStatus>;
}

struct RealServiceCommandRunner;

impl ServiceCommandRunner for RealServiceCommandRunner {
    fn output(&self, command: &str, args: &[&str]) -> io::Result<Output> {
        Command::new(command).args(args).output()
    }

    fn status(&self, command: &str, args: &[&str]) -> io::Result<ExitStatus> {
        Command::new(command).args(args).status()
    }
}

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

#[cfg(target_os = "linux")]
pub fn start_service() -> io::Result<()> {
    start_linux_service()
}

#[cfg(not(target_os = "linux"))]
pub fn start_service() -> io::Result<()> {
    start_macos_service()
}

#[cfg(target_os = "linux")]
pub fn stop_service() -> io::Result<()> {
    stop_linux_service()
}

#[cfg(not(target_os = "linux"))]
pub fn stop_service() -> io::Result<()> {
    stop_macos_service()
}

#[cfg(target_os = "linux")]
pub fn restart_service() -> io::Result<()> {
    restart_linux_service()
}

#[cfg(not(target_os = "linux"))]
pub fn restart_service() -> io::Result<()> {
    restart_macos_service()
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
    copy_exe_to_install_path(&source, &target)
}

fn copy_exe_to_install_path(source: &Path, target: &Path) -> io::Result<PathBuf> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let same_file = source.canonicalize().ok() == target.canonicalize().ok();
    if !same_file {
        fs::copy(source, target)?;
    }
    let mut permissions = fs::metadata(target)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o755);
    }
    fs::set_permissions(target, permissions)?;
    Ok(target.to_path_buf())
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
    launchctl_quiet_with(&RealServiceCommandRunner, args)
}

fn launchctl_quiet_with(runner: &impl ServiceCommandRunner, args: &[&str]) -> io::Result<bool> {
    let output = runner.output("launchctl", args)?;
    log_command_output("launchctl", args, &output);
    Ok(output.status.success())
}

fn launchctl_required(args: &[&str]) -> io::Result<()> {
    launchctl_required_with(&RealServiceCommandRunner, args)
}

fn launchctl_required_with(runner: &impl ServiceCommandRunner, args: &[&str]) -> io::Result<()> {
    let output = runner.output("launchctl", args)?;
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
    systemctl_user_with(&RealServiceCommandRunner, args)
}

fn systemctl_user_with(runner: &impl ServiceCommandRunner, args: &[&str]) -> io::Result<bool> {
    let all_args = std::iter::once("--user")
        .chain(args.iter().copied())
        .collect::<Vec<_>>();
    let status = runner.status("systemctl", &all_args)?;
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
    ensure_macos_user_context_for_euid(unsafe { libc_geteuid() })
}

fn ensure_macos_user_context_for_euid(euid: u32) -> io::Result<()> {
    if euid == 0 {
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
    use std::cell::RefCell;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;

    macro_rules! restore_env {
        ($key:literal, $value:expr) => {
            if let Some(value) = $value {
                std::env::set_var($key, value);
            } else {
                std::env::remove_var($key);
            }
        };
    }

    fn service_test_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-service-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[cfg(unix)]
    fn fake_command(bin_dir: &Path, name: &str) {
        use std::os::unix::fs::PermissionsExt;

        fs::create_dir_all(bin_dir).unwrap();
        let path = bin_dir.join(name);
        fs::write(
            &path,
            "#!/bin/sh\necho \"$0 $@\" >> \"$HERDR_WEB_FAKE_COMMAND_LOG\"\nexit 0\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(unix)]
    fn fake_failing_command(bin_dir: &Path, name: &str, stderr: &str) {
        use std::os::unix::fs::PermissionsExt;

        fs::create_dir_all(bin_dir).unwrap();
        let path = bin_dir.join(name);
        fs::write(&path, format!("#!/bin/sh\necho '{stderr}' >&2\nexit 7\n")).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(unix)]
    fn fake_launchctl_bootstrap_needed(bin_dir: &Path) {
        use std::os::unix::fs::PermissionsExt;

        fs::create_dir_all(bin_dir).unwrap();
        let path = bin_dir.join("launchctl");
        fs::write(
            &path,
            "#!/bin/sh\necho \"$@\" >> \"$HERDR_WEB_FAKE_COMMAND_LOG\"\nif [ \"$1\" = \"kickstart\" ] && [ ! -f \"$HERDR_WEB_FAKE_COMMAND_LOG.kicked\" ]; then touch \"$HERDR_WEB_FAKE_COMMAND_LOG.kicked\"; exit 1; fi\nexit 0\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn config() -> WebConfig {
        WebConfig {
            bind: "127.0.0.1:8787".parse().unwrap(),
            session: Some("work".to_string()),
            api_socket: None,
            client_socket: None,
        }
    }

    struct FakeRunner {
        output: io::Result<Output>,
        status: io::Result<ExitStatus>,
        calls: RefCell<Vec<String>>,
    }

    impl FakeRunner {
        #[cfg(unix)]
        fn new(output_code: i32, stderr: &str, status_code: i32) -> Self {
            Self {
                output: Ok(Output {
                    status: ExitStatus::from_raw(output_code << 8),
                    stdout: Vec::new(),
                    stderr: stderr.as_bytes().to_vec(),
                }),
                status: Ok(ExitStatus::from_raw(status_code << 8)),
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl ServiceCommandRunner for FakeRunner {
        fn output(&self, command: &str, args: &[&str]) -> io::Result<Output> {
            self.calls
                .borrow_mut()
                .push(format!("{command} {}", args.join(" ")));
            self.output
                .as_ref()
                .map(|output| Output {
                    status: output.status,
                    stdout: output.stdout.clone(),
                    stderr: output.stderr.clone(),
                })
                .map_err(|err| io::Error::new(err.kind(), err.to_string()))
        }

        fn status(&self, command: &str, args: &[&str]) -> io::Result<ExitStatus> {
            self.calls
                .borrow_mut()
                .push(format!("{command} {}", args.join(" ")));
            self.status
                .as_ref()
                .copied()
                .map_err(|err| io::Error::new(err.kind(), err.to_string()))
        }
    }

    #[cfg(unix)]
    #[test]
    fn command_helpers_use_injected_runner() {
        let ok = FakeRunner::new(0, "", 0);
        assert!(launchctl_quiet_with(&ok, &["kickstart"]).unwrap());
        assert!(launchctl_required_with(&ok, &["bootstrap"]).is_ok());
        assert!(systemctl_user_with(&ok, &["start", "herdr-web.service"]).unwrap());
        assert_eq!(
            ok.calls.borrow().as_slice(),
            [
                "launchctl kickstart",
                "launchctl bootstrap",
                "systemctl --user start herdr-web.service"
            ]
        );

        let fail = FakeRunner::new(7, "bad", 7);
        assert!(!launchctl_quiet_with(&fail, &["noop"]).unwrap());
        assert!(launchctl_required_with(&fail, &["bootstrap"])
            .unwrap_err()
            .to_string()
            .contains("bad"));
        assert!(systemctl_user_with(&fail, &["stop", "herdr-web.service"])
            .unwrap_err()
            .to_string()
            .contains("systemctl --user stop herdr-web.service failed"));

        let empty = FakeRunner::new(7, "", 0);
        assert!(launchctl_required_with(&empty, &["bootstrap"])
            .unwrap_err()
            .to_string()
            .contains("exit status"));
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
    fn linux_service_unit_includes_herdr_bin_environment() {
        let _guard = crate::test_env_lock().lock().unwrap();
        let old_herdr_bin = std::env::var_os("HERDR_WEB_HERDR_BIN");
        std::env::set_var("HERDR_WEB_HERDR_BIN", "/tmp/herdr bin");

        let unit = linux_service_unit(&config(), Path::new("/tmp/herdr-webui"));

        assert!(unit.contains("Environment=HERDR_WEB_HERDR_BIN='/tmp/herdr bin'"));
        restore_env!("HERDR_WEB_HERDR_BIN", old_herdr_bin);
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
    fn service_paths_use_home_and_xdg_config_home() {
        let _guard = crate::test_env_lock().lock().unwrap();
        let root =
            std::env::temp_dir().join(format!("herdr-webui-service-paths-{}", std::process::id()));
        let home = root.join("home");
        let xdg = root.join("xdg");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&xdg).unwrap();

        let old_home = std::env::var_os("HOME");
        let old_xdg = std::env::var_os("XDG_CONFIG_HOME");
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", &xdg);

        assert_eq!(home_dir().unwrap(), home);
        assert_eq!(local_bin_dir().unwrap(), home.join(".local/bin"));
        assert_eq!(
            install_bin_path().unwrap(),
            home.join(".local/bin/herdr-webui")
        );
        assert_eq!(
            mac_log_dir().unwrap(),
            home.join("Library/Logs/herdr-webui")
        );
        assert_eq!(
            mac_plist_path().unwrap(),
            home.join("Library/LaunchAgents/herdr-web.plist")
        );
        assert_eq!(
            linux_service_path().unwrap(),
            xdg.join("systemd/user/herdr-web.service")
        );
        let missing = ensure_linux_service_exists().unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);

        restore_env!("HOME", old_home);
        restore_env!("XDG_CONFIG_HOME", old_xdg);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn service_helpers_cover_copy_skip_and_root_guard() {
        use std::os::unix::fs::PermissionsExt;

        let root = service_test_root("copy-helper");
        let source = root.join("source-bin");
        fs::write(&source, "bin").unwrap();

        let copied = copy_exe_to_install_path(&source, &root.join("nested/herdr-webui")).unwrap();
        assert_eq!(copied, root.join("nested/herdr-webui"));
        assert_eq!(fs::read_to_string(&copied).unwrap(), "bin");
        assert_eq!(
            fs::metadata(&copied).unwrap().permissions().mode() & 0o777,
            0o755
        );

        let skipped = copy_exe_to_install_path(&copied, &copied).unwrap();
        assert_eq!(skipped, copied);

        let root_error = ensure_macos_user_context_for_euid(0).unwrap_err();
        assert_eq!(root_error.kind(), io::ErrorKind::PermissionDenied);
        assert!(ensure_macos_user_context_for_euid(501).is_ok());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn service_command_targets_and_verbose_flag_are_derived() {
        let _guard = crate::test_env_lock().lock().unwrap();
        let old_verbose = std::env::var_os("HERDR_WEB_VERBOSE");

        std::env::remove_var("HERDR_WEB_VERBOSE");
        assert!(!service_verbose());
        std::env::set_var("HERDR_WEB_VERBOSE", "yes");
        assert!(service_verbose());
        std::env::set_var("HERDR_WEB_VERBOSE", "0");
        assert!(!service_verbose());

        let domain = mac_domain();
        assert!(domain.starts_with("gui/"));
        assert_eq!(mac_service_target(), format!("{domain}/{INSTALL_LABEL}"));

        restore_env!("HERDR_WEB_VERBOSE", old_verbose);
    }

    #[cfg(unix)]
    #[test]
    fn service_failure_and_verbose_paths_are_reported() {
        let _guard = crate::test_env_lock().lock().unwrap();
        let root = service_test_root("failures");
        let home = root.join("home");
        let bin_dir = root.join("bin");
        fs::create_dir_all(&home).unwrap();
        fake_failing_command(&bin_dir, "launchctl", "launch bad");
        fake_failing_command(&bin_dir, "systemctl", "system bad");

        let old_home = std::env::var_os("HOME");
        let old_path = std::env::var_os("PATH");
        let old_verbose = std::env::var_os("HERDR_WEB_VERBOSE");
        std::env::set_var("HOME", &home);
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                bin_dir.display(),
                old_path
                    .as_ref()
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default()
            ),
        );
        std::env::set_var("HERDR_WEB_VERBOSE", "1");

        let missing = start_macos_service().unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);

        let quiet = launchctl_quiet(&["noop"]).unwrap();
        assert!(!quiet);
        let required = launchctl_required(&["bootstrap"]).unwrap_err();
        assert!(required.to_string().contains("launch bad"));

        fake_failing_command(&bin_dir, "launchctl", "");
        let required = launchctl_required(&["bootstrap-empty"]).unwrap_err();
        assert!(required.to_string().contains("exit status"));

        let systemctl = systemctl_user(&["start", "herdr-web.service"]).unwrap_err();
        assert!(systemctl
            .to_string()
            .contains("systemctl --user start herdr-web.service failed"));

        log_macos_context("test", Some(&home.join("missing.plist")));
        let output = std::process::Command::new(bin_dir.join("launchctl"))
            .arg("noop")
            .output()
            .unwrap();
        log_command_output("launchctl", &["noop"], &output);
        let output = std::process::Command::new("sh")
            .args(["-c", "echo out; echo err >&2"])
            .output()
            .unwrap();
        log_command_output("sh", &["-c"], &output);

        restore_env!("HOME", old_home);
        restore_env!("PATH", old_path);
        restore_env!("HERDR_WEB_VERBOSE", old_verbose);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn linux_service_lifecycle_uses_fake_systemctl() {
        let _guard = crate::test_env_lock().lock().unwrap();
        let root = service_test_root("linux-lifecycle");
        let home = root.join("home");
        let xdg = root.join("xdg");
        let bin_dir = root.join("bin");
        let log = root.join("commands.log");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&xdg).unwrap();
        fake_command(&bin_dir, "systemctl");

        let old_home = std::env::var_os("HOME");
        let old_xdg = std::env::var_os("XDG_CONFIG_HOME");
        let old_path = std::env::var_os("PATH");
        let old_log = std::env::var_os("HERDR_WEB_FAKE_COMMAND_LOG");
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", &xdg);
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                bin_dir.display(),
                old_path
                    .as_ref()
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default()
            ),
        );
        std::env::set_var("HERDR_WEB_FAKE_COMMAND_LOG", &log);

        install_linux(config()).unwrap();
        start_linux_service().unwrap();
        restart_linux_service().unwrap();
        update_linux().unwrap();
        stop_linux_service().unwrap();
        uninstall_linux().unwrap();

        let service = xdg.join("systemd/user/herdr-web.service");
        assert!(!service.exists());
        let commands = fs::read_to_string(&log).unwrap();
        assert!(commands.contains("--user daemon-reload"));
        assert!(commands.contains("--user enable --now herdr-web.service"));
        assert!(commands.contains("--user start herdr-web.service"));
        assert!(commands.contains("--user restart herdr-web.service"));
        assert!(commands.contains("--user stop herdr-web.service"));
        assert!(home.join(".local/bin/herdr-webui").exists());

        restore_env!("HOME", old_home);
        restore_env!("XDG_CONFIG_HOME", old_xdg);
        restore_env!("PATH", old_path);
        restore_env!("HERDR_WEB_FAKE_COMMAND_LOG", old_log);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn macos_service_lifecycle_uses_fake_launchctl() {
        let _guard = crate::test_env_lock().lock().unwrap();
        let root = service_test_root("macos-lifecycle");
        let home = root.join("home");
        let bin_dir = root.join("bin");
        let log = root.join("commands.log");
        fs::create_dir_all(&home).unwrap();
        fake_command(&bin_dir, "launchctl");

        let old_home = std::env::var_os("HOME");
        let old_path = std::env::var_os("PATH");
        let old_log = std::env::var_os("HERDR_WEB_FAKE_COMMAND_LOG");
        let old_herdr_bin = std::env::var_os("HERDR_WEB_HERDR_BIN");
        std::env::set_var("HOME", &home);
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                bin_dir.display(),
                old_path
                    .as_ref()
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default()
            ),
        );
        std::env::set_var("HERDR_WEB_FAKE_COMMAND_LOG", &log);
        std::env::set_var("HERDR_WEB_HERDR_BIN", "/tmp/herdr fake/bin");

        install_macos(config()).unwrap();
        start_macos_service().unwrap();
        restart_macos_service().unwrap();
        update_macos().unwrap();
        stop_macos_service().unwrap();
        uninstall_macos().unwrap();

        let plist = home.join("Library/LaunchAgents/herdr-web.plist");
        assert!(!plist.exists());
        assert!(home.join("Library/Logs/herdr-webui").exists());
        assert!(home.join(".local/bin/herdr-webui").exists());
        let commands = fs::read_to_string(&log).unwrap();
        assert!(commands.contains("bootout"));
        assert!(commands.contains("bootstrap"));
        assert!(commands.contains("kickstart -k"));

        restore_env!("HOME", old_home);
        restore_env!("PATH", old_path);
        restore_env!("HERDR_WEB_FAKE_COMMAND_LOG", old_log);
        restore_env!("HERDR_WEB_HERDR_BIN", old_herdr_bin);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn macos_start_bootstraps_when_kickstart_fails() {
        let _guard = crate::test_env_lock().lock().unwrap();
        let root = service_test_root("macos-bootstrap");
        let home = root.join("home");
        let bin_dir = root.join("bin");
        let log = root.join("commands.log");
        fs::create_dir_all(home.join("Library/LaunchAgents")).unwrap();
        fs::write(home.join("Library/LaunchAgents/herdr-web.plist"), "plist").unwrap();
        fake_launchctl_bootstrap_needed(&bin_dir);

        let old_home = std::env::var_os("HOME");
        let old_path = std::env::var_os("PATH");
        let old_log = std::env::var_os("HERDR_WEB_FAKE_COMMAND_LOG");
        std::env::set_var("HOME", &home);
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                bin_dir.display(),
                old_path
                    .as_ref()
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default()
            ),
        );
        std::env::set_var("HERDR_WEB_FAKE_COMMAND_LOG", &log);

        start_macos_service().unwrap();

        let commands = fs::read_to_string(&log).unwrap();
        assert!(commands.contains("kickstart -k"));
        assert!(commands.contains("bootstrap"));

        restore_env!("HOME", old_home);
        restore_env!("PATH", old_path);
        restore_env!("HERDR_WEB_FAKE_COMMAND_LOG", old_log);
        let _ = fs::remove_dir_all(root);
    }
}

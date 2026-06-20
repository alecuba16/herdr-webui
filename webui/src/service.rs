use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{WebConfig, INSTALL_LABEL};

pub fn install_macos(config: WebConfig) -> io::Result<()> {
    let install_bin = copy_current_exe_to_install_path()?;
    let plist = mac_plist_path()?;
    fs::create_dir_all(plist.parent().expect("plist has parent"))?;
    fs::create_dir_all(mac_log_dir()?)?;
    fs::write(&plist, mac_plist_xml(&config, &install_bin)?)?;
    let domain = mac_domain();
    let plist_arg = plist.display().to_string();
    let _ = launchctl(&["bootout", &domain, &plist_arg]);
    launchctl(&["bootstrap", &domain, &plist_arg])?;
    launchctl(&["kickstart", "-k", &format!("{domain}/{INSTALL_LABEL}")])?;
    println!("Installed {INSTALL_LABEL} at {}", plist.display());
    println!("Installed binary at {}", install_bin.display());
    println!("Open http://{}", config.bind);
    Ok(())
}

pub fn update_macos() -> io::Result<()> {
    let install_bin = copy_current_exe_to_install_path()?;
    restart_macos_service()?;
    println!("Updated binary at {}", install_bin.display());
    Ok(())
}

pub fn start_macos_service() -> io::Result<()> {
    let plist = mac_plist_path()?;
    if !plist.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("LaunchAgent plist not found at {}", plist.display()),
        ));
    }
    let domain = mac_domain();
    let service = format!("{domain}/{INSTALL_LABEL}");
    if !launchctl(&["kickstart", "-k", &service])? {
        launchctl(&["bootstrap", &domain, &plist.display().to_string()])?;
        launchctl(&["kickstart", "-k", &service])?;
    }
    println!("Started {INSTALL_LABEL}");
    Ok(())
}

pub fn stop_macos_service() -> io::Result<()> {
    let domain = mac_domain();
    let service = format!("{domain}/{INSTALL_LABEL}");
    let _ = launchctl(&["bootout", &service]);
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
    let plist = mac_plist_path()?;
    let domain = mac_domain();
    let _ = launchctl(&["bootout", &domain, &plist.display().to_string()]);
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

fn launchctl(args: &[&str]) -> io::Result<bool> {
    let status = Command::new("launchctl").args(args).status()?;
    Ok(status.success())
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

#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

#[cfg(not(unix))]
unsafe fn libc_getuid() -> u32 {
    0
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
        };

        let unit = linux_service_unit(&config, Path::new("/tmp/herdr-webui"));

        assert!(unit.contains("ExecStart=/tmp/herdr-webui --bind 127.0.0.1:8787 --session work"));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("WantedBy=default.target"));
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
}

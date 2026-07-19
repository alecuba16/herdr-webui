use std::io;
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

struct NoSleepGuard {
    child: Child,
}

impl Drop for NoSleepGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) struct NoSleepState {
    pub(crate) mode: String,
    pub(crate) until_ms: Option<u64>,
    pub(crate) error: Option<String>,
    guard: Option<NoSleepGuard>,
    pub(crate) auto_generation: u64,
    pub(crate) auto_idle_since_ms: Option<u64>,
}

impl NoSleepState {
    pub(crate) fn active(&self) -> bool {
        self.guard.is_some()
    }

    pub(crate) fn clear_guard(&mut self) {
        self.guard = None;
    }
}

impl Default for NoSleepState {
    fn default() -> Self {
        Self {
            mode: "off".to_string(),
            until_ms: None,
            error: None,
            guard: None,
            auto_generation: 0,
            auto_idle_since_ms: None,
        }
    }
}

pub(crate) fn no_sleep_ms(mode: &str) -> Option<u64> {
    match mode {
        "off" | "auto" | "infinite" => Some(0),
        "1h" => Some(60 * 60 * 1000),
        "2h" => Some(2 * 60 * 60 * 1000),
        "4h" => Some(4 * 60 * 60 * 1000),
        _ => None,
    }
}

pub(crate) fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn start_no_sleep_guard() -> io::Result<NoSleepGuard> {
    #[cfg(target_os = "macos")]
    let child = Command::new("caffeinate")
        .args(["-dimsu"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    #[cfg(target_os = "linux")]
    let child = Command::new("systemd-inhibit")
        .args([
            "--what=sleep:idle",
            "--who=herdr-webui",
            "--why=Herdr WebUI no-sleep mode",
            "sleep",
            "infinity",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no-sleep mode is only supported on macOS and Linux",
    ));
    Ok(NoSleepGuard { child })
}

pub(crate) fn no_sleep_public_json(state: &NoSleepState) -> serde_json::Value {
    json!({
        "mode": &state.mode,
        "until_ms": state.until_ms,
        "error": &state.error,
        "active": state.active(),
        "supported": cfg!(any(target_os = "macos", target_os = "linux")),
    })
}

pub(crate) fn agents_working_from_value(value: &serde_json::Value) -> bool {
    value
        .pointer("/result/agents")
        .and_then(|agents| agents.as_array())
        .is_some_and(|agents| {
            agents.iter().any(|agent| {
                agent
                    .get("agent_status")
                    .or_else(|| agent.get("status"))
                    .and_then(|status| status.as_str())
                    == Some("working")
            })
        })
}

pub(crate) fn sync_auto_no_sleep(
    state: &mut NoSleepState,
    has_working_agents: bool,
    cooldown_seconds: u64,
) {
    if state.mode != "auto" {
        return;
    }
    if has_working_agents && state.guard.is_none() {
        state.auto_idle_since_ms = None;
        match start_no_sleep_guard() {
            Ok(guard) => {
                state.guard = Some(guard);
                state.error = None;
            }
            Err(err) => {
                state.error = Some(err.to_string());
            }
        }
    } else if has_working_agents {
        state.auto_idle_since_ms = None;
        state.error = None;
    } else {
        let now = unix_ms_now();
        let idle_since = *state.auto_idle_since_ms.get_or_insert(now);
        if now.saturating_sub(idle_since) >= cooldown_seconds.saturating_mul(1000) {
            state.guard = None;
            state.mode = "off".to_string();
            state.until_ms = None;
            state.auto_idle_since_ms = None;
            state.error = None;
        }
    }
}

pub(crate) fn apply_no_sleep_mode(
    state: &mut NoSleepState,
    mode: String,
    until_ms: Option<u64>,
) -> (bool, u64) {
    state.auto_generation = state.auto_generation.wrapping_add(1);
    let generation = state.auto_generation;
    state.guard = None;
    state.mode = "off".to_string();
    state.until_ms = None;
    state.error = None;
    state.auto_idle_since_ms = None;
    if mode == "off" || mode == "auto" {
        state.mode = mode;
        return (false, generation);
    }
    match start_no_sleep_guard() {
        Ok(guard) => {
            state.mode = mode;
            state.until_ms = until_ms;
            state.guard = Some(guard);
            (true, generation)
        }
        Err(err) => {
            state.error = Some(err.to_string());
            (false, generation)
        }
    }
}

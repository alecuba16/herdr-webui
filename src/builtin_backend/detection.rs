//! Agent label/status detection from process tables and terminal output.

use super::*;

pub(super) fn workspace_label(cwd: &Path) -> String {
    cwd.file_name()
        .and_then(|name| name.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

pub(super) fn id_sort_key(id: &str) -> usize {
    id.rsplit('_')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
}

pub(super) fn detect_agent_label(argv: &[String]) -> Option<&'static str> {
    argv.first().and_then(|command| {
        let name = Path::new(command)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(command)
            .to_lowercase();
        match name.as_str() {
            "pi" => Some("pi"),
            "jcode" => Some("jcode"),
            "claude" | "claude-code" => Some("claude"),
            "codex" => Some("codex"),
            "gemini" => Some("gemini"),
            "cursor" | "cursor-agent" => Some("cursor"),
            "devin" | "devin-cli" => Some("devin"),
            "agy" | "antigravity" | "antigravity-cli" => Some("agy"),
            "cline" => Some("cline"),
            "omp" => Some("omp"),
            "mastracode" | "mastra-code" => Some("mastracode"),
            "opencode" | "open-code" => Some("opencode"),
            "copilot" | "github-copilot" | "ghcs" => Some("copilot"),
            "kimi" | "kimi-code" => Some("kimi"),
            "kiro" | "kiro-cli" => Some("kiro"),
            "droid" => Some("droid"),
            "amp" | "amp-local" => Some("amp"),
            "grok" | "grok-build" => Some("grok"),
            "hermes" | "hermes-agent" => Some("hermes"),
            "kilo" | "kilo-code" => Some("kilo"),
            "qodercli" | "qoderclicn" | "qoder" | "qodercn" => Some("qodercli"),
            "maki" => Some("maki"),
            "claurst" => Some("claurst"),
            "qwen" | "qwen-code" => Some("qwen"),
            _ => None,
        }
    })
}

pub(super) fn detect_agent_label_from_text(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    if lower.contains("opencode")
        || lower.contains("△ permission required")
        || (lower.contains("esc dismiss") && lower.contains("enter confirm"))
    {
        return Some("opencode");
    }
    let bottom3 = bottom_non_empty_lines(&lower, 3);
    let bottom8 = bottom_non_empty_lines(&lower, 8);
    let bottom12 = bottom_non_empty_lines(&lower, 12);
    if mentions_jcode_brand(&lower)
        || jcode_blocked_markers(&bottom8)
        || has_jcode_spinner(&bottom3)
        || is_jcode_active_background_line(&bottom8)
        || lower.contains("network disconnected, waiting to retry")
        || bottom12
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .is_some_and(|line| {
                let line = line.trim();
                jcode_numbered_prompt_line(line) || jcode_shell_prompt_line(line)
            })
    {
        return Some("jcode");
    }
    if lower.contains("claurst")
        || (lower.contains("yes, allow once") && lower.contains("no, deny"))
        || (lower.contains("yes, always allow (persistent)")
            && lower.contains("yes, allow this session"))
    {
        return Some("claurst");
    }
    // Qwen Code: detect from its signature confirmation and composer patterns.
    if (lower.contains("yes, allow once")
        && contains_any(
            &lower,
            &[
                "apply this change?",
                "allow execution of:",
                "do you want to proceed?",
                "shell command execution",
            ],
        ))
        || (lower.contains("do you trust this folder?") && lower.contains("don't trust (esc)"))
    {
        return Some("qwen");
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ProcessInfo {
    pub(super) pid: u32,
    pub(super) ppid: u32,
    pub(super) command: String,
    pub(super) args: String,
}

pub(super) type ProcessCache = Option<(Instant, Vec<ProcessInfo>)>;

#[cfg(unix)]
pub(super) fn process_table() -> io::Result<Vec<ProcessInfo>> {
    static CACHE: OnceLock<Mutex<ProcessCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cache.lock() {
        if let Some((loaded_at, processes)) = guard.as_ref() {
            if loaded_at.elapsed() < Duration::from_millis(250) {
                return Ok(processes.clone());
            }
        }
        let processes = process_table_uncached()?;
        *guard = Some((Instant::now(), processes.clone()));
        return Ok(processes);
    }
    process_table_uncached()
}

#[cfg(unix)]
pub(super) fn process_table_uncached() -> io::Result<Vec<ProcessInfo>> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,comm=,args="])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("ps failed"));
    }
    Ok(parse_process_table(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(not(unix))]
pub(super) fn process_table() -> io::Result<Vec<ProcessInfo>> {
    Ok(Vec::new())
}

/// Reads a live process's current working directory. Used by `tab.promote`
/// to root the promoted workspace at the directory the shell `cd`-ed into,
/// not the PTY spawn cwd, and by chat-lens PaneContexts to check a session's
/// cwd evidence. Returns `None` when the probe fails (missing pid,
/// permission denied, unsupported platform) so callers fall back to the
/// pane's registered cwd.
#[cfg(unix)]
pub(super) fn live_process_cwd(pid: Option<u32>) -> Option<PathBuf> {
    let pid = pid?;
    #[cfg(target_os = "linux")]
    {
        // Cheapest probe: /proc/<pid>/cwd resolves to the live cwd.
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        macos_process_cwd(pid)
    }
}

/// Native cwd probe for macOS (and other non-Linux unixes carrying
/// libSystem). The old implementation forked `lsof` per call (50-200ms),
/// paid on every conversation poll and every agents refresh;
/// `proc_pidinfo(PROC_PIDVNODEPATHINFO)` reads the same kernel vnode the
/// cwd points at, at syscall cost (microseconds). Returns None on any
/// failure: missing pid, EPERM, empty path.
#[cfg(all(unix, not(target_os = "linux")))]
pub(super) fn macos_process_cwd(pid: u32) -> Option<PathBuf> {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    // Mirrors <sys/proc_info.h> vnode_info_path so the cwd path can be
    // read out of the struct the kernel fills. Only pvi_cdir.vip_path is
    // consumed; the stat fields exist just to keep the layout exact.
    // vinfo_stat's largest member alignment is 8, so the whole struct is
    // naturally 8-aligned on every ABI we target.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct VinfoStat {
        vst_dev: u32,
        vst_mode: u16,
        vst_nlink: u16,
        vst_ino: u64,
        vst_uid: u32,
        vst_gid: u32,
        vst_atime: i64,
        vst_atimensec: i64,
        vst_mtime: i64,
        vst_mtimensec: i64,
        vst_ctime: i64,
        vst_ctimensec: i64,
        vst_birthtime: i64,
        vst_birthtimensec: i64,
        vst_size: i64,
        vst_blocks: i64,
        vst_blksize: i32,
        vst_flags: u32,
        vst_gen: u32,
        vst_rdev: u32,
        vst_qspare: [i64; 2],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct VnodeInfo {
        vi_stat: VinfoStat,
        vi_type: i32,
        vi_pad: i32,
        vi_fsid: [i32; 2], // fsid_t: two int32_t
    }
    #[repr(C)]
    struct VnodeInfoPath {
        vip_vi: VnodeInfo,
        vip_path: [u8; 1024], // MAXPATHLEN
    }
    #[repr(C)]
    struct ProcVnodePathInfo {
        pvi_cdir: VnodeInfoPath, // current working directory
        pvi_rdir: VnodeInfoPath, // root directory (chroot)
    }
    extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut core::ffi::c_void,
            buffersize: i32,
        ) -> i32;
    }
    const PROC_PIDVNODEPATHINFO: i32 = 9;
    // All-zero POD: every field is an integer, no niches, valid repr(C).
    let mut info: ProcVnodePathInfo = unsafe { core::mem::zeroed() };
    let size = core::mem::size_of::<ProcVnodePathInfo>() as i32;
    let rc = unsafe {
        proc_pidinfo(
            pid as i32,
            PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut core::ffi::c_void,
            size,
        )
    };
    if rc < size {
        return None;
    }
    let path = &info.pvi_cdir.vip_path;
    let len = path.iter().position(|&b| b == 0)?;
    if len == 0 {
        return None;
    }
    Some(PathBuf::from(OsStr::from_bytes(&path[..len])))
}

#[cfg(not(unix))]
pub(super) fn live_process_cwd(_pid: Option<u32>) -> Option<PathBuf> {
    None
}

pub(super) fn parse_process_table(raw: &str) -> Vec<ProcessInfo> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            let command = parts.next()?.to_string();
            let args = parts.collect::<Vec<_>>().join(" ");
            Some(ProcessInfo {
                pid,
                ppid,
                command,
                args,
            })
        })
        .collect()
}

pub(super) fn detect_agent_label_from_processes(
    root_pid: u32,
    processes: &[ProcessInfo],
) -> Option<&'static str> {
    let by_pid = processes
        .iter()
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for process in processes {
        children.entry(process.ppid).or_default().push(process.pid);
    }
    let mut stack = vec![root_pid];
    let mut seen = HashSet::<u32>::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(process) = by_pid.get(&pid) {
            if let Some(agent) = detect_agent_label_from_process(process) {
                return Some(agent);
            }
        }
        if let Some(child_pids) = children.get(&pid) {
            stack.extend(child_pids.iter().copied());
        }
    }
    None
}

pub(super) fn detect_agent_label_from_process(process: &ProcessInfo) -> Option<&'static str> {
    if let Some(agent) = detect_agent_label(std::slice::from_ref(&process.command)) {
        return Some(agent);
    }

    let argv = process_args_tokens(&process.args);
    if let Some(agent) = argv
        .first()
        .and_then(|candidate| detect_agent_label(std::slice::from_ref(candidate)))
    {
        return Some(agent);
    }

    let runtime = argv.first().map(String::as_str).unwrap_or(&process.command);
    if is_generic_runtime_or_shell(runtime) {
        return wrapped_agent_label_from_runtime_argv(runtime, &argv);
    }

    None
}

pub(super) fn wrapped_agent_label_from_runtime_argv(
    runtime: &str,
    argv: &[String],
) -> Option<&'static str> {
    let runtime = normalized_command_name(runtime);
    match runtime.as_str() {
        "node" | "bun" => script_arg_agent_label(argv, &["-e", "--eval", "-p", "--print"], &[]),
        "python" | "python3" => script_arg_agent_label(argv, &["-c"], &["-m"]),
        "sh" | "bash" | "zsh" | "fish" => script_arg_agent_label(argv, &["-c"], &[]),
        _ => None,
    }
}

pub(super) fn script_arg_agent_label(
    argv: &[String],
    eval_flags: &[&str],
    module_flags: &[&str],
) -> Option<&'static str> {
    let mut args = argv.iter().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--" {
            return args
                .next()
                .and_then(|token| detect_agent_label(std::slice::from_ref(token)));
        }
        if flag_matches(arg, eval_flags) || flag_matches(arg, module_flags) {
            return None;
        }
        if arg.starts_with('-') {
            if option_takes_value(arg) {
                let _ = args.next();
            }
            continue;
        }
        return detect_agent_label(std::slice::from_ref(arg));
    }
    None
}

pub(super) fn flag_matches(arg: &str, flags: &[&str]) -> bool {
    flags
        .iter()
        .any(|flag| arg == *flag || short_flag_payload(arg, flag) || long_flag_value(arg, flag))
}

pub(super) fn short_flag_payload(arg: &str, flag: &str) -> bool {
    flag.starts_with('-')
        && !flag.starts_with("--")
        && arg.starts_with(flag)
        && arg.len() > flag.len()
}

pub(super) fn long_flag_value(arg: &str, flag: &str) -> bool {
    flag.starts_with("--")
        && arg
            .strip_prefix(flag)
            .is_some_and(|rest| rest.starts_with('='))
}

pub(super) fn option_takes_value(arg: &str) -> bool {
    matches!(
        arg,
        "-r" | "--require"
            | "--loader"
            | "--import"
            | "--experimental-loader"
            | "--inspect-port"
            | "-W"
            | "-X"
            | "-S"
            | "-L"
            | "-o"
    )
}

pub(super) fn is_generic_runtime_or_shell(name: &str) -> bool {
    matches!(
        normalized_command_name(name).as_str(),
        "sh" | "bash" | "zsh" | "fish" | "tmux" | "node" | "bun" | "python" | "python3"
    )
}

pub(super) fn normalized_command_name(name: &str) -> String {
    let mut name = Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(name)
        .trim_matches(|ch| matches!(ch, '"' | '\''))
        .to_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".ps1", ".js"] {
        if name.ends_with(suffix) {
            name.truncate(name.len() - suffix.len());
            break;
        }
    }
    name
}

pub(super) fn process_args_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            ch if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            ch => current.push(ch),
        }
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Detect agent status using OSC 9 progress payload as primary signal,
/// falling back to screen-scraping when no OSC payload is present.
/// This mirrors herdr's manifest-based detection: OSC rules at priority 1100
/// always win over screen-scrape rules at lower priority.
pub(super) fn detect_agent_status_with_osc(
    agent: Option<&str>,
    text: &str,
    osc_progress: &str,
    osc_title: &str,
    jcode_variant: JcodeDetectionVariant,
) -> &'static str {
    // OSC title rules have the highest priority (up to 1300 in manifests).
    // Check them before OSC progress and screen-scrape.
    if !osc_title.is_empty() {
        if let Some(agent) = agent {
            if let Some(status) = osc_title_status_for_agent(agent, osc_title) {
                return status;
            }
        }
    }
    if !osc_progress.is_empty() {
        let Some(agent) = agent else {
            return "unknown";
        };
        if let Some(status) = osc_progress_status_for_agent(agent, osc_progress) {
            return status;
        }
    }
    detect_agent_status(agent, text, jcode_variant)
}

/// Map an OSC 9 progress payload to an agent status string.
///
/// Agents emit structured progress via OSC 9:
/// - jcode (herdr_detectable branch only; master never emits OSC 9):
///   `jcode:working`, `jcode:idle`, `jcode:blocked`
/// - Claude: OSC 9;4 `4;0` → idle only (no working rule in manifest)
/// - Qwen: OSC 9;4 `4;3` → working only (no idle rule in manifest)
/// - Grok: OSC 9;4 `4;1;-1` → working, `4;0;0` → idle
///
/// Returns `None` for unknown formats so the caller falls back to
/// screen-scrape detection.
pub(super) fn osc_progress_status_for_agent(
    agent: &str,
    osc_progress: &str,
) -> Option<&'static str> {
    match agent {
        "jcode" => match osc_progress {
            "jcode:working" => Some("working"),
            "jcode:idle" => Some("idle"),
            "jcode:blocked" => Some("blocked"),
            _ => None,
        },
        // Claude manifest: osc_progress_idle regex '^4;0' → idle only.
        // No osc_progress_working rule; 4;3 falls through to screen-scrape.
        "claude" => {
            if osc_progress.starts_with("4;0") {
                Some("idle")
            } else {
                None
            }
        }
        // Qwen manifest: osc_tool_progress_working regex '^4;3(?:;|$)' →
        // working only. No osc_progress_idle rule; 4;0 falls through to
        // screen-scrape.
        "qwen" => {
            if osc_progress.starts_with("4;3") {
                Some("working")
            } else {
                None
            }
        }
        // Grok emits OSC 9;4 with payload "4;1;-1" while busy and "4;0;0" idle.
        "grok" => {
            if osc_progress == "4;1;-1" {
                Some("working")
            } else if osc_progress == "4;0;0" {
                Some("idle")
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Map an OSC 0/2 terminal title to an agent status string based on
/// `osc_title` manifest rules. Returns `None` when the title doesn't match
/// any known pattern, letting the caller fall back to OSC progress or
/// screen-scrape detection.
///
/// Mirrors the `osc_title` rules from herdr's detection manifests for:
/// amp, claude, codex, grok, hermes, qwen. The jcode arm reads jcode's
/// own title grammar instead (work/last segments).
pub(super) fn osc_title_status_for_agent(agent: &str, title: &str) -> Option<&'static str> {
    match agent {
        // amp.toml: blocked if "Plugin confirmation needed", working if
        // braille prefix, idle if " - amp - " without braille/blocker.
        "amp" => {
            if title.contains("Plugin confirmation needed") {
                Some("blocked")
            } else if starts_with_braille(title) {
                Some("working")
            } else if title.contains(" - amp - ") {
                Some("idle")
            } else {
                None
            }
        }
        // claude.toml: working if braille or half-circle prefix, idle if ✳ prefix.
        "claude" => {
            if has_claude_half_circle_spinner(title) || starts_with_braille(title) {
                Some("working")
            } else if title.starts_with('✳') {
                // ✳ U+2733 followed by optional FE0E and space.
                let chars: Vec<char> = title.chars().collect();
                if chars.len() >= 2 && (chars[1] == ' ' || chars[1] == '\u{fe0e}') {
                    Some("idle")
                } else {
                    None
                }
            } else {
                None
            }
        }
        // codex.toml: blocked if "Action Required", working if braille anywhere,
        // idle if non-empty without braille/blocker.
        "codex" => {
            if title.contains("Action Required") {
                Some("blocked")
            } else if title.contains(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'])
            {
                Some("working")
            } else if !title.is_empty() {
                Some("idle")
            } else {
                None
            }
        }
        // grok.toml: blocked if "Action Required", idle if title ends with
        // "grok" without braille, working if any non-whitespace without idle match.
        "grok" => {
            if title.contains("Action Required") {
                Some("blocked")
            } else if (title == "grok" || title.ends_with(" - grok")) && !contains_braille(title) {
                Some("idle")
            } else if !title.trim().is_empty() {
                Some("working")
            } else {
                None
            }
        }
        // hermes.toml: blocked if ⚠ prefix, working if ⏳ prefix, idle if ✓ prefix.
        "hermes" => {
            let mut chars = title.chars();
            if let Some(first) = chars.next() {
                let second = chars.next();
                let after_variant = match second {
                    Some('\u{fe0e}') | Some('\u{fe0f}') => chars.next(),
                    Some(_) => second,
                    None => None,
                };
                let is_space_or_end = matches!(after_variant, Some(' ') | None);
                if first == '⚠' && is_space_or_end {
                    Some("blocked")
                } else if first == '⏳' && is_space_or_end {
                    Some("working")
                } else if first == '✓' && is_space_or_end {
                    Some("idle")
                } else {
                    None
                }
            } else {
                None
            }
        }
        // qwen.toml: blocked if ✳ prefix (U+2733 + optional FE0E + space),
        // working if ◐ prefix (U+25D0 + optional FE0E + space).
        "qwen" => {
            let mut chars = title.chars();
            if let Some(first) = chars.next() {
                let second = chars.next();
                let after_variant = match second {
                    Some('\u{fe0e}') => chars.next(),
                    _ => second,
                };
                if first == '✳' && after_variant == Some(' ') {
                    Some("blocked")
                } else if first == '◐' && after_variant == Some(' ') {
                    Some("working")
                } else {
                    None
                }
            } else {
                None
            }
        }
        // jcode: the title's work-segment suffix encodes the turn state
        // (`title_with_metrics` in jcode's terminal_title.rs): ` · work ~<dur>`
        // while a turn runs and ` · last ~<dur>` once it finished. `last` is
        // the only reliable idle signal for the post-turn screen, where the
        // scrape markers (numbered prompt, hint row, context bar) fall out of
        // the tail window. `work` maps to None on purpose: the scrape path
        // also carries `blocked`, and a title saying `work` must not outrank
        // a live Permissions viewer on screen.
        "jcode" => {
            if title.contains(" · last ~") {
                Some("idle")
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(super) fn detect_agent_status(
    agent: Option<&str>,
    text: &str,
    jcode_variant: JcodeDetectionVariant,
) -> &'static str {
    let Some(agent) = agent else {
        return "unknown";
    };
    let lower = text.to_lowercase();
    match agent {
        "jcode" => detect_jcode_status_with_variant(&lower, jcode_variant),
        _ => detect_agent_status_in_registry(agent, &lower).unwrap_or("unknown"),
    }
}

pub(super) fn terminal_screen_text_lossy(input: &str) -> String {
    terminal_text::terminal_text_lossy(input, TerminalTextOptions::backend_tail())
}

#[cfg(test)]
pub(super) fn strip_ansi_lossy(input: &str) -> String {
    terminal_text::strip_ansi_lossy(input, terminal_text::StripCarriageReturn::Newline)
}

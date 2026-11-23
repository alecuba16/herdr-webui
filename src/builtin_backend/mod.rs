use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use interprocess::local_socket::traits::ListenerExt as _;
use interprocess::TryClone as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

use crate::builtin_detection::{
    claude::has_claude_half_circle_spinner,
    detect_agent_status as detect_agent_status_in_registry,
    scrape::{
        bottom_non_empty_lines, contains_any, contains_braille, is_braille, starts_with_braille,
    },
};
use crate::builtin_detection::{
    jcode::{
        detect_jcode_status_with_variant, has_jcode_spinner, is_jcode_active_background_line,
        jcode_blocked as jcode_blocked_markers, jcode_numbered_prompt_line,
        jcode_shell_prompt_line, mentions_jcode_brand,
    },
    JcodeDetectionVariant,
};
use crate::builtin_events::{BuiltinEventHub, PaneEventContext};
use crate::chat_lens;
use crate::local_socket::{connect_local_stream, LocalStream};
use crate::protocol::{
    read_message, write_message, ClientMessage, RenderEncoding, ServerMessage, TerminalFrame,
};
use crate::terminal_text::{self, TerminalTextOptions};

#[cfg(test)]
mod tests;

mod detection;
mod env;
mod journal;
mod protocol;
mod serialize;
mod state;
mod terminal;
mod worktree;

#[allow(unused_imports)]
pub(crate) use detection::*;
#[allow(unused_imports)]
pub(crate) use env::*;
#[allow(unused_imports)]
pub(crate) use journal::*;
#[allow(unused_imports)]
pub(crate) use protocol::*;
#[allow(unused_imports)]
pub(crate) use serialize::*;
#[allow(unused_imports)]
pub(crate) use state::*;
#[allow(unused_imports)]
pub(crate) use terminal::*;
#[allow(unused_imports)]
pub(crate) use worktree::*;

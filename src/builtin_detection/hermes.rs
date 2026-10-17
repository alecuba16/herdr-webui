//! Screen-scrape status detection for Hermes.

use crate::builtin_detection::scrape::{bottom_non_empty_lines, contains_any};

pub(crate) fn detect_hermes_status(lower: &str) -> &'static str {
    let bottom14 = bottom_non_empty_lines(lower, 14);

    // dangerous_command_approval: any of [dangerous, approval, allow once+deny,
    // line "1. allow"] AND all of [enter confirm/enter to confirm/↑/↓ to
    // select/show full command].
    if (bottom14.contains("dangerous")
        || bottom14.contains("approval")
        || (bottom14.contains("allow once") && bottom14.contains("deny"))
        || bottom14.lines().any(|line| {
            let line = line.trim_start();
            let line = line.trim_start_matches(['▸', '>']);
            line.starts_with("1.") && line.contains("allow")
        }))
        && contains_any(
            &bottom14,
            &[
                "enter confirm",
                "enter to confirm",
                "↑/↓ to select",
                "show full command",
            ],
        )
    {
        return "blocked";
    }

    // clarification_prompt: any of [hermes needs your, line "ask <X>", type your
    // answer] AND all of [enter confirm/enter to confirm/enter send/press
    // enter/↑/↓ select/↑/↓ to select/other (type].
    if (bottom14.contains("hermes needs your")
        || bottom14.contains("type your answer")
        || bottom14
            .lines()
            .any(|line| line.trim_start().starts_with("ask ")))
        && contains_any(
            &bottom14,
            &[
                "enter confirm",
                "enter to confirm",
                "enter send",
                "press enter",
                "↑/↓ select",
                "↑/↓ to select",
                "other (type",
            ],
        )
    {
        return "blocked";
    }

    // credential_prompt: any of [sudo password, skill setup, 🔑 + "for "].
    if bottom14.contains("sudo password")
        || bottom14.contains("skill setup")
        || (bottom14.contains("🔑") && bottom14.contains("for "))
    {
        return "blocked";
    }

    // confirmation_prompt: any of [(approve once + cancel), (start a new session
    // + keep going)] AND any of [enter to confirm/enter confirm/type 1/2/3/y/n
    // quick].
    if ((bottom14.contains("approve once") && bottom14.contains("cancel"))
        || (bottom14.contains("start a new session") && bottom14.contains("keep going")))
        && contains_any(
            &bottom14,
            &[
                "enter to confirm",
                "enter confirm",
                "type 1/2/3",
                "y/n quick",
            ],
        )
    {
        return "blocked";
    }

    // interrupt_status_working: msg=interrupt or ctrl+c to interrupt.
    let bottom5 = bottom_non_empty_lines(lower, 5);
    if bottom5.contains("msg=interrupt") || bottom5.contains("ctrl+c to interrupt") {
        return "working";
    }

    // classic_cancel_working: "ctrl+c cancel".
    if bottom5.contains("ctrl+c cancel") {
        return "working";
    }

    "unknown"
}

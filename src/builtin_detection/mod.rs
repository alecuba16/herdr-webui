//! Modular built-in backend agent detection.
//!
//! This module groups per-agent screen-scrape detection logic so new agents
//! (and forks of existing agents) can be added without growing the monolithic
//! `builtin_backend.rs` switch. Each agent lives in its own submodule and
//! exposes a `detect_<agent>_status(lower) -> &'static str` function plus any
//! helpers it needs.
//!
//! Detection variants for the same agent (for example, jcode's upstream
//! "vanilla" output format versus the alecuba16 fork's redesigned Overview
//! panel) live side by side under the agent module and are selected at
//! runtime through the persisted `JcodeDetectionVariant` setting.
//!
//! IMPORTANT: The jcode variant selector is a **temporary** affordance. It
//! exists only while the upstream jcode TUI output format diverges from the
//! alecuba16 fork. Once vanilla jcode adopts the same Overview panel layout,
//! this selector should be removed and the two variants merged back into a
//! single `detect_jcode_status` implementation. See `docs/features.md` and
//! `docs/technical-details.md` for the temporary annotation.

pub mod jcode;

use serde::{Deserialize, Serialize};

/// Selects which jcode screen-scrape pattern set the built-in backend uses.
///
/// `Vanilla` matches the upstream jcode master output format (numbered
/// prompts like `1> `, the `❯` idle caret, the `··● bash ●··` tool bar).
///
/// `Alecuba16` matches the alecuba16 fork output format introduced by the
/// `fix/info_fields` and `herdr_detectable` branches: a redesigned Overview
/// panel with dashed separators, session-count header, memory/swarm icons,
/// and a cost/tokens-per-second footer line.
///
/// This is a **temporary** selector that will be removed once vanilla jcode
/// converges on the same output format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum JcodeDetectionVariant {
    /// Upstream jcode master output format.
    Vanilla,
    /// alecuba16 fork (`fix/info_fields` + `herdr_detectable`) output format.
    #[default]
    Alecuba16,
}

impl JcodeDetectionVariant {
    /// Stable string used in settings JSON and API responses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vanilla => "vanilla",
            Self::Alecuba16 => "alecuba16",
        }
    }

    /// Parse a stored variant string. Unknown values fall back to `Vanilla`
    /// so a corrupted settings file never breaks detection.
    pub fn from_str(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "alecuba16" => Self::Alecuba16,
            _ => Self::Vanilla,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_variant_is_alecuba16() {
        assert_eq!(
            JcodeDetectionVariant::default(),
            JcodeDetectionVariant::Alecuba16
        );
    }

    #[test]
    fn variant_round_trips_serde() {
        for variant in [
            JcodeDetectionVariant::Vanilla,
            JcodeDetectionVariant::Alecuba16,
        ] {
            let json = serde_json::to_string(&variant).expect("serialize");
            let parsed: JcodeDetectionVariant = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(variant, parsed, "round trip for {variant:?} via {json:?}");
        }
    }

    #[test]
    fn variant_serde_uses_lowercase() {
        assert_eq!(
            serde_json::to_string(&JcodeDetectionVariant::Vanilla).unwrap(),
            "\"vanilla\""
        );
        assert_eq!(
            serde_json::to_string(&JcodeDetectionVariant::Alecuba16).unwrap(),
            "\"alecuba16\""
        );
    }

    #[test]
    fn from_str_parses_known_variants() {
        assert_eq!(
            JcodeDetectionVariant::from_str("vanilla"),
            JcodeDetectionVariant::Vanilla
        );
        assert_eq!(
            JcodeDetectionVariant::from_str("alecuba16"),
            JcodeDetectionVariant::Alecuba16
        );
    }

    #[test]
    fn from_str_falls_back_to_vanilla_for_unknown() {
        assert_eq!(
            JcodeDetectionVariant::from_str("unknown"),
            JcodeDetectionVariant::Vanilla
        );
        assert_eq!(
            JcodeDetectionVariant::from_str(""),
            JcodeDetectionVariant::Vanilla
        );
        assert_eq!(
            JcodeDetectionVariant::from_str("ALECUBA16"),
            JcodeDetectionVariant::Alecuba16,
            "from_str should be case-insensitive"
        );
    }

    #[test]
    fn as_str_matches_serde_form() {
        for variant in [
            JcodeDetectionVariant::Vanilla,
            JcodeDetectionVariant::Alecuba16,
        ] {
            let serde = serde_json::to_string(&variant).unwrap();
            let expected = format!("\"{}\"", variant.as_str());
            assert_eq!(
                serde, expected,
                "as_str should match serde form for {variant:?}"
            );
        }
    }
}

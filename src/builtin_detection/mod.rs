//! Modular built-in backend agent detection.
//!
//! This module groups per-agent screen-scrape detection logic so new agents
//! (and forks of existing agents) can be added without growing the monolithic
//! `builtin_backend.rs` switch. Each agent lives in its own submodule and
//! exposes a `detect_<agent>_status(lower) -> &'static str` function plus any
//! helpers it needs.
//!
//! Detection variants for the same agent (for example, jcode's upstream
//! `master` output format versus the `fix/info_fields` branch Overview panel)
//! live side by side under the agent module and are selected at runtime
//! through the persisted `JcodeDetectionVariant` setting.
//!
//! IMPORTANT: The jcode variant selector is a **temporary** affordance. It
//! exists only while the upstream jcode TUI output format diverges between
//! its `master` and `fix/info_fields` branches. Once jcode includes a final
//! output format (OSC 9 payloads enabled by default and a converged Overview
//! panel), this selector should be removed and the variants merged back into
//! a single `detect_jcode_status` implementation. See `docs/features.md` and
//! `docs/technical-details.md` for the temporary annotation.

pub mod claurst;
pub mod jcode;

use serde::{Deserialize, Serialize};

/// Selects which jcode screen-scrape pattern set the built-in backend uses.
///
/// `Vanilla` matches the upstream jcode `master` output format: the numbered
/// input prompt (`1> `), the spinner status line (`⠋ sending… 3s`,
/// `⠋ running bash`), the network-retry line, and the Permissions viewer.
///
/// `InfoFields` matches the `fix/info_fields` branch output format: the same
/// bottom chrome plus the Overview panel's `🏠 model · effort` Runtime
/// identity row (and `🐝`/`🧠` agent-override rows) that the branch adds.
///
/// `Auto` is the default and routes to the InfoFields detector directly:
/// that detector is a strict superset of the Vanilla one (identical
/// bottom-chrome matching plus the Overview idle markers), so Auto and
/// InfoFields behave the same for both branches and no per-pane sniffing
/// is needed.
///
/// This is a **temporary** selector that will be removed once jcode ships a
/// final output format and the variants converge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum JcodeDetectionVariant {
    /// Upstream jcode master output format.
    Vanilla,
    /// `fix/info_fields` branch output format (Overview panel with the
    /// `🏠 model · effort` identity row).
    #[default]
    Auto,
    /// Alias for `InfoFields`, kept for settings files written before the
    /// rename. Serialized as `"alecuba16"`.
    #[serde(rename = "alecuba16")]
    Alecuba16Legacy,
    /// `fix/info_fields` branch output format. Serialized as
    /// `"info_fields"`.
    #[serde(rename = "info_fields")]
    InfoFields,
}

impl JcodeDetectionVariant {
    /// Stable string used in settings JSON and API responses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vanilla => "vanilla",
            Self::Auto => "auto",
            Self::Alecuba16Legacy | Self::InfoFields => "info_fields",
        }
    }

    /// Parse a stored variant string. Unknown values fall back to `Auto`
    /// so a corrupted settings file never breaks detection. The legacy
    /// `"alecuba16"` value (written by older builds) maps to InfoFields.
    pub fn from_str(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "vanilla" => Self::Vanilla,
            "info_fields" | "alecuba16" => Self::InfoFields,
            _ => Self::Auto,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_variant_is_auto() {
        assert_eq!(
            JcodeDetectionVariant::default(),
            JcodeDetectionVariant::Auto
        );
    }

    #[test]
    fn variant_round_trips_serde() {
        for variant in [
            JcodeDetectionVariant::Vanilla,
            JcodeDetectionVariant::Auto,
            JcodeDetectionVariant::InfoFields,
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
            serde_json::to_string(&JcodeDetectionVariant::Auto).unwrap(),
            "\"auto\""
        );
        assert_eq!(
            serde_json::to_string(&JcodeDetectionVariant::InfoFields).unwrap(),
            "\"info_fields\""
        );
    }

    #[test]
    fn legacy_alecuba16_deserializes_to_info_fields() {
        // `from_str` maps the stored legacy value onto the renamed arm so
        // settings round-trips converge on InfoFields. Raw serde keeps the
        // legacy arm distinct only so old files stay representable.
        let parsed = JcodeDetectionVariant::from_str("alecuba16");
        assert_eq!(parsed, JcodeDetectionVariant::InfoFields);
        assert_eq!(
            JcodeDetectionVariant::Alecuba16Legacy.as_str(),
            JcodeDetectionVariant::InfoFields.as_str()
        );
    }

    #[test]
    fn from_str_parses_known_variants() {
        assert_eq!(
            JcodeDetectionVariant::from_str("vanilla"),
            JcodeDetectionVariant::Vanilla
        );
        assert_eq!(
            JcodeDetectionVariant::from_str("info_fields"),
            JcodeDetectionVariant::InfoFields
        );
        assert_eq!(
            JcodeDetectionVariant::from_str("auto"),
            JcodeDetectionVariant::Auto
        );
        assert_eq!(
            JcodeDetectionVariant::from_str("alecuba16"),
            JcodeDetectionVariant::InfoFields,
            "legacy stored value maps to info_fields"
        );
    }

    #[test]
    fn from_str_falls_back_to_auto_for_unknown() {
        assert_eq!(
            JcodeDetectionVariant::from_str("unknown"),
            JcodeDetectionVariant::Auto
        );
        assert_eq!(
            JcodeDetectionVariant::from_str(""),
            JcodeDetectionVariant::Auto
        );
        assert_eq!(
            JcodeDetectionVariant::from_str("INFO_FIELDS"),
            JcodeDetectionVariant::InfoFields,
            "from_str should be case-insensitive"
        );
    }

    #[test]
    fn as_str_matches_serde_form() {
        for variant in [
            JcodeDetectionVariant::Vanilla,
            JcodeDetectionVariant::Auto,
            JcodeDetectionVariant::InfoFields,
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

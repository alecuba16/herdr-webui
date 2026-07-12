use std::io::IsTerminal;
use std::str::FromStr;
use std::time::Duration;

use ratatui::style::Color;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TuiTheme {
    #[default]
    System,
    Dark,
    Light,
}

impl TuiTheme {
    pub(crate) fn from_env() -> Self {
        std::env::var("HERDR_WEBUI_TUI_THEME")
            .ok()
            .or_else(|| std::env::var("JCODE_THEME").ok())
            .and_then(|value| value.parse().ok())
            .unwrap_or_default()
    }

    pub(crate) fn palette(self) -> Palette {
        match self {
            Self::Dark => Palette::dark(),
            Self::Light => Palette::light(),
            Self::System => Palette::system(detect_terminal_theme().unwrap_or(TerminalTheme::Dark)),
        }
    }
}

impl FromStr for TuiTheme {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "system" | "terminal" | "auto" => Ok(Self::System),
            "dark" => Ok(Self::Dark),
            "light" => Ok(Self::Light),
            other => Err(format!(
                "invalid theme '{other}', expected dark, light, or system"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalTheme {
    Dark,
    Light,
}

fn detect_terminal_theme() -> Option<TerminalTheme> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return None;
    }
    let mut options = terminal_colorsaurus::QueryOptions::default();
    options.timeout = Duration::from_millis(400);
    match terminal_colorsaurus::theme_mode(options).ok()? {
        terminal_colorsaurus::ThemeMode::Dark => Some(TerminalTheme::Dark),
        terminal_colorsaurus::ThemeMode::Light => Some(TerminalTheme::Light),
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Palette {
    pub(crate) bg: Color,
    pub(crate) panel_bg: Color,
    pub(crate) panel_alt: Color,
    pub(crate) border: Color,
    pub(crate) text: Color,
    pub(crate) muted: Color,
    pub(crate) accent: Color,
    pub(crate) green: Color,
    pub(crate) yellow: Color,
    pub(crate) red: Color,
    pub(crate) teal: Color,
}

impl Default for Palette {
    fn default() -> Self {
        Self::dark()
    }
}

impl Palette {
    pub(crate) fn for_theme(theme: TuiTheme) -> Self {
        theme.palette()
    }

    fn system(terminal: TerminalTheme) -> Self {
        let mut palette = match terminal {
            TerminalTheme::Dark => Self::dark(),
            TerminalTheme::Light => Self::light(),
        };
        palette.bg = Color::Reset;
        palette
    }

    fn dark() -> Self {
        Self {
            bg: Color::Rgb(24, 24, 37),
            panel_bg: Color::Rgb(17, 17, 27),
            panel_alt: Color::Rgb(30, 30, 46),
            border: Color::Rgb(69, 71, 90),
            text: Color::Rgb(205, 214, 244),
            muted: Color::Rgb(127, 132, 156),
            accent: Color::Rgb(137, 180, 250),
            green: Color::Rgb(166, 227, 161),
            yellow: Color::Rgb(249, 226, 175),
            red: Color::Rgb(243, 139, 168),
            teal: Color::Rgb(148, 226, 213),
        }
    }

    fn light() -> Self {
        Self {
            bg: Color::Rgb(248, 250, 252),
            panel_bg: Color::Rgb(255, 255, 255),
            panel_alt: Color::Rgb(241, 245, 249),
            border: Color::Rgb(203, 213, 225),
            text: Color::Rgb(30, 41, 59),
            muted: Color::Rgb(100, 116, 139),
            accent: Color::Rgb(37, 99, 235),
            green: Color::Rgb(22, 163, 74),
            yellow: Color::Rgb(180, 83, 9),
            red: Color::Rgb(220, 38, 38),
            teal: Color::Rgb(13, 148, 136),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    #[test]
    fn parses_theme_names_and_aliases() {
        assert_eq!("".parse::<TuiTheme>().unwrap(), TuiTheme::System);
        assert_eq!(" auto ".parse::<TuiTheme>().unwrap(), TuiTheme::System);
        assert_eq!("DARK".parse::<TuiTheme>().unwrap(), TuiTheme::Dark);
        assert_eq!("dark".parse::<TuiTheme>().unwrap(), TuiTheme::Dark);
        assert_eq!("light".parse::<TuiTheme>().unwrap(), TuiTheme::Light);
        assert_eq!("system".parse::<TuiTheme>().unwrap(), TuiTheme::System);
        assert_eq!("terminal".parse::<TuiTheme>().unwrap(), TuiTheme::System);
        assert!("neon".parse::<TuiTheme>().is_err());
    }

    #[test]
    fn light_and_dark_palettes_are_readable_opposites() {
        let dark = Palette::for_theme(TuiTheme::Dark);
        let light = Palette::for_theme(TuiTheme::Light);
        assert_eq!(dark.bg, Color::Rgb(24, 24, 37));
        assert_eq!(light.bg, Color::Rgb(248, 250, 252));
        assert_ne!(dark.text, light.text);
        assert_ne!(dark.panel_bg, light.panel_bg);
    }

    #[test]
    fn system_palette_uses_terminal_background_reset() {
        let palette = Palette::system(TerminalTheme::Light);
        assert_eq!(palette.bg, Color::Reset);
        assert_eq!(palette.text, Color::Rgb(30, 41, 59));

        let dark = Palette::system(TerminalTheme::Dark);
        assert_eq!(dark.bg, Color::Reset);
        assert_eq!(dark.text, Color::Rgb(205, 214, 244));
    }

    #[test]
    fn theme_env_prefers_webui_setting_then_jcode_then_system() {
        let _guard = env_lock().lock().unwrap();
        let original_webui = std::env::var_os("HERDR_WEBUI_TUI_THEME");
        let original_jcode = std::env::var_os("JCODE_THEME");

        std::env::set_var("HERDR_WEBUI_TUI_THEME", "light");
        std::env::set_var("JCODE_THEME", "dark");
        assert_eq!(TuiTheme::from_env(), TuiTheme::Light);

        std::env::remove_var("HERDR_WEBUI_TUI_THEME");
        assert_eq!(TuiTheme::from_env(), TuiTheme::Dark);

        std::env::set_var("JCODE_THEME", "invalid");
        assert_eq!(TuiTheme::from_env(), TuiTheme::System);

        restore_env_var("HERDR_WEBUI_TUI_THEME", original_webui);
        restore_env_var("JCODE_THEME", original_jcode);
    }

    #[test]
    fn palette_default_and_for_theme_use_dark_fallback() {
        let default = Palette::default();
        let dark = Palette::for_theme(TuiTheme::Dark);

        assert_eq!(default.bg, dark.bg);
        assert_eq!(default.accent, Color::Rgb(137, 180, 250));
        assert_eq!(default.green, Color::Rgb(166, 227, 161));
        assert_eq!(default.yellow, Color::Rgb(249, 226, 175));
        assert_eq!(default.red, Color::Rgb(243, 139, 168));
        assert_eq!(default.teal, Color::Rgb(148, 226, 213));
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn restore_env_var(key: &str, value: Option<std::ffi::OsString>) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}

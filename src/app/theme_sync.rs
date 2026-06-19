use std::sync::atomic::Ordering;

use super::App;

const DARK_CURSOR_COLOR: crate::terminal_theme::RgbColor = crate::terminal_theme::RgbColor {
    r: 0xff,
    g: 0xff,
    b: 0xff,
};
const LIGHT_CURSOR_COLOR: crate::terminal_theme::RgbColor = crate::terminal_theme::RgbColor {
    r: 0x40,
    g: 0xa0,
    b: 0x6b,
};

pub(crate) fn cursor_color_for_appearance(
    appearance: crate::terminal_theme::HostAppearance,
) -> crate::terminal_theme::RgbColor {
    match appearance {
        crate::terminal_theme::HostAppearance::Dark => DARK_CURSOR_COLOR,
        crate::terminal_theme::HostAppearance::Light => LIGHT_CURSOR_COLOR,
    }
}

pub(crate) fn reset_host_cursor_color() {
    use std::io::Write;

    let _ = std::io::stdout().write_all(
        crate::terminal_theme::osc_reset_default_color_sequence(
            crate::terminal_theme::DefaultColorKind::Cursor,
        )
        .as_bytes(),
    );
    let _ = std::io::stdout().flush();
}

impl App {
    pub(super) fn query_host_terminal_theme(&self) {
        use std::io::Write;

        let _ = std::io::stdout()
            .write_all(crate::terminal_theme::HOST_COLOR_QUERY_SEQUENCE.as_bytes());
        let _ = std::io::stdout().flush();
    }

    pub(super) fn update_host_terminal_theme(
        &mut self,
        kind: crate::terminal_theme::DefaultColorKind,
        color: crate::terminal_theme::RgbColor,
    ) -> bool {
        let mut changed = false;
        if matches!(kind, crate::terminal_theme::DefaultColorKind::Background)
            && !self.state.host_terminal_appearance_explicit
        {
            changed |= self.set_host_terminal_appearance(color.inferred_appearance(), false);
        }
        let next_theme = self.state.host_terminal_theme.with_color(kind, color);
        changed | self.set_host_terminal_theme(next_theme)
    }

    pub(super) fn set_host_terminal_appearance(
        &mut self,
        appearance: crate::terminal_theme::HostAppearance,
        explicit: bool,
    ) -> bool {
        if self.state.host_terminal_appearance == Some(appearance)
            && self.state.host_terminal_appearance_explicit == explicit
        {
            return false;
        }
        if self.state.host_terminal_appearance_explicit && !explicit {
            return false;
        }
        self.state.host_terminal_appearance = Some(appearance);
        self.state.host_terminal_appearance_explicit = explicit;
        self.refresh_effective_app_theme()
    }

    pub(crate) fn set_host_terminal_appearance_state(
        &mut self,
        appearance: Option<crate::terminal_theme::HostAppearance>,
        explicit: bool,
    ) -> bool {
        if self.state.host_terminal_appearance == appearance
            && self.state.host_terminal_appearance_explicit == explicit
        {
            return false;
        }
        self.state.host_terminal_appearance = appearance;
        self.state.host_terminal_appearance_explicit = explicit;
        self.refresh_effective_app_theme()
    }

    pub(crate) fn set_host_terminal_theme(
        &mut self,
        theme: crate::terminal_theme::TerminalTheme,
    ) -> bool {
        if theme == self.state.host_terminal_theme {
            return false;
        }
        self.state.host_terminal_theme = theme;
        self.apply_host_terminal_theme_to_panes();
        true
    }

    pub(super) fn refresh_effective_app_theme(&mut self) -> bool {
        let (palette, theme_name) = super::resolve_effective_theme(
            &self.state.theme_runtime,
            self.state.host_terminal_appearance,
        );
        if self.state.theme_name == theme_name && self.state.palette == palette {
            return false;
        }
        self.state.theme_name = theme_name;
        self.state.palette = palette;
        self.apply_host_cursor_color();
        self.render_dirty.store(true, Ordering::Release);
        self.render_notify.notify_one();
        true
    }

    pub(super) fn apply_host_cursor_color(&self) {
        #[cfg(test)]
        {
            return;
        }

        #[cfg(not(test))]
        {
            use std::io::Write;

            let appearance = self
                .state
                .host_terminal_appearance
                .unwrap_or(crate::terminal_theme::HostAppearance::Dark);
            let color = cursor_color_for_appearance(appearance);
            let sequence = crate::terminal_theme::osc_set_default_color_sequence(
                crate::terminal_theme::DefaultColorKind::Cursor,
                color,
            );
            let _ = std::io::stdout().write_all(sequence.as_bytes());
            let _ = std::io::stdout().flush();
        }
    }

    fn apply_host_terminal_theme_to_panes(&self) {
        for runtime in self.terminal_runtimes.values() {
            runtime.apply_host_terminal_theme(self.state.host_terminal_theme);
        }

        self.render_dirty.store(true, Ordering::Release);
        self.render_notify.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_color_tracks_host_appearance() {
        assert_eq!(
            cursor_color_for_appearance(crate::terminal_theme::HostAppearance::Dark),
            DARK_CURSOR_COLOR
        );
        assert_eq!(
            cursor_color_for_appearance(crate::terminal_theme::HostAppearance::Light),
            LIGHT_CURSOR_COLOR
        );
    }
}

use axum::body::Body;
use axum::http::{header, HeaderValue};
use axum::response::{Html, IntoResponse, Response};

pub(crate) const LOGIN_HTML: &str = include_str!("assets/login.html");
pub(crate) const APP_HTML: &str = include_str!("assets/app.html");

const LOGIN_CSS: &str = include_str!("assets/login.css");
const LOGIN_JS: &str = include_str!("assets/login.js");
const SHARED_CORE_JS: &str = include_str!("assets/shared/core.js");
const SHARED_ACTIONS_JS: &str = include_str!("assets/shared/actions.js");
const SHARED_FILE_ICONS_JS: &str = include_str!("assets/shared/file_icons.js");
const SHARED_FILE_ICONS_CSS: &str = include_str!("assets/shared/file_icons.css");
const SHARED_COLORS_CSS: &str = include_str!("assets/shared/colors.css");
const SHARED_CONTENT_SEARCH_CSS: &str = include_str!("assets/shared/content_search.css");
const SHARED_FILE_TREE_JS: &str = include_str!("assets/shared/file_tree.js");
const SHARED_FILE_CONTENT_SEARCH_JS: &str = include_str!("assets/shared/file_content_search.js");
const SHARED_LINE_CONTEXT_JS: &str = include_str!("assets/shared/line_context.js");
const SHARED_WORKSPACE_SEARCH_JS: &str = include_str!("assets/shared/workspace_search.js");
const SHARED_EDITOR_JS: &str = include_str!("assets/shared/editor.js");
const SHARED_TERMINAL_SCROLL_JS: &str = include_str!("assets/shared/terminal_scroll.js");
const SHARED_TERMINAL_FIT_JS: &str = include_str!("assets/shared/terminal_fit.js");
const SHARED_TEMP_TERMINAL_JS: &str = include_str!("assets/shared/temp_terminal.js");
const VENDOR_CODEMIRROR_JS: &str = include_str!("assets/vendor/codemirror.bundle.js");
const APP_BOOT_JS: &str = include_str!("assets/app_boot.js");
const DESKTOP_CSS: &str = concat!(
    include_str!("assets/desktop/app_css/base.css"),
    include_str!("assets/desktop/app_css/modals.css"),
    include_str!("assets/desktop/app_css/terminal.css"),
    include_str!("assets/desktop/app_css/chrome.css"),
    include_str!("assets/desktop/app_css/controls.css"),
    include_str!("assets/desktop/app_css/workspaces.css"),
);
const DESKTOP_GIT_UI_CSS: &str = concat!(
    include_str!("assets/desktop/git_ui/shell.css"),
    include_str!("assets/desktop/git_ui/entry.css"),
    include_str!("assets/desktop/git_ui/layout.css"),
    include_str!("assets/desktop/git_ui/diff.css"),
    include_str!("assets/desktop/git_ui/log.css"),
    include_str!("assets/desktop/git_ui/log_actions.css"),
    include_str!("assets/desktop/git_ui/syntax.css"),
);
const DESKTOP_SEARCH_CSS: &str = include_str!("assets/desktop/search.css");
const DESKTOP_FILE_BROWSER_CSS: &str = include_str!("assets/desktop/file_browser.css");
const DESKTOP_SHORTCUTS_CSS: &str = include_str!("assets/desktop/shortcuts.css");
const DESKTOP_GIT_UI_JS: &str = concat!(
    include_str!("assets/desktop/git_ui/settings.js"),
    include_str!("assets/desktop/git_ui/syntax.js"),
    include_str!("assets/desktop/git_ui/actions.js"),
    include_str!("assets/desktop/git_ui/log.js"),
    include_str!("assets/desktop/git_ui.js"),
);
const DESKTOP_SEARCH_JS: &str = include_str!("assets/desktop/search.js");
const DESKTOP_FILE_BROWSER_JS: &str = include_str!("assets/desktop/file_browser.js");
const DESKTOP_DIRECTORY_PICKER_JS: &str = include_str!("assets/desktop/directory_picker.js");
const DESKTOP_JS: &str = concat!(
    include_str!("assets/desktop/app_js/core.js"),
    include_str!("assets/desktop/app_js/legacy_polling.js"),
    include_str!("assets/desktop/app_js/panel_switcher.js"),
    include_str!("assets/desktop/app_js/render.js"),
    include_str!("assets/desktop/app_js/terminal.js"),
    include_str!("assets/desktop/app_js/worktrees.js"),
    include_str!("assets/desktop/app_js/shortcuts.js"),
    include_str!("assets/desktop/app_js/workspace_create.js"),
    include_str!("assets/desktop/app_js/bindings.js"),
);
const MOBILE_ATTENTION_JS: &str = include_str!("assets/mobile/attention.js");
const MOBILE_CORE_JS: &str = include_str!("assets/mobile/core.js");
const MOBILE_SETTINGS_JS: &str = include_str!("assets/mobile/settings.js");
const MOBILE_TERMINAL_JS: &str = include_str!("assets/mobile/terminal.js");
const MOBILE_WORKTREES_JS: &str = include_str!("assets/mobile/worktrees.js");
const MOBILE_FILE_BROWSER_JS: &str = include_str!("assets/mobile/file_browser.js");
const MOBILE_CSS: &str = include_str!("assets/mobile/app.css");
const MOBILE_JS: &str = include_str!("assets/mobile/app.js");
const XTERM_CSS: &str = include_str!("assets/xterm.css");
const XTERM_JS: &str = include_str!("assets/xterm.min.js");
const JETBRAINS_MONO_NERD_FONT: &[u8] =
    include_bytes!("assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf");
const HERDR_LOGO: &str = include_str!("assets/herdr-logo.svg");
const ICON_HELP: &str = include_str!("assets/icons/help.svg");
const ICON_SETTINGS: &str = include_str!("assets/icons/settings.svg");
const ICON_THEME_AUTO: &str = include_str!("assets/icons/theme-auto.svg");
const ICON_GIT: &str = include_str!("assets/icons/git.svg");
const ICON_TERMINAL: &str = include_str!("assets/icons/terminal.svg");
const ICON_CHEVRON_RIGHT: &str = include_str!("assets/icons/chevron-right.svg");
const ICON_CHEVRON_DOWN: &str = include_str!("assets/icons/chevron-down.svg");
const ICON_FOLDER: &str = include_str!("assets/icons/folder.svg");
const ICON_FOLDER_UP: &str = include_str!("assets/icons/folder-up.svg");
const ICON_FILE: &str = include_str!("assets/icons/file.svg");
const ICON_TRASH: &str = include_str!("assets/icons/trash.svg");
const ICON_SEARCH: &str = include_str!("assets/icons/search.svg");
const ICON_REFRESH: &str = include_str!("assets/icons/refresh.svg");

pub(crate) fn app_html() -> Response {
    Html(APP_HTML).into_response()
}

pub(crate) fn login_html() -> Response {
    Html(LOGIN_HTML).into_response()
}

pub(crate) async fn xterm_js() -> Response {
    static_text(XTERM_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn xterm_css() -> Response {
    static_text(XTERM_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn jetbrains_mono_nerd_font() -> Response {
    static_bytes(JETBRAINS_MONO_NERD_FONT, "font/ttf")
}

pub(crate) async fn desktop_js() -> Response {
    static_text(DESKTOP_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn desktop_git_ui_js() -> Response {
    static_text(DESKTOP_GIT_UI_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn app_boot_js() -> Response {
    static_text(APP_BOOT_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn shared_core_js() -> Response {
    static_text(SHARED_CORE_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn shared_actions_js() -> Response {
    static_text(SHARED_ACTIONS_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn shared_file_icons_js() -> Response {
    static_text(
        SHARED_FILE_ICONS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_file_icons_css() -> Response {
    static_text(SHARED_FILE_ICONS_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_colors_css() -> Response {
    static_text(SHARED_COLORS_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_content_search_css() -> Response {
    static_text(SHARED_CONTENT_SEARCH_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_file_tree_js() -> Response {
    static_text(SHARED_FILE_TREE_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn shared_file_content_search_js() -> Response {
    static_text(
        SHARED_FILE_CONTENT_SEARCH_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_line_context_js() -> Response {
    static_text(
        SHARED_LINE_CONTEXT_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_workspace_search_js() -> Response {
    static_text(
        SHARED_WORKSPACE_SEARCH_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_editor_js() -> Response {
    static_text(SHARED_EDITOR_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn shared_terminal_scroll_js() -> Response {
    static_text(
        SHARED_TERMINAL_SCROLL_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_terminal_fit_js() -> Response {
    static_text(
        SHARED_TERMINAL_FIT_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_temp_terminal_js() -> Response {
    static_text(
        SHARED_TEMP_TERMINAL_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn vendor_codemirror_js() -> Response {
    static_text(
        VENDOR_CODEMIRROR_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_search_js() -> Response {
    static_text(DESKTOP_SEARCH_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn desktop_file_browser_js() -> Response {
    static_text(
        DESKTOP_FILE_BROWSER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_directory_picker_js() -> Response {
    static_text(
        DESKTOP_DIRECTORY_PICKER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_css() -> Response {
    static_text(DESKTOP_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn desktop_git_ui_css() -> Response {
    static_text(DESKTOP_GIT_UI_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn desktop_search_css() -> Response {
    static_text(DESKTOP_SEARCH_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn desktop_file_browser_css() -> Response {
    static_text(DESKTOP_FILE_BROWSER_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn desktop_shortcuts_css() -> Response {
    static_text(DESKTOP_SHORTCUTS_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn mobile_js() -> Response {
    static_text(MOBILE_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn mobile_core_js() -> Response {
    static_text(MOBILE_CORE_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn mobile_attention_js() -> Response {
    static_text(MOBILE_ATTENTION_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn mobile_settings_js() -> Response {
    static_text(MOBILE_SETTINGS_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn mobile_terminal_js() -> Response {
    static_text(MOBILE_TERMINAL_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn mobile_worktrees_js() -> Response {
    static_text(MOBILE_WORKTREES_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn mobile_file_browser_js() -> Response {
    static_text(
        MOBILE_FILE_BROWSER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_css() -> Response {
    static_text(MOBILE_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn login_js() -> Response {
    static_text(LOGIN_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn login_css() -> Response {
    static_text(LOGIN_CSS, "text/css; charset=utf-8")
}

fn static_text(body: &'static str, content_type: &'static str) -> Response {
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

fn static_bytes(body: &'static [u8], content_type: &'static str) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .expect("static asset response should be valid")
}

pub(crate) async fn favicon_svg() -> Response {
    let mut response = HERDR_LOGO.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    response
}

pub(crate) async fn favicon_attention_svg() -> Response {
    themed_favicon_svg("#fff7ed", "#fed7aa", "#f97316")
}

pub(crate) async fn favicon_error_svg() -> Response {
    themed_favicon_svg("#fef2f2", "#fecaca", "#ef4444")
}

fn themed_favicon_svg(background: &str, chrome: &str, accent: &str) -> Response {
    let body = HERDR_LOGO
        .replace("#e0e0e0", background)
        .replace("#f5f5f5", background)
        .replace("#bdbdbd", chrome)
        .replace("#a0a0a0", accent)
        .replace("#808080", accent)
        .replace("#606060", accent);
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    response
}

fn static_svg(body: &'static str) -> Response {
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    response
}

pub(crate) async fn icon_help_svg() -> Response {
    static_svg(ICON_HELP)
}

pub(crate) async fn icon_settings_svg() -> Response {
    static_svg(ICON_SETTINGS)
}

pub(crate) async fn icon_theme_auto_svg() -> Response {
    static_svg(ICON_THEME_AUTO)
}

pub(crate) async fn icon_git_svg() -> Response {
    static_svg(ICON_GIT)
}

pub(crate) async fn icon_terminal_svg() -> Response {
    static_svg(ICON_TERMINAL)
}

pub(crate) async fn icon_chevron_right_svg() -> Response {
    static_svg(ICON_CHEVRON_RIGHT)
}

pub(crate) async fn icon_chevron_down_svg() -> Response {
    static_svg(ICON_CHEVRON_DOWN)
}

pub(crate) async fn icon_folder_svg() -> Response {
    static_svg(ICON_FOLDER)
}

pub(crate) async fn icon_folder_up_svg() -> Response {
    static_svg(ICON_FOLDER_UP)
}

pub(crate) async fn icon_file_svg() -> Response {
    static_svg(ICON_FILE)
}

pub(crate) async fn icon_trash_svg() -> Response {
    static_svg(ICON_TRASH)
}

pub(crate) async fn icon_search_svg() -> Response {
    static_svg(ICON_SEARCH)
}

pub(crate) async fn icon_refresh_svg() -> Response {
    static_svg(ICON_REFRESH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header;

    fn content_type(response: &Response) -> &str {
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
    }

    #[tokio::test]
    async fn serves_remaining_static_text_assets_with_content_types() {
        let javascript = "application/javascript; charset=utf-8";
        let css = "text/css; charset=utf-8";

        assert_eq!(content_type(&desktop_git_ui_js().await), javascript);
        assert_eq!(content_type(&desktop_file_browser_js().await), javascript);
        assert_eq!(
            content_type(&desktop_directory_picker_js().await),
            javascript
        );
        assert_eq!(content_type(&shared_actions_js().await), javascript);
        assert_eq!(content_type(&shared_file_tree_js().await), javascript);
        assert_eq!(
            content_type(&shared_workspace_search_js().await),
            javascript
        );
        assert_eq!(content_type(&shared_terminal_scroll_js().await), javascript);
        assert_eq!(content_type(&shared_terminal_fit_js().await), javascript);
        assert_eq!(content_type(&shared_editor_js().await), javascript);
        assert_eq!(content_type(&vendor_codemirror_js().await), javascript);
        assert_eq!(content_type(&mobile_file_browser_js().await), javascript);
        assert_eq!(content_type(&login_js().await), javascript);
        assert_eq!(content_type(&shared_colors_css().await), css);
        assert_eq!(content_type(&shared_content_search_css().await), css);
        assert_eq!(content_type(&desktop_git_ui_css().await), css);
        assert_eq!(content_type(&desktop_file_browser_css().await), css);
        assert_eq!(content_type(&login_css().await), css);
    }

    #[tokio::test]
    async fn serves_icon_assets_as_svg() {
        let svg = "image/svg+xml; charset=utf-8";

        assert_eq!(content_type(&icon_help_svg().await), svg);
        assert_eq!(content_type(&icon_settings_svg().await), svg);
        assert_eq!(content_type(&icon_theme_auto_svg().await), svg);
        assert_eq!(content_type(&icon_git_svg().await), svg);
        assert_eq!(content_type(&icon_terminal_svg().await), svg);
        assert_eq!(content_type(&icon_chevron_right_svg().await), svg);
        assert_eq!(content_type(&icon_chevron_down_svg().await), svg);
        assert_eq!(content_type(&icon_folder_svg().await), svg);
        assert_eq!(content_type(&icon_folder_up_svg().await), svg);
        assert_eq!(content_type(&icon_file_svg().await), svg);
        assert_eq!(content_type(&icon_trash_svg().await), svg);
        assert_eq!(content_type(&icon_search_svg().await), svg);
    }
}

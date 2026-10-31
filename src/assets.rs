use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};

pub(crate) const LOGIN_HTML: &str = include_str!("assets/login.html");
pub(crate) const APP_HTML: &str = include_str!("assets/app.html");

const LOGIN_CSS: &str = include_str!("assets/login.css");
const LOGIN_JS: &str = include_str!("assets/login.js");
const SHARED_CORE_JS: &str = include_str!("assets/shared/core.js");
const SHARED_HTTP_JS: &str = include_str!("assets/shared/http.js");
const SHARED_SKELETON_JS: &str = include_str!("assets/shared/skeleton.js");
const SHARED_SKELETON_CSS: &str = include_str!("assets/shared/skeleton.css");
const SHARED_ATTENTION_JS: &str = include_str!("assets/shared/attention.js");
const SHARED_ALERT_CARD_JS: &str = include_str!("assets/shared/alert_card.js");
const SHARED_ALERT_CARD_CSS: &str = include_str!("assets/shared/alert_card.css");
const SHARED_OPTIONS_JS: &str = include_str!("assets/shared/options.js");
const SHARED_ACTIONS_JS: &str = include_str!("assets/shared/actions.js");
const SHARED_FILE_ICONS_JS: &str = include_str!("assets/shared/file_icons.js");
const SHARED_FILE_ICONS_CSS: &str = include_str!("assets/shared/file_icons.css");
const SHARED_FILE_TREE_CSS: &str = include_str!("assets/shared/file_tree.css");
const SHARED_COLORS_CSS: &str = include_str!("assets/shared/colors.css");
const SHARED_TOKENS_CSS: &str = include_str!("assets/shared/tokens.css");
const SHARED_PRIMITIVES_CSS: &str = include_str!("assets/shared/primitives.css");
const SHARED_CONTENT_SEARCH_CSS: &str = include_str!("assets/shared/content_search.css");
const SHARED_FILE_TREE_JS: &str = include_str!("assets/shared/file_tree.js");
const SHARED_FILE_CONTENT_SEARCH_JS: &str = include_str!("assets/shared/file_content_search.js");
const SHARED_LINE_CONTEXT_JS: &str = include_str!("assets/shared/line_context.js");
const SHARED_WORKSPACE_SEARCH_JS: &str = include_str!("assets/shared/workspace_search.js");
const SHARED_SETTINGS_FEEDBACK_JS: &str = include_str!("assets/shared/settings_feedback.js");
const SHARED_SETTINGS_CONFIRM_JS: &str = include_str!("assets/shared/settings_confirm.js");
const SHARED_EDITOR_JS: &str = include_str!("assets/shared/editor.js");
const SHARED_LSP_JS: &str = include_str!("assets/shared/lsp.js");
const SHARED_MARKDOWN_PREVIEW_JS: &str = include_str!("assets/shared/markdown_preview.js");
const SHARED_MARKDOWN_PREVIEW_CSS: &str = include_str!("assets/shared/markdown_preview.css");
const SHARED_TERMINAL_SCROLL_JS: &str = include_str!("assets/shared/terminal_scroll.js");
const SHARED_TERMINAL_FIT_JS: &str = include_str!("assets/shared/terminal_fit.js");
const SHARED_TERMINAL_ADAPTER_JS: &str = include_str!("assets/shared/terminal_adapter.js");
const SHARED_GRAPHICS_BRIDGE_JS: &str = include_str!("assets/shared/graphics_bridge.js");
const VENDOR_CODEMIRROR_JS: &str = include_str!("assets/vendor/codemirror.bundle.js");
const VENDOR_MARKED_JS: &str = include_str!("assets/vendor/marked.bundle.js");
const VENDOR_DOMPURIFY_JS: &str = include_str!("assets/vendor/dompurify.bundle.js");
const VENDOR_MERMAID_JS: &str = include_str!("assets/vendor/mermaid.bundle.js");
const VENDOR_WTERM_JS: &str = include_str!("assets/vendor/wterm.bundle.js");
const VENDOR_WTERM_CSS: &str = include_str!("assets/vendor/wterm.css");
const VENDOR_GHOSTTY_WASM: &[u8] = include_bytes!("assets/vendor/ghostty-vt.wasm");
const APP_BOOT_JS: &str = include_str!("assets/app_boot.js");
const DESKTOP_CSS: &str = concat!(
    include_str!("assets/desktop/app_css/base.css"),
    include_str!("assets/desktop/app_css/panes.css"),
    include_str!("assets/desktop/app_css/modals.css"),
    include_str!("assets/desktop/app_css/terminal.css"),
    include_str!("assets/desktop/app_css/chrome.css"),
    include_str!("assets/desktop/app_css/controls.css"),
    include_str!("assets/desktop/app_css/workspaces.css"),
    include_str!("assets/desktop/app_css/location_bar.css"),
);
const DESKTOP_GIT_UI_CSS: &str = concat!(
    include_str!("assets/desktop/git_ui/shell.css"),
    include_str!("assets/desktop/git_ui/entry.css"),
    include_str!("assets/desktop/git_ui/layout.css"),
    include_str!("assets/desktop/git_ui/diff.css"),
    include_str!("assets/desktop/git_ui/log.css"),
    include_str!("assets/desktop/git_ui/syntax.css"),
);
const DESKTOP_SEARCH_CSS: &str = include_str!("assets/desktop/search.css");
const DESKTOP_NOTES_CSS: &str = include_str!("assets/desktop/notes.css");
const DESKTOP_FILE_BROWSER_CSS: &str = include_str!("assets/desktop/file_browser.css");
const DESKTOP_DIRECTORY_PICKER_CSS: &str = include_str!("assets/desktop/directory_picker.css");
const DESKTOP_SHORTCUTS_CSS: &str = include_str!("assets/desktop/shortcuts.css");
const DESKTOP_GIT_UI_JS: &str = concat!(
    include_str!("assets/desktop/git_ui/settings.js"),
    include_str!("assets/desktop/git_ui/primitives.js"),
    include_str!("assets/desktop/git_ui/diff_search.js"),
    include_str!("assets/desktop/git_ui/workspace_nav.js"),
    include_str!("assets/desktop/git_ui/syntax.js"),
    include_str!("assets/desktop/git_ui/log.js"),
    include_str!("assets/desktop/git_ui/shortcuts.js"),
    include_str!("assets/desktop/git_ui/stash.js"),
    include_str!("assets/desktop/git_ui/cleanup.js"),
    include_str!("assets/desktop/git_ui/diff_render.js"),
    include_str!("assets/desktop/git_ui/conflicts.js"),
    include_str!("assets/desktop/git_ui/side_tree.js"),
    include_str!("assets/desktop/git_ui/modals.js"),
    include_str!("assets/desktop/git_ui/branch_list.js"),
    include_str!("assets/desktop/git_ui/toasts.js"),
    include_str!("assets/desktop/git_ui/diff_view.js"),
    include_str!("assets/desktop/git_ui/log_render.js"),
    include_str!("assets/desktop/git_ui.js"),
);
const DESKTOP_SEARCH_JS: &str = include_str!("assets/desktop/search.js");
const DESKTOP_MODAL_DRAG_JS: &str = include_str!("assets/desktop/modal_drag.js");
const DESKTOP_NOTES_JS: &str = include_str!("assets/desktop/notes.js");
const DESKTOP_FILE_BROWSER_JS: &str = include_str!("assets/desktop/file_browser.js");
const DESKTOP_DIRECTORY_PICKER_JS: &str = include_str!("assets/desktop/directory_picker.js");
const DESKTOP_JS: &str = concat!(
    include_str!("assets/desktop/app_js/core.js"),
    include_str!("assets/desktop/app_js/open_folder_flow.js"),
    include_str!("assets/desktop/app_js/settings_sections.js"),
    include_str!("assets/desktop/app_js/workspace_shell.js"),
    include_str!("assets/desktop/app_js/right_sidebar.js"),
    include_str!("assets/desktop/app_js/search_panel.js"),
    include_str!("assets/desktop/app_js/workspace_panes.js"),
    include_str!("assets/desktop/app_js/location_bar.js"),
    include_str!("assets/desktop/app_js/pane_terminals.js"),
    include_str!("assets/desktop/app_js/render.js"),
    include_str!("assets/desktop/app_js/terminal.js"),
    include_str!("assets/desktop/app_js/lens.js"),
    include_str!("assets/desktop/app_js/prompt_cards.js"),
    include_str!("assets/desktop/app_js/composer.js"),
    include_str!("assets/desktop/app_js/worktrees.js"),
    include_str!("assets/desktop/app_js/shortcuts.js"),
    include_str!("assets/desktop/app_js/workspace_create.js"),
    include_str!("assets/desktop/lsp_settings.js"),
    include_str!("assets/desktop/layout_settings.js"),
    include_str!("assets/desktop/window_layout_settings.js"),
    include_str!("assets/desktop/app_js/bindings.js"),
);
const MOBILE_ATTENTION_JS: &str = include_str!("assets/mobile/attention.js");
const MOBILE_CORE_JS: &str = include_str!("assets/mobile/core.js");
const MOBILE_SETTINGS_JS: &str = include_str!("assets/mobile/settings.js");
const MOBILE_TERMINAL_JS: &str = include_str!("assets/mobile/terminal.js");
const MOBILE_WORKTREES_JS: &str = include_str!("assets/mobile/worktrees.js");
const MOBILE_DIRECTORY_PICKER_JS: &str = include_str!("assets/mobile/directory_picker.js");
const MOBILE_FILE_BROWSER_JS: &str = include_str!("assets/mobile/file_browser.js");
const MOBILE_NOTES_JS: &str = include_str!("assets/mobile/notes.js");
const MOBILE_SEARCH_JS: &str = include_str!("assets/mobile/search.js");
const MOBILE_GIT_JS: &str = include_str!("assets/mobile/git.js");
const MOBILE_COMPOSER_JS: &str = include_str!("assets/mobile/composer.js");
const MOBILE_LENS_JS: &str = include_str!("assets/mobile/lens.js");
const MOBILE_SESSIONS_JS: &str = include_str!("assets/mobile/sessions.js");
const MOBILE_EVENTS_JS: &str = include_str!("assets/mobile/events.js");
const MOBILE_SCREENS_JS: &str = include_str!("assets/mobile/screens.js");
const MOBILE_PANELS_JS: &str = include_str!("assets/mobile/panels.js");
const MOBILE_WORKMETA_JS: &str = include_str!("assets/mobile/workmeta.js");
const MOBILE_THEME_JS: &str = include_str!("assets/mobile/theme.js");
const MOBILE_ACTIONS_JS: &str = include_str!("assets/mobile/actions.js");
const MOBILE_BACKEND_JS: &str = include_str!("assets/mobile/backend.js");
const MOBILE_CSS: &str = include_str!("assets/mobile/app.css");
const MOBILE_JS: &str = include_str!("assets/mobile/app.js");
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
const ICON_LOCK: &str = include_str!("assets/icons/lock.svg");
const ICON_LOCK_OPEN: &str = include_str!("assets/icons/lock-open.svg");
const ICON_COLUMNS: &str = include_str!("assets/icons/columns.svg");
const ICON_SAVE: &str = include_str!("assets/icons/save.svg");
const ICON_CLOCK: &str = include_str!("assets/icons/clock.svg");
const ICON_COPY: &str = include_str!("assets/icons/copy.svg");
const ICON_X: &str = include_str!("assets/icons/x.svg");
const ICON_LINK: &str = include_str!("assets/icons/link.svg");
const ICON_PENCIL: &str = include_str!("assets/icons/pencil.svg");
const ICON_EYE: &str = include_str!("assets/icons/eye.svg");
const ICON_EYE_OFF: &str = include_str!("assets/icons/eye-off.svg");

pub(crate) fn app_html() -> Response {
    // Served through `index` in main.rs, which decides auth before calling
    // this, so the zero-arg signature is fixed; that means no conditional
    // 304 here, only unconditional ETag + no-cache so reloads revalidate.
    let mut response = Html(APP_HTML).into_response();
    attach_asset_cache_headers(&mut response, asset_etag(APP_HTML.as_bytes()));
    response
}

pub(crate) fn login_html() -> Response {
    let mut response = Html(LOGIN_HTML).into_response();
    attach_asset_cache_headers(&mut response, asset_etag(LOGIN_HTML.as_bytes()));
    response
}

pub(crate) async fn jetbrains_mono_nerd_font(headers: HeaderMap) -> Response {
    static_bytes(&headers, JETBRAINS_MONO_NERD_FONT, "font/ttf")
}

pub(crate) async fn vendor_wterm_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        VENDOR_WTERM_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn vendor_wterm_css(headers: HeaderMap) -> Response {
    static_text(&headers, VENDOR_WTERM_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn vendor_ghostty_wasm(headers: HeaderMap) -> Response {
    static_bytes(&headers, VENDOR_GHOSTTY_WASM, "application/wasm")
}

pub(crate) async fn desktop_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_git_ui_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_GIT_UI_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn app_boot_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        APP_BOOT_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_core_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_CORE_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_http_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_HTTP_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_skeleton_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_SKELETON_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_skeleton_css(headers: HeaderMap) -> Response {
    static_text(&headers, SHARED_SKELETON_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_attention_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_ATTENTION_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_alert_card_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_ALERT_CARD_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_alert_card_css(headers: HeaderMap) -> Response {
    static_text(&headers, SHARED_ALERT_CARD_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_options_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_OPTIONS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_actions_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_ACTIONS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_file_icons_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_FILE_ICONS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_file_icons_css(headers: HeaderMap) -> Response {
    static_text(&headers, SHARED_FILE_ICONS_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_file_tree_css(headers: HeaderMap) -> Response {
    static_text(&headers, SHARED_FILE_TREE_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_colors_css(headers: HeaderMap) -> Response {
    static_text(&headers, SHARED_COLORS_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_tokens_css(headers: HeaderMap) -> Response {
    static_text(&headers, SHARED_TOKENS_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_primitives_css(headers: HeaderMap) -> Response {
    static_text(&headers, SHARED_PRIMITIVES_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn shared_content_search_css(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_CONTENT_SEARCH_CSS,
        "text/css; charset=utf-8",
    )
}

pub(crate) async fn shared_file_tree_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_FILE_TREE_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_file_content_search_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_FILE_CONTENT_SEARCH_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_line_context_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_LINE_CONTEXT_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_workspace_search_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_WORKSPACE_SEARCH_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_settings_feedback_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_SETTINGS_FEEDBACK_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_settings_confirm_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_SETTINGS_CONFIRM_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_editor_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_EDITOR_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_lsp_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_LSP_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_markdown_preview_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_MARKDOWN_PREVIEW_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_markdown_preview_css(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_MARKDOWN_PREVIEW_CSS,
        "text/css; charset=utf-8",
    )
}

pub(crate) async fn shared_terminal_scroll_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_TERMINAL_SCROLL_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_terminal_fit_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_TERMINAL_FIT_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_terminal_adapter_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_TERMINAL_ADAPTER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn shared_graphics_bridge_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        SHARED_GRAPHICS_BRIDGE_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn vendor_codemirror_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        VENDOR_CODEMIRROR_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn vendor_marked_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        VENDOR_MARKED_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn vendor_dompurify_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        VENDOR_DOMPURIFY_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn vendor_mermaid_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        VENDOR_MERMAID_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_search_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_SEARCH_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_modal_drag_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_MODAL_DRAG_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_notes_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_NOTES_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_file_browser_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_FILE_BROWSER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_directory_picker_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_DIRECTORY_PICKER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn desktop_css(headers: HeaderMap) -> Response {
    static_text(&headers, DESKTOP_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn desktop_git_ui_css(headers: HeaderMap) -> Response {
    static_text(&headers, DESKTOP_GIT_UI_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn desktop_search_css(headers: HeaderMap) -> Response {
    static_text(&headers, DESKTOP_SEARCH_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn desktop_notes_css(headers: HeaderMap) -> Response {
    static_text(&headers, DESKTOP_NOTES_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn desktop_file_browser_css(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_FILE_BROWSER_CSS,
        "text/css; charset=utf-8",
    )
}

pub(crate) async fn desktop_directory_picker_css(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        DESKTOP_DIRECTORY_PICKER_CSS,
        "text/css; charset=utf-8",
    )
}

pub(crate) async fn desktop_shortcuts_css(headers: HeaderMap) -> Response {
    static_text(&headers, DESKTOP_SHORTCUTS_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn mobile_js(headers: HeaderMap) -> Response {
    static_text(&headers, MOBILE_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn mobile_core_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_CORE_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_attention_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_ATTENTION_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_settings_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_SETTINGS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_search_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_SEARCH_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_git_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_GIT_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_composer_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_COMPOSER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_lens_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_LENS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_sessions_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_SESSIONS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_events_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_EVENTS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_screens_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_SCREENS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_panels_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_PANELS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_workmeta_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_WORKMETA_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_theme_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_THEME_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_actions_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_ACTIONS_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_backend_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_BACKEND_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_terminal_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_TERMINAL_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_worktrees_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_WORKTREES_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_directory_picker_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_DIRECTORY_PICKER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_file_browser_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_FILE_BROWSER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_notes_js(headers: HeaderMap) -> Response {
    static_text(
        &headers,
        MOBILE_NOTES_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn mobile_css(headers: HeaderMap) -> Response {
    static_text(&headers, MOBILE_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn login_js(headers: HeaderMap) -> Response {
    static_text(&headers, LOGIN_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn login_css(headers: HeaderMap) -> Response {
    static_text(&headers, LOGIN_CSS, "text/css; charset=utf-8")
}

// FNV-1a 64-bit over the embedded bytes. No hash-crate dependency needed;
// assets are baked into the binary at compile time, so any content change
// flips the ETag, which is exactly the property we want: a different binary
// build always produces a different (or content-equal) tag.
fn fnv64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn asset_etag(body: &[u8]) -> String {
    format!("\"{:016x}\"", fnv64(body))
}

// Asset URLs are versionless (/assets/desktop/app.css and friends carry no
// build hash in the path), so a long max-age would keep serving stale files
// after a binary upgrade. `no-cache` keeps the response cacheable but forces
// a conditional revalidation on every use; with the ETag that collapses to a
// 304 with an empty body when nothing changed, which is the cheap path.
fn if_none_match_hits(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim();
                // Browsers echo the exact tag back; some proxies may prefix a
                // weak validator marker, and `*` means "anything held".
                candidate == etag || candidate == "*" || candidate == format!("W/{etag}")
            })
        })
}

fn attach_asset_cache_headers(response: &mut Response, etag: String) {
    let headers = response.headers_mut();
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("hex etag is a valid header value"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
}

fn not_modified_response(etag: String) -> Response {
    Response::builder()
        .status(StatusCode::NOT_MODIFIED)
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::empty())
        .expect("static asset 304 response should be valid")
}

fn static_text(headers: &HeaderMap, body: &'static str, content_type: &'static str) -> Response {
    let etag = asset_etag(body.as_bytes());
    if if_none_match_hits(headers, &etag) {
        return not_modified_response(etag);
    }
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    attach_asset_cache_headers(&mut response, etag);
    response
}

fn static_bytes(headers: &HeaderMap, body: &'static [u8], content_type: &'static str) -> Response {
    let etag = asset_etag(body);
    if if_none_match_hits(headers, &etag) {
        return not_modified_response(etag);
    }
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .expect("static asset response should be valid");
    attach_asset_cache_headers(&mut response, etag);
    response
}

pub(crate) async fn favicon_svg(headers: HeaderMap) -> Response {
    let etag = asset_etag(HERDR_LOGO.as_bytes());
    if if_none_match_hits(&headers, &etag) {
        return not_modified_response(etag);
    }
    let mut response = HERDR_LOGO.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    attach_asset_cache_headers(&mut response, etag);
    response
}

pub(crate) async fn favicon_attention_svg(headers: HeaderMap) -> Response {
    themed_favicon_svg(&headers, "#fff7ed", "#fed7aa", "#f97316")
}

pub(crate) async fn favicon_error_svg(headers: HeaderMap) -> Response {
    themed_favicon_svg(&headers, "#fef2f2", "#fecaca", "#ef4444")
}

fn themed_favicon_svg(
    headers: &HeaderMap,
    background: &str,
    chrome: &str,
    accent: &str,
) -> Response {
    let body = HERDR_LOGO
        .replace("#e0e0e0", background)
        .replace("#f5f5f5", background)
        .replace("#bdbdbd", chrome)
        .replace("#a0a0a0", accent)
        .replace("#808080", accent)
        .replace("#606060", accent);
    let etag = asset_etag(body.as_bytes());
    if if_none_match_hits(headers, &etag) {
        return not_modified_response(etag);
    }
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    attach_asset_cache_headers(&mut response, etag);
    response
}

fn static_svg(headers: &HeaderMap, body: &'static str) -> Response {
    let etag = asset_etag(body.as_bytes());
    if if_none_match_hits(headers, &etag) {
        return not_modified_response(etag);
    }
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    attach_asset_cache_headers(&mut response, etag);
    response
}

pub(crate) async fn icon_help_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_HELP)
}

pub(crate) async fn icon_settings_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_SETTINGS)
}

pub(crate) async fn icon_theme_auto_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_THEME_AUTO)
}

pub(crate) async fn icon_git_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_GIT)
}

pub(crate) async fn icon_terminal_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_TERMINAL)
}

pub(crate) async fn icon_chevron_right_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_CHEVRON_RIGHT)
}

pub(crate) async fn icon_chevron_down_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_CHEVRON_DOWN)
}

pub(crate) async fn icon_folder_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_FOLDER)
}

pub(crate) async fn icon_folder_up_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_FOLDER_UP)
}

pub(crate) async fn icon_file_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_FILE)
}

pub(crate) async fn icon_trash_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_TRASH)
}

pub(crate) async fn icon_search_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_SEARCH)
}

pub(crate) async fn icon_refresh_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_REFRESH)
}

pub(crate) async fn icon_lock_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_LOCK)
}

pub(crate) async fn icon_lock_open_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_LOCK_OPEN)
}

pub(crate) async fn icon_columns_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_COLUMNS)
}

pub(crate) async fn icon_save_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_SAVE)
}

pub(crate) async fn icon_clock_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_CLOCK)
}

pub(crate) async fn icon_copy_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_COPY)
}

pub(crate) async fn icon_x_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_X)
}

pub(crate) async fn icon_link_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_LINK)
}

pub(crate) async fn icon_pencil_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_PENCIL)
}

pub(crate) async fn icon_eye_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_EYE)
}

pub(crate) async fn icon_eye_off_svg(headers: HeaderMap) -> Response {
    static_svg(&headers, ICON_EYE_OFF)
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

        assert_eq!(
            content_type(&desktop_git_ui_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&desktop_file_browser_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&desktop_directory_picker_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_actions_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_file_tree_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_file_tree_css(HeaderMap::new()).await),
            css
        );
        assert_eq!(
            content_type(&shared_workspace_search_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_terminal_scroll_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_terminal_fit_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_terminal_adapter_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_editor_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_markdown_preview_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_markdown_preview_css(HeaderMap::new()).await),
            css
        );
        assert_eq!(
            content_type(&vendor_codemirror_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&vendor_marked_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&vendor_dompurify_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&vendor_mermaid_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&vendor_wterm_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(content_type(&vendor_wterm_css(HeaderMap::new()).await), css);
        assert_eq!(
            content_type(&vendor_ghostty_wasm(HeaderMap::new()).await),
            "application/wasm"
        );
        assert_eq!(
            content_type(&mobile_file_browser_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&mobile_notes_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&mobile_directory_picker_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(content_type(&login_js(HeaderMap::new()).await), javascript);
        assert_eq!(
            content_type(&shared_skeleton_js(HeaderMap::new()).await),
            javascript
        );
        assert_eq!(
            content_type(&shared_skeleton_css(HeaderMap::new()).await),
            css
        );
        assert_eq!(
            content_type(&shared_colors_css(HeaderMap::new()).await),
            css
        );
        assert_eq!(
            content_type(&shared_content_search_css(HeaderMap::new()).await),
            css
        );
        assert_eq!(
            content_type(&desktop_git_ui_css(HeaderMap::new()).await),
            css
        );
        assert_eq!(
            content_type(&desktop_file_browser_css(HeaderMap::new()).await),
            css
        );
        assert_eq!(
            content_type(&desktop_directory_picker_css(HeaderMap::new()).await),
            css
        );
        assert_eq!(content_type(&login_css(HeaderMap::new()).await), css);
    }

    #[tokio::test]
    async fn serves_icon_assets_as_svg() {
        let svg = "image/svg+xml; charset=utf-8";

        assert_eq!(content_type(&icon_help_svg(HeaderMap::new()).await), svg);
        assert_eq!(
            content_type(&icon_settings_svg(HeaderMap::new()).await),
            svg
        );
        assert_eq!(
            content_type(&icon_theme_auto_svg(HeaderMap::new()).await),
            svg
        );
        assert_eq!(content_type(&icon_git_svg(HeaderMap::new()).await), svg);
        assert_eq!(
            content_type(&icon_terminal_svg(HeaderMap::new()).await),
            svg
        );
        assert_eq!(
            content_type(&icon_chevron_right_svg(HeaderMap::new()).await),
            svg
        );
        assert_eq!(
            content_type(&icon_chevron_down_svg(HeaderMap::new()).await),
            svg
        );
        assert_eq!(content_type(&icon_folder_svg(HeaderMap::new()).await), svg);
        assert_eq!(
            content_type(&icon_folder_up_svg(HeaderMap::new()).await),
            svg
        );
        assert_eq!(content_type(&icon_file_svg(HeaderMap::new()).await), svg);
        assert_eq!(content_type(&icon_trash_svg(HeaderMap::new()).await), svg);
        assert_eq!(content_type(&icon_search_svg(HeaderMap::new()).await), svg);
        assert_eq!(content_type(&icon_lock_svg(HeaderMap::new()).await), svg);
        assert_eq!(
            content_type(&icon_lock_open_svg(HeaderMap::new()).await),
            svg
        );
        assert_eq!(content_type(&icon_eye_svg(HeaderMap::new()).await), svg);
        assert_eq!(content_type(&icon_eye_off_svg(HeaderMap::new()).await), svg);
    }

    #[test]
    fn login_html_contains_password_toggle() {
        assert!(LOGIN_HTML.contains(r#"id="passwordToggle""#));
        assert!(LOGIN_HTML.contains(r#"aria-label="Show password""#));
        assert!(LOGIN_HTML.contains(r#"aria-pressed="false""#));
    }

    #[tokio::test]
    async fn assets_set_etag_and_no_cache_headers() {
        let response = desktop_css(HeaderMap::new()).await;
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .expect("desktop css carries an ETag")
            .to_string();
        assert!(etag.starts_with('"') && etag.ends_with('"'));
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default(),
            "no-cache"
        );

        // Same bytes must produce the same tag, so If-None-Match round-trips.
        let replay = static_text(&HeaderMap::new(), DESKTOP_CSS, "text/css; charset=utf-8");
        assert_eq!(
            replay
                .headers()
                .get(header::ETAG)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default(),
            etag
        );

        // Binary assets go through the same helpers.
        let wasm = vendor_ghostty_wasm(HeaderMap::new()).await;
        assert!(wasm.headers().get(header::ETAG).is_some());
        assert_eq!(
            wasm.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default(),
            "no-cache"
        );

        // The app HTML shell is cached too, even without conditional support.
        let html = app_html();
        assert!(html.headers().get(header::ETAG).is_some());
        assert_eq!(
            html.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default(),
            "no-cache"
        );
    }

    #[tokio::test]
    async fn matching_if_none_match_returns_304_empty_body() {
        let fresh = desktop_css(HeaderMap::new()).await;
        let etag = fresh
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .expect("etag present")
            .to_string();

        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_str(&etag).expect("etag header value"),
        );
        let cached = desktop_css(headers).await;
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        // 304 must not carry the asset bytes; axum's Body has no size probe
        // without http_body traits in scope, so assert on the status and the
        // stripped content type instead.
        assert!(cached.headers().get(header::CONTENT_TYPE).is_none());
        assert_eq!(
            cached
                .headers()
                .get(header::ETAG)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default(),
            etag
        );

        // A stale tag must serve the full body again.
        let mut stale = HeaderMap::new();
        stale.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static("\"deadbeef\""),
        );
        let full = desktop_css(stale).await;
        assert_eq!(full.status(), StatusCode::OK);
    }

    #[test]
    fn shared_skeleton_assets_define_runtime_contract() {
        assert!(SHARED_SKELETON_JS.contains("HerdrSkeleton"));
        assert!(SHARED_SKELETON_CSS.contains(".herdr-skeleton"));
    }

    #[test]
    fn settings_feedback_supports_saving_pending_badges() {
        // Settings rows must expose a pending "Saving..." state for saves
        // that wait on the backend, not only the final applied/error badge.
        assert!(SHARED_SETTINGS_FEEDBACK_JS.contains("flashSaving"));
        assert!(SHARED_SETTINGS_FEEDBACK_JS.contains("settings-applied-saving"));
    }

    #[test]
    fn app_html_contains_blocking_overlay() {
        assert!(APP_HTML.contains(r#"id="blockingOverlay""#));
        assert!(APP_HTML.contains(r#"class="blocking-overlay""#));
        assert!(APP_HTML.contains(r#"id="blockingOverlayLabel""#));
    }

    #[test]
    fn desktop_css_contains_blocking_overlay_styles() {
        assert!(DESKTOP_CSS.contains(".blocking-overlay"));
        assert!(DESKTOP_CSS.contains("z-index: 1300"));
    }

    #[test]
    fn desktop_js_defines_blocking_functions() {
        assert!(DESKTOP_JS.contains("function showBlocking("));
        assert!(DESKTOP_JS.contains("function hideBlocking("));
        assert!(DESKTOP_JS.contains("function resetBlocking("));
        assert!(DESKTOP_JS.contains("window.showBlocking"));
        assert!(DESKTOP_JS.contains("window.hideBlocking"));
        assert!(DESKTOP_JS.contains("window.resetBlocking"));
        assert!(DESKTOP_JS.contains("unhandledrejection"));
        assert!(DESKTOP_JS.contains("blockingOverlayDepth"));
    }

    #[test]
    fn desktop_js_wraps_actions_with_blocking() {
        // Worktree actions
        assert!(DESKTOP_JS.contains(r#"showBlocking("Creating worktree"#));
        assert!(DESKTOP_JS.contains(r#"showBlocking("Opening worktree"#));
        assert!(DESKTOP_JS.contains(r#"showBlocking("Removing worktree"#));
        assert!(DESKTOP_JS.contains(r#"showBlocking("Closing workspace"#));
        assert!(DESKTOP_JS.contains(r#"showBlocking("Creating panel"#));
        assert!(DESKTOP_JS.contains(r#"showBlocking("Closing panel"#));

        // Session/settings actions
        assert!(DESKTOP_JS.contains(r#"showBlocking("Launching session"#));
        assert!(DESKTOP_JS.contains(r#"showBlocking("Closing session"#));
        assert!(DESKTOP_JS.contains(r#"showBlocking("Saving settings"#));

        // Workspace create
        assert!(DESKTOP_JS.contains(r#"showBlocking("Creating workspace"#));

        // catch-block hideBlocking before confirmation dialogs
        assert!(DESKTOP_JS.contains("confirmForceWorktreeRemove"));
        assert!(DESKTOP_JS.contains("confirmContinueWithoutPull"));
    }

    #[test]
    fn git_ui_js_wraps_actions_with_blocking() {
        assert!(DESKTOP_GIT_UI_JS.contains("showBlocking"));
        assert!(DESKTOP_GIT_UI_JS.contains("hideBlocking"));
        assert!(DESKTOP_GIT_UI_JS.contains(r#"showBlocking("Saving file"#));
        assert!(DESKTOP_GIT_UI_JS.contains(r#"showBlocking("Deleting"#));
        assert!(DESKTOP_GIT_UI_JS.contains(r#"showBlocking("Removing worktree"#));
        // Defensive guards for test compatibility
        assert!(DESKTOP_GIT_UI_JS.contains(r#"typeof showBlocking === "function""#));
        assert!(DESKTOP_GIT_UI_JS.contains(r#"typeof hideBlocking === "function""#));
    }

    #[test]
    fn file_browser_js_wraps_actions_with_blocking() {
        assert!(DESKTOP_FILE_BROWSER_JS.contains("showBlocking"));
        assert!(DESKTOP_FILE_BROWSER_JS.contains("hideBlocking"));
        assert!(DESKTOP_FILE_BROWSER_JS.contains(r#"showBlocking("Saving file"#));
        assert!(DESKTOP_FILE_BROWSER_JS.contains(r#"showBlocking("Renaming"#));
        assert!(DESKTOP_FILE_BROWSER_JS.contains(r#"showBlocking("Deleting"#));
        // Defensive guards for test compatibility
        assert!(DESKTOP_FILE_BROWSER_JS.contains(r#"typeof showBlocking === "function""#));
        assert!(DESKTOP_FILE_BROWSER_JS.contains(r#"typeof hideBlocking === "function""#));
    }

    #[test]
    fn modals_css_has_blocking_overlay_above_modals() {
        // The blocking overlay must sit above the question modal (z-index 1100)
        // and the command palette (z-index 1200) to prevent interaction.
        assert!(DESKTOP_CSS.contains("z-index: 1300"));
        assert!(DESKTOP_CSS.contains(".blocking-overlay"));
        assert!(DESKTOP_CSS.contains("blocking-overlay-label"));
    }
}

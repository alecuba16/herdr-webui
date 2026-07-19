use axum::body::Body;
use axum::http::{header, HeaderValue};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;

pub(crate) const LOGIN_HTML: &str = include_str!("assets/login.html");
pub(crate) const APP_HTML: &str = include_str!("assets/app.html");

const LOGIN_CSS: &str = include_str!("assets/login.css");
const LOGIN_JS: &str = include_str!("assets/login.js");
const SHARED_CORE_JS: &str = include_str!("assets/shared/core.js");
const SHARED_ACTIONS_JS: &str = include_str!("assets/shared/actions.js");
const SHARED_FILE_ICONS_JS: &str = include_str!("assets/shared/file_icons.js");
const SHARED_FILE_ICONS_CSS: &str = include_str!("assets/shared/file_icons.css");
const SHARED_COLORS_CSS: &str = include_str!("assets/shared/colors.css");
const SHARED_FILE_WIDGETS_CSS: &str = include_str!("assets/shared/file_widgets.css");
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

pub(crate) fn static_asset_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/assets/desktop/app.css", get(desktop_css))
        .route("/assets/desktop/git-ui.css", get(desktop_git_ui_css))
        .route(
            "/assets/desktop/file-browser.css",
            get(desktop_file_browser_css),
        )
        .route("/assets/desktop/search.css", get(desktop_search_css))
        .route("/assets/desktop/shortcuts.css", get(desktop_shortcuts_css))
        .route("/assets/app-boot.js", get(app_boot_js))
        .route("/assets/shared/core.js", get(shared_core_js))
        .route("/assets/shared/actions.js", get(shared_actions_js))
        .route("/assets/shared/file-icons.js", get(shared_file_icons_js))
        .route("/assets/shared/file-icons.css", get(shared_file_icons_css))
        .route("/assets/shared/colors.css", get(shared_colors_css))
        .route(
            "/assets/shared/file-widgets.css",
            get(shared_file_widgets_css),
        )
        .route(
            "/assets/shared/content-search.css",
            get(shared_content_search_css),
        )
        .route("/assets/shared/file-tree.js", get(shared_file_tree_js))
        .route(
            "/assets/shared/file-content-search.js",
            get(shared_file_content_search_js),
        )
        .route(
            "/assets/shared/line-context.js",
            get(shared_line_context_js),
        )
        .route(
            "/assets/shared/workspace-search.js",
            get(shared_workspace_search_js),
        )
        .route("/assets/vendor/codemirror.js", get(vendor_codemirror_js))
        .route("/assets/shared/editor.js", get(shared_editor_js))
        .route(
            "/assets/shared/terminal-scroll.js",
            get(shared_terminal_scroll_js),
        )
        .route(
            "/assets/shared/terminal-fit.js",
            get(shared_terminal_fit_js),
        )
        .route(
            "/assets/shared/temp-terminal.js",
            get(shared_temp_terminal_js),
        )
        .route("/assets/desktop/git-ui.js", get(desktop_git_ui_js))
        .route(
            "/assets/desktop/file-browser.js",
            get(desktop_file_browser_js),
        )
        .route(
            "/assets/desktop/directory-picker.js",
            get(desktop_directory_picker_js),
        )
        .route("/assets/desktop/search.js", get(desktop_search_js))
        .route("/assets/desktop/app.js", get(desktop_js))
        .route("/assets/login.css", get(login_css))
        .route("/assets/login.js", get(login_js))
        .route("/assets/mobile/attention.js", get(mobile_attention_js))
        .route("/assets/mobile/core.js", get(mobile_core_js))
        .route("/assets/mobile/settings.js", get(mobile_settings_js))
        .route("/assets/mobile/terminal.js", get(mobile_terminal_js))
        .route("/assets/mobile/worktrees.js", get(mobile_worktrees_js))
        .route(
            "/assets/mobile/file-browser.js",
            get(mobile_file_browser_js),
        )
        .route("/assets/mobile/app.css", get(mobile_css))
        .route("/assets/mobile/app.js", get(mobile_js))
        .route("/assets/xterm.js", get(xterm_js))
        .route("/assets/xterm.css", get(xterm_css))
        .route(
            "/assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf",
            get(jetbrains_mono_nerd_font),
        )
        .route("/assets/icons/help.svg", get(icon_help_svg))
        .route("/assets/icons/settings.svg", get(icon_settings_svg))
        .route("/assets/icons/theme-auto.svg", get(icon_theme_auto_svg))
        .route("/assets/icons/git.svg", get(icon_git_svg))
        .route("/assets/icons/terminal.svg", get(icon_terminal_svg))
        .route(
            "/assets/icons/chevron-right.svg",
            get(icon_chevron_right_svg),
        )
        .route("/assets/icons/chevron-down.svg", get(icon_chevron_down_svg))
        .route("/assets/icons/folder.svg", get(icon_folder_svg))
        .route("/assets/icons/folder-up.svg", get(icon_folder_up_svg))
        .route("/assets/icons/file.svg", get(icon_file_svg))
        .route("/assets/icons/trash.svg", get(icon_trash_svg))
        .route("/assets/icons/search.svg", get(icon_search_svg))
        .route("/assets/icons/refresh.svg", get(icon_refresh_svg))
        .route("/favicon.svg", get(favicon_svg))
        .route("/favicon-attention.svg", get(favicon_attention_svg))
        .route("/favicon-error.svg", get(favicon_error_svg))
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

pub(crate) async fn shared_file_widgets_css() -> Response {
    static_text(SHARED_FILE_WIDGETS_CSS, "text/css; charset=utf-8")
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
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Method, Request, StatusCode};
    use tower::ServiceExt;

    fn content_type(response: &Response) -> &str {
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
    }

    async fn request_static_asset(app: Router, path: &str) -> Response {
        app.oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn static_asset_routes_serve_embedded_content() {
        let app: Router = static_asset_routes();
        let assets = [
            ("/assets/xterm.js", "javascript", 1000usize),
            ("/assets/xterm.css", "text/css", 100usize),
            (
                "/assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf",
                "font/ttf",
                2 * 1024 * 1024,
            ),
            ("/assets/app-boot.js", "javascript", 100usize),
            ("/assets/shared/core.js", "javascript", 100usize),
            ("/assets/shared/actions.js", "javascript", 100usize),
            ("/assets/shared/file-icons.js", "javascript", 100usize),
            ("/assets/shared/file-icons.css", "text/css", 100usize),
            ("/assets/shared/colors.css", "text/css", 100usize),
            ("/assets/shared/file-widgets.css", "text/css", 100usize),
            ("/assets/shared/content-search.css", "text/css", 100usize),
            ("/assets/shared/file-tree.js", "javascript", 100usize),
            (
                "/assets/shared/file-content-search.js",
                "javascript",
                100usize,
            ),
            ("/assets/shared/line-context.js", "javascript", 100usize),
            ("/assets/shared/workspace-search.js", "javascript", 100usize),
            ("/assets/shared/editor.js", "javascript", 100usize),
            ("/assets/shared/terminal-scroll.js", "javascript", 100usize),
            ("/assets/shared/terminal-fit.js", "javascript", 100usize),
            ("/assets/shared/temp-terminal.js", "javascript", 1000usize),
            ("/assets/vendor/codemirror.js", "javascript", 1000usize),
            ("/assets/desktop/app.js", "javascript", 1000usize),
            ("/assets/desktop/git-ui.js", "javascript", 1000usize),
            ("/assets/desktop/file-browser.js", "javascript", 1000usize),
            (
                "/assets/desktop/directory-picker.js",
                "javascript",
                100usize,
            ),
            ("/assets/desktop/search.js", "javascript", 100usize),
            ("/assets/desktop/app.css", "text/css", 1000usize),
            ("/assets/desktop/git-ui.css", "text/css", 1000usize),
            ("/assets/desktop/file-browser.css", "text/css", 100usize),
            ("/assets/desktop/search.css", "text/css", 100usize),
            ("/assets/desktop/shortcuts.css", "text/css", 100usize),
            ("/assets/login.css", "text/css", 100usize),
            ("/assets/login.js", "javascript", 100usize),
            ("/assets/mobile/app.js", "javascript", 1000usize),
            ("/assets/mobile/core.js", "javascript", 1000usize),
            ("/assets/mobile/attention.js", "javascript", 1000usize),
            ("/assets/mobile/terminal.js", "javascript", 1000usize),
            ("/assets/mobile/worktrees.js", "javascript", 1000usize),
            ("/assets/mobile/settings.js", "javascript", 100usize),
            ("/assets/mobile/file-browser.js", "javascript", 1000usize),
            ("/assets/mobile/app.css", "text/css", 1000usize),
            ("/assets/icons/help.svg", "image/svg+xml", 100usize),
            ("/assets/icons/settings.svg", "image/svg+xml", 100usize),
            ("/assets/icons/theme-auto.svg", "image/svg+xml", 100usize),
            ("/assets/icons/git.svg", "image/svg+xml", 100usize),
            ("/assets/icons/terminal.svg", "image/svg+xml", 100usize),
            ("/assets/icons/chevron-right.svg", "image/svg+xml", 100usize),
            ("/assets/icons/chevron-down.svg", "image/svg+xml", 100usize),
            ("/assets/icons/folder.svg", "image/svg+xml", 100usize),
            ("/assets/icons/folder-up.svg", "image/svg+xml", 100usize),
            ("/assets/icons/file.svg", "image/svg+xml", 100usize),
            ("/assets/icons/trash.svg", "image/svg+xml", 100usize),
            ("/assets/icons/search.svg", "image/svg+xml", 100usize),
            ("/assets/icons/refresh.svg", "image/svg+xml", 100usize),
            ("/favicon.svg", "image/svg+xml", 100usize),
            ("/favicon-attention.svg", "image/svg+xml", 100usize),
            ("/favicon-error.svg", "image/svg+xml", 100usize),
        ];

        for (path, expected_content_type, minimum_bytes) in assets {
            let response = request_static_asset(app.clone(), path).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert!(
                content_type(&response).contains(expected_content_type),
                "{path} content type was {}",
                content_type(&response)
            );
            let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
                .await
                .unwrap();
            assert!(
                body.len() > minimum_bytes,
                "{path} body length {} <= {minimum_bytes}",
                body.len()
            );
        }
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
        assert_eq!(content_type(&shared_file_widgets_css().await), css);
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

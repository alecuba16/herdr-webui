use axum::http::{header, HeaderValue};
use axum::response::{Html, IntoResponse, Response};

pub(crate) const LOGIN_HTML: &str = include_str!("assets/login.html");
pub(crate) const APP_HTML: &str = include_str!("assets/app.html");

const LOGIN_CSS: &str = include_str!("assets/login.css");
const LOGIN_JS: &str = include_str!("assets/login.js");
const APP_CORE_JS: &str = include_str!("assets/app_core.js");
const APP_BOOT_JS: &str = include_str!("assets/app_boot.js");
const APP_CSS: &str = include_str!("assets/app.css");
const APP_JS: &str = include_str!("assets/app.js");
const MOBILE_ATTENTION_JS: &str = include_str!("assets/mobile_attention.js");
const MOBILE_CORE_JS: &str = include_str!("assets/mobile_core.js");
const MOBILE_SETTINGS_JS: &str = include_str!("assets/mobile_settings.js");
const MOBILE_TERMINAL_JS: &str = include_str!("assets/mobile_terminal.js");
const MOBILE_WORKTREES_JS: &str = include_str!("assets/mobile_worktrees.js");
const MOBILE_CSS: &str = include_str!("assets/mobile.css");
const MOBILE_JS: &str = include_str!("assets/mobile.js");
const XTERM_CSS: &str = include_str!("assets/xterm.css");
const XTERM_JS: &str = include_str!("assets/xterm.min.js");
const HERDR_LOGO: &str = include_str!("assets/herdr-logo.svg");

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

pub(crate) async fn app_js() -> Response {
    static_text(APP_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn app_boot_js() -> Response {
    static_text(APP_BOOT_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn app_core_js() -> Response {
    static_text(APP_CORE_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn app_css() -> Response {
    static_text(APP_CSS, "text/css; charset=utf-8")
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

pub(crate) async fn favicon_svg() -> Response {
    let mut response = HERDR_LOGO.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    response
}

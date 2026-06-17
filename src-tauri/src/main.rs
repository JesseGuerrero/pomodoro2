#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    pomodoro_app_lib::run();
}

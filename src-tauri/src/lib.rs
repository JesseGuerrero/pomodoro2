use std::io::{Read, Write};
use std::net::TcpListener;
use std::fs::OpenOptions;

const LOG_PATH: &str = r"C:\Users\jesse\Projects\Productivity\pomodoro-app\app.log";

#[tauri::command]
fn log_to_file(msg: String) {
    use std::io::Write as _;
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(LOG_PATH) {
        let ts = chrono::Local::now().format("%H:%M:%S");
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

const CLIENT_ID: &str = "816183260763-1g50kp8s8dbbgj8v2gbc45aupaman4cl.apps.googleusercontent.com";
const SCOPES: &str = "https://www.googleapis.com/auth/calendar";
const PORT: u16 = 28173;

#[tauri::command]
fn google_oauth() -> Result<String, String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", PORT))
        .map_err(|e| format!("Port {} in use: {}", PORT, e))?;

    let redirect = format!("http://localhost:{}/callback", PORT);
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=token&scope={}&prompt=consent",
        CLIENT_ID, redirect, SCOPES
    );

    open::that(&url).map_err(|e| format!("Can't open browser: {}", e))?;

    // Step 1: Google redirects here with token in URL fragment (not sent to server).
    // Serve a page that extracts the token from the hash and sends it back.
    let (mut s, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut buf = [0u8; 4096];
    let _ = s.read(&mut buf);
    let page = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:system-ui;text-align:center;padding:60px;background:#0f0f13;color:#e2e8f0'>\
        <script>\
        var h=location.hash.substring(1),p=new URLSearchParams(h),t=p.get('access_token');\
        if(t){fetch('/token?t='+t).then(function(){document.body.innerHTML='<h2>Connected! You can close this tab.</h2>'})}\
        else{document.body.innerHTML='<h2>Error: no token received</h2>'}\
        </script><h2>Connecting...</h2></body></html>";
    s.write_all(page.as_bytes()).ok();
    drop(s);

    // Step 2: Receive the token from the page's fetch request
    let (mut s2, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut buf2 = [0u8; 8192];
    let n = s2.read(&mut buf2).map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf2[..n]);

    let token = req.lines().next()
        .and_then(|l| l.split("t=").nth(1))
        .and_then(|s| s.split(|c: char| c == '&' || c == ' ').next())
        .map(|s| s.to_string())
        .ok_or("Failed to extract token")?;

    let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK";
    s2.write_all(resp.as_bytes()).ok();

    Ok(token)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![google_oauth, log_to_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

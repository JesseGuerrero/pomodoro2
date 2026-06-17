use std::io::{Read, Write};
use std::net::TcpListener;
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::process::Command;

fn app_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("pomodoro-today");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn log_path() -> PathBuf { app_dir().join("app.log") }
fn token_path() -> PathBuf { app_dir().join("tokens.json") }
const CREDS_JSON: &str = include_str!("../../credentials.json");
const SCOPES: &str = "https://www.googleapis.com/auth/calendar";
const PORT: u16 = 28173;

fn load_creds() -> Result<(String, String), String> {
    let v: serde_json::Value = serde_json::from_str(CREDS_JSON)
        .map_err(|_| "Invalid credentials.json")?;
    let id = v["client_id"].as_str().ok_or("No client_id")?.to_string();
    let secret = v["client_secret"].as_str().ok_or("No client_secret")?.to_string();
    Ok((id, secret))
}

fn log(msg: &str) {
    use std::io::Write as _;
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let ts = chrono::Local::now().format("%H:%M:%S");
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

#[tauri::command]
fn log_to_file(msg: String) { eprintln!("[js] {}", msg); log(&msg); }

fn save_tokens(access: &str, refresh: &str, expires_in: u64) {
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + expires_in;
    let json = serde_json::json!({
        "access_token": access,
        "refresh_token": refresh,
        "expires_at": expires_at
    });
    let _ = fs::write(token_path(), json.to_string());
}

fn load_tokens() -> Option<serde_json::Value> {
    fs::read_to_string(token_path()).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn do_refresh(refresh_token: &str) -> Result<String, String> {
    let (client_id, client_secret) = load_creds()?;
    log(&format!("Refreshing token with refresh_token={}...", &refresh_token[..8]));
    let resp: serde_json::Value = ureq::post("https://oauth2.googleapis.com/token")
        .send_form(&[
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .map_err(|e| format!("Refresh request failed: {}", e))?
        .into_json()
        .map_err(|e| format!("Refresh parse failed: {}", e))?;

    let access = resp["access_token"].as_str().ok_or("No access_token in refresh response")?;
    let expires_in = resp["expires_in"].as_u64().unwrap_or(3600);
    save_tokens(access, refresh_token, expires_in);
    log(&format!("Refresh success, new token={}...", &access[..8]));
    Ok(access.to_string())
}

/// Try to get a valid token from stored refresh token (no browser popup)
#[tauri::command]
fn try_refresh() -> Result<String, String> {
    eprintln!("[oauth] try_refresh called");
    let tokens = load_tokens().ok_or("No stored tokens")?;
    let refresh = tokens["refresh_token"].as_str().ok_or("No refresh_token stored")?;
    let expires_at = tokens["expires_at"].as_u64().unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();

    // If access token still valid (with 5 min buffer), return it
    if now + 300 < expires_at {
        let access = tokens["access_token"].as_str().ok_or("No access_token")?;
        log(&format!("Using stored token (expires in {}s)", expires_at - now));
        return Ok(access.to_string());
    }

    // Otherwise refresh
    do_refresh(refresh)
}

fn open_browser(url: &str) -> Result<(), String> {
    // Try xdg-open with cleaned AppImage environment first
    let mut cmd = Command::new("xdg-open");
    cmd.arg(url);
    cmd.env_remove("LD_LIBRARY_PATH");
    cmd.env_remove("GDK_BACKEND");
    if let Ok(appdir) = std::env::var("APPDIR") {
        if let Ok(path) = std::env::var("PATH") {
            let cleaned: Vec<&str> = path.split(':')
                .filter(|p| !p.starts_with(&appdir))
                .collect();
            cmd.env("PATH", cleaned.join(":"));
        }
    }
    match cmd.spawn() {
        Ok(_) => {
            eprintln!("[oauth] xdg-open succeeded");
            return Ok(());
        }
        Err(e) => eprintln!("[oauth] xdg-open failed: {}, trying open crate", e),
    }
    // Fallback to open crate
    open::that(url).map_err(|e| format!("Can't open browser: {}", e))
}

/// Full browser OAuth flow — returns access token, stores refresh token
#[tauri::command]
fn google_oauth() -> Result<String, String> {
    eprintln!("[oauth] google_oauth called");
    log("google_oauth called");
    let (client_id, client_secret) = load_creds()?;

    let listener = TcpListener::bind(format!("127.0.0.1:{}", PORT))
        .map_err(|e| { eprintln!("[oauth] bind failed: {}", e); format!("Port {} in use — try closing the app and reopening: {}", PORT, e) })?;
    listener.set_nonblocking(false).ok();
    eprintln!("[oauth] listening on port {}", PORT);

    let redirect = format!("http://127.0.0.1:{}", PORT);
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        client_id, redirect, SCOPES
    );

    log("Opening browser for OAuth...");
    open_browser(&url)?;
    eprintln!("[oauth] browser opened, waiting for redirect on port {}...", PORT);

    // Wait for Google to redirect with ?code=AUTH_CODE (5 min timeout)
    listener.set_nonblocking(true).ok();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    let stream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() > deadline {
                    return Err("Timed out waiting for Google sign-in (5 min). Try again.".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Listener error: {}", e)),
        }
    };
    let mut s = stream;
    let mut buf = [0u8; 8192];
    let n = s.read(&mut buf).map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    eprintln!("[oauth] got redirect request");

    let code = req.lines().next()
        .and_then(|l| l.split("code=").nth(1))
        .and_then(|s| s.split(|c: char| c == '&' || c == ' ').next())
        .map(|s| s.to_string())
        .ok_or("No auth code in redirect")?;

    let page = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:system-ui;text-align:center;padding:60px;background:#0f0f13;color:#e2e8f0'>\
        <h2>Connected! You can close this tab.</h2></body></html>";
    s.write_all(page.as_bytes()).ok();
    drop(s);

    log("Exchanging auth code for tokens...");
    let resp: serde_json::Value = ureq::post("https://oauth2.googleapis.com/token")
        .send_form(&[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .map_err(|e| format!("Token exchange failed: {}", e))?
        .into_json()
        .map_err(|e| format!("Token parse failed: {}", e))?;

    let access = resp["access_token"].as_str().ok_or("No access_token")?.to_string();
    let refresh = resp["refresh_token"].as_str().ok_or("No refresh_token")?.to_string();
    let expires_in = resp["expires_in"].as_u64().unwrap_or(3600);
    save_tokens(&access, &refresh, expires_in);
    log(&format!("OAuth complete, got refresh token, access={}...", &access[..8]));
    eprintln!("[oauth] OAuth complete!");

    Ok(access)
}

#[tauri::command]
fn focus_window(window: tauri::Window) {
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![google_oauth, try_refresh, log_to_file, focus_window])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

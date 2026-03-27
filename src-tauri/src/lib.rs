use std::io::{Read, Write};
use std::net::TcpListener;
use std::fs::{self, OpenOptions};

const LOG_PATH: &str = r"C:\Users\jesse\Projects\Productivity\pomodoro-app\app.log";
const TOKEN_PATH: &str = r"C:\Users\jesse\Projects\Productivity\pomodoro-app\tokens.json";
const CREDS_PATH: &str = r"C:\Users\jesse\Projects\Productivity\pomodoro-app\credentials.json";
const SCOPES: &str = "https://www.googleapis.com/auth/calendar";
const PORT: u16 = 28173;

fn load_creds() -> Result<(String, String), String> {
    let data = fs::read_to_string(CREDS_PATH)
        .map_err(|_| "credentials.json not found")?;
    let v: serde_json::Value = serde_json::from_str(&data)
        .map_err(|_| "Invalid credentials.json")?;
    let id = v["client_id"].as_str().ok_or("No client_id")?.to_string();
    let secret = v["client_secret"].as_str().ok_or("No client_secret")?.to_string();
    Ok((id, secret))
}

fn log(msg: &str) {
    use std::io::Write as _;
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(LOG_PATH) {
        let ts = chrono::Local::now().format("%H:%M:%S");
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

#[tauri::command]
fn log_to_file(msg: String) { log(&msg); }

fn save_tokens(access: &str, refresh: &str, expires_in: u64) {
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + expires_in;
    let json = serde_json::json!({
        "access_token": access,
        "refresh_token": refresh,
        "expires_at": expires_at
    });
    let _ = fs::write(TOKEN_PATH, json.to_string());
}

fn load_tokens() -> Option<serde_json::Value> {
    fs::read_to_string(TOKEN_PATH).ok()
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

/// Full browser OAuth flow — returns access token, stores refresh token
#[tauri::command]
fn google_oauth() -> Result<String, String> {
    let (client_id, client_secret) = load_creds()?;
    let listener = TcpListener::bind(format!("127.0.0.1:{}", PORT))
        .map_err(|e| format!("Port {} in use: {}", PORT, e))?;

    let redirect = format!("http://127.0.0.1:{}", PORT);
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        client_id, redirect, SCOPES
    );

    log("Opening browser for OAuth...");
    open::that(&url).map_err(|e| format!("Can't open browser: {}", e))?;

    // Wait for Google to redirect with ?code=AUTH_CODE
    let (mut s, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut buf = [0u8; 8192];
    let n = s.read(&mut buf).map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);

    let code = req.lines().next()
        .and_then(|l| l.split("code=").nth(1))
        .and_then(|s| s.split(|c: char| c == '&' || c == ' ').next())
        .map(|s| s.to_string())
        .ok_or("No auth code in redirect")?;

    // Show success page
    let page = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:system-ui;text-align:center;padding:60px;background:#0f0f13;color:#e2e8f0'>\
        <h2>Connected! You can close this tab.</h2></body></html>";
    s.write_all(page.as_bytes()).ok();
    drop(s);

    // Exchange auth code for tokens
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

    Ok(access)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![google_oauth, try_refresh, log_to_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

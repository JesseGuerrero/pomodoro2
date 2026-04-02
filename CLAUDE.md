# Pomodoro App

## Debug Log
App logs and tokens are stored in the OS data directory under `pomodoro-today/`:
- **Windows**: `%APPDATA%\pomodoro-today\app.log`
- **macOS**: `~/Library/Application Support/pomodoro-today/app.log`
- **Linux**: `~/.local/share/pomodoro-today/app.log`

Logs include timestamps and cover OAuth, calendar loading, calendar saving, and API responses.

## Credentials
Desktop OAuth credentials are in `credentials.json` (gitignored). The Rust backend loads them at runtime. Never hardcode secrets in source files.

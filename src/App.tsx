import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getTodos, addTodo, updateTodo, deleteTodo, getSessions, addSession, type Todo, type Session } from "./storage";

const GOOGLE_CLIENT_ID = "816183260763-1g50kp8s8dbbgj8v2gbc45aupaman4cl.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/calendar";

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const uid = () => crypto.randomUUID();
const Purple = "#6c63ff", Dark = "#1e1e2e", Border = "#2d2d3a";

type CalEvent = { id: string; summary: string; startIso: string; endIso: string; allDay: boolean };

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const log = (msg: string) => { if (isTauri) invoke("log_to_file", { msg }).catch(() => {}); };
let tokenClient: any = null;
let accessToken: string | null = null;

function initGoogleAuth(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (tokenClient) { resolve(); return; }
    let elapsed = 0;
    const check = () => {
      if ((window as any).google?.accounts?.oauth2) {
        tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          callback: () => {},
        });
        resolve();
      } else if (elapsed >= 10000) {
        reject(new Error("Google script failed to load"));
      } else {
        elapsed += 200;
        setTimeout(check, 200);
      }
    };
    check();
  });
}

function requestToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (accessToken) { resolve(accessToken); return; }
    tokenClient.callback = (resp: any) => {
      if (resp.error) { reject(resp); return; }
      accessToken = resp.access_token;
      resolve(resp.access_token);
    };
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

async function gcalFetch(path: string, options?: RequestInit) {
  const token = isTauri ? accessToken! : await requestToken();
  const f = isTauri ? tauriFetch : fetch;
  log(`gcalFetch ${options?.method || "GET"} ${path} token=${token ? token.slice(0, 8) + "..." : "null"}`);
  const res = await f(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options?.headers },
  });
  log(`gcalFetch response: ${res.status} ${res.statusText}`);
  if (res.status === 401 && isTauri) {
    log("Token expired, refreshing silently...");
    accessToken = await invoke<string>("try_refresh");
    log(`Refresh complete, token=${accessToken.slice(0, 8)}...`);
    return tauriFetch(`https://www.googleapis.com/calendar/v3${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...options?.headers },
    });
  }
  return res;
}

export default function App() {
  const [duration, setDuration] = useState(25);
  const BREAK = 5;
  const [seconds, setSeconds] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [isBreak, setIsBreak] = useState(false);
  const [finished, setFinished] = useState(false);
  const bellPlayedAt = useRef<number | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [calEvents, setCalEvents] = useState<CalEvent[]>([]);
  const [calLoading, setCalLoading] = useState(true);
  const [calAuthed, setCalAuthed] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [todoInput, setTodoInput] = useState("");
  const [tab, setTab] = useState("timer");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const startedAt = useRef<string | null>(null);
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { init(); }, []);

  const init = async () => {
    if (isTauri) {
      try {
        accessToken = await invoke<string>("try_refresh");
        log(`Auto-login with stored token=${accessToken.slice(0, 8)}...`);
        setCalAuthed(true);
        setTodos(await getTodos());
        setSessions(await getSessions());
        await loadCal();
      } catch {
        setCalAuthed(false);
        setCalLoading(false);
      }
      return;
    }
    try {
      await initGoogleAuth();
      await requestToken();
      setCalAuthed(true);
      setTodos(await getTodos());
      setSessions(await getSessions());
      await loadCal();
    } catch {
      setCalAuthed(false);
      setCalLoading(false);
    }
  };

  const authAndLoadCal = async () => {
    setAuthLoading(true);
    setAuthError("");
    try {
      if (isTauri) {
        log("Starting Tauri OAuth flow");
        accessToken = await invoke<string>("google_oauth");
        log(`OAuth complete, token=${accessToken.slice(0, 8)}...`);
      } else {
        await initGoogleAuth();
        await requestToken();
      }
      setCalAuthed(true);
      setTodos(await getTodos());
      setSessions(await getSessions());
      await loadCal();
    } catch (e: any) {
      log(`authAndLoadCal error: ${JSON.stringify(e)}`);
      setAuthLoading(false);
      setCalLoading(false);
      setAuthError(e?.message || "Failed to connect. Check your internet and try again.");
    }
  };

  const loadCal = async () => {
    setCalLoading(true);
    log("loadCal started");
    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const res = await gcalFetch(
        `/calendars/primary/events?timeMin=${encodeURIComponent(startOfDay)}&timeMax=${encodeURIComponent(endOfDay)}&singleEvents=true&orderBy=startTime&timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message);
      setCalAuthed(true);
      const events: CalEvent[] = (data.items || []).map((e: any) => ({
        id: e.id,
        summary: e.summary || "(No title)",
        startIso: e.start?.dateTime || e.start?.date || "",
        endIso: e.end?.dateTime || e.end?.date || "",
        allDay: !!e.start?.date,
      }));
      log(`loadCal got ${events.length} events`);
      setCalEvents(events);
    } catch (e: any) {
      log(`loadCal error: ${e?.message || JSON.stringify(e)}`);
      setCalEvents([]);
    }
    setCalLoading(false);
  };

  const saveToGCal = async (startIso: string, mins: number) => {
    const endIso = new Date(new Date(startIso).getTime() + mins * 60000).toISOString();
    log(`saveToGCal: ${mins}m session starting ${startIso}`);
    try {
      const res = await gcalFetch("/calendars/primary/events", {
        method: "POST",
        body: JSON.stringify({
          summary: `🍅 Pomodoro Session (${mins}m)`,
          start: { dateTime: startIso },
          end: { dateTime: endIso },
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        log(`saveToGCal failed: ${res.status} ${err}`);
      } else {
        log("saveToGCal success");
      }
    } catch (e: any) {
      log(`saveToGCal exception: ${e?.message || JSON.stringify(e)}`);
    }
  };

  const playBell = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      [660, 880].forEach((freq, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "sine"; o.frequency.value = freq;
        g.gain.setValueAtTime(0, ctx.currentTime + i * 0.01);
        g.gain.linearRampToValueAtTime(0.4, ctx.currentTime + i * 0.01 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5);
        o.start(ctx.currentTime + i * 0.01);
        o.stop(ctx.currentTime + 2.5);
      });
    } catch {}
  };

  const saveSession = async (dur: number, start: string | null) => {
    const startIso = start || new Date().toISOString();
    const elapsedMins = (Date.now() - new Date(startIso).getTime()) / 60000;
    if (elapsedMins < 10) return false;
    const actualMins = Math.round(elapsedMins);
    const row: Session = { id: uid(), started_at: startIso, duration_minutes: actualMins, completed: true };
    setSessions(prev => [row, ...prev]);
    await addSession(row);
    await saveToGCal(startIso, actualMins);
    return true;
  };

  const handleComplete = useCallback(async () => {
    if (!isBreak) { await saveSession(duration, startedAt.current); setIsBreak(true); setSeconds(BREAK * 60); }
    else { setIsBreak(false); setSeconds(duration * 60); }
    setFinished(false); bellPlayedAt.current = null; startedAt.current = null;
  }, [isBreak, duration, sessions]);

  useEffect(() => {
    if (running) {
      ivRef.current = setInterval(() => {
        setSeconds(s => {
          if (s <= 1 && s > 0) {
            playBell();
            bellPlayedAt.current = Date.now();
            setFinished(true);
            setRunning(false);
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } else if (ivRef.current) clearInterval(ivRef.current);
    return () => { if (ivRef.current) clearInterval(ivRef.current); };
  }, [running]);

  // Ring again 3 minutes after finishing if still idle
  useEffect(() => {
    if (!finished) return;
    const iv = setInterval(() => {
      if (bellPlayedAt.current && Date.now() - bellPlayedAt.current >= 180000) {
        playBell();
        bellPlayedAt.current = Date.now();
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [finished]);

  const start = () => { if (!startedAt.current) startedAt.current = new Date().toISOString(); setFinished(false); bellPlayedAt.current = null; setRunning(true); };
  const pause = () => setRunning(false);
  const addTime = () => { setSeconds(10 * 60); setFinished(false); bellPlayedAt.current = null; setRunning(true); };
  const reset = () => { if (ivRef.current) clearInterval(ivRef.current); setRunning(false); setIsBreak(false); setSeconds(duration * 60); setFinished(false); bellPlayedAt.current = null; startedAt.current = null; };
  const changeDur = (v: number) => { if (!running) { setDuration(v); if (!isBreak) setSeconds(v * 60); } };

  const handleAddTodo = async () => {
    if (!todoInput.trim()) return;
    const todo: Todo = { id: uid(), text: todoInput.trim(), completed: false, priority: false, created_at: new Date().toISOString() };
    setTodos(prev => [todo, ...prev]);
    await addTodo(todo);
    setTodoInput("");
  };
  const toggleTodo = async (t: Todo) => {
    const next = !t.completed;
    setTodos(prev => prev.map(x => x.id === t.id ? { ...x, completed: next } : x));
    await updateTodo(t.id, { completed: next });
  };
  const togglePriority = async (t: Todo) => {
    const next = !t.priority;
    setTodos(prev => prev.map(x => x.id === t.id ? { ...x, priority: next } : x));
    await updateTodo(t.id, { priority: next });
  };
  const handleDelTodo = async (id: string) => {
    setTodos(prev => prev.filter(x => x.id !== id));
    await deleteTodo(id);
  };

  const now = new Date();
  const todayStr = now.toDateString();
  const upcomingCal = calEvents.filter(e => !e.allDay && new Date(e.endIso) >= now);
  const pastCal = calEvents.filter(e => !e.allDay && new Date(e.endIso) < now);
  const calFocusMins = pastCal.reduce((a, e) => a + Math.round((new Date(e.endIso).getTime() - new Date(e.startIso).getTime()) / 60000), 0);
  const todaySessions = sessions.filter(s => new Date(s.started_at).toDateString() === todayStr);
  const pomodoroMins = todaySessions.reduce((a, s) => a + s.duration_minutes, 0);
  const totalFocusMins = pomodoroMins + calFocusMins;
  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return { label: d.toLocaleDateString("en", { weekday: "short" }), date: d.toDateString() }; });
  const weekData = weekDays.map(d => ({ ...d, mins: sessions.filter(s => new Date(s.started_at).toDateString() === d.date).reduce((a, s) => a + s.duration_minutes, 0) }));
  const maxMins = Math.max(...weekData.map(d => d.mins), 1);
  const pct = ((isBreak ? BREAK * 60 : duration * 60) - seconds) / (isBreak ? BREAK * 60 : duration * 60);
  const r = 90, circ = 2 * Math.PI * r;
  const sortedTodos = [...todos].sort((a, b) => Number(b.priority) - Number(a.priority));

  if (!calAuthed) {
    return (
      <div style={{ minHeight: "100vh", background: "#0f0f13", color: "#e2e8f0", fontFamily: "system-ui,sans-serif", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", maxWidth: 360 }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>🍅</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#f8f8f2", marginBottom: 8 }}>Pomodoro + Today</div>
          <div style={{ fontSize: 14, color: "#718096", marginBottom: 32 }}>Connect your Google Calendar to get started</div>
          <button onClick={authAndLoadCal} disabled={authLoading} style={{ padding: "14px 32px", background: authLoading ? "#4a4a6a" : Purple, color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, fontSize: 16, cursor: authLoading ? "wait" : "pointer" }}>
            {authLoading ? "Connecting..." : "Connect Google Calendar"}
          </button>
          {authError && <div style={{ marginTop: 16, color: "#fc8181", fontSize: 13 }}>{authError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0f0f13", color: "#e2e8f0", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ background: "#16161e", borderBottom: `1px solid ${Border}`, padding: "12px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 20 }}>🍅</span>
        <span style={{ fontWeight: 700, fontSize: 18, color: "#f8f8f2" }}>Pomodoro + Today</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {["timer", "analytics"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: tab === t ? Purple : "#2d2d3a", color: tab === t ? "#fff" : "#a0aec0", fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>{t}</button>
          ))}
        </div>
      </div>

      {tab === "timer" && (
        <div style={{ display: "flex", flex: 1 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "32px 24px", borderRight: `1px solid ${Border}` }}>
            <div style={{ background: isBreak ? "#1a2e1a" : "#1e1a2e", borderRadius: 16, padding: "8px 20px", marginBottom: 24, fontSize: 13, fontWeight: 600, color: isBreak ? "#68d391" : "#a78bfa" }}>
              {isBreak ? "☕ Break Time" : "🎯 Focus Session"}
            </div>
            <div style={{ position: "relative", marginBottom: 24 }}>
              <svg width={220} height={220} style={{ transform: "rotate(-90deg)" }}>
                <circle cx={110} cy={110} r={r} fill="none" stroke={Border} strokeWidth={10} />
                <circle cx={110} cy={110} r={r} fill="none" stroke={isBreak ? "#68d391" : Purple} strokeWidth={10}
                  strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round"
                  style={{ transition: "stroke-dashoffset 1s linear" }} />
              </svg>
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 42, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: finished ? "#fc8181" : "#f8f8f2" }}>
                  {fmt(seconds)}
                </span>
                {finished && <span style={{ fontSize: 11, color: "#fc8181", marginTop: 2, fontWeight: 600, letterSpacing: 1 }}>TIME'S UP</span>}
              </div>
            </div>
            {!isBreak && (
              <div style={{ width: "100%", maxWidth: 260, marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#718096", marginBottom: 4 }}>
                  <span>Duration</span><span style={{ color: "#a78bfa", fontWeight: 600 }}>{duration} min</span>
                </div>
                <input type="range" min={20} max={60} value={duration} onChange={e => changeDur(+e.target.value)} disabled={running} style={{ width: "100%", accentColor: Purple }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#4a5568" }}><span>20</span><span>60</span></div>
              </div>
            )}
            <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
              {finished ? <>
                <button onClick={addTime} style={{ padding: "10px 28px", background: "#4a3a1a", color: "#f6e05e", border: "1px solid #6b5a2a", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>+10 min</button>
                <button onClick={handleComplete} style={{ padding: "10px 28px", background: Purple, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Done</button>
              </> : !running
                ? <button onClick={start} style={{ padding: "10px 28px", background: Purple, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>▶ Start</button>
                : <button onClick={pause} style={{ padding: "10px 28px", background: "#4a4a6a", color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>⏸ Pause</button>
              }
              <button onClick={reset} style={{ padding: "10px 16px", background: "#2d2d3a", color: "#a0aec0", border: "none", borderRadius: 10, fontSize: 15, cursor: "pointer" }}>↺</button>
              <button onClick={async () => {
                setSaving(true); setSaveMsg("");
                const ok = await saveSession(duration, startedAt.current);
                setSaving(false); setSaveMsg(ok ? "✓ Saved!" : "Need 10+ min");
                setTimeout(() => setSaveMsg(""), 3000);
              }} disabled={saving} style={{ padding: "10px 16px", background: "#1a3a2a", color: "#68d391", border: "1px solid #2d5a3a", borderRadius: 10, fontSize: 13, cursor: "pointer", fontWeight: 600 }}>
                {saving ? "Saving…" : "💾 Save"}
              </button>
            </div>
            {saveMsg && <div style={{ fontSize: 12, color: saveMsg.includes("Need") ? "#fc8181" : "#68d391", marginBottom: 8 }}>{saveMsg}</div>}
            <div style={{ display: "flex", gap: 16, margin: "16px 0" }}>
              {[{ label: "🍅 Pomodoros", val: todaySessions.length }, { label: "⏱ Focus Today", val: `${totalFocusMins}m` }].map(s => (
                <div key={s.label} style={{ background: Dark, borderRadius: 10, padding: "10px 18px", textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#a78bfa" }}>{s.val}</div>
                  <div style={{ fontSize: 11, color: "#718096" }}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{ width: "100%", maxWidth: 320 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#718096", marginBottom: 8 }}>Recent Sessions</div>
              <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {todaySessions.slice(0, 6).map(s => (
                  <div key={s.id} style={{ background: Dark, borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                    🍅 {s.duration_minutes}m — {fmtTime(s.started_at)}
                  </div>
                ))}
                {todaySessions.length === 0 && <div style={{ color: "#4a5568", fontSize: 13, textAlign: "center", padding: 12 }}>No sessions yet</div>}
              </div>
            </div>
          </div>

          <div style={{ width: 340, display: "flex", flexDirection: "column", padding: "24px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#f8f8f2" }}>📅 Today's List</div>
              <button onClick={loadCal} style={{ background: "none", border: "none", color: "#718096", cursor: "pointer", fontSize: 14 }}>🔄</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input value={todoInput} onChange={e => setTodoInput(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAddTodo()}
                placeholder="Add a task..." style={{ flex: 1, background: Dark, border: `1px solid ${Border}`, borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13, outline: "none" }} />
              <button onClick={handleAddTodo} style={{ background: Purple, color: "#fff", border: "none", borderRadius: 8, padding: "8px 12px", cursor: "pointer", fontWeight: 700 }}>+</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
              {calLoading && <div style={{ color: "#4a5568", fontSize: 12, textAlign: "center", padding: 8 }}>Loading calendar…</div>}
              {!calLoading && upcomingCal.length > 0 && <>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#718096", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Upcoming Events</div>
                {upcomingCal.map(e => (
                  <div key={e.id} style={{ background: "#1a1a2e", border: "1px solid #3a3a5a", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                    <span>📆</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: "#c4b5fd", fontWeight: 600 }}>{e.summary}</div>
                      <div style={{ fontSize: 11, color: "#718096" }}>{fmtTime(e.startIso)} – {fmtTime(e.endIso)}</div>
                    </div>
                  </div>
                ))}
              </>}
              {!calLoading && pastCal.length > 0 && <>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#718096", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, marginTop: 8 }}>
                  Past Events <span style={{ color: "#68d391" }}>+{calFocusMins}m focus</span>
                </div>
                {pastCal.map(e => (
                  <div key={e.id} style={{ background: Dark, borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, opacity: 0.55 }}>
                    <span>✅</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: "#a0aec0", textDecoration: "line-through" }}>{e.summary}</div>
                      <div style={{ fontSize: 11, color: "#718096" }}>{fmtTime(e.startIso)} – {fmtTime(e.endIso)}</div>
                    </div>
                  </div>
                ))}
              </>}
              {sortedTodos.length > 0 && <>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#718096", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, marginTop: 8 }}>Tasks</div>
                {sortedTodos.map(t => (
                  <div key={t.id} style={{ background: Dark, borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, opacity: t.completed ? 0.55 : 1, border: t.priority ? "1px solid #2d5a2d" : "1px solid transparent" }}>
                    <button onClick={() => toggleTodo(t)} style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${t.completed ? Purple : "#4a5568"}`, background: t.completed ? Purple : "transparent", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11 }}>
                      {t.completed ? "✓" : ""}
                    </button>
                    <span style={{ flex: 1, fontSize: 13, textDecoration: t.completed ? "line-through" : "none", color: t.completed ? "#718096" : "#e2e8f0" }}>{t.text}</span>
                    <button onClick={() => togglePriority(t)} style={{ background: t.priority ? "#1a3a1a" : "none", border: t.priority ? "1px solid #2d5a2d" : `1px solid ${Border}`, borderRadius: 6, color: t.priority ? "#68d391" : "#4a5568", cursor: "pointer", fontSize: 10, fontWeight: 700, padding: "2px 6px", flexShrink: 0 }}>
                      {t.priority ? "● Priority" : "+ Priority"}
                    </button>
                    <button onClick={() => handleDelTodo(t.id)} style={{ background: "none", border: "none", color: "#4a5568", cursor: "pointer", fontSize: 14, padding: 0 }}>✕</button>
                  </div>
                ))}
              </>}
              {!calLoading && calEvents.length === 0 && todos.length === 0 && (
                <div style={{ color: "#4a5568", fontSize: 13, textAlign: "center", padding: 20 }}>No events or tasks for today</div>
              )}
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: "#4a5568", textAlign: "right" }}>
              {todos.filter(t => t.completed).length}/{todos.length} tasks done
            </div>
          </div>
        </div>
      )}

      {tab === "analytics" && (
        <div style={{ padding: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 24, color: "#f8f8f2" }}>📊 Weekly Analytics</div>
          <div style={{ display: "flex", gap: 16, marginBottom: 32 }}>
            {[{ label: "Total Sessions", val: sessions.length }, { label: "Pomodoro Mins", val: pomodoroMins }, { label: "Cal Focus Mins", val: calFocusMins }, { label: "Tasks Done", val: todos.filter(t => t.completed).length }].map(s => (
              <div key={s.label} style={{ flex: 1, background: Dark, borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: "#a78bfa" }}>{s.val}</div>
                <div style={{ fontSize: 12, color: "#718096", marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>
          <div style={{ background: Dark, borderRadius: 12, padding: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#a0aec0", marginBottom: 20 }}>Pomodoro Minutes — Last 7 Days</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 140 }}>
              {weekData.map(d => (
                <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 11, color: "#718096" }}>{d.mins > 0 ? d.mins : ""}</div>
                  <div style={{ width: "100%", background: d.date === todayStr ? Purple : "#3d3d5a", borderRadius: "4px 4px 0 0", height: `${Math.max((d.mins / maxMins) * 100, d.mins > 0 ? 4 : 0)}px`, transition: "height 0.4s" }} />
                  <div style={{ fontSize: 11, color: d.date === todayStr ? "#a78bfa" : "#718096", fontWeight: d.date === todayStr ? 700 : 400 }}>{d.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

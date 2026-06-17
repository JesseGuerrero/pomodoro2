import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import GtfsRt from "gtfs-realtime-bindings";
import { getTodos, addTodo, updateTodo, deleteTodo, getSessions, addSession, deleteSession, type Todo, type Session } from "./storage";

const GOOGLE_CLIENT_ID = "816183260763-1g50kp8s8dbbgj8v2gbc45aupaman4cl.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/calendar";

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const uid = () => crypto.randomUUID();
// A task that should show live VIA bus arrivals: exact text "Gym" or "gym".
const isGymText = (s: string) => s === "Gym" || s === "gym";
const Purple = "#6c63ff", Card = "#f5f5f7", Border = "#e2e2e8";

type CalEvent = { id: string; summary: string; startIso: string; endIso: string; allDay: boolean };

// Recurring todos: each entry is a SEQUENCE of texts inserted one at a time on a
// cadence. The sequence is never broken and never has two of its members on the
// list at once — the next text is only inserted after the previous one is popped
// (completed/deleted). After the last it wraps to the first. A length-1 sequence
// is just a single repeating task.
// `intervalMs` = test cadence (fires every N ms). `days` = weekly schedule
// (0=Sun..6=Sat). `dayOfMonth` = monthly schedule (1-31). Both checked once a
// minute; optional `atHour` (0-23) only adds once that hour is reached.
// Optional `weeks` constrains `days` to specific occurrences in the month:
// 1=1st .. 5=5th, -1=last (e.g. days:[2], weeks:[2,4] = 2nd & 4th Tuesday).
// Omit `weeks` for a plain weekly schedule.
// Use intervalMs OR days OR dayOfMonth.
//
// A sequence member can be a plain string (uses the entry's schedule, advances
// by index after each pop) OR an object with its OWN schedule. When any member
// carries its own schedule the entry runs in "selection mode": on each tick the
// member whose schedule is due now is inserted (still one-at-a-time, no dupes).
type Schedule = { days?: number[]; weeks?: number[]; dayOfMonth?: number; atHour?: number };
type SeqItem = string | (Schedule & { text: string });
type Recurring = Schedule & { texts: SeqItem[]; intervalMs?: number };
const itemText = (it: SeqItem) => (typeof it === "string" ? it : it.text);
const RECURRING: Recurring[] = [
  { texts: ["Shave"], days: [1, 5], atHour: 12 }, // Monday & Friday at noon
  { texts: ["Haircut"], dayOfMonth: 1, atHour: 12 }, // 1st of the month at noon
  { texts: ["Gym"], days: [1, 3, 5, 6] }, // Monday, Wednesday, Friday, Saturday
  { texts: ["Pay Bills"], dayOfMonth: 1 }, // 1st of the month
  { texts: ["Change AC filters"], dayOfMonth: 20 }, // 20th of the month
  { texts: [ // Cleaning rotation — each room on its own Tuesday/Thursday schedule
    { text: "Clean Restroom", days: [2], weeks: [1, 3] },    // 1st & 3rd Tuesday
    { text: "Clean Bedroom", days: [2], weeks: [2, 4] },     // 2nd & 4th Tuesday
    { text: "Clean Living Room", days: [4], weeks: [1, 3] }, // 1st & 3rd Thursday
    { text: "Clean Kitchen", days: [4], weeks: [2, 4] },     // 2nd & 4th Thursday
  ] },
];

// Is `s` due at `now` (weekly/monthly/nth-weekday/hour gates; no gate = always)?
function isDue(s: Schedule, now: Date): boolean {
  if (s.days && !s.days.includes(now.getDay())) return false;
  if (s.weeks) {
    const week = Math.ceil(now.getDate() / 7);
    const last = now.getDate() + 7 > new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (!(s.weeks.includes(week) || (s.weeks.includes(-1) && last))) return false;
  }
  if (s.dayOfMonth != null && now.getDate() !== s.dayOfMonth) return false;
  if (s.atHour != null && now.getHours() < s.atHour) return false;
  return true;
}

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

// VIA Metropolitan Transit live arrivals. The agency publishes a GTFS-Realtime
// TripUpdates feed (protobuf) — the same source Google Maps ingests. We decode
// it, keep stop_time_updates for our stop on our route, and return the next
// `count` arrival clock times. HTTP-only host (no TLS served), allowlisted in
// the Tauri http capability.
const VIA_TRIPUPDATES = "http://gtfs.viainfo.net/tripupdate/tripupdates.pb";
async function nextBusArrivals(routeId: string, stopId: string, count = 3): Promise<string[]> {
  const f = isTauri ? tauriFetch : fetch;
  const res = await f(VIA_TRIPUPDATES);
  const feed = GtfsRt.transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  const now = Date.now() / 1000;
  const times: number[] = [];
  for (const e of feed.entity) {
    const tu = e.tripUpdate;
    if (!tu || tu.trip?.routeId !== routeId) continue;
    for (const stu of tu.stopTimeUpdate || []) {
      if (stu.stopId !== stopId) continue;
      const t = stu.arrival?.time ?? stu.departure?.time;
      if (t != null && Number(t) > now) times.push(Number(t));
    }
  }
  times.sort((a, b) => a - b);
  return times.slice(0, count).map(ts => `${Math.max(0, Math.round((ts - now) / 60))}m`);
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
  const [todosLoaded, setTodosLoaded] = useState(false);
  const [calEvents, setCalEvents] = useState<CalEvent[]>([]);
  const [calLoading, setCalLoading] = useState(true);
  const [calAuthed, setCalAuthed] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [todoInput, setTodoInput] = useState("");
  const [busTimes, setBusTimes] = useState<string[]>([]); // live VIA route 43 @ stop 17847
  const [tab, setTab] = useState("timer");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const startedAt = useRef<string | null>(null);
  const todosRef = useRef<Todo[]>([]);
  // Per-sequence cursor: current index + whether that index has been placed yet.
  const seqState = useRef<Record<number, { idx: number; placed: boolean }>>({});
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => { init(); }, []);

  // Keep a live ref of todos so the recurring timers always see the latest list.
  useEffect(() => { todosRef.current = todos; }, [todos]);

  // Recurring todos — advance each sequence one text at a time, never duplicating.
  useEffect(() => {
    if (!calAuthed || !todosLoaded) return; // wait for Supabase todos so we don't re-add an existing one
    const insert = async (text: string, note: string) => {
      const todo: Todo = { id: uid(), text, completed: false, priority: false, created_at: new Date().toISOString() };
      setTodos(prev => [todo, ...prev]);
      await addTodo(todo);
      log(`Recurring: added "${text}" (${note})`);
    };
    const advance = async (r: Recurring, key: number) => {
      const now = new Date();
      // If any member of the sequence is on the list, it's still active — wait.
      const presentIdx = r.texts.findIndex(it => todosRef.current.some(t => t.text === itemText(it)));

      // Selection mode: members carry their own schedules — insert whichever is due.
      if (r.texts.some(it => typeof it !== "string")) {
        if (presentIdx !== -1) return;
        const due = r.texts.find(it => typeof it !== "string" && isDue(it, now));
        if (due) await insert(itemText(due), `seq ${key} scheduled`);
        return;
      }

      // Sequence mode: one entry-level schedule, advance by index after each pop.
      if (!isDue(r, now)) return;
      const s = seqState.current[key] ?? (seqState.current[key] = { idx: 0, placed: false });
      if (presentIdx !== -1) { s.idx = presentIdx; s.placed = true; return; } // resync after restart
      if (s.placed) s.idx = (s.idx + 1) % r.texts.length; // previous was popped — move to next
      s.placed = true;
      await insert(itemText(r.texts[s.idx]), `seq ${key} idx ${s.idx}`);
    };
    const timers = RECURRING.map((r, key) => {
      advance(r, key); // check immediately on mount
      return setInterval(() => advance(r, key), r.intervalMs ?? 60000);
    });
    return () => timers.forEach(clearInterval);
  }, [calAuthed, todosLoaded]);

  // Live bus arrivals for any "Gym"/"gym" task — fetched fresh while one is on
  // the list and refreshed each minute so the times stay current (display only;
  // never stored on the todo).
  const hasGym = todos.some(t => isGymText(t.text));
  useEffect(() => {
    if (!hasGym) { setBusTimes([]); return; }
    let active = true;
    const refresh = async () => {
      try {
        const arrivals = await nextBusArrivals("43", "17847", 3);
        if (active) setBusTimes(arrivals);
      } catch (e: any) {
        log(`bus arrivals fetch failed: ${e?.message || JSON.stringify(e)}`);
      }
    };
    refresh();
    const iv = setInterval(refresh, 60000);
    return () => { active = false; clearInterval(iv); };
  }, [hasGym]);

  const init = async () => {
    if (isTauri) {
      try {
        accessToken = await invoke<string>("try_refresh");
        log(`Auto-login with stored token=${accessToken.slice(0, 8)}...`);
        setCalAuthed(true);
        setTodos(await getTodos()); setTodosLoaded(true);
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
      setTodos(await getTodos()); setTodosLoaded(true);
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
      setTodos(await getTodos()); setTodosLoaded(true);
      setSessions(await getSessions());
      await loadCal();
    } catch (e: any) {
      log(`authAndLoadCal error: ${JSON.stringify(e)}`);
      setAuthLoading(false);
      setCalLoading(false);
      const msg = typeof e === "string" ? e : e?.message || JSON.stringify(e);
      setAuthError(msg || "Failed to connect. Check your internet and try again.");
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

  const unlockAudio = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
  };

  const playBell = () => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      const doPlay = () => {
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
      };
      if (ctx.state === "suspended") {
        ctx.resume().then(doPlay);
      } else {
        doPlay();
      }
    } catch (e) {
      log(`playBell error: ${e}`);
    }
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
            invoke("focus_window").catch(e => log(`focus error: ${e}`));
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

  const start = () => { unlockAudio(); if (!startedAt.current) startedAt.current = new Date().toISOString(); setFinished(false); bellPlayedAt.current = null; setRunning(true); };
  const pause = () => setRunning(false);
  const addTime = () => { setSeconds(10 * 60); setFinished(false); bellPlayedAt.current = null; setRunning(true); };
  const reset = () => { if (ivRef.current) clearInterval(ivRef.current); setRunning(false); setIsBreak(false); setSeconds(duration * 60); setFinished(false); bellPlayedAt.current = null; startedAt.current = null; };
  const changeDur = (v: number) => { if (!running) { setDuration(v); if (!isBreak) setSeconds(v * 60); } };
  const toggleMode = () => {
    if (running) return; // don't switch mid-countdown
    setFinished(false); bellPlayedAt.current = null; startedAt.current = null;
    setIsBreak(b => { const next = !b; setSeconds((next ? BREAK : duration) * 60); return next; });
  };

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

  // Log/unlog a past calendar event as a Pomodoro session (id links the two).
  const sessionIdForEvent = (e: CalEvent) => `cal-${e.id}`;
  const addEventSession = async (e: CalEvent) => {
    const id = sessionIdForEvent(e);
    if (sessions.some(s => s.id === id)) return;
    const mins = Math.round((new Date(e.endIso).getTime() - new Date(e.startIso).getTime()) / 60000);
    const row: Session = { id, started_at: e.startIso, duration_minutes: mins, completed: true };
    setSessions(prev => [row, ...prev]);
    await addSession(row);
  };
  const removeEventSession = async (e: CalEvent) => {
    const id = sessionIdForEvent(e);
    setSessions(prev => prev.filter(s => s.id !== id));
    await deleteSession(id);
  };

  const now = new Date();
  const todayStr = now.toDateString();
  const upcomingCal = calEvents.filter(e => !e.allDay && new Date(e.endIso) >= now);
  const pastCal = calEvents.filter(e => !e.allDay && new Date(e.endIso) < now);
  const calFocusMins = pastCal.reduce((a, e) => a + Math.round((new Date(e.endIso).getTime() - new Date(e.startIso).getTime()) / 60000), 0);
  const todaySessions = sessions.filter(s => new Date(s.started_at).toDateString() === todayStr);
  const pomodoroMins = todaySessions.reduce((a, s) => a + s.duration_minutes, 0);
  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return { label: d.toLocaleDateString("en", { weekday: "short" }), date: d.toDateString() }; });
  const weekData = weekDays.map(d => ({ ...d, mins: sessions.filter(s => new Date(s.started_at).toDateString() === d.date).reduce((a, s) => a + s.duration_minutes, 0) }));
  const maxMins = Math.max(...weekData.map(d => d.mins), 1);
  const pct = ((isBreak ? BREAK * 60 : duration * 60) - seconds) / (isBreak ? BREAK * 60 : duration * 60);
  const r = 90, circ = 2 * Math.PI * r;
  const sortedTodos = [...todos].sort((a, b) => Number(b.priority) - Number(a.priority));

  if (!calAuthed) {
    return (
      <div style={{ minHeight: "100vh", background: "#ffffff", color: "#1a1a2e", fontFamily: "system-ui,sans-serif", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", maxWidth: 360 }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>🍅</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#1a1a2e", marginBottom: 8 }}>Pomodoro + Today</div>
          <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 32 }}>Connect your Google Calendar to get started</div>
          <button onClick={authAndLoadCal} disabled={authLoading} style={{ padding: "14px 32px", background: authLoading ? "#a5a3f0" : Purple, color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, fontSize: 16, cursor: authLoading ? "wait" : "pointer" }}>
            {authLoading ? "Connecting..." : "Connect Google Calendar"}
          </button>
          {authError && <div style={{ marginTop: 16, color: "#dc2626", fontSize: 13 }}>{authError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#ffffff", color: "#1a1a2e", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ background: "#fafafb", borderBottom: `1px solid ${Border}`, padding: "12px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 20 }}>🍅</span>
        <span style={{ fontWeight: 700, fontSize: 18, color: "#1a1a2e" }}>Pomodoro + Today</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {["timer", "analytics"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: tab === t ? Purple : "#e8e8ee", color: tab === t ? "#fff" : "#6b7280", fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>{t}</button>
          ))}
        </div>
      </div>

      {tab === "timer" && (
        <div style={{ display: "flex", flex: 1 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "32px 24px", borderRight: `1px solid ${Border}` }}>
            <div onClick={toggleMode} title={running ? "Pause to switch Focus / Break" : "Click to switch Focus / Break"} style={{ background: isBreak ? "#dcfce7" : "#ede9fe", borderRadius: 16, padding: "8px 20px", marginBottom: 24, fontSize: 13, fontWeight: 600, color: isBreak ? "#16a34a" : "#7c3aed", cursor: running ? "default" : "pointer", userSelect: "none" }}>
              {isBreak ? "☕ Break Time" : "🎯 Focus Session"}
            </div>
            <div style={{ position: "relative", marginBottom: 24 }}>
              <svg width={220} height={220} style={{ transform: "rotate(-90deg)" }}>
                <circle cx={110} cy={110} r={r} fill="none" stroke={Border} strokeWidth={10} />
                <circle cx={110} cy={110} r={r} fill="none" stroke={isBreak ? "#16a34a" : Purple} strokeWidth={10}
                  strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round"
                  style={{ transition: "stroke-dashoffset 1s linear" }} />
              </svg>
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 42, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: finished ? "#dc2626" : "#1a1a2e" }}>
                  {fmt(seconds)}
                </span>
                {finished && <span style={{ fontSize: 11, color: "#dc2626", marginTop: 2, fontWeight: 600, letterSpacing: 1 }}>TIME'S UP</span>}
              </div>
            </div>
            {!isBreak && (
              <div style={{ width: "100%", maxWidth: 260, marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
                  <span>Duration</span><span style={{ color: "#7c3aed", fontWeight: 600 }}>{duration} min</span>
                </div>
                <input type="range" min={20} max={60} value={duration} onChange={e => changeDur(+e.target.value)} disabled={running} style={{ width: "100%", accentColor: Purple }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9ca3af" }}><span>20</span><span>60</span></div>
              </div>
            )}
            <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
              {finished ? <>
                <button onClick={addTime} style={{ padding: "10px 28px", background: "#fef9c3", color: "#854d0e", border: "1px solid #fde68a", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>+10 min</button>
                <button onClick={handleComplete} style={{ padding: "10px 28px", background: Purple, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Done</button>
              </> : !running
                ? <button onClick={start} style={{ padding: "10px 28px", background: Purple, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>▶ Start</button>
                : <button onClick={pause} style={{ padding: "10px 28px", background: "#e8e8ee", color: "#1a1a2e", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>⏸ Pause</button>
              }
              <button onClick={reset} style={{ padding: "10px 16px", background: "#e8e8ee", color: "#6b7280", border: "none", borderRadius: 10, fontSize: 15, cursor: "pointer" }}>↺</button>
              <button onClick={async () => {
                setSaving(true); setSaveMsg("");
                const ok = await saveSession(duration, startedAt.current);
                setSaving(false); setSaveMsg(ok ? "✓ Saved!" : "Need 10+ min");
                setTimeout(() => setSaveMsg(""), 3000);
              }} disabled={saving} style={{ padding: "10px 16px", background: "#dcfce7", color: "#16a34a", border: "1px solid #bbf7d0", borderRadius: 10, fontSize: 13, cursor: "pointer", fontWeight: 600 }}>
                {saving ? "Saving…" : "💾 Save"}
              </button>
            </div>
            {saveMsg && <div style={{ fontSize: 12, color: saveMsg.includes("Need") ? "#dc2626" : "#16a34a", marginBottom: 8 }}>{saveMsg}</div>}
            <div style={{ display: "flex", gap: 16, margin: "16px 0" }}>
              {[{ label: "🍅 Pomodoros", val: `${todaySessions.length}/6` }, { label: "⏱ Focus Today", val: `${Math.floor(pomodoroMins / 60)}h${pomodoroMins % 60}m` }].map(s => (
                <div key={s.label} style={{ background: Card, borderRadius: 10, padding: "10px 18px", textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#7c3aed" }}>{s.val}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{ width: "100%", maxWidth: 320 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#6b7280", marginBottom: 8 }}>Recent Sessions</div>
              <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {todaySessions.slice(0, 6).map(s => (
                  <div key={s.id} style={{ background: Card, borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                    🍅 {s.duration_minutes}m — {fmtTime(s.started_at)}
                  </div>
                ))}
                {todaySessions.length === 0 && <div style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: 12 }}>No sessions yet</div>}
              </div>
            </div>
          </div>

          <div style={{ width: 340, display: "flex", flexDirection: "column", padding: "24px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a2e" }}>📅 Today's List</div>
              <button onClick={loadCal} style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 14 }}>🔄</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input value={todoInput} onChange={e => setTodoInput(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAddTodo()}
                placeholder="Add a task..." style={{ flex: 1, background: Card, border: `1px solid ${Border}`, borderRadius: 8, padding: "8px 12px", color: "#1a1a2e", fontSize: 13, outline: "none" }} />
              <button onClick={handleAddTodo} style={{ background: Purple, color: "#fff", border: "none", borderRadius: 8, padding: "8px 12px", cursor: "pointer", fontWeight: 700 }}>+</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
              {calLoading && <div style={{ color: "#9ca3af", fontSize: 12, textAlign: "center", padding: 8 }}>Loading calendar…</div>}
              {!calLoading && upcomingCal.length > 0 && <>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Upcoming Events</div>
                {upcomingCal.map(e => (
                  <div key={e.id} style={{ background: "#ede9fe", border: "1px solid #ddd6fe", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                    <span>📆</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: "#5b21b6", fontWeight: 600 }}>{e.summary}</div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>{fmtTime(e.startIso)} – {fmtTime(e.endIso)}</div>
                    </div>
                  </div>
                ))}
              </>}
              {!calLoading && pastCal.length > 0 && <>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, marginTop: 8 }}>
                  Past Events <span style={{ color: "#16a34a" }}>+{calFocusMins}m focus</span>
                </div>
                {pastCal.map(e => {
                  const logged = sessions.some(s => s.id === sessionIdForEvent(e));
                  return (
                  <div key={e.id} style={{ background: logged ? "#dcfce7" : Card, borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, opacity: logged ? 1 : 0.6 }}>
                    <span>✅</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: "#6b7280", textDecoration: "line-through" }}>{e.summary}</div>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{fmtTime(e.startIso)} – {fmtTime(e.endIso)}</div>
                    </div>
                    <button onClick={() => addEventSession(e)} disabled={logged} title="Log as session" style={{ width: 24, height: 24, borderRadius: 6, border: `1px solid ${Border}`, background: logged ? "#e8e8ee" : "#fff", color: logged ? "#c4c4cc" : "#16a34a", cursor: logged ? "default" : "pointer", fontSize: 15, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>+</button>
                    <button onClick={() => removeEventSession(e)} disabled={!logged} title="Remove session" style={{ width: 24, height: 24, borderRadius: 6, border: `1px solid ${Border}`, background: !logged ? "#e8e8ee" : "#fff", color: !logged ? "#c4c4cc" : "#dc2626", cursor: !logged ? "default" : "pointer", fontSize: 15, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>−</button>
                  </div>
                  );
                })}
              </>}
              {sortedTodos.length > 0 && <>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, marginTop: 8 }}>Tasks</div>
                {sortedTodos.map(t => (
                  <div key={t.id} style={{ background: Card, borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, opacity: t.completed ? 0.6 : 1, border: t.priority ? "1px solid #bbf7d0" : "1px solid transparent" }}>
                    <button onClick={() => toggleTodo(t)} style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${t.completed ? Purple : "#d1d5db"}`, background: t.completed ? Purple : "transparent", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11 }}>
                      {t.completed ? "✓" : ""}
                    </button>
                    <span style={{ flex: 1, fontSize: 13, textDecoration: t.completed ? "line-through" : "none", color: t.completed ? "#9ca3af" : "#1a1a2e" }}>
                      {t.text}
                      {isGymText(t.text) && busTimes.length > 0 && (
                        <span style={{ color: Purple, fontWeight: 600 }}> ({busTimes.join(",")})</span>
                      )}
                    </span>
                    <button onClick={() => togglePriority(t)} style={{ background: t.priority ? "#dcfce7" : "none", border: t.priority ? "1px solid #bbf7d0" : `1px solid ${Border}`, borderRadius: 6, color: t.priority ? "#16a34a" : "#9ca3af", cursor: "pointer", fontSize: 10, fontWeight: 700, padding: "2px 6px", flexShrink: 0 }}>
                      {t.priority ? "● Priority" : "+ Priority"}
                    </button>
                    <button onClick={() => handleDelTodo(t.id)} style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 14, padding: 0 }}>✕</button>
                  </div>
                ))}
              </>}
              {!calLoading && calEvents.length === 0 && todos.length === 0 && (
                <div style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: 20 }}>No events or tasks for today</div>
              )}
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: "#9ca3af", textAlign: "right" }}>
              {todos.filter(t => t.completed).length}/{todos.length} tasks done
            </div>
          </div>
        </div>
      )}

      {tab === "analytics" && (
        <div style={{ padding: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 24, color: "#1a1a2e" }}>📊 Weekly Analytics</div>
          <div style={{ display: "flex", gap: 16, marginBottom: 32 }}>
            {[{ label: "Total Sessions", val: sessions.length }, { label: "Pomodoro Mins", val: pomodoroMins }, { label: "Cal Focus Mins", val: calFocusMins }, { label: "Tasks Done", val: todos.filter(t => t.completed).length }].map(s => (
              <div key={s.label} style={{ flex: 1, background: Card, borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: "#7c3aed" }}>{s.val}</div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>
          <div style={{ background: Card, borderRadius: 12, padding: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#4b5563", marginBottom: 20 }}>Pomodoro Minutes — Last 7 Days</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 140 }}>
              {weekData.map(d => (
                <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{d.mins > 0 ? d.mins : ""}</div>
                  <div style={{ width: "100%", background: d.date === todayStr ? Purple : "#e2e2e8", borderRadius: "4px 4px 0 0", height: `${Math.max((d.mins / maxMins) * 100, d.mins > 0 ? 4 : 0)}px`, transition: "height 0.4s" }} />
                  <div style={{ fontSize: 11, color: d.date === todayStr ? "#7c3aed" : "#6b7280", fontWeight: d.date === todayStr ? 700 : 400 }}>{d.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

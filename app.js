(function () {
  "use strict";

  const SEED_VERSION = window.SEED_VERSION;
  const DONE_COUNTERS = window.DONE_COUNTERS || {};
  const config = window.SOP_CONFIG || {};

  // Flatten SEED_TASKS into rows: { employee, title, position }.
  function seedRows() {
    const rows = [];
    for (const employee of window.EMPLOYEES) {
      (window.SEED_TASKS[employee] || []).forEach((title, i) => {
        rows.push({ employee, title, position: i });
      });
    }
    return rows;
  }

  // Status is derived from a day's entry, never stored by the UI.
  function statusOf(entry) {
    if (entry.end_time) return "done";
    if (entry.start_time) return "in_progress";
    return "todo";
  }

  const STATUS_LABEL = { todo: "To Do", in_progress: "In Progress", done: "Done" };
  const EMPTY_ENTRY = Object.freeze({ start_time: null, end_time: null, quantity: null });
  const OVERVIEW = "\u0000overview";
  const TEAM = "\u0000team";

  function toMinutes(t) {
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  }

  function nowMinutes() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  // Minutes from start to end, or to now while a task for today is running.
  // An end "earlier" than the start is treated as running past midnight.
  // Returns null when there is nothing to measure.
  function minutesTaken(entry, isToday) {
    const start = toMinutes(entry.start_time);
    if (start === null) return null;
    let end = toMinutes(entry.end_time);
    if (end === null) {
      if (!isToday) return null;
      end = nowMinutes();
    }
    let diff = end - start;
    if (diff < 0) diff += 24 * 60;
    return diff;
  }

  function formatDuration(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return m + "m";
    return m ? h + "h " + m + "m" : h + "h";
  }

  // "14:05:00" -> "2:05 PM"
  function formatClock(t) {
    const [h, m] = t.split(":").map(Number);
    return ((h + 11) % 12) + 1 + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM");
  }

  function capitalize(s) {
    return s.replace(/^./, (c) => c.toUpperCase());
  }

  function initials(name) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0] || "")[0] + ((parts[1] || "")[0] || "")).toUpperCase();
  }

  // A stable colour per person, for their avatar.
  function avatarHue(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  function paintAvatar(node, name, isAdmin) {
    node.textContent = isAdmin ? "★" : initials(name);
    node.style.setProperty("--avatar-hue", isAdmin ? 220 : avatarHue(name));
    node.classList.toggle("avatar-admin", Boolean(isAdmin));
  }

  const ICONS = {
    up: '<path d="M12 6l-6 6h4v6h4v-6h4z"/>',
    down: '<path d="M12 18l6-6h-4V6h-4v6H6z"/>',
    copy: '<path d="M8 3h11a2 2 0 0 1 2 2v11h-2V5H8V3zm-3 4h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v10h10V9H5z"/>',
    trash: '<path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/>',
  };

  function iconButton(icon, label, className, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">' + ICONS[icon] + "</svg>";
    btn.addEventListener("click", onClick);
    return btn;
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function nowHHMM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // Local calendar date as "YYYY-MM-DD" (toISOString would give the UTC date).
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function parseYmd(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(s, n) {
    const d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function shortDate(s) {
    return parseYmd(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function apiError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // -------------------------------------------------------------------------
  // Data stores. Both expose the same interface:
  //   getSession()                    -> { site_ok, user: {role, name} | null, users: [{name, has_password}] }
  //   siteLogin(password), userLogin(name, password), switchUser(), logout()
  //   init()                          -> admin: apply seed version
  //   listTasks(), listEntries(date), listNotes(date)   (employees get only their own)
  //   listWorkDates(employee, from, to)
  //   insertTask({employee, title}), removeTask(id)     (admin)
  //   duplicateTask(id), setPositions([{id, position}])
  //   saveEntry(taskId, date, {start_time, end_time, quantity})
  //   saveNote(employee, date, body)
  //   listUsers(), addUser(name, password), setUserPassword(name, password), removeUser(name)   (admin)
  //   report(from, to)                -> { rows: [{employee, work_date, tasks_started, tasks_done, minutes, quantity}] }
  //   subscribe(onChange)             -> called when data may have changed elsewhere
  //
  // Start and end times are write-once: once saved they are never changed.
  // -------------------------------------------------------------------------

  // PHP + MySQL API in api/index.php (for regular web hosting such as
  // Hostinger). The server enforces who may see and change what.
  function createPhpStore(apiUrl) {
    async function call(action, params) {
      let res;
      try {
        res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...params }),
          cache: "no-store",
          credentials: "same-origin",
        });
      } catch (e) {
        throw new Error("Can't reach the server. Check your internet connection.");
      }
      let body = null;
      try {
        body = await res.json();
      } catch (e) {
        /* not JSON: PHP missing or a server error page */
      }
      if (!res.ok || !body || body.error) {
        throw apiError((body && body.error) || "The server returned an error (" + res.status + ").", body && body.code);
      }
      return body.data;
    }

    return {
      mode: "php",
      getSession: () => call("session"),
      siteLogin: (password) => call("siteLogin", { password }),
      userLogin: (name, password) => call("userLogin", { name, password }),
      switchUser: () => call("switchUser"),
      logout: () => call("logout"),
      init: () => call("init", { version: SEED_VERSION, tasks: seedRows(), employees: window.EMPLOYEES }),
      listTasks: () => call("listTasks"),
      listEntries: (date) => call("listEntries", { date }),
      insertTask: (row) => call("insertTask", row),
      duplicateTask: (id) => call("duplicateTask", { id }),
      removeTask: (id) => call("removeTask", { id }),
      setPositions: (updates) => call("setPositions", { updates }),
      saveEntry: (taskId, date, times) => call("saveEntry", { task_id: taskId, date, ...times }),
      listWorkDates: (employee, from, to) => call("listWorkDates", { employee, from, to }),
      listNotes: (date) => call("listNotes", { date }),
      saveNote: (employee, date, body) => call("saveNote", { employee, date, body }),
      listUsers: () => call("listUsers"),
      addUser: (name, password) => call("addUser", { name, password }),
      setUserPassword: (name, password) => call("setUserPassword", { name, password }),
      removeUser: (name) => call("removeUser", { name }),
      report: (from, to) => call("report", { from, to }),
      subscribe(onChange) {
        // Check for changes every 15 seconds while the page is visible, and
        // straight away when someone comes back to the tab.
        setInterval(() => {
          if (document.visibilityState === "visible") onChange();
        }, 15 * 1000);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") onChange();
        });
      },
    };
  }

  // Data lives in this browser only (for previewing the dashboard). It follows
  // the same sign-in steps with demo passwords, but it is not secure.
  const DEMO = { site: "demo", admin: "admin", employee: "1234" };

  function createLocalStore() {
    const KEY = "sop-dashboard:v3";

    function load() {
      try {
        const s = JSON.parse(localStorage.getItem(KEY));
        if (s && Array.isArray(s.tasks) && s.entries) return { notes: {}, users: [], session: {}, ...s };
      } catch (e) {}
      return { seedVersion: 0, tasks: [], entries: {}, notes: {}, users: [], session: {} };
    }
    function save() {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        /* storage unavailable: changes last for this page view only */
      }
    }
    function newId() {
      return window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
    let state = load();

    function seed() {
      if (state.seedVersion >= SEED_VERSION) return;
      const rows = seedRows();
      const inSeed = (t) => rows.some((s) => s.employee === t.employee && s.title === t.title);
      const removed = state.tasks.filter((t) => t.from_seed && !inSeed(t)).map((t) => t.id);
      state.tasks = state.tasks.filter((t) => !removed.includes(t.id));
      for (const date of Object.keys(state.entries)) removed.forEach((id) => delete state.entries[date][id]);
      for (const s of rows) {
        const existing = state.tasks.find((t) => t.employee === s.employee && t.title === s.title);
        if (existing) Object.assign(existing, { position: s.position, from_seed: true });
        else state.tasks.push({ ...s, id: newId(), from_seed: true, created_at: new Date().toISOString() });
      }
      window.EMPLOYEES.forEach((name, i) => {
        if (!state.users.some((u) => u.name === name)) state.users.push({ name, password: DEMO.employee, active: true, position: i });
      });
      state.seedVersion = SEED_VERSION;
      save();
    }
    seed();

    const me = () => state.session || {};
    const isAdmin = () => me().role === "admin";
    const activeUsers = () => state.users.filter((u) => u.active).sort((a, b) => a.position - b.position);
    const publicUsers = () => activeUsers().map((u) => ({ name: u.name, has_password: Boolean(u.password), active: true }));
    function payload() {
      const s = me();
      return {
        site_ok: Boolean(s.site_ok),
        user: s.site_ok && s.role ? { role: s.role, name: s.role === "admin" ? "Admin" : s.name } : null,
        users: s.site_ok ? publicUsers() : [],
      };
    }
    function requireUser() {
      if (!me().site_ok) throw apiError("Please sign in.", "site_login");
      if (!me().role) throw apiError("Please choose who you are.", "user_login");
    }
    function requireAdmin() {
      requireUser();
      if (!isAdmin()) throw apiError("Only the admin can do that.");
    }
    function ownTask(id) {
      requireUser();
      const t = state.tasks.find((x) => x.id === id);
      if (!t) throw apiError("That task no longer exists.");
      if (!isAdmin() && t.employee !== me().name) throw apiError("That task belongs to someone else.");
      return t;
    }
    const visibleTasks = () => (isAdmin() ? state.tasks : state.tasks.filter((t) => t.employee === me().name));
    const sorted = (list) =>
      list.slice().sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));

    return {
      mode: "local",
      async getSession() {
        return payload();
      },
      async siteLogin(password) {
        if (password !== DEMO.site) throw apiError("Wrong password.", "wrong_password");
        state.session = { site_ok: true };
        save();
        return payload();
      },
      async userLogin(name, password) {
        if (!me().site_ok) throw apiError("Enter the dashboard password first.", "site_login");
        if (name.toLowerCase() === "admin") {
          if (password !== DEMO.admin) throw apiError("Wrong password.", "wrong_password");
          state.session = { site_ok: true, role: "admin" };
        } else {
          const u = activeUsers().find((x) => x.name === name);
          if (!u) throw apiError("That person is no longer on the team.");
          if (!u.password) throw apiError("No password has been set for " + name + " yet. Ask the admin to set one.");
          if (password !== u.password) throw apiError("Wrong password.", "wrong_password");
          state.session = { site_ok: true, role: "employee", name };
        }
        save();
        return payload();
      },
      async switchUser() {
        state.session = { site_ok: Boolean(me().site_ok) };
        save();
        return payload();
      },
      async logout() {
        state.session = {};
        save();
        return payload();
      },
      async init() {
        requireAdmin();
      },
      async listTasks() {
        requireUser();
        return sorted(visibleTasks());
      },
      async listEntries(date) {
        requireUser();
        const ids = new Set(visibleTasks().map((t) => t.id));
        const day = state.entries[date] || {};
        return Object.keys(day)
          .filter((id) => ids.has(id))
          .map((taskId) => ({ task_id: taskId, ...day[taskId] }));
      },
      async insertTask(row) {
        requireAdmin();
        if (!activeUsers().some((u) => u.name === row.employee)) throw apiError("Choose someone on the team to assign this task to.");
        const mine = state.tasks.filter((t) => t.employee === row.employee);
        const position = mine.length ? Math.max(...mine.map((t) => t.position)) + 1 : 0;
        state.tasks.push({ employee: row.employee, title: row.title, position, id: newId(), from_seed: false, created_at: new Date().toISOString() });
        save();
      },
      async duplicateTask(id) {
        const t = ownTask(id);
        const list = sorted(state.tasks.filter((x) => x.employee === t.employee));
        const base = t.title.replace(/ \(\d+\)$/, "");
        let max = 1;
        for (const x of list) {
          const m = x.title.startsWith(base + " (") && x.title.slice(base.length).match(/^ \((\d+)\)$/);
          if (m) max = Math.max(max, Number(m[1]));
        }
        const copy = { employee: t.employee, title: base + " (" + (max + 1) + ")", id: newId(), from_seed: false, created_at: new Date().toISOString() };
        let pos = 0;
        for (const x of list) {
          x.position = pos++;
          if (x.id === t.id) copy.position = pos++;
        }
        state.tasks.push(copy);
        save();
      },
      async removeTask(id) {
        requireAdmin();
        state.tasks = state.tasks.filter((t) => t.id !== id);
        for (const date of Object.keys(state.entries)) delete state.entries[date][id];
        save();
      },
      async setPositions(updates) {
        for (const u of updates) ownTask(u.id).position = u.position;
        save();
      },
      async saveEntry(taskId, date, times) {
        ownTask(taskId);
        state.entries[date] = state.entries[date] || {};
        const old = state.entries[date][taskId] || {};
        // Write-once times, as on the server.
        state.entries[date][taskId] = {
          ...times,
          start_time: old.start_time || times.start_time || null,
          end_time: old.end_time || times.end_time || null,
        };
        save();
      },
      async listWorkDates(employee, from, to) {
        requireUser();
        const who = isAdmin() ? employee : me().name;
        const ids = new Set(state.tasks.filter((t) => t.employee === who).map((t) => t.id));
        return Object.keys(state.entries).filter(
          (date) => date >= from && date <= to && Object.entries(state.entries[date]).some(([id, e]) => ids.has(id) && e.start_time)
        );
      },
      async listNotes(date) {
        requireUser();
        const day = state.notes[date] || {};
        return Object.keys(day)
          .filter((employee) => isAdmin() || employee === me().name)
          .map((employee) => ({ employee, body: day[employee] }));
      },
      async saveNote(employee, date, body) {
        requireUser();
        if (!isAdmin() && employee !== me().name) throw apiError("You can only write your own notes.");
        state.notes[date] = state.notes[date] || {};
        state.notes[date][employee] = body;
        save();
      },
      async listUsers() {
        requireAdmin();
        return publicUsers();
      },
      async addUser(name, password) {
        requireAdmin();
        if (name.toLowerCase() === "admin") throw apiError('"Admin" is reserved. Choose another name.');
        const u = state.users.find((x) => x.name === name);
        if (u && u.active) throw apiError(name + " is already on the team.");
        const position = state.users.length ? Math.max(...state.users.map((x) => x.position)) + 1 : 0;
        if (u) Object.assign(u, { active: true, position, password: password || u.password });
        else state.users.push({ name, password: password || null, active: true, position });
        save();
        return publicUsers();
      },
      async setUserPassword(name, password) {
        requireAdmin();
        if (password.length < 4) throw apiError("Use a password of at least 4 characters.");
        const u = activeUsers().find((x) => x.name === name);
        if (u) u.password = password;
        save();
        return publicUsers();
      },
      async removeUser(name) {
        requireAdmin();
        const u = state.users.find((x) => x.name === name);
        if (u) u.active = false;
        save();
        return publicUsers();
      },
      async report(from, to) {
        requireAdmin();
        const rows = [];
        for (const date of Object.keys(state.entries).sort()) {
          if (date < from || date > to) continue;
          const byEmp = {};
          for (const [id, e] of Object.entries(state.entries[date])) {
            const t = state.tasks.find((x) => x.id === id);
            if (!t || (!e.start_time && !(e.quantity > 0))) continue;
            const r = (byEmp[t.employee] = byEmp[t.employee] || { employee: t.employee, work_date: date, tasks_started: 0, tasks_done: 0, minutes: 0, quantity: 0 });
            if (e.start_time) r.tasks_started++;
            if (e.end_time) {
              r.tasks_done++;
              r.minutes += minutesTaken(e, false);
            }
            r.quantity += e.quantity || 0;
          }
          rows.push(...Object.values(byEmp));
        }
        return { from, to, rows };
      },
      subscribe(onChange) {
        window.addEventListener("storage", (e) => {
          if (e.key === KEY) {
            state = load();
            onChange();
          }
        });
      },
    };
  }

  function createStore() {
    if (config.backend === "php") return createPhpStore(config.apiUrl || "api/index.php");
    return createLocalStore();
  }

  let store; // set in start()

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $("app"),
    auth: $("auth"),
    authSite: $("auth-site"),
    authPeople: $("auth-people"),
    authUser: $("auth-user"),
    sitePassword: $("site-password"),
    siteError: $("site-error"),
    people: $("people"),
    authLock: $("auth-lock"),
    authBack: $("auth-back"),
    authAvatar: $("auth-avatar"),
    authUserTitle: $("auth-user-title"),
    userPassword: $("user-password"),
    userError: $("user-error"),
    userAvatar: $("user-avatar"),
    userName: $("user-name"),
    userRole: $("user-role"),
    switchUser: $("switch-user"),
    lock: $("lock"),
    pageTitle: $("page-title"),
    tabs: $("tabs"),
    overview: $("overview"),
    ovDate: $("ov-date"),
    ovTotals: $("ov-totals"),
    ovCards: $("ov-cards"),
    assignForm: $("assign-form"),
    assignTitle: $("assign-title"),
    assignTo: $("assign-to"),
    repPreset: $("rep-preset"),
    repFrom: $("rep-from"),
    repTo: $("rep-to"),
    repHead: $("rep-head"),
    repBody: $("rep-body"),
    repFoot: $("rep-foot"),
    repEmpty: $("rep-empty"),
    repCsv: $("rep-csv"),
    team: $("team"),
    teamList: $("team-list"),
    addUserForm: $("add-user-form"),
    newUserName: $("new-user-name"),
    newUserPassword: $("new-user-password"),
    tasksPanel: $("tasks-panel"),
    notesPanel: $("notes-panel"),
    summary: $("summary"),
    spotlight: $("spotlight"),
    rows: $("task-rows"),
    empty: $("empty"),
    addForm: $("add-form"),
    addInput: $("add-input"),
    banner: $("banner"),
    toast: $("toast"),
    today: $("today"),
    todayDay: $("today-day"),
    todayWeekday: $("today-weekday"),
    todayMonth: $("today-month"),
    dateButton: $("date-button"),
    calendar: $("calendar"),
    notesTitle: $("notes-title"),
    notesInput: $("notes-input"),
    notesStatus: $("notes-status"),
    datePrev: $("date-prev"),
    dateNext: $("date-next"),
    dateToday: $("date-today"),
    dateNote: $("date-note"),
    doneCounter: $("done-counter"),
    qtyHead: $("qty-head"),
  };

  let me = null; // { role: "admin" | "employee", name }
  let employees = []; // names of the people whose tasks this person can see
  let teamUsers = []; // admin: [{ name, has_password }]
  let tasks = [];
  let entries = new Map(); // task_id -> { start_time, end_time, quantity } for selectedDate
  let active = null; // an employee name, OVERVIEW or TEAM
  let todayStr = ymd(new Date());
  let selectedDate = todayStr;
  let renderPending = false;
  let notes = new Map(); // employee -> note text for selectedDate
  let subscribed = false;

  const isAdmin = () => Boolean(me && me.role === "admin");
  const isPersonTab = () => active !== OVERVIEW && active !== TEAM;

  function isToday() {
    return selectedDate === todayStr;
  }

  function entryFor(taskId) {
    return entries.get(taskId) || EMPTY_ENTRY;
  }

  function tabKey() {
    return "sop-dashboard:tab:" + (me ? me.role + ":" + me.name : "");
  }

  function defaultTab() {
    if (!isAdmin()) return employees[0];
    try {
      const saved = localStorage.getItem(tabKey());
      if (saved === OVERVIEW || saved === TEAM || employees.includes(saved)) return saved;
    } catch (e) {}
    return OVERVIEW;
  }

  function setActiveTab(name) {
    flushNote();
    active = name;
    try {
      localStorage.setItem(tabKey(), name);
    } catch (e) {}
    if (calendarOpen) toggleCalendar(false);
    render();
    if (active === OVERVIEW) loadReport();
    if (active === TEAM) loadTeam();
  }

  function setDate(date) {
    if (!date || date === selectedDate) return;
    if (date > todayStr) date = todayStr; // nothing to see in the future
    flushNote();
    selectedDate = date;
    entries = new Map();
    notes = new Map();
    render();
    refresh();
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.toggle("toast-error", /^(Couldn't|Can't)/.test(msg));
    el.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => (el.toast.hidden = true), 4000);
  }

  function showBanner(text, isError) {
    el.banner.textContent = text;
    el.banner.classList.toggle("banner-error", Boolean(isError));
    el.banner.hidden = false;
  }

  // The server says this browser is no longer signed in (e.g. the admin
  // changed someone's password): go back to the sign-in screen.
  function handleAuthError(e) {
    if (e && (e.code === "site_login" || e.code === "user_login")) {
      reloadSession();
      return true;
    }
    return false;
  }

  async function refresh() {
    if (!me) return;
    const date = selectedDate;
    let t, e, n;
    try {
      [t, e, n] = await Promise.all([store.listTasks(), store.listEntries(date), store.listNotes(date)]);
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't load tasks: " + err.message);
      return;
    }
    if (date !== selectedDate || !me) return; // changed while loading
    tasks = t;
    entries = new Map(
      e.map((x) => [x.task_id, { start_time: x.start_time, end_time: x.end_time, quantity: x.quantity ?? null }])
    );
    notes = new Map(n.map((x) => [x.employee, x.body || ""]));
    render();
    if (calendarOpen) loadCalendarDots();
  }

  // Coalesce bursts of change notifications into one reload.
  let refreshTimer;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  // Apply a change locally right away, then persist; reload on failure.
  async function mutate(localChange, remoteCall) {
    localChange();
    render();
    try {
      await remoteCall();
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't save: " + e.message);
      refresh();
    }
  }

  function tasksFor(name) {
    return tasks.filter((t) => t.employee === name);
  }

  function countStatuses(list) {
    const c = { todo: 0, in_progress: 0, done: 0 };
    list.forEach((t) => c[statusOf(entryFor(t.id))]++);
    return c;
  }

  function finishedMinutes(list) {
    return list
      .map((t) => entryFor(t.id))
      .filter((e) => e.start_time && e.end_time)
      .reduce((sum, e) => sum + minutesTaken(e, false), 0);
  }

  function quantityTotal(list) {
    return list.reduce((sum, t) => sum + (entryFor(t.id).quantity || 0), 0);
  }

  function renderDate() {
    const d = parseYmd(selectedDate);
    el.todayDay.textContent = d.getDate();
    el.todayWeekday.textContent = d.toLocaleDateString("en-GB", { weekday: "long" });
    el.todayMonth.textContent = d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    el.today.setAttribute("datetime", selectedDate);
    el.dateToday.hidden = isToday();
    el.dateNext.disabled = isToday();
    if (isToday()) {
      el.dateNote.textContent = "Today";
    } else if (selectedDate === addDays(todayStr, -1)) {
      el.dateNote.textContent = "Yesterday";
    } else {
      el.dateNote.textContent = selectedDate < todayStr ? "Past date" : "Upcoming date";
    }
    el.dateNote.classList.toggle("is-other-day", !isToday());
  }

  function renderDoneCounter(list) {
    const noun = isPersonTab() && DONE_COUNTERS[active];
    el.doneCounter.hidden = !noun;
    if (!noun) return;
    const n = h("strong", "", quantityTotal(list));
    const label = h("span", "done-label", noun + " done " + (isToday() ? "today" : "on this day"));
    const sub = h("span", "done-sub", countStatuses(list).done + " / " + list.length + " tasks finished");
    el.doneCounter.replaceChildren(n, label, sub);
  }

  // Big "now working on" card for tasks in progress on the selected day.
  function renderSpotlight(list) {
    const running = list.filter((t) => statusOf(entryFor(t.id)) === "in_progress");
    el.spotlight.hidden = running.length === 0;
    el.spotlight.replaceChildren(
      ...running.map((task) => {
        const entry = entryFor(task.id);
        const item = h("div", "spotlight-item");
        const mins = minutesTaken(entry, isToday());
        item.append(
          h("span", "spotlight-eyebrow", "In Progress"),
          h("strong", "spotlight-title", task.title),
          h(
            "span",
            "spotlight-meta",
            "Started " + formatClock(entry.start_time) + " · " + (mins === null ? "no end time" : formatDuration(mins) + " so far")
          )
        );
        return item;
      })
    );
  }

  function renderTabs() {
    // Employees only ever see their own list, so they get no tabs.
    el.tabs.hidden = !isAdmin();
    if (!isAdmin()) return;
    const tab = (key, label, badge, extraClass) => {
      const btn = h("button", "tab" + (extraClass ? " " + extraClass : ""));
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(key === active));
      btn.append(h("span", "", label));
      if (badge !== undefined) btn.append(h("span", "tab-count", badge));
      btn.addEventListener("click", () => setActiveTab(key));
      return btn;
    };
    el.tabs.replaceChildren(
      tab(OVERVIEW, "Overview", undefined, "tab-admin"),
      ...employees.map((name) => {
        const list = tasksFor(name);
        return tab(name, name, countStatuses(list).done + "/" + list.length);
      }),
      tab(TEAM, "Team", undefined, "tab-admin")
    );
  }

  function renderSummary(list) {
    const c = countStatuses(list);
    const totalChip = h("div", "summary-chip summary-total");
    totalChip.append(h("strong", "", formatDuration(finishedMinutes(list))), h("span", "", "Total Time Taken"));
    el.summary.replaceChildren(
      ...["todo", "in_progress", "done"].map((s) => {
        const chip = h("div", "summary-chip status-" + s);
        chip.append(h("strong", "", c[s]), h("span", "", STATUS_LABEL[s]));
        return chip;
      }),
      totalChip
    );
  }

  // Times can't be typed in. Today, an empty time shows a Start / End button
  // that stamps the current time once; after that the time is locked.
  // Other days are view-only.
  function timeCell(task, entry, field) {
    const td = h("td", "time-cell");
    td.dataset.label = field === "start_time" ? "Start" : "End";
    const wrap = h("div", "time-wrap");

    if (entry[field]) {
      const value = h("span", "time-value", formatClock(entry[field]));
      value.title = "Recorded time (locked)";
      wrap.append(value);
    } else if (isToday()) {
      const isStart = field === "start_time";
      const btn = h("button", "btn-stamp " + (isStart ? "btn-stamp-start" : "btn-stamp-end"), isStart ? "Start" : "End");
      btn.type = "button";
      btn.setAttribute("aria-label", (isStart ? "Start " : "End ") + task.title + " now");
      if (!isStart && !entry.start_time) {
        btn.disabled = true;
        btn.title = "Start the task first";
      }
      btn.addEventListener("click", () => stampTime(task.id, field));
      wrap.append(btn);
    } else {
      wrap.append(h("span", "time-none", "—"));
    }
    td.append(wrap);
    return td;
  }

  // People listed in DONE_COUNTERS get a per-task count column (e.g. videos).
  function countsItems() {
    return isPersonTab() && Boolean(DONE_COUNTERS[active]);
  }

  function quantityCell(task, entry) {
    const td = h("td", "qty-cell");
    td.dataset.label = capitalize(DONE_COUNTERS[active]);
    const wrap = h("div", "qty-wrap");
    const value = entry.quantity || 0;

    if (!isToday()) {
      wrap.append(h("span", "qty-value", value));
      td.append(wrap);
      return td;
    }

    const minus = h("button", "btn-step btn-qty", "−");
    minus.type = "button";
    minus.disabled = value <= 0;
    minus.setAttribute("aria-label", "One less for " + task.title);
    minus.addEventListener("click", () => setQuantity(task.id, value - 1));

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.inputMode = "numeric";
    input.value = entry.quantity === null || entry.quantity === undefined ? "" : entry.quantity;
    input.placeholder = "0";
    input.setAttribute("aria-label", DONE_COUNTERS[active] + " done for " + task.title);
    input.addEventListener("change", () => {
      const n = parseInt(input.value, 10);
      setQuantity(task.id, Number.isFinite(n) && n > 0 ? n : null);
    });

    const plus = h("button", "btn-step btn-qty", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", "One more for " + task.title);
    plus.addEventListener("click", () => setQuantity(task.id, value + 1));

    wrap.append(minus, input, plus);
    td.append(wrap);
    return td;
  }

  function renderRows(list) {
    el.rows.replaceChildren(
      ...list.map((task, i) => {
        const tr = document.createElement("tr");
        const entry = entryFor(task.id);
        const status = statusOf(entry);

        const num = h("td", "num", i + 1);
        const title = h("td", "title", task.title);
        const st = h("td", "status-cell");
        st.append(h("span", "pill status-" + status, STATUS_LABEL[status]));

        const qty = countsItems() ? quantityCell(task, entry) : null;

        const taken = h("td", "taken-cell");
        taken.dataset.label = "Taken";
        const mins = minutesTaken(entry, isToday());
        if (status === "done" && mins !== null) {
          taken.textContent = formatDuration(mins);
        } else if (status === "in_progress" && mins !== null) {
          taken.textContent = formatDuration(mins) + " so far";
          taken.classList.add("taken-running");
        } else if (status === "in_progress") {
          taken.textContent = "No end time";
          taken.classList.add("taken-none");
        } else {
          taken.textContent = "—";
          taken.classList.add("taken-none");
        }

        const actions = h("td", "actions");
        const tools = h("div", "row-tools");
        const up = iconButton("up", "Move " + task.title + " up", "btn-tool", () => moveTask(task, -1));
        up.disabled = i === 0;
        const down = iconButton("down", "Move " + task.title + " down", "btn-tool", () => moveTask(task, 1));
        down.disabled = i === list.length - 1;
        const copy = iconButton("copy", "Duplicate " + task.title, "btn-tool", () => duplicateTask(task));
        tools.append(up, down, copy);
        if (isAdmin()) {
          const del = iconButton("trash", "Delete " + task.title, "btn-tool btn-delete", () => {
            // Two-step delete: first click arms the button, second click deletes.
            if (del.classList.contains("armed")) return deleteTask(task);
            del.classList.add("armed");
            del.textContent = "Delete?";
            setTimeout(() => render(), 3000);
          });
          tools.append(del);
        }
        actions.append(tools);

        tr.append(
          num,
          title,
          timeCell(task, entry, "start_time"),
          timeCell(task, entry, "end_time"),
          st,
          ...(qty ? [qty] : []),
          taken,
          actions
        );
        return tr;
      })
    );
    el.empty.hidden = list.length > 0;
    el.empty.textContent = isAdmin() ? "No tasks yet. Add one below." : "No tasks assigned to you yet.";
  }

  // ---- Admin: overview of everyone on the selected day -----------------------

  function renderOverview() {
    el.ovDate.textContent = isToday() ? "today" : parseYmd(selectedDate).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

    let done = 0;
    let total = 0;
    let running = 0;
    const cards = employees.map((name) => {
      const list = tasksFor(name);
      const c = countStatuses(list);
      done += c.done;
      total += list.length;
      running += c.in_progress;

      const card = h("button", "ov-card");
      card.type = "button";
      card.setAttribute("aria-label", "Open " + name + "'s tasks");
      card.addEventListener("click", () => setActiveTab(name));

      const head = h("div", "ov-card-head");
      const av = h("span", "avatar");
      paintAvatar(av, name);
      head.append(av, h("strong", "ov-name", name), h("span", "ov-count", c.done + "/" + list.length));

      const bar = h("div", "ov-bar");
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", c.done + " of " + list.length + " done, " + c.in_progress + " in progress");
      const pct = (n) => (list.length ? (n / list.length) * 100 : 0) + "%";
      const fillDone = h("span", "ov-bar-done");
      fillDone.style.width = pct(c.done);
      const fillRun = h("span", "ov-bar-running");
      fillRun.style.width = pct(c.in_progress);
      bar.append(fillDone, fillRun);

      const now = list.filter((t) => statusOf(entryFor(t.id)) === "in_progress");
      const nowLine = h("p", "ov-now");
      if (now.length) {
        const e = entryFor(now[0].id);
        nowLine.append(h("span", "ov-now-dot"), h("span", "ov-now-title", now[0].title));
        nowLine.append(h("span", "ov-now-meta", " · since " + formatClock(e.start_time) + (now.length > 1 ? " · +" + (now.length - 1) + " more" : "")));
      } else {
        nowLine.classList.add("ov-idle");
        nowLine.textContent = c.done === list.length && list.length ? "All tasks done" : "Nothing in progress";
      }

      const stats = h("dl", "ov-stats");
      const stat = (label, value) => {
        const d = h("div");
        d.append(h("dt", "", label), h("dd", "", value));
        stats.append(d);
      };
      stat("Time", formatDuration(finishedMinutes(list)));
      stat("To do", c.todo);
      if (DONE_COUNTERS[name]) stat(capitalize(DONE_COUNTERS[name]), quantityTotal(list));

      card.append(head, bar, nowLine, stats);
      return card;
    });
    el.ovCards.replaceChildren(...cards);

    const chip = (n, label, cls) => {
      const c = h("span", "ov-total " + cls);
      c.append(h("strong", "", n), h("span", "", label));
      return c;
    };
    el.ovTotals.replaceChildren(chip(done + "/" + total, "tasks done", "status-done"), chip(running, "in progress", "status-in_progress"));

    // Keep the "Assign to" list in step with the team.
    const current = el.assignTo.value;
    const options = employees.map((name) => {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      return o;
    });
    if (options.map((o) => o.value).join("\u0001") !== Array.from(el.assignTo.options, (o) => o.value).join("\u0001")) {
      el.assignTo.replaceChildren(...options);
      if (employees.includes(current)) el.assignTo.value = current;
    }
  }

  // ---- Admin: reports --------------------------------------------------------

  let reportData = null;

  function reportRange() {
    const preset = el.repPreset.value;
    const t = parseYmd(todayStr);
    const monday = addDays(todayStr, -((t.getDay() + 6) % 7));
    switch (preset) {
      case "today":
        return [todayStr, todayStr];
      case "yesterday":
        return [addDays(todayStr, -1), addDays(todayStr, -1)];
      case "week":
        return [monday, todayStr];
      case "last7":
        return [addDays(todayStr, -6), todayStr];
      case "month":
        return [todayStr.slice(0, 8) + "01", todayStr];
      case "lastmonth": {
        const first = new Date(t.getFullYear(), t.getMonth() - 1, 1);
        const last = new Date(t.getFullYear(), t.getMonth(), 0);
        return [ymd(first), ymd(last)];
      }
      default:
        return [el.repFrom.value || todayStr, el.repTo.value || todayStr];
    }
  }

  async function loadReport() {
    if (!isAdmin()) return;
    const [from, to] = reportRange();
    el.repFrom.value = from;
    el.repTo.value = to;
    try {
      reportData = await store.report(from, to);
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't load the report: " + e.message);
      return;
    }
    renderReport();
  }

  function reportTotals() {
    const byEmp = new Map(employees.map((name) => [name, { days: new Set(), done: 0, started: 0, minutes: 0, quantity: 0 }]));
    for (const r of reportData ? reportData.rows : []) {
      if (!byEmp.has(r.employee)) byEmp.set(r.employee, { days: new Set(), done: 0, started: 0, minutes: 0, quantity: 0 });
      const x = byEmp.get(r.employee);
      x.days.add(r.work_date);
      x.done += r.tasks_done;
      x.started += r.tasks_started;
      x.minutes += r.minutes;
      x.quantity += r.quantity;
    }
    return byEmp;
  }

  function renderReport() {
    if (!reportData) return;
    const hasQty = Object.keys(DONE_COUNTERS).length > 0;
    const qtyLabel = hasQty ? capitalize(Object.values(DONE_COUNTERS)[0]) : "";
    const headRow = h("tr");
    ["Employee", "Days worked", "Tasks done", "Time taken", "Avg per day"].concat(hasQty ? [qtyLabel] : []).forEach((label, i) => {
      headRow.append(h("th", i ? "num-col" : "", label));
    });
    el.repHead.replaceChildren(headRow);

    const totals = reportTotals();
    let sumDays = 0, sumDone = 0, sumMin = 0, sumQty = 0;
    const rows = [];
    for (const [name, x] of totals) {
      const tr = h("tr");
      const who = h("td", "rep-name");
      const av = h("span", "avatar avatar-sm");
      paintAvatar(av, name);
      who.append(av, h("span", "", name));
      tr.append(
        who,
        h("td", "num-col", x.days.size),
        h("td", "num-col", x.done),
        h("td", "num-col", formatDuration(x.minutes)),
        h("td", "num-col", x.days.size ? formatDuration(Math.round(x.minutes / x.days.size)) : "—")
      );
      if (hasQty) tr.append(h("td", "num-col", DONE_COUNTERS[name] ? x.quantity : "—"));
      rows.push(tr);
      sumDays += x.days.size;
      sumDone += x.done;
      sumMin += x.minutes;
      sumQty += x.quantity;
    }
    el.repBody.replaceChildren(...rows);

    const foot = h("tr");
    foot.append(h("td", "", "Total"), h("td", "num-col", sumDays), h("td", "num-col", sumDone), h("td", "num-col", formatDuration(sumMin)), h("td", "num-col", ""));
    if (hasQty) foot.append(h("td", "num-col", sumQty));
    el.repFoot.replaceChildren(foot);
    el.repEmpty.hidden = reportData.rows.length > 0;
  }

  function downloadCsv() {
    if (!reportData) return;
    const esc = (v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [["Date", "Employee", "Tasks started", "Tasks done", "Minutes", "Time", "Items done"].join(",")];
    for (const r of reportData.rows) {
      lines.push([r.work_date, r.employee, r.tasks_started, r.tasks_done, r.minutes, formatDuration(r.minutes), r.quantity].map(esc).join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sop-report-" + reportData.from + "-to-" + reportData.to + ".csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  el.repPreset.addEventListener("change", loadReport);
  for (const input of [el.repFrom, el.repTo]) {
    input.addEventListener("change", () => {
      el.repPreset.value = "custom";
      loadReport();
    });
  }
  el.repCsv.addEventListener("click", downloadCsv);

  el.assignForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = el.assignTitle.value.trim();
    const employee = el.assignTo.value;
    if (!title || !employee) return;
    try {
      await store.insertTask({ employee, title });
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't assign the task: " + err.message);
      return;
    }
    el.assignTitle.value = "";
    showToast("Assigned “" + title + "” to " + employee);
    refresh();
  });

  // ---- Admin: team -----------------------------------------------------------

  async function loadTeam() {
    try {
      teamUsers = await store.listUsers();
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't load the team: " + e.message);
      return;
    }
    applyTeam(teamUsers);
  }

  function applyTeam(users) {
    teamUsers = users;
    const names = users.map((u) => u.name);
    if (names.join("\u0001") !== employees.join("\u0001")) {
      employees = names;
      if (isPersonTab() && !employees.includes(active)) active = OVERVIEW;
    }
    render();
  }

  function renderTeam() {
    el.teamList.replaceChildren(
      ...teamUsers.map((u) => {
        const row = h("div", "team-row");
        const who = h("div", "team-who");
        const av = h("span", "avatar");
        paintAvatar(av, u.name);
        const text = h("div");
        text.append(h("strong", "", u.name), h("span", "team-state " + (u.has_password ? "is-set" : "is-missing"), u.has_password ? "Password set" : "No password yet: can't sign in"));
        who.append(av, text);

        const form = h("form", "team-pass");
        form.autocomplete = "off";
        const input = document.createElement("input");
        input.type = "text";
        input.minLength = 4;
        input.maxLength = 100;
        input.required = true;
        input.placeholder = u.has_password ? "New password" : "Set a password";
        input.setAttribute("aria-label", "New password for " + u.name);
        input.autocomplete = "new-password";
        const save = h("button", "btn-secondary", u.has_password ? "Change" : "Set password");
        save.type = "submit";
        form.append(input, save);
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            applyTeam(await store.setUserPassword(u.name, input.value));
            showToast("Password saved for " + u.name + ". Tell them the new password.");
          } catch (err) {
            if (!handleAuthError(err)) showToast("Couldn't save: " + err.message);
          }
        });

        const remove = h("button", "btn-link btn-danger", "Remove");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          if (!remove.classList.contains("armed")) {
            remove.classList.add("armed");
            remove.textContent = "Remove " + u.name + "?";
            setTimeout(() => {
              remove.classList.remove("armed");
              remove.textContent = "Remove";
            }, 3000);
            return;
          }
          try {
            applyTeam(await store.removeUser(u.name));
            showToast(u.name + " was removed. Their past work stays in the reports.");
          } catch (err) {
            if (!handleAuthError(err)) showToast("Couldn't remove: " + err.message);
          }
        });

        row.append(who, form, remove);
        return row;
      })
    );
  }

  el.addUserForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el.newUserName.value.trim();
    const password = el.newUserPassword.value;
    if (!name) return;
    try {
      applyTeam(await store.addUser(name, password));
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't add: " + err.message);
      return;
    }
    el.newUserName.value = "";
    el.newUserPassword.value = "";
    showToast(name + " was added. Assign tasks from the Overview.");
  });

  // ---- Main render -------------------------------------------------------------

  function render() {
    if (!me) return;
    renderDate();
    // Don't rebuild the table under someone who is mid-edit in a number field;
    // catch up once they leave it.
    const focused = document.activeElement;
    if (focused && focused.type === "number" && el.rows.contains(focused)) {
      renderPending = true;
      return;
    }
    renderPending = false;
    renderTabs();

    const person = isPersonTab();
    el.overview.hidden = active !== OVERVIEW;
    el.team.hidden = active !== TEAM;
    el.tasksPanel.hidden = !person;
    el.notesPanel.hidden = !person;

    el.pageTitle.textContent = isAdmin() ? "Team SOP Dashboard" : me.name + "’s Tasks";

    const list = person ? tasksFor(active) : [];
    renderDoneCounter(list);
    if (active === OVERVIEW) renderOverview();
    if (active === TEAM) renderTeam();
    if (!person) return;

    renderSpotlight(list);
    renderSummary(list);
    el.qtyHead.hidden = !countsItems();
    if (countsItems()) el.qtyHead.textContent = capitalize(DONE_COUNTERS[active]) + " Done";
    renderRows(list);
    renderNotes();
    el.addForm.hidden = !isAdmin();
    el.addInput.placeholder = "Add a task for " + active + "…";
  }

  el.rows.addEventListener("focusout", () => {
    setTimeout(() => renderPending && render(), 0);
  });

  function saveEntryField(taskId, field, value) {
    const date = selectedDate;
    const next = { ...entryFor(taskId), [field]: value };
    mutate(
      () => entries.set(taskId, next),
      () =>
        store.saveEntry(taskId, date, {
          start_time: next.start_time,
          end_time: next.end_time,
          quantity: next.quantity,
        })
    );
  }

  function stampTime(taskId, field) {
    const entry = entryFor(taskId);
    if (!isToday() || entry[field]) return; // write-once
    if (field === "end_time" && !entry.start_time) return;
    saveEntryField(taskId, field, nowHHMM());
  }

  function setQuantity(taskId, value) {
    saveEntryField(taskId, "quantity", value > 0 ? value : null);
  }

  // Save a new order for one person's list: positions become 0..n-1 and
  // only the tasks whose position changed are written.
  function applyOrder(ordered) {
    const updates = [];
    ordered.forEach((t, i) => {
      if (t.position !== i) updates.push({ id: t.id, position: i });
    });
    if (!updates.length) return Promise.resolve();
    updates.forEach((u) => (tasks.find((t) => t.id === u.id).position = u.position));
    tasks.sort((a, b) => a.position - b.position);
    render();
    return store.setPositions(updates);
  }

  async function moveTask(task, dir) {
    const list = tasksFor(task.employee);
    const i = list.findIndex((t) => t.id === task.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    try {
      await applyOrder(list);
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't reorder: " + e.message);
      refresh();
    }
  }

  async function duplicateTask(task) {
    try {
      await store.duplicateTask(task.id);
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't duplicate: " + e.message);
    }
    refresh();
  }

  function deleteTask(task) {
    mutate(
      () => (tasks = tasks.filter((t) => t.id !== task.id)),
      () => store.removeTask(task.id)
    );
  }

  el.addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = el.addInput.value.trim();
    if (!title || !isPersonTab()) return;
    el.addInput.value = "";
    try {
      await store.insertTask({ employee: active, title });
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't add task: " + err.message);
      el.addInput.value = title;
      return;
    }
    refresh();
  });

  // ---- Notepad: one note per person per day, saved as you type. -------------

  let noteTimer = null;
  let notePending = null; // { employee, date, body } waiting to be saved
  let noteShownFor = "";

  function noteKey() {
    return active + "|" + selectedDate;
  }

  function renderNotes() {
    el.notesTitle.textContent = "Notes · " + active + " · " + shortDate(selectedDate);
    el.notesInput.placeholder = "Notes for " + (isAdmin() ? active : "you") + (isToday() ? " today" : " on this day") + "…";
    // Don't overwrite what someone is typing; do switch when tab or date changes.
    const typing = document.activeElement === el.notesInput;
    if (noteShownFor !== noteKey() || !typing) {
      const body =
        notePending && notePending.employee === active && notePending.date === selectedDate
          ? notePending.body
          : notes.get(active) || "";
      if (el.notesInput.value !== body) el.notesInput.value = body;
      if (noteShownFor !== noteKey()) el.notesStatus.textContent = "";
      noteShownFor = noteKey();
    }
  }

  async function flushNote() {
    clearTimeout(noteTimer);
    const pending = notePending;
    notePending = null;
    if (!pending || !store) return;
    try {
      await store.saveNote(pending.employee, pending.date, pending.body);
      if (pending.date === selectedDate) notes.set(pending.employee, pending.body);
      if (pending.employee + "|" + pending.date === noteKey()) el.notesStatus.textContent = "Saved";
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't save notes: " + e.message);
      if (pending.employee + "|" + pending.date === noteKey()) el.notesStatus.textContent = "Not saved";
    }
  }

  el.notesInput.addEventListener("input", () => {
    if (!isPersonTab()) return;
    notePending = { employee: active, date: selectedDate, body: el.notesInput.value };
    el.notesStatus.textContent = "Saving…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 700);
  });
  el.notesInput.addEventListener("blur", flushNote);
  window.addEventListener("beforeunload", flushNote);

  // ---- Calendar pop-up for picking a date. ---------------------------------

  let calendarOpen = false;
  let calendarMonth = selectedDate.slice(0, 7); // "YYYY-MM"
  let calendarDots = new Set();

  function monthBounds(ym) {
    const [y, m] = ym.split("-").map(Number);
    return { first: new Date(y, m - 1, 1), last: new Date(y, m, 0) };
  }

  async function loadCalendarDots() {
    if (!isPersonTab()) return; // dots are per person
    const month = calendarMonth;
    const { first, last } = monthBounds(month);
    try {
      const dates = await store.listWorkDates(active, ymd(first), ymd(last));
      if (month !== calendarMonth || !calendarOpen) return;
      calendarDots = new Set(dates);
      renderCalendar();
    } catch (e) {
      /* dots are a hint only */
    }
  }

  function renderCalendar() {
    const { first, last } = monthBounds(calendarMonth);
    const head = h("div", "cal-head");
    const prev = h("button", "btn-step");
    prev.type = "button";
    prev.innerHTML = "&#8249;";
    prev.setAttribute("aria-label", "Previous month");
    prev.addEventListener("click", () => shiftMonth(-1));
    const label = h("strong", "", first.toLocaleDateString("en-GB", { month: "long", year: "numeric" }));
    const next = h("button", "btn-step");
    next.type = "button";
    next.innerHTML = "&#8250;";
    next.setAttribute("aria-label", "Next month");
    next.disabled = calendarMonth >= todayStr.slice(0, 7);
    next.addEventListener("click", () => shiftMonth(1));
    head.append(prev, label, next);

    const grid = h("div", "cal-grid");
    grid.setAttribute("role", "grid");
    for (const wd of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) grid.append(h("span", "cal-wd", wd));
    for (let i = 0; i < first.getDay(); i++) grid.append(document.createElement("span"));
    for (let day = 1; day <= last.getDate(); day++) {
      const date = calendarMonth + "-" + String(day).padStart(2, "0");
      const b = h("button", "cal-day", day);
      b.type = "button";
      if (date === todayStr) b.classList.add("is-today");
      if (date === selectedDate) b.classList.add("is-selected");
      if (calendarDots.has(date)) b.classList.add("has-work");
      b.disabled = date > todayStr;
      b.setAttribute("aria-label", parseYmd(date).toDateString() + (calendarDots.has(date) ? ", work recorded" : ""));
      b.addEventListener("click", () => {
        setDate(date);
        toggleCalendar(false);
      });
      grid.append(b);
    }

    const foot = h("div", "cal-foot");
    const legend = h("span", "cal-legend", isPersonTab() ? "Dot = work recorded for " + active : "Pick a day to see the team");
    const todayBtn = h("button", "btn-now", "Today");
    todayBtn.type = "button";
    todayBtn.addEventListener("click", () => {
      setDate(todayStr);
      toggleCalendar(false);
    });
    foot.append(legend, todayBtn);

    el.calendar.replaceChildren(head, grid, foot);
  }

  function shiftMonth(n) {
    const [y, m] = calendarMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + n, 1);
    calendarMonth = ymd(d).slice(0, 7);
    calendarDots = new Set();
    renderCalendar();
    loadCalendarDots();
  }

  function toggleCalendar(open) {
    calendarOpen = open === undefined ? !calendarOpen : open;
    el.calendar.hidden = !calendarOpen;
    el.dateButton.setAttribute("aria-expanded", String(calendarOpen));
    if (calendarOpen) {
      calendarMonth = selectedDate.slice(0, 7);
      calendarDots = new Set();
      renderCalendar();
      loadCalendarDots();
    }
  }

  el.dateButton.addEventListener("click", () => toggleCalendar());
  el.today.addEventListener("click", () => toggleCalendar(true));
  document.addEventListener("click", (e) => {
    if (calendarOpen && !el.calendar.contains(e.target) && !el.dateButton.contains(e.target) && !el.today.contains(e.target)) {
      toggleCalendar(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && calendarOpen) {
      toggleCalendar(false);
      el.dateButton.focus();
    }
  });

  el.datePrev.addEventListener("click", () => setDate(addDays(selectedDate, -1)));
  el.dateNext.addEventListener("click", () => setDate(addDays(selectedDate, 1)));
  el.dateToday.addEventListener("click", () => setDate(todayStr));

  // Every minute: keep "so far" durations current, and roll over at midnight
  // (a dashboard left open on today moves on to the new day).
  setInterval(() => {
    const now = ymd(new Date());
    if (now !== todayStr) {
      const wasToday = isToday();
      todayStr = now;
      if (wasToday) return setDate(now);
    }
    render();
  }, 60 * 1000);

  // ---- Sign-in ----------------------------------------------------------------

  let chosenPerson = null; // name picked on step 2, or "Admin"

  function showAuthStep(step) {
    el.app.hidden = true;
    el.auth.hidden = false;
    el.authSite.hidden = step !== "site";
    el.authPeople.hidden = step !== "people";
    el.authUser.hidden = step !== "user";
    const focus = step === "site" ? el.sitePassword : step === "user" ? el.userPassword : el.people.querySelector("button");
    if (focus) setTimeout(() => focus.focus(), 0);
  }

  function renderPeople(users) {
    const person = (name, isAdminChoice, note) => {
      const b = h("button", "person" + (isAdminChoice ? " person-admin" : ""));
      b.type = "button";
      const av = h("span", "avatar avatar-lg");
      paintAvatar(av, name, isAdminChoice);
      b.append(av, h("span", "person-name", name));
      if (note) b.append(h("span", "person-note", note));
      b.addEventListener("click", () => {
        chosenPerson = name;
        paintAvatar(el.authAvatar, name, isAdminChoice);
        el.authUserTitle.textContent = isAdminChoice ? "Admin sign-in" : "Hi " + name;
        el.userPassword.value = "";
        el.userError.textContent = "";
        showAuthStep("user");
      });
      return b;
    };
    el.people.replaceChildren(
      ...users.map((u) => person(u.name, false, u.has_password ? "" : "No password yet")),
      person("Admin", true, "")
    );
  }

  // Show whichever sign-in step this browser is on, or open the dashboard.
  async function applySession(s) {
    if (!s.site_ok) {
      me = null;
      el.sitePassword.value = "";
      el.siteError.textContent = "";
      return showAuthStep("site");
    }
    if (!s.user) {
      me = null;
      renderPeople(s.users);
      return showAuthStep("people");
    }
    await enterApp(s);
  }

  async function reloadSession() {
    try {
      await applySession(await store.getSession());
    } catch (e) {
      showBanner(e.message, true);
    }
  }

  async function enterApp(s) {
    me = s.user;
    el.auth.hidden = true;
    el.app.hidden = false;
    paintAvatar(el.userAvatar, me.name, isAdmin());
    el.userName.textContent = me.name;
    el.userRole.hidden = !isAdmin();

    if (isAdmin()) {
      try {
        await store.init();
      } catch (e) {
        if (!handleAuthError(e)) showToast("Couldn't sync the task list: " + e.message);
      }
      try {
        teamUsers = await store.listUsers();
      } catch (e) {
        teamUsers = s.users;
      }
      employees = teamUsers.map((u) => u.name);
    } else {
      employees = [me.name];
    }
    tasks = [];
    entries = new Map();
    notes = new Map();
    noteShownFor = "";
    active = defaultTab();
    render();
    if (!subscribed) {
      store.subscribe(scheduleRefresh);
      subscribed = true;
    }
    await refresh();
    if (active === OVERVIEW) loadReport();
  }

  el.authSite.addEventListener("submit", async (e) => {
    e.preventDefault();
    el.siteError.textContent = "";
    try {
      await applySession(await store.siteLogin(el.sitePassword.value));
    } catch (err) {
      el.siteError.textContent = err.message;
      el.sitePassword.select();
    }
  });

  el.authUser.addEventListener("submit", async (e) => {
    e.preventDefault();
    el.userError.textContent = "";
    try {
      await applySession(await store.userLogin(chosenPerson, el.userPassword.value));
    } catch (err) {
      if (err.code === "site_login") return reloadSession();
      el.userError.textContent = err.message;
      el.userPassword.select();
    }
  });

  el.authBack.addEventListener("click", () => showAuthStep("people"));

  async function signOut(action) {
    await flushNote();
    try {
      await applySession(await store[action]());
    } catch (e) {
      showBanner(e.message, true);
    }
  }
  el.switchUser.addEventListener("click", () => signOut("switchUser"));
  el.lock.addEventListener("click", () => signOut("logout"));
  el.authLock.addEventListener("click", () => signOut("logout"));

  async function start() {
    store = createStore();
    if (store.mode === "local") {
      showBanner(
        "Preview mode: data is saved in this browser only. Dashboard password: " + DEMO.site +
          " · Admin password: " + DEMO.admin + " · Employee password: " + DEMO.employee
      );
    }
    try {
      await applySession(await store.getSession());
    } catch (e) {
      const plain = e.message.startsWith("Can't") || e.message.includes("config.php");
      showBanner(plain ? e.message : "Couldn't connect to the database: " + e.message, true);
    }
  }

  start();
})();

(function () {
  "use strict";

  const SEED_VERSION = window.SEED_VERSION;
  const DONE_COUNTERS = window.DONE_COUNTERS || {};
  // Days that count for daily tasks (0 = Sunday ... 6 = Saturday). A daily
  // task not done on one of these days becomes pending the next day.
  const WORK_DAYS = window.WORK_DAYS || [1, 2, 3, 4, 5, 6];
  // Pending work older than this many days drops off the list.
  const PENDING_DAYS = 30;
  const config = window.SOP_CONFIG || {};
  // "team" (haaps.co.in): dashboard password, then name + own password.
  // "admin" (admin.haaps.co.in or /admin): admin password only. The local
  // preview opens the admin side with #admin in the address.
  const MODE = config.mode === "admin" || (config.backend !== "php" && location.hash === "#admin") ? "admin" : "team";

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

  // Status is derived from an entry, never stored by the UI.
  function statusOf(entry) {
    if (entry.end_time) return "done";
    if (entry.start_time) return "in_progress";
    return "todo";
  }

  const STATUS_LABEL = { todo: "To Do", in_progress: "In Progress", done: "Done", overdue: "Overdue", excused: "Excused" };
  const EMPTY_ENTRY = Object.freeze({ start_time: null, end_time: null, started_on: null, ended_on: null, quantity: null, skipped: false });
  const OVERVIEW = "\u0000overview";
  const TEAM = "\u0000team";
  const FREQ_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
  const VIEWS = [
    { key: "daily", label: "Daily Tasks" },
    { key: "weekly", label: "Weekly Tasks" },
    { key: "monthly", label: "Monthly Tasks" },
    { key: "pending", label: "Pending" },
    { key: "reminders", label: "Reminders" },
  ];
  const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  function toMinutes(t) {
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  }

  function atTime(date, time) {
    const [y, mo, d] = date.split("-").map(Number);
    const [h, mi, s] = time.split(":").map(Number);
    return new Date(y, mo - 1, d, h, mi, s || 0);
  }

  // Minutes from start to end, or to now while a task is still running and
  // `running` is allowed. Returns null when there is nothing to measure.
  function minutesTaken(entry, running) {
    if (!entry.start_time) return null;
    if (entry.started_on) {
      const start = atTime(entry.started_on, entry.start_time);
      let end;
      if (entry.end_time) end = atTime(entry.ended_on || entry.started_on, entry.end_time);
      else if (running) end = new Date();
      else return null;
      return Math.max(0, Math.round((end - start) / 60000));
    }
    // Older entries have times but no dates: same day, wrapping past midnight.
    const start = toMinutes(entry.start_time);
    let end = toMinutes(entry.end_time);
    if (end === null) {
      if (!running) return null;
      const d = new Date();
      end = d.getHours() * 60 + d.getMinutes();
    }
    let diff = end - start;
    if (diff < 0) diff += 24 * 60;
    return diff;
  }

  function formatDuration(min) {
    const d = Math.floor(min / 1440);
    const h = Math.floor((min % 1440) / 60);
    const m = min % 60;
    if (d) return h ? d + "d " + h + "h" : d + "d";
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

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
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
    edit: '<path d="M4 17.25V20h2.75L17.8 8.95l-2.75-2.75L4 17.25zM20.7 6.05a1 1 0 0 0 0-1.41l-1.34-1.34a1 1 0 0 0-1.41 0l-1.13 1.13 2.75 2.75 1.13-1.13z"/>',
    check: '<path d="M9.5 16.2L5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/>',
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

  function option(value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  function nowHHMM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
  }

  // ---- Dates ------------------------------------------------------------------

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

  function daysBetween(a, b) {
    return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  }

  function weekStart(s) {
    return addDays(s, -((parseYmd(s).getDay() + 6) % 7)); // Monday
  }

  function monthStart(s) {
    return s.slice(0, 8) + "01";
  }

  function nextMonth(s) {
    const d = parseYmd(s);
    return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  }

  function daysInMonth(s) {
    const d = parseYmd(s);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }

  function shortDate(s) {
    return parseYmd(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function dayDate(s) {
    return parseYmd(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }

  const maxDate = (a, b) => (a > b ? a : b);

  // Each task happens once per "occurrence": a day for daily tasks, a week
  // (keyed by its Monday) for weekly tasks, a month (keyed by the 1st) for
  // monthly tasks. Times are recorded against the occurrence's key date.
  function occurrenceKey(task, date) {
    if (task.frequency === "weekly") return weekStart(date);
    if (task.frequency === "monthly") return monthStart(date);
    return date;
  }

  function dueDate(task, key) {
    if (task.frequency === "weekly") return addDays(key, (task.due_day || 1) - 1);
    if (task.frequency === "monthly") return addDays(key, Math.min(task.due_day || 1, daysInMonth(key)) - 1);
    return key;
  }

  function dueLabel(task) {
    if (task.frequency === "weekly") return "Due " + WEEKDAYS[(task.due_day || 1) - 1];
    if (task.frequency === "monthly") return "Due on the " + ordinal(task.due_day || 1);
    return "";
  }

  function apiError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // -------------------------------------------------------------------------
  // Data stores. Both expose the same interface:
  //   getSession()                    -> { site_ok, user, users, today, tracking_start }
  //   siteLogin(password), userLogin(name, password), switchUser(), logout()
  //   init()                          -> admin: apply seed version
  //   listTasks(), listEntries(dates), listEntriesRange(from, to), listNotes(date)
  //   listWorkDates(employee, from, to)
  //   insertTask({employee, title, frequency, due_day}), removeTask(id)    (employees: their own)
  //   updateTask(id, changes)                                              (admin)
  //   duplicateTask(id), setPositions([{id, position}])
  //   saveEntry(taskId, date, {start_time, end_time, quantity}) -> recorded times
  //   skipEntry(taskId, date, skipped)                                                            (admin)
  //   saveNote(employee, date, body)
  //   listReminders(), addReminder({employee, title, due_date, due_time}), setReminderDone(id, done), removeReminder(id)
  //   listUsers(), addUser(name, password), setUserPassword(name, password), removeUser(name)   (admin)
  //   report(from, to)
  //   subscribe(onChange)             -> called when data may have changed elsewhere
  //
  // Employees only ever get their own data back. Start and end times are
  // write-once; sending one means "stamp it now if it's empty".
  // -------------------------------------------------------------------------

  // PHP + MySQL API in api/index.php (for regular web hosting such as
  // Hostinger). The server enforces who may see and change what, and its
  // clock decides the recorded times.
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
      adminLogin: (password) => call("adminLogin", { password }),
      switchUser: () => call("switchUser"),
      logout: () => call("logout"),
      init: () => call("init", { version: SEED_VERSION, tasks: seedRows(), employees: window.EMPLOYEES }),
      listTasks: () => call("listTasks"),
      listEntries: (dates) => call("listEntries", { dates }),
      listEntriesRange: (from, to) => call("listEntriesRange", { from, to }),
      insertTask: (row) => call("insertTask", row),
      updateTask: (id, changes) => call("updateTask", { id, ...changes }),
      duplicateTask: (id) => call("duplicateTask", { id }),
      removeTask: (id) => call("removeTask", { id }),
      setPositions: (updates) => call("setPositions", { updates }),
      saveEntry: (taskId, date, times) => call("saveEntry", { task_id: taskId, date, ...times }),
      skipEntry: (taskId, date, skipped) => call("skipEntry", { task_id: taskId, date, skipped }),
      listWorkDates: (employee, from, to) => call("listWorkDates", { employee, from, to }),
      listNotes: (date) => call("listNotes", { date }),
      saveNote: (employee, date, body) => call("saveNote", { employee, date, body }),
      listReminders: () => call("listReminders"),
      addReminder: (r) => call("addReminder", r),
      setReminderDone: (id, done) => call("setReminderDone", { id, done }),
      removeReminder: (id) => call("removeReminder", { id }),
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
  // the same rules with demo passwords, but it is not secure.
  const DEMO = { site: "demo", admin: "admin", employee: "1234" };

  function createLocalStore() {
    const KEY = "sop-dashboard:v4";

    function load() {
      try {
        const s = JSON.parse(localStorage.getItem(KEY));
        if (s && Array.isArray(s.tasks) && s.entries) return { notes: {}, users: [], session: {}, reminders: [], ...s };
      } catch (e) {}
      return { seedVersion: 0, tasks: [], entries: {}, notes: {}, users: [], session: {}, reminders: [], trackingStart: null };
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
    const today = () => ymd(new Date());
    let state = load();

    function seed() {
      if (!state.trackingStart) state.trackingStart = today();
      if (state.seedVersion >= SEED_VERSION) return save();
      const rows = seedRows();
      const inSeed = (t) => rows.some((s) => s.employee === t.employee && s.title === t.title);
      const removed = state.tasks.filter((t) => t.from_seed && !inSeed(t)).map((t) => t.id);
      state.tasks = state.tasks.filter((t) => !removed.includes(t.id));
      for (const date of Object.keys(state.entries)) removed.forEach((id) => delete state.entries[date][id]);
      for (const s of rows) {
        const existing = state.tasks.find((t) => t.employee === s.employee && t.title === s.title);
        const weekly = /\(Weekly\)/i.test(s.title);
        if (existing) Object.assign(existing, { position: s.position, from_seed: true });
        else
          state.tasks.push({ ...s, id: newId(), from_seed: true, frequency: weekly ? "weekly" : "daily", due_day: weekly ? 1 : null, created_at: new Date().toISOString() });
      }
      window.EMPLOYEES.forEach((name, i) => {
        if (!state.users.some((u) => u.name === name)) state.users.push({ name, password: DEMO.employee, active: true, position: i });
      });
      state.seedVersion = SEED_VERSION;
      save();
    }
    seed();

    // One sign-in per entrance, like the two cookies on the server.
    const sessionKey = "session_" + MODE;
    const me = () => state[sessionKey] || {};
    const setSession = (v) => (state[sessionKey] = v);
    const isAdmin = () => me().role === "admin";
    const activeUsers = () => state.users.filter((u) => u.active).sort((a, b) => a.position - b.position);
    const publicUsers = () => activeUsers().map((u) => ({ name: u.name, has_password: Boolean(u.password), active: true }));
    function payload() {
      const s = me();
      const ok = s.site_ok && ((MODE === "admin" && s.role === "admin") || (MODE === "team" && s.role === "employee"));
      const user = ok ? { role: s.role, name: s.role === "admin" ? "Admin" : s.name } : null;
      return { site_ok: Boolean(s.site_ok), user, users: s.site_ok && MODE === "team" ? publicUsers() : [], entry: MODE, today: today(), tracking_start: user ? state.trackingStart : null };
    }
    function requireUser() {
      if (MODE === "admin" && me().role !== "admin") throw apiError("Please sign in.", "admin_login");
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
    function freq(row, current) {
      const frequency = row.frequency || (current && current.frequency) || "daily";
      if (frequency === "daily") return { frequency, due_day: null };
      const due = Number(row.due_day ?? (current && current.frequency === frequency ? current.due_day : 1)) || 1;
      return { frequency, due_day: Math.min(Math.max(due, 1), frequency === "weekly" ? 7 : 31) };
    }
    const visibleTasks = () => (isAdmin() ? state.tasks : state.tasks.filter((t) => t.employee === me().name));
    const sorted = (list) =>
      list.slice().sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
    function entriesWhere(test) {
      const ids = new Set(visibleTasks().map((t) => t.id));
      const out = [];
      for (const date of Object.keys(state.entries)) {
        if (!test(date)) continue;
        for (const [taskId, e] of Object.entries(state.entries[date])) {
          if (ids.has(taskId)) out.push({ task_id: taskId, work_date: date, ...EMPTY_ENTRY, ...e });
        }
      }
      return out;
    }
    function entry(taskId, date) {
      state.entries[date] = state.entries[date] || {};
      return (state.entries[date][taskId] = state.entries[date][taskId] || { ...EMPTY_ENTRY });
    }

    return {
      mode: "local",
      async getSession() {
        return payload();
      },
      async siteLogin(password) {
        if (password !== DEMO.site) throw apiError("Wrong password.", "wrong_password");
        setSession({ site_ok: true });
        save();
        return payload();
      },
      async userLogin(name, password) {
        if (!me().site_ok) throw apiError("Enter the dashboard password first.", "site_login");
        if (name.toLowerCase() === "admin") {
          throw apiError("Admin signs in from the admin address.");
        } else {
          const u = activeUsers().find((x) => x.name === name);
          if (!u) throw apiError("That person is no longer on the team.");
          if (!u.password) throw apiError("No password has been set for " + name + " yet. Ask the admin to set one.");
          if (password !== u.password) throw apiError("Wrong password.", "wrong_password");
          setSession({ site_ok: true, role: "employee", name });
        }
        save();
        return payload();
      },
      async adminLogin(password) {
        if (password !== DEMO.admin) throw apiError("Wrong password.", "wrong_password");
        setSession({ site_ok: true, role: "admin" });
        save();
        return payload();
      },
      async switchUser() {
        setSession({ site_ok: Boolean(me().site_ok) });
        save();
        return payload();
      },
      async logout() {
        setSession({});
        save();
        return payload();
      },
      async init() {
        requireAdmin();
      },
      async listTasks() {
        requireUser();
        return sorted(visibleTasks()).map((t) => ({ frequency: "daily", due_day: null, ...t }));
      },
      async listEntries(dates) {
        requireUser();
        return entriesWhere((d) => dates.includes(d));
      },
      async listEntriesRange(from, to) {
        requireUser();
        return entriesWhere((d) => d >= from && d <= to);
      },
      async insertTask(row) {
        requireUser();
        if (!isAdmin()) row = { ...row, employee: me().name };
        if (!activeUsers().some((u) => u.name === row.employee)) throw apiError("Choose someone on the team to assign this task to.");
        const mine = state.tasks.filter((t) => t.employee === row.employee);
        const position = mine.length ? Math.max(...mine.map((t) => t.position)) + 1 : 0;
        state.tasks.push({ employee: row.employee, title: row.title, position, ...freq(row), id: newId(), from_seed: false, created_at: new Date().toISOString() });
        save();
      },
      async updateTask(id, changes) {
        requireAdmin();
        const t = ownTask(id);
        if (changes.employee && changes.employee !== t.employee) {
          const mine = state.tasks.filter((x) => x.employee === changes.employee);
          t.position = mine.length ? Math.max(...mine.map((x) => x.position)) + 1 : 0;
          t.employee = changes.employee;
        }
        if (changes.title) t.title = changes.title;
        Object.assign(t, freq(changes, t));
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
        const copy = { employee: t.employee, title: base + " (" + (max + 1) + ")", frequency: t.frequency || "daily", due_day: t.due_day ?? null, id: newId(), from_seed: false, created_at: new Date().toISOString() };
        let pos = 0;
        for (const x of list) {
          x.position = pos++;
          if (x.id === t.id) copy.position = pos++;
        }
        state.tasks.push(copy);
        save();
      },
      async removeTask(id) {
        ownTask(id);
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
        if (date > today()) throw apiError("That day hasn't started yet.");
        const e = entry(taskId, date);
        // Write-once, stamped with this device's clock.
        if (!e.start_time && times.start_time) Object.assign(e, { start_time: nowHHMM(), started_on: today() });
        if (!e.end_time && times.end_time) {
          if (!e.start_time) throw apiError("A task has to be started before it can be ended.");
          Object.assign(e, { end_time: nowHHMM(), ended_on: today() });
        }
        e.quantity = times.quantity ?? null;
        save();
        return { start_time: e.start_time, end_time: e.end_time, started_on: e.started_on, ended_on: e.ended_on };
      },
      async skipEntry(taskId, date, skipped) {
        requireAdmin();
        ownTask(taskId);
        entry(taskId, date).skipped = Boolean(skipped);
        save();
      },
      async listWorkDates(employee, from, to) {
        requireUser();
        const who = isAdmin() ? employee : me().name;
        const ids = new Set(state.tasks.filter((t) => t.employee === who).map((t) => t.id));
        const dates = new Set();
        for (const [date, day] of Object.entries(state.entries)) {
          for (const [id, e] of Object.entries(day)) {
            const d = e.started_on || date;
            if (ids.has(id) && e.start_time && d >= from && d <= to) dates.add(d);
          }
        }
        return [...dates];
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
      async listReminders() {
        requireUser();
        const cutoff = Date.now() - 14 * 86400000;
        return state.reminders
          .filter((r) => (isAdmin() || r.employee === me().name) && (!r.done_at || Date.parse(r.done_at) > cutoff))
          .sort((a, b) => (a.due_date + (a.due_time || "~")).localeCompare(b.due_date + (b.due_time || "~")));
      },
      async addReminder(r) {
        requireUser();
        const employee = isAdmin() ? r.employee : me().name;
        state.reminders.push({ id: newId(), employee, title: r.title, due_date: r.due_date, due_time: r.due_time || null, done_at: null, created_by: isAdmin() ? "Admin" : employee });
        save();
      },
      async setReminderDone(id, done) {
        requireUser();
        const r = state.reminders.find((x) => x.id === id && (isAdmin() || x.employee === me().name));
        if (r) r.done_at = done ? new Date().toISOString() : null;
        save();
      },
      async removeReminder(id) {
        requireUser();
        state.reminders = state.reminders.filter((x) => !(x.id === id && (isAdmin() || x.employee === me().name)));
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
        const byKey = {};
        for (const [date, day] of Object.entries(state.entries)) {
          for (const [id, e] of Object.entries(day)) {
            const t = state.tasks.find((x) => x.id === id);
            const d = e.ended_on || e.started_on || date;
            if (!t || d < from || d > to || (!e.start_time && !(e.quantity > 0))) continue;
            const k = t.employee + "|" + d;
            const r = (byKey[k] = byKey[k] || { employee: t.employee, work_date: d, tasks_started: 0, tasks_done: 0, minutes: 0, quantity: 0 });
            if (e.start_time) r.tasks_started++;
            if (e.end_time) {
              r.tasks_done++;
              r.minutes += minutesTaken(e, false) || 0;
            }
            r.quantity += e.quantity || 0;
          }
        }
        return { from, to, rows: Object.values(byKey).sort((a, b) => a.work_date.localeCompare(b.work_date)) };
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
    authAdmin: $("auth-admin"),
    adminPassword: $("admin-password"),
    adminError: $("admin-error"),
    greeting: $("greeting"),
    ringFill: $("ring-fill"),
    ringPct: $("ring-pct"),
    progressMain: $("progress-main"),
    progressSub: $("progress-sub"),
    clock: $("clock"),
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
    subtabs: $("subtabs"),
    overview: $("overview"),
    ovDate: $("ov-date"),
    ovTotals: $("ov-totals"),
    ovCards: $("ov-cards"),
    ovPending: $("ov-pending"),
    ovPendingTotal: $("ov-pending-total"),
    ovNotes: $("ov-notes"),
    ovNotesDate: $("ov-notes-date"),
    assignForm: $("assign-form"),
    assignTitle: $("assign-title"),
    assignFreq: $("assign-freq"),
    assignDueField: $("assign-due-field"),
    assignDueLabel: $("assign-due-label"),
    assignDue: $("assign-due"),
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
    periodLine: $("period-line"),
    pendingPanel: $("pending-panel"),
    pendingRows: $("pending-rows"),
    pendingEmpty: $("pending-empty"),
    pendingHelp: $("pending-help"),
    remindersPanel: $("reminders-panel"),
    reminderForm: $("reminder-form"),
    reminderTitle: $("reminder-title"),
    reminderDate: $("reminder-date"),
    reminderTime: $("reminder-time"),
    reminderGroups: $("reminder-groups"),
    notesPanel: $("notes-panel"),
    summary: $("summary"),
    spotlight: $("spotlight"),
    rows: $("task-rows"),
    empty: $("empty"),
    addForm: $("add-form"),
    addInput: $("add-input"),
    addDue: $("add-due"),
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
  let entries = new Map(); // "taskId|date" -> entry, for the selected day/week/month
  let recent = new Map(); // "taskId|date" -> entry, for the pending window
  let notes = new Map(); // employee -> note text for selectedDate
  let reminders = [];
  let active = null; // an employee name, OVERVIEW or TEAM
  let view = "daily"; // daily | weekly | monthly | pending | reminders
  let todayStr = ymd(new Date());
  let trackingStart = todayStr;
  let selectedDate = todayStr;
  let renderPending = false;
  let editingTaskId = null;
  let subscribed = false;

  const isAdmin = () => Boolean(me && me.role === "admin");
  const isPersonTab = () => active !== OVERVIEW && active !== TEAM;
  const isTaskView = () => view === "daily" || view === "weekly" || view === "monthly";

  function isToday() {
    return selectedDate === todayStr;
  }

  // The entry for a task's occurrence on the selected date.
  function entryFor(task, date) {
    const key = occurrenceKey(task, date || selectedDate);
    return entries.get(task.id + "|" + key) || recent.get(task.id + "|" + key) || EMPTY_ENTRY;
  }

  // Times can only be stamped for the current day/week/month.
  function isCurrent(task) {
    return occurrenceKey(task, selectedDate) === occurrenceKey(task, todayStr);
  }

  function prefKey(name) {
    return "sop-dashboard:" + name + ":" + (me ? me.role + ":" + me.name : "");
  }

  function readPref(name, valid, fallback) {
    try {
      const saved = localStorage.getItem(prefKey(name));
      if (valid(saved)) return saved;
    } catch (e) {}
    return fallback;
  }

  function writePref(name, value) {
    try {
      localStorage.setItem(prefKey(name), value);
    } catch (e) {}
  }

  function setActiveTab(name, nextView) {
    flushNote();
    active = name;
    editingTaskId = null;
    writePref("tab", name);
    if (nextView) setView(nextView, true);
    if (calendarOpen) toggleCalendar(false);
    render();
    if (active === OVERVIEW) loadReport();
    if (active === TEAM) loadTeam();
  }

  function setView(v, silent) {
    view = v;
    editingTaskId = null;
    writePref("view", v);
    if (!silent) render();
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
    if (e && (e.code === "site_login" || e.code === "user_login" || e.code === "admin_login")) {
      reloadSession();
      return true;
    }
    return false;
  }

  function pendingWindowStart() {
    return maxDate(trackingStart, addDays(todayStr, -PENDING_DAYS));
  }

  async function refresh() {
    if (!me) return;
    const date = selectedDate;
    const keys = [...new Set([date, weekStart(date), monthStart(date)])];
    const from = pendingWindowStart();
    const rangeFrom = [from, weekStart(from), monthStart(from)].sort()[0];
    let t, e, n, r, rem;
    try {
      [t, e, n, r, rem] = await Promise.all([
        store.listTasks(),
        store.listEntries(keys),
        store.listNotes(date),
        store.listEntriesRange(rangeFrom, todayStr),
        store.listReminders(),
      ]);
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't load tasks: " + err.message);
      return;
    }
    if (date !== selectedDate || !me) return; // changed while loading
    const toMap = (list) => new Map(list.map((x) => [x.task_id + "|" + x.work_date, { ...EMPTY_ENTRY, ...x, quantity: x.quantity ?? null }]));
    tasks = t;
    entries = toMap(e);
    recent = toMap(r);
    notes = new Map(n.map((x) => [x.employee, x.body || ""]));
    reminders = rem;
    render();
    if (calendarOpen) loadCalendarDots();
  }

  // Coalesce bursts of change notifications into one reload.
  let refreshTimer;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  function tasksFor(name, frequency) {
    return tasks.filter((t) => t.employee === name && (!frequency || (t.frequency || "daily") === frequency));
  }

  function statusFor(task, date) {
    const e = entryFor(task, date);
    const s = statusOf(e);
    if (s !== "done" && task.frequency !== "daily" && isCurrent(task) && dueDate(task, occurrenceKey(task, todayStr)) < todayStr) {
      return "overdue";
    }
    return s;
  }

  function countStatuses(list) {
    const c = { todo: 0, in_progress: 0, done: 0 };
    list.forEach((t) => c[statusOf(entryFor(t))]++);
    return c;
  }

  function finishedMinutes(list) {
    return list
      .map((t) => entryFor(t))
      .filter((e) => e.start_time && e.end_time)
      .reduce((sum, e) => sum + minutesTaken(e, false), 0);
  }

  function quantityTotal(list) {
    return list.reduce((sum, t) => sum + (entryFor(t).quantity || 0), 0);
  }

  // ---- Pending work ------------------------------------------------------------
  // A daily task not finished on a work day, or a weekly/monthly task not
  // finished by its due day, is pending until it's done or the admin excuses it.

  function pendingFor(name) {
    const items = [];
    const from = pendingWindowStart();
    const recorded = (task, key) => recent.get(task.id + "|" + key) || entries.get(task.id + "|" + key) || EMPTY_ENTRY;
    const add = (task, key, due) => {
      const e = recorded(task, key);
      if (!e.end_time && !e.skipped) items.push({ task, key, due, entry: e });
    };
    for (const task of tasksFor(name)) {
      const created = String(task.created_at || "").slice(0, 10) || from;
      const start = maxDate(from, created);
      const freq = task.frequency || "daily";
      if (freq === "daily") {
        for (let d = start; d < todayStr; d = addDays(d, 1)) {
          if (WORK_DAYS.includes(parseYmd(d).getDay())) add(task, d, d);
        }
      } else {
        const step = freq === "weekly" ? (k) => addDays(k, 7) : nextMonth;
        for (let k = occurrenceKey(task, start); k <= todayStr; k = step(k)) {
          const due = dueDate(task, k);
          if (due >= start && due < todayStr) add(task, k, due);
        }
      }
    }
    return items.sort((a, b) => a.due.localeCompare(b.due) || a.task.position - b.task.position);
  }

  function dueReminders(name) {
    return reminders.filter((r) => r.employee === name && !r.done_at && r.due_date <= todayStr);
  }

  // ---- Header / date ------------------------------------------------------------

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

  function greetingText() {
    const hour = new Date().getHours();
    const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    return part + ", " + me.name;
  }

  // Header: greeting and a progress ring for the selected day's daily tasks
  // (your own, or the whole team's for the admin).
  function renderHeaderWidget() {
    el.greeting.textContent = greetingText();
    const people = isAdmin() ? employees : [me.name];
    const list = people.flatMap((name) => tasksFor(name, "daily"));
    const done = countStatuses(list).done;
    const pct = list.length ? Math.round((done / list.length) * 100) : 0;
    const circumference = 2 * Math.PI * 27;
    el.ringFill.style.strokeDasharray = circumference.toFixed(2);
    el.ringFill.style.strokeDashoffset = (circumference * (1 - pct / 100)).toFixed(2);
    el.ringPct.textContent = pct + "%";
    const when = isToday() ? "today" : "on " + dayDate(selectedDate);
    el.progressMain.textContent = done + " of " + list.length + " daily tasks done " + (isAdmin() ? "by the team " : "") + when;
    const pending = people.reduce((n, name) => n + pendingFor(name).length, 0);
    const due = people.reduce((n, name) => n + dueReminders(name).length, 0);
    const bits = [];
    bits.push(pending ? pending + " pending" + (isAdmin() ? " across the team" : "") : "Nothing pending");
    if (due) bits.push(due + (due === 1 ? " reminder" : " reminders") + " due");
    el.progressSub.textContent = bits.join(" · ");
    el.progressSub.classList.toggle("has-pending", pending > 0);
  }

  function renderClock() {
    el.clock.textContent = formatClock(nowHHMM());
  }
  setInterval(renderClock, 10 * 1000);

  function renderDoneCounter(list) {
    const noun = isPersonTab() && view === "daily" && DONE_COUNTERS[active];
    el.doneCounter.hidden = !noun;
    if (!noun) return;
    const n = h("strong", "", quantityTotal(list));
    const label = h("span", "done-label", noun + " done " + (isToday() ? "today" : "on this day"));
    const sub = h("span", "done-sub", countStatuses(list).done + " / " + list.length + " tasks finished");
    el.doneCounter.replaceChildren(n, label, sub);
  }

  // Big "now working on" card for tasks in progress.
  function renderSpotlight(list) {
    const running = list.filter((t) => statusOf(entryFor(t)) === "in_progress");
    el.spotlight.hidden = running.length === 0;
    el.spotlight.replaceChildren(
      ...running.map((task) => {
        const entry = entryFor(task);
        const item = h("div", "spotlight-item");
        const mins = minutesTaken(entry, isCurrent(task));
        const startedOn = entry.started_on && entry.started_on !== todayStr ? dayDate(entry.started_on) + ", " : "";
        item.append(
          h("span", "spotlight-eyebrow", "In Progress" + (task.frequency !== "daily" ? " · " + FREQ_LABEL[task.frequency] : "")),
          h("strong", "spotlight-title", task.title),
          h(
            "span",
            "spotlight-meta",
            "Started " + startedOn + formatClock(entry.start_time) + " · " + (mins === null ? "no end time" : formatDuration(mins) + " so far")
          )
        );
        return item;
      })
    );
  }

  function renderTabs() {
    // Employees only ever see their own work, so they get no person tabs.
    el.tabs.hidden = !isAdmin();
    if (!isAdmin()) return;
    const tab = (key, label, badge, extraClass, alert) => {
      const btn = h("button", "tab" + (extraClass ? " " + extraClass : ""));
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(key === active));
      btn.append(h("span", "", label));
      if (badge !== undefined) btn.append(h("span", "tab-count", badge));
      if (alert) {
        const a = h("span", "tab-alert", alert);
        a.title = alert + " pending";
        btn.append(a);
      }
      btn.addEventListener("click", () => setActiveTab(key));
      return btn;
    };
    el.tabs.replaceChildren(
      tab(OVERVIEW, "Overview", undefined, "tab-admin"),
      ...employees.map((name) => {
        const list = tasksFor(name, "daily");
        return tab(name, name, countStatuses(list).done + "/" + list.length, "", pendingFor(name).length || 0);
      }),
      tab(TEAM, "Team", undefined, "tab-admin")
    );
  }

  function renderSubtabs() {
    el.subtabs.hidden = !isPersonTab();
    if (!isPersonTab()) return;
    const counts = {
      daily: tasksFor(active, "daily"),
      weekly: tasksFor(active, "weekly"),
      monthly: tasksFor(active, "monthly"),
    };
    el.subtabs.replaceChildren(
      ...VIEWS.map(({ key, label }) => {
        const btn = h("button", "subtab subtab-" + key);
        btn.type = "button";
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", String(key === view));
        btn.append(h("span", "", label));
        if (counts[key]) {
          btn.append(h("span", "tab-count", countStatuses(counts[key]).done + "/" + counts[key].length));
        } else if (key === "pending") {
          const n = pendingFor(active).length;
          btn.append(h("span", "tab-count" + (n ? " count-alert" : ""), n));
        } else if (key === "reminders") {
          const n = dueReminders(active).length;
          if (n) btn.append(h("span", "tab-count count-warn", n));
        }
        btn.addEventListener("click", () => setView(key));
        return btn;
      })
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

  function renderPeriodLine() {
    const show = isTaskView() && view !== "daily";
    el.periodLine.hidden = !show;
    if (!show) return;
    if (view === "weekly") {
      const ws = weekStart(selectedDate);
      el.periodLine.textContent = "Week of " + shortDate(ws) + " – " + shortDate(addDays(ws, 6)) + (ws === weekStart(todayStr) ? " (this week)" : "");
    } else {
      el.periodLine.textContent =
        parseYmd(selectedDate).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) +
        (monthStart(selectedDate) === monthStart(todayStr) ? " (this month)" : "");
    }
  }

  // Times can't be typed in. For the current day/week/month (or a pending
  // item), an empty time shows a Start / End button that stamps the time
  // once; after that it's locked. Everything else is view-only.
  function timeCell(task, entry, field, key, editable) {
    const td = h("td", "time-cell");
    td.dataset.label = field === "start_time" ? "Start" : "End";
    const wrap = h("div", "time-wrap");
    const onDay = field === "start_time" ? entry.started_on : entry.ended_on;

    if (entry[field]) {
      const value = h("span", "time-value", formatClock(entry[field]));
      value.title = "Recorded time (locked)";
      wrap.append(value);
      if (onDay && onDay !== key) wrap.append(h("span", "time-day", dayDate(onDay)));
    } else if (editable) {
      const isStart = field === "start_time";
      const btn = h("button", "btn-stamp " + (isStart ? "btn-stamp-start" : "btn-stamp-end"), isStart ? "Start" : "End");
      btn.type = "button";
      btn.setAttribute("aria-label", (isStart ? "Start " : "End ") + task.title + " now");
      if (!isStart && !entry.start_time) {
        btn.disabled = true;
        btn.title = "Start the task first";
      }
      btn.addEventListener("click", () => stampTime(task, key, field));
      wrap.append(btn);
    } else {
      wrap.append(h("span", "time-none", "—"));
    }
    td.append(wrap);
    return td;
  }

  function takenCell(entry, running) {
    const taken = h("td", "taken-cell");
    taken.dataset.label = "Taken";
    const status = statusOf(entry);
    const mins = minutesTaken(entry, running);
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
    return taken;
  }

  // People listed in DONE_COUNTERS get a per-task count column (e.g. videos)
  // on their daily list.
  function countsItems() {
    return isPersonTab() && view === "daily" && Boolean(DONE_COUNTERS[active]);
  }

  function quantityCell(task, entry, key, editable) {
    const td = h("td", "qty-cell");
    td.dataset.label = capitalize(DONE_COUNTERS[active]);
    const wrap = h("div", "qty-wrap");
    const value = entry.quantity || 0;

    if (!editable) {
      wrap.append(h("span", "qty-value", value));
      td.append(wrap);
      return td;
    }

    const minus = h("button", "btn-step btn-qty", "−");
    minus.type = "button";
    minus.disabled = value <= 0;
    minus.setAttribute("aria-label", "One less for " + task.title);
    minus.addEventListener("click", () => setQuantity(task, key, value - 1));

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
      setQuantity(task, key, Number.isFinite(n) && n > 0 ? n : null);
    });

    const plus = h("button", "btn-step btn-qty", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", "One more for " + task.title);
    plus.addEventListener("click", () => setQuantity(task, key, value + 1));

    wrap.append(minus, input, plus);
    td.append(wrap);
    return td;
  }

  function dueOptions(select, frequency, selected) {
    if (frequency === "weekly") {
      select.replaceChildren(...WEEKDAYS.map((d, i) => option(String(i + 1), d)));
    } else {
      select.replaceChildren(...Array.from({ length: 31 }, (_, i) => option(String(i + 1), ordinal(i + 1) + " of the month")));
    }
    select.value = String(selected || 1);
  }

  // Admin: edit a task in place (name, type, due day, who it's assigned to).
  function editRow(task, colspan) {
    const tr = h("tr", "edit-row");
    const td = h("td");
    td.colSpan = colspan;
    const form = h("form", "assign-form edit-form");
    form.autocomplete = "off";

    const titleField = h("label", "field field-grow");
    const title = document.createElement("input");
    title.type = "text";
    title.maxLength = 200;
    title.required = true;
    title.value = task.title;
    titleField.append(h("span", "", "Task"), title);

    const freqField = h("label", "field");
    const freq = document.createElement("select");
    freq.append(option("daily", "Daily"), option("weekly", "Weekly"), option("monthly", "Monthly"));
    freq.value = task.frequency || "daily";
    freqField.append(h("span", "", "Type"), freq);

    const dueField = h("label", "field");
    const due = document.createElement("select");
    const dueCaption = h("span", "", "Due on");
    dueField.append(dueCaption, due);
    const syncDue = () => {
      dueField.hidden = freq.value === "daily";
      if (freq.value !== "daily") dueOptions(due, freq.value, freq.value === task.frequency ? task.due_day : 1);
    };
    freq.addEventListener("change", syncDue);
    syncDue();

    const whoField = h("label", "field");
    const who = document.createElement("select");
    who.append(...employees.map((n) => option(n, n)));
    who.value = task.employee;
    whoField.append(h("span", "", "Assigned to"), who);

    const saveBtn = h("button", "btn-primary", "Save");
    saveBtn.type = "submit";
    const cancel = h("button", "btn-link", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      editingTaskId = null;
      render();
    });

    form.append(titleField, freqField, dueField, whoField, saveBtn, cancel);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const changes = { title: title.value.trim(), frequency: freq.value, employee: who.value };
      if (freq.value !== "daily") changes.due_day = Number(due.value);
      try {
        await store.updateTask(task.id, changes);
      } catch (err) {
        if (!handleAuthError(err)) showToast("Couldn't save: " + err.message);
        return;
      }
      editingTaskId = null;
      showToast(
        changes.employee !== task.employee
          ? "Moved “" + changes.title + "” to " + changes.employee
          : "Saved “" + changes.title + "” as a " + FREQ_LABEL[changes.frequency].toLowerCase() + " task"
      );
      refresh();
    });
    td.append(form);
    tr.append(td);
    setTimeout(() => title.focus(), 0);
    return tr;
  }

  function rowTools(task, i, list) {
    const tools = h("div", "row-tools");
    const up = iconButton("up", "Move " + task.title + " up", "btn-tool", () => moveTask(task, -1));
    up.disabled = i === 0;
    const down = iconButton("down", "Move " + task.title + " down", "btn-tool", () => moveTask(task, 1));
    down.disabled = i === list.length - 1;
    const copy = iconButton("copy", "Duplicate " + task.title, "btn-tool", () => duplicateTask(task));
    tools.append(up, down, copy);
    if (isAdmin()) {
      const edit = iconButton("edit", "Edit " + task.title, "btn-tool", () => {
        editingTaskId = editingTaskId === task.id ? null : task.id;
        render();
      });
      tools.append(edit);
    }
    const del = iconButton("trash", "Delete " + task.title, "btn-tool btn-delete", () => {
      // Two-step delete: first click arms the button, second click deletes.
      if (del.classList.contains("armed")) return deleteTask(task);
      del.classList.add("armed");
      del.textContent = "Delete?";
      setTimeout(() => render(), 3000);
    });
    tools.append(del);
    return tools;
  }

  function renderRows(list) {
    const colspan = 7 + (countsItems() ? 1 : 0);
    const rows = [];
    list.forEach((task, i) => {
      const tr = document.createElement("tr");
      const key = occurrenceKey(task, selectedDate);
      const entry = entryFor(task);
      const editable = isCurrent(task);
      const status = statusFor(task);

      const num = h("td", "num", i + 1);
      const title = h("td", "title");
      title.append(h("span", "", task.title));
      const due = dueLabel(task);
      if (due) title.append(h("span", "task-due", due));

      const st = h("td", "status-cell");
      st.append(h("span", "pill status-" + status, STATUS_LABEL[status]));

      const actions = h("td", "actions");
      actions.append(rowTools(task, i, list));

      tr.append(
        num,
        title,
        timeCell(task, entry, "start_time", key, editable),
        timeCell(task, entry, "end_time", key, editable),
        st,
        ...(countsItems() ? [quantityCell(task, entry, key, editable)] : []),
        takenCell(entry, editable),
        actions
      );
      rows.push(tr);
      if (editingTaskId === task.id) rows.push(editRow(task, colspan));
    });
    el.rows.replaceChildren(...rows);
    el.empty.hidden = list.length > 0;
    const kind = view === "daily" ? "daily" : view === "weekly" ? "weekly" : "monthly";
    el.empty.textContent = "No " + kind + " tasks yet. Add one below.";
  }

  // ---- Pending view ------------------------------------------------------------

  function renderPendingView() {
    const items = pendingFor(active);
    el.pendingHelp.textContent =
      (isAdmin() ? active + "'s" : "Your") +
      " daily tasks not finished on their day, and weekly or monthly tasks not finished by their due day." +
      (isAdmin() ? " Excuse an item if it wasn't needed (e.g. a day off)." : " Press Start and End to finish them now.");
    el.pendingRows.replaceChildren(
      ...items.map(({ task, key, due, entry }) => {
        const tr = document.createElement("tr");
        const title = h("td", "title");
        title.append(h("span", "", task.title), h("span", "freq-badge freq-" + (task.frequency || "daily"), FREQ_LABEL[task.frequency || "daily"]));
        const dueTd = h("td", "due-cell", dayDate(due));
        dueTd.dataset.label = "Was due";
        const late = daysBetween(due, todayStr);
        const lateTd = h("td", "late-cell", late + (late === 1 ? " day" : " days"));
        lateTd.dataset.label = "Late by";
        const st = h("td", "status-cell");
        const s = statusOf(entry);
        st.append(h("span", "pill status-" + (s === "in_progress" ? "in_progress" : "overdue"), s === "in_progress" ? "In Progress" : "Pending"));
        const actions = h("td", "actions");
        if (isAdmin()) {
          const excuse = h("button", "btn-link", "Excuse");
          excuse.type = "button";
          excuse.title = "Remove from pending (e.g. a day off)";
          excuse.addEventListener("click", () => excuseItem(task, key));
          actions.append(excuse);
        }
        tr.append(title, dueTd, lateTd, timeCell(task, entry, "start_time", key, true), timeCell(task, entry, "end_time", key, true), st, actions);
        return tr;
      })
    );
    el.pendingEmpty.hidden = items.length > 0;
  }

  // ---- Reminders view ----------------------------------------------------------

  function renderReminders() {
    const mine = reminders.filter((r) => r.employee === active);
    const open = mine.filter((r) => !r.done_at);
    const groups = [
      { label: "Overdue", cls: "rem-overdue", items: open.filter((r) => r.due_date < todayStr) },
      { label: "Today", cls: "rem-today", items: open.filter((r) => r.due_date === todayStr) },
      { label: "Upcoming", cls: "rem-upcoming", items: open.filter((r) => r.due_date > todayStr) },
      { label: "Done (last 14 days)", cls: "rem-done", items: mine.filter((r) => r.done_at) },
    ];
    const blocks = groups
      .filter((g) => g.items.length)
      .map((g) => {
        const block = h("div", "rem-group " + g.cls);
        block.append(h("h3", "", g.label + " · " + g.items.length));
        const list = h("ul", "rem-list");
        for (const r of g.items) {
          const li = h("li", "rem-item");
          const check = iconButton("check", (r.done_at ? "Mark not done: " : "Mark done: ") + r.title, "rem-check" + (r.done_at ? " is-done" : ""), async () => {
            try {
              await store.setReminderDone(r.id, !r.done_at);
            } catch (e) {
              if (!handleAuthError(e)) showToast("Couldn't save: " + e.message);
            }
            refresh();
          });
          const body = h("div", "rem-body");
          body.append(h("span", "rem-title", r.title));
          const meta = dayDate(r.due_date) + (r.due_time ? " · " + formatClock(r.due_time) : "") + (r.created_by && r.created_by !== r.employee ? " · from " + r.created_by : "");
          body.append(h("span", "rem-meta", meta));
          const del = iconButton("trash", "Delete reminder: " + r.title, "btn-tool btn-delete", async () => {
            if (!del.classList.contains("armed")) {
              del.classList.add("armed");
              del.textContent = "Delete?";
              setTimeout(() => render(), 3000);
              return;
            }
            try {
              await store.removeReminder(r.id);
            } catch (e) {
              if (!handleAuthError(e)) showToast("Couldn't delete: " + e.message);
            }
            refresh();
          });
          li.append(check, body, del);
          list.append(li);
        }
        block.append(list);
        return block;
      });
    if (!blocks.length) blocks.push(h("p", "empty", "No reminders yet. Add one above."));
    el.reminderGroups.replaceChildren(...blocks);
    if (!el.reminderDate.value) el.reminderDate.value = todayStr;
  }

  el.reminderForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = el.reminderTitle.value.trim();
    if (!title || !isPersonTab()) return;
    try {
      await store.addReminder({ employee: active, title, due_date: el.reminderDate.value || todayStr, due_time: el.reminderTime.value || null });
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't add the reminder: " + err.message);
      return;
    }
    el.reminderTitle.value = "";
    el.reminderTime.value = "";
    showToast("Reminder added for " + dayDate(el.reminderDate.value || todayStr));
    refresh();
  });

  // ---- Admin: overview of everyone on the selected day -----------------------

  function renderOverview() {
    const dayText = isToday() ? "today" : dayDate(selectedDate);
    el.ovDate.textContent = dayText;
    el.ovNotesDate.textContent = isToday() ? "Today" : dayDate(selectedDate);

    let done = 0;
    let total = 0;
    let running = 0;
    let pendingTotal = 0;
    const pendingBlocks = [];
    const cards = employees.map((name) => {
      const list = tasksFor(name, "daily");
      const c = countStatuses(list);
      done += c.done;
      total += list.length;
      const all = tasksFor(name);
      const now = all.filter((t) => statusOf(entryFor(t)) === "in_progress");
      running += now.length;
      const pending = pendingFor(name);
      pendingTotal += pending.length;

      const card = h("button", "ov-card");
      card.type = "button";
      card.setAttribute("aria-label", "Open " + name + "'s tasks");
      card.addEventListener("click", () => setActiveTab(name, "daily"));

      const head = h("div", "ov-card-head");
      const av = h("span", "avatar");
      paintAvatar(av, name);
      head.append(av, h("strong", "ov-name", name), h("span", "ov-count", c.done + "/" + list.length));

      const bar = h("div", "ov-bar");
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", c.done + " of " + list.length + " daily tasks done, " + c.in_progress + " in progress");
      const pct = (n) => (list.length ? (n / list.length) * 100 : 0) + "%";
      const fillDone = h("span", "ov-bar-done");
      fillDone.style.width = pct(c.done);
      const fillRun = h("span", "ov-bar-running");
      fillRun.style.width = pct(c.in_progress);
      bar.append(fillDone, fillRun);

      const nowLine = h("p", "ov-now");
      if (now.length) {
        const e = entryFor(now[0]);
        nowLine.append(h("span", "ov-now-dot"), h("span", "ov-now-title", now[0].title));
        nowLine.append(h("span", "ov-now-meta", " · since " + formatClock(e.start_time) + (now.length > 1 ? " · +" + (now.length - 1) + " more" : "")));
      } else {
        nowLine.classList.add("ov-idle");
        nowLine.textContent = c.done === list.length && list.length ? "All daily tasks done" : "Nothing in progress";
      }

      const stats = h("dl", "ov-stats");
      const stat = (label, value, cls) => {
        const d = h("div", cls || "");
        d.append(h("dt", "", label), h("dd", "", value));
        stats.append(d);
      };
      stat("Time", formatDuration(finishedMinutes(list)));
      stat("Pending", pending.length, pending.length ? "stat-alert" : "");
      if (DONE_COUNTERS[name]) stat(capitalize(DONE_COUNTERS[name]), quantityTotal(list));
      const remDue = dueReminders(name).length;
      if (remDue) stat("Reminders", remDue, "stat-warn");

      card.append(head, bar, nowLine, stats);

      // Pending work, grouped by person.
      const block = h("div", "ovp-person" + (pending.length ? "" : " is-clear"));
      const pHead = h("button", "ovp-head");
      pHead.type = "button";
      const pav = h("span", "avatar avatar-sm");
      paintAvatar(pav, name);
      pHead.append(pav, h("strong", "", name), h("span", "tab-count" + (pending.length ? " count-alert" : ""), pending.length ? pending.length + " pending" : "All caught up"));
      pHead.addEventListener("click", () => setActiveTab(name, "pending"));
      block.append(pHead);
      if (pending.length) {
        const ul = h("ul", "ovp-list");
        for (const item of pending.slice(0, 5)) {
          const li = h("li");
          const late = daysBetween(item.due, todayStr);
          li.append(
            h("span", "ovp-title", item.task.title),
            h("span", "freq-badge freq-" + (item.task.frequency || "daily"), FREQ_LABEL[item.task.frequency || "daily"]),
            h("span", "ovp-meta", "due " + dayDate(item.due) + " · " + late + (late === 1 ? " day" : " days") + " late")
          );
          ul.append(li);
        }
        if (pending.length > 5) {
          const more = h("li", "ovp-more", "+ " + (pending.length - 5) + " more");
          ul.append(more);
        }
        block.append(ul);
      }
      pendingBlocks.push({ count: pending.length, block });
      return card;
    });
    el.ovCards.replaceChildren(...cards);
    el.ovPending.replaceChildren(...pendingBlocks.sort((a, b) => b.count - a.count).map((x) => x.block));
    el.ovPendingTotal.textContent = pendingTotal ? pendingTotal + " pending" : "Nothing pending";
    el.ovPendingTotal.className = "ov-total " + (pendingTotal ? "status-todo" : "status-done");

    const chip = (n, label, cls) => {
      const c = h("span", "ov-total " + cls);
      c.append(h("strong", "", n), h("span", "", label));
      return c;
    };
    el.ovTotals.replaceChildren(chip(done + "/" + total, "daily tasks done", "status-done"), chip(running, "in progress", "status-in_progress"));

    // Everyone's notes for the day.
    const noteBlocks = employees
      .filter((name) => (notes.get(name) || "").trim())
      .map((name) => {
        const b = h("button", "ovn-item");
        b.type = "button";
        b.title = "Open " + name + "'s tasks";
        b.addEventListener("click", () => setActiveTab(name));
        const head = h("div", "ovn-head");
        const av = h("span", "avatar avatar-sm");
        paintAvatar(av, name);
        head.append(av, h("strong", "", name));
        b.append(head, h("p", "ovn-body", notes.get(name).trim()));
        return b;
      });
    if (!noteBlocks.length) noteBlocks.push(h("p", "empty", "No notes written " + (isToday() ? "today" : "on this day") + " yet."));
    el.ovNotes.replaceChildren(...noteBlocks);

    // Keep the "Assign to" list in step with the team.
    const current = el.assignTo.value;
    if (employees.join("\u0001") !== Array.from(el.assignTo.options, (o) => o.value).join("\u0001")) {
      el.assignTo.replaceChildren(...employees.map((name) => option(name, name)));
      if (employees.includes(current)) el.assignTo.value = current;
    }
  }

  function syncAssignDue() {
    const f = el.assignFreq.value;
    el.assignDueField.hidden = f === "daily";
    el.assignDueLabel.textContent = f === "weekly" ? "Due on (weekday)" : "Due on (day of month)";
    if (f !== "daily") dueOptions(el.assignDue, f, 1);
  }
  el.assignFreq.addEventListener("change", syncAssignDue);

  // ---- Admin: reports --------------------------------------------------------

  let reportData = null;

  function reportRange() {
    const preset = el.repPreset.value;
    const t = parseYmd(todayStr);
    switch (preset) {
      case "today":
        return [todayStr, todayStr];
      case "yesterday":
        return [addDays(todayStr, -1), addDays(todayStr, -1)];
      case "week":
        return [weekStart(todayStr), todayStr];
      case "last7":
        return [addDays(todayStr, -6), todayStr];
      case "month":
        return [monthStart(todayStr), todayStr];
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
    const blank = () => ({ days: new Set(), done: 0, started: 0, minutes: 0, quantity: 0 });
    const byEmp = new Map(employees.map((name) => [name, blank()]));
    for (const r of reportData ? reportData.rows : []) {
      if (!byEmp.has(r.employee)) byEmp.set(r.employee, blank());
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
    ["Employee", "Days worked", "Tasks done", "Time taken", "Avg per day", "Pending now"].concat(hasQty ? [qtyLabel] : []).forEach((label, i) => {
      headRow.append(h("th", i ? "num-col" : "", label));
    });
    el.repHead.replaceChildren(headRow);

    const totals = reportTotals();
    let sumDays = 0, sumDone = 0, sumMin = 0, sumQty = 0, sumPending = 0;
    const rows = [];
    for (const [name, x] of totals) {
      const tr = h("tr");
      const who = h("td", "rep-name");
      const av = h("span", "avatar avatar-sm");
      paintAvatar(av, name);
      who.append(av, h("span", "", name));
      const pending = employees.includes(name) ? pendingFor(name).length : 0;
      tr.append(
        who,
        h("td", "num-col", x.days.size),
        h("td", "num-col", x.done),
        h("td", "num-col", formatDuration(x.minutes)),
        h("td", "num-col", x.days.size ? formatDuration(Math.round(x.minutes / x.days.size)) : "—"),
        h("td", "num-col" + (pending ? " cell-alert" : ""), pending)
      );
      if (hasQty) tr.append(h("td", "num-col", DONE_COUNTERS[name] ? x.quantity : "—"));
      rows.push(tr);
      sumDays += x.days.size;
      sumDone += x.done;
      sumMin += x.minutes;
      sumQty += x.quantity;
      sumPending += pending;
    }
    el.repBody.replaceChildren(...rows);

    const foot = h("tr");
    foot.append(h("td", "", "Total"), h("td", "num-col", sumDays), h("td", "num-col", sumDone), h("td", "num-col", formatDuration(sumMin)), h("td", "num-col", ""), h("td", "num-col", sumPending));
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
    const frequency = el.assignFreq.value;
    if (!title || !employee) return;
    const row = { employee, title, frequency };
    if (frequency !== "daily") row.due_day = Number(el.assignDue.value);
    try {
      await store.insertTask(row);
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't assign the task: " + err.message);
      return;
    }
    el.assignTitle.value = "";
    showToast("Assigned “" + title + "” to " + employee + " as a " + FREQ_LABEL[frequency].toLowerCase() + " task");
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
    // Don't rebuild the table under someone who is mid-edit in a field;
    // catch up once they leave it.
    const focused = document.activeElement;
    if (focused && (focused.type === "number" || focused.closest(".edit-form")) && el.rows.contains(focused)) {
      renderPending = true;
      return;
    }
    renderPending = false;
    renderHeaderWidget();
    renderTabs();
    renderSubtabs();

    const person = isPersonTab();
    el.overview.hidden = active !== OVERVIEW;
    el.team.hidden = active !== TEAM;
    el.tasksPanel.hidden = !person || !isTaskView();
    el.pendingPanel.hidden = !person || view !== "pending";
    el.remindersPanel.hidden = !person || view !== "reminders";
    el.notesPanel.hidden = !person;

    el.pageTitle.textContent = isAdmin() ? "Team SOP Dashboard" : me.name + "’s Tasks";

    const list = person && isTaskView() ? tasksFor(active, view) : [];
    renderDoneCounter(list);
    if (active === OVERVIEW) renderOverview();
    if (active === TEAM) renderTeam();
    if (!person) return;

    renderNotes();
    if (view === "pending") return renderPendingView();
    if (view === "reminders") return renderReminders();

    renderPeriodLine();
    renderSpotlight(list);
    renderSummary(list);
    el.qtyHead.hidden = !countsItems();
    if (countsItems()) el.qtyHead.textContent = capitalize(DONE_COUNTERS[active]) + " Done";
    renderRows(list);
    el.addForm.hidden = false;
    el.addDue.hidden = view === "daily";
    if (view !== "daily" && el.addDue.dataset.freq !== view) {
      dueOptions(el.addDue, view, 1);
      el.addDue.dataset.freq = view;
    }
    el.addInput.placeholder = isAdmin() ? "Add a " + view + " task for " + active + "…" : "Add a " + view + " task…";
  }

  el.rows.addEventListener("focusout", () => {
    setTimeout(() => renderPending && render(), 0);
  });

  // Save a change to one occurrence's entry. The server's reply carries the
  // recorded times, which replace the ones shown optimistically.
  async function saveEntryField(task, key, field, value) {
    const mapKey = task.id + "|" + key;
    const current = entries.get(mapKey) || recent.get(mapKey) || EMPTY_ENTRY;
    const next = { ...current, [field]: value };
    if (field === "start_time" && value) next.started_on = todayStr;
    if (field === "end_time" && value) next.ended_on = todayStr;
    const apply = (e) => {
      if (entries.has(mapKey) || occurrenceKey(task, selectedDate) === key) entries.set(mapKey, e);
      if (recent.has(mapKey) || key >= pendingWindowStart()) recent.set(mapKey, e);
    };
    apply(next);
    render();
    try {
      const saved = await store.saveEntry(task.id, key, {
        start_time: next.start_time,
        end_time: next.end_time,
        quantity: next.quantity,
      });
      if (saved) apply({ ...next, ...saved });
      render();
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't save: " + e.message);
      refresh();
    }
  }

  function stampTime(task, key, field) {
    const e = entries.get(task.id + "|" + key) || recent.get(task.id + "|" + key) || EMPTY_ENTRY;
    if (e[field]) return; // write-once
    if (field === "end_time" && !e.start_time) return;
    saveEntryField(task, key, field, nowHHMM());
  }

  function setQuantity(task, key, value) {
    saveEntryField(task, key, "quantity", value > 0 ? value : null);
  }

  async function excuseItem(task, key) {
    const mapKey = task.id + "|" + key;
    const current = recent.get(mapKey) || entries.get(mapKey) || EMPTY_ENTRY;
    recent.set(mapKey, { ...current, skipped: true });
    render();
    try {
      await store.skipEntry(task.id, key, true);
      showToast("Excused “" + task.title + "” for " + dayDate(key));
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't excuse: " + e.message);
      refresh();
    }
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
    // Moving within the visible list (e.g. weekly tasks) keeps the other
    // lists' relative order: renumber the whole person's list around it.
    const all = tasksFor(task.employee);
    const visible = tasksFor(task.employee, task.frequency || "daily");
    const i = visible.findIndex((t) => t.id === task.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= visible.length) return;
    const a = all.indexOf(visible[i]);
    const b = all.indexOf(visible[j]);
    [all[a], all[b]] = [all[b], all[a]];
    try {
      await applyOrder(all);
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

  async function deleteTask(task) {
    tasks = tasks.filter((t) => t.id !== task.id);
    render();
    try {
      await store.removeTask(task.id);
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't delete: " + e.message);
      refresh();
    }
  }

  el.addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = el.addInput.value.trim();
    if (!title || !isPersonTab() || !isTaskView()) return;
    const row = { employee: active, title, frequency: view };
    if (view !== "daily") row.due_day = Number(el.addDue.value);
    el.addInput.value = "";
    try {
      await store.insertTask(row);
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
    el.notesInput.placeholder = "Notes for " + (isAdmin() ? active : "you") + (isToday() ? " today" : " on this day") + "… (the admin can read these)";
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
  // (a dashboard left open on today moves on to the new day, and yesterday's
  // unfinished daily tasks become pending).
  setInterval(() => {
    const now = ymd(new Date());
    if (now !== todayStr) {
      const wasToday = isToday();
      todayStr = now;
      if (wasToday) return setDate(now);
      refresh();
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
    el.authAdmin.hidden = step !== "admin";
    const focus =
      step === "site" ? el.sitePassword : step === "user" ? el.userPassword : step === "admin" ? el.adminPassword : el.people.querySelector("button");
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
    // Admin isn't listed here: the admin signs in at the admin address.
    el.people.replaceChildren(...users.map((u) => person(u.name, false, u.has_password ? "" : "No password yet")));
  }

  // Show whichever sign-in step this browser is on, or open the dashboard.
  async function applySession(s) {
    // Never run ahead of the server's date (it refuses times for future days).
    if (s.today) todayStr = s.today < ymd(new Date()) ? s.today : ymd(new Date());
    if (MODE === "admin") {
      if (!s.user) {
        me = null;
        el.adminPassword.value = "";
        el.adminError.textContent = "";
        return showAuthStep("admin");
      }
      return enterApp(s);
    }
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
    trackingStart = s.tracking_start || todayStr;
    el.auth.hidden = true;
    el.app.hidden = false;
    paintAvatar(el.userAvatar, me.name, isAdmin());
    el.userName.textContent = me.name;
    el.userRole.hidden = !isAdmin();
    el.switchUser.hidden = isAdmin(); // the admin site has only one sign-in

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
    recent = new Map();
    notes = new Map();
    reminders = [];
    noteShownFor = "";
    editingTaskId = null;
    active = isAdmin() ? readPref("tab", (v) => v === OVERVIEW || v === TEAM || employees.includes(v), OVERVIEW) : employees[0];
    view = readPref("view", (v) => VIEWS.some((x) => x.key === v), "daily");
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

  el.authAdmin.addEventListener("submit", async (e) => {
    e.preventDefault();
    el.adminError.textContent = "";
    try {
      await applySession(await store.adminLogin(el.adminPassword.value));
    } catch (err) {
      el.adminError.textContent = err.message;
      el.adminPassword.select();
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

  // Preview only: switching between the team and admin side (#admin) reloads.
  if (config.backend !== "php") window.addEventListener("hashchange", () => location.reload());

  async function start() {
    store = createStore();
    syncAssignDue();
    renderClock();
    if (MODE === "admin") document.title = "Admin · Team SOP Dashboard";
    if (store.mode === "local") {
      showBanner(
        MODE === "admin"
          ? "Preview of the admin site: data is saved in this browser only. Admin password: " + DEMO.admin
          : "Preview mode: data is saved in this browser only. Dashboard password: " + DEMO.site +
              " · Employee password: " + DEMO.employee + " · Admin preview: add #admin to the address"
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

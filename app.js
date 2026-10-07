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

  // ---- Inactivity sign-out ---------------------------------------------------
  // After IDLE minutes with no mouse, keyboard, touch or scrolling in the page
  // (in any open tab of this site), the person is signed out as if they had
  // pressed Lock. The server enforces the same limit; the page tells it when
  // the person is actually active, so background update checks don't count.
  let idleMinutes = 120; // replaced by the server's setting after sign-in
  const ACTIVITY_KEY = "sop-dashboard:last-activity:" + MODE;
  let lastActivity = Date.now();
  let lastActivitySaved = 0;

  function lastActive() {
    let shared = 0;
    try {
      shared = Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
    } catch (e) {}
    return Math.max(lastActivity, shared);
  }

  function markActive() {
    lastActivity = Date.now();
    if (lastActivity - lastActivitySaved > 15000) {
      lastActivitySaved = lastActivity;
      try {
        localStorage.setItem(ACTIVITY_KEY, String(lastActivity));
      } catch (e) {}
    }
  }

  function recentlyActive() {
    return Date.now() - lastActive() < 5 * 60 * 1000;
  }

  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"]) {
    window.addEventListener(type, markActive, { passive: true, capture: true });
  }

  // Flatten SEED_TASKS into rows: { employee, title, position, frequency, due_day }.
  // An entry is a title (a daily task) or { title, days: ["Mon", "Wed"] }
  // for a task on set weekdays, or { title, frequency, due_day }.
  function seedRows() {
    const rows = [];
    for (const employee of Object.keys(window.SEED_TASKS)) {
      (window.SEED_TASKS[employee] || []).forEach((item, i) => {
        if (typeof item === "string") return rows.push({ employee, title: item, position: i });
        const row = { employee, title: item.title, position: i };
        if (item.days) Object.assign(row, freqFromDays(item.days.map((d) => SHORT_DAYS.indexOf(d.slice(0, 3)) + 1)));
        else if (item.dates) Object.assign(row, freqFromDates(item.dates));
        else if (item.frequency) Object.assign(row, { frequency: item.frequency, due_day: item.due_day ?? null });
        rows.push(row);
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

  // Started, not finished, and the clock is stopped.
  function isPaused(entry) {
    return Boolean(entry.start_time && !entry.end_time && entry.worked_sec != null && !entry.resumed_at);
  }

  const STATUS_LABEL = { todo: "To Do", in_progress: "In Progress", paused: "Paused", done: "Done", overdue: "Overdue", excused: "Excused" };
  const EMPTY_ENTRY = Object.freeze({ start_time: null, end_time: null, started_on: null, ended_on: null, quantity: null, skipped: false, worked_sec: null, resumed_at: null });
  const OVERVIEW = "\u0000overview";
  const TEAM = "\u0000team";
  const REPORTS = "\u0000reports";
  // "weekdays" tasks happen on set days of the week (due_day is a bitmask,
  // Monday = 1, Tuesday = 2, Wednesday = 4 ... Sunday = 64). On those days
  // they're part of the daily list; the weekly list shows the whole week.
  // "monthdays" tasks happen on set dates of the month (due_day is a bitmask,
  // 1st = 1, 2nd = 2, 3rd = 4 ...). A date on a Saturday moves to the Friday
  // before, a Sunday to the Monday after. On those dates they're part of the
  // daily list; the monthly list shows the whole month.
  // "monthstart" tasks are worked on over the first working days of the month
  // (due_day = how many Monday-Friday days, e.g. 6). They're in the daily list
  // on each of those days with one record for the month, so they don't reset.
  const FREQ_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", weekdays: "Set days", monthdays: "Set dates", monthstart: "Start of month" };
  const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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
    if (entry.worked_sec != null) {
      // Paused work doesn't count: finished stretches plus the running one.
      if (!entry.end_time && !running) return null;
      let sec = entry.worked_sec;
      if (!entry.end_time && entry.resumed_at) sec += Math.max(0, (new Date() - atTime(...entry.resumed_at.split(" "))) / 1000);
      return Math.round(sec / 60);
    }
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

  // Totals of work time: hours and minutes, never days ("143h 20m").
  function formatHours(min) {
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
    if (task.frequency === "monthly" || task.frequency === "monthstart") return monthStart(date);
    return date;
  }

  function dueDate(task, key) {
    if (task.frequency === "weekly") return addDays(key, (task.due_day || 1) - 1);
    if (task.frequency === "monthly") return addDays(key, Math.min(task.due_day || 1, daysInMonth(key)) - 1);
    if (task.frequency === "monthstart") return windowEnd(key, task.due_day || 1);
    return key;
  }

  function addMonths(s, n) {
    const d = parseYmd(s);
    const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
    return ymd(new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)));
  }

  // A task can run for a set time: starts_on / ends_on (null = open-ended).
  function activeIn(task, from, to) {
    return (!task.starts_on || task.starts_on <= to) && (!task.ends_on || task.ends_on >= from);
  }

  // "Delete for now" hides a task for a day, a week or a month.
  function skippedFor(task, from, to) {
    return (task.skips || []).some(([a, b]) => a <= from && b >= to);
  }

  // The days a Daily / Weekly / Monthly list covers for a date.
  function viewSpan(which, date) {
    if (which === "weekly") return [weekStart(date), addDays(weekStart(date), 6)];
    if (which === "monthly") return [monthStart(date), addDays(nextMonth(monthStart(date)), -1)];
    return [date, date];
  }

  // Start / end dates for a new task: once (today, this week or this month
  // only), or repeating for a number of days, weeks or months (or always).
  function newTaskSpan(which, once, count, unit) {
    if (once) {
      const [from, to] = viewSpan(which, todayStr);
      return { starts_on: from, ends_on: to };
    }
    const n = Math.floor(Number(count));
    if (unit === "always" || !n || n < 1) return { starts_on: todayStr, ends_on: null };
    const end = unit === "months" ? addMonths(todayStr, n) : addDays(todayStr, unit === "weeks" ? n * 7 : n);
    return { starts_on: todayStr, ends_on: addDays(end, -1) };
  }

  function spanLabel(task) {
    const s = task.starts_on;
    const e = task.ends_on;
    if (!e) return s && s > todayStr ? "Starts " + dayDate(s) : "";
    if (s && s === e) return s === todayStr ? "Today only" : "Only on " + dayDate(s);
    if (s && s === weekStart(s) && e === addDays(s, 6)) return s === weekStart(todayStr) ? "This week only" : "Week of " + shortDate(s) + " only";
    if (s && s === monthStart(s) && e === addDays(nextMonth(s), -1)) return s === monthStart(todayStr) ? "This month only" : parseYmd(s).toLocaleDateString("en-GB", { month: "long" }) + " only";
    return (e < todayStr ? "Ended " : "Until ") + dayDate(e);
  }

  // Repeat choices, worded for the kind of task.
  function repeatOptions(select, which) {
    const words = which === "daily" ? ["Every day", "Today only"] : which === "weekly" ? ["Every week", "This week only"] : ["Every month", "This month only"];
    const value = select.value || "repeat";
    select.replaceChildren(option("repeat", words[0]), option("once", words[1]));
    select.value = value;
  }

  // The last of the first n Monday-Friday days of a month (key = its 1st):
  // each Saturday or Sunday in between adds a day.
  function windowEnd(key, n) {
    let d = key;
    for (let left = n; ; d = addDays(d, 1)) {
      const wd = parseYmd(d).getDay();
      if (wd !== 0 && wd !== 6 && --left === 0) return d;
    }
  }

  // Day of the week, Monday = 1 ... Sunday = 7.
  function isoDay(date) {
    return ((parseYmd(date).getDay() + 6) % 7) + 1;
  }

  function maskDays(mask) {
    return [1, 2, 3, 4, 5, 6, 7].filter((d) => mask & (1 << (d - 1)));
  }

  // One chosen day = a weekly task due that day; several = set weekdays.
  function freqFromDays(days) {
    const list = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort();
    if (list.length === 1) return { frequency: "weekly", due_day: list[0] };
    return { frequency: "weekdays", due_day: list.reduce((m, d) => m | (1 << (d - 1)), 0) };
  }

  // One date = a monthly task due by that date; several = set dates.
  function freqFromDates(dates) {
    const list = [...new Set(dates.map(Number))].filter((d) => d >= 1 && d <= 31).sort((a, b) => a - b);
    if (list.length === 1) return { frequency: "monthly", due_day: list[0] };
    return { frequency: "monthdays", due_day: list.reduce((m, d) => m | (1 << (d - 1)), 0) };
  }

  function maskDates(mask) {
    return Array.from({ length: 31 }, (_, i) => i + 1).filter((d) => mask & (1 << (d - 1)));
  }

  // The actual dates of a set-dates task in one month (key = its 1st), with
  // weekends moved to the nearest weekday inside the month.
  function monthDates(task, key) {
    const n = daysInMonth(key);
    const month = key.slice(0, 7);
    const out = new Set();
    for (const d of maskDates(task.due_day || 0)) {
      const base = addDays(key, Math.min(d, n) - 1);
      const wd = parseYmd(base).getDay();
      let date = base;
      if (wd === 6) date = addDays(base, -1);
      if (wd === 0) date = addDays(base, 1);
      if (date.slice(0, 7) !== month) date = wd === 6 ? addDays(base, 2) : addDays(base, -2);
      out.add(date);
    }
    return [...out].sort();
  }

  function scheduledOn(task, date) {
    if (task.frequency === "monthstart") return date <= dueDate(task, monthStart(date)) && WORK_DAYS.includes(parseYmd(date).getDay());
    if (task.frequency === "monthdays") return monthDates(task, monthStart(date)).includes(date);
    return task.frequency === "weekdays" && Boolean(task.due_day & (1 << (isoDay(date) - 1)));
  }

  function dueLabel(task) {
    if (task.frequency === "monthstart") {
      const n = task.due_day || 1;
      return "First " + n + " working " + (n === 1 ? "day" : "days") + " of the month · by " + dayDate(dueDate(task, monthStart(selectedDate)));
    }
    if (task.frequency === "monthdays") {
      const list = maskDates(task.due_day || 0).map(ordinal);
      return "On the " + (list.length > 1 ? list.slice(0, -1).join(", ") + " & " + list[list.length - 1] : list[0]) + " (not Sat/Sun)";
    }
    if (task.frequency === "weekdays") return "Every " + maskDays(task.due_day || 0).map((d) => SHORT_DAYS[d - 1]).join(", ");
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
          headers: { "Content-Type": "application/json", "X-User-Active": recentlyActive() ? "1" : "0" },
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
      skipTask: (id, from, to) => call("skipTask", { id, from, to }),
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
      reportDetail: (from, to, employee) => call("reportDetail", { from, to, employee }),
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
          state.tasks.push({ frequency: weekly ? "weekly" : "daily", due_day: weekly ? 1 : null, ...s, id: newId(), from_seed: true, created_at: new Date().toISOString() });
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
      if (frequency === "weekdays") return { frequency, due_day: Math.min(Math.max(Number(row.due_day) || 1, 1), 127) };
      if (frequency === "monthdays") return { frequency, due_day: Math.min(Math.max(Number(row.due_day) || 1, 1), 2147483647) };
      if (frequency === "monthstart") return { frequency, due_day: Math.min(Math.max(Number(row.due_day) || 1, 1), 20) };
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
        state.tasks.push({ employee: row.employee, title: row.title, position, ...freq(row), starts_on: row.starts_on || null, ends_on: row.ends_on || null, id: newId(), from_seed: false, created_at: new Date().toISOString() });
        save();
      },
      async skipTask(id, from, to) {
        const t = ownTask(id);
        t.skips = [...(t.skips || []), [from, to]];
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
        if ("ends_on" in changes) t.ends_on = changes.ends_on || null;
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
        const copy = { employee: t.employee, title: base + " (" + (max + 1) + ")", frequency: t.frequency || "daily", due_day: t.due_day ?? null, starts_on: t.starts_on || null, ends_on: t.ends_on || null, id: newId(), from_seed: false, created_at: new Date().toISOString() };
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
        const nowDt = () => today() + " " + nowHHMM();
        const running = () =>
          e.worked_sec == null
            ? Math.max(0, Math.round((new Date() - atTime(e.started_on || date, e.start_time)) / 1000))
            : e.resumed_at
              ? Math.max(0, Math.round((new Date() - atTime(...e.resumed_at.split(" "))) / 1000))
              : 0;
        if (!e.start_time && times.start_time) Object.assign(e, { start_time: nowHHMM(), started_on: today(), worked_sec: 0, resumed_at: nowDt() });
        if (!e.end_time && e.start_time && times.pause && (e.worked_sec == null || e.resumed_at)) {
          Object.assign(e, { worked_sec: (e.worked_sec || 0) + running(), resumed_at: null });
        }
        if (!e.end_time && e.start_time && times.resume && e.worked_sec != null && !e.resumed_at) e.resumed_at = nowDt();
        if (!e.end_time && times.end_time) {
          if (!e.start_time) throw apiError("A task has to be started before it can be finished.");
          if (e.worked_sec != null) Object.assign(e, { worked_sec: e.worked_sec + running(), resumed_at: null });
          Object.assign(e, { end_time: nowHHMM(), ended_on: today() });
        }
        e.quantity = times.quantity ?? null;
        save();
        return { start_time: e.start_time, end_time: e.end_time, started_on: e.started_on, ended_on: e.ended_on, worked_sec: e.worked_sec ?? null, resumed_at: e.resumed_at ?? null };
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
      async reportDetail(from, to, employee) {
        requireAdmin();
        const rows = [];
        for (const [date, day] of Object.entries(state.entries)) {
          for (const [id, e] of Object.entries(day)) {
            const t = state.tasks.find((x) => x.id === id);
            const d = e.ended_on || e.started_on || date;
            if (!t || d < from || d > to || (employee && t.employee !== employee)) continue;
            if (!e.start_time && !(e.quantity > 0) && !e.skipped) continue;
            rows.push({ employee: t.employee, title: t.title, frequency: t.frequency || "daily", due_day: t.due_day ?? null, task_id: id, work_date: date, ...EMPTY_ENTRY, ...e });
          }
        }
        return { from, to, rows };
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
    reports: $("reports"),
    repDetail: $("rep-detail"),
    drPreset: $("dr-preset"),
    drFrom: $("dr-from"),
    drTo: $("dr-to"),
    drWho: $("dr-who"),
    drRange: $("dr-range"),
    drKpis: $("dr-kpis"),
    drChart: $("dr-chart"),
    drChartTitle: $("dr-chart-title"),
    drPeoplePanel: $("dr-people-panel"),
    drPeopleHead: $("dr-people-head"),
    drPeople: $("dr-people"),
    drTasksHead: $("dr-tasks-head"),
    drTasks: $("dr-tasks"),
    drTasksEmpty: $("dr-tasks-empty"),
    drTasksMore: $("dr-tasks-more"),
    drLogHead: $("dr-log-head"),
    drLog: $("dr-log"),
    drLogEmpty: $("dr-log-empty"),
    drLogMore: $("dr-log-more"),
    drLogCount: $("dr-log-count"),
    drCsv: $("dr-csv"),
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
    addDays: $("add-days"),
    addRepeat: $("add-repeat"),
    addFor: $("add-for"),
    addCount: $("add-count"),
    addUnit: $("add-unit"),
    assignRepeat: $("assign-repeat"),
    assignForField: $("assign-for-field"),
    assignCount: $("assign-count"),
    assignUnit: $("assign-unit"),
    assignDaysField: $("assign-days-field"),
    assignDays: $("assign-days"),
    assignDaysLabel: $("assign-days-label"),
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
  let deleteMenuFor = null; // task id whose delete choices are open
  let subscribed = false;

  const isAdmin = () => Boolean(me && me.role === "admin");
  const isPersonTab = () => active !== OVERVIEW && active !== TEAM && active !== REPORTS;
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
    if (active === REPORTS) loadDetail();
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
    const ws = weekStart(date);
    const keys = [...new Set([date, ws, monthStart(date), ...[0, 1, 2, 3, 4, 5, 6].map((n) => addDays(ws, n))])];
    const from = pendingWindowStart();
    const rangeFrom = [from, weekStart(from), monthStart(from)].sort()[0];
    const ms = monthStart(date);
    const monthEnd = addDays(nextMonth(ms), -1);
    let t, e, n, r, rem, mo;
    try {
      [t, e, n, r, rem, mo] = await Promise.all([
        store.listTasks(),
        store.listEntries(keys),
        store.listNotes(date),
        store.listEntriesRange(rangeFrom, todayStr),
        store.listReminders(),
        store.listEntriesRange(ms, monthEnd < todayStr ? monthEnd : todayStr),
      ]);
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't load tasks: " + err.message);
      return;
    }
    if (date !== selectedDate || !me) return; // changed while loading
    const toMap = (list) => new Map(list.map((x) => [x.task_id + "|" + x.work_date, { ...EMPTY_ENTRY, ...x, quantity: x.quantity ?? null }]));
    tasks = t;
    entries = toMap(mo.concat(e));
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

  // What a person's Daily / Weekly / Monthly list shows: set-weekday tasks
  // are in the daily list on their days, and always in the weekly list.
  function listFor(name, which, date) {
    const [from, to] = viewSpan(which, date || selectedDate);
    const mine = tasksFor(name).filter((t) => activeIn(t, from, to) && !skippedFor(t, from, to));
    if (which === "daily") return mine.filter((t) => (t.frequency || "daily") === "daily" || scheduledOn(t, date || selectedDate));
    if (which === "weekly") return mine.filter((t) => t.frequency === "weekly" || t.frequency === "weekdays");
    if (which === "monthly") return mine.filter((t) => t.frequency === "monthly" || t.frequency === "monthdays" || t.frequency === "monthstart");
    return mine.filter((t) => t.frequency === which);
  }

  // Set-days / set-dates tasks show in the weekly / monthly list as a row of
  // markers, one per occurrence in that week or month.
  function isPeriodRow(task, which) {
    return (which === "weekly" && task.frequency === "weekdays") || (which === "monthly" && task.frequency === "monthdays");
  }

  // A set-days task across the selected week, or a set-dates task across the
  // selected month: one entry per scheduled date.
  function periodOccurrences(task) {
    // Dates before the task existed (or before tracking began) don't count.
    const from = maxDate(trackingStart, String(task.created_at || "").slice(0, 10) || trackingStart);
    let dates;
    if (task.frequency === "monthdays") {
      dates = monthDates(task, monthStart(selectedDate));
    } else {
      const ws = weekStart(selectedDate);
      dates = maskDays(task.due_day || 0).map((d) => addDays(ws, d - 1));
    }
    return dates.filter((date) => date >= from && activeIn(task, date, date) && !skippedFor(task, date, date)).map((date) => {
      const d = isoDay(date);
      const e = entries.get(task.id + "|" + date) || recent.get(task.id + "|" + date) || EMPTY_ENTRY;
      let state = statusOf(e);
      if (state !== "done" && e.skipped) state = "excused";
      else if (state !== "done" && date < todayStr) state = "missed";
      else if (state === "todo" && date === todayStr) state = "today";
      else if (state === "todo") state = "upcoming";
      return { date, day: d, entry: e, state };
    });
  }

  // Status in a list: in the weekly list a set-weekday task is done when every
  // one of its days that week is done.
  function listStatus(task, which) {
    if (isPeriodRow(task, which)) {
      const occ = periodOccurrences(task);
      const done = occ.filter((o) => o.state === "done" || o.state === "excused").length;
      if (done === occ.length) return "done";
      if (occ.some((o) => o.state === "done" || o.state === "in_progress")) return "in_progress";
      return "todo";
    }
    return statusOf(entryFor(task));
  }

  function statusFor(task, date) {
    const e = entryFor(task, date);
    const s = statusOf(e);
    if (s !== "done" && task.frequency !== "daily" && isCurrent(task) && dueDate(task, occurrenceKey(task, todayStr)) < todayStr) {
      return "overdue";
    }
    return s;
  }

  function countStatuses(list, which) {
    const c = { todo: 0, in_progress: 0, done: 0 };
    list.forEach((t) => c[listStatus(t, which)]++);
    return c;
  }

  function finishedMinutes(list, which) {
    return list
      .flatMap((t) => (isPeriodRow(t, which) ? periodOccurrences(t).map((o) => o.entry) : [entryFor(t)]))
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
      if (skippedFor(task, key, due) || !activeIn(task, due, due)) return;
      const e = recorded(task, key);
      if (!e.end_time && !e.skipped) items.push({ task, key, due, entry: e });
    };
    for (const task of tasksFor(name)) {
      const created = String(task.created_at || "").slice(0, 10) || from;
      const start = maxDate(maxDate(from, created), task.starts_on || from);
      const freq = task.frequency || "daily";
      if (freq === "daily") {
        for (let d = start; d < todayStr; d = addDays(d, 1)) {
          if (WORK_DAYS.includes(parseYmd(d).getDay())) add(task, d, d);
        }
      } else if (freq === "weekdays" || freq === "monthdays") {
        for (let d = start; d < todayStr; d = addDays(d, 1)) {
          if (scheduledOn(task, d)) add(task, d, d);
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
    const list = people.flatMap((name) => listFor(name, "daily"));
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
    const running = list.filter((t) => statusOf(entryFor(t)) === "in_progress" && !isPaused(entryFor(t)));
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
        const list = listFor(name, "daily");
        return tab(name, name, countStatuses(list).done + "/" + list.length, "", pendingFor(name).length || 0);
      }),
      tab(REPORTS, "Reports", undefined, "tab-admin"),
      tab(TEAM, "Team", undefined, "tab-admin")
    );
  }

  function renderSubtabs() {
    el.subtabs.hidden = !isPersonTab();
    if (!isPersonTab()) return;
    const counts = {
      daily: listFor(active, "daily"),
      weekly: listFor(active, "weekly"),
      monthly: listFor(active, "monthly"),
    };
    el.subtabs.replaceChildren(
      ...VIEWS.map(({ key, label }) => {
        const btn = h("button", "subtab subtab-" + key);
        btn.type = "button";
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", String(key === view));
        btn.append(h("span", "", label));
        if (counts[key]) {
          btn.append(h("span", "tab-count", countStatuses(counts[key], key).done + "/" + counts[key].length));
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
    const c = countStatuses(list, view);
    const totalChip = h("div", "summary-chip summary-total");
    totalChip.append(h("strong", "", formatHours(finishedMinutes(list, view))), h("span", "", "Total Time Taken"));
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
      if (!isStart && entry.start_time) {
        const paused = isPaused(entry);
        const pause = h("button", "btn-stamp " + (paused ? "btn-stamp-resume" : "btn-stamp-pause"), paused ? "Resume" : "Pause");
        pause.type = "button";
        pause.setAttribute("aria-label", (paused ? "Resume " : "Pause ") + task.title);
        pause.addEventListener("click", () => pauseTask(task, key, paused));
        wrap.append(pause);
      }
      const btn = h("button", "btn-stamp " + (isStart ? "btn-stamp-start" : "btn-stamp-end"), isStart ? "Start" : "Finish");
      btn.type = "button";
      btn.setAttribute("aria-label", (isStart ? "Start " : "Finish ") + task.title + " now");
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
      taken.textContent = formatDuration(mins) + " so far" + (isPaused(entry) ? " · paused" : "");
      taken.classList.add(isPaused(entry) ? "taken-paused" : "taken-running");
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

  // Mon-Sun toggle buttons for weekly tasks. One day = due that day;
  // several = the task happens on each of them.
  function dayPicker(container, days, kind) {
    const month = kind === "month";
    const chosen = new Set(days);
    const labels = month ? Array.from({ length: 31 }, (_, i) => String(i + 1)) : SHORT_DAYS;
    const buttons = labels.map((label, i) => {
      const b = h("button", "day-chip" + (month ? " date-chip" : ""), label);
      b.type = "button";
      b.setAttribute("aria-label", month ? ordinal(i + 1) + " of the month" : WEEKDAYS[i]);
      const sync = () => b.setAttribute("aria-pressed", String(chosen.has(i + 1)));
      sync();
      b.addEventListener("click", () => {
        if (chosen.has(i + 1)) chosen.delete(i + 1);
        else chosen.add(i + 1);
        sync();
        hint.textContent = pickerHint();
      });
      return b;
    });
    const hint = h("span", "day-hint");
    const pickerHint = () =>
      month
        ? chosen.size === 0
          ? "Pick at least one date"
          : chosen.size === 1
            ? "Monthly, due by the " + ordinal([...chosen][0])
            : "Shows in Daily Tasks on these dates · Sat/Sun move to Fri/Mon"
        : chosen.size === 0
          ? "Pick at least one day"
          : chosen.size === 1
            ? "Weekly, due " + WEEKDAYS[[...chosen][0] - 1]
            : "Shows in Daily Tasks on these days";
    hint.textContent = pickerHint();
    const row = h("div", "day-chips" + (month ? " date-chips" : ""));
    row.append(...buttons);
    container.replaceChildren(row, hint);
    return () => [...chosen];
  }

  function taskDays(task) {
    if (task.frequency === "weekdays") return maskDays(task.due_day || 0);
    if (task.frequency === "weekly") return [task.due_day || 1];
    return [1];
  }

  function taskDates(task) {
    if (task.frequency === "monthdays") return maskDates(task.due_day || 0);
    if (task.frequency === "monthly") return [task.due_day || 1];
    return [1];
  }

  function dueOptions(select, frequency, selected) {
    if (frequency === "monthstart") {
      select.replaceChildren(...Array.from({ length: 15 }, (_, i) => option(String(i + 1), "First " + (i + 1) + " working " + (i ? "days" : "day"))));
    } else if (frequency === "weekly") {
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
    freq.append(option("daily", "Daily"), option("weekly", "Weekly"), option("monthly", "Monthly"), option("monthstart", "Start of month"));
    freq.value = task.frequency || "daily";
    freqField.append(h("span", "", "Type"), freq);

    const dueField = h("label", "field");
    const due = document.createElement("select");
    const dueCaption = h("span", "", "Due on");
    dueField.append(dueCaption, due);
    const daysField = h("div", "field");
    const daysBox = h("div", "day-picker");
    daysField.append(h("span", "", "Days"), daysBox);
    const datesField = h("div", "field");
    const datesBox = h("div", "day-picker");
    datesField.append(h("span", "", "Dates"), datesBox);
    let getDays = dayPicker(daysBox, taskDays(task));
    let getDates = dayPicker(datesBox, taskDates(task), "month");
    if (task.frequency === "weekdays") freq.value = "weekly";
    if (task.frequency === "monthdays") freq.value = "monthly";
    const syncDue = () => {
      dueField.hidden = freq.value !== "monthstart";
      if (freq.value === "monthstart") {
        dueCaption.textContent = "Within";
        dueOptions(due, "monthstart", task.frequency === "monthstart" ? task.due_day : 6);
      }
      daysField.hidden = freq.value !== "weekly";
      datesField.hidden = freq.value !== "monthly";
    };
    freq.addEventListener("change", syncDue);
    syncDue();

    const endField = h("label", "field");
    const endInput = document.createElement("input");
    endInput.type = "date";
    endInput.value = task.ends_on || "";
    endField.append(h("span", "", "Last day (optional)"), endInput);

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

    form.append(titleField, freqField, dueField, daysField, datesField, endField, whoField, saveBtn, cancel);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const changes = { title: title.value.trim(), frequency: freq.value, employee: who.value, ends_on: endInput.value || null };
      if (changes.ends_on && task.starts_on && changes.ends_on < task.starts_on) return showToast("The last day must be after " + dayDate(task.starts_on) + ".");
      if (freq.value === "monthstart") changes.due_day = Number(due.value);
      if (freq.value === "monthly") {
        if (!getDates().length) return showToast("Pick at least one date.");
        Object.assign(changes, freqFromDates(getDates()));
      }
      if (freq.value === "weekly") {
        if (!getDays().length) return showToast("Pick at least one day.");
        Object.assign(changes, freqFromDays(getDays()));
      }
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
      deleteMenuFor = deleteMenuFor === task.id ? null : task.id;
      render();
    });
    tools.append(del);
    return tools;
  }

  // The period "Delete for now" applies to: today, this week or this month
  // (only while looking at the current one).
  function nowSpan() {
    const [from, to] = viewSpan(view, selectedDate);
    if (from > todayStr || to < todayStr) return null;
    return { from, to, word: view === "weekly" ? "this week" : view === "monthly" ? "this month" : "today", next: view === "weekly" ? "next week" : view === "monthly" ? "next month" : "tomorrow" };
  }

  function deleteRow(task, colspan) {
    const tr = h("tr", "del-row");
    const td = h("td");
    td.colSpan = colspan;
    td.append(deleteMenu(task));
    tr.append(td);
    return tr;
  }

  function deleteMenu(task) {
    const menu = h("div", "del-menu");
    menu.append(h("span", "del-question", "Delete “" + task.title + "”?"));
    menu.setAttribute("role", "menu");
    const span = nowSpan();
    if (span) {
      const once = h("button", "del-option", "Delete for " + span.word);
      once.type = "button";
      once.title = "It comes back " + span.next;
      once.addEventListener("click", () => skipTask(task, span));
      menu.append(once);
    }
    const forever = h("button", "del-option del-forever", "Delete permanently");
    forever.type = "button";
    forever.title = "Remove this task and its history for good";
    forever.addEventListener("click", () => {
      if (!forever.classList.contains("armed")) {
        forever.classList.add("armed");
        forever.textContent = "Sure? Delete permanently";
        return;
      }
      deleteMenuFor = null;
      deleteTask(task);
    });
    const cancel = h("button", "del-option del-cancel", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      deleteMenuFor = null;
      render();
    });
    menu.append(forever, cancel);
    return menu;
  }

  async function skipTask(task, span) {
    deleteMenuFor = null;
    task.skips = [...(task.skips || []), [span.from, span.to]];
    render();
    try {
      await store.skipTask(task.id, span.from, span.to);
      showToast("Removed “" + task.title + "” for " + span.word + ". It comes back " + span.next + ".");
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't remove: " + e.message);
    }
    refresh();
  }

  document.addEventListener("click", (e) => {
    if (deleteMenuFor && !e.target.closest(".del-menu, .btn-delete")) {
      deleteMenuFor = null;
      render();
    }
  });

  function renderRows(list) {
    const colspan = 7 + (countsItems() ? 1 : 0);
    const rows = [];
    list.forEach((task, i) => {
      if (isPeriodRow(task, view)) {
        rows.push(periodRow(task, i, list));
        if (deleteMenuFor === task.id) rows.push(deleteRow(task, colspan));
        if (editingTaskId === task.id) rows.push(editRow(task, colspan));
        return;
      }
      const tr = document.createElement("tr");
      const key = occurrenceKey(task, selectedDate);
      const entry = entryFor(task);
      const editable = isCurrent(task);
      const status = statusFor(task) === "in_progress" && isPaused(entry) ? "paused" : statusFor(task);

      const num = h("td", "num", i + 1);
      const title = h("td", "title");
      title.append(h("span", "", task.title));
      const due = [dueLabel(task), spanLabel(task)].filter(Boolean).join(" · ");
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
      if (deleteMenuFor === task.id) rows.push(deleteRow(task, colspan));
      if (editingTaskId === task.id) rows.push(editRow(task, colspan));
    });
    el.rows.replaceChildren(...rows);
    el.empty.hidden = list.length > 0;
    const kind = view === "daily" ? "daily" : view === "weekly" ? "weekly" : "monthly";
    el.empty.textContent = "No " + kind + " tasks yet. Add one below.";
  }

  // Weekly / monthly list: a set-days or set-dates task with one marker per
  // occurrence. Its Start / End happen in Daily Tasks on each of those days.
  function periodRow(task, i, list) {
    const tr = h("tr", "weekdays-row");
    const occ = periodOccurrences(task);
    const monthly = task.frequency === "monthdays";
    const title = h("td", "title");
    title.append(h("span", "", task.title), h("span", "task-due", [dueLabel(task) + " · in Daily Tasks on those " + (monthly ? "dates" : "days"), spanLabel(task)].filter(Boolean).join(" · ")));
    const chips = h("div", "occ-chips");
    const word = { done: "done", in_progress: "in progress", missed: "missed", today: "today", upcoming: "upcoming", excused: "excused" };
    for (const o of occ) {
      const c = h("span", "occ-chip occ-" + o.state, monthly ? shortDate(o.date) : SHORT_DAYS[o.day - 1]);
      c.title = dayDate(o.date) + ": " + word[o.state];
      chips.append(c);
    }
    title.append(chips);
    const blank = () => {
      const td = h("td", "time-cell");
      td.append(h("span", "time-none", "—"));
      return td;
    };
    const done = occ.filter((o) => o.state === "done").length;
    const st = h("td", "status-cell");
    const status = listStatus(task, monthly ? "monthly" : "weekly");
    const missed = occ.some((o) => o.state === "missed");
    st.append(h("span", "pill status-" + (status !== "done" && missed ? "overdue" : status), occ.length ? done + " of " + occ.length + " done" : "Starts next " + (monthly ? "month" : "week")));
    const taken = h("td", "taken-cell");
    taken.dataset.label = "Taken";
    const mins = occ.reduce((sum, o) => sum + (o.entry.end_time ? minutesTaken(o.entry, false) || 0 : 0), 0);
    taken.textContent = mins ? formatHours(mins) : "—";
    if (!mins) taken.classList.add("taken-none");
    const actions = h("td", "actions");
    actions.append(rowTools(task, i, list));
    tr.append(h("td", "num", i + 1), title, blank(), blank(), st, taken, actions);
    return tr;
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
      const list = listFor(name, "daily");
      const c = countStatuses(list);
      done += c.done;
      total += list.length;
      const all = tasksFor(name);
      const now = all.filter((t) => statusOf(entryFor(t)) === "in_progress" && !isPaused(entryFor(t)));
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

  let getAssignDays = () => [1];
  function syncAssignDue() {
    const f = el.assignFreq.value;
    repeatOptions(el.assignRepeat, f === "monthstart" ? "monthly" : f);
    el.assignForField.hidden = el.assignRepeat.value === "once";
    el.assignUnit.value = "always";
    el.assignCount.hidden = true;
    el.assignDueField.hidden = f !== "monthstart";
    if (f === "monthstart") {
      el.assignDueLabel.textContent = "Within";
      dueOptions(el.assignDue, "monthstart", 6);
    }
    el.assignDaysField.hidden = f === "daily" || f === "monthstart";
    el.assignDaysLabel.textContent = f === "monthly" ? "Dates" : "Days";
    if (f !== "daily" && f !== "monthstart") getAssignDays = dayPicker(el.assignDays, [1], f === "monthly" ? "month" : "week");
  }
  el.assignFreq.addEventListener("change", syncAssignDue);
  el.assignRepeat.addEventListener("change", () => (el.assignForField.hidden = el.assignRepeat.value === "once"));
  el.addRepeat.addEventListener("change", () => (el.addFor.hidden = el.addRepeat.value === "once"));
  el.addUnit.addEventListener("change", () => (el.addCount.hidden = el.addUnit.value === "always"));
  el.assignUnit.addEventListener("change", () => (el.assignCount.hidden = el.assignUnit.value === "always"));

  // ---- Admin: reports --------------------------------------------------------

  let reportData = null;

  function reportRange() {
    return presetRange(el.repPreset.value, el.repFrom.value, el.repTo.value);
  }

  function presetRange(preset, customFrom, customTo) {
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
      case "last30":
        return [addDays(todayStr, -29), todayStr];
      case "month":
        return [monthStart(todayStr), todayStr];
      case "lastmonth": {
        const first = new Date(t.getFullYear(), t.getMonth() - 1, 1);
        const last = new Date(t.getFullYear(), t.getMonth(), 0);
        return [ymd(first), ymd(last)];
      }
      default: {
        const a = customFrom || todayStr;
        const b = customTo || todayStr;
        return a <= b ? [a, b] : [b, a];
      }
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
      const open = h("button", "link-cell", name);
      open.type = "button";
      open.title = "Open " + name + "'s detailed report";
      open.addEventListener("click", () => openDetail(name));
      who.append(av, open);
      const pending = employees.includes(name) ? pendingFor(name).length : 0;
      tr.append(
        who,
        h("td", "num-col", x.days.size),
        h("td", "num-col", x.done),
        h("td", "num-col", formatHours(x.minutes)),
        h("td", "num-col", x.days.size ? formatHours(Math.round(x.minutes / x.days.size)) : "—"),
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
    foot.append(h("td", "", "Total"), h("td", "num-col", sumDays), h("td", "num-col", sumDone), h("td", "num-col", formatHours(sumMin)), h("td", "num-col", ""), h("td", "num-col", sumPending));
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
    const row = { employee, title, frequency, ...newTaskSpan(frequency === "monthstart" ? "monthly" : frequency, el.assignRepeat.value === "once", el.assignCount.value, el.assignUnit.value) };
    if (frequency === "monthstart") row.due_day = Number(el.assignDue.value);
    else if (frequency !== "daily") {
      if (!getAssignDays().length) return showToast(frequency === "monthly" ? "Pick at least one date." : "Pick at least one day.");
      Object.assign(row, frequency === "monthly" ? freqFromDates(getAssignDays()) : freqFromDays(getAssignDays()));
    }
    try {
      await store.insertTask(row);
    } catch (err) {
      if (!handleAuthError(err)) showToast("Couldn't assign the task: " + err.message);
      return;
    }
    el.assignTitle.value = "";
    showToast("Assigned “" + title + "” to " + employee + (row.frequency === "weekdays" || row.frequency === "monthdays" || row.frequency === "monthstart" ? " (" + dueLabel(row).replace(/^\w/, (c) => c.toLowerCase()) + ")" : " as a " + FREQ_LABEL[row.frequency].toLowerCase() + " task"));
    refresh();
  });

  // ---- Admin: detailed reports -----------------------------------------------

  let detail = null; // { from, to, who, rows }
  let logLimit = 50;
  let taskLimit = 15;

  function openDetail(who) {
    // Carry the Overview's period over, then show one person (or everyone).
    el.drPreset.value = el.repPreset.value === "custom" ? "custom" : el.repPreset.value;
    el.drFrom.value = el.repFrom.value;
    el.drTo.value = el.repTo.value;
    renderDetailFilters();
    el.drWho.value = who || "";
    setActiveTab(REPORTS);
  }

  function renderDetailFilters() {
    const options = [option("", "Everyone")].concat(employees.map((n) => option(n, n)));
    const current = el.drWho.value;
    if (options.map((o) => o.value).join("\u0001") !== Array.from(el.drWho.options, (o) => o.value).join("\u0001")) {
      el.drWho.replaceChildren(...options);
      el.drWho.value = employees.includes(current) ? current : "";
    }
  }

  async function loadDetail() {
    if (!isAdmin()) return;
    renderDetailFilters();
    const [from, to] = presetRange(el.drPreset.value, el.drFrom.value, el.drTo.value);
    el.drFrom.value = from;
    el.drTo.value = to;
    const who = el.drWho.value;
    try {
      const data = await store.reportDetail(from, to, who || null);
      detail = { from: data.from, to: data.to, who, rows: data.rows };
    } catch (e) {
      if (!handleAuthError(e)) showToast("Couldn't load the report: " + e.message);
      return;
    }
    logLimit = 50;
    taskLimit = 15;
    renderDetail();
  }

  const workDay = (r) => r.ended_on || r.started_on || r.work_date;

  // Finished on or before the task's due day (the same day for daily tasks).
  function onTime(r) {
    return Boolean(r.end_time) && (r.ended_on || r.work_date) <= dueDate({ frequency: r.frequency, due_day: r.due_day }, r.work_date);
  }

  function summarize(rows) {
    const done = rows.filter((r) => r.end_time);
    const minutes = done.reduce((sum, r) => sum + (minutesTaken(r, false) || 0), 0);
    const worked = rows.filter((r) => r.start_time);
    const days = new Set(worked.map(workDay));
    const personDays = new Set(worked.map((r) => r.employee + "|" + workDay(r)));
    return {
      done: done.length,
      minutes,
      days: days.size,
      personDays: personDays.size,
      onTime: done.filter(onTime).length,
      late: done.length - done.filter(onTime).length,
      excused: rows.filter((r) => r.skipped && !r.end_time).length,
      open: rows.filter((r) => r.start_time && !r.end_time).length,
      quantity: rows.reduce((sum, r) => sum + (r.quantity || 0), 0),
    };
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");

  function renderDetail() {
    if (!detail) return;
    const people = detail.who ? [detail.who] : employees;
    const rows = detail.rows;
    const sum = summarize(rows);
    const span = daysBetween(detail.from, detail.to) + 1;
    el.drRange.textContent =
      (detail.who ? detail.who : "Everyone") + " · " + dayDate(detail.from) + (detail.from === detail.to ? "" : " – " + dayDate(detail.to)) + " · " + span + (span === 1 ? " day" : " days");

    // Headline numbers.
    const pendingNow = people.reduce((n, name) => n + pendingFor(name).length, 0);
    const counts = people.some((n) => DONE_COUNTERS[n]);
    const tile = (value, label, sub, cls) => {
      const t = h("div", "dr-kpi" + (cls ? " " + cls : ""));
      t.append(h("strong", "", value), h("span", "dr-kpi-label", label));
      if (sub) t.append(h("span", "dr-kpi-sub", sub));
      return t;
    };
    el.drKpis.replaceChildren(
      tile(sum.done, "Tasks done", sum.open ? sum.open + " still in progress" : ""),
      tile(formatHours(sum.minutes), "Time worked", sum.days + (sum.days === 1 ? " day with work" : " days with work")),
      tile(
        sum.personDays ? formatHours(Math.round(sum.minutes / sum.personDays)) : "—",
        detail.who ? "Average per day worked" : "Average per person per day",
        detail.who ? "" : sum.personDays + " person-days"
      ),
      tile(pct(sum.onTime, sum.done), "On time", sum.late ? sum.late + " finished late" : sum.done ? "None late" : "", sum.done && sum.late / sum.done > 0.2 ? "kpi-warn" : ""),
      tile(pendingNow, "Pending now", sum.excused ? sum.excused + " excused in period" : "", pendingNow ? "kpi-alert" : "kpi-good"),
      ...(counts ? [tile(sum.quantity, capitalize(DONE_COUNTERS[people.find((n) => DONE_COUNTERS[n])]) + " done")] : [])
    );

    renderDetailChart(rows);
    renderDetailPeople(rows);
    renderDetailTasks(rows);
    renderDetailLog(rows);
  }

  // Column chart: tasks finished per day (per week for long periods), one
  // series, with a hover tooltip. The same numbers are in the tables below.
  function renderDetailChart(rows) {
    const byWeek = daysBetween(detail.from, detail.to) > 62;
    el.drChartTitle.textContent = "Tasks done per " + (byWeek ? "week" : "day");
    const buckets = [];
    const index = new Map();
    const first = byWeek ? weekStart(detail.from) : detail.from;
    for (let d = first; d <= detail.to; d = addDays(d, byWeek ? 7 : 1)) {
      index.set(d, buckets.length);
      buckets.push({ key: d, done: 0, minutes: 0 });
    }
    for (const r of rows) {
      if (!r.end_time) continue;
      const d = workDay(r);
      const b = buckets[index.get(byWeek ? weekStart(d) : d)];
      if (!b) continue;
      b.done++;
      b.minutes += minutesTaken(r, false) || 0;
    }

    const width = Math.max(320, el.drChart.clientWidth || 800);
    const height = 220;
    const m = { top: 12, right: 8, bottom: 28, left: 34 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;
    const maxVal = Math.max(1, ...buckets.map((b) => b.done));
    const step = maxVal <= 5 ? 1 : maxVal <= 10 ? 2 : maxVal <= 25 ? 5 : maxVal <= 50 ? 10 : Math.ceil(maxVal / 50) * 10;
    const top = Math.ceil(maxVal / step) * step;
    const y = (v) => m.top + ih - (v / top) * ih;
    const band = iw / buckets.length;
    const barW = Math.max(2, Math.min(24, band - 2));
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("role", "img");
    const total = buckets.reduce((n, b) => n + b.done, 0);
    const best = buckets.reduce((a, b) => (b.done > a.done ? b : a), buckets[0]);
    svg.setAttribute("aria-label", total + " tasks done in this period" + (best && best.done ? ", most on " + dayDate(best.key) + " (" + best.done + ")" : ""));
    const add = (tag, attrs, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      (parent || svg).append(n);
      return n;
    };
    for (let v = 0; v <= top; v += step) {
      add("line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: "dr-grid" });
      const t = add("text", { x: m.left - 8, y: y(v) + 4, class: "dr-axis", "text-anchor": "end" });
      t.textContent = v;
    }
    const labelEvery = Math.ceil(buckets.length / Math.max(1, Math.floor(iw / 56)));
    const tip = h("div", "dr-tip");
    tip.hidden = true;
    buckets.forEach((b, i) => {
      const cx = m.left + band * i + band / 2;
      if (b.done) {
        const x0 = cx - barW / 2;
        const y0 = y(b.done);
        const r = Math.min(4, barW / 2, (m.top + ih - y0) / 2);
        const base = m.top + ih;
        add("path", {
          class: "dr-bar",
          d: "M" + x0 + "," + base + "V" + (y0 + r) + "Q" + x0 + "," + y0 + " " + (x0 + r) + "," + y0 + "H" + (x0 + barW - r) + "Q" + (x0 + barW) + "," + y0 + " " + (x0 + barW) + "," + (y0 + r) + "V" + base + "Z",
        });
      }
      if (i % labelEvery === 0) {
        const t = add("text", { x: cx, y: height - 8, class: "dr-axis", "text-anchor": "middle" });
        t.textContent = byWeek ? shortDate(b.key) : parseYmd(b.key).toLocaleDateString("en-GB", buckets.length <= 14 ? { weekday: "short", day: "numeric" } : { day: "numeric", month: "short" });
      }
      // Hover target: the whole column, bigger than the bar.
      const hit = add("rect", { x: m.left + band * i, y: m.top, width: band, height: ih, class: "dr-hit", tabindex: "0" });
      const show = () => {
        tip.replaceChildren(
          h("strong", "", byWeek ? "Week of " + dayDate(b.key) : dayDate(b.key)),
          h("span", "", b.done + (b.done === 1 ? " task done" : " tasks done")),
          h("span", "", formatHours(b.minutes) + " worked")
        );
        tip.hidden = false;
        const left = Math.min(Math.max(cx - 70, 0), width - 150);
        tip.style.left = left + "px";
        tip.style.top = Math.max(0, y(b.done) - 72) + "px";
        hit.classList.add("is-hover");
      };
      const hide = () => {
        tip.hidden = true;
        hit.classList.remove("is-hover");
      };
      hit.addEventListener("mouseenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", hide);
      hit.addEventListener("blur", hide);
    });
    add("line", { x1: m.left, x2: width - m.right, y1: m.top + ih, y2: m.top + ih, class: "dr-baseline" });
    const wrap = h("div", "dr-chart-inner");
    wrap.append(svg, tip);
    el.drChart.replaceChildren(wrap);
    if (!total) el.drChart.append(h("p", "empty", "No tasks were finished in this period."));
  }

  function renderDetailPeople(rows) {
    el.drPeoplePanel.hidden = Boolean(detail.who);
    if (detail.who) return;
    const counts = Object.keys(DONE_COUNTERS).length > 0;
    const head = h("tr");
    ["Person", "Days worked", "Tasks done", "Time worked", "Avg per day", "On time", "Pending now"].concat(counts ? ["Videos"] : []).forEach((label, i) =>
      head.append(h("th", i ? "num-col" : "", label))
    );
    el.drPeopleHead.replaceChildren(head);
    const stats = employees.map((name) => ({ name, s: summarize(rows.filter((r) => r.employee === name)), pending: pendingFor(name).length }));
    const maxDone = Math.max(1, ...stats.map((x) => x.s.done));
    el.drPeople.replaceChildren(
      ...stats.map(({ name, s, pending }) => {
        const tr = h("tr", "dr-row-link");
        tr.tabIndex = 0;
        tr.title = "Show only " + name;
        const open = () => {
          el.drWho.value = name;
          loadDetail();
        };
        tr.addEventListener("click", open);
        tr.addEventListener("keydown", (e) => {
          if (e.key === "Enter") open();
        });
        const who = h("td", "rep-name");
        const av = h("span", "avatar avatar-sm");
        paintAvatar(av, name);
        who.append(av, h("span", "", name));
        const doneCell = h("td", "num-col dr-bar-cell");
        const meter = h("span", "dr-meter");
        meter.style.width = (s.done / maxDone) * 100 + "%";
        doneCell.append(meter, h("span", "dr-meter-val", s.done));
        tr.append(
          who,
          h("td", "num-col", s.days),
          doneCell,
          h("td", "num-col", formatHours(s.minutes)),
          h("td", "num-col", s.days ? formatHours(Math.round(s.minutes / s.days)) : "—"),
          h("td", "num-col", pct(s.onTime, s.done)),
          h("td", "num-col" + (pending ? " cell-alert" : ""), pending)
        );
        if (counts) tr.append(h("td", "num-col", DONE_COUNTERS[name] ? s.quantity : "—"));
        return tr;
      })
    );
  }

  function renderDetailTasks(rows) {
    const all = !detail.who;
    const head = h("tr");
    ["Task"].concat(all ? ["Person"] : [], ["Type", "Times done", "Total time", "Avg time", "Late", "Last done"]).forEach((label, i) =>
      head.append(h("th", i === 0 || (all && i === 1) || label === "Type" ? "" : "num-col", label))
    );
    el.drTasksHead.replaceChildren(head);
    const byTask = new Map();
    for (const r of rows) {
      if (!r.end_time) continue;
      const x = byTask.get(r.task_id) || { r, done: 0, minutes: 0, late: 0, last: "" };
      x.done++;
      x.minutes += minutesTaken(r, false) || 0;
      if (!onTime(r)) x.late++;
      if (workDay(r) > x.last) x.last = workDay(r);
      byTask.set(r.task_id, x);
    }
    const list = [...byTask.values()].sort((a, b) => b.done - a.done || b.minutes - a.minutes);
    el.drTasks.replaceChildren(
      ...list.slice(0, taskLimit).map((x) => {
        const tr = h("tr");
        tr.append(h("td", "dr-task", x.r.title));
        if (all) tr.append(h("td", "", x.r.employee));
        const type = h("td");
        type.append(h("span", "freq-badge freq-" + x.r.frequency, FREQ_LABEL[x.r.frequency] || "Daily"));
        tr.append(
          type,
          h("td", "num-col", x.done),
          h("td", "num-col", formatHours(x.minutes)),
          h("td", "num-col", formatDuration(Math.round(x.minutes / x.done))),
          h("td", "num-col" + (x.late ? " cell-alert" : ""), x.late),
          h("td", "num-col", dayDate(x.last))
        );
        return tr;
      })
    );
    el.drTasksEmpty.hidden = list.length > 0;
    el.drTasksMore.hidden = list.length <= taskLimit;
    el.drTasksMore.textContent = "Show all " + list.length + " tasks";
  }

  function logStatus(r) {
    if (r.end_time) return onTime(r) ? ["Done", "status-done"] : ["Done late", "status-in_progress"];
    if (r.start_time) return ["In progress", "status-in_progress"];
    if (r.skipped) return ["Excused", "status-excused"];
    return ["Count only", "status-todo"];
  }

  function renderDetailLog(rows) {
    const all = !detail.who;
    const head = h("tr");
    ["Date"].concat(all ? ["Person"] : [], ["Task", "Type", "Start", "End", "Time taken", "Status"]).forEach((label) => head.append(h("th", label === "Time taken" ? "num-col" : "", label)));
    el.drLogHead.replaceChildren(head);
    const shown = rows.slice(0, logLimit);
    el.drLog.replaceChildren(
      ...shown.map((r) => {
        const tr = h("tr");
        const when = (day, time) => (time ? (day && day !== workDay(r) ? dayDate(day) + " " : "") + formatClock(time) : "—");
        const mins = minutesTaken(r, false);
        const [label, cls] = logStatus(r);
        const st = h("td");
        st.append(h("span", "pill " + cls, label));
        tr.append(h("td", "", dayDate(workDay(r))));
        if (all) tr.append(h("td", "", r.employee));
        const type = h("td");
        type.append(h("span", "freq-badge freq-" + r.frequency, FREQ_LABEL[r.frequency] || "Daily"));
        tr.append(
          h("td", "dr-task", r.title + (r.quantity ? " · " + r.quantity + " done" : "")),
          type,
          h("td", "", when(r.started_on, r.start_time)),
          h("td", "", when(r.ended_on, r.end_time)),
          h("td", "num-col", mins === null ? "—" : formatDuration(mins)),
          st
        );
        return tr;
      })
    );
    el.drLogEmpty.hidden = rows.length > 0;
    el.drLogCount.textContent = rows.length ? rows.length + (rows.length === 1 ? " entry" : " entries") : "";
    el.drLogMore.hidden = rows.length <= logLimit;
    el.drLogMore.textContent = "Show all " + rows.length + " entries";
  }

  function downloadDetailCsv() {
    if (!detail) return;
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [["Date", "Person", "Task", "Type", "Started", "Ended", "Minutes", "Status", "Items done"].join(",")];
    for (const r of detail.rows) {
      const mins = minutesTaken(r, false);
      lines.push(
        [
          workDay(r),
          r.employee,
          r.title,
          FREQ_LABEL[r.frequency] || "Daily",
          r.start_time ? (r.started_on || r.work_date) + " " + r.start_time.slice(0, 5) : "",
          r.end_time ? (r.ended_on || r.started_on || r.work_date) + " " + r.end_time.slice(0, 5) : "",
          mins ?? "",
          logStatus(r)[0],
          r.quantity ?? "",
        ].map(esc).join(",")
      );
    }
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sop-detailed-" + (detail.who ? detail.who.replace(/\s+/g, "-") + "-" : "") + detail.from + "-to-" + detail.to + ".csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  el.repDetail.addEventListener("click", () => openDetail(""));
  el.drPreset.addEventListener("change", loadDetail);
  el.drWho.addEventListener("change", loadDetail);
  for (const input of [el.drFrom, el.drTo]) {
    input.addEventListener("change", () => {
      el.drPreset.value = "custom";
      loadDetail();
    });
  }
  el.drLogMore.addEventListener("click", () => {
    logLimit = Infinity;
    renderDetailLog(detail.rows);
  });
  el.drTasksMore.addEventListener("click", () => {
    taskLimit = Infinity;
    renderDetailTasks(detail.rows);
  });
  el.drCsv.addEventListener("click", downloadDetailCsv);
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => active === REPORTS && detail && renderDetailChart(detail.rows), 150);
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
    el.reports.hidden = active !== REPORTS;
    el.tasksPanel.hidden = !person || !isTaskView();
    el.pendingPanel.hidden = !person || view !== "pending";
    el.remindersPanel.hidden = !person || view !== "reminders";
    el.notesPanel.hidden = !person;

    el.pageTitle.textContent = isAdmin() ? "Team SOP Dashboard" : me.name + "’s Tasks";

    const list = person && isTaskView() ? listFor(active, view) : [];
    renderDoneCounter(list);
    if (active === OVERVIEW) renderOverview();
    if (active === TEAM) renderTeam();
    if (active === REPORTS) renderDetailFilters();
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
    el.addDue.hidden = true;
    el.addDays.hidden = view === "daily";
    if (view !== "daily" && el.addDays.dataset.kind !== view) {
      getAddDays = dayPicker(el.addDays, [1], view === "monthly" ? "month" : "week");
      el.addDays.dataset.kind = view;
    }
    el.addInput.placeholder = isAdmin() ? "Add a " + view + " task for " + active + "…" : "Add a " + view + " task…";
    if (el.addRepeat.dataset.kind !== view) {
      el.addRepeat.value = "repeat";
      repeatOptions(el.addRepeat, view);
      el.addUnit.value = "always";
      el.addCount.hidden = true;
      el.addRepeat.dataset.kind = view;
    }
    el.addFor.hidden = el.addRepeat.value === "once";
  }

  let getAddDays = () => [1];

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

  // Pause stops the clock; Resume starts it again. Only worked time counts.
  async function pauseTask(task, key, resume) {
    const mapKey = task.id + "|" + key;
    const current = entries.get(mapKey) || recent.get(mapKey) || EMPTY_ENTRY;
    const apply = (e) => {
      if (entries.has(mapKey) || occurrenceKey(task, selectedDate) === key) entries.set(mapKey, e);
      if (recent.has(mapKey) || key >= pendingWindowStart()) recent.set(mapKey, e);
    };
    try {
      const saved = await store.saveEntry(task.id, key, { quantity: current.quantity ?? null, [resume ? "resume" : "pause"]: true });
      if (saved) apply({ ...current, ...saved });
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
    const visible = listFor(task.employee, isTaskView() ? view : task.frequency || "daily");
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
    const row = { employee: active, title, frequency: view, ...newTaskSpan(view, el.addRepeat.value === "once", el.addCount.value, el.addUnit.value) };
    if (view !== "daily") {
      if (!getAddDays().length) return showToast(view === "monthly" ? "Pick at least one date." : "Pick at least one day.");
      Object.assign(row, view === "monthly" ? freqFromDates(getAddDays()) : freqFromDays(getAddDays()));
    }
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
    if (s.idle_minutes) idleMinutes = s.idle_minutes;
    // Signed out by the timer here, or by the server after the same time.
    const idleNote = idleSignedOut || (me && idleTooLong()) ? "You were signed out after " + formatHours(idleMinutes) + " without activity. Please sign in again." : "";
    if (MODE === "admin") {
      if (!s.user) {
        me = null;
        el.adminPassword.value = "";
        el.adminError.textContent = idleNote;
        idleSignedOut = false;
        return showAuthStep("admin");
      }
      return enterApp(s);
    }
    if (!s.site_ok) {
      me = null;
      el.sitePassword.value = "";
      el.siteError.textContent = idleNote;
      idleSignedOut = false;
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
    markActive();
    idleSignedOut = false;
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
    active = isAdmin() ? readPref("tab", (v) => v === OVERVIEW || v === TEAM || v === REPORTS || employees.includes(v), OVERVIEW) : employees[0];
    view = readPref("view", (v) => VIEWS.some((x) => x.key === v), "daily");
    render();
    if (!subscribed) {
      store.subscribe(scheduleRefresh);
      subscribed = true;
    }
    await refresh();
    if (active === OVERVIEW) loadReport();
    if (active === REPORTS) loadDetail();
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

  let idleSignedOut = false;

  function idleTooLong() {
    return Date.now() - lastActive() > idleMinutes * 60 * 1000;
  }

  async function checkIdle() {
    if (!me || !idleTooLong()) return;
    idleSignedOut = true;
    await signOut("logout");
  }
  setInterval(checkIdle, 30 * 1000);
  // Timers pause while a computer sleeps, so check again when the page comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkIdle();
  });
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

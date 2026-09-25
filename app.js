(function () {
  "use strict";

  const EMPLOYEES = window.EMPLOYEES;
  const SEED_VERSION = window.SEED_VERSION;
  const DONE_COUNTERS = window.DONE_COUNTERS || {};
  const config = window.SOP_CONFIG || {};

  // Flatten SEED_TASKS into rows: { employee, title, position }.
  function seedRows() {
    const rows = [];
    for (const employee of EMPLOYEES) {
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
  const EMPTY_ENTRY = Object.freeze({ start_time: null, end_time: null });

  // "HH:MM:SS" (Postgres time) -> "HH:MM" for <input type="time">.
  function toInputTime(t) {
    return t ? t.slice(0, 5) : "";
  }

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

  // -------------------------------------------------------------------------
  // Data stores. Both expose the same interface:
  //   init()                          -> apply seed version, resolve when ready
  //   listTasks()                     -> Promise<Task[]>
  //   listEntries(date)               -> Promise<Entry[]> for that day
  //   insertTask({employee,title,position})
  //   removeTask(id)                  -> also removes its history
  //   saveEntry(taskId, date, {start_time, end_time})
  //   subscribe(onChange)             -> called when data changes elsewhere
  // -------------------------------------------------------------------------

  function createSupabaseStore(url, key) {
    const client = window.supabase.createClient(url, key);

    async function check(promise) {
      const { data, error } = await promise;
      if (error) throw error;
      return data;
    }

    return {
      mode: "supabase",
      async init() {
        await check(client.rpc("apply_seed", { p_version: SEED_VERSION, p_tasks: seedRows() }));
      },
      listTasks() {
        return check(
          client
            .from("tasks")
            .select("id, employee, title, position, created_at")
            .order("position", { ascending: true })
            .order("created_at", { ascending: true })
        );
      },
      listEntries(date) {
        return check(client.from("task_entries").select("task_id, start_time, end_time").eq("work_date", date));
      },
      insertTask(row) {
        return check(client.from("tasks").insert(row));
      },
      removeTask(id) {
        return check(client.from("tasks").delete().eq("id", id));
      },
      saveEntry(taskId, date, times) {
        return check(
          client
            .from("task_entries")
            .upsert({ task_id: taskId, work_date: date, ...times }, { onConflict: "task_id,work_date" })
        );
      },
      subscribe(onChange) {
        client
          .channel("dashboard-changes")
          .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, onChange)
          .on("postgres_changes", { event: "*", schema: "public", table: "task_entries" }, onChange)
          .subscribe();
      },
    };
  }

  // Fallback used until Supabase is configured: data lives in this browser only.
  function createLocalStore() {
    const KEY = "sop-dashboard:v2";

    function load() {
      try {
        const s = JSON.parse(localStorage.getItem(KEY));
        if (s && Array.isArray(s.tasks) && s.entries) return s;
      } catch (e) {}
      return { seedVersion: 0, tasks: [], entries: {} };
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

    return {
      mode: "local",
      async init() {
        if (state.seedVersion >= SEED_VERSION) return;
        // Same rules as apply_seed() in schema.sql.
        const seed = seedRows();
        const inSeed = (t) => seed.some((s) => s.employee === t.employee && s.title === t.title);
        const removed = state.tasks.filter((t) => t.from_seed && !inSeed(t)).map((t) => t.id);
        state.tasks = state.tasks.filter((t) => !removed.includes(t.id));
        for (const date of Object.keys(state.entries)) {
          removed.forEach((id) => delete state.entries[date][id]);
        }
        for (const s of seed) {
          const existing = state.tasks.find((t) => t.employee === s.employee && t.title === s.title);
          if (existing) Object.assign(existing, { position: s.position, from_seed: true });
          else state.tasks.push({ ...s, id: newId(), from_seed: true, created_at: new Date().toISOString() });
        }
        state.seedVersion = SEED_VERSION;
        save();
      },
      async listTasks() {
        return state.tasks
          .slice()
          .sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
      },
      async listEntries(date) {
        const day = state.entries[date] || {};
        return Object.keys(day).map((taskId) => ({ task_id: taskId, ...day[taskId] }));
      },
      async insertTask(row) {
        state.tasks.push({ ...row, id: newId(), from_seed: false, created_at: new Date().toISOString() });
        save();
      },
      async removeTask(id) {
        state.tasks = state.tasks.filter((t) => t.id !== id);
        for (const date of Object.keys(state.entries)) delete state.entries[date][id];
        save();
      },
      async saveEntry(taskId, date, times) {
        state.entries[date] = state.entries[date] || {};
        state.entries[date][taskId] = { ...times };
        save();
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

  const store =
    config.supabaseUrl && config.supabaseAnonKey && window.supabase
      ? createSupabaseStore(config.supabaseUrl, config.supabaseAnonKey)
      : createLocalStore();

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  const el = {
    tabs: document.getElementById("tabs"),
    summary: document.getElementById("summary"),
    rows: document.getElementById("task-rows"),
    empty: document.getElementById("empty"),
    addForm: document.getElementById("add-form"),
    addInput: document.getElementById("add-input"),
    banner: document.getElementById("banner"),
    toast: document.getElementById("toast"),
    today: document.getElementById("today"),
    todayDay: document.getElementById("today-day"),
    todayWeekday: document.getElementById("today-weekday"),
    todayMonth: document.getElementById("today-month"),
    datePicker: document.getElementById("date-picker"),
    datePrev: document.getElementById("date-prev"),
    dateNext: document.getElementById("date-next"),
    dateToday: document.getElementById("date-today"),
    dateNote: document.getElementById("date-note"),
    doneCounter: document.getElementById("done-counter"),
  };

  let tasks = [];
  let entries = new Map(); // task_id -> { start_time, end_time } for selectedDate
  let active = readActiveTab();
  let todayStr = ymd(new Date());
  let selectedDate = todayStr;
  let renderPending = false;

  function isToday() {
    return selectedDate === todayStr;
  }

  function entryFor(taskId) {
    return entries.get(taskId) || EMPTY_ENTRY;
  }

  function readActiveTab() {
    try {
      const saved = localStorage.getItem("sop-dashboard:tab");
      if (EMPLOYEES.includes(saved)) return saved;
    } catch (e) {}
    return EMPLOYEES[0];
  }

  function setActiveTab(name) {
    active = name;
    try {
      localStorage.setItem("sop-dashboard:tab", name);
    } catch (e) {}
    render();
  }

  function setDate(date) {
    if (!date || date === selectedDate) return;
    selectedDate = date;
    entries = new Map();
    render();
    refresh();
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => (el.toast.hidden = true), 4000);
  }

  async function refresh() {
    const date = selectedDate;
    let t, e;
    try {
      [t, e] = await Promise.all([store.listTasks(), store.listEntries(date)]);
    } catch (err) {
      showToast("Couldn't load tasks: " + err.message);
      return;
    }
    if (date !== selectedDate) return; // the date changed while loading
    tasks = t;
    entries = new Map(e.map((x) => [x.task_id, { start_time: x.start_time, end_time: x.end_time }]));
    render();
  }

  // Coalesce bursts of realtime events (e.g. a reseed) into one reload.
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
      showToast("Couldn't save: " + e.message);
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

  function renderDate() {
    const d = parseYmd(selectedDate);
    el.todayDay.textContent = d.getDate();
    el.todayWeekday.textContent = d.toLocaleDateString("en-GB", { weekday: "long" });
    el.todayMonth.textContent = d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    el.today.setAttribute("datetime", selectedDate);
    el.datePicker.value = selectedDate;
    el.dateToday.hidden = isToday();
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
    const noun = DONE_COUNTERS[active];
    el.doneCounter.hidden = !noun;
    if (!noun) return;
    const done = countStatuses(list).done;
    const n = document.createElement("strong");
    n.textContent = done;
    const of = document.createElement("span");
    of.className = "done-of";
    of.textContent = "/ " + list.length;
    const label = document.createElement("span");
    label.className = "done-label";
    label.textContent = noun + " done " + (isToday() ? "today" : "on this day");
    el.doneCounter.replaceChildren(n, of, label);
  }

  function renderTabs() {
    el.tabs.replaceChildren(
      ...EMPLOYEES.map((name) => {
        const list = tasksFor(name);
        const done = countStatuses(list).done;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tab";
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", String(name === active));
        const label = document.createElement("span");
        label.textContent = name;
        const badge = document.createElement("span");
        badge.className = "tab-count";
        badge.textContent = done + "/" + list.length;
        btn.append(label, badge);
        btn.addEventListener("click", () => setActiveTab(name));
        return btn;
      })
    );
  }

  function renderSummary(list) {
    const c = countStatuses(list);
    const total = list
      .map((t) => entryFor(t.id))
      .filter((e) => e.start_time && e.end_time)
      .reduce((sum, e) => sum + minutesTaken(e, false), 0);
    const totalChip = document.createElement("div");
    totalChip.className = "summary-chip summary-total";
    const totalN = document.createElement("strong");
    totalN.textContent = formatDuration(total);
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "Total Time Taken";
    totalChip.append(totalN, totalLabel);

    el.summary.replaceChildren(
      ...["todo", "in_progress", "done"].map((s) => {
        const chip = document.createElement("div");
        chip.className = "summary-chip status-" + s;
        const n = document.createElement("strong");
        n.textContent = c[s];
        const label = document.createElement("span");
        label.textContent = STATUS_LABEL[s];
        chip.append(n, label);
        return chip;
      }),
      totalChip
    );
  }

  function timeCell(task, entry, field) {
    const td = document.createElement("td");
    td.className = "time-cell";
    td.dataset.label = field === "start_time" ? "Start" : "End";
    const wrap = document.createElement("div");
    wrap.className = "time-wrap";

    const input = document.createElement("input");
    input.type = "time";
    input.value = toInputTime(entry[field]);
    input.setAttribute("aria-label", (field === "start_time" ? "Start time for " : "End time for ") + task.title);
    input.addEventListener("change", () => setTime(task.id, field, input.value || null));
    wrap.append(input);

    if (!entry[field]) {
      // "Now" only makes sense for today; other days are filled in by hand.
      if (isToday()) {
        const now = document.createElement("button");
        now.type = "button";
        now.className = "btn-now";
        now.textContent = "Now";
        now.addEventListener("click", () => setTime(task.id, field, nowHHMM()));
        wrap.append(now);
      }
    } else {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "btn-icon";
      clear.title = "Clear time";
      clear.setAttribute("aria-label", "Clear " + (field === "start_time" ? "start" : "end") + " time");
      clear.textContent = "×";
      clear.addEventListener("click", () => setTime(task.id, field, null));
      wrap.append(clear);
    }
    td.append(wrap);
    return td;
  }

  function renderRows(list) {
    el.rows.replaceChildren(
      ...list.map((task, i) => {
        const tr = document.createElement("tr");
        const entry = entryFor(task.id);
        const status = statusOf(entry);

        const num = document.createElement("td");
        num.className = "num";
        num.textContent = i + 1;

        const title = document.createElement("td");
        title.className = "title";
        title.textContent = task.title;

        const st = document.createElement("td");
        st.className = "status-cell";
        const pill = document.createElement("span");
        pill.className = "pill status-" + status;
        pill.textContent = STATUS_LABEL[status];
        st.append(pill);

        const taken = document.createElement("td");
        taken.className = "taken-cell";
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

        const actions = document.createElement("td");
        actions.className = "actions";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn-delete";
        del.title = "Delete task";
        del.setAttribute("aria-label", "Delete " + task.title);
        del.innerHTML =
          '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/></svg>';
        del.addEventListener("click", () => {
          // Two-step delete: first click arms the button, second click deletes.
          if (del.classList.contains("armed")) return deleteTask(task);
          del.classList.add("armed");
          del.textContent = "Delete?";
          setTimeout(() => render(), 3000);
        });
        actions.append(del);

        tr.append(
          num,
          title,
          timeCell(task, entry, "start_time"),
          timeCell(task, entry, "end_time"),
          st,
          taken,
          actions
        );
        return tr;
      })
    );
    el.empty.hidden = list.length > 0;
  }

  function render() {
    renderDate();
    // Don't rebuild the table under someone who is mid-edit in a time field;
    // catch up once they leave it.
    const focused = document.activeElement;
    if (focused && focused.type === "time" && el.rows.contains(focused)) {
      renderPending = true;
      return;
    }
    renderPending = false;
    const list = tasksFor(active);
    renderTabs();
    renderSummary(list);
    renderDoneCounter(list);
    renderRows(list);
    el.addInput.placeholder = "Add a task for " + active + "…";
  }

  el.rows.addEventListener("focusout", () => {
    setTimeout(() => renderPending && render(), 0);
  });

  function setTime(taskId, field, value) {
    const date = selectedDate;
    const next = { ...entryFor(taskId), [field]: value };
    mutate(
      () => entries.set(taskId, next),
      () => store.saveEntry(taskId, date, { start_time: next.start_time, end_time: next.end_time })
    );
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
    if (!title) return;
    const list = tasksFor(active);
    const position = list.length ? Math.max(...list.map((t) => t.position)) + 1 : 0;
    el.addInput.value = "";
    try {
      await store.insertTask({ employee: active, title, position });
    } catch (err) {
      showToast("Couldn't add task: " + err.message);
      el.addInput.value = title;
      return;
    }
    refresh();
  });

  el.datePicker.addEventListener("change", () => setDate(el.datePicker.value));
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

  async function start() {
    if (store.mode === "local") {
      el.banner.hidden = false;
    }
    render();
    try {
      await store.init();
    } catch (e) {
      showToast("Couldn't sync task list: " + e.message);
    }
    store.subscribe(scheduleRefresh);
    await refresh();
  }

  start();
})();

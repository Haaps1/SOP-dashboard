(function () {
  "use strict";

  const EMPLOYEES = window.EMPLOYEES;
  const SEED_VERSION = window.SEED_VERSION;
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

  // Status is derived, never stored by the UI.
  function statusOf(task) {
    if (task.end_time) return "done";
    if (task.start_time) return "in_progress";
    return "todo";
  }

  const STATUS_LABEL = { todo: "To Do", in_progress: "In Progress", done: "Done" };

  // "HH:MM:SS" (Postgres time) -> "HH:MM" for <input type="time">.
  function toInputTime(t) {
    return t ? t.slice(0, 5) : "";
  }

  function nowHHMM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // -------------------------------------------------------------------------
  // Data stores. Both expose the same interface:
  //   init()                 -> apply seed version, resolve when ready
  //   list()                 -> Promise<Task[]>
  //   insert({employee,title,position})
  //   update(id, patch)
  //   remove(id)
  //   subscribe(onChange)    -> called when data changes elsewhere
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
      list() {
        return check(
          client
            .from("tasks")
            .select("id, employee, title, position, start_time, end_time, created_at")
            .order("position", { ascending: true })
            .order("created_at", { ascending: true })
        );
      },
      insert(row) {
        return check(client.from("tasks").insert(row));
      },
      update(id, patch) {
        return check(client.from("tasks").update(patch).eq("id", id));
      },
      remove(id) {
        return check(client.from("tasks").delete().eq("id", id));
      },
      subscribe(onChange) {
        client
          .channel("tasks-changes")
          .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, onChange)
          .subscribe();
      },
    };
  }

  // Fallback used until Supabase is configured: data lives in this browser only.
  function createLocalStore() {
    const KEY = "sop-dashboard:v1";

    function load() {
      try {
        return JSON.parse(localStorage.getItem(KEY)) || { seedVersion: 0, tasks: [] };
      } catch (e) {
        return { seedVersion: 0, tasks: [] };
      }
    }
    function save(state) {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        /* storage unavailable: changes last for this page view only */
      }
    }
    let state = load();

    return {
      mode: "local",
      async init() {
        if (state.seedVersion >= SEED_VERSION) return;
        // Same rule as apply_seed(): keep times for tasks that still exist.
        const old = state.tasks;
        state = {
          seedVersion: SEED_VERSION,
          tasks: seedRows().map((r) => {
            const prev = old.find((o) => o.employee === r.employee && o.title === r.title);
            return {
              ...r,
              id: crypto.randomUUID(),
              start_time: prev ? prev.start_time : null,
              end_time: prev ? prev.end_time : null,
            };
          }),
        };
        save(state);
      },
      async list() {
        return state.tasks.slice().sort((a, b) => a.position - b.position);
      },
      async insert(row) {
        state.tasks.push({ ...row, id: crypto.randomUUID(), start_time: null, end_time: null });
        save(state);
      },
      async update(id, patch) {
        const t = state.tasks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        save(state);
      },
      async remove(id) {
        state.tasks = state.tasks.filter((x) => x.id !== id);
        save(state);
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
  };

  let tasks = [];
  let active = readActiveTab();
  let renderPending = false;

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

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => (el.toast.hidden = true), 4000);
  }

  async function refresh() {
    try {
      tasks = await store.list();
    } catch (e) {
      showToast("Couldn't load tasks: " + e.message);
      return;
    }
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
    list.forEach((t) => c[statusOf(t)]++);
    return c;
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
      })
    );
  }

  function timeCell(task, field) {
    const td = document.createElement("td");
    td.className = "time-cell";
    td.dataset.label = field === "start_time" ? "Start" : "End";
    const wrap = document.createElement("div");
    wrap.className = "time-wrap";

    const input = document.createElement("input");
    input.type = "time";
    input.value = toInputTime(task[field]);
    input.setAttribute("aria-label", (field === "start_time" ? "Start time for " : "End time for ") + task.title);
    input.addEventListener("change", () => setTime(task.id, field, input.value || null));
    wrap.append(input);

    if (!task[field]) {
      const now = document.createElement("button");
      now.type = "button";
      now.className = "btn-now";
      now.textContent = "Now";
      now.addEventListener("click", () => setTime(task.id, field, nowHHMM()));
      wrap.append(now);
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
        const status = statusOf(task);

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

        tr.append(num, title, timeCell(task, "start_time"), timeCell(task, "end_time"), st, actions);
        return tr;
      })
    );
    el.empty.hidden = list.length > 0;
  }

  function render() {
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
    renderRows(list);
    el.addInput.placeholder = "Add a task for " + active + "…";
  }

  el.rows.addEventListener("focusout", () => {
    setTimeout(() => renderPending && render(), 0);
  });

  function setTime(id, field, value) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const patch = { [field]: value };
    mutate(
      () => Object.assign(task, patch),
      () => store.update(id, patch)
    );
  }

  function deleteTask(task) {
    mutate(
      () => (tasks = tasks.filter((t) => t.id !== task.id)),
      () => store.remove(task.id)
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
      await store.insert({ employee: active, title, position });
    } catch (err) {
      showToast("Couldn't add task: " + err.message);
      el.addInput.value = title;
      return;
    }
    refresh();
  });

  async function start() {
    if (store.mode === "local") {
      el.banner.hidden = false;
    }
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

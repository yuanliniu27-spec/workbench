(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  let state = null;
  let filter = "todo";
  let sortable = null;
  let timers = [];
  let saveQueue = Promise.resolve();
  let deferredPrompt = null;
  let syncTimer = null;
  let pushing = false;
  let lastOpen = { editor: false, settings: false };

  const els = {
    list: $("#task-list"),
    hello: $("#hello"),
    stats: $("#stats"),
    dateMobile: $("#date-line-mobile"),
    dateDesk: $("#date-line-desk"),
    deskTitle: $("#desk-title"),
    listHeading: $("#list-heading"),
    listHint: $("#list-hint"),
    sampleBanner: $("#sample-banner"),
    notifyBanner: $("#notify-banner"),
    installBanner: $("#install-banner"),
    remindList: $("#remind-list"),
    timeline: $("#timeline-list"),
    restSummary: $("#rest-summary"),
    editor: $("#editor"),
    settings: $("#settings"),
    confirm: $("#confirm"),
    toast: $("#toast"),
    form: $("#task-form"),
    title: $("#title-input"),
    titleCount: $("#title-count"),
    pending: $("#pending-check"),
    whenFields: $("#when-fields"),
    dueDate: $("#due-date"),
    dueTime: $("#due-time"),
    durValue: $("#dur-value"),
    durUnit: $("#dur-unit"),
    editorReminder: $("#editor-reminder"),
    editorTitle: $("#editor-title"),
    taskId: $("#task-id"),
    toggleDone: $("#toggle-done"),
    deleteTask: $("#delete-task"),
    syncCode: $("#sync-code"),
    syncInput: $("#sync-input"),
    syncStatus: $("#sync-status"),
    notifyStatus: $("#notify-status"),
    leadHours: $("#lead-hours"),
    restAvoid: $("#rest-avoid"),
    restEditor: $("#rest-editor")
  };

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  function persist(mutator, opts) {
    saveQueue = saveQueue
      .then(async () => {
        if (typeof mutator === "function") mutator(state);
        state = await WB.saveState(state, opts);
        scheduleReminders();
        if (!opts || !opts.skipSync) queueSyncPush();
        return state;
      })
      .catch((err) => {
        console.error(err);
        toast("保存失败，请再试一次");
      });
    return saveQueue;
  }

  function incomplete() {
    return state.tasks.filter((t) => !t.done).sort((a, b) => a.order - b.order);
  }

  function completed() {
    return state.tasks
      .filter((t) => t.done)
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  }

  function visibleTasks() {
    if (filter === "done") return completed();
    if (filter === "all") return incomplete().concat(completed());
    return incomplete();
  }

  function priClass(n) {
    if (n <= 1) return "p1";
    if (n === 2) return "p2";
    return `p${Math.min(n, 6)}`;
  }

  function isOverdue(task, now) {
    if (!task.dueAt || task.done) return false;
    return new Date(task.dueAt).getTime() < now.getTime();
  }

  function reminderChip(task, now) {
    const rem = WB.reminderForTask(task, state.settings);
    if (!rem) return "";
    const key = WB.reminderKey(task.id, rem.at);
    if (state.notified[key]) {
      return `<span class="chip">已提醒 ${esc(WB.formatShortDateTime(rem.at))}</span>`;
    }
    if (rem.at.getTime() < now.getTime() - 60 * 1000) return "";
    const atLabel = WB.formatShortDateTime(rem.at);
    if (rem.early) {
      return `<span class="chip early">避开休息时间，提前至${esc(atLabel)}</span>`;
    }
    const dueLabel = WB.formatDueLabel(task.dueAt, now);
    return `<span class="chip">${esc(dueLabel)} 前提醒 · 计划 ${esc(atLabel)} 推送</span>`;
  }

  function render() {
    if (!state) return;
    const now = new Date();
    const todo = incomplete();
    const done = completed();
    const dueToday = WB.dueTodayTasks(state, now);
    const upcoming = WB.upcomingReminders(state, now, 8);
    const earlyCount = upcoming.filter((x) => x.rem.early).length;
    const name = state.settings.name || "元丽";

    els.dateMobile.textContent = WB.formatDateLine(now);
    els.dateDesk.textContent = `${WB.formatDateLine(now).replace(" · 上海时间", "")} · 拖动左侧手柄调整优先级`;
    els.hello.innerHTML = `你好，${esc(name)}<br>今天有 ${todo.length} 件待办`;

    els.stats.innerHTML = `
      <div class="stat"><b>${dueToday.length}</b> 项今日到期</div>
      <div class="stat ${earlyCount ? "warn" : ""}"><b>${upcoming.length}</b> 项将提前提醒</div>
    `;

    $("#nav-todo").textContent = todo.length;
    $("#nav-all").textContent = state.tasks.length;
    $("#nav-done").textContent = done.length;
    $("#f-todo").textContent = todo.length;
    $("#f-all").textContent = state.tasks.length;
    $("#f-done").textContent = done.length;

    $$("[data-filter]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === filter);
    });

    const titles = { todo: "今日待办", all: "全部任务", done: "已完成" };
    els.deskTitle.textContent = titles[filter];
    if (filter === "done") {
      els.listHeading.textContent = "已完成";
      els.listHint.textContent = "按完成时间排列";
    } else {
      els.listHeading.textContent = "按优先级排列";
      els.listHint.textContent = "按住左侧拖动排序";
    }

    const samples = state.tasks.some((t) => t.isSample && !t.done);
    els.sampleBanner.hidden = !samples;

    const periods = state.settings.restPeriods || [];
    const lines = periods.map((p) => {
      const overnight = WB.parseHm(p.start) > WB.parseHm(p.end);
      const range = overnight
        ? `${p.start}–次日 ${p.end}`
        : `${p.start}–${p.end}`;
      return `${esc(p.label || "休息")} ${range}`;
    });
    els.restSummary.innerHTML = `<b>休息时间（可改）</b>${lines.join("<br>")}<br>定时提醒会自动提前到休息开始前。`;

    const items = visibleTasks();
    if (!items.length) {
      els.list.innerHTML = `<div class="empty">${
        filter === "done" ? "还没有已完成的任务。" : "还没有任务，点上方记下第一件。"
      }</div>`;
    } else {
      const orderMap = new Map(incomplete().map((t, i) => [t.id, i + 1]));
      els.list.innerHTML = items
        .map((task) => {
          const n = task.done ? "✓" : orderMap.get(task.id) || "";
          const cls = task.done ? "p3" : priClass(orderMap.get(task.id) || 3);
          const overdue = isOverdue(task, now);
          const extra = [];
          if (task.isSample) extra.push(`<span class="chip sample">示例，可删</span>`);
          if (overdue) extra.push(`<span class="chip overdue">已过开始/完成时间</span>`);
          extra.push(reminderChip(task, now));
          const metaBits = [WB.formatDuration(task.durationMin)];
          if (!task.dueAt && !task.done) metaBits.push("记下后可补时间");
          return `<article class="card${task.done ? " done" : ""}${overdue ? " overdue" : ""}" data-id="${esc(task.id)}">
            <div class="grip" title="拖动排序" aria-label="拖动排序">⠿</div>
            <div class="pri ${cls}">${n}</div>
            <div class="body">
              <div class="title">${esc(task.title)}</div>
              <div class="times"><span>开始/完成时间</span><b>${esc(WB.formatDueLabel(task.dueAt, now))}</b></div>
              <div class="meta">${esc(metaBits.join(" · "))}</div>
              ${extra.join("")}
            </div>
            <div class="drag-hint">${task.done ? "已完成" : "可拖动"}</div>
          </article>`;
        })
        .join("");
    }

    if (!upcoming.length) {
      els.remindList.innerHTML = `<p class="hint-text">暂无即将到来的提醒。为任务补上开始/完成时间后会自动安排。</p>`;
    } else {
      els.remindList.innerHTML = upcoming
        .map(({ task, rem }) => {
          const lead = state.settings.reminderLeadHours;
          const due = WB.formatDueLabel(task.dueAt, now);
          const sub = rem.early
            ? `定时 ${esc(due)}`
            : `定时 ${esc(due)} · 提前 ${lead} 小时`;
          const time = rem.early
            ? `避开休息时间，提前至${esc(WB.formatShortDateTime(rem.at))}`
            : `${esc(WB.formatShortDateTime(rem.at))} 推送到本机`;
          return `<div class="remind${rem.early ? " early" : ""}" data-id="${esc(task.id)}">
            <div class="t">${esc(task.title)}</div>
            <div class="d">${sub}</div>
            <div class="time">${time}</div>
          </div>`;
        })
        .join("");
    }

    const slots = WB.dueTodayTimeline(state, now);
    if (!slots.length) {
      els.timeline.innerHTML = `<p class="hint-text">今天还没有排定开始/完成时间的任务。</p>`;
    } else {
      els.timeline.innerHTML = slots
        .map((task, i) => {
          const p = WB.shanghaiParts(new Date(task.dueAt));
          const hm = `${WB.pad(p.hour)}:${WB.pad(p.minute)}`;
          const barCls = i === 0 ? "" : i === 1 ? " b2" : " b3";
          return `<div class="slot">
            <div class="hr">${hm}</div>
            <div class="bar${barCls}">${esc(task.title)}<small>开始/完成时间</small></div>
          </div>`;
        })
        .join("");
    }

    updateNotifyBanner();
    setupSortable();
  }

  function setupSortable() {
    if (sortable) {
      sortable.destroy();
      sortable = null;
    }
    if (filter === "done") return;
    if (!window.Sortable) return;
    if (!$(".card", els.list)) return;
    sortable = Sortable.create(els.list, {
      handle: ".grip",
      animation: 180,
      ghostClass: "sortable-ghost",
      dragClass: "sortable-drag",
      filter: ".done, .empty",
      preventOnFilter: false,
      delay: 0,
      delayOnTouchOnly: false,
      touchStartThreshold: 4,
      fallbackTolerance: 4,
      onEnd: async (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const ids = $$(".card", els.list)
          .map((el) => el.dataset.id)
          .filter((id) => {
            const t = state.tasks.find((x) => x.id === id);
            return t && !t.done;
          });
        await persist((s) => {
          ids.forEach((id, i) => {
            const t = s.tasks.find((x) => x.id === id);
            if (t) {
              t.order = i;
              t.updatedAt = Date.now();
            }
          });
        });
        render();
      }
    });
  }

  function openOverlay(el) {
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("open"));
  }

  function closeOverlay(el) {
    el.classList.remove("open");
    setTimeout(() => {
      if (!el.classList.contains("open")) el.hidden = true;
    }, 200);
  }

  function closeAllOverlays() {
    closeOverlay(els.editor);
    closeOverlay(els.settings);
    closeOverlay(els.confirm);
  }

  function updateTitleCount() {
    const n = WB.countChars(els.title.value);
    els.titleCount.textContent = `${n}/${WB.TITLE_MAX}`;
    els.titleCount.classList.toggle("full", n >= WB.TITLE_MAX);
  }

  function enforceTitle() {
    if (els.title.composing) return;
    if (WB.countChars(els.title.value) > WB.TITLE_MAX) {
      els.title.value = WB.clipTitle(els.title.value);
    }
    updateTitleCount();
  }

  function setPendingUI() {
    const on = els.pending.checked;
    els.whenFields.style.opacity = on ? 0.45 : 1;
    els.dueDate.disabled = on;
    els.dueTime.disabled = on;
    updateEditorReminder();
  }

  function durationMinutes() {
    const raw = Number(els.durValue.value);
    if (!raw || raw < 0) return 0;
    return els.durUnit.value === "hour" ? Math.round(raw * 60) : Math.round(raw);
  }

  function applyDuration(min) {
    if (min >= 60 && min % 30 === 0) {
      els.durUnit.value = "hour";
      els.durValue.value = String(min / 60);
    } else {
      els.durUnit.value = "min";
      els.durValue.value = String(min);
    }
    $$("#dur-chips button").forEach((b) =>
      b.classList.toggle("on", Number(b.dataset.min) === min)
    );
  }

  function updateEditorReminder() {
    if (els.pending.checked || !els.dueDate.value || !els.dueTime.value) {
      els.editorReminder.textContent = "待定任务不会推送提醒。补上开始/完成时间后，将至少提前 2 小时通知。";
      return;
    }
    const [y, m, d] = els.dueDate.value.split("-").map(Number);
    const [h, min] = els.dueTime.value.split(":").map(Number);
    const dueAt = WB.fromShanghai(y, m, d, h, min, 0).toISOString();
    const rem = WB.reminderForTask(
      { id: "preview", done: false, dueAt },
      state.settings
    );
    if (!rem) return;
    const when = WB.formatShortDateTime(rem.at);
    els.editorReminder.textContent = rem.early
      ? `提醒将避开休息时间，提前至${when}。`
      : `将在 ${when} 提醒（开始/完成时间提前 ${state.settings.reminderLeadHours} 小时）。`;
  }

  function openEditor(task) {
    const isNew = !task;
    els.editorTitle.textContent = isNew ? "记下任务" : "编辑任务";
    els.taskId.value = task ? task.id : "";
    els.title.value = task ? task.title : "";
    updateTitleCount();
    if (task && task.dueAt) {
      els.pending.checked = false;
      const p = WB.shanghaiParts(new Date(task.dueAt));
      els.dueDate.value = `${p.year}-${WB.pad(p.month)}-${WB.pad(p.day)}`;
      els.dueTime.value = `${WB.pad(p.hour)}:${WB.pad(p.minute)}`;
    } else if (task) {
      els.pending.checked = true;
      const p = WB.shanghaiParts(new Date());
      els.dueDate.value = `${p.year}-${WB.pad(p.month)}-${WB.pad(p.day)}`;
      els.dueTime.value = "";
    } else {
      els.pending.checked = false;
      const later = new Date(Date.now() + 3 * 3600 * 1000);
      const p = WB.shanghaiParts(later);
      els.dueDate.value = `${p.year}-${WB.pad(p.month)}-${WB.pad(p.day)}`;
      els.dueTime.value = `${WB.pad(p.hour)}:${WB.pad(p.minute)}`;
    }
    applyDuration(task ? task.durationMin : 60);
    els.deleteTask.hidden = isNew;
    els.toggleDone.hidden = isNew;
    els.toggleDone.textContent = task && task.done ? "取消完成" : "完成";
    setPendingUI();
    openOverlay(els.editor);
    setTimeout(() => els.title.focus(), 220);
  }

  async function saveTask(evt) {
    evt.preventDefault();
    enforceTitle();
    const title = WB.clipTitle(els.title.value);
    if (!title) {
      toast("请填写主题");
      els.title.focus();
      return;
    }
    if (WB.countChars(title) > WB.TITLE_MAX) {
      toast("主题不能超过 10 个字");
      return;
    }
    let dueAt = null;
    if (!els.pending.checked) {
      if (!els.dueDate.value || !els.dueTime.value) {
        toast("请填写开始/完成时间，或勾选待定");
        return;
      }
      const [y, m, d] = els.dueDate.value.split("-").map(Number);
      const [h, min] = els.dueTime.value.split(":").map(Number);
      dueAt = WB.fromShanghai(y, m, d, h, min, 0).toISOString();
    }
    const durationMin = durationMinutes();
    if (!durationMin) {
      toast("请填写预计耗时");
      return;
    }
    const id = els.taskId.value;
    await persist((s) => {
      if (id) {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return;
        t.title = title;
        t.dueAt = dueAt;
        t.durationMin = durationMin;
        t.isSample = false;
        t.updatedAt = Date.now();
      } else {
        const order = incomplete().length;
        s.tasks.push({
          id: WB.uid("task"),
          title,
          dueAt,
          durationMin,
          done: false,
          order,
          isSample: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          completedAt: null
        });
      }
    });
    closeOverlay(els.editor);
    render();
    toast(id ? "已保存" : "已记下");
  }

  function askConfirm(text, okLabel) {
    return new Promise((resolve) => {
      $("#confirm-text").textContent = text;
      $("#confirm-ok").textContent = okLabel || "确定";
      openOverlay(els.confirm);
      const ok = $("#confirm-ok");
      const cancel = $("#confirm-cancel");
      const done = (val) => {
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        closeOverlay(els.confirm);
        resolve(val);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
    });
  }

  async function deleteCurrent() {
    const id = els.taskId.value;
    if (!id) return;
    const task = state.tasks.find((t) => t.id === id);
    const ok = await askConfirm(`删除「${task ? task.title : "该任务"}」？此操作不可恢复。`, "删除");
    if (!ok) return;
    await persist((s) => {
      s.tasks = s.tasks.filter((t) => t.id !== id);
    });
    closeOverlay(els.editor);
    render();
    toast("已删除");
  }

  async function toggleCurrentDone() {
    const id = els.taskId.value;
    if (!id) return;
    await persist((s) => {
      const t = s.tasks.find((x) => x.id === id);
      if (!t) return;
      t.done = !t.done;
      t.completedAt = t.done ? Date.now() : null;
      t.updatedAt = Date.now();
      t.isSample = false;
    });
    closeOverlay(els.editor);
    render();
    toast(state.tasks.find((t) => t.id === id)?.done ? "已完成" : "已恢复为待办");
  }

  async function clearSamples() {
    const ok = await askConfirm("删除全部仍保留的示例任务？你自己记下的任务不会受影响。", "删除示例");
    if (!ok) return;
    await persist((s) => {
      s.tasks = s.tasks.filter((t) => !t.isSample);
      s.seeded = false;
    });
    render();
    toast("示例已删除");
  }

  function renderRestEditor() {
    const periods = state.settings.restPeriods || [];
    els.restEditor.innerHTML = periods
      .map(
        (p, i) => `<div class="rest-row" data-i="${i}">
          <input type="text" class="rest-label" value="${esc(p.label || "")}" placeholder="名称" />
          <input type="time" class="rest-start" value="${esc(p.start)}" />
          <input type="time" class="rest-end" value="${esc(p.end)}" />
          <button type="button" class="del" data-del="${i}" aria-label="删除此时段">×</button>
        </div>`
      )
      .join("");
  }

  function readRestEditor() {
    return $$(".rest-row", els.restEditor)
      .map((row, i) => {
        const start = $(".rest-start", row).value;
        const end = $(".rest-end", row).value;
        if (!start || !end) return null;
        const prev = state.settings.restPeriods[i];
        return {
          id: (prev && prev.id) || WB.uid("rest"),
          label: $(".rest-label", row).value.trim() || "休息",
          start,
          end
        };
      })
      .filter(Boolean);
  }

  function openSettings() {
    els.leadHours.value = String(state.settings.reminderLeadHours);
    els.restAvoid.value = String(state.settings.restAvoidMinutes);
    renderRestEditor();
    els.syncCode.textContent = formatSyncCode(state.sync && state.sync.blobId, state.sync && state.sync.token) || "尚未开启";
    els.syncInput.value = formatSyncCode(state.sync && state.sync.blobId, state.sync && state.sync.token) || "";
    updateNotifyStatus();
    updateSyncStatus();
    openOverlay(els.settings);
  }

  async function saveSettings() {
    const lead = Math.max(2, Number(els.leadHours.value) || 2);
    const avoid = Math.max(0, Number(els.restAvoid.value) || 0);
    const periods = readRestEditor();
    if (!periods.length) {
      toast("请至少保留一个休息时段，或把时段改成你的作息");
      return;
    }
    await persist((s) => {
      s.settings.reminderLeadHours = lead;
      s.settings.restAvoidMinutes = avoid;
      s.settings.restPeriods = periods;
    });
    render();
    toast("设置已保存");
    closeOverlay(els.settings);
  }

  /* ---------- notifications ---------- */
  function permissionState() {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  }

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function updateNotifyStatus() {
    const p = permissionState();
    const sw = "serviceWorker" in navigator;
    const https = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const bits = [];
    if (!https) bits.push("当前不是 HTTPS，系统通知可能不可用。");
    if (p === "unsupported") bits.push("此浏览器不支持系统通知。");
    else if (p === "granted") bits.push("通知已允许。");
    else if (p === "denied") bits.push("通知已被拒绝，请到系统或浏览器设置中重新允许。");
    else bits.push("尚未允许通知。");
    bits.push(sw ? "已准备 Service Worker。" : "此浏览器不支持 Service Worker。");
    bits.push(isStandalone() ? "已作为主屏幕应用打开。" : "尚未添加到主屏幕。");
    if (typeof TimestampTrigger !== "undefined") bits.push("本机支持 Notification Triggers，可尝试在后台按点提醒。");
    els.notifyStatus.textContent = bits.join(" ");
  }

  function updateNotifyBanner() {
    const p = permissionState();
    const dismissed = sessionStorage.getItem("wb-notify-dismiss") === "1";
    els.notifyBanner.hidden = !(p === "default" && !dismissed);
    const instDismissed = localStorage.getItem("wb-install-dismiss") === "1";
    const canInstall = !!deferredPrompt && !isStandalone() && !instDismissed;
    const showTip = !isStandalone() && !instDismissed && !deferredPrompt && p !== "unsupported";
    if (canInstall) {
      els.installBanner.hidden = false;
      $("#install-btn").textContent = "添加";
    } else if (showTip) {
      els.installBanner.hidden = false;
      $("#install-btn").textContent = "查看步骤";
    } else {
      els.installBanner.hidden = true;
    }
  }

  async function requestNotify() {
    if (!("Notification" in window)) {
      toast("此浏览器不支持通知");
      return false;
    }
    const perm = await Notification.requestPermission();
    updateNotifyStatus();
    updateNotifyBanner();
    if (perm === "granted") {
      toast("通知已打开");
      scheduleReminders();
      return true;
    }
    toast("没有获得通知权限");
    return false;
  }

  async function showNotification(copy, task) {
    if (permissionState() !== "granted") return;
    const opts = {
      body: copy.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: copy.tag,
      renotify: true,
      lang: "zh-CN",
      data: { url: "./", taskId: task && task.id }
    };
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.showNotification(copy.title, opts);
      else new Notification(copy.title, opts);
    } catch (err) {
      try {
        new Notification(copy.title, opts);
      } catch (err2) {
        console.warn(err2);
      }
    }
  }

  async function fireReminder(task, rem) {
    const key = WB.reminderKey(task.id, rem.at);
    if (state.notified[key]) return;
    await persist((s) => {
      s.notified[key] = Date.now();
    });
    const copy = WB.notificationCopy(task, rem);
    await showNotification(copy, task);
    toast(`提醒：${task.title}`);
    render();
  }

  function clearTimers() {
    timers.forEach((id) => clearTimeout(id));
    timers = [];
  }

  function scheduleReminders() {
    clearTimers();
    if (!state) return;
    const now = Date.now();
    for (const task of state.tasks) {
      const rem = WB.reminderForTask(task, state.settings);
      if (!rem) continue;
      const key = WB.reminderKey(task.id, rem.at);
      if (state.notified[key]) continue;
      const delay = rem.at.getTime() - now;
      if (delay <= 0) {
        if (now - rem.at.getTime() <= 24 * 3600 * 1000) {
          fireReminder(task, rem);
        }
        continue;
      }
      if (delay > 2147000000) continue;
      timers.push(setTimeout(() => fireReminder(task, rem), delay));
    }
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (sw) {
      sw.postMessage({ type: "SCHEDULE" });
    }
  }

  async function checkDueReminders() {
    if (!state) return;
    const now = Date.now();
    for (const task of state.tasks) {
      const rem = WB.reminderForTask(task, state.settings);
      if (!rem) continue;
      const key = WB.reminderKey(task.id, rem.at);
      if (state.notified[key]) continue;
      if (rem.at.getTime() <= now && now - rem.at.getTime() <= 24 * 3600 * 1000) {
        await fireReminder(task, rem);
      }
    }
  }

  async function testNotify() {
    const ok = permissionState() === "granted" || (await requestNotify());
    if (!ok) return;
    await showNotification(
      { title: "工作台", body: "这是一条测试通知。开始/完成时间：现在。若你能看到它，说明本机通知可用。", tag: "test" },
      { id: "test" }
    );
    toast("已发送测试通知");
  }

  /* ---------- sync ---------- */
  const SYNC_HOST = "https://jsonstorage.com";

  function payloadForSync(s) {
    return {
      version: 1,
      settings: s.settings,
      tasks: s.tasks,
      notified: s.notified,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      seeded: s.seeded
    };
  }

  function parseSyncCode(code) {
    const raw = (code || "").trim();
    const hash = raw.lastIndexOf("#");
    if (hash === -1) return { id: raw, key: "" };
    return { id: raw.slice(0, hash).trim(), key: raw.slice(hash + 1).trim() };
  }

  function formatSyncCode(id, key) {
    if (!id) return "";
    return key ? `${id}#${key}` : id;
  }

  async function syncCreate(s) {
    const res = await fetch(SYNC_HOST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payloadForSync(s))
    });
    if (!res.ok) throw new Error("创建同步失败");
    const data = await res.json();
    if (!data.id || !data.key) throw new Error("未获得同步口令");
    return { id: data.id, key: data.key };
  }

  async function syncGet(id) {
    const res = await fetch(`${SYNC_HOST}/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" }
    });
    if (res.status === 404) throw new Error("找不到这个同步口令");
    if (!res.ok) throw new Error("读取同步数据失败");
    return res.json();
  }

  async function syncPut(id, key, s) {
    if (!key) throw new Error("这个口令不完整，无法上传（缺少写入密钥）");
    const res = await fetch(`${SYNC_HOST}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Bin-Key": key
      },
      body: JSON.stringify(payloadForSync(s))
    });
    if (!res.ok) throw new Error("上传同步数据失败");
  }

  function updateSyncStatus(extra) {
    const id = state.sync && state.sync.blobId;
    const when = state.sync && state.sync.updatedAt;
    const parts = [];
    if (id) parts.push("已连接同步口令。点击口令可复制。");
    else parts.push("尚未开启同步。也可只用导出/导入在两台设备间拷贝。");
    if (when) parts.push(`最近同步：${WB.formatShortDateTime(new Date(when))}。`);
    if (extra) parts.push(extra);
    els.syncStatus.textContent = parts.join(" ");
  }

  function queueSyncPush() {
    if (!state.sync || !state.sync.blobId) return;
    clearTimeout(queueSyncPush._t);
    queueSyncPush._t = setTimeout(() => pushSync().catch(() => {}), 1600);
  }

  async function pushSync() {
    if (!state.sync || !state.sync.blobId || pushing) return;
    pushing = true;
    try {
      await syncPut(state.sync.blobId, state.sync.token, state);
      await persist((s) => {
        s.sync.updatedAt = Date.now();
      }, { skipSync: true, touch: false });
      updateSyncStatus("已上传到同步空间。");
    } catch (err) {
      updateSyncStatus("上传失败，将保留在本机。也可改用导出备份。");
    } finally {
      pushing = false;
    }
  }

  async function pullSync(silent) {
    if (!state.sync || !state.sync.blobId) return;
    try {
      const remote = await syncGet(state.sync.blobId);
      if (!remote || !Array.isArray(remote.tasks)) return;
      if ((remote.updatedAt || 0) > (state.updatedAt || 0)) {
        state = await WB.saveState(
          Object.assign({}, WB.normalizeState(remote), {
            sync: { blobId: state.sync.blobId, updatedAt: Date.now() }
          })
        );
        render();
        scheduleReminders();
        if (!silent) toast("已从同步口令更新");
        updateSyncStatus("已从同步空间拉取最新任务。");
      } else if ((state.updatedAt || 0) > (remote.updatedAt || 0) + 500) {
        await pushSync();
      } else {
        updateSyncStatus("本机与同步空间已一致。");
      }
    } catch (err) {
      if (!silent) toast(err.message || "同步失败");
      updateSyncStatus(err.message || "同步失败");
    }
  }

  async function createSync() {
    try {
      els.syncStatus.textContent = "正在生成同步口令…";
      const created = await syncCreate(state);
      const code = formatSyncCode(created.id, created.key);
      await persist((s) => {
        s.sync = { blobId: created.id, token: created.key, updatedAt: Date.now() };
      });
      els.syncCode.textContent = code;
      els.syncInput.value = code;
      try {
        await navigator.clipboard.writeText(code);
        toast("已生成并复制同步口令");
      } catch (err) {
        toast("已生成同步口令，请手动复制");
      }
      ensureSyncLoop();
      updateSyncStatus("把这串口令输入到另一台设备即可共享同一套任务。");
    } catch (err) {
      toast("无法开启在线同步，请改用导出/导入");
      updateSyncStatus("在线同步暂不可用（公共中转未能连通）。请使用导出/导入备份。");
    }
  }

  async function joinSync() {
    const parsed = parseSyncCode(els.syncInput.value);
    if (!parsed.id) {
      toast("请先输入同步口令");
      return;
    }
    try {
      const remote = await syncGet(parsed.id);
      if (!remote || !Array.isArray(remote.tasks)) throw new Error("口令内容无法识别");
      const ok = await askConfirm(
        "用这个口令同步会覆盖本机当前任务（可用导出先备份）。确定继续？",
        "开始同步"
      );
      if (!ok) return;
      state = await WB.saveState(
        Object.assign({}, WB.normalizeState(remote), {
          sync: { blobId: parsed.id, token: parsed.key, updatedAt: Date.now() }
        })
      );
      els.syncCode.textContent = formatSyncCode(parsed.id, parsed.key);
      render();
      scheduleReminders();
      toast("已接入同步");
      ensureSyncLoop();
      updateSyncStatus("已从同步口令拉取任务。之后两台设备会尽量自动对齐。");
    } catch (err) {
      toast(err.message || "同步失败");
      updateSyncStatus(err.message || "同步失败");
    }
  }


  function ensureSyncLoop() {
    if (!state.sync || !state.sync.blobId) return;
    pullSync(true);
    if (syncTimer) return;
    syncTimer = setInterval(() => pullSync(true), 60 * 1000);
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const p = WB.shanghaiParts(new Date());
    a.href = URL.createObjectURL(blob);
    a.download = `工作台备份-${p.year}${WB.pad(p.month)}${WB.pad(p.day)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("已导出备份文件");
  }

  async function importBackup(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.tasks)) throw new Error("文件格式不对");
      const ok = await askConfirm("导入会覆盖本机当前任务。确定继续？", "导入");
      if (!ok) return;
      const keepSync = state.sync;
      state = await WB.saveState(
        Object.assign({}, WB.normalizeState(data), { sync: keepSync })
      );
      render();
      scheduleReminders();
      queueSyncPush();
      toast("已导入");
    } catch (err) {
      toast(err.message || "导入失败");
    }
  }

  /* ---------- events ---------- */
  function bindEvents() {
    $("#quick-add").addEventListener("click", () => openEditor(null));
    $("#open-settings-mobile").addEventListener("click", openSettings);
    $("#open-settings-desk").addEventListener("click", openSettings);
    $("#close-settings").addEventListener("click", () => closeOverlay(els.settings));
    $("#save-settings").addEventListener("click", saveSettings);
    $("#clear-samples").addEventListener("click", clearSamples);
    $("#enable-notify").addEventListener("click", requestNotify);
    $("#dismiss-notify").addEventListener("click", () => {
      sessionStorage.setItem("wb-notify-dismiss", "1");
      els.notifyBanner.hidden = true;
    });
    $("#install-btn").addEventListener("click", async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        updateNotifyBanner();
      } else {
        openSettings();
      }
    });
    $("#dismiss-install").addEventListener("click", () => {
      localStorage.setItem("wb-install-dismiss", "1");
      els.installBanner.hidden = true;
    });

    els.list.addEventListener("click", (evt) => {
      if (evt.target.closest(".grip")) return;
      const card = evt.target.closest(".card");
      if (!card) return;
      const task = state.tasks.find((t) => t.id === card.dataset.id);
      if (task) openEditor(task);
    });
    els.remindList.addEventListener("click", (evt) => {
      const card = evt.target.closest(".remind");
      if (!card) return;
      const task = state.tasks.find((t) => t.id === card.dataset.id);
      if (task) openEditor(task);
    });

    $$("#filters [data-filter], #desk-nav [data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        filter = btn.dataset.filter;
        render();
      });
    });

    els.form.addEventListener("submit", saveTask);
    els.title.addEventListener("input", enforceTitle);
    els.title.addEventListener("compositionstart", () => {
      els.title.composing = true;
    });
    els.title.addEventListener("compositionend", () => {
      els.title.composing = false;
      enforceTitle();
    });
    els.pending.addEventListener("change", setPendingUI);
    els.dueDate.addEventListener("change", updateEditorReminder);
    els.dueTime.addEventListener("change", updateEditorReminder);
    $("#dur-chips").addEventListener("click", (evt) => {
      const btn = evt.target.closest("button");
      if (!btn) return;
      applyDuration(Number(btn.dataset.min));
    });
    els.durValue.addEventListener("input", () => {
      $$("#dur-chips button").forEach((b) => b.classList.remove("on"));
    });
    $("#delete-task").addEventListener("click", deleteCurrent);
    $("#toggle-done").addEventListener("click", toggleCurrentDone);

    $("#add-rest").addEventListener("click", () => {
      state.settings.restPeriods.push({
        id: WB.uid("rest"),
        label: "休息",
        start: "18:00",
        end: "19:00"
      });
      renderRestEditor();
    });
    els.restEditor.addEventListener("click", (evt) => {
      const btn = evt.target.closest("[data-del]");
      if (!btn) return;
      const i = Number(btn.dataset.del);
      state.settings.restPeriods.splice(i, 1);
      renderRestEditor();
    });

    $("#btn-request-notify").addEventListener("click", requestNotify);
    $("#btn-test-notify").addEventListener("click", testNotify);
    els.syncCode.addEventListener("click", async () => {
      const text = (els.syncCode.textContent || "").trim();
      if (!text || text === "尚未开启") return;
      try {
        await navigator.clipboard.writeText(text);
        toast("已复制同步口令");
      } catch (err) {
        toast("请手动选中并复制口令");
      }
    });
    $("#btn-create-sync").addEventListener("click", createSync);
    $("#btn-join-sync").addEventListener("click", joinSync);
    $("#btn-export").addEventListener("click", exportBackup);
    $("#btn-import").addEventListener("click", () => $("#import-file").click());
    $("#import-file").addEventListener("change", (evt) => {
      const file = evt.target.files && evt.target.files[0];
      evt.target.value = "";
      if (file) importBackup(file);
    });

    [els.editor, els.settings, els.confirm].forEach((ov) => {
      ov.addEventListener("click", (evt) => {
        if (evt.target === ov) closeOverlay(ov);
      });
    });
    document.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") closeAllOverlays();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        checkDueReminders();
        pullSync(true);
        render();
      }
    });
    window.addEventListener("focus", () => {
      checkDueReminders();
      pullSync(true);
    });
    window.addEventListener("beforeinstallprompt", (evt) => {
      evt.preventDefault();
      deferredPrompt = evt;
      updateNotifyBanner();
    });
  }

  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      try {
        if (reg.periodicSync) {
          await reg.periodicSync.register("check-reminders", { minInterval: 15 * 60 * 1000 });
        }
      } catch (err) {
        // not installed as PWA, or permission missing
      }
    } catch (err) {
      console.warn("SW register failed", err);
    }
  }

  async function init() {
    bindEvents();
    const existing = await WB.loadState();
    state = existing || WB.defaultState();
    if (!existing) await WB.saveState(state);
    render();
    await registerSW();
    scheduleReminders();
    setInterval(checkDueReminders, 30 * 1000);
    ensureSyncLoop();
    updateNotifyBanner();
    updateNotifyStatus();
  }

  init().catch((err) => {
    console.error(err);
    toast("启动失败，请刷新页面");
  });
})();

/* 工作台共享逻辑：时间、提醒、存储。页面与 Service Worker 共用。 */
(function (root) {
  const TZ = "Asia/Shanghai";
  const DB_NAME = "yuanli-workbench";
  const DB_VERSION = 1;
  const STORE = "kv";
  const STATE_KEY = "state";
  const BACKUP_KEY = "yuanli-workbench-backup";
  const TITLE_MAX = 10;
  const DEFAULT_LEAD_HOURS = 2;
  const DEFAULT_REST_AVOID_MIN = 60;

  const DEFAULT_SETTINGS = {
    name: "元丽",
    timezone: TZ,
    reminderLeadHours: DEFAULT_LEAD_HOURS,
    restAvoidMinutes: DEFAULT_REST_AVOID_MIN,
    restPeriods: [
      { id: "night", label: "夜间休息", start: "22:00", end: "08:00" },
      { id: "lunch", label: "午休", start: "12:00", end: "13:30" }
    ]
  };

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function shanghaiParts(date) {
    const fmt = new Intl.DateTimeFormat("zh-CN", {
      timeZone: TZ,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
      hourCycle: "h23"
    });
    const map = {};
    for (const p of fmt.formatToParts(date || new Date())) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    return {
      year: +map.year,
      month: +map.month,
      day: +map.day,
      hour: +map.hour,
      minute: +map.minute,
      second: +map.second || 0,
      weekday: map.weekday
    };
  }

  function fromShanghai(y, m, d, h, min, s) {
    return new Date(
      `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s || 0)}+08:00`
    );
  }

  function atHmOnDay(date, hm) {
    const p = shanghaiParts(date);
    const [h, min] = hm.split(":").map(Number);
    return fromShanghai(p.year, p.month, p.day, h, min, 0);
  }

  function addDays(date, days) {
    const p = shanghaiParts(date);
    // Use noon to avoid DST edge (China has no DST, still safe)
    const mid = fromShanghai(p.year, p.month, p.day, 12, 0, 0);
    return new Date(mid.getTime() + days * 86400000);
  }

  function startOfDay(date) {
    const p = shanghaiParts(date);
    return fromShanghai(p.year, p.month, p.day, 0, 0, 0);
  }

  function sameDay(a, b) {
    const pa = shanghaiParts(a);
    const pb = shanghaiParts(b);
    return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
  }

  function parseHm(hm) {
    const [h, m] = (hm || "00:00").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function minutesOfDay(date) {
    const p = shanghaiParts(date);
    return p.hour * 60 + p.minute;
  }

  function restContaining(date, periods) {
    const m = minutesOfDay(date);
    for (const period of periods || []) {
      const s = parseHm(period.start);
      const e = parseHm(period.end);
      if (s === e) continue;
      if (s < e) {
        if (m >= s && m <= e) return period;
      } else if (m >= s || m <= e) {
        return period;
      }
    }
    return null;
  }

  function restStartBefore(date, period) {
    const s = parseHm(period.start);
    const e = parseHm(period.end);
    const m = minutesOfDay(date);
    if (s < e) {
      return atHmOnDay(date, period.start);
    }
    // Overnight: times in the early morning belong to the previous day's start.
    if (m <= e) {
      return atHmOnDay(addDays(date, -1), period.start);
    }
    return atHmOnDay(date, period.start);
  }

  function adjustOffRest(date, settings) {
    const periods = (settings && settings.restPeriods) || DEFAULT_SETTINGS.restPeriods;
    const lead = (settings && settings.restAvoidMinutes) != null
      ? settings.restAvoidMinutes
      : DEFAULT_REST_AVOID_MIN;
    let current = new Date(date.getTime());
    let shifted = false;
    for (let i = 0; i < 10; i += 1) {
      const period = restContaining(current, periods);
      if (!period) {
        return { time: current, early: shifted };
      }
      const start = restStartBefore(current, period);
      current = new Date(start.getTime() - lead * 60 * 1000);
      shifted = true;
    }
    return { time: current, early: true };
  }

  function reminderForTask(task, settings) {
    if (!task || task.done || !task.dueAt) return null;
    const due = new Date(task.dueAt);
    if (Number.isNaN(due.getTime())) return null;
    const hours = Math.max(
      DEFAULT_LEAD_HOURS,
      (settings && settings.reminderLeadHours) || DEFAULT_LEAD_HOURS
    );
    const raw = new Date(due.getTime() - hours * 60 * 60 * 1000);
    const adj = adjustOffRest(raw, settings || DEFAULT_SETTINGS);
    return {
      at: adj.time,
      raw,
      early: adj.early,
      due,
      taskId: task.id
    };
  }

  function reminderKey(taskId, at) {
    return `${taskId}:${at.getTime()}`;
  }

  function formatDueLabel(iso, now) {
    if (!iso) return "待定";
    const due = new Date(iso);
    if (Number.isNaN(due.getTime())) return "待定";
    const nowDate = now || new Date();
    const t = shanghaiParts(due);
    const hm = `${pad(t.hour)}:${pad(t.minute)}`;
    if (sameDay(due, nowDate)) return hm;
    if (sameDay(due, addDays(nowDate, 1))) return `明天 ${hm}`;
    if (sameDay(due, addDays(nowDate, -1))) return `昨天 ${hm}`;
    if (t.year === shanghaiParts(nowDate).year) {
      return `${t.month}月${t.day}日 ${hm}`;
    }
    return `${t.year}年${t.month}月${t.day}日 ${hm}`;
  }

  function formatDateLine(date) {
    const p = shanghaiParts(date || new Date());
    return `${p.month}月${p.day}日 ${p.weekday} · 上海时间`;
  }

  function formatShortDateTime(date) {
    const now = new Date();
    const p = shanghaiParts(date);
    const hm = `${pad(p.hour)}:${pad(p.minute)}`;
    if (sameDay(date, now)) return `今天 ${hm}`;
    if (sameDay(date, addDays(now, 1))) return `明天 ${hm}`;
    if (sameDay(date, addDays(now, -1))) return `昨天 ${hm}`;
    return `${p.month}月${p.day}日 ${hm}`;
  }

  function formatDuration(min) {
    const n = Number(min) || 0;
    if (n <= 0) return "未估耗时";
    if (n % 60 === 0) {
      return `预计 ${n / 60} 小时`;
    }
    if (n > 60 && n % 30 === 0) {
      const hours = n / 60;
      return `预计 ${hours} 小时`;
    }
    if (n > 60) {
      const h = Math.floor(n / 60);
      const m = n % 60;
      return `预计 ${h} 小时 ${m} 分钟`;
    }
    return `预计 ${n} 分钟`;
  }

  function countChars(str) {
    return Array.from(str || "").length;
  }

  function clipTitle(str) {
    return Array.from(str || "").slice(0, TITLE_MAX).join("").trim();
  }

  function uid(prefix) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix || "id"}_${Date.now().toString(36)}_${rand}`;
  }

  function seedTasks(now) {
    const n = now || new Date();
    const p = shanghaiParts(n);
    const today = (h, m) => fromShanghai(p.year, p.month, p.day, h, m, 0);
    const tomorrow = (h, m) => {
      const d = addDays(n, 1);
      const q = shanghaiParts(d);
      return fromShanghai(q.year, q.month, q.day, h, m, 0);
    };
    const base = [
      { title: "整理WA落地方案", due: today(14, 0), durationMin: 90 },
      { title: "准备周会材料", due: today(16, 30), durationMin: 60 },
      { title: "核对GTM广告代码", due: today(16, 30), durationMin: 40 },
      { title: "跟进OEM曝光", due: tomorrow(10, 0), durationMin: 120 },
      { title: "回复经销商询价", due: null, durationMin: 25 }
    ];
    return base.map((item, i) => ({
      id: uid("task"),
      title: item.title,
      dueAt: item.due ? item.due.toISOString() : null,
      durationMin: item.durationMin,
      done: false,
      order: i,
      isSample: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null
    }));
  }

  function markPastReminders(state, now) {
    const t = now || new Date();
    state.notified = state.notified || {};
    for (const task of state.tasks || []) {
      const rem = reminderForTask(task, state.settings);
      if (!rem) continue;
      if (rem.at.getTime() <= t.getTime()) {
        state.notified[reminderKey(task.id, rem.at)] = rem.at.getTime();
      }
    }
    return state;
  }

  function defaultState() {
    const state = {
      version: 1,
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      tasks: seedTasks(new Date()),
      notified: {},
      sync: { blobId: null, token: null, updatedAt: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      seeded: true
    };
    return markPastReminders(state, new Date());
  }

  function openDb() {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("no indexedDB"));
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadState() {
    try {
      const db = await openDb();
      const state = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(STATE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (state && state.tasks) return normalizeState(state);
    } catch (err) {
      // fall through to backup
    }
    try {
      if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(BACKUP_KEY);
        if (raw) return normalizeState(JSON.parse(raw));
      }
    } catch (err) {
      // ignore
    }
    return null;
  }

  async function saveState(state, opts) {
    const next = normalizeState(state);
    if (!opts || opts.touch !== false) next.updatedAt = Date.now();
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(next, STATE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      // still try localStorage
    }
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(next));
      }
    } catch (err) {
      // quota
    }
    return next;
  }

  function normalizeState(state) {
    const src = state || {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, src.settings || {});
    if (!Array.isArray(settings.restPeriods) || !settings.restPeriods.length) {
      settings.restPeriods = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.restPeriods));
    }
    settings.reminderLeadHours = Math.max(
      DEFAULT_LEAD_HOURS,
      Number(settings.reminderLeadHours) || DEFAULT_LEAD_HOURS
    );
    settings.restAvoidMinutes = Math.max(
      0,
      Number(settings.restAvoidMinutes) || DEFAULT_REST_AVOID_MIN
    );
    settings.timezone = TZ;
    return {
      version: 1,
      settings,
      tasks: Array.isArray(src.tasks) ? src.tasks : [],
      notified: src.notified && typeof src.notified === "object" ? src.notified : {},
      sync: Object.assign({ blobId: null, token: null, updatedAt: 0 }, src.sync || {}),
      createdAt: src.createdAt || Date.now(),
      updatedAt: src.updatedAt || Date.now(),
      seeded: !!src.seeded
    };
  }

  function upcomingReminders(state, now, limit) {
    const t = now || new Date();
    const list = [];
    for (const task of state.tasks || []) {
      const rem = reminderForTask(task, state.settings);
      if (!rem) continue;
      if (rem.at.getTime() + 60 * 1000 < t.getTime()) continue;
      list.push({ task, rem });
    }
    list.sort((a, b) => a.rem.at - b.rem.at);
    return list.slice(0, limit || 8);
  }

  function dueTodayTasks(state, now) {
    const t = now || new Date();
    return (state.tasks || []).filter(
      (task) => !task.done && task.dueAt && sameDay(new Date(task.dueAt), t)
    );
  }

  function notificationCopy(task, rem) {
    const when = formatDueLabel(task.dueAt);
    let body = `开始/完成时间：${when}`;
    if (rem && rem.early) body += "。已避开休息时间，提前提醒";
    return {
      title: task.title,
      body,
      tag: `task-${task.id}`
    };
  }

  function dueTodayTimeline(state, now) {
    const t = now || new Date();
    return (state.tasks || [])
      .filter((task) => !task.done && task.dueAt && sameDay(new Date(task.dueAt), t))
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt) || a.order - b.order);
  }

  const api = {
    TZ,
    TITLE_MAX,
    DEFAULT_SETTINGS,
    DEFAULT_LEAD_HOURS,
    DEFAULT_REST_AVOID_MIN,
    BACKUP_KEY,
    pad,
    shanghaiParts,
    fromShanghai,
    atHmOnDay,
    addDays,
    startOfDay,
    sameDay,
    parseHm,
    minutesOfDay,
    restContaining,
    restStartBefore,
    adjustOffRest,
    reminderForTask,
    reminderKey,
    formatDueLabel,
    formatDateLine,
    formatShortDateTime,
    formatDuration,
    countChars,
    clipTitle,
    uid,
    seedTasks,
    defaultState,
    markPastReminders,
    loadState,
    saveState,
    normalizeState,
    upcomingReminders,
    dueTodayTasks,
    dueTodayTimeline,
    notificationCopy
  };

  root.WB = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);

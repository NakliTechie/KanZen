/* KzReminders — reminder instances, missed/fire split, snooze and a leader-elected scheduler.
   Contract: docs/specs/kanzen-tasks-contract-001.md (KzReminders). Pure logic; timers, locks and
   delivery are injected. No Date.now() in logic: callers pass now (ms) and today (YYYY-MM-DD). */
(function(root){
  'use strict';

  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const MISSED_WINDOW_MS = 7 * DAY;
  const DEFAULT_GRACE_MS = 5 * MIN;
  const DEFAULT_MAX_DELAY_MS = 60000;
  const LOCK_NAME = 'kanzen-reminders';

  /* ---------- time-zone helpers ---------- */

  const fmtCache = new Map();
  function formatter(tz){
    let f = fmtCache.get(tz);
    if(!f){
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      fmtCache.set(tz, f);
    }
    return f;
  }
  // Wall-clock fields of instant ms in zone tz, as a UTC-based ms number (seconds kept).
  function wallMs(ms, tz){
    const p = {};
    for(const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
    const hour = p.hour === '24' ? 0 : Number(p.hour);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  }
  function offsetAt(ms, tz){ return wallMs(ms, tz) - Math.floor(ms / 1000) * 1000; }

  const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
  // 'YYYY-MM-DDTHH:MM' in zone tz → ms. A time inside a DST gap moves forward by the gap
  // (02:30 → 03:30 on a spring-forward day); an ambiguous time takes the first (earlier) instant.
  function localToMs(local, tz){
    const m = LOCAL_RE.exec(local || '');
    if(!m) return NaN;
    const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if(!tz) return naive;
    const before = offsetAt(naive - DAY, tz), after = offsetAt(naive + DAY, tz);
    const hits = [];
    for(const off of new Set([before, after])){
      const t = naive - off;
      if(wallMs(t, tz) === naive) hits.push(t);
    }
    if(hits.length) return Math.min(...hits);
    return naive - before; // gap: keep the pre-transition offset, which lands after the gap
  }
  function pad(n){ return String(n).padStart(2, '0'); }
  // ms → 'YYYY-MM-DDTHH:MM' wall clock in tz.
  function msToLocal(ms, tz){
    const w = tz ? wallMs(ms, tz) : ms;
    const d = new Date(w);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function addDays(day, n){
    const [y, mo, d] = day.split('-').map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  function isoWeekday(day){
    const [y, mo, d] = day.split('-').map(Number);
    const w = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    return w === 0 ? 7 : w;
  }

  /* ---------- done rule (copy of KzTasks.doneColumn / isDone) ---------- */

  function doneColumn(board){
    const cols = (board && board.columns) || [];
    return cols.find(c => c.done === true) || cols.find(c => /^(done|completed?|finished)$/i.test(String(c.name || '').trim())) || null;
  }
  function isCardDone(board, cardId, card){
    if(card && card.completedAt) return true;
    const col = doneColumn(board);
    return !!(col && (col.cardIds || []).includes(cardId));
  }

  /* ---------- instances ---------- */

  function defaultScheduled(habit, day){
    const s = habit.schedule || { type: 'daily' };
    if(s.type === 'weekdays') return (s.days || []).includes(isoWeekday(day));
    return true; // daily, xPerWeek and xInDays: any day is eligible until done
  }
  function defaultHabitDone(folded, habitId, day){
    const e = folded && folded.get && folded.get(habitId) && folded.get(habitId).get(day);
    return !!(e && (e.op === 'set' && e.value > 0 || e.op === 'skip'));
  }

  // → [{ key, kind, boardId, cardId, habitId, reminderId, title, fireAt, fireAtLocal, snooze }], sorted by fireAt.
  // opts.isHabitDone(habitId, day) and opts.isHabitScheduled(habit, day) override the built-in rules.
  function instances(boards, habitsDoc, folded, opts){
    const o = opts || {};
    const now = o.now, tz = o.tz, today = o.today || msToLocal(now, tz).slice(0, 10);
    const horizon = o.horizonDays == null ? 7 : o.horizonDays;
    const lo = now - MISSED_WINDOW_MS, hi = now + horizon * DAY;
    const out = [];
    const keep = (inst) => { if(inst.fireAt >= lo && inst.fireAt <= hi) out.push(inst); };

    for(const board of boards || []){
      const cards = board.cards || {};
      for(const cardId of Object.keys(cards)){
        const card = cards[cardId];
        if(!card || !Array.isArray(card.reminders) || !card.reminders.length) continue;
        if(isCardDone(board, cardId, card)) continue;
        for(const r of card.reminders){
          let fireAt, fireAtLocal;
          if(r.at){
            fireAtLocal = r.at; fireAt = localToMs(r.at, tz);
          }else if(r.offsetMin != null && card.dueDate){
            const dueMs = localToMs(`${card.dueDate}T${card.dueTime || '09:00'}`, tz);
            fireAt = dueMs - Number(r.offsetMin) * MIN;
            fireAtLocal = msToLocal(fireAt, tz);
          }else continue;
          if(!Number.isFinite(fireAt)) continue;
          keep({ key: `card:${board.id}:${cardId}:${r.id}:${fireAtLocal}`, kind: 'card', boardId: board.id, cardId,
            habitId: null, reminderId: r.id, title: card.title || '', fireAt, fireAtLocal, snooze: !!r.snooze });
        }
      }
    }

    const isDone = o.isHabitDone || ((id, day) => defaultHabitDone(folded, id, day));
    const isSched = o.isHabitScheduled || defaultScheduled;
    const habits = (habitsDoc && habitsDoc.habits) || [];
    const firstDay = addDays(today, -7), lastDay = addDays(today, horizon);
    for(const h of habits){
      if(!h || h.archived || !Array.isArray(h.reminders) || !h.reminders.length) continue;
      const endHour = h.dayEndHour || 0;
      for(let day = firstDay; day <= lastDay; day = addDays(day, 1)){
        if(h.paused && h.paused <= day) continue;
        if(h.createdAt && Number.isFinite(h.createdAt) && localToMs(`${day}T23:59`, tz) < h.createdAt) continue;
        if(!isSched(h, day) || isDone(h.id, day)) continue;
        for(const r of h.reminders){
          if(!r || !/^\d{2}:\d{2}$/.test(r.at || '')) continue;
          // A habit day runs from dayEndHour to dayEndHour next day, so an early-morning time belongs to the next date.
          const calDay = Number(r.at.slice(0, 2)) < endHour ? addDays(day, 1) : day;
          const fireAtLocal = `${calDay}T${r.at}`;
          keep({ key: `habit:${h.id}:${r.id}:${day}`, kind: 'habit', boardId: null, cardId: null, habitId: h.id,
            reminderId: r.id, title: h.name || '', fireAt: localToMs(fireAtLocal, tz), fireAtLocal, day, snooze: false });
        }
      }
    }
    out.sort((a, b) => a.fireAt - b.fireAt || (a.key < b.key ? -1 : 1));
    return out;
  }

  // → { fireNow, missed, later }. Missed = older than graceMs, not fired, within the last 7 days.
  function split(list, isFired, opts){
    const now = opts.now, grace = opts.graceMs == null ? DEFAULT_GRACE_MS : opts.graceMs;
    const res = { fireNow: [], missed: [], later: [] };
    for(const inst of list || []){
      if(inst.fireAt > now){ res.later.push(inst); continue; }
      if(isFired(inst.key)) continue;
      const age = now - inst.fireAt;
      if(age <= grace) res.fireNow.push(inst);
      else if(age <= MISSED_WINDOW_MS) res.missed.push(inst);
    }
    for(const k of Object.keys(res)) res[k].sort((a, b) => a.fireAt - b.fireAt);
    return res;
  }

  /* ---------- snooze ---------- */

  // Adds a one-shot reminder { id, at, snooze:true } to card.reminders; returns it.
  function snooze(card, untilLocal){
    if(!LOCAL_RE.test(untilLocal || '')) throw new Error('snooze: untilLocal must be YYYY-MM-DDTHH:MM');
    card.reminders = Array.isArray(card.reminders) ? card.reminders : [];
    const base = 'snooze-' + untilLocal.replace(/\D/g, '');
    let id = base, n = 1;
    while(card.reminders.some(r => r.id === id)) id = `${base}-${++n}`;
    const r = { id, at: untilLocal, snooze: true };
    card.reminders.push(r);
    return r;
  }
  // Removes a fired snooze reminder from the card (N5: one-shot). Returns true when removed.
  function consumeSnooze(card, reminderId){
    const list = (card && card.reminders) || [];
    const i = list.findIndex(r => r.id === reminderId && r.snooze);
    if(i < 0) return false;
    list.splice(i, 1);
    return true;
  }
  // → [{ id, label, at }] with at a floating local time in tz: 10 minutes, 1 hour, tomorrow 09:00.
  function snoozeTargets(nowMs, tz){
    const today = msToLocal(nowMs, tz).slice(0, 10);
    return [
      { id: '10m', label: '10 minutes', at: msToLocal(nowMs + 10 * MIN, tz) },
      { id: '1h', label: '1 hour', at: msToLocal(nowMs + HOUR, tz) },
      { id: 'tomorrow', label: 'Tomorrow 09:00', at: `${addDays(today, 1)}T09:00` }
    ];
  }

  /* ---------- fired log ---------- */

  // → a new log with entries fired within the last `days` days (default 30).
  function pruneLog(reminderLog, nowMs, days){
    const cutoff = nowMs - (days == null ? 30 : days) * DAY;
    const out = {};
    for(const [k, iso] of Object.entries(reminderLog || {})){
      const t = Date.parse(iso);
      if(Number.isFinite(t) && t >= cutoff) out[k] = iso;
    }
    return out;
  }

  /* ---------- scheduler ---------- */

  // Only the window holding the 'kanzen-reminders' lock delivers. Before each delivery it re-checks
  // isFired(key) and calls markFired(key) first, so windows sharing one board file never double-fire.
  // Missed reminders go to onMissed(list) and are marked fired, so the list shows once.
  function createScheduler(opts){
    const o = opts || {};
    const grace = o.graceMs == null ? DEFAULT_GRACE_MS : o.graceMs;
    const maxDelay = o.maxDelayMs || DEFAULT_MAX_DELAY_MS;
    const lockName = o.lockName || LOCK_NAME;
    let started = false, leader = false, timer = null, release = null;
    let running = null, again = false;

    // Re-check, then mark before delivering. With a synchronous log there is no await between the check
    // and the mark, so two schedulers in one realm cannot both claim a key.
    function claim(inst){
      const f = o.isFired(inst.key);
      const mark = () => { const m = o.markFired(inst.key, inst); return m && typeof m.then === 'function' ? m.then(() => true) : true; };
      if(f && typeof f.then === 'function') return f.then(v => v ? false : mark());
      return f ? false : mark();
    }

    function clear(){ if(timer != null){ o.clearTimer(timer); timer = null; } }

    async function pass(){
      clear();
      if(!started || !leader) return;
      const t = o.now();
      const list = await o.getInstances(t);
      const fired = new Set();
      const isFiredNow = (k) => fired.has(k);
      // isFired may be async in some hosts; resolve each key before the split.
      for(const inst of list) if(inst.fireAt <= t && await o.isFired(inst.key)) fired.add(inst.key);
      const { fireNow, missed, later } = split(list, isFiredNow, { now: t, graceMs: grace });
      const missedOut = [];
      for(const inst of missed){
        if(!leader) return;
        if(await claim(inst)) missedOut.push(inst);
      }
      if(missedOut.length && o.onMissed) await o.onMissed(missedOut);
      for(const inst of fireNow){
        if(!leader) return;
        if(await claim(inst)) await o.deliver(inst);
      }
      if(!started || !leader) return;
      const next = later.length ? later[0].fireAt - t : maxDelay;
      timer = o.setTimer(recompute, Math.max(0, Math.min(next, maxDelay)));
    }

    function recompute(){
      if(running){ again = true; return running; }
      running = (async () => {
        try{
          do{ again = false; await pass(); }while(again);
        }finally{ running = null; }
      })();
      return running;
    }

    function start(){
      if(started) return;
      started = true;
      o.locks.request(lockName, {}, () => {
        if(!started) return undefined;
        leader = true;
        const held = new Promise(res => { release = res; });
        recompute();
        return held;
      });
    }

    function stop(){
      started = false;
      clear();
      leader = false;
      if(release){ const r = release; release = null; r(); }
    }

    return { start, stop, recompute, isLeader: () => leader };
  }

  root.KzReminders = {
    instances, split, snooze, consumeSnooze, snoozeTargets, createScheduler, pruneLog,
    localToMs, msToLocal, addDays, doneColumn, isCardDone,
    LOCK_NAME, MISSED_WINDOW_MS, DEFAULT_GRACE_MS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

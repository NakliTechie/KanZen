/* KzHabits: habit definitions, the append-only check-in log, schedules, streaks, score and heatmap.
 * Contract: docs/specs/kanzen-tasks-contract-001.md ("Habit store", "KzHabits"); parity rows H1-H8, H10, S2, S4.
 * Pure functions: callers pass now (ms) and today (YYYY-MM-DD). No DOM, no clock reads inside logic.
 * The score is reimplemented from Loop Habit Tracker's published formula; no Loop code is used.
 *
 * Status of a day (status()):
 *   done     a `set` line wins for that day
 *   skipped  a `skip` line wins (neutral)
 *   paused   habit.paused is set and the day is on or after it, with no line (neutral)
 *   off      not required: before the habit starts, an unscheduled weekday, or a flexible-schedule day whose
 *            period or window is already met or excused (neutral)
 *   open     still achievable: today, a future day, or a day whose period or window has not closed yet
 *   missed   required and the chance has passed
 *
 * Flexible schedules:
 *   xPerWeek n   weeks run Monday to Sunday. A week is met when done >= n; excused when done + credit >= n,
 *                where credit counts skipped days, paused days and days before the habit starts; missed when
 *                neither holds and the week ended before today. Not-done days of a met or excused week are
 *                `off`, of a missed week `missed`, of the current week `open`.
 *   xInDays n m  rolling window (Loop's n/m fraction). A day is covered when some m-day window that contains it
 *                holds done + credit >= n (only days up to today count). A not-done day is `off` when covered,
 *                `missed` when uncovered and every window containing it ended before today (day + m - 1 < today),
 *                otherwise `open`.
 *
 * Streaks (streaks()):
 *   daily, weekdays  unit 'day': consecutive scheduled days done. Skipped, paused, off and open days are
 *                    neutral (they neither add nor break); a missed day resets to 0. A check-in on an
 *                    unscheduled day is neutral.
 *   xPerWeek         unit 'week': consecutive met weeks; excused weeks are neutral; the current week counts when
 *                    met and never breaks the streak.
 *   xInDays          unit 'period': the same rule over consecutive m-day blocks anchored on the habit's start day.
 *
 * Score (score()): exponential moving average, multiplier = 0.5 ** (sqrt(freq) / 13), with freq = 1 (daily),
 *   k/7 (weekdays with k days), n/7 (xPerWeek), n/m (xInDays). Starting at 0 on the habit's start day, for each
 *   day up to today, score = score * multiplier + checked * (1 - multiplier) applied once per update:
 *   daily, weekdays  done day -> one update with checked 1; missed day -> one update with checked 0;
 *                    every other day leaves the score unchanged.
 *   xPerWeek         done day -> checked 1. On the Sunday of a missed week, apply (n - done - credit) updates
 *                    with checked 0, so only the shortfall lowers the score. Other days unchanged.
 *   xInDays          done day -> checked 1; missed day -> checked 0; other days unchanged.
 *
 * Start day: the earlier of the habit's created day (createdAt as ms, ISO string or YYYY-MM-DD; a datetime is
 * read as its UTC date) and the first logged day, and never later than today.
 */
(function (root) {
  'use strict';

  var DAY_MS = 86400000;
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var OPS = { set: 1, clear: 1, skip: 1 };

  // ---- day arithmetic (floating days as ordinals since 1970-01-01) ----
  function isDay(s) {
    if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
    var o = toOrd(s);
    return fromOrd(o) === s;
  }
  function toOrd(day) {
    return Math.round(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS);
  }
  function fromOrd(o) { return new Date(o * DAY_MS).toISOString().slice(0, 10); }
  function addDays(day, n) { return fromOrd(toOrd(day) + n); }
  function isoWeekdayOrd(o) { return (((o + 3) % 7) + 7) % 7 + 1; }
  function isoWeekday(day) { return isoWeekdayOrd(toOrd(day)); }
  function mondayOf(day) { return addDays(day, 1 - isoWeekday(day)); }

  // ---- day rollover (H5) ----
  var fmtCache = {};
  function formatterFor(tz) {
    var key = tz || '';
    if (!fmtCache[key]) {
      var opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' };
      if (tz) opts.timeZone = tz;
      fmtCache[key] = new Intl.DateTimeFormat('en-US', opts);
    }
    return fmtCache[key];
  }
  /** Local day in zone tz for instant atMs; wall-clock hours before dayEndHour belong to the previous day. */
  function dayFor(atMs, dayEndHour, tz) {
    var parts = formatterFor(tz).formatToParts(new Date(atMs));
    var p = {};
    for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
    var hour = +p.hour % 24;
    var day = p.year + '-' + p.month + '-' + p.day;
    var end = +dayEndHour || 0;
    return hour < end ? addDays(day, -1) : day;
  }
  /** Convenience: the habit's current day for instant nowMs. */
  function todayFor(nowMs, habit, tz) { return dayFor(nowMs, habit && habit.dayEndHour, tz); }

  // ---- log (H3, S2, S4) ----
  function normalizeLine(x) {
    if (!x || typeof x !== 'object') return null;
    if (typeof x.habitId !== 'string' || !x.habitId) return null;
    if (!isDay(x.day)) return null;
    if (!OPS[x.op]) return null;
    if (typeof x.at !== 'number' || !isFinite(x.at)) return null;
    return { habitId: x.habitId, day: x.day, value: x.op === 'set' ? 1 : 0, at: x.at, op: x.op };
  }
  /** Parse habit-log.jsonl text (or an array of line strings or objects, as IDB stores them).
   *  Returns an array of normalised lines; the array's non-enumerable `skipped` property counts bad lines. */
  function parseLog(text) {
    var raw = Array.isArray(text) ? text : String(text == null ? '' : text).split(/\r?\n/);
    var out = [];
    var skipped = 0;
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (typeof item === 'string') {
        if (!item.trim()) continue;
        try { item = JSON.parse(item); } catch (e) { skipped++; continue; }
      }
      var line = normalizeLine(item);
      if (line) out.push(line); else skipped++;
    }
    Object.defineProperty(out, 'skipped', { value: skipped, enumerable: false });
    return out;
  }
  /** One JSON line, fixed key order, no trailing newline. */
  function serializeLine(line) {
    var l = normalizeLine(line);
    if (!l) throw new Error('KzHabits.serializeLine: invalid line');
    return JSON.stringify({ habitId: l.habitId, day: l.day, value: l.value, at: l.at, op: l.op });
  }
  function makeLine(habitId, day, op, nowMs) {
    var l = normalizeLine({ habitId: habitId, day: day, op: op, at: nowMs });
    if (!l) throw new Error('KzHabits.makeLine: invalid habitId, day, op or nowMs');
    return l;
  }
  /** Map(habitId -> Map(day -> { value, op, at, prev })). Latest `at` wins; a tie goes to the later line.
   *  `prev` is the state the winning line replaced ({ value, op, at } or null), used by inverseLine. */
  function fold(lines) {
    var out = new Map();
    var list = lines || [];
    for (var i = 0; i < list.length; i++) {
      var l = normalizeLine(list[i]);
      if (!l) continue;
      var byDay = out.get(l.habitId);
      if (!byDay) { byDay = new Map(); out.set(l.habitId, byDay); }
      var cur = byDay.get(l.day);
      var entry = { value: l.value, op: l.op, at: l.at };
      if (!cur) { entry.prev = null; byDay.set(l.day, entry); continue; }
      if (l.at >= cur.at) {
        entry.prev = { value: cur.value, op: cur.op, at: cur.at };
        byDay.set(l.day, entry);
      } else if (!cur.prev || l.at >= cur.prev.at) {
        cur.prev = entry;
      }
    }
    return out;
  }
  function entryOf(folded, habitId, day) {
    var m = folded && folded.get && folded.get(habitId);
    return m ? m.get(day) || null : null;
  }
  /** The line that restores the state before the winning line for habitId + day (undo), or null when the day
   *  has no line. `at` is max(nowMs, winner.at + 1) so the undo line wins. Applying a second inverse redoes. */
  function inverseLine(folded, habitId, day, nowMs) {
    var cur = entryOf(folded, habitId, day);
    if (!cur) return null;
    var op = cur.prev ? cur.prev.op : 'clear';
    return makeLine(habitId, day, op, Math.max(nowMs, cur.at + 1));
  }

  // ---- schedules (H2) ----
  function sched(habit) { return (habit && habit.schedule) || { type: 'daily' }; }
  /** daily: every day; weekdays: listed ISO days; xPerWeek / xInDays: any day may count, so true. */
  function isScheduled(habit, day) {
    var s = sched(habit);
    if (s.type === 'weekdays') return (s.days || []).indexOf(isoWeekday(day)) !== -1;
    return true;
  }
  function freqOf(habit) {
    var s = sched(habit);
    if (s.type === 'weekdays') return Math.max(1, (s.days || []).length) / 7;
    if (s.type === 'xPerWeek') return Math.min(7, Math.max(1, s.n)) / 7;
    if (s.type === 'xInDays') return Math.min(1, Math.max(1, s.n) / Math.max(1, s.m));
    return 1;
  }
  function createdOrd(habit) {
    var c = habit && habit.createdAt;
    if (typeof c === 'number' && isFinite(c)) return Math.floor(c / DAY_MS);
    if (typeof c === 'string' && c.length >= 10 && isDay(c.slice(0, 10))) return toOrd(c.slice(0, 10));
    return null;
  }
  function startOrd(habit, folded, todayO) {
    var s = createdOrd(habit);
    var m = folded && folded.get && folded.get(habit.id);
    if (m) m.forEach(function (e, day) {
      if (e.op === 'clear') return;
      var o = toOrd(day);
      if (s === null || o < s) s = o;
    });
    if (s === null || s > todayO) s = todayO;
    return s;
  }

  // Raw per-day codes: 0 nothing, 1 done, 2 skip, 3 paused (no line), 4 before start (no line).
  function build(habit, folded, today, fromO) {
    var tO = toOrd(today);
    var sO = startOrd(habit, folded, tO);
    var s = sched(habit);
    var m = s.type === 'xInDays' ? Math.max(1, s.m | 0) : 1;
    var n = Math.max(1, s.n | 0);
    var lo = Math.min(fromO == null ? sO : fromO, sO) - 7 - m;
    var hi = tO + 7 + m;
    var len = hi - lo + 1;
    var raw = new Uint8Array(len);
    var pausedO = habit.paused && isDay(habit.paused) ? toOrd(habit.paused) : null;
    var byDay = folded && folded.get && folded.get(habit.id);
    for (var o = lo; o <= hi; o++) {
      var e = byDay ? byDay.get(fromOrd(o)) : null;
      var code = 0;
      if (e && e.op === 'set') code = 1;
      else if (e && e.op === 'skip') code = 2;
      else if (pausedO !== null && o >= pausedO) code = 3;
      else if (o < sO) code = 4;
      raw[o - lo] = code;
    }
    // prefix sums over days <= today: done count and credit (skip, paused, before start)
    var pDone = new Int32Array(len + 1), pCred = new Int32Array(len + 1);
    for (var i = 0; i < len; i++) {
      var c = lo + i <= tO ? raw[i] : 0;
      pDone[i + 1] = pDone[i] + (c === 1 ? 1 : 0);
      pCred[i + 1] = pCred[i] + (c >= 2 ? 1 : 0);
    }
    function sum(arr, a, b) { // inclusive ordinals, clamped to range
      a = Math.max(a, lo); b = Math.min(b, hi);
      return b < a ? 0 : arr[b - lo + 1] - arr[a - lo];
    }
    var ctx = { s: s, n: n, m: m, lo: lo, hi: hi, tO: tO, sO: sO, raw: raw, habit: habit };
    ctx.rawAt = function (o) { return o < lo || o > hi ? (o < sO ? 4 : 0) : raw[o - lo]; };
    ctx.done = function (a, b) { return sum(pDone, a, b); };
    ctx.credit = function (a, b) { return sum(pCred, a, b); };
    // period classification: 'met' | 'excused' | 'missed' | 'current'
    ctx.classify = function (a, b) {
      var d = ctx.done(a, b);
      if (d >= n) return 'met';
      if (d + ctx.credit(a, b) >= n) return 'excused';
      return b < tO ? 'missed' : 'current';
    };
    ctx.weekStart = function (o) { return o - (isoWeekdayOrd(o) - 1); };
    ctx.covered = function (o) {
      for (var a = o - m + 1; a <= o; a++) {
        if (ctx.done(a, a + m - 1) + ctx.credit(a, a + m - 1) >= n) return true;
      }
      return false;
    };
    ctx.status = function (o) {
      var c = ctx.rawAt(o);
      if (c === 1) return 'done';
      if (c === 2) return 'skipped';
      if (c === 3) return 'paused';
      if (c === 4) return 'off';
      if (o > tO) return 'open';
      if (s.type === 'xPerWeek') {
        var ws = ctx.weekStart(o);
        var k = ctx.classify(ws, ws + 6);
        return k === 'missed' ? 'missed' : k === 'current' ? 'open' : 'off';
      }
      if (s.type === 'xInDays') {
        if (ctx.covered(o)) return 'off';
        return o + m - 1 < tO ? 'missed' : 'open';
      }
      if (!isScheduled(habit, fromOrd(o))) return 'off';
      return o < tO ? 'missed' : 'open';
    };
    return ctx;
  }

  /** Status of `day`. Pass `today` (YYYY-MM-DD); without it the day is treated as today. */
  function status(habit, folded, day, today) {
    var ctx = build(habit, folded, today || day, toOrd(day));
    return ctx.status(toOrd(day));
  }
  /** H10: true when a reminder for `day` should fire: not archived and the day is still `open`. */
  function isDue(habit, folded, day, today) {
    if (!habit || habit.archived) return false;
    return status(habit, folded, day, today || day) === 'open';
  }

  // ---- streaks (H6) ----
  function streaks(habit, folded, today) {
    var ctx = build(habit, folded, today);
    var s = ctx.s, cur = 0, best = 0, o;
    if (s.type === 'daily' || s.type === 'weekdays' || !s.type) {
      for (o = ctx.sO; o <= ctx.tO; o++) {
        var st = ctx.status(o);
        if (st === 'done' && isScheduled(habit, fromOrd(o))) { cur++; if (cur > best) best = cur; }
        else if (st === 'missed') cur = 0;
      }
      return { current: cur, best: best, unit: 'day' };
    }
    var len = s.type === 'xPerWeek' ? 7 : ctx.m;
    var a = s.type === 'xPerWeek' ? ctx.weekStart(ctx.sO) : ctx.sO;
    for (; a <= ctx.tO; a += len) {
      var k = ctx.classify(a, a + len - 1);
      if (k === 'met') { cur++; if (cur > best) best = cur; }
      else if (k === 'missed') cur = 0;
    }
    return { current: cur, best: best, unit: s.type === 'xPerWeek' ? 'week' : 'period' };
  }

  // ---- score (H7) ----
  function score(habit, folded, today) {
    var ctx = build(habit, folded, today);
    var mult = Math.pow(0.5, Math.sqrt(freqOf(habit)) / 13);
    var sc = 0, s = ctx.s;
    function upd(checked) { sc = sc * mult + checked * (1 - mult); }
    for (var o = ctx.sO; o <= ctx.tO; o++) {
      var st = ctx.status(o);
      if (st === 'done') upd(1);
      if (s.type === 'xPerWeek') {
        if (isoWeekdayOrd(o) === 7 && o < ctx.tO) {
          var ws = o - 6;
          if (ctx.classify(ws, o) === 'missed') {
            var short = ctx.n - ctx.done(ws, o) - ctx.credit(ws, o);
            for (var i = 0; i < short; i++) upd(0);
          }
        }
      } else if (st === 'missed') upd(0);
    }
    return Math.min(1, Math.max(0, sc));
  }

  /** Share of due days done over the `days` days ending today: done / (done + missed); null when none due. */
  function completionRate(habit, folded, today, days) {
    var n = days == null ? 30 : Math.max(1, days | 0);
    var tO = toOrd(today);
    var ctx = build(habit, folded, today, tO - n + 1);
    var done = 0, missed = 0;
    for (var o = tO - n + 1; o <= tO; o++) {
      var st = ctx.status(o);
      if (st === 'done') done++; else if (st === 'missed') missed++;
    }
    return done + missed === 0 ? null : done / (done + missed);
  }

  // ---- heatmap (H8) ----
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeColor(c) {
    return typeof c === 'string' && /^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\([0-9.,%\s]+\)|[a-zA-Z]{3,20})$/.test(c)
      ? c : '#2da44e';
  }
  var LABEL = { done: 'done', skipped: 'skipped', paused: 'paused', off: 'not required', open: 'open', missed: 'missed' };
  /** GitHub-style grid: columns are Monday-start weeks, the last column holds today; days after today are
   *  omitted, so the grid has at most 7 * weeks cells. Each <rect> carries data-day and data-status. */
  function heatmapSvg(habit, folded, today, opts) {
    var weeks = Math.max(1, ((opts && opts.weeks) || 53) | 0);
    var cell = (opts && opts.cell) || 11, gap = (opts && opts.gap) || 2;
    var tO = toOrd(today);
    var first = tO - (isoWeekdayOrd(tO) - 1) - 7 * (weeks - 1);
    var ctx = build(habit, folded, today, first);
    var color = safeColor(habit.color);
    var fill = {
      done: 'var(--kz-habit-done, ' + color + ')',
      skipped: 'var(--kz-habit-skipped, #c8ccd2)',
      paused: 'var(--kz-habit-paused, #dfe2e6)',
      off: 'var(--kz-habit-off, #eef0f2)',
      open: 'var(--kz-habit-open, #ffffff)',
      missed: 'var(--kz-habit-missed, #f3c7c7)'
    };
    var w = weeks * (cell + gap) - gap, h = 7 * (cell + gap) - gap;
    var name = esc(habit.name);
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" class="kz-habit-heatmap" role="img" viewBox="0 0 ' + w + ' ' + h +
      '" width="' + w + '" height="' + h + '" aria-label="' + name + ' history"><title>' + name + ' history</title>'];
    for (var c = 0; c < weeks; c++) {
      for (var r = 0; r < 7; r++) {
        var o = first + c * 7 + r;
        if (o > tO) break;
        var day = fromOrd(o), st = ctx.status(o);
        out.push('<rect x="' + c * (cell + gap) + '" y="' + r * (cell + gap) + '" width="' + cell + '" height="' + cell +
          '" rx="2" data-day="' + day + '" data-status="' + st + '" fill="' + fill[st] + '"' +
          (st === 'open' ? ' stroke="var(--kz-habit-open-stroke, #c8ccd2)"' : '') +
          '><title>' + day + ': ' + LABEL[st] + '</title></rect>');
      }
    }
    out.push('</svg>');
    return out.join('');
  }

  // ---- habit definitions (H1) ----
  /** true, or an error string. */
  function validateHabit(h) {
    if (!h || typeof h !== 'object') return 'habit must be an object';
    if (typeof h.id !== 'string' || !h.id) return 'id must be a non-empty string';
    if (typeof h.name !== 'string' || !h.name.trim()) return 'name must be a non-empty string';
    if (h.name.length > 200) return 'name is longer than 200 characters';
    if (h.color != null && typeof h.color !== 'string') return 'color must be a string';
    if (h.order != null && (typeof h.order !== 'number' || !isFinite(h.order))) return 'order must be a number';
    if (h.createdAt != null && createdOrd(h) === null) return 'createdAt must be ms, an ISO string or YYYY-MM-DD';
    var s = h.schedule;
    if (!s || typeof s !== 'object') return 'schedule is required';
    var isInt = function (x, a, b) { return typeof x === 'number' && x % 1 === 0 && x >= a && x <= b; };
    if (s.type === 'daily') { /* ok */ }
    else if (s.type === 'weekdays') {
      if (!Array.isArray(s.days) || !s.days.length) return 'weekdays schedule needs days';
      for (var i = 0; i < s.days.length; i++) {
        if (!isInt(s.days[i], 1, 7)) return 'weekdays days must be 1..7 (1 = Monday)';
        if (s.days.indexOf(s.days[i]) !== i) return 'weekdays days must not repeat';
      }
    } else if (s.type === 'xPerWeek') {
      if (!isInt(s.n, 1, 7)) return 'xPerWeek n must be 1..7';
    } else if (s.type === 'xInDays') {
      if (!isInt(s.m, 1, 365)) return 'xInDays m must be 1..365';
      if (!isInt(s.n, 1, s.m)) return 'xInDays n must be 1..m';
    } else return 'unknown schedule type';
    if (h.dayEndHour != null && !isInt(h.dayEndHour, 0, 23)) return 'dayEndHour must be 0..23';
    if (h.reminders != null) {
      if (!Array.isArray(h.reminders)) return 'reminders must be an array';
      for (var j = 0; j < h.reminders.length; j++) {
        var r = h.reminders[j];
        if (!r || typeof r.id !== 'string' || !r.id) return 'reminder id must be a non-empty string';
        if (typeof r.at !== 'string' || !TIME_RE.test(r.at)) return 'reminder at must be HH:MM';
      }
    }
    if (h.paused != null && !isDay(h.paused)) return 'paused must be null or YYYY-MM-DD';
    if (h.archived != null && typeof h.archived !== 'boolean') return 'archived must be a boolean';
    return true;
  }
  function randomId() {
    var c = root.crypto;
    var bytes = new Uint8Array(9);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var s = '';
    for (var k = 0; k < bytes.length; k++) s += (bytes[k] + 256).toString(16).slice(1);
    return 'h_' + s;
  }
  /** New habit with defaults; `fields.id` may be injected (tests). createdAt is the ISO string of nowMs.
   *  Throws on an invalid result. */
  function newHabit(fields, nowMs) {
    var f = fields || {};
    var h = {
      id: f.id || randomId(),
      name: typeof f.name === 'string' ? f.name.trim() : '',
      color: f.color || '#2da44e',
      order: typeof f.order === 'number' ? f.order : 0,
      createdAt: new Date(nowMs).toISOString(),
      schedule: f.schedule || { type: 'daily' },
      dayEndHour: f.dayEndHour == null ? 0 : f.dayEndHour,
      reminders: f.reminders || [],
      paused: f.paused || null,
      archived: !!f.archived
    };
    var v = validateHabit(h);
    if (v !== true) throw new Error('KzHabits.newHabit: ' + v);
    return h;
  }

  root.KzHabits = {
    dayFor: dayFor, todayFor: todayFor,
    parseLog: parseLog, serializeLine: serializeLine, fold: fold, makeLine: makeLine, inverseLine: inverseLine,
    isScheduled: isScheduled, status: status, isDue: isDue,
    streaks: streaks, score: score, completionRate: completionRate, heatmapSvg: heatmapSvg,
    validateHabit: validateHabit, newHabit: newHabit,
    addDays: addDays, isoWeekday: isoWeekday, mondayOf: mondayOf, frequency: freqOf
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

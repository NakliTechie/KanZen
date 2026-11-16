/* kz-tasks.js — KanZen tasks logic: quick add, repeat grammar, occurrences, completion, smart views.
 * Contract: docs/specs/kanzen-tasks-contract-001.md (KzTasks). Classic script, pure functions.
 * Needs globalThis.Temporal and globalThis.KzVendor ({ chrono, RRuleTemporal }) from kz-vendor-dates.js.
 * Days are 'YYYY-MM-DD', times 'HH:MM', instants ms; days and times are floating local values.
 * Repeats expand in UTC, which has no DST, so a floating day and wall time never shift (R8). */
(function (root) {
  'use strict';

  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var WD_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  var WD_NAMES = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
  var WD_WORDS = {
    mo: 'MO', mon: 'MO', monday: 'MO',
    tu: 'TU', tue: 'TU', tues: 'TU', tuesday: 'TU',
    we: 'WE', wed: 'WE', weds: 'WE', wednesday: 'WE',
    th: 'TH', thu: 'TH', thur: 'TH', thurs: 'TH', thursday: 'TH',
    fr: 'FR', fri: 'FR', friday: 'FR',
    sa: 'SA', sat: 'SA', saturday: 'SA',
    su: 'SU', sun: 'SU', sunday: 'SU'
  };
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MONTH_WORDS = {};
  MONTH_NAMES.forEach(function (n, i) { MONTH_WORDS[n.toLowerCase()] = i + 1; MONTH_WORDS[n.slice(0, 3).toLowerCase()] = i + 1; });
  MONTH_WORDS.sept = 9;
  var NTH_WORDS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 };
  var NTH_NAMES = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', '-1': 'last' };
  var PRIORITY = { p1: 'urgent', p2: 'high', p3: 'medium', p4: 'low' };
  var RRULE_KEYS = { FREQ: 1, INTERVAL: 1, BYDAY: 1, BYMONTHDAY: 1, BYMONTH: 1, BYSETPOS: 1, COUNT: 1, UNTIL: 1, WKST: 1 };

  // ---------- environment ----------
  function T() {
    var t = root.Temporal;
    if (!t) throw new Error('KzTasks needs Temporal: load kz-vendor-dates.js first');
    return t;
  }
  function V() {
    var v = root.KzVendor;
    if (!v || !v.chrono || !v.RRuleTemporal) throw new Error('KzTasks needs KzVendor: load kz-vendor-dates.js first');
    return v;
  }

  // ---------- day and time helpers ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isDay(s) {
    if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
    try { return T().PlainDate.from(s, { overflow: 'reject' }).toString() === s; } catch (e) { return false; }
  }
  function isTime(s) { return typeof s === 'string' && TIME_RE.test(s); }
  function addDays(day, n) { return T().PlainDate.from(day).add({ days: n }).toString(); }
  function daysBetween(a, b) { return T().PlainDate.from(a).until(T().PlainDate.from(b), { largestUnit: 'days' }).days; }
  function maxDay(a, b) { return !a ? b : !b ? a : (a > b ? a : b); }
  function isoAt(now) { return new Date(now).toISOString(); }
  function toMs(v) { return typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN); }
  function dayOfIso(iso, tz) {
    var ms = toMs(iso);
    if (isNaN(ms)) return null;
    if (!tz) return new Date(ms).toISOString().slice(0, 10);
    return T().Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz).toPlainDate().toString();
  }
  function isValidZone(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  // Wall-clock reference for chrono: a Date whose local fields equal "now" in tz (or today at 12:00).
  function chronoRef(ctx) {
    ctx = ctx || {};
    var y, mo, d, h = 12, mi = 0;
    if (ctx.now != null && isValidZone(ctx.tz)) {
      var z = T().Instant.fromEpochMilliseconds(ctx.now).toZonedDateTimeISO(ctx.tz);
      y = z.year; mo = z.month; d = z.day; h = z.hour; mi = z.minute;
      if (ctx.today && z.toPlainDate().toString() !== ctx.today) { h = 12; mi = 0; y = undefined; }
    }
    if (y === undefined) {
      var t = ctx.today || (ctx.now != null ? new Date(ctx.now).toISOString().slice(0, 10) : null);
      if (!t) throw new Error('KzTasks: pass today (YYYY-MM-DD) or now');
      y = +t.slice(0, 4); mo = +t.slice(5, 7); d = +t.slice(8, 10);
    }
    return new Date(y, mo - 1, d, h, mi, 0, 0);
  }
  function componentsOf(c) {
    var date = c.get('year') + '-' + pad(c.get('month')) + '-' + pad(c.get('day'));
    var time = c.isCertain('hour') ? pad(c.get('hour')) + ':' + pad(c.get('minute') || 0) : null;
    return { date: date, time: time };
  }
  // chrono results over text: [{ index, text, date, time }]
  function chronoAll(text, ctx) {
    var res = V().chrono.parse(text, chronoRef(ctx), { forwardDate: true });
    return res.map(function (r) {
      var c = componentsOf(r.start);
      return { index: r.index, text: r.text, date: c.date, time: c.time };
    });
  }
  // A date phrase that must make up the whole text: ISO day or something chrono reads end to end.
  function parseDayExact(text, ctx) {
    var s = String(text || '').trim();
    if (!s) return null;
    if (isDay(s)) return { date: s, time: null };
    var r = chronoAll(s, ctx)[0];
    if (!r || r.index !== 0 || r.text.trim().length !== s.length) return null;
    return { date: r.date, time: r.time };
  }
  function parseTimeWord(s) {
    s = String(s || '').trim().toLowerCase().replace(/\./g, '');
    if (s === 'noon') return '12:00';
    if (s === 'midnight') return '00:00';
    var m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
    if (!m) return null;
    var h = +m[1], mi = m[2] ? +m[2] : 0;
    if (mi > 59) return null;
    if (m[3]) {
      if (h < 1 || h > 12) return null;
      if (m[3] === 'am') h = h === 12 ? 0 : h; else h = h === 12 ? 12 : h + 12;
    } else if (h > 23) return null;
    return pad(h) + ':' + pad(mi);
  }

  // ---------- RRULE parts ----------
  function parseRRule(s) {
    var out = {};
    String(s || '').split(';').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
    });
    return out;
  }
  function buildRRule(p) {
    var order = ['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'BYSETPOS', 'WKST', 'COUNT', 'UNTIL'];
    return order.filter(function (k) { return p[k] != null && p[k] !== '' && !(k === 'INTERVAL' && String(p[k]) === '1'); })
      .map(function (k) { return k + '=' + p[k]; }).join(';');
  }
  // Floating UNTIL (YYYYMMDD or YYYYMMDDTHHMMSS) becomes a UTC DATE-TIME, matching the UTC expansion.
  function expansionRRule(rrule) {
    var p = parseRRule(rrule);
    if (p.UNTIL) {
      var u = p.UNTIL;
      if (/^\d{8}$/.test(u)) p.UNTIL = u + 'T235959Z';
      else if (/^\d{8}T\d{6}$/.test(u)) p.UNTIL = u + 'Z';
    }
    return buildRRule(p);
  }
  function untilDay(rrule) {
    var u = parseRRule(rrule).UNTIL;
    return u ? u.slice(0, 4) + '-' + u.slice(4, 6) + '-' + u.slice(6, 8) : null;
  }

  var ruleCache = new Map();
  function ruleFor(rrule, anchor, time) {
    var key = rrule + '|' + anchor + '|' + (time || '');
    var hit = ruleCache.get(key);
    if (hit) return hit;
    var t = time || '00:00';
    var dt = T().ZonedDateTime.from({
      year: +anchor.slice(0, 4), month: +anchor.slice(5, 7), day: +anchor.slice(8, 10),
      hour: +t.slice(0, 2), minute: +t.slice(3, 5), timeZone: 'UTC'
    });
    var rule = new (V().RRuleTemporal)({ rruleString: expansionRRule(rrule), dtstart: dt });
    if (ruleCache.size > 500) ruleCache.clear();
    ruleCache.set(key, rule);
    return rule;
  }
  function utcEdge(day, end) { return T().ZonedDateTime.from(day + (end ? 'T23:59:59' : 'T00:00:00') + '[UTC]'); }
  function zdtDay(z) { return z.toPlainDate().toString(); }

  // First occurrence day strictly after afterDay, or null when the series has ended.
  function nextOccurrence(repeat, afterDay) {
    if (!repeat || !repeat.rrule || !isDay(repeat.anchor)) return null;
    var r = ruleFor(repeat.rrule, repeat.anchor, repeat.time);
    var from = isDay(afterDay) ? afterDay : addDays(repeat.anchor, -1);
    var z = r.next(utcEdge(from, true), false);
    return z ? zdtDay(z) : null;
  }
  // Occurrence days in [fromDay, toDay], at most limit (default 1000).
  function occurrencesBetween(repeat, fromDay, toDay, limit) {
    if (!repeat || !repeat.rrule || !isDay(repeat.anchor) || !isDay(fromDay) || !isDay(toDay) || fromDay > toDay) return [];
    var r = ruleFor(repeat.rrule, repeat.anchor, repeat.time);
    var max = limit > 0 ? limit : 1000;
    var out = [];
    var hits = r.between(utcEdge(fromDay, false), utcEdge(toDay, true), true);
    for (var i = 0; i < hits.length && out.length < max; i++) {
      var d = zdtDay(hits[i]);
      if (out[out.length - 1] !== d) out.push(d);
    }
    return out;
  }
  // The instant (ms) of an occurrence day at the repeat's floating time in zone tz (default repeat.tz).
  function occurrenceInstant(repeat, day, tz) {
    var zone = tz || (repeat && repeat.tz) || 'UTC';
    var t = (repeat && repeat.time) || '00:00';
    return T().PlainDateTime.from(day + 'T' + t).toZonedDateTime(zone, { disambiguation: 'compatible' }).epochMilliseconds;
  }

  // ---------- repeat grammar (C3) ----------
  function dayListCodes(s) {
    var toks = s.split(/\s*(?:,|&|\band\b|\bor\b)\s*|\s+/).filter(Boolean);
    if (!toks.length) return null;
    var codes = [];
    for (var i = 0; i < toks.length; i++) {
      var w = toks[i];
      var c = WD_WORDS[w] || (/s$/.test(w) ? WD_WORDS[w.slice(0, -1)] : null);
      if (!c) return null;
      if (codes.indexOf(c) < 0) codes.push(c);
    }
    codes.sort(function (a, b) { return WD_CODES.indexOf(a) - WD_CODES.indexOf(b); });
    return codes;
  }
  function ordinalNum(w) {
    var m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(w);
    if (!m) return null;
    var n = +m[1];
    return n >= 1 && n <= 31 ? n : null;
  }
  // "the 3rd", "3rd and 15th", "last day" → BYMONTHDAY list
  var MONTH_TAIL = '(?:\\s+(?:day\\s+)?of\\s+(?:the\\s+|each\\s+|every\\s+)?month)?';
  function monthDaySpec(s, needOrdinal) {
    s = s.replace(/^the\s+/, '');
    var m = new RegExp('^last\\s+day' + MONTH_TAIL + '$').exec(s);
    if (m) return { BYMONTHDAY: '-1' };
    m = new RegExp('^(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\\s+([a-z]+)' + MONTH_TAIL + '$').exec(s);
    if (m && WD_WORDS[m[2]]) return { BYDAY: NTH_WORDS[m[1]] + WD_WORDS[m[2]] };
    m = new RegExp('^(.+?)(?:\\s+day)?' + MONTH_TAIL + '$').exec(s);
    if (!m) return null;
    var hasTail = m[0] !== m[1];
    var toks = m[1].split(/\s*(?:,|&|\band\b)\s*(?:the\s+)?/).filter(Boolean);
    var days = [];
    for (var i = 0; i < toks.length; i++) {
      if (needOrdinal && !hasTail && !/(st|nd|rd|th)$/.test(toks[i])) return null;
      var n = ordinalNum(toks[i]);
      if (!n) return null;
      days.push(n);
    }
    return days.length ? { BYMONTHDAY: days.join(',') } : null;
  }
  function yearDaySpec(s) {
    var m = /^(?:the\s+)?([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
    if (m && MONTH_WORDS[m[1]]) return { BYMONTH: String(MONTH_WORDS[m[1]]), BYMONTHDAY: String(+m[2]) };
    m = /^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/.exec(s);
    if (m && MONTH_WORDS[m[2]]) return { BYMONTH: String(MONTH_WORDS[m[2]]), BYMONTHDAY: String(+m[1]) };
    return null;
  }
  var UNIT_FREQ = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
  // Body after "every": returns RRULE parts or null.
  function parseBody(b) {
    var m;
    if (/^(day|days|daily)$/.test(b)) return { FREQ: 'DAILY' };
    if (/^(weekday|weekdays|workday|workdays|work day|work days)$/.test(b)) return { FREQ: 'WEEKLY', BYDAY: 'MO,TU,WE,TH,FR' };
    if (/^(weekend|weekends|weekend day|weekend days)$/.test(b)) return { FREQ: 'WEEKLY', BYDAY: 'SA,SU' };
    if ((m = /^(day|week|month|year)$/.exec(b))) return { FREQ: UNIT_FREQ[m[1]] };
    m = /^(other|\d{1,3})\s+(day|week|month|year)s?(?:\s+on\s+(.+))?$/.exec(b);
    if (!m) { var one = /^(week|month|year)\s+on\s+(.+)$/.exec(b); if (one) m = [one[0], '1', one[1], one[2]]; }
    if (m) {
      var n = m[1] === 'other' ? 2 : +m[1];
      if (!(n >= 1)) return null;
      var p = { FREQ: UNIT_FREQ[m[2]], INTERVAL: String(n) };
      if (m[3]) {
        var extra = null;
        if (m[2] === 'week') { var c = dayListCodes(m[3]); extra = c && { BYDAY: c.join(',') }; }
        else if (m[2] === 'month') extra = monthDaySpec(m[3], false);
        else if (m[2] === 'year') extra = yearDaySpec(m[3]);
        if (!extra) return null;
        for (var k in extra) p[k] = extra[k];
      }
      return p;
    }
    if ((m = /^other\s+(.+)$/.exec(b))) {
      var oc = dayListCodes(m[1]);
      return oc ? { FREQ: 'WEEKLY', INTERVAL: '2', BYDAY: oc.join(',') } : null;
    }
    var codes = dayListCodes(b);
    if (codes) return { FREQ: 'WEEKLY', BYDAY: codes.join(',') };
    var md = monthDaySpec(b, true);
    if (md) { md.FREQ = 'MONTHLY'; return md; }
    var yd = yearDaySpec(b);
    if (yd) { yd.FREQ = 'YEARLY'; return yd; }
    return null;
  }
  var SHORTHAND = {
    daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year', annually: 'every year',
    biweekly: 'every 2 weeks', fortnightly: 'every 2 weeks', weekdays: 'every weekday', weekends: 'every weekend'
  };
  // Whole phrase → { parts, time, mode, start } or null. s is lower case with single spaces.
  function parseRepeatExact(s, ctx) {
    var mode = 'fixed';
    if (/^every!/.test(s)) { mode = 'afterCompletion'; s = s.replace(/^every!\s*/, 'every '); }
    var ac = /\s+(?:after|from)\s+(?:completion|completing|done|complete)\b/;
    if (ac.test(s)) { mode = 'afterCompletion'; s = s.replace(ac, ''); }
    var sh = /^([a-z]+)\b/.exec(s);
    if (sh && SHORTHAND[sh[1]]) s = SHORTHAND[sh[1]] + s.slice(sh[1].length);
    var segs = s.split(/\s+(?=(?:at|until|till|ending|for|starting|from|beginning)\s)/);
    var body = segs[0];
    var time = null, start = null, count = null, until = null;
    for (var i = 1; i < segs.length; i++) {
      var seg = segs[i], m;
      if ((m = /^at\s+(.+)$/.exec(seg))) { if (time) return null; time = parseTimeWord(m[1]); if (!time) return null; }
      else if ((m = /^(?:until|till|ending(?:\s+on)?)\s+(.+)$/.exec(seg))) { var u = parseDayExact(m[1], ctx); if (!u || until) return null; until = u.date; }
      else if ((m = /^for\s+(\d{1,4})\s+(?:times?|occurrences?)$/.exec(seg))) { count = +m[1]; if (!count) return null; }
      else if ((m = /^(?:starting|beginning|from)(?:\s+(?:on|from))?\s+(.+)$/.exec(seg))) { var st = parseDayExact(m[1], ctx); if (!st || start) return null; start = st.date; }
      else return null;
    }
    var bm = /^(?:every|each)\s+(.+)$/.exec(body);
    if (!bm) return null;
    var b = bm[1];
    var parts = parseBody(b);
    if (!parts && !time) {
      var tm = /^(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2}|noon|midnight)$/.exec(b);
      if (tm) { parts = parseBody(tm[1]); time = parts ? parseTimeWord(tm[2]) : null; if (!time) parts = null; }
    }
    if (!parts) return null;
    if (count) parts.COUNT = String(count);
    if (until) parts.UNTIL = until.replace(/-/g, '');
    return { parts: parts, time: time, mode: mode, start: start };
  }
  // First occurrence on or after fromDay, used as the anchor (DTSTART) so COUNT and INTERVAL phase line up.
  // The search drops INTERVAL and COUNT, so "every 3 months on the 10th" from 16 Nov starts on 10 Dec.
  function anchorFor(rrule, time, fromDay) {
    var p = parseRRule(rrule);
    delete p.INTERVAL; delete p.COUNT;
    return nextOccurrence({ rrule: buildRRule(p), time: time, anchor: fromDay }, addDays(fromDay, -1));
  }
  // "every"/"each" phrases win over one-word shorthands, so "Weekly review every Friday" reads the Friday rule.
  var TRIGGERS = [
    /(^|[^a-z0-9!])(every!|every|each)(?![a-z0-9])/gi,
    /(^|[^a-z0-9!])(daily|weekly|monthly|yearly|annually|biweekly|fortnightly|weekdays|weekends)(?![a-z0-9])/gi
  ];
  // parseRepeat finds the first repeat phrase in the text; start/end index it in the input.
  function parseRepeat(phrase, opts) {
    opts = opts || {};
    var text = String(phrase || '');
    var today = opts.today;
    if (!isDay(today)) throw new Error('parseRepeat needs today (YYYY-MM-DD)');
    var ctx = { today: today, tz: opts.tz, now: opts.now };
    for (var ti = 0; ti < TRIGGERS.length; ti++) {
    var TRIGGER_RE = TRIGGERS[ti];
    TRIGGER_RE.lastIndex = 0;
    var m;
    while ((m = TRIGGER_RE.exec(text))) {
      var s0 = m.index + m[1].length;
      var ends = [];
      var re = /\S+/g, w;
      re.lastIndex = s0;
      while ((w = re.exec(text)) && ends.length < 18) ends.push(w.index + w[0].length);
      for (var j = ends.length - 1; j >= 0; j--) {
        var raw = text.slice(s0, ends[j]);
        if (/^every!$/i.test(raw)) continue;
        var cut = raw.replace(/[.,;:!?)]+$/, '');
        var norm = cut.toLowerCase().replace(/\s+/g, ' ').trim();
        if (/[\u0000-\u001f]/.test(norm)) continue;
        var r = parseRepeatExact(norm, ctx);
        if (!r) continue;
        var rrule = buildRRule(r.parts);
        var anchor = anchorFor(rrule, r.time, r.start || today);
        if (!anchor) continue;
        return {
          repeat: { rrule: rrule, time: r.time, mode: r.mode, tz: opts.tz || 'UTC', anchor: anchor, resetChecklist: false },
          start: s0, end: s0 + cut.length
        };
      }
      TRIGGER_RE.lastIndex = m.index + m[0].length;
    }
    }
    return null;
  }

  function listWords(arr) {
    if (arr.length <= 1) return arr.join('');
    return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
  }
  function ordSuffix(n) {
    var v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }
  function describeRepeat(repeat) {
    if (!repeat || !repeat.rrule) return '';
    var p = parseRRule(repeat.rrule);
    var n = +(p.INTERVAL || 1);
    var unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[p.FREQ] || String(p.FREQ || '').toLowerCase();
    var every = n === 1 ? 'Every ' + unit : 'Every ' + n + ' ' + unit + 's';
    var s = every;
    if (p.FREQ === 'WEEKLY' && p.BYDAY) {
      var days = p.BYDAY.split(',');
      var set = days.join(',');
      if (n === 1 && set === 'MO,TU,WE,TH,FR') s = 'Every weekday';
      else if (n === 1 && set === 'SA,SU') s = 'Every weekend day';
      else if (n === 1) s = 'Every ' + listWords(days.map(function (d) { return WD_NAMES[d] || d; }));
      else s = every + ' on ' + listWords(days.map(function (d) { return WD_NAMES[d] || d; }));
    } else if (p.FREQ === 'MONTHLY') {
      if (p.BYMONTHDAY) {
        var md = p.BYMONTHDAY.split(',').map(Number);
        s = every + ' on the ' + listWords(md.map(function (d) { return d === -1 ? 'last day' : d < 0 ? ordSuffix(-d) + ' last day' : ordSuffix(d); }));
      } else if (p.BYDAY) {
        var bm = /^(-?\d)([A-Z]{2})$/.exec(p.BYDAY);
        s = bm ? every + ' on the ' + NTH_NAMES[bm[1]] + ' ' + WD_NAMES[bm[2]] : every + ' on ' + p.BYDAY;
      }
    } else if (p.FREQ === 'YEARLY' && p.BYMONTH && p.BYMONTHDAY) {
      s = every + ' on ' + MONTH_NAMES[+p.BYMONTH - 1] + ' ' + p.BYMONTHDAY;
    }
    if (repeat.time) s += ' at ' + repeat.time;
    if (repeat.mode === 'afterCompletion') s += ', counted from completion';
    if (p.COUNT) s += ', ' + p.COUNT + ' times';
    var u = untilDay(repeat.rrule);
    if (u) s += ', until ' + u;
    return s;
  }

  function validateRepeat(repeat) {
    if (!repeat || typeof repeat !== 'object') return 'repeat must be an object';
    if (typeof repeat.rrule !== 'string' || !repeat.rrule) return 'repeat.rrule must be a non-empty string';
    if (/^RRULE:|DTSTART/i.test(repeat.rrule)) return 'repeat.rrule must not contain RRULE: or DTSTART';
    var p = parseRRule(repeat.rrule);
    for (var k in p) if (!RRULE_KEYS[k]) return 'repeat.rrule has unsupported part ' + k;
    if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(p.FREQ || '')) return 'repeat.rrule FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY';
    if (p.INTERVAL != null && !/^[1-9]\d{0,3}$/.test(p.INTERVAL)) return 'repeat.rrule INTERVAL must be a positive integer';
    if (p.COUNT != null && !/^[1-9]\d{0,4}$/.test(p.COUNT)) return 'repeat.rrule COUNT must be a positive integer';
    if (p.UNTIL != null && !/^\d{8}(T\d{6}Z?)?$/.test(p.UNTIL)) return 'repeat.rrule UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSS';
    if (p.COUNT != null && p.UNTIL != null) return 'repeat.rrule must not have both COUNT and UNTIL';
    if (p.BYDAY != null && !/^([+-]?\d{0,2}(MO|TU|WE|TH|FR|SA|SU))(,[+-]?\d{0,2}(MO|TU|WE|TH|FR|SA|SU))*$/.test(p.BYDAY)) return 'repeat.rrule BYDAY is malformed';
    if (p.BYMONTHDAY != null && !/^-?\d{1,2}(,-?\d{1,2})*$/.test(p.BYMONTHDAY)) return 'repeat.rrule BYMONTHDAY is malformed';
    if (p.BYMONTH != null && !/^\d{1,2}(,\d{1,2})*$/.test(p.BYMONTH)) return 'repeat.rrule BYMONTH is malformed';
    if (!(repeat.time === null || repeat.time === undefined || isTime(repeat.time))) return 'repeat.time must be HH:MM or null';
    if (repeat.mode !== 'fixed' && repeat.mode !== 'afterCompletion') return 'repeat.mode must be fixed or afterCompletion';
    if (!isValidZone(repeat.tz)) return 'repeat.tz must be an IANA zone name';
    if (!isDay(repeat.anchor)) return 'repeat.anchor must be YYYY-MM-DD';
    if (repeat.resetChecklist !== undefined && typeof repeat.resetChecklist !== 'boolean') return 'repeat.resetChecklist must be a boolean';
    try { ruleFor(repeat.rrule, repeat.anchor, repeat.time); } catch (e) { return 'repeat.rrule is not accepted: ' + e.message; }
    return true;
  }

  function validateTaskFields(card) {
    if (!card || typeof card !== 'object') return 'card must be an object';
    var c = card;
    if (c.dueDate != null && !isDay(c.dueDate)) return 'dueDate must be YYYY-MM-DD';
    if (c.dueTime != null && !isTime(c.dueTime)) return 'dueTime must be HH:MM';
    if (c.startDate != null && !isDay(c.startDate)) return 'startDate must be YYYY-MM-DD';
    if (c.startTime != null && !isTime(c.startTime)) return 'startTime must be HH:MM';
    if (c.dueTime != null && c.dueDate == null) return 'dueTime needs dueDate';
    if (c.startTime != null && c.startDate == null) return 'startTime needs startDate';
    if (c.someday != null && c.someday !== true && c.someday !== false) return 'someday must be true when present';
    if (c.repeat != null) { var r = validateRepeat(c.repeat); if (r !== true) return r; }
    if (c.reminders != null) {
      if (!Array.isArray(c.reminders)) return 'reminders must be an array';
      for (var i = 0; i < c.reminders.length; i++) {
        var m = c.reminders[i];
        if (!m || typeof m.id !== 'string' || !m.id) return 'reminders[' + i + '].id must be a string';
        var hasAt = m.at != null, hasOff = m.offsetMin != null;
        if (hasAt === hasOff) return 'reminders[' + i + '] needs exactly one of at or offsetMin';
        if (hasAt && !(typeof m.at === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(m.at) && isDay(m.at.slice(0, 10)))) return 'reminders[' + i + '].at must be YYYY-MM-DDTHH:MM';
        if (hasOff && !(Number.isInteger(m.offsetMin) && m.offsetMin >= 0)) return 'reminders[' + i + '].offsetMin must be a non-negative integer';
        if (m.snooze != null && typeof m.snooze !== 'boolean') return 'reminders[' + i + '].snooze must be a boolean';
      }
    }
    if (c.parentId != null && (typeof c.parentId !== 'string' || !c.parentId)) return 'parentId must be a card id';
    if (c.parentId != null && c.parentId === c.id) return 'parentId must not be the card itself';
    if (c.estimateMin != null && !(Number.isInteger(c.estimateMin) && c.estimateMin >= 0)) return 'estimateMin must be a non-negative integer';
    if (c.completedAt != null && (typeof c.completedAt !== 'string' || isNaN(Date.parse(c.completedAt)))) return 'completedAt must be an ISO time';
    if (c.doneLog != null) {
      if (!Array.isArray(c.doneLog)) return 'doneLog must be an array';
      for (var j = 0; j < c.doneLog.length; j++) {
        var e = c.doneLog[j];
        if (!e || !isDay(e.occ)) return 'doneLog[' + j + '].occ must be YYYY-MM-DD';
        if (typeof e.at !== 'string' || isNaN(Date.parse(e.at))) return 'doneLog[' + j + '].at must be an ISO time';
        if (e.kind !== 'done' && e.kind !== 'skip') return 'doneLog[' + j + '].kind must be done or skip';
        if (e.prevDue != null && !isDay(e.prevDue)) return 'doneLog[' + j + '].prevDue must be YYYY-MM-DD or null';
        if (e.prevStart != null && !isDay(e.prevStart)) return 'doneLog[' + j + '].prevStart must be YYYY-MM-DD or null';
      }
    }
    return true;
  }

  // ---------- board helpers ----------
  function doneColumn(board) {
    var cols = (board && board.columns) || [];
    for (var i = 0; i < cols.length; i++) if (cols[i] && cols[i].done === true) return cols[i];
    for (var j = 0; j < cols.length; j++) if (cols[j] && /^(done|completed?|finished)$/i.test(String(cols[j].name || '').trim())) return cols[j];
    return null;
  }
  function columnOf(board, cardId) {
    var cols = (board && board.columns) || [];
    for (var i = 0; i < cols.length; i++) if ((cols[i].cardIds || []).indexOf(cardId) >= 0) return cols[i];
    return null;
  }
  function moveTo(board, cardId, col) {
    if (!col) return;
    (board.columns || []).forEach(function (c) {
      if (!c.cardIds) return;
      var k = c.cardIds.indexOf(cardId);
      if (k >= 0) c.cardIds.splice(k, 1);
    });
    if (!col.cardIds) col.cardIds = [];
    col.cardIds.push(cardId);
  }
  function getCard(board, cardId) {
    var card = board && board.cards && board.cards[cardId];
    if (!card) throw new Error('KzTasks: card ' + cardId + ' not found');
    return card;
  }
  function isDone(board, cardId) {
    var card = board && board.cards && board.cards[cardId];
    if (!card) return false;
    if (card.completedAt) return true;
    var dc = doneColumn(board);
    return !!dc && (dc.cardIds || []).indexOf(cardId) >= 0;
  }
  function hasRepeat(card) { return !!(card && card.repeat && card.repeat.rrule && isDay(card.repeat.anchor)); }

  // Next scheduled day after a completion or skip. base: the day to count from.
  function advanceDay(card, base, today) {
    var rep = card.repeat;
    if (rep.mode === 'afterCompletion') {
      var p = parseRRule(rep.rrule);
      var count = p.COUNT ? +p.COUNT : 0;
      delete p.COUNT;
      if (count && (card.doneLog || []).length + 1 >= count) return null;
      var from = maxDay(base, today);
      return nextOccurrence({ rrule: buildRRule(p), time: rep.time, anchor: from }, from);
    }
    return nextOccurrence(rep, base);
  }
  function scheduledDay(card, today) { return card.dueDate || card.startDate || today; }
  function closeCard(board, cardId, card, entry, now) {
    var from = columnOf(board, cardId);
    card.completedAt = isoAt(now);
    var dc = doneColumn(board);
    if (entry) { entry.closed = true; entry.prevCol = from ? from.id : null; }
    if (dc && from !== dc) moveTo(board, cardId, dc);
  }
  function applyAdvance(board, cardId, card, kind, next, occ, now) {
    var entry = { occ: occ, at: isoAt(now), kind: kind, prevDue: card.dueDate || null, prevStart: card.startDate || null };
    if (next) {
      if (card.dueDate) {
        var gap = card.startDate ? daysBetween(card.startDate, card.dueDate) : null;
        card.dueDate = next;
        if (gap !== null) card.startDate = addDays(next, -gap);
      } else if (card.startDate) card.startDate = next;
      else card.dueDate = next;
      if (card.repeat.resetChecklist && Array.isArray(card.checklist)) {
        var prev = [];
        card.checklist.forEach(function (it, i) { if (it && it.done) { prev.push(i); it.done = false; } });
        if (prev.length) entry.prevChecks = prev;
      }
    } else {
      closeCard(board, cardId, card, entry, now);
    }
    if (!Array.isArray(card.doneLog)) card.doneLog = [];
    card.doneLog.push(entry);
    return entry;
  }

  function completeCard(board, cardId, opts) {
    opts = opts || {};
    var card = getCard(board, cardId);
    var today = opts.today;
    if (hasRepeat(card)) {
      if (!isDay(today)) throw new Error('completeCard needs today');
      var occ = scheduledDay(card, today);
      var next = card.repeat.mode === 'afterCompletion' ? advanceDay(card, today, today) : advanceDay(card, maxDay(occ, today), today);
      applyAdvance(board, cardId, card, 'done', next, occ, opts.now);
      return { repeating: true, next: next };
    }
    closeCard(board, cardId, card, null, opts.now);
    return { repeating: false, next: null };
  }
  function skipOccurrence(board, cardId, opts) {
    opts = opts || {};
    var card = getCard(board, cardId);
    if (!hasRepeat(card)) throw new Error('skipOccurrence: card does not repeat');
    var today = opts.today;
    if (!isDay(today)) throw new Error('skipOccurrence needs today');
    var occ = scheduledDay(card, today);
    var next = advanceDay(card, occ, today);
    applyAdvance(board, cardId, card, 'skip', next, occ, opts.now);
    return { repeating: true, next: next };
  }
  // Complete forever: logs the current occurrence as done, keeps the rule for history, closes the card.
  function endSeries(board, cardId, opts) {
    opts = opts || {};
    var card = getCard(board, cardId);
    var entry = null;
    if (hasRepeat(card)) {
      entry = { occ: card.dueDate || card.startDate || card.repeat.anchor, at: isoAt(opts.now), kind: 'done', prevDue: card.dueDate || null, prevStart: card.startDate || null };
      if (!Array.isArray(card.doneLog)) card.doneLog = [];
      card.doneLog.push(entry);
    }
    closeCard(board, cardId, card, entry, opts.now);
    return { ended: true };
  }
  // Reverses the last completeCard, skipOccurrence or endSeries on the card.
  function uncompleteCard(board, cardId) {
    var card = getCard(board, cardId);
    var log = card.doneLog;
    if (hasRepeat(card) && Array.isArray(log) && log.length) {
      var e = log.pop();
      card.dueDate = e.prevDue || null;
      if (e.prevStart) card.startDate = e.prevStart; else delete card.startDate;
      if (e.prevChecks && Array.isArray(card.checklist)) e.prevChecks.forEach(function (i) { if (card.checklist[i]) card.checklist[i].done = true; });
      if (e.closed) {
        delete card.completedAt;
        reopenColumn(board, cardId, e.prevCol);
      }
      if (!log.length) delete card.doneLog;
      return { undone: true, entry: e };
    }
    if (card.completedAt || isDone(board, cardId)) {
      delete card.completedAt;
      reopenColumn(board, cardId, undefined);
      return { undone: true, entry: null };
    }
    return { undone: false, entry: null };
  }
  function reopenColumn(board, cardId, prevColId) {
    var dc = doneColumn(board);
    var cur = columnOf(board, cardId);
    if (!dc || cur !== dc) return;
    var target = null;
    if (prevColId) target = (board.columns || []).find(function (c) { return c.id === prevColId; }) || null;
    if (!target) target = (board.columns || []).find(function (c) { return c !== dc; }) || null;
    if (target) moveTo(board, cardId, target);
  }

  // ---------- smart views (V1–V4, V11) ----------
  function eachCard(boards, fn) {
    (boards || []).forEach(function (board, bi) {
      if (!board || !board.cards) return;
      (board.columns || []).forEach(function (col, ci) {
        (col.cardIds || []).forEach(function (id, k) {
          var card = board.cards[id];
          if (card) fn(board, card, id, [bi, ci, k]);
        });
      });
    });
  }
  function cmpOrder(a, b) {
    for (var i = 0; i < 3; i++) if (a._o[i] !== b._o[i]) return a._o[i] - b._o[i];
    return 0;
  }
  function strip(rows) { return rows.map(function (r) { delete r._o; return r; }); }
  function smartView(name, boards, opts) {
    opts = opts || {};
    var today = opts.today;
    if (!isDay(today)) throw new Error('smartView needs today (YYYY-MM-DD)');
    var rows = [];
    if (name === 'today' || name === 'overdue') {
      eachCard(boards, function (board, card, id, o) {
        if (isDone(board, id) || card.someday) return;
        var due = isDay(card.dueDate) ? card.dueDate : null, st = isDay(card.startDate) ? card.startDate : null;
        if (due && due < today) rows.push({ boardId: board.id, cardId: id, day: due, section: 'overdue', _o: o });
        else if (name === 'today' && ((due && due <= today) || (st && st <= today))) rows.push({ boardId: board.id, cardId: id, day: today, section: 'today', _o: o });
      });
      rows.sort(function (a, b) {
        if (a.section !== b.section) return a.section === 'overdue' ? -1 : 1;
        if (a.day !== b.day) return a.day < b.day ? -1 : 1;
        return cmpOrder(a, b);
      });
      return strip(rows);
    }
    if (name === 'upcoming') {
      var n = opts.days > 0 ? opts.days : 14;
      var first = addDays(today, 1), last = addDays(today, n);
      eachCard(boards, function (board, card, id, o) {
        if (isDone(board, id) || card.someday) return;
        var due = isDay(card.dueDate) ? card.dueDate : null, st = isDay(card.startDate) ? card.startDate : null;
        var days = [];
        if (hasRepeat(card) && card.repeat.mode === 'fixed') {
          var from = maxDay(first, due);
          try { days = occurrencesBetween(card.repeat, from, last, n + 1); } catch (e) { days = []; }
          if (due && due >= first && due <= last && days.indexOf(due) < 0) days.unshift(due);
        } else {
          var d = st ? (st > today ? st : null) : due;
          if (d && d >= first && d <= last) days = [d];
        }
        days.forEach(function (d) { rows.push({ boardId: board.id, cardId: id, day: d, section: d, _o: o }); });
      });
      rows.sort(function (a, b) { return a.day !== b.day ? (a.day < b.day ? -1 : 1) : cmpOrder(a, b); });
      return strip(rows);
    }
    if (name === 'anytime' || name === 'someday' || name === 'inbox') {
      eachCard(boards, function (board, card, id, o) {
        if (isDone(board, id)) return;
        if (name === 'someday' && card.someday) rows.push({ boardId: board.id, cardId: id, day: card.dueDate || null, section: 'someday', _o: o });
        else if (name === 'anytime' && !card.someday && !card.dueDate && !card.startDate && !hasRepeat(card)) rows.push({ boardId: board.id, cardId: id, day: null, section: 'anytime', _o: o });
        else if (name === 'inbox' && board.inbox) rows.push({ boardId: board.id, cardId: id, day: card.dueDate || null, section: 'inbox', _o: o });
      });
      rows.sort(cmpOrder);
      return strip(rows);
    }
    if (name === 'logbook') {
      eachCard(boards, function (board, card, id, o) {
        if (Array.isArray(card.doneLog) && card.doneLog.length) {
          card.doneLog.forEach(function (e) { rows.push({ boardId: board.id, cardId: id, day: e.occ, section: e.kind, at: e.at, _o: o }); });
          return;
        }
        if (!isDone(board, id)) return;
        var at = card.completedAt || card.lastModifiedAt || card.updatedAt || null;
        rows.push({ boardId: board.id, cardId: id, day: at ? dayOfIso(at, opts.tz) : null, section: 'done', at: at, _o: o });
      });
      rows.sort(function (a, b) {
        var x = toMs(a.at), y = toMs(b.at);
        x = isNaN(x) ? -Infinity : x; y = isNaN(y) ? -Infinity : y;
        return x !== y ? y - x : cmpOrder(a, b);
      });
      return strip(rows);
    }
    throw new Error('smartView: unknown view ' + name);
  }

  // ---------- quick add (C2, C4, C5) ----------
  function normName(s) { return String(s || '').toLowerCase().replace(/[_]/g, ' '); }
  // Longest name in list that the text starts with, ending at a word boundary.
  function matchName(rest, list) {
    var low = normName(rest);
    var best = null;
    (list || []).forEach(function (it) {
      var nm = normName(it.name).trim();
      if (!nm || low.slice(0, nm.length) !== nm) return;
      var after = low.charAt(nm.length);
      if (after && /[a-z0-9]/i.test(after)) return;
      if (!best || nm.length > best.len) best = { item: it, len: nm.length };
    });
    return best;
  }
  function parseQuickAdd(text, opts) {
    opts = opts || {};
    var src = String(text || '');
    var today = opts.today;
    if (!isDay(today)) throw new Error('parseQuickAdd needs today (YYYY-MM-DD)');
    var ctx = { today: today, tz: opts.tz, now: opts.now };
    var boards = opts.boards || [];
    var masked = src.split('');
    var parts = [];
    function mask(s, e) { for (var i = s; i < e; i++) masked[i] = '\u0001'; }
    function free(s, e) { for (var i = s; i < e; i++) if (masked[i] === '\u0001') return false; return true; }
    function add(kind, s, e, value) { parts.push({ kind: kind, text: src.slice(s, e), start: s, end: e, value: value }); mask(s, e); }
    var m, re;

    // {deadline}
    re = /\{([^{}]*)\}/g;
    var deadline = null;
    while ((m = re.exec(src))) {
      var dl = parseDayExact(m[1], ctx) || (chronoAll(m[1], ctx)[0] || null);
      if (dl && !deadline) { deadline = { date: dl.date, time: dl.time || null }; add('deadline', m.index, m.index + m[0].length, deadline); }
    }
    // p1..p4 (the last one wins)
    var priority = null;
    re = /(^|\s)(p[1-4])(?=\s|$|[.,;!?])/gi;
    while ((m = re.exec(src))) {
      var ps = m.index + m[1].length;
      if (!free(ps, ps + 2)) continue;
      priority = PRIORITY[m[2].toLowerCase()];
      add('priority', ps, ps + 2, priority);
    }
    // #board
    var board = null;
    re = /(^|\s)#(?=\S)/g;
    while ((m = re.exec(src))) {
      var hs = m.index + m[1].length;
      var hit = matchName(src.slice(hs + 1), boards);
      if (hit && !board && free(hs, hs + 1 + hit.len)) { board = hit.item; add('board', hs, hs + 1 + hit.len, board.id); }
    }
    var target = board || boards.find(function (b) { return b.id === opts.defaultBoardId; }) || boards.find(function (b) { return b.inbox; }) || boards[0] || null;
    // /column
    var column = null;
    re = /(^|\s)\/(?=\S)/g;
    while ((m = re.exec(src))) {
      var cs = m.index + m[1].length;
      var ch = target ? matchName(src.slice(cs + 1), target.columns) : null;
      if (ch && !column && free(cs, cs + 1 + ch.len)) { column = ch.item; add('column', cs, cs + 1 + ch.len, column.id); }
    }
    // @label (unknown names become new labels)
    var labelIds = [], newLabels = [];
    re = /(^|\s)@(?=[^\s@])/g;
    while ((m = re.exec(src))) {
      var ls = m.index + m[1].length;
      if (!free(ls, ls + 1)) continue;
      var lh = target ? matchName(src.slice(ls + 1), target.labels) : null;
      if (lh) {
        if (labelIds.indexOf(lh.item.id) < 0) labelIds.push(lh.item.id);
        add('label', ls, ls + 1 + lh.len, { id: lh.item.id, name: lh.item.name });
      } else {
        var word = /^[^\s#@{}]+/.exec(src.slice(ls + 1))[0].replace(/[.,;:!?]+$/, '');
        if (!word) continue;
        if (newLabels.indexOf(word) < 0) newLabels.push(word);
        add('label', ls, ls + 1 + word.length, { id: null, name: word });
      }
    }
    // someday
    var someday = false;
    re = /(^|\s)(someday)(?=\s|$|[.,;!?])/gi;
    while ((m = re.exec(src))) {
      var ss = m.index + m[1].length;
      if (!free(ss, ss + 7)) continue;
      someday = true;
      add('date', ss, ss + 7, { someday: true });
    }
    // repeat
    var rep = parseRepeat(masked.join(''), ctx);
    var repeat = null;
    if (rep) { repeat = rep.repeat; add('repeat', rep.start, rep.end, repeat); }
    // plain date: first chrono hit that does not overlap a token
    var date = null;
    var spaced = masked.map(function (c) { return c === '\u0001' ? ' ' : c; }).join('');
    var hits = chronoAll(spaced, ctx);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var s0 = h.index, e0 = h.index + h.text.length;
      if (!free(s0, e0) || !h.text.trim()) continue;
      date = { date: h.date, time: h.time };
      add('date', s0, e0, date);
      break;
    }

    var out = {
      title: '', boardId: target ? target.id : (opts.defaultBoardId || null), columnId: column ? column.id : null,
      labelIds: labelIds, newLabels: newLabels, priority: priority,
      dueDate: null, dueTime: null, startDate: null, startTime: null, repeat: null, someday: someday, parts: null
    };
    if (repeat) {
      var from = (date && date.date) || (deadline && deadline.date) || null;
      if (from && from > today) {
        var re2 = anchorFor(repeat.rrule, repeat.time, from);
        if (re2) repeat.anchor = re2;
      }
      out.repeat = repeat;
      out.dueDate = repeat.anchor;
      out.dueTime = repeat.time || (date && date.time) || null;
    } else if (deadline) {
      out.dueDate = deadline.date; out.dueTime = deadline.time;
      if (date) { out.startDate = date.date; out.startTime = date.time; }
    } else if (date) {
      out.dueDate = date.date; out.dueTime = date.time;
    }
    var keep = src.split('');
    parts.forEach(function (p) { for (var k = p.start; k < p.end; k++) keep[k] = ' '; });
    out.title = keep.join('').replace(/\s+/g, ' ').trim();
    parts.sort(function (a, b) { return a.start - b.start; });
    out.parts = parts;
    return out;
  }

  // Reads one date phrase ("tomorrow 3pm", "next Fri", "2026-11-20") → { date, time } or null.
  function parseDate(text, opts) {
    opts = opts || {};
    var exact = parseDayExact(text, opts);
    if (exact) return exact;
    var r = chronoAll(String(text || ''), opts)[0];
    return r ? { date: r.date, time: r.time } : null;
  }

  root.KzTasks = {
    parseQuickAdd: parseQuickAdd,
    parseRepeat: parseRepeat,
    describeRepeat: describeRepeat,
    nextOccurrence: nextOccurrence,
    occurrencesBetween: occurrencesBetween,
    completeCard: completeCard,
    uncompleteCard: uncompleteCard,
    skipOccurrence: skipOccurrence,
    endSeries: endSeries,
    isDone: isDone,
    doneColumn: doneColumn,
    smartView: smartView,
    validateRepeat: validateRepeat,
    validateTaskFields: validateTaskFields,
    // additions beyond the contract
    parseDate: parseDate,
    occurrenceInstant: occurrenceInstant,
    parseRRule: parseRRule,
    buildRRule: buildRRule
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

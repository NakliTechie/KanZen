/* KzInterop — iCalendar VTODO export, todo.txt import/export, Todoist CSV import, extra CSV columns.
   Contract: docs/specs/kanzen-tasks-contract-001.md (KzInterop). Pure functions, no DOM. */
(function(root){
  'use strict';

  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;

  function doneColumn(board){
    const cols = (board && board.columns) || [];
    return cols.find(c => c.done === true) || cols.find(c => /^(done|completed?|finished)$/i.test(String(c.name || '').trim())) || null;
  }
  function isCardDone(board, cardId, card){
    if(card && card.completedAt) return true;
    const col = doneColumn(board);
    return !!(col && (col.cardIds || []).includes(cardId));
  }
  // Cards in column order, then any card not placed in a column.
  function orderedCards(board){
    const seen = new Set(), out = [];
    const cards = board.cards || {};
    for(const col of board.columns || []) for(const id of col.cardIds || []){
      if(cards[id] && !seen.has(id)){ seen.add(id); out.push([id, cards[id], col]); }
    }
    for(const id of Object.keys(cards)) if(!seen.has(id)) out.push([id, cards[id], null]);
    return out;
  }
  function validDay(s){
    if(!DAY_RE.test(s || '')) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  function addDays(day, n){
    const [y, m, d] = day.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  /* ================= iCalendar ================= */

  function icsEscape(s){
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  }
  // Folds one content line at 75 octets (RFC 5545 §3.1); continuation lines start with one space.
  function foldLine(line){
    const enc = new TextEncoder();
    if(enc.encode(line).length <= 75) return line;
    const parts = [];
    let cur = '', curBytes = 0, limit = 75;
    for(const ch of line){
      const b = enc.encode(ch).length;
      if(curBytes + b > limit){ parts.push(cur); cur = ' '; curBytes = 1; limit = 75; }
      cur += ch; curBytes += b;
    }
    parts.push(cur);
    return parts.join('\r\n');
  }
  const icsDate = (day) => day.replace(/-/g, '');
  const icsDateTime = (day, time) => `${icsDate(day)}T${time.replace(':', '')}00`;
  function icsUtc(ms){
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }
  const ICS_PRIORITY = { urgent: 1, high: 3, medium: 5, low: 7 };

  // UNTIL is written as a DATE when DTSTART is a DATE, and as a floating end-of-day DATE-TIME otherwise,
  // because RFC 5545 requires UNTIL to share DTSTART's value type.
  function icsRrule(rrule, dateOnly){
    return String(rrule).replace(/^RRULE:/i, '').split(';').filter(Boolean).map(part => {
      const [k, v] = part.split('=');
      if(k.toUpperCase() !== 'UNTIL' || v == null) return part;
      const digits = v.replace(/[^0-9]/g, '').slice(0, 8);
      return `UNTIL=${dateOnly ? digits : digits + 'T235959'}`;
    }).join(';');
  }

  // RFC 5545 3.8.6.3: an absolute trigger MUST be UTC. opts.localToMs (KzReminders.localToMs bound to the zone)
  // turns the floating local moment into an instant; without it the trigger stays floating as a last resort.
  function absTrigger(day, time, offsetMin, opts){
    if(opts && typeof opts.localToMs === 'function'){
      const ms = opts.localToMs(`${day}T${time}`) - offsetMin * 60000;
      if(Number.isFinite(ms)) return `TRIGGER;VALUE=DATE-TIME:${icsUtc(ms)}`;
    }
    const [y, m, d] = day.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d, hh, mm) - offsetMin * 60000);
    return `TRIGGER;VALUE=DATE-TIME:${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00`;
  }

  function vtodoLines(board, cardId, card, opts){
    const L = [];
    const uid = (id) => `${id}@${board.id}.kanzen`;
    const hasRepeat = !!(card.repeat && card.repeat.rrule);
    let startDay = card.startDate || null, startTime = card.startTime || null;
    const dueDay = card.dueDate || null, dueTime = card.dueTime || null;
    if(!startDay && hasRepeat) { startDay = dueDay || card.repeat.anchor || null; startTime = startTime || dueTime; }
    // DTSTART and DUE must share a value type: a timed one makes the other timed (start 00:00, due 23:59).
    const timed = !!((startDay && startTime) || (dueDay && dueTime));
    L.push('BEGIN:VTODO');
    L.push(`UID:${uid(cardId)}`);
    L.push(`DTSTAMP:${icsUtc(opts.now)}`);
    L.push(`SUMMARY:${icsEscape(card.title || '')}`);
    if(card.description) L.push(`DESCRIPTION:${icsEscape(card.description)}`);
    if(startDay) L.push(timed ? `DTSTART:${icsDateTime(startDay, startTime || '00:00')}` : `DTSTART;VALUE=DATE:${icsDate(startDay)}`);
    if(dueDay) L.push(timed ? `DUE:${icsDateTime(dueDay, dueTime || '23:59')}` : `DUE;VALUE=DATE:${icsDate(dueDay)}`);
    if(hasRepeat){
      L.push(`RRULE:${icsRrule(card.repeat.rrule, !timed)}`);
      if(card.repeat.mode === 'afterCompletion') L.push('X-KANZEN-REPEAT-MODE:afterCompletion');
    }
    if(ICS_PRIORITY[card.priority]) L.push(`PRIORITY:${ICS_PRIORITY[card.priority]}`);
    L.push('STATUS:NEEDS-ACTION');
    const labels = (card.labelIds || []).map(id => (board.labels || []).find(x => x.id === id)).filter(Boolean).map(x => icsEscape(x.name));
    if(labels.length) L.push(`CATEGORIES:${labels.join(',')}`);
    if(card.parentId) L.push(`RELATED-TO;RELTYPE=PARENT:${uid(card.parentId)}`);
    for(const r of card.reminders || []){
      let trig = null;
      if(r.at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.at)){
        trig = absTrigger(r.at.slice(0, 10), r.at.slice(11), 0, opts);
      }else if(r.offsetMin != null && dueDay){
        const n = Math.round(Number(r.offsetMin));
        if(dueTime){
          // RELATED=END ties the trigger to DUE; the default (START) would tie it to DTSTART.
          trig = `TRIGGER;RELATED=END:${n >= 0 ? '-' : ''}PT${Math.abs(n)}M`;
        }else{
          // No due time: the due moment is 09:00 (F2), which the DATE-valued DUE cannot carry, so write it absolute.
          trig = absTrigger(dueDay, '09:00', n, opts);
        }
      }
      if(!trig) continue;
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(card.title || 'Reminder')}`, trig, 'END:VALARM');
    }
    L.push('END:VTODO');
    return L;
  }

  // One VTODO per open card with a due or start date. Floating times (no Z, no TZID).
  function toIcs(boards, opts){
    const o = opts || {};
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${o.prodId || '-//NakliTechie//KanZen//EN'}`, 'CALSCALE:GREGORIAN'];
    for(const board of boards || []){
      for(const [id, card] of orderedCards(board)){
        if(isCardDone(board, id, card)) continue;
        if(!card.dueDate && !card.startDate) continue;
        lines.push(...vtodoLines(board, id, card, { now: o.now, localToMs: o.localToMs }));
      }
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  /* ================= todo.txt ================= */

  const PRI_FROM_LETTER = (ch) => ch === 'A' ? 'urgent' : ch === 'B' ? 'high' : ch === 'C' ? 'medium' : 'low';
  const LETTER_FROM_PRI = { urgent: 'A', high: 'B', medium: 'C', low: 'D' };
  const REC_UNITS = { d: 'day', w: 'week', m: 'month', y: 'year' };

  // rec:[+]N(d|w|m|y|b) → an English phrase for parseRepeat; '+' means strict (fixed) mode.
  function recToPhrase(val){
    const m = /^(\+?)(\d+)([dwmyb])$/i.exec(val || '');
    if(!m) return null;
    const n = Number(m[2]), unit = m[3].toLowerCase();
    let phrase;
    if(unit === 'b') phrase = n === 1 ? 'every weekday' : null;
    else phrase = n === 1 ? `every ${REC_UNITS[unit]}` : `every ${n} ${REC_UNITS[unit]}s`;
    return phrase ? { phrase, mode: m[1] ? 'fixed' : 'afterCompletion' } : null;
  }
  function rruleToRec(repeat){
    if(!repeat || !repeat.rrule) return null;
    const parts = {};
    for(const p of repeat.rrule.split(';')){ const [k, v] = p.split('='); parts[k.toUpperCase()] = v; }
    const keys = Object.keys(parts).filter(k => k !== 'FREQ' && k !== 'INTERVAL');
    const unit = { DAILY: 'd', WEEKLY: 'w', MONTHLY: 'm', YEARLY: 'y' }[parts.FREQ];
    let rec = null;
    if(unit && !keys.length) rec = `${parts.INTERVAL || 1}${unit}`;
    else if(parts.FREQ === 'WEEKLY' && keys.length === 1 && parts.BYDAY === 'MO,TU,WE,TH,FR' && !parts.INTERVAL) rec = '1b';
    if(!rec) return null;
    return (repeat.mode === 'afterCompletion' ? '' : '+') + rec;
  }
  const KV_RE = /^([A-Za-z][\w-]*):(\S+)$/;

  // → { tasks, warnings }. Task: { title, description, priority, dueDate, startDate, done, completedAt,
  //   projects, contexts, repeat, createdDate, extras }. opts.parseRepeat maps rec: when given.
  function parseTodoTxt(text, opts){
    const o = opts || {};
    const tasks = [], warnings = [];
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    lines.forEach((raw, i) => {
      const lineNo = i + 1;
      let s = raw.trim();
      if(!s) return;
      const t = { title: '', description: '', priority: 'none', dueDate: null, startDate: null, done: false,
        completedAt: null, projects: [], contexts: [], repeat: null, createdDate: null, extras: {} };
      let m;
      if((m = /^x (\d{4}-\d{2}-\d{2} )?(\d{4}-\d{2}-\d{2} )?/.exec(s)) && s.startsWith('x ')){
        t.done = true;
        if(m[1]) t.completedAt = m[1].trim();
        if(m[2]) t.createdDate = m[2].trim();
        s = s.slice(m[0].length);
      }else{
        if((m = /^\(([A-Z])\) /.exec(s))){ t.priority = PRI_FROM_LETTER(m[1]); s = s.slice(m[0].length); }
        if((m = /^(\d{4}-\d{2}-\d{2}) /.exec(s))){ t.createdDate = m[1]; s = s.slice(m[0].length); }
      }
      const words = [];
      for(const w of s.split(/\s+/)){
        if(/^\+\S+$/.test(w)){ t.projects.push(w.slice(1)); continue; }
        if(/^@\S+$/.test(w)){ t.contexts.push(w.slice(1)); continue; }
        const kv = KV_RE.exec(w);
        if(kv && !kv[2].startsWith('//')){
          const key = kv[1].toLowerCase(), val = kv[2];
          if(key === 'due' || key === 't'){
            if(validDay(val)) t[key === 'due' ? 'dueDate' : 'startDate'] = val;
            else warnings.push(`line ${lineNo}: ${key}:${val} is not a YYYY-MM-DD date; ignored`);
            continue;
          }
          if(key === 'pri' && /^[A-Z]$/.test(val)){ t.priority = PRI_FROM_LETTER(val); continue; }
          if(key === 'rec'){
            const r = recToPhrase(val);
            const parsed = r && o.parseRepeat ? o.parseRepeat(r.phrase, { today: o.today, tz: o.tz }) : null;
            if(parsed && parsed.repeat) t.repeat = Object.assign({}, parsed.repeat, { mode: r.mode });
            else { t.extras.rec = val; warnings.push(`line ${lineNo}: rec:${val} not converted to a repeat`); }
            continue;
          }
          t.extras[key] = val;
          words.push(w);
          continue;
        }
        words.push(w);
      }
      t.title = words.join(' ').trim();
      // A repeat counts from the task's own date (DTSTART), not the import day, so a weekly rule keeps its weekday.
      if(t.repeat && (t.dueDate || t.startDate)) t.repeat.anchor = t.dueDate || t.startDate;
      if(!t.title) warnings.push(`line ${lineNo}: empty title`);
      tasks.push(t);
    });
    return { tasks, warnings };
  }

  const todoName = (s) => String(s || '').trim().replace(/\s+/g, '_');
  function dayOf(v, tz){
    if(v == null || v === '') return null;
    if(typeof v === 'string' && DAY_RE.test(v.slice(0, 10)) && v.length <= 10) return v;
    const ms = typeof v === 'number' ? v : Date.parse(v);
    if(!Number.isFinite(ms)) return null;
    if(!tz) return new Date(ms).toISOString().slice(0, 10);
    const p = {};
    for(const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}`;
  }

  // One line per card. Board → +project, labels → @context. Descriptions, times and checklists are not written.
  function toTodoTxt(boards, opts){
    const tz = opts && opts.tz;
    const out = [];
    for(const board of boards || []){
      for(const [id, card] of orderedCards(board)){
        const parts = [];
        const done = isCardDone(board, id, card);
        const created = dayOf(card.createdAt, tz);
        const letter = LETTER_FROM_PRI[card.priority];
        if(done){
          parts.push('x');
          const comp = dayOf(card.completedAt, tz);
          if(comp) parts.push(comp);
          if(comp && created) parts.push(created);
        }else{
          if(letter) parts.push(`(${letter})`);
          if(created) parts.push(created);
        }
        parts.push(String(card.title || '').replace(/\s+/g, ' ').trim());
        if(board.name) parts.push('+' + todoName(board.name));
        for(const lid of card.labelIds || []){
          const l = (board.labels || []).find(x => x.id === lid);
          if(l) parts.push('@' + todoName(l.name));
        }
        if(card.dueDate) parts.push(`due:${card.dueDate}`);
        if(card.startDate) parts.push(`t:${card.startDate}`);
        const rec = rruleToRec(card.repeat);
        if(rec) parts.push(`rec:${rec}`);
        if(done && letter) parts.push(`pri:${letter}`);
        out.push(parts.join(' '));
      }
    }
    return out.length ? out.join('\n') + '\n' : '';
  }

  /* ================= CSV and Todoist ================= */

  function detectDelimiter(text){
    let commas = 0, semis = 0, q = false;
    for(const ch of text){
      if(ch === '"') q = !q;
      else if(!q && (ch === '\n' || ch === '\r')) break;
      else if(!q && ch === ',') commas++;
      else if(!q && ch === ';') semis++;
    }
    return semis > commas ? ';' : ',';
  }
  // RFC 4180 reader: quoted fields may hold the delimiter, "" and newlines.
  function parseCsv(text, delim){
    const rows = [];
    let row = [], field = '', q = false, i = 0;
    const n = text.length;
    while(i < n){
      const ch = text[i];
      if(q){
        if(ch === '"'){ if(text[i + 1] === '"'){ field += '"'; i += 2; continue; } q = false; i++; continue; }
        field += ch; i++; continue;
      }
      if(ch === '"' && field === ''){ q = true; i++; continue; }
      if(ch === delim){ row.push(field); field = ''; i++; continue; }
      if(ch === '\r' || ch === '\n'){
        row.push(field); rows.push(row); row = []; field = '';
        if(ch === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += ch; i++;
    }
    if(field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function monthIndex(word){
    const w = word.toLowerCase().replace(/\.$/, '');
    const i = MONTHS.indexOf(w.slice(0, 3));
    if(i < 0) return -1;
    const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][i];
    return (w.length === 3 || (w === 'sept') || full.startsWith(w)) ? i : -1;
  }
  function parseClock(s){
    const m = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
    if(!m) return null;
    let h = Number(m[1]); const mi = Number(m[2] || 0);
    if(!m[2] && !m[3]) return null;
    if(m[3]){ if(h < 1 || h > 12) return null; h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0); }
    if(h > 23 || mi > 59) return null;
    return `${pad(h)}:${pad(mi)}`;
  }
  // Plain Todoist date text → { day, time } or null. ISO, today/tomorrow, "Nov 20 [2026]", "20 Nov [2026]",
  // with an optional time ("5pm", "17:30", "at 9:15 am"). A missing year takes the next such date on or after today.
  function parsePlainDate(text, today){
    let s = String(text || '').trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
    if(!s) return null;
    let m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if(m) return validDay(m[1]) ? { day: m[1], time: m[2] || null } : null;
    let time = null;
    const tm = /\s(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(' ' + s);
    if(tm){ const c = parseClock(tm[1]); if(c){ time = c; s = s.slice(0, s.length - tm[0].length + 1).trim(); } }
    if(/^today$/i.test(s) && today) return { day: today, time };
    if(/^(tomorrow|tmr)$/i.test(s) && today) return { day: addDays(today, 1), time };
    const w = s.split(' ');
    let mon = -1, dom = null, year = null;
    if(w.length >= 2 && w.length <= 3){
      if(monthIndex(w[0]) >= 0 && /^\d{1,2}(st|nd|rd|th)?$/i.test(w[1])){ mon = monthIndex(w[0]); dom = parseInt(w[1], 10); }
      else if(/^\d{1,2}(st|nd|rd|th)?$/i.test(w[0]) && monthIndex(w[1]) >= 0){ mon = monthIndex(w[1]); dom = parseInt(w[0], 10); }
      if(mon >= 0 && w.length === 3){ if(/^\d{4}$/.test(w[2])) year = Number(w[2]); else mon = -1; }
    }
    if(mon < 0) return null;
    if(year == null){
      if(!today) return null;
      year = Number(today.slice(0, 4));
      let day = `${year}-${pad(mon + 1)}-${pad(dom)}`;
      if(day < today) day = `${year + 1}-${pad(mon + 1)}-${pad(dom)}`;
      return validDay(day) ? { day, time } : null;
    }
    const day = `${year}-${pad(mon + 1)}-${pad(dom)}`;
    return validDay(day) ? { day, time } : null;
  }
  const RECURRING_RE = /^(every!?|ev!?|each|daily|weekly|monthly|yearly|annually|after)\b|\bevery!?\s/i;

  const TODOIST_PRIORITY = { 4: 'urgent', 3: 'high', 2: 'medium', 1: 'none' };

  // Todoist project CSV → { tasks, sections, warnings, lost }. Task ids are importIds (t1, t2 …);
  // parentId points at another task's importId. opts.parseRepeat maps recurring date strings.
  function parseTodoistCsv(text, opts){
    const o = opts || {};
    const src = String(text || '').replace(/^\uFEFF/, '');
    const delim = detectDelimiter(src);
    const rows = parseCsv(src, delim);
    const tasks = [], sections = [], warnings = [], lost = [
      'Completed tasks are not in a Todoist project CSV export.',
      'Recurrence start anchors ("starting …") are not in a Todoist CSV export; a repeat starts from the import day.'
    ];
    if(!rows.length) { warnings.push('empty file'); return { tasks, sections, warnings, lost, delimiter: delim }; }
    const header = rows[0].map(h => h.trim().toUpperCase());
    const col = (name) => header.indexOf(name);
    for(const need of ['TYPE', 'CONTENT']) if(col(need) < 0){ warnings.push(`missing ${need} column`); return { tasks, sections, warnings, lost, delimiter: delim }; }
    const raw = (row, name) => { const i = col(name); return i < 0 ? '' : (row[i] || ''); };
    const get = (row, name) => raw(row, name).trim();
    let section = null, prevTask = null, seq = 0;
    const stack = []; // stack[i] = last task seen at indent i+1
    for(let r = 1; r < rows.length; r++){
      const row = rows[r];
      if(row.every(c => !String(c).trim())) continue;
      const type = get(row, 'TYPE').toLowerCase();
      const content = raw(row, 'CONTENT');
      if(type === 'section'){
        section = { name: content.trim(), order: sections.length };
        sections.push(section);
        stack.length = 0; prevTask = null;
        continue;
      }
      if(type === 'note'){
        if(prevTask){
          prevTask.comments.push({ text: content, author: get(row, 'AUTHOR') || null, date: get(row, 'DATE') || null });
        }else{
          lost.push(`row ${r + 1}: a project-level note has no task to attach to: ${content.slice(0, 60)}`);
        }
        continue;
      }
      if(type !== 'task'){ warnings.push(`row ${r + 1}: unknown TYPE "${type}" skipped`); continue; }

      let title = content.trim();
      const labels = [];
      title = title.replace(/(^|\s)@([^\s@]+)/g, (all, sp, name) => { labels.push(name); return sp; }).replace(/\s+/g, ' ').trim();
      const t = { importId: `t${++seq}`, title, description: raw(row, 'DESCRIPTION').trim(),
        priority: TODOIST_PRIORITY[Number(get(row, 'PRIORITY'))] || 'none', dueDate: null, dueTime: null, startDate: null,
        startTime: null, done: false, completedAt: null, projects: [], contexts: labels, repeat: null,
        section: section ? section.name : null, parentId: null, comments: [], assignee: get(row, 'RESPONSIBLE') || null,
        estimateMin: null };

      // Nesting: one level is kept; deeper tasks attach to their top-level ancestor.
      const indent = Math.max(1, parseInt(get(row, 'INDENT'), 10) || 1);
      stack.length = Math.min(stack.length, indent - 1);
      if(indent > 1){
        let parent = null;
        for(let d = Math.min(indent - 2, stack.length - 1); d >= 0; d--) if(stack[d]){ parent = stack[d]; break; }
        if(parent){
          let top = parent;
          while(top.parentId) top = tasks.find(x => x.importId === top.parentId) || top;
          if(top !== parent) lost.push(`row ${r + 1}: "${t.title}" was nested ${indent - 1} levels deep; flattened to one level under "${top.title}"`);
          t.parentId = top.importId;
        }else warnings.push(`row ${r + 1}: INDENT ${indent} with no parent; kept at top level`);
      }
      stack[indent - 1] = t;

      const dateText = get(row, 'DATE');
      const deadlineText = get(row, 'DEADLINE');
      let plain = null, deadline = null;
      if(dateText){
        if(RECURRING_RE.test(dateText)){
          const parsed = o.parseRepeat ? o.parseRepeat(dateText.replace(/^(every|ev)!/i, '$1'), { today: o.today, tz: o.tz }) : null;
          if(parsed && parsed.repeat){
            t.repeat = Object.assign({}, parsed.repeat);
            if(/^(every|ev)!/i.test(dateText)) t.repeat.mode = 'afterCompletion';
            if(t.repeat.anchor) plain = { day: t.repeat.anchor, time: t.repeat.time || null };
          }else{
            t.description = (t.description ? t.description + '\n\n' : '') + `Todoist date: ${dateText}`;
            lost.push(`row ${r + 1}: repeat "${dateText}" not understood; kept in the description`);
          }
        }else{
          plain = parsePlainDate(dateText, o.today);
          if(!plain){
            t.description = (t.description ? t.description + '\n\n' : '') + `Todoist date: ${dateText}`;
            lost.push(`row ${r + 1}: date "${dateText}" not understood; kept in the description`);
          }
        }
      }
      if(deadlineText){
        deadline = parsePlainDate(deadlineText, o.today);
        if(!deadline){
          t.description = (t.description ? t.description + '\n\n' : '') + `Todoist deadline: ${deadlineText}`;
          lost.push(`row ${r + 1}: deadline "${deadlineText}" not understood; kept in the description`);
        }
      }
      // Same rule as quick-add: with a deadline, the plain date becomes the start date.
      if(deadline){
        t.dueDate = deadline.day; t.dueTime = deadline.time;
        if(plain){ t.startDate = plain.day; t.startTime = plain.time; }
      }else if(plain){ t.dueDate = plain.day; t.dueTime = plain.time; }

      const tzText = get(row, 'TIMEZONE');
      if(tzText && o.tz && tzText !== o.tz && (t.dueTime || t.startTime)) warnings.push(`row ${r + 1}: times kept as wall clock; Todoist zone ${tzText} differs from ${o.tz}`);
      const dur = parseInt(get(row, 'DURATION'), 10);
      if(Number.isFinite(dur) && dur > 0){
        const unit = get(row, 'DURATION_UNIT').toLowerCase();
        t.estimateMin = unit.startsWith('day') ? dur * 1440 : dur;
      }
      tasks.push(t);
      prevTask = t;
    }
    if(tasks.some(t => t.assignee)) lost.push('Assignees are names in Todoist; kept as text in assignee, not linked to board members.');
    return { tasks, sections, warnings, lost, delimiter: delim };
  }

  /* ================= extra CSV columns (X8) ================= */

  const csvExtraColumns = ['start date', 'start time', 'due time', 'repeat', 'completed at', 'someday', 'parent'];
  // Values for csvExtraColumns. board (optional) resolves the parent's title; opts.describeRepeat (optional)
  // writes the repeat in words, else the RRULE body is written.
  function csvExtraValues(card, board, opts){
    const c = card || {};
    let repeat = '';
    if(c.repeat && c.repeat.rrule){
      repeat = opts && opts.describeRepeat ? opts.describeRepeat(c.repeat) : c.repeat.rrule + (c.repeat.mode === 'afterCompletion' ? ' (after completion)' : '');
    }
    let parent = '';
    if(c.parentId){
      const p = board && board.cards && board.cards[c.parentId];
      parent = p ? (p.title || c.parentId) : c.parentId;
    }
    return [c.startDate || '', c.startTime || '', c.dueTime || '', repeat, c.completedAt || '', c.someday ? 'yes' : '', parent];
  }

  root.KzInterop = {
    toIcs, parseTodoTxt, toTodoTxt, parseTodoistCsv, csvExtraColumns, csvExtraValues,
    icsEscape, foldLine, parseCsv, detectDelimiter, parsePlainDate
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

// Sojuli Digital — static file server + board storage.
//
// Exists so project-plan-dashboard.html can read AND write its boards.
// Opening the dashboard straight off disk (file://) blocks the read, which is
// what let the dashboard drift out of sync with the ledger before 2026-08-07.
// Node built-ins only, no install step.
//
// Every board is one JSON file in boards/, listed in boards/index.json.
//
//   GET    /                      -> the dashboard
//   GET    /api/boards            -> the list of boards, in tab order
//   POST   /api/boards            -> create a board from a full plan
//   GET    /api/boards/<id>       -> one board, never cached, with its ETag
//   POST   /api/boards/<id>       -> validate, back up, then overwrite that board
//   DELETE /api/boards/<id>       -> move that board to boards/deleted/
//
// On first start every file in seeds/ becomes a board, in file-name order. An
// existing tasks.json, if there is one, is COPIED in after them. Neither the
// seeds nor tasks.json is ever written.
//
// Every write takes a timestamped backup first. A malformed payload is
// rejected before anything touches disk. This file is the only thing standing
// between a bad save and the ledger, so it validates hard and fails loudly.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SEED_LEDGER = path.join(ROOT, 'tasks.json');      // read once, at migration. Never written.
const SEEDS_DIR = path.join(ROOT, 'seeds');            // starting boards, one file each, in tab order. Never written.
const BOARDS_DIR = path.join(ROOT, 'boards');
const INDEX = path.join(BOARDS_DIR, 'index.json');
const DELETED_DIR = path.join(BOARDS_DIR, 'deleted');
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_BOARDS = 50;
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 5 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf'
};

const REQUIRED_TASK_FIELDS = ['id', 'key', 'title', 'section', 'start', 'due'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Z]{2,6}-\d+$/;
const COL_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/* Columns used to be hardcoded here and in the board, and the two had to be
   kept 1:1 by hand. They now come from plan.settings so the Settings page can
   rename, add, reorder and remove them without a code change. A ledger written
   before 2026-08-27 has no settings block, so the original five stay as the
   fallback — an old backup must still restore cleanly. */
const LEGACY_COLUMNS = [
  { key: 'needs-reconciliation', label: 'Needs Decision',  dot: '#C62828' },
  { key: 'not-started',          label: 'Not Started',     dot: '#9A9A98' },
  { key: 'in-progress',          label: 'In Progress',     dot: '#FF8200' },
  { key: 'ready-for-testing',    label: 'Ready to Verify', dot: '#1565C0' },
  { key: 'done',                 label: 'Done',            dot: '#2E7D32' }
];
const LEGACY_DONE = 'done';
const LEGACY_DEFAULT = 'not-started';

function columnsOf(plan) {
  const s = plan && plan.settings;
  return (s && Array.isArray(s.columns) && s.columns.length) ? s.columns : LEGACY_COLUMNS;
}
function statusKeysOf(plan) { return columnsOf(plan).map(c => c && c.key); }
function doneKeyOf(plan) {
  const s = plan && plan.settings;
  return (s && s.doneKey) || LEGACY_DONE;
}

/* The settings block decides what a valid status IS, so a malformed one would
   let every task through unchecked. Validate it before the tasks, and refuse
   the whole save if it is broken. */
function validateSettings(plan, errs) {
  const s = plan.settings;
  if (s === undefined) return;                      // pre-settings ledger, legacy columns apply
  if (!s || typeof s !== 'object' || Array.isArray(s)) { errs.push('settings is not an object'); return; }
  if (!Array.isArray(s.columns)) { errs.push('settings.columns is not an array'); return; }
  if (s.columns.length < 2) errs.push('settings.columns needs at least two columns');
  if (s.columns.length > 12) errs.push('settings.columns is capped at 12 columns');

  const seen = new Set();
  s.columns.forEach((c, i) => {
    const where = 'settings.columns[' + i + ']';
    if (!c || typeof c !== 'object') { errs.push(where + ' is not an object'); return; }
    if (!c.key || !COL_KEY_RE.test(c.key)) errs.push(where + ' has a malformed key: ' + c.key);
    if (seen.has(c.key)) errs.push('duplicate column key: ' + c.key);
    seen.add(c.key);
    if (!c.label || !String(c.label).trim()) errs.push(where + ' has no label');
    if (String(c.label || '').length > 30) errs.push(where + ' label is longer than 30 characters');
    if (c.dot && !HEX_RE.test(c.dot)) errs.push(where + ' has a bad colour: ' + c.dot);
  });
  if (errs.length) return;

  // A board with no terminal column could never record a task as done.
  if (!s.doneKey || !seen.has(s.doneKey)) errs.push('settings.doneKey must name one of the columns');
  if (!s.defaultKey || !seen.has(s.defaultKey)) errs.push('settings.defaultKey must name one of the columns');
  // Optional: older settings blocks predate backlog promotion.
  if (s.intakeKey !== undefined && s.intakeKey !== null && !seen.has(s.intakeKey)) {
    errs.push('settings.intakeKey must name one of the columns');
  }
  // failFrom/failTo are optional as a pair. Half a pair disables the action silently.
  if (s.failFrom || s.failTo) {
    if (!seen.has(s.failFrom)) errs.push('settings.failFrom must name one of the columns');
    if (!seen.has(s.failTo)) errs.push('settings.failTo must name one of the columns');
  }

  /* The real danger. Deleting a column whose tasks were never moved would leave
     those tasks pointing at a status the board cannot render, and they would
     silently pile into the default column on the next load. */
  const stranded = [...new Set((plan.tasks || [])
    .map(t => t && t.status).filter(st => st && !seen.has(st)))];
  if (stranded.length) {
    errs.push('these statuses still have tasks but no column: ' + stranded.join(', ')
      + '. Reassign those tasks before removing the column.');
  }
}

// Reject anything that would corrupt the ledger. Returns an array of problems.
function validate(plan) {
  const errs = [];
  if (!plan || typeof plan !== 'object') return ['payload is not an object'];
  if (!Array.isArray(plan.tasks)) errs.push('tasks is not an array');
  if (!Array.isArray(plan.sections)) errs.push('sections is not an array');
  if (!Array.isArray(plan.backlog)) errs.push('backlog is not an array');
  if (!Array.isArray(plan.rules)) errs.push('rules is not an array');
  if (errs.length) return errs;

  validateSettings(plan, errs);
  if (errs.length) return errs;          // bad columns make every status check meaningless

  const VALID_STATUS = statusKeysOf(plan);
  const DONE = doneKeyOf(plan);

  if (plan.tasks.length === 0) errs.push('refusing to write an empty task list');

  const seen = new Set(), seenKeys = new Set();
  plan.tasks.forEach((t, i) => {
    const where = 'task[' + i + ']' + (t && t.key ? ' (' + t.key + ')' : t && t.id ? ' (' + t.id + ')' : '');
    REQUIRED_TASK_FIELDS.forEach(f => {
      if (!t || !t[f]) errs.push(where + ' is missing ' + f);
    });
    if (!t) return;
    if (seen.has(t.id)) errs.push('duplicate task id: ' + t.id);
    seen.add(t.id);
    if (t.key) {
      if (!KEY_RE.test(t.key)) errs.push(where + ' has a malformed ticket key: ' + t.key);
      if (seenKeys.has(t.key)) errs.push('duplicate ticket key: ' + t.key);
      seenKeys.add(t.key);
    }
    if (t.status && VALID_STATUS.indexOf(t.status) === -1) {
      errs.push(where + ' has an unknown status: ' + t.status);
    }
    if (t.status === DONE && !t.done) errs.push(where + ' is status ' + DONE + ' with no done date');
    if (t.done && t.status && t.status !== DONE) errs.push(where + ' has a done date but status ' + t.status);
    ['start', 'due'].forEach(f => {
      if (t[f] && !DATE_RE.test(t[f])) errs.push(where + ' has a bad ' + f + ': ' + t[f]);
    });
    if (t.done && !DATE_RE.test(t.done)) errs.push(where + ' has a bad done date: ' + t.done);
    if (t.start && t.due && t.due < t.start) errs.push(where + ' is due before it starts');
    if (t.acceptanceCriteria && !Array.isArray(t.acceptanceCriteria)) {
      errs.push(where + ' acceptanceCriteria is not an array');
    }
    if (t.history !== undefined) {
      if (!Array.isArray(t.history)) {
        errs.push(where + ' history is not an array');
      } else {
        // The activity log is the audit trail for failed verifications.
        // A malformed entry would silently lose why a ticket was sent back.
        t.history.forEach((h, hi) => {
          if (!h || typeof h !== 'object') { errs.push(where + ' history[' + hi + '] is not an object'); return; }
          if (!h.at || !DATE_RE.test(h.at)) errs.push(where + ' history[' + hi + '] has a bad date: ' + h.at);
          if (h.fail && !String(h.note || '').trim()) {
            errs.push(where + ' history[' + hi + '] is a failure with no reason recorded');
          }
        });
      }
    }
    if (t.section && plan.sections.indexOf(t.section) === -1) {
      errs.push(where + ' has an unknown section: ' + t.section);
    }
    // Epics are containers. A ticket that is both an epic and a milestone, or an
    // epic nested in another epic, would be counted wrong by the pace maths and
    // render as a dead tag on the board.
    if (t.epic && t.milestone) errs.push(where + ' is both an epic and a milestone');
    if (t.epic && t.epicKey) errs.push(where + ' is an epic and also inside epic ' + t.epicKey);
    if (t.epicKey !== undefined && t.epicKey !== null && typeof t.epicKey !== 'string') {
      errs.push(where + ' has a malformed epicKey');
    }
  });

  /* Backlog items carry ticket keys from the same sequence as tasks, so a
     promoted item keeps its number. That only holds if the two lists can never
     issue the same key — check them together, not separately. Bare strings are
     the pre-2026-08-27 shape and still validate, so old backups restore. */
  plan.backlog.forEach((b, i) => {
    const where = 'backlog[' + i + ']';
    if (typeof b === 'string') return;
    if (!b || typeof b !== 'object' || Array.isArray(b)) { errs.push(where + ' is neither text nor an item'); return; }
    if (!b.key || !KEY_RE.test(b.key)) {
      errs.push(where + ' has a malformed ticket key: ' + b.key);
    } else if (seenKeys.has(b.key)) {
      errs.push('duplicate ticket key: ' + b.key + ' — the board and the backlog cannot share a number');
    } else {
      seenKeys.add(b.key);
    }
    if (!String(b.text == null ? '' : b.text).trim()) errs.push(where + ' has no text');
    /* A demoted ticket parks its whole former self here so a round trip does
       not destroy the criteria and the activity log. It is not a live task, so
       it is not status-checked — but it must be an object, and it must not
       claim a different number than the item holding it. */
    if (b.parked !== undefined) {
      if (!b.parked || typeof b.parked !== 'object' || Array.isArray(b.parked)) {
        errs.push(where + ' has a malformed parked ticket');
      } else if (b.parked.key && b.parked.key !== b.key) {
        errs.push(where + ' parks ' + b.parked.key + ' under ' + b.key);
      }
    }
  });

  // Resolve epic links only after every task has been seen, so order does not matter.
  const epicKeys = new Set(plan.tasks.filter(t => t && t.epic && t.key).map(t => t.key));
  plan.tasks.forEach((t, i) => {
    if (!t || !t.epicKey) return;
    const where = 'task[' + i + ']' + (t.key ? ' (' + t.key + ')' : '');
    if (!epicKeys.has(t.epicKey)) errs.push(where + ' points at epic ' + t.epicKey + ', which is not an epic in this plan');
  });
  return errs;
}

/* Autosave (added 2026-08-08) writes on every board mutation, so the per-save
   backup that was fine for a once-a-day manual click would now bury the board
   folder. Keep the newest KEEP_BACKUPS autosave copies per board and drop the
   rest. Named backups made by hand (<id>.json.bak-<date>-pre-something) do not
   match and are never touched. */
const KEEP_BACKUPS = 25;
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function pruneAutosaveBackups(file) {
  try {
    const dir = path.dirname(file), base = path.basename(file);
    const re = new RegExp('^' + escRe(base) + '\\.bak-.*-autosave$');
    const all = fs.readdirSync(dir).filter(f => re.test(f)).sort();
    // Autosave writes on every edit, so a flat window of 25 can be burned
    // through in minutes and take the last good pre-mistake copy with it.
    // The earliest backup of each calendar day is kept permanently.
    const seenDays = new Set();
    const keepForever = new Set();
    all.forEach(f => {
      const day = (f.match(/bak-(\d{4}-\d{2}-\d{2})T/) || [])[1];
      if (day && !seenDays.has(day)) { seenDays.add(day); keepForever.add(f); }
    });
    const recent = new Set(all.slice(-KEEP_BACKUPS));
    all.filter(f => !recent.has(f) && !keepForever.has(f))
       .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
  } catch (e) { /* pruning must never break a save */ }
}

/* Optimistic concurrency, added 2026-08-08.
   The save used to be a blind whole-file overwrite. Anything that edited a
   board file outside the browser — Claude, an editor, a second tab — was wiped
   by the next save with no warning. Every save now has to name the revision it
   was built on, and a save built on a stale one is refused rather than applied.
   The token is the file's mtime plus size, so an external edit changes it
   without needing a field inside the JSON. */
function revOf(file) {
  try {
    const st = fs.statSync(file);
    return '"' + st.mtimeMs + '-' + st.size + '"';
  } catch (e) {
    return '"none"';
  }
}

/* Write to a temp file and rename, so a crash mid-write cannot truncate the
   target. Same lesson as the 2026-08-03 database truncation. Unique temp name:
   two tabs autosaving at once would otherwise interleave writes into one shared
   .tmp file and rename a half file over the board. */
function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);            // get the bytes on disk BEFORE the rename
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeLedger(file, plan) {
  /* Second-granularity stamps were not unique enough. On 2026-08-09 two autosaves
     landed inside the same second, so the second backup overwrote the first and
     took the only pre-write copy of the previous ledger with it. Milliseconds,
     plus a collision guard, so a backup can never overwrite another backup. */
  const dir = path.dirname(file), base = path.basename(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  let backup = base + '.bak-' + stamp + '-autosave';
  for (let n = 2; fs.existsSync(path.join(dir, backup)); n++) {
    backup = base + '.bak-' + stamp + '-' + n + '-autosave';
  }
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(dir, backup));
    pruneAutosaveBackups(file);
  }
  atomicWrite(file, JSON.stringify(plan, null, 2));
  return backup;
}

/* ---------- the board index ----------
   One list, in tab order: [{ id, name }]. The id names the file and never
   changes, so a rename can never orphan a board or its backups. */
function slugify(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return s || 'board';
}
function readIndex() {
  try {
    const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    if (idx && Array.isArray(idx.boards)) {
      idx.boards = idx.boards.filter(b => b && ID_RE.test(String(b.id)) && fs.existsSync(path.join(BOARDS_DIR, b.id + '.json')));
      return idx;
    }
  } catch (e) {}
  return null;
}
function writeIndex(idx) { atomicWrite(INDEX, JSON.stringify({ version: 1, boards: idx.boards }, null, 2)); }
function boardFile(id) { return path.join(BOARDS_DIR, id + '.json'); }
function uniqueId(name, idx) {
  const taken = new Set(idx.boards.map(b => b.id));
  const base = slugify(name);
  let id = base;
  for (let n = 2; taken.has(id) || fs.existsSync(boardFile(id)); n++) id = base.slice(0, 36) + '-' + n;
  return id;
}

/* First start, or a folder from before boards existed. Copies tasks.json in as
   the first board and leaves the original alone. If boards/ already holds board
   files but the index is lost, the index is rebuilt from the files rather than
   pretending the boards are gone. */
function ensureBoards() {
  if (!fs.existsSync(BOARDS_DIR)) fs.mkdirSync(BOARDS_DIR, { recursive: true });
  let idx = readIndex();
  if (idx && idx.boards.length) return idx;

  idx = { version: 1, boards: [] };
  fs.readdirSync(BOARDS_DIR).filter(f => /^[a-z0-9]+(-[a-z0-9]+)*\.json$/.test(f) && f !== 'index.json').sort().forEach(f => {
    const id = f.slice(0, -5);
    let name = id;
    try { name = JSON.parse(fs.readFileSync(path.join(BOARDS_DIR, f), 'utf8')).project || id; } catch (e) {}
    idx.boards.push({ id, name: String(name) });
  });
  if (idx.boards.length) { writeIndex(idx); console.log('rebuilt boards/index.json from ' + idx.boards.length + ' board file(s)'); return idx; }

  /* Starting boards ship in seeds/, one file per board, named so file order is
     tab order (01-..., 02-...). A seed that will not parse is skipped and named
     in the log rather than stopping the others. */
  if (fs.existsSync(SEEDS_DIR)) {
    fs.readdirSync(SEEDS_DIR).filter(f => f.endsWith('.json')).sort().forEach(f => {
      let plan = null;
      try { plan = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8')); } catch (e) {
        console.log('seeds/' + f + ' is not valid JSON, so it was skipped: ' + e.message); return;
      }
      if (!plan || !Array.isArray(plan.tasks)) { console.log('seeds/' + f + ' has no task list, so it was skipped'); return; }
      const id = uniqueId(plan.project, idx);
      atomicWrite(boardFile(id), JSON.stringify(plan, null, 2));
      idx.boards.push({ id, name: String(plan.project || id) });
      console.log('created board "' + id + '" from seeds/' + f);
    });
  }

  if (fs.existsSync(SEED_LEDGER)) {
    let plan = null;
    try { plan = JSON.parse(fs.readFileSync(SEED_LEDGER, 'utf8')); } catch (e) {
      console.log('tasks.json is not valid JSON, so it was not copied in: ' + e.message);
    }
    if (plan && Array.isArray(plan.tasks)) {
      const id = uniqueId(plan.project, idx);
      atomicWrite(boardFile(id), JSON.stringify(plan, null, 2));
      idx.boards.push({ id, name: String(plan.project || id) });
      console.log('copied tasks.json in as board "' + id + '". The original tasks.json is untouched.');
    }
  }
  writeIndex(idx);           // the seeded boards, or an empty list the board fills with a first board
  return idx;
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, res, cb) {
  let body = '', tooBig = false;
  req.on('data', c => {
    body += c;
    if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return sendJSON(res, 413, { ok: false, errors: ['payload too large'] });
    let plan;
    try { plan = JSON.parse(body); }
    catch (e) { return sendJSON(res, 400, { ok: false, errors: ['invalid JSON: ' + e.message] }); }
    cb(plan);
  });
}

function saveBoard(req, res, id) {
  const file = boardFile(id);
  readBody(req, res, plan => {
    // Precondition. A client that cannot name its base revision is not
    // allowed to overwrite the board.
    const sent = req.headers['if-match'];
    const current = revOf(file);
    if (!sent) {
      return sendJSON(res, 428, { ok: false, rev: current,
        errors: ['If-Match header required. Reload the board so it knows which revision it is editing.'] });
    }
    if (sent !== current) {
      console.log('CONFLICT refused a stale save to ' + id + '. client had ' + sent + ', disk is ' + current);
      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
      return sendJSON(res, 409, { ok: false, conflict: true, rev: current, plan: disk,
        errors: ['This board changed since it was loaded. Nothing was overwritten.'] });
    }
    const errs = validate(plan);
    if (errs.length) {
      console.log('REJECTED save to ' + id + ' — ' + errs.length + ' problem(s):');
      errs.forEach(e => console.log('  ' + e));
      return sendJSON(res, 422, { ok: false, errors: errs });
    }
    plan.updated = new Date().toISOString().slice(0, 10);
    try {
      const backup = writeLedger(file, plan);
      // The tab label is the board name. Keep the index in step with a rename.
      const idx = readIndex() || { boards: [] };
      const entry = idx.boards.find(b => b.id === id);
      const name = String(plan.project || id);
      if (entry && entry.name !== name) { entry.name = name; writeIndex(idx); }
      console.log('saved ' + id + ' (' + plan.tasks.length + ' tasks), backup ' + backup);
      sendJSON(res, 200, { ok: true, updated: plan.updated, backup: backup,
                           tasks: plan.tasks.length, rev: revOf(file) });
    } catch (e) {
      console.log('WRITE FAILED: ' + e.message);
      sendJSON(res, 500, { ok: false, errors: ['write failed: ' + e.message] });
    }
  });
}

function createBoard(req, res) {
  readBody(req, res, plan => {
    const idx = readIndex() || { version: 1, boards: [] };
    if (idx.boards.length >= MAX_BOARDS) return sendJSON(res, 422, { ok: false, errors: ['a folder holds at most ' + MAX_BOARDS + ' boards'] });
    if (!plan || typeof plan !== 'object' || !String(plan.project || '').trim()) {
      return sendJSON(res, 422, { ok: false, errors: ['a new board needs a name'] });
    }
    const errs = validate(plan);
    if (errs.length) return sendJSON(res, 422, { ok: false, errors: errs });
    const id = uniqueId(plan.project, idx);
    plan.updated = new Date().toISOString().slice(0, 10);
    try {
      atomicWrite(boardFile(id), JSON.stringify(plan, null, 2));
      idx.boards.push({ id, name: String(plan.project) });
      writeIndex(idx);
      console.log('created board ' + id);
      sendJSON(res, 201, { ok: true, id, name: String(plan.project), boards: idx.boards, rev: revOf(boardFile(id)) });
    } catch (e) {
      sendJSON(res, 500, { ok: false, errors: ['write failed: ' + e.message] });
    }
  });
}

/* Delete is a move, never an unlink. The file goes to boards/deleted/ with a
   timestamp so a mistaken click is one file copy away from undone. */
function deleteBoard(res, id) {
  const idx = readIndex() || { boards: [] };
  if (!idx.boards.some(b => b.id === id)) return sendJSON(res, 404, { ok: false, errors: ['no board named ' + id] });
  if (idx.boards.length <= 1) return sendJSON(res, 422, { ok: false, errors: ['the last board cannot be deleted'] });
  try {
    if (!fs.existsSync(DELETED_DIR)) fs.mkdirSync(DELETED_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const dest = path.join(DELETED_DIR, id + '-' + stamp + '.json');
    fs.renameSync(boardFile(id), dest);
    idx.boards = idx.boards.filter(b => b.id !== id);
    writeIndex(idx);
    console.log('deleted board ' + id + ', kept at boards/deleted/' + path.basename(dest));
    sendJSON(res, 200, { ok: true, boards: idx.boards, keptAs: 'boards/deleted/' + path.basename(dest) });
  } catch (e) {
    sendJSON(res, 500, { ok: false, errors: ['delete failed: ' + e.message] });
  }
}

ensureBoards();

http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/boards') {
    if (req.method === 'GET') return sendJSON(res, 200, { ok: true, boards: (readIndex() || { boards: [] }).boards });
    if (req.method === 'POST') return createBoard(req, res);
    return sendJSON(res, 405, { ok: false, errors: ['method not allowed'] });
  }

  const m = url.match(/^\/api\/boards\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) return sendJSON(res, 400, { ok: false, errors: ['bad board id'] });
    const known = (readIndex() || { boards: [] }).boards.some(b => b.id === id);
    if (!known) return sendJSON(res, 404, { ok: false, errors: ['no board named ' + id] });
    if (req.method === 'GET') {
      fs.readFile(boardFile(id), (err, buf) => {
        if (err) return sendJSON(res, 404, { ok: false, errors: ['no board named ' + id] });
        // The board sends this back as If-Match on every save.
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                             'Cache-Control': 'no-store, no-cache, must-revalidate', 'ETag': revOf(boardFile(id)) });
        res.end(buf);
      });
      return;
    }
    if (req.method === 'POST') return saveBoard(req, res, id);
    if (req.method === 'DELETE') return deleteBoard(res, id);
    return sendJSON(res, 405, { ok: false, errors: ['method not allowed'] });
  }

  // The single-ledger endpoint is gone. An old tab open across the upgrade gets
  // told plainly instead of writing into a file nothing reads any more.
  if (url === '/api/tasks') {
    return sendJSON(res, 410, { ok: false, errors: ['This folder now keeps boards in boards/. Reload the page.'] });
  }

  if (req.method !== 'GET') {
    return sendJSON(res, 405, { ok: false, errors: ['method not allowed'] });
  }

  let rel = decodeURIComponent(url);
  if (rel === '/') rel = '/project-plan-dashboard.html';

  // Keep the server inside the project folder.
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }).end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  const n = (readIndex() || { boards: [] }).boards.length;
  console.log('Sojuli Digital');
  console.log('  http://localhost:' + PORT + '/project-plan-dashboard.html');
  console.log('  serving ' + ROOT);
  console.log('  ' + n + ' board(s) in boards/, backup taken before every save');
  console.log('  Ctrl+C to stop');
});

/* Tests for serve-dashboard.js, the only thing allowed to write a board file.
 *
 * The backup pruner shipped broken on 2026-08-08: it compared a day key against
 * a set of "day|filename" strings, so the "keep one per day" rule matched
 * nothing and every backup was kept forever. Silent, and the opposite of the
 * intent. These tests spawn the real server and check the real filesystem.
 *
 * Run: node dashboard-server.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');
const { spawn } = require('child_process');
const { fixture, MOVABLE, MOVABLE_ID, EPIC } = require('./dashboard-test-fixture.js');

const ROOT = __dirname;
const KEEP = 25;                       // must match KEEP_BACKUPS in serve-dashboard.js
const wait = ms => new Promise(r => setTimeout(r, ms));

async function sandbox(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmsrv-'));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(fixture(), null, 2));
  fs.copyFileSync(path.join(ROOT, 'serve-dashboard.js'), path.join(dir, 'serve-dashboard.js'));
  const port = 8300 + Math.floor(Math.random() * 400);
  const srv = spawn(process.execPath, ['serve-dashboard.js'], { cwd: dir, env: { ...process.env, PORT: String(port) } });
  await wait(1300);
  const rev = async () => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/boards/fixture-project');
    return res.headers.get('etag');
  };
  const post = async (opts = {}) => {
    const body = opts.body !== undefined ? opts.body : fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8');
    const headers = { 'Content-Type': 'application/json' };
    const ifMatch = opts.ifMatch !== undefined ? opts.ifMatch : await rev();
    if (ifMatch !== null) headers['If-Match'] = ifMatch;
    const res = await fetch('http://127.0.0.1:' + port + '/api/boards/fixture-project', { method: 'POST', headers, body });
    return Object.assign(await res.json(), { _status: res.status });
  };
  try { await fn({ dir, port, post, rev, ls: () => fs.readdirSync(path.join(dir, 'boards')) }); }
  finally { srv.kill(); }
}

test('a POST actually lands on disk, backed up first', async () => {
  await sandbox(async ({ dir, post, ls }) => {
    const out = await post();
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(ls().some(f => f === out.backup), 'the named backup must exist');
    JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));   // still valid JSON
  });
});

test('garbage is rejected and the ledger is left alone', async () => {
  await sandbox(async ({ dir, post }) => {
    const before = fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8');
    const out = await post({ body: '{"tasks":"nope"}' });
    assert.equal(out.ok, false);
    assert.ok(out.errors.length > 0);
    assert.equal(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'), before, 'a rejected save must not touch the file');
  });
});

test('pruning caps the window but keeps the first backup of every day', async () => {
  await sandbox(async ({ dir, post, ls }) => {
    for (let i = 1; i <= 40; i++) fs.writeFileSync(path.join(dir, 'boards', 'fixture-project.json.bak-2026-08-05T00-00-' + String(i).padStart(2,'0') + '-autosave'), 'x');
    for (let i = 1; i <= 10; i++) fs.writeFileSync(path.join(dir, 'boards', 'fixture-project.json.bak-2026-08-06T00-00-' + String(i).padStart(2,'0') + '-autosave'), 'x');
    fs.writeFileSync(path.join(dir, 'boards', 'fixture-project.json.bak-2026-08-08-pre-bm120'), 'x');   // hand-named
    fs.writeFileSync(path.join(dir, 'boards', 'fixture-project.json.bak-2026-07-30'), 'x');             // hand-named

    for (let i = 0; i < 3; i++) { await post(); await wait(1050); }   // stamps are per-second

    const auto = ls().filter(f => /-autosave$/.test(f)).sort();
    assert.ok(auto.length < 53, 'pruning must actually delete something. got ' + auto.length);
    assert.ok(auto.includes('fixture-project.json.bak-2026-08-05T00-00-01-autosave'), 'earliest Aug 5 copy is the daily floor and must survive');
    assert.ok(auto.includes('fixture-project.json.bak-2026-08-06T00-00-01-autosave'), 'earliest Aug 6 copy must survive');
    const days = new Set(auto.map(f => (f.match(/bak-(\d{4}-\d{2}-\d{2})/) || [])[1]));
    assert.ok(days.has('2026-08-05') && days.has('2026-08-06'), 'no day may lose its floor');
    // window + floors, with a little slack for same-second collapsing
    assert.ok(auto.length <= KEEP + days.size, 'retention must stay bounded. got ' + auto.length);

    assert.ok(ls().includes('fixture-project.json.bak-2026-08-08-pre-bm120'), 'hand-named backups are never pruned');
    assert.ok(ls().includes('fixture-project.json.bak-2026-07-30'), 'hand-named backups are never pruned');
  });
});

test('no temp files are left behind', async () => {
  await sandbox(async ({ post, ls }) => {
    for (let i = 0; i < 3; i++) { await post(); await wait(1050); }
    assert.deepEqual(ls().filter(f => f.includes('.tmp')), [], 'tmp files must be renamed away');
  });
});

test('the server refuses connections that are not from this machine', async () => {
  await sandbox(async ({ port }) => {
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address)[0];
    if (!lan) { console.log('    (no non-loopback interface here, skipping)'); return; }
    let refused = false;
    try {
      const c = new AbortController(); setTimeout(() => c.abort(), 2500);
      await fetch('http://' + lan + ':' + port + '/tasks.json', { signal: c.signal });
    } catch (e) { refused = true; }
    assert.ok(refused, 'the ledger writer must not be reachable from the LAN at ' + lan);
  });
});

test('a save built on a stale revision is refused, not applied', async () => {
  await sandbox(async ({ dir, post, rev, ls }) => {
    const stale = await rev();

    // Something outside the browser edits the ledger. This is Claude writing
    // tasks.json, or a second tab, or an editor.
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    disk.tasks.find(t => t.key === MOVABLE).status = 'in-progress';
    disk.tasks.find(t => t.key === MOVABLE).title = 'WRITTEN OUTSIDE THE BOARD';
    fs.writeFileSync(path.join(dir, 'boards', 'fixture-project.json'), JSON.stringify(disk, null, 2));
    await wait(30);

    // The board, still holding the old revision, tries to save its own copy.
    const mine = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    mine.tasks.find(t => t.key === MOVABLE).title = 'BOARD WOULD HAVE CLOBBERED THIS';
    const out = await post({ body: JSON.stringify(mine), ifMatch: stale });

    assert.equal(out._status, 409, 'a stale save must be refused');
    assert.equal(out.conflict, true);
    assert.ok(out.plan, 'the refusal must hand back what is actually on disk');
    assert.ok(out.rev && out.rev !== stale, 'and the current revision to retry with');

    const after = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    assert.equal(after.tasks.find(t => t.key === MOVABLE).title, 'WRITTEN OUTSIDE THE BOARD',
      'THE OUTSIDE WRITE MUST SURVIVE. This is the 2026-08-07 incident.');
    assert.ok(!ls().some(f => f.includes('.tmp')), 'a refused save writes nothing at all');
  });
});

test('retrying with the revision the server handed back succeeds', async () => {
  await sandbox(async ({ dir, post, rev }) => {
    const stale = await rev();
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    disk.updated = '2026-01-01';
    fs.writeFileSync(path.join(dir, 'boards', 'fixture-project.json'), JSON.stringify(disk, null, 2));
    await wait(30);

    const mine = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    mine.tasks.find(t => t.key === MOVABLE).status = 'in-progress';
    const refused = await post({ body: JSON.stringify(mine), ifMatch: stale });
    assert.equal(refused._status, 409);

    const ok = await post({ body: JSON.stringify(mine), ifMatch: refused.rev });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    assert.equal(after.tasks.find(t => t.key === MOVABLE).status, 'in-progress');
  });
});

test('a save with no revision at all is refused', async () => {
  await sandbox(async ({ dir, post }) => {
    const before = fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8');
    const out = await post({ ifMatch: null });
    assert.equal(out._status, 428);
    assert.equal(out.ok, false);
    assert.equal(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'), before);
  });
});

test('two boards racing: the second one is refused, not merged blindly', async () => {
  await sandbox(async ({ dir, post, rev }) => {
    const shared = await rev();
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    a.tasks.find(t => t.key === MOVABLE).status = 'in-progress';
    const b = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    b.tasks.find(t => t.key === 'PB-204').status = 'in-progress';

    const first = await post({ body: JSON.stringify(a), ifMatch: shared });
    const second = await post({ body: JSON.stringify(b), ifMatch: shared });
    assert.equal(first.ok, true);
    assert.equal(second._status, 409, 'the second tab must be told, not allowed to win');

    const after = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    assert.equal(after.tasks.find(t => t.key === MOVABLE).status, 'in-progress', 'first write stands');
    assert.notEqual(after.tasks.find(t => t.key === 'PB-204').status, 'in-progress', 'second write did not sneak in');
  });
});

test('two saves in the same second cannot overwrite each other\'s backup', async () => {
  await sandbox(async ({ dir, post, rev, ls }) => {
    // The 2026-08-09 failure: same-second stamps collided and the pre-write copy
    // of the ledger was destroyed by the next backup.
    const original = fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8');

    const first = JSON.parse(original);
    first.tasks.find(t => t.key === MOVABLE).title = 'FIRST WRITE';
    const r1 = await post({ body: JSON.stringify(first), ifMatch: await rev() });
    assert.equal(r1.ok, true);

    const second = JSON.parse(original);
    second.tasks.find(t => t.key === MOVABLE).title = 'SECOND WRITE';
    const r2 = await post({ body: JSON.stringify(second), ifMatch: r1.rev });   // no sleep: same second
    assert.equal(r2.ok, true, JSON.stringify(r2));

    assert.notEqual(r1.backup, r2.backup, 'each save needs its own backup filename');
    const b1 = fs.readFileSync(path.join(dir, 'boards', r1.backup), 'utf8');
    assert.equal(b1, original, 'the first backup must still hold the pre-write ledger');
    const b2 = JSON.parse(fs.readFileSync(path.join(dir, 'boards', r2.backup), 'utf8'));
    assert.equal(b2.tasks.find(t => t.key === MOVABLE).title, 'FIRST WRITE',
      'the second backup must hold what the first save produced');
  });
});

test('the ledger refuses a ticket that is both an epic and a milestone', async () => {
  await sandbox(async ({ dir, post, rev }) => {
    const p = fixture();
    p.tasks.find(t => t.key === EPIC).milestone = true;
    const out = await post({ body: JSON.stringify(p), ifMatch: await rev() });
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /both an epic and a milestone/);
  });
});

test('the ledger refuses an epic nested inside another epic', async () => {
  await sandbox(async ({ dir, post, rev }) => {
    const p = fixture();
    p.tasks.find(t => t.key === EPIC).epicKey = EPIC;
    const out = await post({ body: JSON.stringify(p), ifMatch: await rev() });
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /is an epic and also inside epic/);
  });
});

test('the ledger refuses a link to something that is not an epic', async () => {
  await sandbox(async ({ dir, post, rev }) => {
    const p = fixture();
    p.tasks.find(t => t.key === MOVABLE).epicKey = 'PB-999';
    const out = await post({ body: JSON.stringify(p), ifMatch: await rev() });
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /PB-999, which is not an epic/);

    const p2 = fixture();
    p2.tasks.find(t => t.key === MOVABLE).epicKey = 'PB-207';   // a milestone, not an epic
    const out2 = await post({ body: JSON.stringify(p2), ifMatch: await rev() });
    assert.equal(out2.ok, false);
  });
});

test('a valid epic structure is accepted and stored', async () => {
  await sandbox(async ({ dir, post, rev }) => {
    const p = fixture();
    p.tasks.find(t => t.key === MOVABLE).epicKey = EPIC;
    const out = await post({ body: JSON.stringify(p), ifMatch: await rev() });
    assert.equal(out.ok, true, JSON.stringify(out));
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    assert.equal(disk.tasks.find(t => t.key === MOVABLE).epicKey, EPIC);
    assert.equal(disk.tasks.find(t => t.key === EPIC).epic, true);
  });
});

/* ---------- board settings (added 2026-08-27) ----------
 * Columns used to be a hardcoded whitelist in this file that had to be kept 1:1
 * with the board by hand. Adding a column on the board therefore failed the save
 * with "unknown status" and looked like a board bug. Columns now come from
 * plan.settings, and these tests hold the two rules that make that safe:
 * a status with no column is refused, and a ledger written before settings
 * existed still validates on the original five.
 */
function withSettings(over) {
  const plan = fixture();
  plan.settings = Object.assign({
    columns: [
      { key: 'not-started',       label: 'Not Started',     dot: '#9A9A98' },
      { key: 'in-progress',       label: 'Doing',           dot: '#FF8200' },
      { key: 'ready-for-testing', label: 'Ready to Verify', dot: '#1565C0' },
      { key: 'blocked',           label: 'Blocked',         dot: '#B26A00' },
      { key: 'done',              label: 'Shipped',         dot: '#2E7D32' }
    ],
    doneKey: 'done', defaultKey: 'not-started',
    failFrom: 'ready-for-testing', failTo: 'in-progress'
  }, over || {});
  // needs-reconciliation is gone from this board, so nothing may still claim it.
  plan.tasks.forEach(t => { if (t.status === 'needs-reconciliation') t.status = 'not-started'; });
  return plan;
}

test('a ledger with no settings block still validates on the original columns', async () => {
  await sandbox(async ({ post }) => {
    const plan = fixture();
    assert.equal(plan.settings, undefined, 'fixture must stay pre-settings');
    plan.tasks.find(t => t.key === MOVABLE).status = 'needs-reconciliation';
    const out = await post({ body: JSON.stringify(plan) });
    assert.equal(out.ok, true, 'an old ledger must still restore cleanly: ' + JSON.stringify(out.errors));
  });
});

test('a renamed column does not touch the stored status', async () => {
  await sandbox(async ({ dir, post }) => {
    const plan = withSettings();
    plan.tasks.find(t => t.key === MOVABLE).status = 'in-progress';
    const out = await post({ body: JSON.stringify(plan) });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    // The label says "Doing" but the key the task points at is unchanged.
    assert.equal(disk.settings.columns[1].label, 'Doing');
    assert.equal(disk.tasks.find(t => t.key === MOVABLE).status, 'in-progress');
  });
});

test('a task in a custom column is accepted and stored', async () => {
  await sandbox(async ({ dir, post }) => {
    const plan = withSettings();
    plan.tasks.find(t => t.key === MOVABLE).status = 'blocked';
    const out = await post({ body: JSON.stringify(plan) });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    assert.equal(disk.tasks.find(t => t.key === MOVABLE).status, 'blocked');
  });
});

test('removing a column while tasks still point at it is refused', async () => {
  await sandbox(async ({ post }) => {
    const plan = withSettings();
    plan.tasks.find(t => t.key === MOVABLE).status = 'blocked';
    plan.settings.columns = plan.settings.columns.filter(c => c.key !== 'blocked');
    const out = await post({ body: JSON.stringify(plan) });
    assert.equal(out._status, 422, 'stranded tasks must not be written');
    assert.ok(out.errors.join(' ').includes('blocked'), 'the error must name the column');
  });
});

test('the done column is whatever settings says, not the word done', async () => {
  await sandbox(async ({ post }) => {
    const plan = withSettings({ doneKey: 'ready-for-testing' });
    // Under this board, ready-for-testing is terminal, so it needs a done date.
    plan.tasks.forEach(t => {
      if (t.status === 'done') { t.status = 'ready-for-testing'; }
      else if (t.status === 'ready-for-testing' && !t.done) { t.done = '2026-08-02'; }
    });
    const ok = await post({ body: JSON.stringify(plan) });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));

    const bad = withSettings({ doneKey: 'ready-for-testing' });
    bad.tasks.forEach(t => { if (t.status === 'done') t.status = 'ready-for-testing'; });
    const out = await post({ body: JSON.stringify(bad) });
    assert.equal(out._status, 422, 'a terminal-column task with no done date must be refused');
  });
});

test('a settings block that could break the board is refused', async () => {
  await sandbox(async ({ post }) => {
    const dupe = withSettings();
    dupe.settings.columns.push({ key: 'blocked', label: 'Blocked again', dot: '#B26A00' });
    assert.equal((await post({ body: JSON.stringify(dupe) }))._status, 422, 'duplicate keys');

    const noDone = withSettings({ doneKey: 'nope' });
    assert.equal((await post({ body: JSON.stringify(noDone) }))._status, 422, 'doneKey naming no column');

    const one = withSettings();
    one.settings.columns = [{ key: 'only', label: 'Only', dot: '#9A9A98' }];
    assert.equal((await post({ body: JSON.stringify(one) }))._status, 422, 'a one-column board');

    const badKey = withSettings();
    badKey.settings.columns[3].key = 'Not A Key';
    assert.equal((await post({ body: JSON.stringify(badKey) }))._status, 422, 'a malformed key');
  });
});

test('a promoted backlog ticket is accepted, and a bad intake column is not', async () => {
  await sandbox(async ({ dir, post }) => {
    const plan = withSettings();
    const item = plan.backlog[0];
    const text = item.text;
    // Promotion consumes the backlog entry and reuses its key on the board.
    plan.backlog = plan.backlog.slice(1);
    plan.tasks.push({
      id: 'task-promoted', key: item.key, title: text.slice(0, 60),
      section: plan.sections[0], start: '2026-08-27', due: '2026-09-30', done: null,
      status: 'not-started', milestone: false, epic: false, epicKey: null,
      description: 'Promoted from the backlog on 2026-08-27.\n\nOriginal backlog entry:\n' + text,
      acceptanceCriteria: [], history: [{ at: '2026-08-27', from: 'Backlog', to: 'Not Started', note: 'Promoted from the backlog.', fail: false }]
    });
    const out = await post({ body: JSON.stringify(plan) });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    assert.ok(!disk.backlog.some(b => b.key === item.key), 'the item must not be in both places');
    assert.ok(disk.tasks.some(t => t.key === item.key), 'and it keeps its number on the board');

    const bad = withSettings({ intakeKey: 'ghost' });
    assert.equal((await post({ body: JSON.stringify(bad) }))._status, 422, 'intakeKey naming no column');
  });
});

test('the board and the backlog cannot issue the same ticket key', async () => {
  await sandbox(async ({ post }) => {
    const plan = withSettings();
    plan.backlog = [{ key: MOVABLE, text: 'stealing a key that is already on the board' }];
    const out = await post({ body: JSON.stringify(plan) });
    assert.equal(out._status, 422, 'a shared number must be refused');
    assert.ok(out.errors.join(' ').includes(MOVABLE));

    const dupe = withSettings();
    dupe.backlog = [{ key: 'PB-901', text: 'one' }, { key: 'PB-901', text: 'two' }];
    assert.equal((await post({ body: JSON.stringify(dupe) }))._status, 422, 'two backlog items, one key');

    const bad = withSettings();
    bad.backlog = [{ key: 'nope', text: 'malformed key' }];
    assert.equal((await post({ body: JSON.stringify(bad) }))._status, 422, 'malformed key');

    const empty = withSettings();
    empty.backlog = [{ key: 'PB-902', text: '   ' }];
    assert.equal((await post({ body: JSON.stringify(empty) }))._status, 422, 'an item with no text');

    const legacy = withSettings();
    legacy.backlog = ['a bare string from before backlog keys'];
    assert.equal((await post({ body: JSON.stringify(legacy) })).ok, true, 'old backups must still restore');
  });
});

test('a parked ticket rides along in the backlog but is not treated as live work', async () => {
  await sandbox(async ({ dir, post }) => {
    const plan = withSettings();
    const t = plan.tasks.find(x => x.key === MOVABLE);
    plan.tasks = plan.tasks.filter(x => x.key !== MOVABLE);
    plan.backlog.unshift({ key: MOVABLE, text: t.title, parked: t });
    const out = await post({ body: JSON.stringify(plan) });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    assert.ok(disk.backlog[0].parked, 'the parked ticket is stored intact');
    assert.ok(!disk.tasks.some(x => x.key === MOVABLE), 'and it is not on the board twice');

    // A parked ticket filed under someone else's number would break the round trip.
    const mismatched = withSettings();
    mismatched.backlog.unshift({ key: 'PB-903', text: 'wrong owner', parked: { key: 'PB-904' } });
    assert.equal((await post({ body: JSON.stringify(mismatched) }))._status, 422);

    const junk = withSettings();
    junk.backlog.unshift({ key: 'PB-905', text: 'junk', parked: 'not an object' });
    assert.equal((await post({ body: JSON.stringify(junk) }))._status, 422);
  });
});

/* ---------- multiple boards (added 2026-10-13) ----------
   Each board is boards/<id>.json, listed in boards/index.json. tasks.json is
   copied in once and never touched again. Delete is a move, never an unlink. */
async function serverIn(dir, fn) {
  fs.copyFileSync(path.join(ROOT, 'serve-dashboard.js'), path.join(dir, 'serve-dashboard.js'));
  const port = 8700 + Math.floor(Math.random() * 400);
  const srv = spawn(process.execPath, ['serve-dashboard.js'], { cwd: dir, env: { ...process.env, PORT: String(port) } });
  await wait(1300);
  const api = async (method, p, body, headers) => {
    const res = await fetch('http://127.0.0.1:' + port + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, json, etag: res.headers.get('etag') };
  };
  try { await fn({ api, port }); } finally { srv.kill(); }
}
const newPlan = name => {
  const p = fixture(); p.project = name; return p;
};

test('first start copies tasks.json in as a board and leaves the original byte for byte', async () => {
  await sandbox(async ({ dir }) => {
    const seed = fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8');
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'index.json'), 'utf8'));
    assert.deepEqual(idx.boards, [{ id: 'fixture-project', name: 'Fixture Project' }]);
    assert.equal(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8').trim(), seed.trim());
    assert.equal(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'), seed, 'tasks.json is a permanent backup, never written');
  });
});

test('a new board is created, listed, and given a unique id', async () => {
  await sandbox(async ({ dir, port }) => {
    const call = async (method, p, body) => {
      const res = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return Object.assign(await res.json(), { _status: res.status });
    };
    const a = await call('POST', '/api/boards', newPlan('Calibration Prep'));
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.id, 'calibration-prep');
    const b = await call('POST', '/api/boards', newPlan('Calibration Prep'));
    assert.equal(b.id, 'calibration-prep-2', 'same name, different board');
    assert.ok(fs.existsSync(path.join(dir, 'boards', 'calibration-prep.json')));
    const list = await call('GET', '/api/boards');
    assert.deepEqual(list.boards.map(x => x.id), ['fixture-project', 'calibration-prep', 'calibration-prep-2'], 'tab order is creation order');
  });
});

test('a new board must be valid and named', async () => {
  await sandbox(async ({ dir, port }) => {
    const post = async body => (await fetch('http://127.0.0.1:' + port + '/api/boards', { method: 'POST', body: JSON.stringify(body) })).json();
    const empty = newPlan('Empty'); empty.tasks = [];
    assert.equal((await post(empty)).ok, false, 'an empty task list is refused here too');
    const nameless = newPlan('   ');
    assert.equal((await post(nameless)).ok, false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'boards')).filter(f => f.endsWith('.json')).sort(), ['fixture-project.json', 'index.json']);
  });
});

test('renaming a board updates its tab name, never its file', async () => {
  await sandbox(async ({ dir, post }) => {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'fixture-project.json'), 'utf8'));
    plan.project = 'Renamed Board';
    const out = await post({ body: JSON.stringify(plan) });
    assert.equal(out.ok, true, JSON.stringify(out));
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'boards', 'index.json'), 'utf8'));
    assert.deepEqual(idx.boards, [{ id: 'fixture-project', name: 'Renamed Board' }]);
  });
});

test('delete moves the board to boards/deleted and the last board cannot be deleted', async () => {
  await sandbox(async ({ dir, port }) => {
    const call = async (method, p, body) => {
      const res = await fetch('http://127.0.0.1:' + port + p, { method, body: body && JSON.stringify(body) });
      return Object.assign(await res.json(), { _status: res.status });
    };
    assert.equal((await call('DELETE', '/api/boards/fixture-project'))._status, 422, 'the only board stays');
    await call('POST', '/api/boards', newPlan('Second'));
    const del = await call('DELETE', '/api/boards/fixture-project');
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.deepEqual(del.boards.map(b => b.id), ['second']);
    assert.ok(!fs.existsSync(path.join(dir, 'boards', 'fixture-project.json')));
    const kept = fs.readdirSync(path.join(dir, 'boards', 'deleted'));
    assert.equal(kept.length, 1);
    assert.ok(/^fixture-project-.*\.json$/.test(kept[0]), 'deleted board is kept, recoverable: ' + kept[0]);
    assert.equal((await call('GET', '/api/boards/fixture-project'))._status, 404);
  });
});

test('board ids are checked before they touch the filesystem', async () => {
  await sandbox(async ({ port }) => {
    for (const bad of ['Bad_ID', '..%2Findex', '%2E%2E', 'index%2F..%2F..%2Ftasks']) {
      const res = await fetch('http://127.0.0.1:' + port + '/api/boards/' + bad, { method: 'DELETE' });
      // 405 is the URL parser folding the dots away before the server sees them: still refused.
      assert.ok([400, 404, 405].includes(res.status), bad + ' answered ' + res.status);
    }
    const res = await fetch('http://127.0.0.1:' + port + '/api/boards/index');
    assert.equal(res.status, 404, 'the index file is not a board');
  });
});

test('the old single-board endpoint is retired with a plain message', async () => {
  await sandbox(async ({ port }) => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/tasks', { method: 'POST', body: '{}' });
    assert.equal(res.status, 410);
    assert.match((await res.json()).errors[0], /Reload the page/);
  });
});

test('a lost index is rebuilt from the board files, not reset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmsrv-'));
  fs.mkdirSync(path.join(dir, 'boards'));
  fs.writeFileSync(path.join(dir, 'boards', 'alpha.json'), JSON.stringify(newPlan('Alpha Board')));
  fs.writeFileSync(path.join(dir, 'boards', 'beta.json'), JSON.stringify(newPlan('Beta Board')));
  await serverIn(dir, async ({ api }) => {
    const out = await api('GET', '/api/boards');
    assert.deepEqual(out.json.boards, [{ id: 'alpha', name: 'Alpha Board' }, { id: 'beta', name: 'Beta Board' }]);
  });
});

test('a folder with no tasks.json starts with an empty list instead of crashing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmsrv-'));
  await serverIn(dir, async ({ api }) => {
    const out = await api('GET', '/api/boards');
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.boards, []);
  });
});

/* ---------- seeded boards (added 2026-10-17) ----------
   The starting boards ship in seeds/, one file each, file order = tab order. */
test('first start creates one board per seed file, in file order, and never writes the seeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmsrv-'));
  fs.mkdirSync(path.join(dir, 'seeds'));
  const a = newPlan('Budget Master'), b = newPlan('Fix.ly'), c = newPlan('Kin & Letter');
  fs.writeFileSync(path.join(dir, 'seeds', '01-a.json'), JSON.stringify(a));
  fs.writeFileSync(path.join(dir, 'seeds', '03-c.json'), JSON.stringify(c));
  fs.writeFileSync(path.join(dir, 'seeds', '02-b.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(dir, 'seeds', '04-broken.json'), '{ not json');
  const before = fs.readdirSync(path.join(dir, 'seeds')).map(f => fs.readFileSync(path.join(dir, 'seeds', f), 'utf8'));
  await serverIn(dir, async ({ api }) => {
    const out = await api('GET', '/api/boards');
    assert.deepEqual(out.json.boards, [
      { id: 'budget-master', name: 'Budget Master' },
      { id: 'fix-ly', name: 'Fix.ly' },
      { id: 'kin-letter', name: 'Kin & Letter' }], 'a broken seed is skipped, the rest still load');
    const one = await api('GET', '/api/boards/fix-ly');
    assert.equal(one.json.project, 'Fix.ly');
  });
  const after = fs.readdirSync(path.join(dir, 'seeds')).map(f => fs.readFileSync(path.join(dir, 'seeds', f), 'utf8'));
  assert.deepEqual(after, before, 'seed files are read, never written');
});

test('the shipped seed boards all pass the ledger rules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmsrv-'));
  fs.mkdirSync(path.join(dir, 'seeds'));
  const shipped = fs.readdirSync(path.join(ROOT, 'seeds')).filter(f => f.endsWith('.json'));
  assert.ok(shipped.length >= 1, 'the repo ships seed boards');
  shipped.forEach(f => fs.copyFileSync(path.join(ROOT, 'seeds', f), path.join(dir, 'seeds', f)));
  await serverIn(dir, async ({ api }) => {
    const list = (await api('GET', '/api/boards')).json.boards;
    assert.equal(list.length, shipped.length, 'every shipped seed became a board');
    for (const bd of list) {
      const got = await api('GET', '/api/boards/' + bd.id);
      const saved = await api('POST', '/api/boards/' + bd.id, got.json, { 'If-Match': got.etag });
      assert.equal(saved.status, 200, bd.id + ' failed validation: ' + JSON.stringify(saved.json));
    }
  });
});

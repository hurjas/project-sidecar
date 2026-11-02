/* Settings tests for project-plan-dashboard.html.
 *
 * Deliberately does NOT use jsdom. The jsdom suite cannot even load on some
 * machines, and a test that will not run proves nothing. This one runs the
 * board's real script in a vm against a stub DOM, so the settings logic is
 * covered everywhere node runs.
 *
 * What it holds: a rename never touches a stored status, order decides what
 * counts as a backward move, removing a column moves its tickets instead of
 * stranding them, and the done column is a setting rather than a magic string.
 *
 * Run: node dashboard-settings.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { test } = require('node:test');
const { fixture, MOVABLE, EPIC, EPIC_CHILD } = require('./dashboard-test-fixture.js');

/* A due date safely in the future. Promotion refuses a due date before today,
   so a hard-coded date turns into a failing test the day the calendar passes
   it. Computed in local time to match the board's own today(). */
const FUTURE = (() => {
  const d = new Date(); d.setDate(d.getDate() + 60);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
})();

const HTML = fs.readFileSync(path.join(__dirname, 'project-plan-dashboard.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];

function el() {
  const e = {
    innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    className: '', title: '', dataset: {},
    style: { setProperty(k, v) { this[k] = v; } },
    classList: { _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); } },
    appendChild() {}, focus() {}, select() {}, getContext() { return {}; },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {},
    _attrs: {},
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    scrollIntoView() {}
  };
  return e;
}

/* Boots the real board script against a stub DOM and a fake ledger. */
function board(plan) {
  const served = plan || fixture();
  const els = {};
  const byId = id => (els[id] || (els[id] = el()));
  const doc = {
    getElementById: byId,
    querySelectorAll: () => [],
    addEventListener: () => {},
    documentElement: el(),
    body: el()
  };
  const store = {};
  const ctx = {
    document: doc,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Math, Date, Set, Map, Object, Array, String, Number, Boolean, Promise, RegExp, Error, isNaN, parseInt, parseFloat,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    Chart: Object.assign(function () {
      return { destroy() {}, ctx: { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {} },
               chartArea: { top: 0, bottom: 0 }, scales: { x: { getPixelForValue: () => 0 } } };
    }, { register: () => {} }),
    fetch: async (url, opt) => {
      if ((!opt || opt.method !== 'POST') && /^api\/boards(\?|$)/.test(url)) {
        return { ok: true, status: 200, headers: { get: () => null },
                 json: async () => ({ ok: true, boards: [{ id: 'fixture-project', name: served.project }] }) };
      }
      if (opt && opt.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, updated: '2026-08-27', backup: 'b', tasks: served.tasks.length, rev: '"rev-2"' }) };
      return { ok: true, status: 200, headers: { get: h => (/etag/i.test(h) ? '"rev-1"' : null) }, json: async () => JSON.parse(JSON.stringify(served)) };
    }
  };
  ctx.addEventListener = () => {};
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  return { ctx, els, byId,
           get: n => vm.runInContext(n, ctx),
           task: k => vm.runInContext('state', ctx).tasks.find(t => t.key === k) };
}
const settled = () => new Promise(r => setTimeout(r, 60));

test('a ledger with no settings block boots on the original five columns', async () => {
  const b = board(); await settled();
  assert.equal(b.get('COLUMNS').length, 5);
  assert.equal(b.get('DONE_KEY'), 'done');
  assert.equal(b.get('DEFAULT_STATUS'), 'not-started');
  // The board CSS reads this, so a wrong value silently squashes the columns.
  assert.equal(String(b.ctx.document.documentElement.style['--cols']), '5');
});

test('renaming a column changes the label and nothing else', async () => {
  const b = board(); await settled();
  const before = b.task(MOVABLE).status;
  b.ctx.setColumnLabel(1, 'Backlogged');
  assert.equal(b.get('state').settings.columns[1].label, 'Backlogged');
  assert.equal(b.get('state').settings.columns[1].key, 'not-started', 'the key must be permanent');
  assert.equal(b.task(MOVABLE).status, before, 'a rename must not touch a stored status');
  assert.equal(b.get('labelOf')('not-started'), 'Backlogged');
});

test('adding a column mints a unique slug key and widens the board', async () => {
  const b = board(); await settled();
  b.byId('newCol').value = 'Blocked';
  b.ctx.addColumn();
  const cols = b.get('state').settings.columns;
  assert.equal(cols.length, 6);
  assert.equal(cols[5].key, 'blocked');
  assert.equal(String(b.ctx.document.documentElement.style['--cols']), '6');

  b.byId('newCol').value = 'Blocked';         // same name again
  b.ctx.addColumn();
  assert.equal(b.get('state').settings.columns[6].key, 'blocked-2', 'keys must never collide');
});

test('column order decides what counts as a backward move', async () => {
  const b = board(); await settled();
  // not-started is index 1, in-progress index 2, so this is forward and silent.
  assert.ok(b.get('colIdx')('in-progress') > b.get('colIdx')('not-started'));
  b.ctx.moveColumn(2, -1);                    // in-progress now sits before not-started
  assert.ok(b.get('colIdx')('in-progress') < b.get('colIdx')('not-started'),
    'reordering must change the direction test, not just the picture');
});

test('removing a column moves its tickets rather than stranding them', async () => {
  const b = board(); await settled();
  const t = b.task(MOVABLE);
  b.ctx.moveTask(t, b.ctx.resolveTarget('in-progress'));
  const before = b.get('state').tasks.filter(x => x.status === 'in-progress').length;
  assert.ok(before > 0);

  b.ctx.startRemove('in-progress');
  b.byId('reassignTo').value = 'not-started';   // the reassignment the page asks for
  b.ctx.confirmRemove('in-progress');

  const s = b.get('state');
  assert.ok(!s.settings.columns.some(c => c.key === 'in-progress'), 'column is gone');
  assert.equal(s.tasks.filter(x => x.status === 'in-progress').length, 0, 'no ticket left pointing at it');
  const moved = b.task(MOVABLE);
  assert.equal(moved.status, 'not-started');
  const last = moved.history[moved.history.length - 1];
  assert.ok(/was removed from the board/.test(last.note), 'the move must say why in the activity log');
});

test('the done column cannot be removed out from under its tickets', async () => {
  const b = board(); await settled();
  const doneKeys = b.get('state').tasks.filter(t => t.status === 'done').map(t => t.key);
  assert.ok(doneKeys.length, 'fixture must have done tickets');

  b.ctx.startRemove('done');
  assert.equal(b.get('pendingRemove'), null, 'the confirm must not even open');
  b.ctx.confirmRemove('done');                    // and forcing it changes nothing

  const s = b.get('state');
  assert.ok(s.settings.columns.some(c => c.key === 'done'), 'the done column is still there');
  doneKeys.forEach(k => assert.ok(b.task(k).done, 'no done date may be stripped: ' + k));
});

test('removing the column new tickets start in moves the start role too', async () => {
  const b = board(); await settled();
  assert.equal(b.get('DEFAULT_STATUS'), 'not-started');
  b.ctx.startRemove('not-started');
  b.byId('reassignTo').value = 'in-progress';
  b.ctx.confirmRemove('not-started');
  assert.equal(b.get('DEFAULT_STATUS'), 'in-progress',
    'the start role must follow the tickets, not fall on whatever sits first');
});

test('moving the done role is confirmed first, then restamps', async () => {
  const b = board(); await settled();
  b.ctx.setRole('doneKey', 'ready-for-testing');
  assert.equal(b.get('state').settings.doneKey, 'done', 'nothing may change before the confirm');
  assert.equal(b.get('pendingDone'), 'ready-for-testing');

  b.ctx.confirmDone();
  const s = b.get('state');
  assert.equal(s.settings.doneKey, 'ready-for-testing');
  s.tasks.filter(t => t.status === 'ready-for-testing').forEach(t => {
    assert.ok(t.done, 'everything in the done column must carry a done date');
  });
  assert.equal(s.tasks.filter(t => t.status === 'done').length, 0, 'the old done column is empty');
});

test('a fail route that no longer exists is dropped, not left dangling', async () => {
  const b = board(); await settled();
  b.ctx.startRemove('in-progress');
  b.byId('reassignTo').value = 'not-started';
  b.ctx.confirmRemove('in-progress');           // in-progress was failTo
  assert.equal(b.get('FAIL_TO'), null);
  assert.equal(b.get('FAIL_FROM'), null, 'half a fail route must not survive');
  // The dropdown must stop offering an action that cannot resolve.
  assert.ok(!/Failed/.test(b.get('statusOptions')('ready-for-testing', 'ready-for-testing')));
});

test('clearing a done date sends the ticket to whatever now precedes done', async () => {
  const b = board(); await settled();
  assert.equal(b.get('prevOfDone')(), 'ready-for-testing');
  b.ctx.startRemove('ready-for-testing');
  b.byId('reassignTo').value = 'in-progress';
  b.ctx.confirmRemove('ready-for-testing');
  assert.equal(b.get('prevOfDone')(), 'in-progress', 'must not stay pinned to a column that is gone');
});

test('a hand-broken settings block is repaired instead of breaking the board', async () => {
  const plan = fixture();
  plan.settings = { columns: [{ key: 'a', label: 'A', dot: 'not-a-colour' }, { key: 'b', label: 'B' }],
                    doneKey: 'ghost', defaultKey: 'ghost', failFrom: 'ghost', failTo: 'b' };
  const b = board(plan); await settled();
  assert.equal(b.get('DONE_KEY'), 'b', 'an impossible done column falls back to the last one');
  assert.equal(b.get('DEFAULT_STATUS'), 'a');
  assert.equal(b.get('FAIL_FROM'), null);
  assert.equal(b.get('COLUMNS')[0].dot, '#9A9A98', 'a bad colour is replaced, not rendered');
  // Every task pointed at a status none of these columns has.
  b.get('state').tasks.forEach(t => {
    assert.ok(['a', 'b'].includes(t.status), 'no task may keep a status with no column');
  });
});

/* ---------- backlog promotion (added 2026-08-27) ----------
 * A backlog entry is a bare string. A ticket is not. Everything the ledger
 * requires — key, section, start, due, status — has to be real, or the save is
 * refused and the item looks like it vanished.
 */
test('promoting a backlog item builds a ticket the ledger will accept', async () => {
  const b = board(); await settled();
  const item = b.get('state').backlog[0];
  const before = b.get('state').tasks.length;

  b.ctx.startPromote(0);
  b.byId('promoSec').value = b.get('state').sections[1];
  b.byId('promoDue').value = FUTURE;
  const t = b.ctx.confirmPromote(0);

  const s = b.get('state');
  assert.equal(s.tasks.length, before + 1);
  assert.ok(!s.backlog.some(x => x.key === item.key), 'the backlog entry must be consumed, not copied');
  assert.equal(t.key, item.key, 'a promoted item keeps the number it was filed under');
  assert.equal(t.status, 'needs-reconciliation', 'lands in the intake column');
  assert.equal(t.section, s.sections[1]);
  assert.equal(t.due, FUTURE);
  assert.ok(t.start && t.title && !t.done);
  assert.ok(t.description.includes(item.text), 'the original wording must survive in full');
  assert.equal(t.history[0].from, 'Backlog', 'the promotion is on the record');
  ['id','key','title','section','start','due'].forEach(f => assert.ok(t[f], 'missing ' + f));
});

test('promotion refuses to invent a due date or a section', async () => {
  const b = board(); await settled();
  const before = b.get('state').tasks.length;

  b.ctx.startPromote(0);
  b.byId('promoDue').value = '';
  b.byId('promoSec').value = b.get('state').sections[0];
  b.ctx.confirmPromote(0);
  assert.equal(b.get('state').tasks.length, before, 'no due date, no ticket');

  b.byId('promoDue').value = '2026-01-01';            // before today
  b.ctx.confirmPromote(0);
  assert.equal(b.get('state').tasks.length, before, 'a due date before the start is refused');

  b.byId('promoSec').value = 'Not A Section';
  b.byId('promoDue').value = FUTURE;
  b.ctx.confirmPromote(0);
  assert.equal(b.get('state').tasks.length, before, 'an unknown section is refused');
});

test('promotion follows the intake column, it is not pinned to a key', async () => {
  const b = board(); await settled();
  b.ctx.setRole('intakeKey', 'in-progress');
  b.ctx.startPromote(0);
  b.byId('promoSec').value = b.get('state').sections[0];
  b.byId('promoDue').value = FUTURE;
  assert.equal(b.ctx.confirmPromote(0).status, 'in-progress');
});

test('removing the intake column hands the role to where its tickets went', async () => {
  const b = board(); await settled();
  assert.equal(b.get('INTAKE_KEY'), 'needs-reconciliation');
  b.ctx.startRemove('needs-reconciliation');
  b.byId('reassignTo').value = 'not-started';
  b.ctx.confirmRemove('needs-reconciliation');
  assert.equal(b.get('INTAKE_KEY'), 'not-started', 'promotion must not point at a column that is gone');
});

test('a promoted ticket counts as open work immediately', async () => {
  const b = board(); await settled();
  const before = b.ctx.stats();
  b.ctx.startPromote(0);
  b.byId('promoSec').value = b.get('state').sections[0];
  b.byId('promoDue').value = FUTURE;
  b.ctx.confirmPromote(0);
  const after = b.ctx.stats();
  assert.equal(after.open, before.open + 1, 'promoting is not filing — it adds work');
  assert.ok(after.required > before.required, 'required pace must move');
});

/* ---------- backlog keys and ordering (added 2026-08-27) ---------- */
test('every backlog item carries a ticket key, whatever shape it arrived in', async () => {
  const plan = fixture();
  // The three shapes this list has actually held.
  plan.backlog = ['a bare string from the original schema',
                  { title: 'a heading-sweep object', note: 'with a note worth keeping' },
                  { key: 'PB-299', text: 'already keyed' }];
  const b = board(plan); await settled();
  const bl = b.get('state').backlog;
  assert.equal(bl.length, 3);
  bl.forEach(x => {
    assert.ok(/^PB-\d+$/.test(x.key), 'every item needs a key: ' + JSON.stringify(x));
    assert.ok(x.text && x.text.trim(), 'no item may lose its wording');
  });
  assert.equal(bl[2].key, 'PB-299', 'an existing key is never reissued');
  assert.equal(bl[1].note, 'with a note worth keeping');
  assert.notEqual(bl[0].key, bl[1].key);
});

test('a backlog key can never collide with a ticket key', async () => {
  const b = board(); await settled();
  const taken = new Set([...b.get('state').tasks.map(t => t.key), ...b.get('state').backlog.map(x => x.key)]);
  b.byId('bName').value = 'A brand new idea';
  b.ctx.addBacklog();
  const added = b.get('state').backlog[b.get('state').backlog.length - 1];
  assert.ok(!taken.has(added.key), 'minted into a used number: ' + added.key);

  b.ctx.newTask();                                  // and the task side must dodge backlog keys too
  const t = b.get('state').tasks[b.get('state').tasks.length - 1];
  assert.notEqual(t.key, added.key);
  const all = [...b.get('state').tasks.map(x => x.key), ...b.get('state').backlog.map(x => x.key)];
  assert.equal(new Set(all).size, all.length, 'keys must be unique across both lists');
});

test('backlog rows reorder by button and by drop, and the order sticks', async () => {
  const b = board(); await settled();
  const [first, second] = b.get('state').backlog.map(x => x.key);

  b.ctx.moveBacklog(0, 1);
  assert.deepEqual(b.get('state').backlog.map(x => x.key).slice(0, 2), [second, first], 'button move');

  b.ctx.moveBacklog(0, -1);                          // already at the top
  assert.deepEqual(b.get('state').backlog.map(x => x.key).slice(0, 2), [second, first], 'no wrap off the end');

  // A drop from row 1 onto row 0 puts it back.
  const row = i => ({ preventDefault() {}, currentTarget: { dataset: { i: String(i) }, classList: { add() {}, remove() {} } },
                      dataTransfer: { effectAllowed: '', dropEffect: '', _d: {}, setData(k, v) { this._d[k] = v; }, getData(k) { return this._d[k]; } } });
  const start = row(1); b.ctx.blDragStart(start);
  b.ctx.blDrop(row(0));
  assert.deepEqual(b.get('state').backlog.map(x => x.key).slice(0, 2), [first, second], 'drop reorders');
  assert.equal(b.get('dirty'), true, 'a reorder is an unsaved change like any other');
});

test('reordering never rewrites what an item says', async () => {
  const b = board(); await settled();
  const before = b.get('state').backlog.map(x => x.key + '|' + x.text).sort();
  b.ctx.moveBacklog(0, 1);
  b.ctx.moveBacklog(1, -1);
  const after = b.get('state').backlog.map(x => x.key + '|' + x.text).sort();
  assert.deepEqual(after, before);
});

/* ---------- the backlog item editor (added 2026-08-27) ----------
 * Keyed by PB- number rather than list index: the list reorders and items are
 * deleted from underneath, and an index-keyed panel would silently edit the
 * wrong item.
 */
test('a backlog item opens, edits and saves', async () => {
  const b = board(); await settled();
  const item = b.get('state').backlog[0];

  b.ctx.openBacklogItem(item.key);
  assert.equal(b.get('blOpenKey'), item.key);
  assert.equal(b.byId('blText').value, item.text, 'the panel loads what is stored');

  b.byId('blText').value = 'Reworded idea';
  b.byId('blNote').value = 'Why it matters';
  b.ctx.applyBacklogItem();

  const after = b.get('state').backlog.find(x => x.key === item.key);
  assert.equal(after.text, 'Reworded idea');
  assert.equal(after.note, 'Why it matters');
  assert.equal(after.key, item.key, 'editing never reissues the number');
  assert.equal(b.get('blOpenKey'), null, 'the panel closes on save');
  assert.equal(b.get('dirty'), true);
});

test('an emptied backlog item is refused, not written', async () => {
  const b = board(); await settled();
  const item = b.get('state').backlog[0];
  b.ctx.openBacklogItem(item.key);
  b.byId('blText').value = '   ';
  b.ctx.applyBacklogItem();
  assert.equal(b.get('blOpenKey'), item.key, 'the panel stays open so it can be fixed');
  assert.equal(b.get('state').backlog[0].text, item.text, 'nothing was overwritten');
});

test('clearing the note removes it rather than storing an empty string', async () => {
  const b = board(); await settled();
  const item = b.get('state').backlog[0];
  b.ctx.openBacklogItem(item.key);
  b.byId('blNote').value = 'temporary';
  b.ctx.applyBacklogItem();
  assert.equal(b.get('state').backlog[0].note, 'temporary');

  b.ctx.openBacklogItem(item.key);
  b.byId('blNote').value = '';
  b.ctx.applyBacklogItem();
  assert.ok(!('note' in b.get('state').backlog[0]), 'an empty note is dropped');
});

test('the panel follows the item through a reorder, not the row it sat on', async () => {
  const b = board(); await settled();
  const [first, second] = b.get('state').backlog.map(x => x.key);
  b.ctx.openBacklogItem(first);
  b.ctx.moveBacklog(0, 1);                       // first is now row 2
  b.byId('blText').value = 'edited after the move';
  b.ctx.applyBacklogItem();
  assert.equal(b.get('state').backlog.find(x => x.key === first).text, 'edited after the move');
  assert.notEqual(b.get('state').backlog.find(x => x.key === second).text, 'edited after the move');
});

test('deleting from the panel removes exactly one item and closes it', async () => {
  const b = board(); await settled();
  const item = b.get('state').backlog[0];
  const before = b.get('state').backlog.length;
  b.ctx.openBacklogItem(item.key);
  b.ctx.deleteBacklogItem();
  assert.equal(b.get('state').backlog.length, before - 1);
  assert.ok(!b.get('state').backlog.some(x => x.key === item.key));
  assert.equal(b.get('blOpenKey'), null);
});

test('deleting the row under an open panel closes it instead of orphaning it', async () => {
  const b = board(); await settled();
  const item = b.get('state').backlog[0];
  b.ctx.openBacklogItem(item.key);
  b.ctx.delBacklog(0);
  assert.equal(b.get('blOpenKey'), null, 'the panel must not stay open on a deleted item');
});

test('send to board from the panel keeps an unsaved rename', async () => {
  const b = board(); await settled();
  const item = b.get('state').backlog[0];
  b.ctx.openBacklogItem(item.key);
  b.byId('blText').value = 'Renamed on the way to the board';
  b.ctx.promoteFromPanel();
  assert.equal(b.get('blOpenKey'), null, 'the panel closes');
  assert.equal(b.get('pendingPromote'), 0, 'and the promote row opens on the right item');

  b.byId('promoSec').value = b.get('state').sections[0];
  b.byId('promoDue').value = FUTURE;
  const t = b.ctx.confirmPromote(0);
  assert.equal(t.title, 'Renamed on the way to the board');
  assert.equal(t.key, item.key);
});

test('escape closes the backlog panel, not the ticket modal behind it', async () => {
  const b = board(); await settled();
  b.ctx.openBacklogItem(b.get('state').backlog[0].key);
  b.ctx.closeAnyPanel();
  assert.equal(b.get('blOpenKey'), null);
  assert.equal(b.get('openId'), null, 'and the ticket modal was never involved');
});

test('backlog rows band alternately, and banding follows a reorder', async () => {
  const b = board(); await settled();
  const rows = () => (b.byId('backlogList').innerHTML.match(/<li class="bl[^"]*"/g) || []);
  const r = rows();
  assert.ok(r.length >= 2, 'need at least two rows to band');
  assert.ok(!/alt/.test(r[0]), 'first row is unbanded');
  assert.ok(/alt/.test(r[1]), 'second row is banded');

  /* The stripe is rendered from the index rather than :nth-child, because the
     promote form replaces a row in place. Banding must survive that. */
  b.ctx.startPromote(0);
  const withForm = rows();
  assert.ok(/promote/.test(b.byId('backlogList').innerHTML), 'the form is open');
  assert.ok(/alt/.test(withForm[0]), 'the row after an open form keeps its band');
  b.ctx.cancelPromote();

  b.ctx.moveBacklog(0, 1);
  const after = rows();
  assert.ok(!/alt/.test(after[0]) && /alt/.test(after[1]), 'banding is positional, not per item');
});

/* ---------- board back to backlog (added 2026-08-28) ----------
 * The round trip is the point. A demote that drops the criteria and the
 * activity log is data loss wearing a feature's clothes.
 */
test('sending a ticket back parks everything the backlog shape cannot hold', async () => {
  const b = board(); await settled();
  const t = b.task(MOVABLE);
  t.acceptanceCriteria = [{ text: 'a criterion', done: true }];
  b.ctx.moveTask(t, b.ctx.resolveTarget('in-progress'));   // gives it a history entry
  const historyBefore = t.history.length;
  const tasksBefore = b.get('state').tasks.length;

  b.ctx.openTask(t.id);
  b.ctx.startDemote();
  assert.equal(b.get('state').tasks.length, tasksBefore, 'nothing moves before the confirm');
  b.ctx.confirmDemote();

  const s = b.get('state');
  assert.equal(s.tasks.length, tasksBefore - 1, 'off the board');
  const item = s.backlog.find(x => x.key === MOVABLE);
  assert.ok(item, 'and into the backlog');
  assert.equal(s.backlog[0].key, MOVABLE, 'newest decision sits at the top');
  assert.ok(item.parked, 'the ticket is parked, not discarded');
  assert.equal(item.parked.acceptanceCriteria.length, 1);
  assert.ok(item.parked.history.length > historyBefore, 'the demotion itself is logged');
  assert.equal(item.parked.history[item.parked.history.length - 1].to, 'Backlog');
  assert.equal(b.get('openId'), null, 'the modal closes');
});

test('a parked ticket comes back whole', async () => {
  const b = board(); await settled();
  const t = b.task(MOVABLE);
  t.acceptanceCriteria = [{ text: 'prove the number', done: true }];
  t.epicKey = 'PB-208';
  const section = t.section;
  b.ctx.openTask(t.id);
  b.ctx.startDemote();
  b.ctx.confirmDemote();

  const i = b.get('state').backlog.findIndex(x => x.key === MOVABLE);
  b.ctx.startPromote(i);
  b.byId('promoSec').value = section;
  b.byId('promoDue').value = FUTURE;
  const back = b.ctx.confirmPromote(i);

  assert.equal(back.key, MOVABLE, 'same number the whole way round');
  assert.equal(back.acceptanceCriteria.length, 1, 'criteria come back');
  assert.equal(back.acceptanceCriteria[0].done, false, 'but unproven again');
  assert.equal(back.epicKey, 'PB-208', 'the epic link survives');
  assert.ok(back.history.length >= 2, 'the log is continuous, not restarted');
  assert.equal(back.status, 'needs-reconciliation', 're-enters through intake');
  assert.equal(back.done, null);
  assert.ok(!b.get('state').backlog.some(x => x.key === MOVABLE), 'and it left the backlog');
});

test('an epic with tickets in it cannot be sent back', async () => {
  const b = board(); await settled();
  const epic = b.task(EPIC);
  const before = b.get('state').tasks.length;
  b.ctx.openTask(epic.id);
  b.ctx.startDemote();
  b.ctx.confirmDemote();                                   // forcing it must still do nothing
  assert.equal(b.get('state').tasks.length, before, 'the epic stays put');
  assert.ok(b.byId('demoteBox').innerHTML.includes('still has'), 'and it says why');
  assert.ok(b.get('state').tasks.some(x => x.key === EPIC_CHILD && x.epicKey === EPIC),
    'no child was silently unlinked');
});

test('demoting a done ticket is flagged before it changes the counts', async () => {
  const b = board(); await settled();
  const done = b.get('state').tasks.find(t => t.status === 'done' && !t.epic);
  const beforeDone = b.ctx.stats().done;
  b.ctx.openTask(done.id);
  b.ctx.startDemote();
  assert.ok(b.byId('demoteBox').className.includes('bad'), 'a done ticket warns harder');
  assert.ok(/burndown|velocity/i.test(b.byId('demoteBox').innerHTML), 'and names what moves');
  b.ctx.confirmDemote();
  assert.equal(b.ctx.stats().done, beforeDone - 1, 'the done count really does drop');
});

test('editing a demoted item does not throw away what was parked', async () => {
  const b = board(); await settled();
  const t = b.task(MOVABLE);
  b.ctx.openTask(t.id);
  b.ctx.startDemote();
  b.ctx.confirmDemote();

  b.ctx.openBacklogItem(MOVABLE);
  b.byId('blText').value = 'Reworded while parked';
  b.ctx.applyBacklogItem();
  const item = b.get('state').backlog.find(x => x.key === MOVABLE);
  assert.equal(item.text, 'Reworded while parked');
  assert.ok(item.parked, 'the parked ticket survives an edit');
});

/* ---------- the sample board keeps itself current (added 2026-10-13) ----------
   The shipped sample was written for one day. Opened weeks later every open
   ticket read as overdue and the board looked broken. A plan carrying
   sampleAnchor slides its dates forward to today; the first real edit stops it. */
function ymd(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function shiftStr(s, n) {
  const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d + n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

test('a sample plan slides every date forward to today', async () => {
  const plan = fixture();
  plan.sampleAnchor = ymd(-30);
  plan.tasks[0].history = [{ at: plan.tasks[0].done, from: 'In Progress', to: 'Done', note: '', fail: false }];
  const before = JSON.parse(JSON.stringify(plan));
  const b = board(plan); await settled();
  const s = b.get('state');
  assert.equal(s.sampleAnchor, ymd(0), 'the anchor moves to today');
  assert.equal(s.targetDate, shiftStr(before.targetDate, 30));
  assert.equal(s.created, shiftStr(before.created, 30));
  s.tasks.forEach((t, i) => {
    const o = before.tasks[i];
    assert.equal(t.start, shiftStr(o.start, 30), t.key + ' start');
    assert.equal(t.due, shiftStr(o.due, 30), t.key + ' due');
    if (o.done) assert.equal(t.done, shiftStr(o.done, 30), t.key + ' done');
  });
  assert.equal(s.tasks[0].history[0].at, shiftStr(before.tasks[0].history[0].at, 30), 'history moves with the ticket');
  assert.equal(b.get('dirty'), false, 'sliding the sample is not an edit');
});

test('a plan without a sample anchor is never moved', async () => {
  const plan = fixture();
  const b = board(plan); await settled();
  assert.equal(b.get('state').targetDate, plan.targetDate);
  assert.equal(b.task('PB-203').due, plan.tasks[2].due);
});

test('the first real edit stops the sample from moving', async () => {
  const plan = fixture();
  plan.sampleAnchor = ymd(-5);
  const b = board(plan); await settled();
  assert.ok(b.get('state').sampleAnchor, 'still a sample before any edit');
  b.ctx.markDirty();
  assert.equal(b.get('state').sampleAnchor, undefined, 'an edit makes it the user\'s board');
});

/* ---------- clearing never leaves a board the ledger refuses (added 2026-10-13) ----------
   serve-dashboard.js rejects an empty task list. Clear used to write exactly
   that, so the documented first step of setup ended in SAVE FAILED. */
test('clearing the board leaves one starter task the ledger will accept', async () => {
  const b = board(); await settled();
  b.ctx.confirm = () => true; b.ctx.prompt = () => 'My Calibration Prep';
  b.ctx.clearBoard();
  const s = b.get('state');
  assert.equal(s.project, 'My Calibration Prep');
  assert.equal(s.tasks.length, 1, 'exactly one starter task');
  const t = s.tasks[0];
  ['id','key','title','section','start','due'].forEach(f => assert.ok(t[f], 'starter task missing ' + f));
  assert.ok(/^[A-Z]{2,6}-\d+$/.test(t.key), 'the starter task gets a real key: ' + t.key);
  assert.ok(s.sections.includes(t.section));
  assert.ok(t.due > t.start);
  assert.equal(s.backlog.length, 0);
  assert.equal(s.sampleAnchor, undefined, 'a cleared board is no longer a sample');
});

test('the last task cannot be deleted or sent to the backlog', async () => {
  const b = board(); await settled();
  b.ctx.confirm = () => true; b.ctx.prompt = () => 'Solo';
  b.ctx.clearBoard();
  const only = b.get('state').tasks[0];
  b.ctx.openId = only.id; vm.runInContext('openId = ' + JSON.stringify(only.id), b.ctx);
  b.ctx.deleteTask();
  assert.equal(b.get('state').tasks.length, 1, 'delete refused');
  b.ctx.confirmDemote();
  assert.equal(b.get('state').tasks.length, 1, 'send to backlog refused');
  assert.equal(b.get('state').backlog.length, 0);
});

test('a one-letter board name still gets a ticket prefix the ledger accepts', async () => {
  const b = board(); await settled();
  b.ctx.confirm = () => true; b.ctx.prompt = () => 'Q';
  b.ctx.clearBoard();
  const s = b.get('state');
  assert.ok(/^[A-Z]{2,6}$/.test(s.keyPrefix), 'prefix must be 2 to 6 letters, got ' + s.keyPrefix);
  assert.ok(/^[A-Z]{2,6}-\d+$/.test(s.tasks[0].key));
});

test('a sample anchor in the future never moves dates backwards', async () => {
  const plan = fixture();
  plan.sampleAnchor = ymd(30);
  const b = board(plan); await settled();
  assert.equal(b.get('state').targetDate, plan.targetDate);
});

/* ---------- board tabs (added 2026-10-13) ---------- */
test('the board opens on the board the server lists and draws one tab per board', async () => {
  const b = board(); await settled();
  assert.equal(b.get('BOARD_ID'), 'fixture-project');
  assert.equal(b.get('SAVE_URL'), 'api/boards/fixture-project', 'saves go to this board only');
  assert.equal(b.get('LS_KEY'), 'project_board_v1:fixture-project', 'the browser copy is per board');
  const html = b.byId('boardTabs').innerHTML;
  assert.match(html, /aria-current="page"[^>]*>Fixture Project</, 'the open board is marked current');
  assert.match(html, /\+ New board/);
});

test('a starter plan for a new board passes the ledger rules and keeps your columns', async () => {
  const b = board(); await settled();
  b.ctx.setColumnLabel(1, 'Queued');
  const plan = b.ctx.makeStarterPlan('Hiring Loops');
  assert.equal(plan.project, 'Hiring Loops');
  assert.equal(plan.tasks.length, 1);
  const t = plan.tasks[0];
  ['id','key','title','section','start','due'].forEach(f => assert.ok(t[f], 'missing ' + f));   // REQUIRED_TASK_FIELDS
  assert.ok(/^[A-Z]{2,6}-\d+$/.test(t.key), t.key);
  assert.ok(plan.sections.includes(t.section));
  assert.equal(plan.settings.columns[1].label, 'Queued', 'a new board inherits the column setup');
  assert.ok(plan.settings.columns.some(c => c.key === t.status), 'the starter task sits in a real column');
  assert.ok(t.due > t.start);
});

test('a rename shows on the tab straight away', async () => {
  const b = board(); await settled();
  vm.runInContext("state.project = 'Year-End Write-Ups'", b.ctx);
  b.ctx.renderBoardTabs();
  assert.match(b.byId('boardTabs').innerHTML, />Year-End Write-Ups</);
  assert.equal(b.get('BOARDS')[0].name, 'Year-End Write-Ups');
});

test('board ids are unique slugs', async () => {
  const b = board(); await settled();
  const list = [{ id: 'calibration-prep', name: 'x' }];
  assert.equal(b.ctx.slugId('Calibration Prep!', list), 'calibration-prep-2');
  assert.equal(b.ctx.slugId('🚀🚀', []), 'board');
  assert.equal(b.ctx.slugId('Résumé Reviews', []), 'resume-reviews');
});

test('browser mode adopts a board saved before tabs existed as the first tab', async () => {
  const b = board(); await settled();
  const legacy = { baseUpdated: null, savedAt: '2026-10-01', dirty: false, ledger: fixture(), state: Object.assign(fixture(), { project: 'Old Single Board' }) };
  b.ctx.localStorage.removeItem('project_board_index');
  b.ctx.localStorage.setItem('project_board_v1', JSON.stringify(legacy));
  b.ctx.loadLocalBoards();
  const boards = b.get('BOARDS');
  assert.deepEqual(boards, [{ id: 'old-single-board', name: 'Old Single Board' }]);
  const moved = JSON.parse(b.ctx.localStorage.getItem('project_board_v1:old-single-board'));
  assert.equal(moved.state.project, 'Old Single Board', 'the old copy is carried over, not lost');
});

test('the last board cannot be deleted', async () => {
  const b = board(); await settled();
  b.ctx.confirm = () => { throw new Error('must not even ask'); };
  await b.ctx.deleteCurrentBoard();
  assert.equal(b.get('BOARDS').length, 1);
});

test('criteria stored as plain text open as real criteria, not empty boxes', async () => {
  const plan = fixture();
  plan.tasks[2].acceptanceCriteria = ['Page inventory exported', { text: 'Owner signed off', done: true }, '   '];
  const b = board(plan); await settled();
  assert.deepEqual(JSON.parse(JSON.stringify(b.task('PB-203').acceptanceCriteria)),
    [{ text: 'Page inventory exported', done: false }, { text: 'Owner signed off', done: true }]);
});

test('browser mode with no saved boards opens every seed board as a tab', async () => {
  const b = board(); await settled();
  b.ctx.localStorage.removeItem('project_board_index');
  b.ctx.localStorage.removeItem('project_board_v1');
  b.ctx.loadLocalBoards();
  const seeds = b.get('SEEDS');
  const boards = b.get('BOARDS');
  assert.equal(boards.length, seeds.length);
  boards.forEach((bd, i) => {
    assert.equal(bd.name, seeds[i].project);
    assert.equal(b.ctx.seedFor(bd.id).project, seeds[i].project, 'each tab finds its own seed');
  });
});

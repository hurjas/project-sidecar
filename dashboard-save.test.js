/* Persistence tests for project-plan-dashboard.html.
 *
 * Why this file exists: on 2026-08-08 three verified status changes were lost.
 * Root cause was two defects working together — the board stayed fully
 * interactive when it had no server to save to, and even with a server it only
 * persisted on a deliberate click whose sole "unsaved" signal was a bullet in a
 * button label. Autosave and a read-only lock fixed it. These tests hold both.
 *
 * Run:  npm i -g jsdom   (once)
 *       node dashboard-save.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.error('SKIPPED: jsdom is not installed. Run "npm i -g jsdom" then set NODE_PATH=$(npm root -g).');
  process.exit(0);
}

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'project-plan-dashboard.html'), 'utf8');
const { fixture, MOVABLE, MOVABLE_ID, MOVABLE_2, MOVABLE_2_ID,
        EPIC, EPIC_ID, EPIC_CHILD, EPIC_CHILD_ID } = require('./dashboard-test-fixture.js');
const ledger = fixture();

const wait = ms => new Promise(r => setTimeout(r, ms));
const DEBOUNCE_PLUS = 900;   // autosave debounce is 600ms

/* Builds a live dashboard with a fake server. mode: ok | netfail | reject | nofetch */
function boot({ mode = 'ok', cache = null, ledger: led = null } = {}) {
  const served = led || ledger;
  const posts = [];
  const install = (w) => {
    const C = function () {
      return { destroy() {}, ctx: { save(){}, restore(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, setLineDash(){} },
               chartArea: { top: 0, bottom: 0 }, scales: { x: { getPixelForValue: () => 0 } } };
    };
    C.register = () => {};
    w.Chart = C;                                   // CDN tag jsdom will not fetch
    w.fetch = async (url, opt) => {
      if (!opt || opt.method !== 'POST') {
        if (mode === 'nofetch') throw new Error('Failed to fetch');   // this is file://
        if (/^api\/boards(\?|$)/.test(url)) {                         // the board list
          return { ok: true, status: 200, headers: { get: () => null },
                   json: async () => ({ ok: true, boards: [{ id: 'fixture-project', name: served.project }] }) };
        }
        return { ok: true, status: 200, headers: { get: h => /etag/i.test(h) ? '"rev-1"' : null },
                 json: async () => JSON.parse(JSON.stringify(served)) };
      }
      posts.push({ body: JSON.parse(opt.body), ifMatch: opt.headers && opt.headers['If-Match'] });
      if (mode === 'netfail') throw new Error('Failed to fetch');
      if (mode === 'reject') return { ok: true, status: 422, json: async () => ({ ok: false, errors: ['tasks[3] has an unknown section: Foo'] }) };
      if (mode === 'conflict') {
        const disk = JSON.parse(JSON.stringify(served));
        disk.tasks.find(t => t.key === MOVABLE).title = 'WRITTEN OUTSIDE THE BOARD';
        mode = 'ok';                                  // the retry after resolving must succeed
        return { ok: false, status: 409, json: async () => ({ ok: false, conflict: true, rev: '"rev-2"', plan: disk,
                 errors: ['tasks.json changed since this board loaded it.'] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, updated: '2026-08-08', backup: 'b',
               tasks: served.tasks.length, rev: '"rev-2"' }) };
    };
    if (cache) { try { w.localStorage.setItem('project_board_v1', JSON.stringify(cache)); } catch (e) {} }
  };
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'http://localhost:8080/project-plan-dashboard.html', beforeParse: install });
  const w = dom.window;
  // `let` at script top level is not a window property, so read it through eval.
  return { w, posts, get: n => w.eval(n), pill: () => w.document.getElementById('savePill').textContent,
           task: k => w.eval('state').tasks.find(x => x.key === k) };
}
const cachedBoard = () => ({ baseUpdated: ledger.updated, savedAt: '2026-08-08', dirty: false,
                             ledger, state: JSON.parse(JSON.stringify(ledger)) });

test('a status change saves itself, with no click', async () => {
  const d = boot(); await wait(300);
  const t = d.task(MOVABLE);
  d.w.moveTask(t, d.w.resolveTarget('in-progress'));
  assert.equal(d.posts.length, 0, 'must debounce, not write per keystroke');
  assert.equal(d.w.document.getElementById('saveBtn').hidden, true, 'no save button while autosave is queued');
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.posts.length, 1, 'exactly one write');
  assert.equal(d.posts[0].body.tasks.find(x => x.key === MOVABLE).status, 'in-progress');
  assert.equal(d.posts[0].ifMatch, '\"rev-1\"', 'the save must name the revision it was built on');
  assert.equal(d.get('dirty'), false);
  assert.match(d.pill(), /^Saved/);
  assert.equal(d.w.document.getElementById('saveBtn').hidden, true, 'the pill says Saved; a second Saved button is noise');
});

test('a burst of edits coalesces into one write', async () => {
  const d = boot(); await wait(300);
  [MOVABLE, MOVABLE_2, 'PB-205'].forEach(k => d.w.moveTask(d.task(k), d.w.resolveTarget('in-progress')));
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.posts.length, 1);
  assert.ok([MOVABLE, MOVABLE_2, 'PB-205'].every(k => d.posts[0].body.tasks.find(x => x.key === k).status === 'in-progress'));
});

test('a dead network keeps the edit and says so loudly', async () => {
  const d = boot({ mode: 'netfail' }); await wait(300);
  d.w.moveTask(d.task(MOVABLE), d.w.resolveTarget('done'));
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.get('dirty'), true, 'edit must not be marked saved');
  assert.match(d.pill(), /SAVE FAILED/);
  assert.equal(d.w.document.getElementById('saveBtn').disabled, false, 'retry must be clickable');
  assert.equal(d.w.document.getElementById('saveBtn').hidden, false, 'a failed save must show the retry button');
  assert.equal(d.w.document.getElementById('saveBtn').textContent, 'Retry save');
  assert.equal(d.task(MOVABLE).status, 'done', 'the edit itself survives');
});

test('a ledger rejection does not clear dirty', async () => {
  const d = boot({ mode: 'reject' }); await wait(300);
  d.w.moveTask(d.task(MOVABLE), d.w.resolveTarget('done'));
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.get('dirty'), true);
  assert.match(d.pill(), /SAVE FAILED/);
});

test('no server and no cache: read-only, no board', async () => {
  const d = boot({ mode: 'nofetch' }); await wait(400);
  assert.equal(d.get('canWrite'), false);
  assert.match(d.pill(), /READ-ONLY/);
  assert.equal(d.posts.length, 0);
});

test('read-only: the ARROW KEY path is refused too (regression, 2026-08-08)', async () => {
  // cardKey -> moveTask bypassed the first version of the lock entirely.
  const d = boot({ mode: 'nofetch', cache: cachedBoard() }); await wait(400);
  const before = d.task(MOVABLE).status;
  d.w.cardKey({ currentTarget: { dataset: { id: MOVABLE_ID } }, key: 'ArrowRight', preventDefault(){} });
  d.w.moveTask(d.task(MOVABLE), d.w.resolveTarget('done'));   // direct call, the choke point
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.task(MOVABLE).status, before, 'keyboard move must be refused');
  assert.equal(d.get('dirty'), false);
  assert.equal(d.posts.length, 0);
});

test('with a server, the arrow key still works and still autosaves', async () => {
  const d = boot(); await wait(300);
  const before = d.task(MOVABLE_2).status;
  d.w.cardKey({ currentTarget: { dataset: { id: MOVABLE_2_ID } }, key: 'ArrowRight', preventDefault(){} });
  await wait(DEBOUNCE_PLUS);
  assert.notEqual(d.task(MOVABLE_2).status, before, 'the lock must not break normal use');
  assert.equal(d.posts.length, 1);
});

test('no server but a cached board: every edit is refused', async () => {
  const d = boot({ mode: 'nofetch', cache: cachedBoard() }); await wait(400);
  assert.ok(d.get('state'), 'the board does render from cache');
  assert.equal(d.get('canWrite'), false);
  assert.ok(d.w.document.body.classList.contains('readonly'));
  assert.match(d.pill(), /READ-ONLY/);

  const before = d.task(MOVABLE).status;
  const nTasks = d.get('state').tasks.length;
  const nBacklog = d.get('state').backlog.length;

  d.w.dropCard({ preventDefault(){}, currentTarget:{ dataset:{ col:'done' } }, dataTransfer:{ getData: () => MOVABLE_ID } });
  d.w.cardStatusChange({ target:{ dataset:{ id:'disc-three' }, value:'done' } });
  d.w.newTask(); d.w.addBacklog(); d.w.deleteTask();
  await wait(DEBOUNCE_PLUS);

  assert.equal(d.task(MOVABLE).status, before, 'drag and dropdown must both be refused');
  assert.equal(d.get('state').tasks.length, nTasks, 'no task created');
  assert.equal(d.get('state').backlog.length, nBacklog, 'no backlog change');
  assert.equal(d.get('dirty'), false, 'nothing may be marked as a pending edit');
  assert.equal(d.posts.length, 0, 'no write attempted');
});

test('an outside write is not clobbered: the board shows a conflict and holds both', async () => {
  const d = boot({ mode: 'conflict' }); await wait(300);
  d.w.moveTask(d.task(MOVABLE), d.w.resolveTarget('in-progress'));
  await wait(DEBOUNCE_PLUS);

  assert.equal(d.get('conflict'), true, 'the board must know it is in conflict');
  assert.match(d.pill(), /CONFLICT/);
  assert.equal(d.task(MOVABLE).title, 'WRITTEN OUTSIDE THE BOARD', 'the disk version is now on screen');
  assert.ok(d.get('pendingLocal'), 'our version is held, not discarded');
  assert.equal(d.get('dirty'), false, 'nothing may be queued while a conflict is open');

  const postsBefore = d.posts.length;
  d.w.moveTask(d.task(MOVABLE_2), d.w.resolveTarget('in-progress'));   // keep working
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.posts.length, postsBefore, 'autosave must not retry into an open conflict');

  const banner = d.w.document.getElementById('banner').innerHTML;
  assert.match(banner, /Keep my edits/);
  assert.match(banner, /use the ledger/);
});

test('choosing "keep my edits" saves on the revision the server handed back', async () => {
  const d = boot({ mode: 'conflict' }); await wait(300);
  d.w.moveTask(d.task(MOVABLE), d.w.resolveTarget('in-progress'));
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.get('conflict'), true);

  d.w.keepLocal();
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.get('conflict'), false);
  const last = d.posts[d.posts.length - 1];
  assert.equal(last.ifMatch, '"rev-2"', 'the retry must use the revision the server reported');
  assert.equal(d.get('dirty'), false, 'and it must actually land');
  assert.match(d.pill(), /^Saved/);
});

test('choosing "use the ledger" clears the conflict and drops our copy', async () => {
  const d = boot({ mode: 'conflict' }); await wait(300);
  d.w.moveTask(d.task(MOVABLE), d.w.resolveTarget('in-progress'));
  await wait(DEBOUNCE_PLUS);

  d.w.takeLedger();
  assert.equal(d.get('conflict'), false);
  assert.equal(d.get('pendingLocal'), null);
  assert.equal(d.get('dirty'), false);
  assert.equal(d.task(MOVABLE).title, 'WRITTEN OUTSIDE THE BOARD');
  assert.match(d.pill(), /^Saved|^Unsaved/);
});

test('the create button is in the top bar, not buried in the filters', async () => {
  const d = boot(); await wait(300);
  const bar = d.w.document.querySelector('.topbar .actions').innerHTML;
  assert.match(bar, /newTask/, 'the create action must be in the top bar');
  assert.doesNotMatch(d.w.document.querySelector('.filters').innerHTML, /newTask/,
    'and not left behind in the filters row where it was missed');
});

test('creating a ticket persists it, which it never did before autosave', async () => {
  const d = boot(); await wait(300);
  const before = d.get('state').tasks.length;
  d.w.newTask();
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.get('state').tasks.length, before + 1);
  assert.equal(d.posts.length, 1, 'a new ticket must reach the ledger on its own');
  assert.equal(d.posts[0].body.tasks.length, before + 1);
  assert.equal(d.get('dirty'), false);
});

test('read-only mode refuses ticket creation', async () => {
  const d = boot({ mode: 'nofetch', cache: cachedBoard() }); await wait(400);
  const before = d.get('state').tasks.length;
  d.w.newTask();
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.get('state').tasks.length, before);
  assert.equal(d.posts.length, 0);
});

/* ---------- epics ---------- */
const openPanel = (w, id) => { w.openTask(id); };
const setSel = (w, id, v) => { w.document.getElementById(id).value = v; };
const setChk = (w, id, v) => { w.document.getElementById(id).checked = v; };
const shown = (w, id) => w.document.getElementById(id).style.display !== 'none';

test('epics are left out of the pace maths, exactly like milestones', async () => {
  const d = boot(); await wait(300);
  const plan = d.w.planTasks().map(t => t.key);
  assert.ok(!plan.includes(EPIC), 'an epic is a container, not work');
  assert.ok(!plan.includes('PB-207'), 'milestones stay excluded too');
  assert.ok(plan.includes(EPIC_CHILD), 'tickets inside an epic are still work');
});

test('adding an epic does not move the required pace', async () => {
  const d = boot(); await wait(300);
  const before = d.w.stats().required;
  d.w.newTask();
  const fresh = d.get('state').tasks[d.get('state').tasks.length - 1];
  openPanel(d.w, fresh.id);
  setChk(d.w, 'mEpic', true); d.w.onTypeToggle('epic');
  d.w.applyModal();
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.w.stats().required.toFixed(3), before.toFixed(3),
    'a grouping must not change what the release date demands');
});

test('ticking Epic swaps the fields in, and clears Milestone', async () => {
  const d = boot(); await wait(300);
  openPanel(d.w, MOVABLE_ID);
  assert.ok(shown(d.w, 'mEpicPick'), 'a normal ticket offers a parent epic');
  assert.ok(!shown(d.w, 'mEpicRoll'), 'and no rollup');

  setChk(d.w, 'mMile', true); d.w.onTypeToggle('mile');
  setChk(d.w, 'mEpic', true); d.w.onTypeToggle('epic');
  assert.equal(d.w.document.getElementById('mMile').checked, false, 'epic and milestone are mutually exclusive');
  assert.ok(!shown(d.w, 'mEpicPick'), 'an epic cannot sit inside an epic, so the picker goes away');
  assert.ok(shown(d.w, 'mEpicRoll'), 'and the rollup appears instead');
});

test('the epic rollup counts its children', async () => {
  const d = boot(); await wait(300);
  openPanel(d.w, EPIC_ID);
  assert.ok(shown(d.w, 'mEpicRoll'));
  const txt = d.w.document.getElementById('mEpicChildren').textContent;
  assert.match(txt, /1 of 2 done/, 'one of the two fixture children is done');
  assert.match(txt, new RegExp(EPIC_CHILD));
});

test('assigning a ticket to an epic saves and shows on the card', async () => {
  const d = boot(); await wait(300);
  openPanel(d.w, MOVABLE_ID);
  setSel(d.w, 'mEpicKey', EPIC);
  d.w.applyModal();
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.task(MOVABLE).epicKey, EPIC);
  assert.equal(d.posts.length, 1, 'the link must reach the ledger');
  assert.equal(d.posts[0].body.tasks.find(t => t.key === MOVABLE).epicKey, EPIC);
  assert.match(d.w.document.getElementById('board').innerHTML, /Checkout Page/, 'the card carries an epic tag');
});

test('the epic picker never offers the ticket itself', async () => {
  const d = boot(); await wait(300);
  openPanel(d.w, EPIC_ID);
  d.w.fillEpicPicker(d.task(EPIC));
  const opts = [...d.w.document.getElementById('mEpicKey').options].map(o => o.value);
  assert.ok(!opts.includes(EPIC), 'a ticket cannot be its own epic');
});

test('filtering by epic shows the epic and its children only', async () => {
  const d = boot(); await wait(300);
  setSel(d.w, 'fEpic', EPIC);
  const keys = d.w.visibleTasks().map(t => t.key).sort();
  assert.deepEqual(keys, [EPIC, 'PB-209', 'PB-210'].sort());
  setSel(d.w, 'fEpic', '');
  assert.equal(d.w.visibleTasks().length, d.get('state').tasks.length, 'clearing the filter restores everything');
});

test('the epic filter list is rebuilt from real epics and survives a redraw', async () => {
  const d = boot(); await wait(300);
  const opts = [...d.w.document.getElementById('fEpic').options].map(o => o.value);
  assert.deepEqual(opts, ['', EPIC]);
  setSel(d.w, 'fEpic', EPIC);
  d.w.renderAll();
  assert.equal(d.w.document.getElementById('fEpic').value, EPIC, 'the chosen epic must not be reset by a redraw');
});

test('demoting an epic releases its children instead of orphaning them', async () => {
  const d = boot(); await wait(300);
  openPanel(d.w, EPIC_ID);
  setChk(d.w, 'mEpic', false); d.w.onTypeToggle('epic');
  d.w.applyModal();
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.task(EPIC).epic, false);
  assert.equal(d.task('PB-209').epicKey, null, 'no ticket may point at a thing that is not an epic');
  assert.equal(d.task('PB-210').epicKey, null);
});

test('a link to a deleted epic is cleaned up on load, not left dangling', async () => {
  const bad = fixture();
  bad.tasks = bad.tasks.filter(t => t.key !== EPIC);        // the epic is gone
  const d = boot({ ledger: bad }); await wait(300);
  assert.equal(d.task('PB-209').epicKey, null);
  assert.equal(d.task('PB-210').epicKey, null);
});

test('search matches the epic name as well as the ticket', async () => {
  const d = boot(); await wait(300);
  d.w.document.getElementById('q').value = 'Checkout Page';
  const keys = d.w.visibleTasks().map(t => t.key);
  assert.ok(keys.includes('PB-209'), 'a child is findable by its epic name');
});

test('read-only mode refuses an epic change', async () => {
  const d = boot({ mode: 'nofetch', cache: cachedBoard() }); await wait(400);
  openPanel(d.w, MOVABLE_ID);
  setSel(d.w, 'mEpicKey', EPIC);
  d.w.applyModal();
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.task(MOVABLE).epicKey, null);
  assert.equal(d.posts.length, 0);
});

/* ---------- the title field ---------- */
test('the title is a real labelled form field, styled like the rest', async () => {
  const d = boot(); await wait(300);
  openPanel(d.w, MOVABLE_ID);
  const input = d.w.document.getElementById('mTitle');
  const wrap = input.closest('.field');
  assert.ok(wrap, 'the title must sit inside .field so it inherits the shared input styling');
  const label = wrap.querySelector('label[for="mTitle"]');
  assert.ok(label, 'it needs a label like every other field');
  assert.equal(label.textContent.trim(), 'Title');
});

test('a new ticket opens with its placeholder title selected', async () => {
  const d = boot(); await wait(300);
  d.w.newTask();
  const input = d.w.document.getElementById('mTitle');
  assert.equal(input.value, 'New task', 'it cannot be blank: the server requires a title and autosave fires at once');
  assert.equal(input.selectionStart, 0, 'and it is selected so typing replaces it');
  assert.equal(input.selectionEnd, 'New task'.length);
});

test('the title says how many characters are left, and warns near the cap', async () => {
  const d = boot(); await wait(300);
  openPanel(d.w, MOVABLE_ID);
  const input = d.w.document.getElementById('mTitle');
  const out = d.w.document.getElementById('mTitleCount');

  input.value = 'Short'; d.w.titleCount();
  assert.match(out.textContent, /65 characters left/);
  assert.equal(out.className, '', 'no warning when there is room');

  input.value = 'x'.repeat(65); d.w.titleCount();
  assert.equal(out.className, 'near', 'warn before typing silently stops');

  input.value = 'x'.repeat(70); d.w.titleCount();
  assert.match(out.textContent, /At the 70 character limit/);
});

test('an empty title is still refused, and the ticket keeps its old one', async () => {
  const d = boot(); await wait(300);
  openPanel(d.w, MOVABLE_ID);
  const was = d.task(MOVABLE).title;
  d.w.document.getElementById('mTitle').value = '   ';
  d.w.applyModal();
  await wait(DEBOUNCE_PLUS);
  assert.equal(d.task(MOVABLE).title, was, 'a blank title must not reach the ledger');
});

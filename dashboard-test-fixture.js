/* A frozen plan for the dashboard tests.
 *
 * These suites used to load the live tasks.json. That made them lie in both
 * directions: on 2026-08-09 four tests broke because real tickets had moved to
 * done, and one "failure" was actually the server validator correctly refusing a
 * task with a done date and a status of in-progress. Tests that read live data
 * cannot tell a regression from a Tuesday. The fixture never changes.
 */
const SECTIONS = ['Discovery', 'Delivery', 'Launch'];

function task(key, id, over) {
  return Object.assign({
    id, key, title: id.replace(/-/g, ' '), section: SECTIONS[0],
    start: '2026-07-14', due: '2026-08-20', done: null,
    status: 'not-started', milestone: false, epic: false, epicKey: null, description: '',
    acceptanceCriteria: [], history: []
  }, over || {});
}

function fixture() {
  return {
    project: 'Fixture Project',
    goal: 'Exercise the board without touching the real plan',
    targetDate: '2026-08-30',
    created: '2026-07-14',
    updated: '2026-08-01',
    rules: ['Fixture. Not the real plan.'],
    sections: SECTIONS.slice(),
    tasks: [
      task('PB-201', 'disc-one', { done: '2026-07-19', status: 'done' }),
      task('PB-202', 'disc-two', { status: 'ready-for-testing' }),
      task('PB-203', 'disc-three'),
      task('PB-204', 'disc-four'),
      task('PB-205', 'disc-five', { status: 'in-progress' }),
      task('PB-206', 'delivery-one', { section: SECTIONS[1] }),
      task('PB-207', 'launch-milestone', { section: SECTIONS[2], milestone: true, due: '2026-08-30' }),
      task('PB-208', 'epic-checkout', { epic: true, title: 'Checkout Page' }),
      task('PB-209', 'checkout-child-one', { epicKey: 'PB-208' }),
      task('PB-210', 'checkout-child-two', { epicKey: 'PB-208', done: '2026-08-01', status: 'done' })
    ],
    backlog: [
      { key: 'PB-291', text: 'A backlog idea that must not be counted as plan work' },
      { key: 'PB-292', text: 'A second idea, so ordering has something to move' }
    ],
    schemaVersion: 4,
    keyPrefix: 'PB',
    nextKeyNum: 293
  };
}

// A task that is safe to move around in every test: open, no done date.
const MOVABLE = 'PB-203';
const MOVABLE_ID = 'disc-three';
const MOVABLE_2 = 'PB-204';
const MOVABLE_2_ID = 'disc-four';

const EPIC = 'PB-208';
const EPIC_ID = 'epic-checkout';
const EPIC_CHILD = 'PB-209';
const EPIC_CHILD_ID = 'checkout-child-one';

module.exports = { fixture, SECTIONS, MOVABLE, MOVABLE_ID, MOVABLE_2, MOVABLE_2_ID,
                   EPIC, EPIC_ID, EPIC_CHILD, EPIC_CHILD_ID };

# Project SideCar

A task board with one tab per project. Each project has its own tasks, charts,
backlog and settings. It ships with four example projects:

- Project 1
- Project 2
- Project 3
- Project 4

Every status change is dated, so each board doubles as a record of what moved
and when. One HTML file, JSON files, an optional Node server. No build step, no
framework, no account. Your data stays on your machine.

## Run it

Two ways. Pick one.

### Open the file (quick look)

Unzip the folder and double-click `project-plan-dashboard.html`.

The four example projects open with their starter tasks. Every change saves to
your browser automatically. Clearing your browser data clears the board, so use Export to
keep a copy.

### Run the server (recommended for real use)

Use this to store your boards on disk in the `boards/` folder, with a backup
before every write.

1. Install Node 18 or newer from https://nodejs.org. Check with `node -v`.
2. Start the board:
   - Windows: double-click `start-dashboard.bat`.
   - Mac or Linux: run `./start-dashboard.sh`. On a permission error, run
     `chmod +x start-dashboard.sh` first.
   - Any OS: run `node serve-dashboard.js`.
3. Open http://localhost:8080/project-plan-dashboard.html if the browser does
   not open on its own.
4. Keep the terminal window open while you work. Press Ctrl+C to stop.

Port 8080 taken? Run `PORT=8090 node serve-dashboard.js` (Mac or Linux) or
`set PORT=8090 && node serve-dashboard.js` (Windows), then open port 8090.

## Make it yours

Each board starts with a few example tasks. Rename the projects and edit or
delete the tasks.

1. Open a project tab, then Settings.
2. Write a one-sentence goal for the project and set a target date.
3. Adjust the sections, one per line.
4. Write 3 to 5 rules, such as what the project will not take on this quarter.
5. Click Save board details.
6. Add tasks with + New ticket. Keep them high level: milestones, decisions,
   launches. Detailed work belongs in each project's own tracker.
7. Add a project later with + New board in the tab row.

Settings also lets you rename, recolour, reorder, add and remove the board
columns, and decide which column means new, which means done, and where a
failed verification sends a task. Column keys never change, so a rename cannot
orphan a task or break its history.

## Boards

Keep separate boards for separate areas of work, such as Calibration, Hiring
and Mentoring. Each board has its own tasks, charts, backlog and settings.

- Boards sit in a row of tabs at the top of the page. Click a tab to switch.
- Click + New board and give it a name. The new board opens with one starter
  task and the same columns as the board you were on.
- Rename a board in Settings. The tab follows the board name.
- Delete a board with Delete this board in Settings. The last board cannot be
  deleted.
- The page remembers the board you had open. The address bar carries
  `?board=<id>`, so a bookmark opens that board directly.
- Switching boards saves any pending edit first. If a save cannot land, the
  board asks before it switches, and the edit stays in your browser.

With the server running, each board is one file, `boards/<id>.json`, listed in
`boards/index.json`. A deleted board moves to `boards/deleted/` with a
timestamp, so recovering one means moving the file back and restarting the
server. The id comes from the board name when the board is created and never
changes, so a rename never moves a file.

On first start the server turns each file in `seeds/` into a board, in file-name
order. The seed files are never written. Your live boards are in `boards/`.

In browser mode each board is stored separately in this browser. Deleting a
board there cannot be undone, so Export first.

## How the board works

Columns are the ticket lifecycle:

- Needs Decision. Blocked on a human choice, not on work.
- Not Started
- In Progress
- Ready to Verify. Built, waiting to be checked against the acceptance criteria.
- Done

Failed is an action, not a column. When a ticket in Ready to Verify does not
hold up, send it back to In Progress and the failure is recorded in its history.
Nothing named failed ever gets stored, so the board cannot show you a status
your data does not support.

Sections group tickets into areas of responsibility or phases. You define them
in Settings.

Epics group tickets across sections. Mark a ticket as an epic and other tickets
can point at it. Epics stay out of the pace maths, the same as milestones, so
a container ticket never inflates your progress.

Acceptance criteria are a checklist on each ticket. They exist so Done means
verified rather than coded.

History records every status change with a date and an optional note. This is
what turns the board into a record of what happened instead of a snapshot of
what is true today.

## The charts

- Timeline. Open tickets against the calendar, grouped by section, with the
  target date as the wall. Milestones are markers on the time axis, not rows.
  An overdue ticket draws a hatched slip bar from its due date to today and
  labels how many days late it is. Rows click through to the ticket. Completed
  work is hidden by default behind Show completed.
- Burndown. Open tickets over time against the line you need to be on.
- Velocity. Tickets finished per week, on a rolling 10-week window anchored on
  today. Whole project switches to the full range.
- Pace. What you need per week versus what you have delivered and what you did
  this week.
- Workload. Where the open work sits, on the same 10-week window.

The pace badge in the header goes red when you have overdue tickets or when your
delivered pace falls below the pace you need. It reads from your data, not from
a setting.

## The ledger

Each board is one JSON file. Readable, diffable.

```
project      the board name
goal         one sentence describing done
created      when work started
targetDate   the date the charts measure against
sections     area or phase names, in order
rules        the decisions you want to stop relitigating
tasks        every ticket
backlog      ideas kept out of the plan on purpose
keyPrefix    names your tickets, so WR gives you WR-101
```

Each ticket carries an id, key, title, section, start, due, done, status,
milestone, epic, epicKey, description, acceptanceCriteria, and history.

## What protects your data

This board was built after a real incident where a plan was silently rebuilt
from stale memory. The protections are deliberate.

- Every write to a board takes a timestamped backup first, next to the board
  in `boards/`. Each board keeps its own 25 most recent backups plus the first
  backup of every day.
- Saves carry the revision they were built on. If the file changed underneath
  you, the save is refused and nothing is overwritten. The board shows you what
  is on disk and holds your version to one side so you choose.
- The server validates every save. An unknown section, an unknown status, a
  ticket marked done with no done date, or an empty task list is rejected rather
  than written.
- Edits autosave. A Save now button appears only when a save fails or restored
  edits need writing.
- In browser mode the board writes to localStorage on every change. Clearing
  your browser data clears the board, so export a copy for anything you care
  about.

## Tests

```
npm install
npm test
```

113 tests across three suites. They cover autosave and debouncing, save
conflicts, server validation, the read-only path, standalone browser mode,
epics, ticket creation, the settings panel, the seeded boards, clearing
the board, and creating, switching, renaming and deleting boards.

The tests run against a frozen fixture, never against your live board. A test
suite that reads live data cannot tell a regression from a Tuesday.

## Files

```
project-plan-dashboard.html   the board, everything in one file
seeds/                        the four example boards, copied into boards/ on first start
boards/                       your boards (created by the server, not in Git)
serve-dashboard.js            static server plus the save endpoint
start-dashboard.bat           Windows launcher
start-dashboard.sh            Mac and Linux launcher
vendor/chart.umd.min.js       Chart.js 4.4.1, vendored so it works offline
dashboard-save.test.js        board behavior tests
dashboard-server.test.js      server and validation tests
dashboard-settings.test.js    settings, backlog and board tests
dashboard-test-fixture.js     the frozen test board
package.json                  scripts and the one test dependency
```

## Limits

Read these before you commit to the tool.

- Up to 50 boards per folder.
- One person per board. No users, no assignments, no permissions, no sharing.
- The server answers on your own machine only (127.0.0.1).
- No notifications and no integrations, Jira included.
- Browser mode stores the board in one browser on one machine. Use server mode
  for anything you care about.
- Dates are stored as plain YYYY-MM-DD with no timezone. Weeks run Sunday to
  Saturday.
- The Done column shows the newest 15 tickets and collapses the rest behind a
  Show all button. That is a display limit only. Nothing is deleted or archived,
  and every chart still counts every done ticket. Change it in Settings, or set
  it to 0 to show them all.

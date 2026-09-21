PERSONAL WORK PLANNING - FINAL SECURE PORTAL
README

------------------------------------------------------------
1. HOW TO RUN
------------------------------------------------------------
This is a fully local, offline, dependency-free web app. It has no
build step, no server, and no network calls of any kind.

1. Keep index.html, style.css, and script.js together in the SAME
   folder at all times. If you received these as a ZIP, extract the
   ZIP fully before opening the app - do not open index.html from
   inside the ZIP.
2. Double-click index.html. It will open in your default browser.
3. Recommended browsers: current Microsoft Edge or Google Chrome
   on macOS (MacBook Pro) or Windows. Other Chromium-based browsers
   will also work for the core portal; the optional Auto Backup
   feature specifically requires Edge or Chrome because it depends
   on the File System Access API.
4. No installation, npm, or internet connection is required or used.

------------------------------------------------------------
2. WHERE YOUR DATA LIVES
------------------------------------------------------------
All workbook data is stored ONLY in your browser's localStorage, on
your own machine, under these exact keys:

  workPlanningFinal.v2.data                   - the full workbook
  workPlanningFinal.v2.selectedSheet           - last page you viewed
  workPlanningFinal.v2.filters                 - filters per page
  workPlanningFinal.v2.safeManualColumnWidths  - manual column widths

(Note: these internal storage/IndexedDB key names are unchanged from
the previous "Work Planning" build on purpose, so that any data you
already saved in your browser keeps working with this renamed
"Personal Work Planning" version. Only the visible app name, page
title, and exported file names were updated.)

Nothing is ever sent anywhere. The page's Content Security Policy
blocks all outgoing network connections (connect-src 'none'), and
the app itself never calls fetch, XMLHttpRequest, WebSocket, or any
other network API.

Every change (typing, status changes, add/copy/delete/move rows,
imports, resets) is saved to localStorage immediately, so closing
the tab or restarting the computer does not lose your data.

Because your data loads from localStorage before anything else, if a
page is ever renamed, restructured, or removed in an update (as
happened with the old Important TimeLines and Rough Notes pages -
see section 3 for the current page list), the app automatically
upgrades your already-saved data to match on the next time you open
it.

------------------------------------------------------------
3. THE FIVE WORKBOOK PAGES
------------------------------------------------------------
Pages appear as pill-style buttons in the header, in this exact
order. Each pill shows a short name to keep all of them fitting on
one row (especially on a phone); hover over a pill (or check the
page title once selected) to see its full name:

1. Daily planning - All tasks (nav pill: "Daily")
   Columns: Date, Project, Priority, Task/Meeting, Raised by,
   Work with, Next steps, Due date, Status.
   Starts with one seeded row (Project "AA", Priority "1").

2. Week planning (nav pill: "Week")
   Columns: Section, Monday, Tuesday, Wednesday, Thursday, Friday.
   Starts with rows Section 1-10, "Added today", then 1-10 again,
   with all weekday cells blank.

3. All future Tasks (nav pill: "Future")
   Same 9 columns as Daily planning. Starts with 26 blank rows,
   each with Project "ee".

4. Road Map - Pending (nav pill: "Roadmap")
   Columns: Project, Task/Meeting, Notes.

5. Completed tasks (nav pill: "Completed")
   Same 9 columns as Daily planning. Starts empty and is always the
   last page in the list, so completed/archived items sit out of the
   way of your active pages. Rows only ever arrive here automatically
   (see section 4) or via Reset/Import.

------------------------------------------------------------
4. MOVING TASKS BETWEEN PAGES
------------------------------------------------------------
- On "Daily planning - All tasks" only, changing a row's Status to
  "Complete" immediately removes it from that page and inserts it
  at the TOP of "Completed tasks" with Status forced to "Complete".
  On every other page, changing Status simply saves the new value.
- "Daily planning - All tasks" and "All future Tasks" each have a
  "Move" button (in addition to Copy and Delete) that sends the row
  the other way and adds it to the BOTTOM of the destination page:
    - Move on "Daily planning - All tasks" -> appends the row to
      the bottom of "All future Tasks".
    - Move on "All future Tasks" -> appends the row to the bottom
      of "Daily planning - All tasks".
  No other page has a Move button.

------------------------------------------------------------
5. EDITING, FILTERING, AND SORTING
------------------------------------------------------------
- Ordinary cells are click-to-edit. Click into a cell to see the
  plain saved text with an orange focus highlight; press Enter (with
  or without Shift) to add a line break within the cell. Your edit
  is saved when the cell loses focus - click elsewhere, press Tab,
  or move to another cell. Pasting always pastes as plain, sanitized
  text.
- Status cells (on the three task pages) are colored dropdowns:
  Select status (blank/purple), Complete (green), In-Progress
  (blue), Not started (gray), Hold (amber).
- Priority and Project values are shown as colored pills when not
  being edited (Priority: 1/P1/High/Urgent/Critical = red,
  2/P2/Medium/Med = amber, 3/P3/Low = green, 4/P4/Backlog/Optional
  = blue, anything else non-blank = purple. Project: contains "AA"
  = purple, "DD" = light blue, "RR" = green, "TT" = amber, otherwise
  gray).
- Every column has its own filter row directly under the header
  with a text search box and a dropdown of "All values", "(Blank)",
  and every distinct value currently used in that column. All active
  filters combine together (AND logic). Filters are remembered
  separately per page, even after closing the browser.
- Click any column header to sort by that column: first click sorts
  ascending (case-insensitive) with an up arrow, a second click
  sorts descending with a down arrow, and a third click clears the
  sort. Clicking inside a filter box or dropdown never triggers
  sorting.
- The "Clear" button in the Actions column of the filter row clears
  filters for the CURRENT page only.

------------------------------------------------------------
6. THE CALENDAR-PICKER DUE DATE COLUMN
------------------------------------------------------------
The Due date column on "Daily planning - All tasks" uses a special
calendar-picker control instead of plain text editing. It looks and
behaves like a plain, read-only text box (blank shows as completely
blank, with no placeholder). Clicking or focusing it switches it into
a real date picker; your browser's native calendar opens
automatically where supported. Picking a date saves it as MM/DD/YYYY
and the box returns to its plain read-only look. Clearing the date
returns the cell to blank.

------------------------------------------------------------
7. ADD ROW
------------------------------------------------------------
"+ Add Row" (also available as a floating button fixed to the
bottom-right of the window) appends a new blank row to the current
page (auto-filling today's date, in MM/DD/YYYY, if the page has a
Date column), then automatically scrolls that new row smoothly into
the center of the screen, briefly highlights it pale green, and
places your cursor in its first editable field. Each page is capped
at 5,000 rows; past that, you'll see an alert instead of a new row.

------------------------------------------------------------
8. COPY, MOVE, DELETE, RESET
------------------------------------------------------------
- Copy duplicates a row directly beneath itself (subject to the
  5,000-row cap).
- Move (available on "Daily planning - All tasks" and "All future
  Tasks" only) sends the row to the other of those two pages and
  appends it to the BOTTOM of that page's list.
- Delete asks "Delete this row from the local portal?" before
  removing the row.
- "Reset" (Reset Sheet) asks "Clear all rows from this sheet?" and, if
  confirmed, empties every row on the CURRENT page only (also
  clearing that page's saved filters). It works identically and
  completely on every one of the five pages, leaving zero rows
  behind - even pages that started with seeded example data.

------------------------------------------------------------
9. IMPORT / EXPORT JSON
------------------------------------------------------------
- "Export" (Export JSON) downloads the entire workbook (all five
  pages) as a nicely indented (2-space) file named
  personal-work-planning-local-backup.json.
- "Import" (Import JSON) opens a file picker limited to .json files.
  Files larger than 2 MiB are rejected with "Backup file is too
  large." Selected files are parsed and fully validated/normalized
  before anything changes. You will be asked to confirm: "Import
  this JSON backup and replace all current local data?" If the file
  is invalid, you'll see "Import blocked: " followed by the specific
  reason. If the file cannot be read at all, you'll see "Could not
  read selected file." On a successful import, the workbook is
  replaced, the view jumps to the first page, and all filters are
  cleared.
- Older backups that predate the "Completed tasks" page, or that
  still have the old Important TimeLines / Rough Notes pages, are
  automatically upgraded on load/import - missing pages are added,
  removed ones are dropped, and everything else is kept as-is.

------------------------------------------------------------
10. EXPORT CSV
------------------------------------------------------------
"CSV" (Export CSV) downloads only the CURRENTLY SELECTED page as a
CSV file (named after the page, e.g. daily-planning-all-tasks.csv).
As a formula-injection safeguard, any cell that starts with =, +,
-, @, a tab, or a carriage return is prefixed with a leading
apostrophe before being written out, so opening the CSV in Excel or
similar spreadsheet software cannot trigger unexpected formulas.
Quotes are doubled and fields containing commas, quotes, or line
breaks are quoted per standard CSV rules.

------------------------------------------------------------
11. AUTO BACKUP
------------------------------------------------------------
This is an OPTIONAL, extra layer of protection on top of the always
-on localStorage saving described in section 2. The app now offers
two different modes depending on what your browser supports, so it
works on Chrome/Edge AND on Safari:

CHROME / EDGE / OPERA (File System Access support):
- Click "Backup" (Enable Auto Backup). You will be asked to choose/
  create a real, visible file on your disk (suggested name
  personal-work-planning-autobackup.json). The app remembers this
  file handle both in memory and in your browser's IndexedDB
  database (workPlanningFinal.v2.autoBackup, object store
  "handles"), so it can be reused automatically the next time you
  open the app.
- The whole workbook is written to that file immediately after you
  pick it, and again (debounced by 250ms, with protection against
  overlapping writes) every time you make a change while auto
  backup is enabled.
- Because browsers require the user to re-approve file access after
  a restart, if you reopen the app later the button may read
  "Resume" instead of "Backup On" - just click it once to
  reauthorize. If something goes wrong the button turns red and
  reads "Error". Hover/long-press the button any time for the full
  description of its current state.
- Canceling the file picker does nothing (no error, no change).

SAFARI / FIREFOX (no File System Access picker):
Apple's WebKit engine (Safari, on macOS and iOS) and Firefox do not
implement the browser picker API (showSaveFilePicker) that the mode
above depends on - this is a platform limitation of those browsers,
not something a web page can add on its own. Rather than showing a
dead-end error, the app automatically switches to a second, fully
working mode in these browsers:
- Click "Backup" once. The app immediately writes the full workbook
  into your browser's IndexedDB storage (still 100% local, still
  never leaves your device) and the button turns green and reads
  "Backup On".
- From then on, every change you make is automatically written into
  that IndexedDB backup too (debounced by 250ms, same as the Chrome/
  Edge mode), completely silently, with no picker and no repeated
  permission prompts - and, unlike the Chrome/Edge mode, it stays
  enabled across restarts with nothing further to click.
- Because this backup lives in browser storage rather than as a
  plain file in Finder, click the (now green) "Backup On" button
  again any time to instantly download a real, portable .json copy
  of it - the button briefly shows "Saved!" for confirmation.
- If your browser has no local storage (IndexedDB) available at
  all, which is extremely rare, you'll see: "Automatic backup
  requires a browser with local storage (IndexedDB) support, which
  is not available here."

In both modes, localStorage (section 2) remains the primary,
always-on save mechanism regardless of whether Auto Backup is
enabled at all - Auto Backup is always a secondary safety net, never
a replacement for it.

------------------------------------------------------------
12. MANUAL COLUMN RESIZING
------------------------------------------------------------
Drag the thin handle on the right edge of any column header
(including the Actions column) to resize it. Each page remembers
its own column widths separately, saved locally under
workPlanningFinal.v2.safeManualColumnWidths, and widths are
reapplied automatically every time you return to that page.

------------------------------------------------------------
13. ROW LIMITS AND SAFETY
------------------------------------------------------------
- Maximum 5,000 rows per page (enforced on Add Row and Copy Row).
- Maximum 2 MiB for JSON files you import.
- All user-entered text is sanitized (control characters stripped,
  length capped) before it is stored or displayed.
- The app never uses innerHTML, outerHTML, insertAdjacentHTML,
  document.write, eval, or the Function constructor. All on-screen
  elements are built safely with createElement, textContent,
  replaceChildren, appendChild, classList, and addEventListener, so
  pasted or imported text can never be interpreted as HTML or script.
- A strict Content Security Policy in index.html blocks all network
  connections, external scripts/styles, plugins, and framing.

------------------------------------------------------------
14. TROUBLESHOOTING
------------------------------------------------------------
- If the page looks unstyled, make sure style.css is in the same
  folder as index.html (it will not load from a different folder or
  over the network).
- If Auto Backup keeps asking you to "Resume", that's expected
  browser behavior after a restart - click it once per session.
- To start completely fresh, use "Reset" on each page, or clear this
  site's data/localStorage from your browser settings.

------------------------------------------------------------
15. INSTALLING AS AN APP ON YOUR IPHONE (PWA)
------------------------------------------------------------
This delivery now includes everything needed to install the portal
as a real, full-screen, icon-on-your-Home-Screen app on iPhone:
manifest.json (the web-app manifest), apple-touch-icon.png,
icon-192.png, and icon-512.png (the app icon at the sizes iOS/other
platforms expect), plus the matching <meta>/<link> tags already
added to index.html.

IMPORTANT - a plain double-clicked/local index.html cannot be
installed this way. iOS blocks running a local, multi-file HTML
page's CSS/JavaScript from Safari or any other browser (this is an
Apple platform restriction, not something these files can work
around - see the "why" note below). The manifest and icons only
take effect once the app's files are served from a real https://
web address, which is a one-time, completely free setup:

  1. Create a free GitHub account at github.com, if you don't
     already have one.
  2. Create a new PUBLIC repository (e.g. "personal-work-planning").
  3. On the repository page, click "Add file" -> "Upload files" and
     drag in all the files from this folder (index.html, style.css,
     script.js, manifest.json, apple-touch-icon.png, icon-192.png,
     icon-512.png). Commit the upload.
  4. Go to the repository's Settings tab -> Pages (in the left
     sidebar) -> under "Build and deployment", set Source to
     "Deploy from a branch", Branch to "main" / "/(root)", then
     Save.
  5. After a minute or two, GitHub shows your live URL, something
     like: https://yourusername.github.io/personal-work-planning/
  6. On your iPhone, open that URL in Safari.
  7. Tap the Share icon, then "Add to Home Screen".
  8. You now have a real app icon. Tapping it opens the portal
     full-screen, with no browser address bar - it behaves like a
     native app from then on.

Any other free static host works the same way (Netlify, Vercel,
Cloudflare Pages, etc.) - GitHub Pages is simply the most widely
used free option requiring no payment details.

WHAT STAYS PRIVATE: the repository/hosted files only contain the
app's CODE (the same index.html/style.css/script.js described
throughout this document) - never your actual task data. Your tasks
live only in that installed app's local browser storage on your own
iPhone (see section 2), exactly as before; nothing you type is ever
uploaded to GitHub, this host, or anywhere else. Do keep in mind
that on GitHub's free tier the repository/URL is technically public
(reachable by anyone who has the link, even though it isn't listed
anywhere) - if that matters to you, a paid GitHub/host plan can make
it private, or you can use any host that supports private hosting.

WHY A PLAIN LOCAL FILE CAN'T DO THIS: as of recent iOS versions,
Apple removed the ability for Safari (or any other iOS browser -
they're all required to use the same underlying engine as Safari)
to run a local, multi-file HTML page's linked CSS and JavaScript.
Opening index.html directly from the Files app only shows a static,
non-interactive preview. Hosting the files at a real web address
(steps above) sidesteps this entirely, and is also what finally lets
"Add to Home Screen" install it as a proper standalone app instead
of just bookmarking a browser tab.

MOVING YOUR EXISTING DATA TO THE INSTALLED APP: once installed, the
new app has its own separate, empty local storage - it does not
automatically inherit tasks from any other browser/device. Use
Export JSON wherever your current data lives, get that .json file
onto your iPhone (AirDrop, iCloud Drive, email to yourself, etc.),
then use Import JSON inside the newly-installed app to bring it in.
From then on, that installed app is fully self-contained on your
iPhone - Auto Backup, Export/Import, and every other feature
described in this document all work exactly as they do anywhere
else (see section 16 below for how the on-screen layout itself
adapts on a phone-width screen).

------------------------------------------------------------
16. THE MOBILE (PHONE-WIDTH) LAYOUT
------------------------------------------------------------
Below roughly 680px wide - i.e. on an iPhone, whether in the
installed app or just in Safari - the page layout changes to stay
usable on a small screen:

- The logo, "Personal Work Planning" title, and subtitle are hidden
  entirely to leave more room for task details - the highlighted
  pill in the nav row already shows which page you're on. All five
  page pills and all six action buttons keep to a single row each
  (see section 17) instead of wrapping or scrolling off-screen.
- The "CURRENT PAGE" label and the full page-name heading (e.g.
  "Daily planning - All tasks") are also hidden, for the same
  reason.
- EVERY page shows just ONE row at a time. A "Previous" / position /
  "Next" bar for moving between rows sits at the BOTTOM of the page,
  below the row itself - see section 18.
- Within that one row, short fields (Date, Priority, Status, Due
  date, Raised by, Work with, weekday cells, and similar) are paired
  up two-per-row instead of each taking a full line, and longer
  free-text fields (Task/Meeting, Next steps, Notes), Project on the
  three task-schema pages, and the Copy/Move/Delete buttons still
  take the full width - see section 18 for the full explanation of
  the exact row layout on each page.
- Column sorting and the per-column filter row are hidden at this
  width, since they depend on the column-header row this layout
  removes to make room for the cards. They are unaffected and fully
  available as soon as the screen is wider than 680px (an iPad in
  landscape, or any desktop/laptop browser window).

------------------------------------------------------------
17. SHORT PAGE AND BUTTON NAMES
------------------------------------------------------------
To keep every page pill and every action button fitting on a single
row (most noticeably on a phone, but this applies everywhere), pages
and buttons now show a short label. The action each one performs is
unchanged - only the visible text is shorter. Hover over (or
long-press) any pill or button to see its full name as a tooltip.

Page pills:
  "Daily"     = Daily planning - All tasks
  "Week"      = Week planning
  "Future"    = All future Tasks
  "Roadmap"   = Road Map - Pending
  "Completed" = Completed tasks

Action buttons:
  "+ Add"   = Add Row
  "Export"  = Export JSON
  "Backup"  = Enable Auto Backup (see section 11 for its other states)
  "Import"  = Import JSON
  "CSV"     = Export CSV
  "Reset"   = Reset Sheet
The floating round button at the bottom-right of the screen still
reads "+ Add Row" in full, since it stands alone and isn't competing
for space in a row of other buttons.

------------------------------------------------------------
18. SWIPING THROUGH ROWS ONE AT A TIME, AND THE COMPACT LAYOUT
------------------------------------------------------------
On a phone-width screen, EVERY page works this way: instead of a
scrolling list of cards, you see ONE row at a time. A bar showing
your position (e.g. "3 of 26") is docked to the very bottom edge of
the screen - always in the same place, regardless of how tall the
current row's content is - with a "‹ Previous" button on its left
and a "Next ›" button on its right.

- Swipe left anywhere on the card (except starting on a text field,
  dropdown, or button) to move to the next row; swipe right to move
  to the previous one. You can also just tap the "Previous" / "Next"
  buttons at the bottom instead of swiping.
- The order you swipe through matches whatever you're currently
  viewing - if you have a filter or sort applied on desktop/tablet
  first, that same order carries over here.
- Swiping (or tapping Previous/Next) stops at the first and last row
  - it does not loop around; the button dims and stops responding
  once you're at that end.
- If you mark a task "Complete" (which moves it off "Daily planning
  - All tasks" onto "Completed tasks", per section 4), use Move, or
  otherwise remove/relocate the row you're currently viewing, your
  position automatically adjusts to stay on a valid row rather than
  showing a blank screen.
- This one-at-a-time view, and the swipe/Previous/Next navigation,
  is specific to phone-width screens. On a tablet or desktop/laptop
  browser window, every page always shows the normal full table/list
  regardless of width.
- The floating "+ Add Row" button is raised a little higher than on
  wider screens, so it sits clear of this bottom bar instead of
  overlapping it.

COMPACT FIELD LAYOUT (fitting a task on one screen): within that one
row, fields are grouped into the following rows to minimize how much
you need to scroll:
- On "Daily planning - All tasks", "All future Tasks", and
  "Completed tasks", the rows are, top to bottom:
    1. Project (on its own)
    2. Date + Priority (paired side-by-side)
    3. Task/Meeting (on its own, full width)
    4. Raised by + Work with (paired side-by-side)
    5. Next steps (on its own, full width)
    6. Due date + Status (paired side-by-side)
    7. The Copy/Move/Delete buttons (on their own, full width)
  This is a deliberate visual re-grouping for this compact view
  only - it does not change the actual column order used anywhere
  else (the desktop table, CSV export, JSON export, etc. are all
  unaffected).
- On "Week planning", Section and the five weekday columns pair up
  two-per-row in their normal order.
- On "Road Map - Pending", Project sits on its own short line, and
  Task/Meeting and Notes each take the full width since they're
  free-text fields.
- In general: any field that can hold multi-line free text (Task/
  Meeting, Next steps, Notes) always takes the full width, since
  that's the one case where "no scrolling" genuinely isn't possible
  - a long note has to take the room it needs. Every other, shorter
  field is eligible to pair up with its neighbor, except Project on
  the three task-schema pages above, which was specifically kept on
  its own row. If a page ever has an odd number of pairable fields,
  the one left without a partner automatically takes the full width
  for that row rather than sitting half-empty.
- The task card area has its own independent scroll, bounded to the
  space left on screen between the action buttons and the fixed
  bottom bar - so a normal, short-value task fits with no scrolling
  at all, and scrolling only ever happens within that one card, only
  when a free-text field genuinely has more content than fits,
  without ever hiding the action buttons or the Previous/Next bar
  off screen. Exactly how much fits before scrolling starts varies a
  little by phone model (screen height, notch size), since this is
  sized relative to your actual screen rather than to a fixed number
  of rows.
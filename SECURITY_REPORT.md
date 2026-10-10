# Security report - Participant: Spaces & Time

**Result after fixes: 129 passed, 0 failed.**
Run: `npm i jsdom && node security-tests.js` (from the app folder). Raw output: `SECURITY_TESTS.txt`.

The previous suite (45 checks) was re-run first and reproduced as passing, but several of its checks were weak (details below), so the audit was redone adversarially. The same new suite run against your **original** files gives **61 passed / 27 failed**, so the new tests really do detect the problems.

## Vulnerabilities found and fixed

| # | Severity | Problem (original code) | Fix |
|---|---|---|---|
| 1 | **High** | **Global prototype pollution, persistent.** A backup containing a page named `__proto__` wrote attacker-chosen properties onto `Object.prototype` on every launch (the page cannot be deleted from the UI). Pollution can corrupt cells (e.g. "[object Object]" injected through legacy-column lookups). Triggered by importing a malicious/shared .json. Found independently by the fuzzer at iteration 76. | All maps keyed by page/column names are now prototype-less; lookup tables use own-property checks; reserved names dropped from columns |
| 2 | Medium | Pages named `constructor`, `toString`, etc. showed JavaScript function source in the page bar and **crashed CSV export** | Own-property lookups |
| 3 | Medium | **Persistent denial of service from tampered storage.** A wrong-typed value in the saved filters crashed rendering of a page permanently (the Clear button never appeared). Matters because all `*.github.io` pages of one account share storage. Absurd column widths (99,999,999px) were also accepted. | Everything read from localStorage is type-checked/clamped; widths limited to 60-2000px |
| 4 | Medium | **Silent data loss:** if the device rejected the save (storage full), nothing told you | One clear warning per failure; asks you to Export |
| 5 | Low-Med | Page/column/duplicate floods: 3000 imported pages made 3007 buttons; 20,000 columns accepted; duplicate pages kept | Caps (8 extra pages, 30 columns), duplicates collapse, Quick list schema normalised |
| 6 | Low | **False assurance on clickjacking:** `frame-ancestors` inside a `<meta>` CSP is ignored by browsers (and GitHub Pages cannot send headers), so the old "CSP blocks framing: PASS" was untrue | Removed from the meta; app now refuses to run when embedded in another page |
| 7 | Low | Rich HTML could be dragged into an editable cell | `drop` and rich-format commands blocked (typing, paste, iOS autocorrect still work) |
| 8 | Low | Bidirectional-override characters could disguise text | Stripped on input/import |
| 9 | Hardening | Inline `style.cssText` in the keyboard helper (a possible conflict with `style-src 'self'` on some WebKit builds); CSV fields with bare CR not quoted; CSP lacked `frame-src/media-src/font-src`; no referrer policy | CSS class; quoting; tightened CSP; `no-referrer` |
| 10 | Hardening | iOS can evict Safari-tab storage | `navigator.storage.persist()` requested (best effort) |

## Weak checks in the old suite (now fixed)
- "Prototype pollution via import" used an object root, which the app rejects before any logic runs, so it passed vacuously.
- Test boot manually fired `DOMContentLoaded` while jsdom also fires it, so the app could initialise twice.
- It never tried hostile *page names*, tampered filters/widths, quota errors, or drag-and-drop.

## Verified not broken
- Differential test, original vs patched, on 13 legitimate/legacy workbooks (old column names, old Quick list/Week/Road Map formats, Unicode/RTL/emoji, removed pages), boot path and import path: **25/25 byte-identical**.
- Functional tests: add row, edit, Complete -> Completed, JSON export->import round trip, legacy migration.
- Seeded mutation fuzz: 150 poisoned imports -> no crashes, no pollution, stored data always reloads.

## Checked and fine
No `innerHTML`/`eval`/network APIs; CSP has no `unsafe-*`; all text rendered via `textContent` (XSS payloads stay inert); CSV formula injection neutralised; import size/row/cell caps; icons contain no EXIF/metadata; no ReDoS in the milestone splitter.

## Risks that code cannot remove (your hosting choices)
1. **Shared origin on GitHub Pages**: other Pages sites under the same account can read/write this app's data. Use a dedicated account or custom domain.
2. **Public repo**: upload only the 7 app files; never upload a backup .json. The sample rows in `script.js` are public.
3. **No encryption**: data and backups are plain text (iPhone passcode is the protection).
4. **Not tested on a real iPhone/Safari.** jsdom does not enforce CSP or emulate Safari, so do a quick manual pass on the phone: open the app, add/edit/complete a row, export, import.
5. Optional future hardening: a custom domain behind Cloudflare/Netlify would allow real HTTP headers (`X-Frame-Options`, `Permissions-Policy`).

## Update: TimesX7 page changes (6 new tests, 94 total)
- Refresh / auto-sync from Times now writes "Space || Time" (Spaces-page rows stay Space only). An older auto-added row showing only the time is upgraded in place rather than duplicated.
- Today's weekday group reads "<Day> - Today" in a blue/gray highlight; other groups unchanged.
- Transforms column removed; Defined time on shows the date only (the weekday is still stored, so old backups and grouping are unaffected); date and Times share one line, Times takes the remaining width.
These changes touch no security-sensitive code; the full suite (including the fuzzer) was re-run.

## Update: Times page (7 new tests, 101 total)
- "time on" now opens the calendar picker (same control as "Time Zero on"); "+ Add" focuses the first text cell so it doesn't pop the calendar.
- Demand = 99 repeats a Times row on every day (all 7 days) between "time on" and "Time Zero on" in TimesX7. No security-relevant code changed; the full suite (including the fuzzer) was re-run.

## Update: Spaces delete (5 new tests, 106 total)
Delete on the Spaces page now also deletes that Space's tasks on Times, NextIn and NoSpace (Spacetime follows). A blank-named Space deletes only itself; a duplicate-named Space keeps the tasks. Shows a confirmation with row counts. No security-relevant code changed.

## Update: BackIn / NextIn wrap around (7 new tests, 113 total)
On Spacetime, Times, NextIn and NoSpace the BackIn/NextIn buttons now loop (1 of 10 -> BackIn -> 10 of 10; 10 of 10 -> NextIn -> 1 of 10). Finger swipes still stop at the ends. No security-relevant code changed.

## Update: TimesX7 / Times sync (10 new tests, 123 total)
- TimesX7 now shows only rows from the Times page (Spaces "Life Ends" rows are no longer added). Press Refresh once to clear old Spaces-based rows.
- Times "Time Zero on" and TimesX7 "Defined time on" cannot be later than that Space's "Life Ends" on Spaces (calendar `max` plus a check on save; no limit if the Space is blank, unknown or has no Life Ends).
- TimesX7 has a small radio button before the date: it deletes the TimesX7 row and its source row on Times (with a confirmation); for Demand = 99 it deletes only that day on TimesX7.
- Changing the date on TimesX7 updates "Time Zero on" on Times; Demand = 99 dates are locked on TimesX7.
No security-sensitive code changed (still no innerHTML / network APIs); the full suite, including the fuzzer, was re-run.

## Update: TimesX7 Times column read-only (2 new tests, 125 total)
- The Times column on TimesX7 is display-only ("Space || Time"). Tapping it opens that task on the Times page (highlighted). No security-relevant code changed.

## Update: Spacetime page (3 new tests, 128 total)
- "Time 1 / Time 2 ..." labels replaced by the task's "Time Zero on" date (blank if empty); tapping it opens the calendar, limited to the Space's Life Ends, and saves to the same row on Times.
- Within each Space, tasks are grouped under status headings (In-Progress, Not started, Hold, Complete, No status). No security-relevant code changed.

## Update: Spaces page collapsible text box (1 new test, 129 total)
- The Key milestones text box on Spaces is hidden behind a down arrow (up arrow when open); tapping toggles it. Display only, no data or security-relevant code changed.

## Update: Spacetime matches TimesX7 look (129 tests)
- Spacetime columns are now "Defined time on" and "Times"; each Space is a group title in the same style as the TimesX7 weekday titles, with the status headings beneath. Task rows use the TimesX7 font, size, colour and borders. Display only; no security-relevant code changed.

## Update: layout tweaks (129 tests)
- Spaces: show/hide arrow moved onto the "Time" title line, right-most. Spacetime: task text has an outline like the date field, narrower date column, and Space / status titles keep their own capitalisation. Display only; no security-relevant code changed.

## Update: more layout tweaks (129 tests)
- Spacetime task text uses the same gray as the TimesX7 Times column. Spaces (phone): "Space" title and box share a row; "Transforms" title left with the buttons at the far right. CSS only; no security-relevant code changed.

## Update: Spacetime status titles (129 tests)
- Status titles are capitals again in a blue-gray; Space titles keep the capitalisation typed on Times. CSS only.

## Update: Space background colours (3 new tests, 132 total)
- The text-colour version was fully reverted (suite back to 129 passed), then Space colours were re-applied as backgrounds.
- Each Space on the Spaces page owns one of 12 pastel backgrounds, saved on its row as `Color` (a palette number 0-11, not a visible column). A new Space gets the least-used colour; existing colours never change; Spaces with the same name share one.
- Shown as a coloured background behind the Space name on Spaces, Times (and NextIn/NoSpace), behind the whole "Space || Time" box on TimesX7, and behind the Space group title on Spacetime.
- Security: the stored value is validated on every load/import (digits 0-11 only, anything else replaced) and applied only as a fixed CSS class name from a code-owned list, so imported data cannot inject classes, styles or markup. No innerHTML / inline styles added. The full suite, including the fuzzer, was re-run.

- Space names use the original 11px badge size again (as the old pills did).

- Space colour is now shown as a 4px strip on the left edge (Space cells, the whole TimesX7 box, the Spacetime group title) instead of a background fill. CSS only.

- Space cells now use the same gray box with a rounded left colour strip as the Times column on TimesX7 (no more inner badge).

- Spacetime: the Space group title now uses the Space colour as its background (white text); Space cells elsewhere keep the gray box with the left strip.

## Update: colour tweaks (132 tests)
- TimesX7 Times box: Space colour strip moved to the right. Spacetime task boxes use the same right strip; Spacetime group titles are back to the original pink with rounded corners; on the phone, Spacetime rows show the "Defined time on" / "Times" labels like TimesX7.
- Spaces / Times / NextIn / NoSpace: the Space name is shown in its colour (gray box, no strip). Display only; no security-relevant code changed.

## Update: Spaces / Spacetime / Stars tweaks (133 tests)
- Space cells (Spaces, Times, ...): 13px text, vertically centred in the gray box.
- Spaces: Copy / Create Times / Delete share one gray button look. A single tap on a named Space opens it on Spacetime (double-tap renames; an empty name is editable straight away). Navigation only; no new data paths.
- Spacetime date field uses the TimesX7 size. Stars page: the star button is now the same round radio as TimesX7. CSS/UI only; no security-relevant code changed.

## Update: Spaces collapsed list (134 tests)
- Each Space is one collapsed line: "+  Space  [name]". The + shows/hides that Space's other rows (Time, life dates, Transforms). A Space with no name yet starts open. UI only; nothing stored or imported changed.

## Update: life dates on the collapsed Spaces view (135 tests)
- While a Space is collapsed, a small "Began ... Ends ..." line shows under its name box (hidden when both dates are empty, and while the Space is open). Display only; the dates are read from the same row and written with textContent.

## Update: Spaces order (136 tests)
- Spaces tiles are shown by Life Ends (earliest first), then Life began; Spaces without dates go last. Display order only: the stored order is unchanged, and clicking a column sort still overrides it.

## Update: Spacetime order by Demand (137 tests)
- On Spacetime, tasks inside each status group of a Space are ordered by their Demand on Times (1 first, then 2, 3 ...; blank last). Display order only; nothing stored changed.

## Update: drag to reorder (5 new tests, 140 total)
- A small handle (three bars) lets you drag rows on **Spaces** (any place), **Spacetime** (tasks, only inside their own Space and status group; the order is saved by moving the task on the Times page), **TimesX7** (only inside the same date) and **Stars** (any place). The order is saved with the data.
- The automatic date order on Spaces and the Demand order on Spacetime were removed. The first time this version runs, the current Spaces date order is kept once as the starting order.
- The reorder only moves existing rows inside the stored lists (matched by identity); no new data, no innerHTML, no new storage fields besides one "done" flag. The full suite, including the fuzzer, was re-run.

- Drag handle is now three small vertical dots overlaying the right edge of the row (12px reserved instead of ~38px). Display only; no logic changed.

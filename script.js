"use strict";

/* ============================================================
   Participant - Spaces & Time - Final Secure Portal
   Local-first, dependency-free vanilla JS application.
   ============================================================ */

(function () {
  // Clickjacking defense. A <meta> CSP cannot carry frame-ancestors (browsers
  // ignore it there) and GitHub Pages cannot send X-Frame-Options, so refuse
  // to run at all if this page has been embedded inside another page.
  var isFramed = true;
  try { isFramed = window.top !== window.self; } catch (e) { isFramed = true; }
  if (isFramed) {
    document.documentElement.replaceChildren();
    return;
  }

  var STORAGE_DATA_KEY = "workPlanningFinal.v2.data";
  var STORAGE_SHEET_KEY = "workPlanningFinal.v2.selectedSheet";
  var STORAGE_FILTERS_KEY = "workPlanningFinal.v2.filters";
  var STORAGE_WIDTHS_KEY = "workPlanningFinal.v2.safeManualColumnWidths";
  var STORAGE_WEEK_AUTOADD_KEY = "workPlanningFinal.v2.weekAutoAdded";
  var STORAGE_LAST_EXPORT_DATE_KEY = "workPlanningFinal.v2.lastExportDate";
  var STORAGE_LAST_PROMPT_DISMISS_KEY = "workPlanningFinal.v2.lastBackupPromptDismiss";

  var IDB_NAME = "workPlanningFinal.v2.autoBackup";
  var IDB_VERSION = 1;
  var IDB_STORE = "handles";
  var IDB_KEY = "workbookJson";

  var TASK_COLUMNS = ["Date", "Space", "Demand", "Timeframe/Meeting", "Next Timeframes", "Time Zero on", "Timing"];
  var TASK_SHEET_NAMES = ["Daily planning - All tasks", "All future Tasks", "Completed tasks"];
  var STATUS_OPTIONS = ["", "Complete", "In-Progress", "Not started", "Hold"];
  var MAX_ROWS = 5000;
  var MAX_CELL_LEN = 5000;
  var MAX_IMPORT_BYTES = 2 * 1024 * 1024;
  var MAX_EXTRA_SHEETS = 8;   // pages beyond the built-in ones, per workbook
  var MAX_COLUMNS = 30;       // columns per page
  var MIN_COL_WIDTH = 60;     // px, manual column width bounds
  var MAX_COL_WIDTH = 2000;
  var RESERVED_KEYS = ["__proto__", "constructor", "prototype"];
  var KNOWN_SHEET_NAMES = ["Daily planning - All tasks", "All future Tasks", "Completed tasks",
    "Week planning", "Road Map - Pending", "Quick list", "Summary"];

  // Own-property helpers. Page names and column names can come from an
  // imported file, so they must never be used as keys on a plain object
  // (a page called "__proto__" or "constructor" would otherwise reach
  // Object.prototype). Maps keyed by user-controlled text use newMap().
  function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function newMap() { return Object.create(null); }
  function isReservedKey(k) { return RESERVED_KEYS.indexOf(k) !== -1; }

  // Maps each current column name to the older name(s) it replaced, so a
  // workbook saved before a column rename still carries its data forward
  // instead of showing blank cells after the rename ships.
  var LEGACY_MAP = {
    "Demand": ["Priority", "Catogery"],
    "Space": ["Project"],
    "Timeframe/Meeting": ["Task/Meeting"],
    "Next Timeframes": ["Next steps", "Notes", "Deliver-TO"],
    "Time Zero on": ["Due date"],
    "Timing": ["Status"]
  };

  var ROAD_MAP_COLUMNS = ["Space", "Key milestones", "Life began", "Life Ends", "Life span"];
  var WEEK_PLANNING_COLUMNS = ["Date/Day", "Timeframes"];
  var DAY_ABBREV = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var SUMMARY_COLUMNS = ["Date", "Time"]; // shown as "Defined time on" and "Times"; Space is the group heading

  /* ---------------------------------------------------------
     Default workbook
     --------------------------------------------------------- */
  function blankTaskRow(overrides) {
    var row = {};
    for (var i = 0; i < TASK_COLUMNS.length; i++) row[TASK_COLUMNS[i]] = "";
    if (overrides) {
      for (var k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) row[k] = overrides[k];
    }
    return row;
  }

  function buildDefaultWorkbook() {
    var sheets = [];

    // 1. Daily planning - All tasks
    var dailyRows = [
      blankTaskRow({ Space: "AA", Demand: "1", "Timeframe/Meeting": "Analyze the responses from esd - 123 etc" })
    ];
    sheets.push({ name: "Daily planning - All tasks", columns: TASK_COLUMNS.slice(), rows: dailyRows });

    // 2. Week planning
    sheets.push(buildWeekPlanningSheet());

    // 3. All future Tasks
    var futureRows = [];
    for (var f = 0; f < 26; f++) futureRows.push(blankTaskRow({ Space: "ee" }));
    sheets.push({ name: "All future Tasks", columns: TASK_COLUMNS.slice(), rows: futureRows });

    // 4. Road Map - Pending
    var roadCols = ["Space", "Key milestones", "Life began", "Life Ends", "Life span"];
    var roadRows = [
      { Space: "RR 2.0", "Key milestones": "", "Life began": "", "Life Ends": "", "Life span": "" },
      { Space: "", "Key milestones": "", "Life began": "", "Life Ends": "", "Life span": "" }
    ];
    sheets.push({ name: "Road Map - Pending", columns: roadCols, rows: roadRows });

    // 5. Quick list
    sheets.push(buildQuickListSheet());

    // 6. Completed tasks (kept last so completed/archived items sit at the
    // end of the page list rather than in the middle of the active pages)
    sheets.push({ name: "Completed tasks", columns: TASK_COLUMNS.slice(), rows: [] });

    // 0. Summary - built last here since it's derived from the Daily
    // planning sheet already assembled above.
    sheets.unshift(buildSummarySheet(sheets));

    // Projects (Road Map) leads the nav row, with Summary right after it.
    putProjectsAndSummaryFirst(sheets);

    return sheets;
  }

  var DEFAULT_WORKBOOK = buildDefaultWorkbook();

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /* ---------------------------------------------------------
     Sanitization
     --------------------------------------------------------- */
  function sanitizeCell(value, max) {
    if (max === undefined) max = MAX_CELL_LEN;
    if (value === null || value === undefined) return "";
    var str = String(value);
    str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    // Bidi override/embedding/isolate controls can visually reorder text
    // (spoofing); nothing in this app needs them.
    str = str.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
    str = str.replace(/\r\n|\r/g, "\n");
    if (str.length > max) str = str.slice(0, max);
    return str;
  }

  function sanitizeName(value, max) {
    return sanitizeCell(value, max === undefined ? 120 : max);
  }

  /* ---------------------------------------------------------
     Normalization
     --------------------------------------------------------- */
  function normalizeTaskSheet(sheetName, rawSheet) {
    var rows = Array.isArray(rawSheet.rows) ? rawSheet.rows : [];
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
    var outRows = rows.map(function (r) {
      if (!r || typeof r !== "object") r = {};
      var out = {};
      for (var i = 0; i < TASK_COLUMNS.length; i++) {
        var col = TASK_COLUMNS[i];
        var val = r[col];
        if ((val === undefined || val === "") && LEGACY_MAP[col]) {
          for (var j = 0; j < LEGACY_MAP[col].length; j++) {
            var legacyKey = LEGACY_MAP[col][j];
            if (r[legacyKey] !== undefined && r[legacyKey] !== "") { val = r[legacyKey]; break; }
          }
        }
        out[col] = sanitizeCell(val, MAX_CELL_LEN);
      }
      return out;
    });
    return { name: sheetName, columns: TASK_COLUMNS.slice(), rows: outRows };
  }

  function normalizeGenericSheet(rawSheet) {
    var name = sanitizeName(rawSheet.name, 120);
    var columns = [];
    var seenCols = newMap();
    if (Array.isArray(rawSheet.columns)) {
      rawSheet.columns.forEach(function (c) {
        var n = sanitizeName(c, 120);
        if (!n || isReservedKey(n) || seenCols[n] || columns.length >= MAX_COLUMNS) return;
        seenCols[n] = true;
        columns.push(n);
      });
    }
    if (columns.length === 0) columns = ["Notes"];
    var rows = Array.isArray(rawSheet.rows) ? rawSheet.rows : [];
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
    var outRows = rows.map(function (r) {
      if (!r || typeof r !== "object") r = {};
      var out = {};
      for (var i = 0; i < columns.length; i++) {
        // Own properties only, so a column called "toString" can't pick up
        // an inherited function and print its source into the cell.
        out[columns[i]] = hasOwn(r, columns[i]) ? sanitizeCell(r[columns[i]], MAX_CELL_LEN) : "";
      }
      return out;
    });
    return { name: name, columns: columns, rows: outRows };
  }

  // Parses a strict MM/DD/YYYY string into a UTC millisecond timestamp,
  // returning null for anything malformed or not a real calendar date.
  function dateToUtcMs(value) {
    var match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value || "");
    if (!match) return null;
    var month = Number(match[1]), day = Number(match[2]), year = Number(match[3]);
    var time = Date.UTC(year, month - 1, day);
    var check = new Date(time);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return time;
  }

  // Whole days between Start date and End date, inclusive of neither
  // endpoint's time-of-day (both are date-only). Blank whenever either
  // date is missing/invalid or End date is before Start date.
  function roadMapDuration(startDate, endDate) {
    var start = dateToUtcMs(startDate), end = dateToUtcMs(endDate);
    if (start === null || end === null || end < start) return "";
    return String(Math.round((end - start) / 86400000));
  }

  /* ---------------------------------------------------------
     Space colours
     ---------------------------------------------------------
     Every Space on the Spaces page owns one colour (stored on its row as
     "Color" = a palette number, not shown as a column). A new Space gets
     the least-used palette colour automatically; the same colour is used
     wherever that Space's name is shown (matched by exact trimmed name). */
  var SPACE_COLOR_COUNT = 12;
  var spaceColorMap = newMap();

  function validSpaceColor(v) {
    var t = String(v === undefined || v === null ? "" : v).trim();
    if (!/^\d{1,2}$/.test(t)) return "";
    var n = Number(t);
    return n < SPACE_COLOR_COUNT ? String(n) : "";
  }

  function ensureSpaceColors(wb) {
    spaceColorMap = newMap();
    var road = Array.isArray(wb) ? wb.find(function (sh) { return sh && sh.name === "Road Map - Pending"; }) : null;
    if (!road || !Array.isArray(road.rows)) return;
    var uses = [];
    var i;
    for (i = 0; i < SPACE_COLOR_COUNT; i++) uses.push(0);
    // Pass 1: names that already have a colour (first row with a name wins).
    road.rows.forEach(function (r) {
      if (!r) return;
      var name = String(r.Space || "").trim();
      var c = validSpaceColor(r.Color);
      if (name && c !== "" && !hasOwn(spaceColorMap, name)) { spaceColorMap[name] = c; uses[Number(c)]++; }
    });
    // Pass 2: names without one take the least-used colour.
    road.rows.forEach(function (r) {
      if (!r) return;
      var name = String(r.Space || "").trim();
      if (!name) return;
      if (!hasOwn(spaceColorMap, name)) {
        var best = 0;
        for (var k = 1; k < SPACE_COLOR_COUNT; k++) if (uses[k] < uses[best]) best = k;
        spaceColorMap[name] = String(best);
        uses[best]++;
      }
      r.Color = spaceColorMap[name]; // duplicate names share the colour
    });
  }

  // CSS class (space-color-N) for a Space name, or "" when it has none.
  function spaceColorClass(name) {
    var n = String(name === undefined || name === null ? "" : name).trim();
    return (n && hasOwn(spaceColorMap, n)) ? "space-color-" + spaceColorMap[n] : "";
  }

  // Older saved workbooks may still have the previous Road Map schema
  // (Project, Task/Meeting, Notes), the pre-rename "Project" column, or
  // the pre-rename "Start date"/"End date"/"Duration" columns. Carry
  // forward whatever free-text content they had rather than losing the
  // page's content on upgrade.
  function migrateRoadMapSheet(sheet) {
    var rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
    var newRows = rows.map(function (r) {
      if (!r || typeof r !== "object") r = {};
      var startRaw = r["Life began"] !== undefined ? r["Life began"] : r["Start date"];
      var endRaw = r["Life Ends"] !== undefined ? r["Life Ends"] : r["End date"];
      var start = sanitizeCell(startRaw, MAX_CELL_LEN);
      var end = sanitizeCell(endRaw, MAX_CELL_LEN);
      var milestone = r["Key milestones"];
      if (milestone === undefined) milestone = r["Task/Meeting"] || r["Notes"];
      var space = r.Space !== undefined ? r.Space : r.Project;
      return {
        Space: sanitizeCell(space, MAX_CELL_LEN),
        "Key milestones": sanitizeCell(milestone, MAX_CELL_LEN),
        "Life began": start,
        "Life Ends": end,
        "Life span": roadMapDuration(start, end)
      };
    });
    return { name: "Road Map - Pending", columns: ROAD_MAP_COLUMNS.slice(), rows: newRows };
  }

  // Pages that used to exist in earlier versions of this app and have
  // since been removed. Any older saved workbook that still has them is
  // silently dropped down to the current page set on the next load,
  // rather than showing stale pages that no longer have UI support.
  var REMOVED_PAGE_NAMES = ["Important TimeLines", "Rough Notes"];

  // True when a saved sheet's columns already match the current Week
  // planning schema, so its rows (the user's actual typed task text)
  // should be kept as-is rather than replaced by a fresh default row.
  function isCurrentWeekPlanningSchema(rawSheet) {
    var cols = Array.isArray(rawSheet.columns) ? rawSheet.columns : [];
    return cols.length === WEEK_PLANNING_COLUMNS.length &&
      WEEK_PLANNING_COLUMNS.every(function (c, i) { return cols[i] === c; });
  }

  // The Week planning schema before "Tasks" was renamed to "Timeframes".
  // Detected separately so that renamed data is carried forward into the
  // new column instead of being replaced by a blank default sheet.
  var LEGACY_WEEK_PLANNING_COLUMNS = ["Date/Day", "Tasks"];
  function isLegacyWeekPlanningSchema(rawSheet) {
    var cols = Array.isArray(rawSheet.columns) ? rawSheet.columns : [];
    return cols.length === LEGACY_WEEK_PLANNING_COLUMNS.length &&
      LEGACY_WEEK_PLANNING_COLUMNS.every(function (c, i) { return cols[i] === c; });
  }
  function migrateLegacyWeekPlanningSheet(rawSheet) {
    var rows = Array.isArray(rawSheet.rows) ? rawSheet.rows : [];
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
    var newRows = rows.map(function (r) {
      if (!r || typeof r !== "object") r = {};
      return {
        "Date/Day": sanitizeCell(r["Date/Day"], MAX_CELL_LEN),
        "Timeframes": sanitizeCell(r["Tasks"], MAX_CELL_LEN)
      };
    });
    return { name: "Week planning", columns: WEEK_PLANNING_COLUMNS.slice(), rows: newRows };
  }

  // The Quick list schema before "Item" was renamed to "Small Times".
  // Detected separately so existing checklist text is carried forward
  // into the new column instead of being dropped.
  function migrateLegacyQuickListSheet(rawSheet) {
    var rows = Array.isArray(rawSheet.rows) ? rawSheet.rows : [];
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
    var newRows = rows.map(function (r) {
      if (!r || typeof r !== "object") r = {};
      var v = hasOwn(r, "Small Times") ? r["Small Times"] : (hasOwn(r, "Item") ? r["Item"] : "");
      return { "Small Times": sanitizeCell(v, MAX_CELL_LEN) };
    });
    return { name: "Quick list", columns: ["Small Times"], rows: newRows };
  }

  function normalizeWorkbook(raw) {
    if (!Array.isArray(raw)) throw new Error("workbook root must be an array of sheets");
    var sheets = [];
    var seenNames = newMap();
    var extraSheets = 0;
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      if (!s || typeof s !== "object") throw new Error("each sheet must be an object");
      var name = sanitizeName(s.name, 120);
      if (!name) throw new Error("each sheet must have a name");
      if (REMOVED_PAGE_NAMES.indexOf(name) !== -1) continue;
      if (name === "Summary") continue; // always recomputed fresh below
      if (seenNames[name]) continue;    // duplicate page name: first copy wins
      if (KNOWN_SHEET_NAMES.indexOf(name) === -1) {
        // Unknown pages are tolerated for old backups but capped, so a
        // crafted file can't flood the page bar.
        if (extraSheets >= MAX_EXTRA_SHEETS) continue;
        extraSheets++;
      }
      seenNames[name] = true;
      if (name === "Week planning") {
        if (isCurrentWeekPlanningSchema(s)) sheets.push(normalizeGenericSheet(s));
        else if (isLegacyWeekPlanningSchema(s)) sheets.push(migrateLegacyWeekPlanningSheet(s));
        else sheets.push(buildWeekPlanningSheet());
        continue;
      }
      if (TASK_SHEET_NAMES.indexOf(name) !== -1) {
        sheets.push(normalizeTaskSheet(name, s));
      } else if (name === "Quick list") {
        sheets.push(migrateLegacyQuickListSheet(s));
      } else {
        if (!Array.isArray(s.columns) || s.columns.length === 0) throw new Error("sheet '" + name + "' must have a nonempty columns array");
        var generic = normalizeGenericSheet(s);
        if (generic.name === "Road Map - Pending") {
          generic = migrateRoadMapSheet(generic);
          // keep each Space's saved colour (validated; not a column)
          var rawRoadRows = Array.isArray(s.rows) ? s.rows.slice(0, MAX_ROWS) : [];
          generic.rows.forEach(function (gr, gi) {
            var rr = rawRoadRows[gi];
            gr.Color = (rr && typeof rr === "object" && hasOwn(rr, "Color")) ? validSpaceColor(rr.Color) : "";
          });
        }
        sheets.push(generic);
      }
    }
    // Ensure Week planning always present
    var hasWeekPlanning = sheets.some(function (s) { return s.name === "Week planning"; });
    if (!hasWeekPlanning) sheets.splice(1, 0, buildWeekPlanningSheet());
    // Ensure Road Map - Pending always present
    var hasRoadMap = sheets.some(function (s) { return s.name === "Road Map - Pending"; });
    if (!hasRoadMap) sheets.push(migrateRoadMapSheet({ rows: [] }));
    // Ensure Quick list always present
    var hasQuickList = sheets.some(function (s) { return s.name === "Quick list"; });
    if (!hasQuickList) sheets.push(buildQuickListSheet());
    // Ensure Completed tasks always present
    var hasCompleted = sheets.some(function (s) { return s.name === "Completed tasks"; });
    if (!hasCompleted) {
      sheets.push({ name: "Completed tasks", columns: TASK_COLUMNS.slice(), rows: [] });
    }
    // Completed tasks always sits last in the page list, even for older
    // saved workbooks where it used to be positioned earlier.
    var completedIdx = sheets.findIndex(function (s) { return s.name === "Completed tasks"; });
    if (completedIdx !== -1 && completedIdx !== sheets.length - 1) {
      var completedSheet = sheets.splice(completedIdx, 1)[0];
      sheets.push(completedSheet);
    }
    // Summary is derived from Daily planning; Projects (Road Map) and
    // Summary lead the nav row (see putProjectsAndSummaryFirst).
    ensureSpaceColors(sheets);
    sheets.unshift(buildSummarySheet(sheets));
    putProjectsAndSummaryFirst(sheets);
    return sheets;
  }

  /* ---------------------------------------------------------
     App State
     --------------------------------------------------------- */
  var workbook = [];
  var selectedSheetIndex = 0;
  // All four are keyed by page/column names that may come from an imported
  // file, so they are prototype-less maps (see newMap).
  var filters = newMap(); // { sheetName: { colName: { text, select } } }
  var manualWidths = newMap(); // { "sheet|col": px }
  var sortState = newMap(); // { sheetName: { col, dir } }

  function todayLocalMMDDYYYY() {
    return formatLocalMMDDYYYY(new Date());
  }

  function formatLocalMMDDYYYY(d) {
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    var yyyy = d.getFullYear();
    return mm + "/" + dd + "/" + yyyy;
  }

  // "Thu, 09/24/2026" - the auto-populated value for Week planning's
  // Date/Day column and for the Date/Day of freshly added rows.
  function formatDateDay(d) {
    return DAY_ABBREV[d.getDay()] + ", " + formatLocalMMDDYYYY(d);
  }

  function buildQuickListSheet() {
    return { name: "Quick list", columns: ["Small Times"], rows: [{ "Small Times": "" }] };
  }

  function buildWeekPlanningSheet() {
    return {
      name: "Week planning",
      columns: WEEK_PLANNING_COLUMNS.slice(),
      rows: [{ "Date/Day": formatDateDay(new Date()), "Timeframes": "" }]
    };
  }

  // Builds the Summary page fresh from Daily planning - All tasks: one
  // header row per project (Task left blank) followed by one row per
  // task under that project (Task/Meeting text), in the order projects
  // and tasks first appear on the Daily planning page. Rows with no
  // Project or no Task/Meeting text are skipped, since they have
  // nothing to summarize.
  var SUMMARY_STATUS_ORDER = ["In-Progress", "Not started", "Hold", "Complete", ""];
  function summaryStatusRank(v) {
    var i = SUMMARY_STATUS_ORDER.indexOf(v);
    return i === -1 ? SUMMARY_STATUS_ORDER.length : i;
  }

  function computeSummaryRows(wb) {
    var daily = (wb || []).find ? (wb || []).find(function (s) { return s.name === "Daily planning - All tasks"; }) : null;
    if (!daily || !Array.isArray(daily.rows)) return [];
    var order = [];
    var byProject = Object.create(null);
    daily.rows.forEach(function (r, dailyIdx) {
      var project = ((r && r.Space) || "").toString().trim();
      var task = ((r && r["Timeframe/Meeting"]) || "").toString().trim();
      // A task with no Space set still gets summarized - it's grouped
      // under a catch-all label rather than dropped, since leaving
      // Space blank is a normal, common case on Daily planning.
      if (!task) return;
      if (!project) project = "(No space)";
      if (!byProject[project]) { byProject[project] = []; order.push(project); }
      // Keep the row's original index on Daily planning alongside its
      // text, so a Summary row can later be tapped to jump straight to
      // that same row on Daily planning (see goToDailyTaskFromSummary).
      byProject[project].push({
        task: task,
        dailyIdx: dailyIdx,
        timing: ((r && r.Timing) || "").toString().trim(),
        demand: (function () {
          var dv = Number(((r && r.Demand) || "").toString().trim());
          return (isFinite(dv) && ((r && r.Demand) || "").toString().trim() !== "") ? dv : Infinity;
        })(),
        date: ((r && r["Time Zero on"]) || "").toString().trim()
      });
    });
    // One row per task - the project name is shown on every one of its
    // task rows (not a separate header row), so a project with a single
    // task is a single row, not two. The first task row for each project
    // is flagged so it can be visually highlighted as the start of a new
    // group, without needing an extra blank row to do it.
    var rows = [];
    order.forEach(function (project) {
      // Within a Space, tasks are grouped by their status/timing value
      // (In-Progress, Not started, Hold, Complete, then no status); the
      // original order is kept inside each group.
      var entries = byProject[project].map(function (e, n) { e.n = n; return e; });
      entries.sort(function (a, b) {
        var d = summaryStatusRank(a.timing) - summaryStatusRank(b.timing);
        if (d !== 0) return d;
        if (a.timing !== b.timing) return a.timing < b.timing ? -1 : 1;
        // inside a status group: Demand 1 first, then 2, 3 ...; blank last
        if (a.demand !== b.demand) return a.demand < b.demand ? -1 : 1;
        return a.n - b.n;
      });
      entries.forEach(function (entry, i) {
        rows.push({
          Space: project, Time: entry.task,
          Date: entry.date, Timing: entry.timing, _date: entry.date,
          _isGroupStart: i === 0, _dailyIdx: entry.dailyIdx
        });
      });
    });
    return rows;
  }

  function buildSummarySheet(wb) {
    return { name: "Summary", columns: SUMMARY_COLUMNS.slice(), rows: computeSummaryRows(wb) };
  }

  // Projects (internal name "Road Map - Pending") leads the nav row,
  // with Summary right after it; every other sheet keeps whatever
  // relative order it already had. Used for both a fresh workbook and
  // one loaded/migrated from storage, so the ordering is consistent
  // either way.
  function putProjectsAndSummaryFirst(sheets) {
    var summaryIdx = sheets.findIndex(function (s) { return s.name === "Summary"; });
    if (summaryIdx !== -1) sheets.unshift(sheets.splice(summaryIdx, 1)[0]);
    var roadIdx = sheets.findIndex(function (s) { return s.name === "Road Map - Pending"; });
    if (roadIdx !== -1) sheets.unshift(sheets.splice(roadIdx, 1)[0]);
    return sheets;
  }

  // Recomputes the Summary sheet in place within an already-loaded
  // workbook array, so it picks up any Daily planning edits made earlier
  // in the current session (not just what was true at page load/import).
  function refreshSummarySheet(wb) {
    var idx = wb.findIndex(function (s) { return s.name === "Summary"; });
    var fresh = buildSummarySheet(wb);
    if (idx === -1) wb.unshift(fresh); else wb[idx] = fresh;
  }

  function currentSheet() {
    return workbook[selectedSheetIndex];
  }

  function isTaskSheet(sheet) {
    return TASK_SHEET_NAMES.indexOf(sheet.name) !== -1;
  }

  function hasDateColumn(sheet) {
    return sheet.columns.indexOf("Date") !== -1;
  }

  // Columns that use the special calendar-picker date control (blank when
  // empty, switches to a native date input on focus/click, saves as
  // MM/DD/YYYY). Keyed by sheet name -> column name, or an array of
  // column names when a sheet has more than one date column.
  var CALENDAR_DATE_COLUMNS = {
    "Daily planning - All tasks": ["Date", "Time Zero on"],
    "Road Map - Pending": ["Life began", "Life Ends"],
    "Week planning": "Date/Day"
  };

  function isCalendarDateColumn(sheet, col) {
    var cols = hasOwn(CALENDAR_DATE_COLUMNS, sheet.name) ? CALENDAR_DATE_COLUMNS[sheet.name] : undefined;
    return Array.isArray(cols) ? cols.indexOf(col) !== -1 : cols === col;
  }

  // Week planning's Date/Day still gets auto-filled with today's date
  // when a row is added (see handleAddRow), but is a normal editable
  // text field after that - not computed/read-only - so it can be
  // corrected to a different date.
  function isComputedColumn(sheet, col) {
    if (sheet.name === "Road Map - Pending" && col === "Life span") return true;
    if (sheet.name === "Summary") return true;
    return false;
  }

  // Summary is entirely derived from Daily planning - nothing on it is
  // user-entered - so it gets no row actions (nothing to copy/move/
  // delete) and no manual add-row control.
  function isComputedSheet(sheet) {
    return sheet.name === "Summary";
  }

  function hasActionsColumn(sheet) {
    // Quick list deletes a row via tapping its radio button instead of a
    // Copy/Move/Delete actions column (see buildQuickListRow).
    return !isComputedSheet(sheet) && sheet.name !== "Quick list" && sheet.name !== "Week planning";
  }

  // Pages that have a "Move" row action, and where that action sends the
  // row (always appended to the bottom of the destination page).
  var MOVE_TARGETS = {
    "Daily planning - All tasks": "All future Tasks",
    "All future Tasks": "Daily planning - All tasks"
  };

  // Short labels shown on the nav pills (and the page title) to keep every
  // page name fitting on one row, especially on a phone screen. The full
  // name is still used for every internal check (isTaskSheet, MOVE_TARGETS,
  // CALENDAR_DATE_COLUMNS, storage, etc.) and is shown as a tooltip.
  var NAV_SHORT_NAMES = {
    "Summary": "Spacetime",
    "Daily planning - All tasks": "Times",
    "Week planning": "TimesX7",
    "All future Tasks": "NextIn",
    "Road Map - Pending": "Spaces",
    "Quick list": "Stars",
    "Completed tasks": "NoSpace"
  };

  function shortSheetName(sheet) {
    return hasOwn(NAV_SHORT_NAMES, sheet.name) ? NAV_SHORT_NAMES[sheet.name] : sheet.name;
  }

  /* ---------------------------------------------------------
     Persistence
     --------------------------------------------------------- */
  function loadWorkbook() {
    var raw = null;
    try {
      var stored = localStorage.getItem(STORAGE_DATA_KEY);
      if (stored) raw = JSON.parse(stored);
    } catch (e) {
      raw = null;
    }
    if (raw) {
      try {
        return normalizeWorkbook(raw);
      } catch (e) {
        return deepClone(DEFAULT_WORKBOOK);
      }
    }
    return deepClone(DEFAULT_WORKBOOK);
  }

  function loadSelectedSheetIndex(max) {
    var idx = 0;
    try {
      var stored = localStorage.getItem(STORAGE_SHEET_KEY);
      if (stored !== null) {
        var n = parseInt(stored, 10);
        if (!isNaN(n)) idx = n;
      }
    } catch (e) { idx = 0; }
    if (idx < 0 || idx >= max) idx = 0;
    return idx;
  }

  // Reads the raw (pre-normalization) saved workbook/index independently,
  // to recover which sheet NAME was previously selected. This is used so
  // that a page reorder (e.g. Completed tasks moving to the end of the
  // list) doesn't leave a returning user looking at the wrong tab just
  // because the numeric index it used to sit at now points elsewhere.
  function loadPreviouslySelectedSheetName() {
    try {
      var storedData = localStorage.getItem(STORAGE_DATA_KEY);
      var storedIdxRaw = localStorage.getItem(STORAGE_SHEET_KEY);
      if (!storedData || storedIdxRaw === null) return null;
      var idx = parseInt(storedIdxRaw, 10);
      if (isNaN(idx)) return null;
      var parsed = JSON.parse(storedData);
      if (!Array.isArray(parsed) || !parsed[idx] || typeof parsed[idx] !== "object") return null;
      return typeof parsed[idx].name === "string" ? parsed[idx].name : null;
    } catch (e) {
      return null;
    }
  }

  // Everything read back from localStorage is treated as untrusted: it can
  // be corrupted, or written by another page on the same origin (all
  // *.github.io project pages of one account share an origin). Only values
  // of the expected type survive; anything else is dropped.
  function loadFilters() {
    var out = newMap();
    try {
      var stored = localStorage.getItem(STORAGE_FILTERS_KEY);
      if (!stored) return out;
      var parsed = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
      Object.keys(parsed).slice(0, 100).forEach(function (sheetName) {
        var perSheet = parsed[sheetName];
        if (!perSheet || typeof perSheet !== "object" || Array.isArray(perSheet)) return;
        var clean = newMap();
        Object.keys(perSheet).slice(0, MAX_COLUMNS).forEach(function (col) {
          var cf = perSheet[col];
          if (!cf || typeof cf !== "object") return;
          clean[col] = {
            text: typeof cf.text === "string" ? sanitizeCell(cf.text, 200) : "",
            select: typeof cf.select === "string"
              ? (cf.select === "\u0000__BLANK__" ? cf.select : sanitizeCell(cf.select, MAX_CELL_LEN))
              : ""
          };
        });
        out[sheetName] = clean;
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function loadWidths() {
    var out = newMap();
    try {
      var stored = localStorage.getItem(STORAGE_WIDTHS_KEY);
      if (!stored) return out;
      var parsed = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
      Object.keys(parsed).slice(0, 500).forEach(function (k) {
        var n = parsed[k];
        if (typeof n === "number" && isFinite(n)) {
          out[k] = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(n)));
        }
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function persistSelectedSheet() {
    try { localStorage.setItem(STORAGE_SHEET_KEY, String(selectedSheetIndex)); } catch (e) { /* ignore */ }
  }

  function persistFilters() {
    try { localStorage.setItem(STORAGE_FILTERS_KEY, JSON.stringify(filters)); } catch (e) { /* ignore */ }
  }

  function persistWidths() {
    try { localStorage.setItem(STORAGE_WIDTHS_KEY, JSON.stringify(manualWidths)); } catch (e) { /* ignore */ }
  }

  // Daily backup reminder bookkeeping. Both dates are stored as plain
  // MM/DD/YYYY local-date strings (see todayLocalMMDDYYYY), so a simple
  // string comparison against "today" is enough to know whether the
  // reminder has already been handled today - no time-of-day/timezone
  // math needed.
  function loadLastExportDate() {
    try { return localStorage.getItem(STORAGE_LAST_EXPORT_DATE_KEY) || ""; } catch (e) { return ""; }
  }
  function saveLastExportDate(dateStr) {
    try { localStorage.setItem(STORAGE_LAST_EXPORT_DATE_KEY, dateStr); } catch (e) { /* ignore */ }
  }
  function loadLastPromptDismissDate() {
    try { return localStorage.getItem(STORAGE_LAST_PROMPT_DISMISS_KEY) || ""; } catch (e) { return ""; }
  }
  function saveLastPromptDismissDate(dateStr) {
    try { localStorage.setItem(STORAGE_LAST_PROMPT_DISMISS_KEY, dateStr); } catch (e) { /* ignore */ }
  }

  // If the browser refuses the write (storage full, private mode, storage
  // cleared by the OS) the user must know: otherwise they keep typing,
  // believing their data is saved, and lose it on the next launch.
  var storageWarned = false;
  function warnStorageFailure() {
    if (storageWarned) return;
    storageWarned = true;
    try {
      window.alert("Warning: your device storage is full or unavailable, so your latest changes could NOT be saved. Tap Export now to keep a backup copy, then free up space.");
    } catch (e) { /* ignore */ }
  }
  function writeWorkbookToStorage() {
    ensureSpaceColors(workbook);
    try {
      localStorage.setItem(STORAGE_DATA_KEY, JSON.stringify(workbook));
      storageWarned = false;
      return true;
    } catch (e) {
      warnStorageFailure();
      return false;
    }
  }

  function saveWorkbook() {
    writeWorkbookToStorage();
    queueAutoBackupWrite();
  }

  /* ---------------------------------------------------------
     Filters helpers
     --------------------------------------------------------- */
  function getSheetFilters(sheetName) {
    if (!filters[sheetName]) filters[sheetName] = newMap();
    return filters[sheetName];
  }

  function getColFilter(sheetName, col) {
    var sf = getSheetFilters(sheetName);
    var cf = sf[col];
    if (!cf || typeof cf.text !== "string" || typeof cf.select !== "string") {
      cf = sf[col] = { text: "", select: "" };
    }
    return cf;
  }

  function clearSheetFilters(sheetName) {
    filters[sheetName] = newMap();
    persistFilters();
  }

  /* ---------------------------------------------------------
     Sanitization for editable input (typing / paste)
     --------------------------------------------------------- */
  function sanitizeTyped(value) {
    return sanitizeCell(value, MAX_CELL_LEN);
  }

  /* ---------------------------------------------------------
     Pill color helpers
     --------------------------------------------------------- */
  function priorityPillClass(raw) {
    var v = (raw || "").trim().toLowerCase();
    if (["1", "p1", "high", "urgent", "critical"].indexOf(v) !== -1) return "pill-red";
    if (["2", "p2", "medium", "med"].indexOf(v) !== -1) return "pill-amber";
    if (["3", "p3", "low"].indexOf(v) !== -1) return "pill-green";
    if (["4", "p4", "backlog", "optional"].indexOf(v) !== -1) return "pill-blue";
    if (v.length > 0) return "pill-purple";
    return null;
  }

  function projectPillClass(raw) {
    var v = (raw || "").toUpperCase();
    if (v.indexOf("AA") !== -1) return "pill-purple";
    if (v.indexOf("DD") !== -1) return "pill-lightblue";
    if (v.indexOf("RR") !== -1) return "pill-green";
    if (v.indexOf("TT") !== -1) return "pill-amber";
    if (v.trim().length > 0) return "pill-gray";
    return null;
  }

  function statusClass(v) {
    if (v === "Complete") return "status-complete";
    if (v === "In-Progress") return "status-inprogress";
    if (v === "Not started") return "status-notstarted";
    if (v === "Hold") return "status-hold";
    return "status-empty";
  }

  /* ---------------------------------------------------------
     Column widths / min widths
     --------------------------------------------------------- */
  function minWidthForColumn(sheet, col) {
    if (col === "Timeframe/Meeting" || col === "Key milestones" || col === "Timeframes" || col === "Time") return 230;
    if (col === "Next Timeframes") return 190;
    if (sheet.name === "Summary" && col === "Date") return 100;
    if (col === "Date" || col === "Space" || col === "Demand") return 64;
    if (col === "Date/Day") return 110;
    if (col === "Timing") return 126;
    if (col === "Time Zero on" || col === "Life began" || col === "Life Ends") return 110;
    if (col === "Life span") return 80;
    return 70;
  }

  function pctWidthForColumn(sheet, col) {
    if (isTaskSheet(sheet)) {
      if (col === "Timeframe/Meeting") return 39;
      if (col === "Next Timeframes") return 26;
      if (col === "Date" || col === "Space" || col === "Demand") return 5;
      if (col === "Timing") return 10;
      if (col === "Time Zero on") return 7;
      return 9;
    }
    if (sheet.name === "Road Map - Pending") {
      if (col === "Key milestones") return 39;
      if (col === "Space") return 13;
      if (col === "Life began" || col === "Life Ends") return 12;
      if (col === "Life span") return 9;
      return 12;
    }
    if (sheet.name === "Week planning") {
      if (col === "Timeframes") return 55;
      return 22; // Date/Day
    }
    if (sheet.name === "Summary") {
      if (col === "Time") return 86;
      return 14; // Date
    }
    if (col === "Timeframe/Meeting" || col === "Notes" || col === "Next Timeframes") return 27;
    if (col === "Space") return 13;
    return 12;
  }

  function actionsPct(sheet) {
    return isTaskSheet(sheet) ? 14 : 10;
  }

  function widthKey(sheetName, col) {
    return sanitizeName(sheetName, 120) + "|" + sanitizeName(col, 120);
  }

  var ACTIONS_KEY_TOKEN = "__Actions__";

  /* ============================================================
     RENDERING
     ============================================================ */
  var navEl, pageTitleEl, colgroupEl, tableHeadEl, tableBodyEl, tableScrollerEl;
  var navSpacesBtn, navNoSpaceBtn;
  var backupPromptEl, backupPromptExportBtn, backupPromptDismissBtn;

  function init() {
    navEl = document.getElementById("nav");
    navSpacesBtn = document.getElementById("navSpacesBtn");
    navNoSpaceBtn = document.getElementById("navNoSpaceBtn");
    pageTitleEl = document.getElementById("pageTitle");
    colgroupEl = document.getElementById("colgroup");
    tableHeadEl = document.getElementById("tableHead");
    tableBodyEl = document.getElementById("tableBody");
    tableScrollerEl = document.getElementById("tableScroller");
    backupPromptEl = document.getElementById("backupPrompt");
    backupPromptExportBtn = document.getElementById("backupPromptExportBtn");
    backupPromptDismissBtn = document.getElementById("backupPromptDismissBtn");

    // Ask the browser not to evict our data under storage pressure
    // (best effort; harmless if unsupported or declined).
    try {
      if (navigator.storage && typeof navigator.storage.persist === "function") {
        var persisted = navigator.storage.persist();
        if (persisted && typeof persisted.catch === "function") persisted.catch(function () { /* ignore */ });
      }
    } catch (e) { /* ignore */ }

    workbook = loadWorkbook();
    selectedSheetIndex = loadSelectedSheetIndex(workbook.length);
    var rememberedName = loadPreviouslySelectedSheetName();
    if (rememberedName) {
      var byName = workbook.findIndex(function (s) { return s.name === rememberedName; });
      if (byName !== -1) selectedSheetIndex = byName;
    }
    filters = loadFilters();
    manualWidths = loadWidths();

    // Summary is derived from Daily planning; refresh it once against
    // whatever Daily planning data just loaded, then persist.
    refreshSummarySheet(workbook);
    autoAddToWeekPlanning();
    saveWorkbookSilently();

    // Re-check every time an edit is committed (a cell loses focus), so
    // a date entered before its Space/Time text - or the other way
    // round - still creates the TimesX7 row as soon as both exist.
    tableBodyEl.addEventListener("focusout", function () {
      setTimeout(autoAddToWeekPlanning, 150);
    });
    window.addEventListener("pageshow", function () { autoAddToWeekPlanning(); });
    // Safety net: iOS keeps a date box focused after "Done", so no blur
    // may ever fire. Check every few seconds, but never while the user
    // is mid-edit in a date box or text cell (avoids adding half-typed
    // text or the calendar's pre-selected "today").
    setInterval(function () {
      var a = document.activeElement;
      if (a && a.closest && a.closest("#tableBody") && (a.type === "date" || a.isContentEditable)) return;
      autoAddToWeekPlanning();
    }, 3000);

    // Re-check whenever the app comes back to the foreground, so a new
    // day (or a date entered earlier) is picked up without a reload.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") autoAddToWeekPlanning();
    });

    document.getElementById("btnAddRow").addEventListener("click", handleAddRow);
    document.getElementById("btnRefreshWeek").addEventListener("click", handleRefreshWeek);
    document.getElementById("btnAddRowFloating").addEventListener("click", handleAddRow);
    document.getElementById("btnExportJson").addEventListener("click", handleExportJson);
    document.getElementById("btnImportJson").addEventListener("click", function () {
      document.getElementById("fileImport").click();
    });
    document.getElementById("fileImport").addEventListener("change", handleImportFileChosen);
    document.getElementById("btnExportCsv").addEventListener("click", handleExportCsv);
    document.getElementById("btnResetSheet").addEventListener("click", handleResetSheet);
    document.getElementById("btnAutoBackup").addEventListener("click", handleAutoBackupButton);
    document.getElementById("taskPrevBtn").addEventListener("click", function () { stepTask(-1, true); });
    document.getElementById("taskNextBtn").addEventListener("click", function () { stepTask(1, true); });
    if (backupPromptExportBtn) backupPromptExportBtn.addEventListener("click", handleBackupPromptExport);
    if (backupPromptDismissBtn) backupPromptDismissBtn.addEventListener("click", handleBackupPromptDismiss);

    var resizeDebounceTimer = null;
    window.addEventListener("resize", function () {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(function () { renderTable(); }, 150);
    });

    renderAll();
    initAutoBackupOnStartup();
    initSwipeNavigation();
    maybeShowBackupPrompt();
  }

  function saveWorkbookSilently() {
    writeWorkbookToStorage();
  }

  /* ---------------------------------------------------------
     Auto-add upcoming dates to TimesX7 (Week planning)
     ---------------------------------------------------------
     - Spaces page rows are NOT shown on TimesX7 (only Times rows are).
     - Times page: a row whose "Time Zero on" date falls today..+7
       days gets a TimesX7 row: Defined time on = that date, Times =
       the row's Time text (falls back to the Space if Time is blank).
     - Times page, Demand = 99: the row repeats on every day of the
       week (Mon-Sun) from its "time on" date to its "Time Zero on" date.
     Each (source, date, text) is added only once - remembered in
     localStorage - so a row you delete from TimesX7 stays deleted. */
  function loadWeekAutoAdded() {
    var out = Object.create(null);
    try {
      var arr = JSON.parse(localStorage.getItem(STORAGE_WEEK_AUTOADD_KEY) || "[]");
      if (Array.isArray(arr)) arr.forEach(function (k) { if (typeof k === "string") out[k] = true; });
    } catch (e) { /* ignore */ }
    return out;
  }
  function saveWeekAutoAdded(map) {
    var keys = Object.keys(map);
    if (keys.length > 3000) keys = keys.slice(keys.length - 3000);
    try { localStorage.setItem(STORAGE_WEEK_AUTOADD_KEY, JSON.stringify(keys)); } catch (e) { /* ignore */ }
  }
  function clearWeekAutoAdded() {
    try { localStorage.removeItem(STORAGE_WEEK_AUTOADD_KEY); } catch (e) { /* ignore */ }
  }


  /* ---------------------------------------------------------
     Times <-> TimesX7 link and Life Ends limit
     --------------------------------------------------------- */
  function dailySheet() { return workbook.find(function (s) { return s.name === "Daily planning - All tasks"; }); }

  // The text TimesX7 shows for a Times row: "Space || Time".
  function timesRowWeekText(r) {
    var timeText = String(r["Timeframe/Meeting"] || "").trim();
    var spaceText = String(r.Space || "").trim();
    return (spaceText && timeText) ? (spaceText + " || " + timeText) : (timeText || spaceText);
  }

  function dateOnlyOf(v) {
    var m = /\d{2}\/\d{2}\/\d{4}/.exec(String(v || ""));
    return m ? m[0] : "";
  }

  // Finds the Times row a TimesX7 row came from (matched by its text and
  // date, since rows carry no id). Returns { row, recurring } or null.
  // recurring = Demand 99 (repeats daily; one Times row, many TimesX7 rows).
  function findWeekSource(weekRow) {
    var daily = dailySheet();
    if (!daily || !Array.isArray(daily.rows) || !weekRow) return null;
    var text = String(weekRow["Timeframes"] || "").trim();
    var date = dateOnlyOf(weekRow["Date/Day"]);
    if (!text || !date) return null;
    var ms = dateToUtcMs(date);
    var recurringHit = null;
    for (var i = 0; i < daily.rows.length; i++) {
      var r = daily.rows[i];
      if (!r) continue;
      var matches = timesRowWeekText(r) === text || String(r["Timeframe/Meeting"] || "").trim() === text;
      if (!matches) continue;
      if (String(r.Demand || "").trim() === "99") {
        var end = dateToUtcMs(r["Time Zero on"]);
        var start = dateToUtcMs(r["Date"]);
        if (end !== null && ms !== null && ms <= end && (start === null || ms >= start || start > end) && !recurringHit) recurringHit = { row: r, recurring: true };
      } else if (r["Time Zero on"] === date) {
        return { row: r, recurring: false };
      }
    }
    return recurringHit;
  }

  // The "Life Ends" of a Space on the Spaces page, or null (no Space,
  // no matching Spaces row, or no valid date = no limit).
  function lifeEndFor(spaceName) {
    var name = String(spaceName || "").trim();
    if (!name) return null;
    var road = workbook.find(function (s) { return s.name === "Road Map - Pending"; });
    if (!road || !Array.isArray(road.rows)) return null;
    for (var i = 0; i < road.rows.length; i++) {
      var r = road.rows[i];
      if (r && String(r.Space || "").trim() === name) {
        var ms = dateToUtcMs(r["Life Ends"]);
        if (ms !== null) return { ms: ms, str: r["Life Ends"] };
      }
    }
    return null;
  }

  function mmddyyyyToIsoStr(v) {
    var m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(v || "");
    return m ? (m[3] + "-" + m[1] + "-" + m[2]) : "";
  }

  // The Space a TimesX7 row belongs to: from its Times source row, else
  // the text before " || ".
  function weekRowSpace(weekRow) {
    var src = findWeekSource(weekRow);
    if (src) return String(src.row.Space || "").trim();
    var t = String(weekRow["Timeframes"] || "");
    var i = t.indexOf(" || ");
    return i === -1 ? "" : t.slice(0, i).trim();
  }

  function warnPastLifeEnd(spaceName, lim) {
    window.alert("The date can't be later than the Life Ends date of \"" + String(spaceName).trim() + "\" on Spaces (" + lim.str + ").");
  }

  function autoAddToWeekPlanning(includeOverdue) {
    includeOverdue = includeOverdue === true; // only the Refresh button passes true
    if (!Array.isArray(workbook)) return 0;
    var week = workbook.find(function (s) { return s.name === "Week planning"; });
    var road = workbook.find(function (s) { return s.name === "Road Map - Pending"; });
    var daily = workbook.find(function (s) { return s.name === "Daily planning - All tasks"; });
    if (!week || !Array.isArray(week.rows)) return 0;

    var now = new Date();
    var todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    var synced = loadWeekAutoAdded();
    var added = 0, changedKeys = false;
    var liveKeys = Object.create(null); // keys the source rows currently produce

    function consider(tag, dateStr, text, legacyText) {
      var ms = dateToUtcMs(dateStr);
      if (ms === null) return;
      var diff = Math.round((ms - todayMs) / 86400000);
      if (diff > 7 || (diff < 0 && !includeOverdue)) return;
      text = sanitizeCell(text, MAX_CELL_LEN).trim();
      legacyText = legacyText ? sanitizeCell(legacyText, MAX_CELL_LEN).trim() : "";
      if (!text) return;
      var key = tag + "|" + dateStr + "|" + text;
      liveKeys[key] = true;
      if (synced[key]) return;
      var parts = dateStr.split("/");
      var dateDay = formatDateDay(new Date(Number(parts[2]), Number(parts[0]) - 1, Number(parts[1])));
      var exists = week.rows.some(function (r) {
        return r && r["Date/Day"] === dateDay && String(r["Timeframes"] || "").trim() === text;
      });
      if (!exists && legacyText && legacyText !== text) {
        // A row added earlier by this same sync, before it started
        // showing "Space || Time": upgrade it in place instead of adding
        // a duplicate beside it.
        var legacyRow = week.rows.find(function (r) {
          return r && r["Date/Day"] === dateDay && String(r["Timeframes"] || "").trim() === legacyText;
        });
        if (legacyRow) { legacyRow["Timeframes"] = text; added++; exists = true; }
      }
      if (!exists) {
        if (week.rows.length >= MAX_ROWS) return;
        week.rows.push({ "Date/Day": dateDay, "Timeframes": text });
        added++;
      }
      synced[key] = true;
      changedKeys = true;
    }

    // TimesX7 is built from the Times page only (Spaces rows are no
    // longer copied here).
    if (daily && Array.isArray(daily.rows)) {
      daily.rows.forEach(function (r) {
        if (!r) return;
        // TimesX7 shows where each time came from: "Space || Time".
        // With only one of the two filled in, that one is used alone.
        var timeText = String(r["Timeframe/Meeting"] || "").trim();
        var spaceText = String(r.Space || "").trim();
        var text = (spaceText && timeText) ? (spaceText + " || " + timeText) : (timeText || spaceText);
        if (String(r.Demand || "").trim() === "99") {
          // Demand 99 = repeats every day (all 7 days) from "time on"
          // (Date) to "Time Zero on", inclusive. Only today and the
          // coming days inside the sync window are added - past days of
          // a daily task are not "overdue" items worth listing.
          var endMs = dateToUtcMs(r["Time Zero on"]);
          if (endMs === null) return;                 // no end date: nothing to repeat to
          var startMs = dateToUtcMs(r["Date"]);
          if (startMs === null || startMs > endMs) startMs = endMs;
          var from = Math.max(startMs, todayMs);
          var to = Math.min(endMs, todayMs + 7 * 86400000);
          for (var ms = from; ms <= to; ms += 86400000) {
            var d = new Date(ms);                      // UTC midnight; read back in UTC
            var dayStr = String(d.getUTCMonth() + 1).padStart(2, "0") + "/" +
              String(d.getUTCDate()).padStart(2, "0") + "/" + d.getUTCFullYear();
            consider("T", dayStr, text, timeText);
          }
          return;
        }
        consider("T", r["Time Zero on"], text, timeText);
      });
    }
    // Forget keys whose source row no longer has that date/text (date
    // changed, cleared, or row removed). Otherwise a date you tried once
    // - e.g. picked, then changed, then picked again - would never be
    // added again. A key for a row that still exists stays remembered, so
    // a TimesX7 row you delete does not come back.
    Object.keys(synced).forEach(function (k) {
      if (!liveKeys[k]) { delete synced[k]; changedKeys = true; }
    });
    if (changedKeys) saveWeekAutoAdded(synced);
    if (added > 0) {
      saveWorkbook();
      var cur = currentSheet();
      if (cur && cur.name === "Week planning") renderAll();
    }
    return added;
  }

  function goToSheetIndex(idx) {
    if (idx < 0 || idx >= workbook.length || idx === selectedSheetIndex) return;
    autoAddToWeekPlanning();
    selectedSheetIndex = idx;
    persistSelectedSheet();
    if (workbook[idx].name === "Summary") {
      refreshSummarySheet(workbook);
      saveWorkbookSilently();
    }
    renderAll();
    var activeBtn = document.querySelector(".nav-btn.active");
    if (activeBtn) activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  // Swipe left/right anywhere in the main content area steps to the
  // next/previous row, but only while the current page is in single-task
  // swipe mode (see isSingleTaskSwipeMode) - i.e. only at phone width,
  // on every page. Switching PAGES is still done by tapping a nav pill.
  // A swipe that starts on an editable cell, an input/select, a button,
  // or a column-resize handle is ignored, so it never fights with text
  // selection, typing, or dragging a control.
  function isInteractiveSwipeTarget(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('.cell-editable, input, select, button, .resize-handle, a');
  }

  function initSwipeNavigation() {
    var contentEl = document.querySelector(".content");
    if (!contentEl) return;
    var startX = 0, startY = 0, tracking = false;

    contentEl.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) { tracking = false; return; }
      if (!isSingleTaskSwipeMode(currentSheet())) { tracking = false; return; }
      if (isInteractiveSwipeTarget(e.target)) { tracking = false; return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });

    contentEl.addEventListener("touchend", function (e) {
      if (!tracking) return;
      tracking = false;
      var touch = e.changedTouches[0];
      if (!touch) return;
      var dx = touch.clientX - startX;
      var dy = touch.clientY - startY;
      var SWIPE_MIN_DISTANCE = 60;
      if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5) return; // mostly a vertical scroll gesture
      if (dx < 0) {
        stepTask(1);
      } else {
        stepTask(-1);
      }
    }, { passive: true });

    contentEl.addEventListener("touchcancel", function () {
      tracking = false;
    }, { passive: true });
  }

  function renderAll() {
    renderNav();
    renderTable();
  }

  // The Spaces (Road Map) and NoSpace (Completed) page buttons are
  // rendered separately, pinned to the title row - Spaces leftmost,
  // NoSpace rightmost (see #navSpacesBtn/#navNoSpaceBtn in index.html) -
  // rather than mixed in with the rest of the page pills below. Every
  // other sheet still gets its normal pill in #nav.
  function renderNav() {
    navEl.replaceChildren();
    workbook.forEach(function (sheet, idx) {
      if (sheet.name === "Road Map - Pending" || sheet.name === "Completed tasks") {
        var pinnedBtn = sheet.name === "Road Map - Pending" ? navSpacesBtn : navNoSpaceBtn;
        var pinnedClass = sheet.name === "Road Map - Pending" ? "nav-btn-spaces" : "nav-btn-nospace";
        if (pinnedBtn) {
          pinnedBtn.className = "nav-btn " + pinnedClass + (idx === selectedSheetIndex ? " active" : "");
          pinnedBtn.textContent = shortSheetName(sheet);
          pinnedBtn.title = shortSheetName(sheet);
          pinnedBtn.onclick = function () { goToSheetIndex(idx); };
        }
        return;
      }
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-btn" + (idx === selectedSheetIndex ? " active" : "");
      btn.textContent = shortSheetName(sheet);
      btn.title = shortSheetName(sheet);
      btn.addEventListener("click", function () {
        goToSheetIndex(idx);
      });
      navEl.appendChild(btn);
    });
  }

  function renderTable() {
    ensureSpaceColors(workbook);
    var sheet = currentSheet();
    pageTitleEl.textContent = shortSheetName(sheet);

    // TimesX7 only: swap the "+ Add" button for a Refresh button.
    var isWeek = sheet.name === "Week planning";
    var addBtnEl = document.getElementById("btnAddRow");
    var refreshBtnEl = document.getElementById("btnRefreshWeek");
    if (addBtnEl) addBtnEl.hidden = isWeek;
    if (refreshBtnEl) refreshBtnEl.hidden = !isWeek;

    // colgroup
    colgroupEl.replaceChildren();
    sheet.columns.forEach(function (col) {
      var c = document.createElement("col");
      var pct = pctWidthForColumn(sheet, col);
      var savedW = manualWidths[widthKey(sheet.name, col)];
      if (savedW) {
        c.style.width = savedW + "px";
      } else if (sheet.name === "Week planning") {
        // Date column is only as wide as a date needs; the Times column
        // gets no width so the fixed-layout table gives it all the rest.
        if (col === "Date/Day") c.style.width = "160px";
      } else {
        c.style.width = pct + "%";
      }
      colgroupEl.appendChild(c);
    });
    var actionsCol = document.createElement("col");
    if (hasActionsColumn(sheet)) {
      var savedActionsW = manualWidths[widthKey(sheet.name, ACTIONS_KEY_TOKEN)];
      if (savedActionsW) {
        actionsCol.style.width = savedActionsW + "px";
      } else {
        actionsCol.style.width = actionsPct(sheet) + "%";
      }
      colgroupEl.appendChild(actionsCol);
    }

    renderTableHead(sheet);
    renderTableBody(sheet);
    applyManualWidths(sheet);
    attachResizeHandles(sheet);
  }

  // Some columns keep their underlying key the same across sheets (so
  // moving/copying rows between them, e.g. Daily planning -> Completed,
  // still lines fields up correctly) but should read differently to the
  // user depending on which page they're on. Right now this is just
  // "Date" on the 24hr (Daily planning) page reading as "time on".
  function displayColumnLabel(sheet, col) {
    if ((sheet.name === "Daily planning - All tasks" || sheet.name === "Completed tasks") && col === "Date") return "time on";
    if ((sheet.name === "Daily planning - All tasks" || sheet.name === "Completed tasks") && col === "Timeframe/Meeting") return "Time";
    if ((sheet.name === "Daily planning - All tasks" || sheet.name === "Completed tasks") && col === "Next Timeframes") return "Next in Time";
    if (sheet.name === "Road Map - Pending" && col === "Key milestones") return "Time";
    if (sheet.name === "Week planning" && col === "Timeframes") return "Times";
    if (sheet.name === "Week planning" && col === "Date/Day") return "Defined time on";
    if (sheet.name === "Summary" && col === "Date") return "Defined time on";
    if (sheet.name === "Summary" && col === "Time") return "Times";
    if (sheet.name === "Quick list" && col === "Small Times") return "Small Stars";
    return col;
  }

  function renderTableHead(sheet) {
    tableHeadEl.replaceChildren();

    // header row
    var headRow = document.createElement("tr");
    sheet.columns.forEach(function (col) {
      var th = document.createElement("th");
      th.dataset.col = col;
      th.style.minWidth = minWidthForColumn(sheet, col) + "px";
      var label = document.createElement("span");
      var sort = sortState[sheet.name];
      var arrow = "";
      if (sort && sort.col === col) arrow = sort.dir === "asc" ? " \u25B2" : " \u25BC";
      label.textContent = displayColumnLabel(sheet, col) + arrow;
      th.appendChild(label);
      th.addEventListener("click", function (e) {
        handleSortClick(sheet, col);
      });
      var handle = document.createElement("span");
      handle.className = "resize-handle";
      handle.title = "Drag to resize column";
      handle.dataset.col = col;
      th.appendChild(handle);
      headRow.appendChild(th);
    });
    var thActions = document.createElement("th");
    if (hasActionsColumn(sheet)) {
      thActions.className = "col-actions";
      thActions.textContent = "Transforms";
      thActions.style.minWidth = "190px";
      var handleActions = document.createElement("span");
      handleActions.className = "resize-handle";
      handleActions.title = "Drag to resize column";
      handleActions.dataset.col = ACTIONS_KEY_TOKEN;
      thActions.appendChild(handleActions);
      headRow.appendChild(thActions);
    }
    tableHeadEl.appendChild(headRow);

    // filter row
    var filterRow = document.createElement("tr");
    filterRow.className = "filter-row";
    sheet.columns.forEach(function (col) {
      var th = document.createElement("th");
      var cf = getColFilter(sheet.name, col);

      var search = document.createElement("input");
      search.type = "text";
      search.className = "filter-search";
      search.placeholder = "Search " + displayColumnLabel(sheet, col);
      search.maxLength = 200;
      search.value = cf.text;
      search.addEventListener("click", function (e) { e.stopPropagation(); });
      search.addEventListener("input", function () {
        cf.text = search.value;
        persistFilters();
        renderTableBody(sheet);
      });
      th.appendChild(search);

      var uniqueVals = getUniqueValues(sheet, col);
      var select = document.createElement("select");
      select.className = "filter-select";
      var optAll = document.createElement("option");
      optAll.value = "";
      optAll.textContent = "All values";
      select.appendChild(optAll);
      var optBlank = document.createElement("option");
      optBlank.value = "\u0000__BLANK__";
      optBlank.textContent = "(Blank)";
      select.appendChild(optBlank);
      uniqueVals.forEach(function (v) {
        var opt = document.createElement("option");
        opt.value = v;
        opt.textContent = (sheet.name === "Week planning" && col === "Date/Day") ? weekDateOnly(v) : v;
        select.appendChild(opt);
      });
      select.value = cf.select || "";
      select.addEventListener("click", function (e) { e.stopPropagation(); });
      select.addEventListener("change", function () {
        cf.select = select.value;
        persistFilters();
        renderTableBody(sheet);
      });
      th.appendChild(select);

      filterRow.appendChild(th);
    });

    var thActionsFilter = document.createElement("th");
    if (hasActionsColumn(sheet)) {
      var clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "clear-filters-btn";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        clearSheetFilters(sheet.name);
        renderTableHead(sheet);
        renderTableBody(sheet);
        applyManualWidths(sheet);
        attachResizeHandles(sheet);
      });
      thActionsFilter.appendChild(clearBtn);
      filterRow.appendChild(thActionsFilter);
    }

    tableHeadEl.appendChild(filterRow);
  }

  function getUniqueValues(sheet, col) {
    var set = newMap();
    sheet.rows.forEach(function (row) {
      var v = (row[col] || "").toString().trim();
      if (v.length > 0) set[v] = true;
    });
    return Object.keys(set).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
  }

  function getFilteredSortedRows(sheet) {
    var sf = getSheetFilters(sheet.name);
    var indexed = sheet.rows.map(function (row, idx) { return { row: row, idx: idx }; });

    var filtered = indexed.filter(function (item) {
      for (var i = 0; i < sheet.columns.length; i++) {
        var col = sheet.columns[i];
        var cf = sf[col];
        if (!cf) continue;
        var val = (item.row[col] || "").toString();
        if (cf.text && cf.text.trim().length > 0) {
          if (val.toLowerCase().indexOf(cf.text.trim().toLowerCase()) === -1) return false;
        }
        if (cf.select) {
          if (cf.select === "\u0000__BLANK__") {
            if (val.trim().length !== 0) return false;
          } else {
            if (val.trim() !== cf.select) return false;
          }
        }
      }
      return true;
    });

    var sort = sortState[sheet.name];
    if (!(sort && sort.col) && sheet.name === "Road Map - Pending") {
      // Spaces default order: Life Ends (earliest first), then Life began;
      // Spaces without a date go last; otherwise the original order.
      var keyOf = function (item, c) {
        var ms = dateToUtcMs(item.row[c]);
        return ms === null ? Infinity : ms;
      };
      filtered.sort(function (a, b) {
        var d = keyOf(a, "Life Ends") - keyOf(b, "Life Ends");
        if (d !== 0 && !isNaN(d)) return d;
        d = keyOf(a, "Life began") - keyOf(b, "Life began");
        if (d !== 0 && !isNaN(d)) return d;
        return a.idx - b.idx;
      });
    }
    if (sort && sort.col) {
      filtered.sort(function (a, b) {
        var av = (a.row[sort.col] || "").toString().toLowerCase();
        var bv = (b.row[sort.col] || "").toString().toLowerCase();
        if (av < bv) return sort.dir === "asc" ? -1 : 1;
        if (av > bv) return sort.dir === "asc" ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }

  function handleSortClick(sheet, col) {
    var current = sortState[sheet.name];
    if (current && current.col === col) {
      if (current.dir === "asc") {
        sortState[sheet.name] = { col: col, dir: "desc" };
      } else {
        delete sortState[sheet.name];
      }
    } else {
      sortState[sheet.name] = { col: col, dir: "asc" };
    }
    renderTableHead(sheet);
    renderTableBody(sheet);
    applyManualWidths(sheet);
    attachResizeHandles(sheet);
  }

  // At phone width, EVERY page shows one row at a time with swipe/Prev/
  // Next navigation instead of a long scrolling list - meant for
  // flipping through individual rows one by one without needing to
  // scroll past a dozen stacked cards. Desktop/tablet widths always
  // show the full list/table regardless of page.
  var currentTaskIndexBySheet = newMap();

  function isMobileWidth() {
    return window.matchMedia && window.matchMedia("(max-width:680px)").matches;
  }

  function isSingleTaskSwipeMode(sheet) {
    // Week planning and Quick list are both running lists, not a set of
    // separate single-item pages - every row should stay stacked on the
    // one page (like the desktop view) instead of being paged through
    // one at a time with a "1 of N" counter. Road Map - Pending is a
    // short list of projects the user wants to scroll through all at
    // once too, rather than flipping through one project per screen.
    if (sheet.name === "Week planning" || sheet.name === "Quick list" || sheet.name === "Road Map - Pending") return false;
    return isMobileWidth();
  }

  // On every page except Summary, one swipe "page" is a single row. On
  // Summary, one page is instead an entire project's worth of task rows,
  // grouped together in the order they first appear among the (filtered/
  // sorted) items - so Prev/Next flips between projects, and all of a
  // project's tasks show stacked one after another on the same page.
  function getSwipePages(sheet, items) {
    if (sheet.name === "Summary") {
      var order = [];
      var byProject = Object.create(null);
      items.forEach(function (item) {
        var project = ((item.row && item.row.Space) || "").toString();
        if (!Object.prototype.hasOwnProperty.call(byProject, project)) { byProject[project] = []; order.push(project); }
        byProject[project].push(item);
      });
      return order.map(function (project) { return byProject[project]; });
    }
    return items.map(function (item) { return [item]; });
  }

  function clampTaskIndex(sheet, itemsLength) {
    var idx = currentTaskIndexBySheet[sheet.name];
    if (typeof idx !== "number" || isNaN(idx)) idx = 0;
    if (idx < 0) idx = 0;
    if (idx > itemsLength - 1) idx = Math.max(0, itemsLength - 1);
    currentTaskIndexBySheet[sheet.name] = idx;
    return idx;
  }

  // wrap = true for the BackIn / NextIn buttons: BackIn on the first item
  // goes to the last ("10 of 10"), NextIn on the last goes to the first.
  // Finger swipes call this without wrap, so they still stop at the ends.
  function stepTask(delta, wrap) {
    var sheet = currentSheet();
    if (!isSingleTaskSwipeMode(sheet)) return;
    var items = getFilteredSortedRows(sheet);
    var pages = getSwipePages(sheet, items);
    var idx = clampTaskIndex(sheet, pages.length);
    if (pages.length === 0) return;
    var newIdx = idx + delta;
    if (wrap) {
      newIdx = (newIdx + pages.length) % pages.length;
    } else if (newIdx < 0 || newIdx > pages.length - 1) {
      return; // swipes stop at the ends
    }
    currentTaskIndexBySheet[sheet.name] = newIdx;
    renderTableBody(sheet);
  }

  function updateRowCountAndTaskNav(sheet, items) {
    var countEl = document.getElementById("rowCountIndicator");
    var swipeNavEl = document.getElementById("taskSwipeNav");
    var posEl = document.getElementById("taskPositionLabel");
    if (!countEl || !swipeNavEl || !posEl) return;
    if (isSingleTaskSwipeMode(sheet)) {
      var pages = getSwipePages(sheet, items);
      countEl.hidden = true;
      swipeNavEl.hidden = false;
      if (pages.length === 0) {
        posEl.textContent = "0 of 0";
      } else {
        var idx = clampTaskIndex(sheet, pages.length);
        if (sheet.name === "Summary") {
          posEl.textContent = "Space " + (idx + 1) + " of " + pages.length;
        } else if (sheet.name === "Daily planning - All tasks" || sheet.name === "All future Tasks") {
          posEl.textContent = "Time " + (idx + 1) + " of " + pages.length;
        } else {
          posEl.textContent = (idx + 1) + " of " + pages.length;
        }
      }
      var prevBtn = document.getElementById("taskPrevBtn");
      var nextBtn = document.getElementById("taskNextBtn");
      var curIdx = clampTaskIndex(sheet, pages.length);
      // The buttons wrap around, so they only need disabling when there is
      // nothing to move to (0 or 1 items).
      if (prevBtn) prevBtn.disabled = (pages.length <= 1);
      if (nextBtn) nextBtn.disabled = (pages.length <= 1);
    } else {
      swipeNavEl.hidden = true;
      countEl.hidden = false;
      countEl.textContent = items.length + (items.length === 1 ? " row" : " rows");
    }
  }

  // Columns that hold free-form, potentially multi-line text and so need
  // the full row width; everything else is short enough to pair two per
  // row in the single-task view (see below) without cramming.
  var LONG_TEXT_COLUMNS = ["Timeframe/Meeting", "Next Timeframes", "Notes", "Key milestones", "Timeframes", "Time"];

  function isLongTextColumn(col) {
    return LONG_TEXT_COLUMNS.indexOf(col) !== -1;
  }

  // In the single-task view, fields are visually reordered (CSS `order`,
  // via inline style) so related fields land in the requested row
  // groups - independent of the underlying column order used everywhere
  // else (the desktop table, CSV export, etc., which are unaffected).
  // Only the 7-column task schema gets a custom order; every other
  // page's fields already pair up sensibly in their natural left-to-
  // right order. Row layout: Space (own row) -> Date + Priority ->
  // Timeframe/Meeting (own row) -> Next Timeframes (own row) -> Time
  // Zero on + Timing -> Actions (own row, always last).
  var TASK_SCHEMA_FIELD_ORDER = {
    "Space": 1,
    "Date": 2,
    "Demand": 3,
    "Timeframe/Meeting": 4,
    "Next Timeframes": 5,
    "Time Zero on": 6,
    "Timing": 7
  };

  // Columns that get the full row to themselves in the single-task view.
  // Space is included here (even though its value is short) because it
  // was specifically requested to sit alone on its own row rather than
  // paired with another field.
  var SOLO_ROW_TASK_SCHEMA_COLUMNS = ["Space", "Timeframe/Meeting", "Next Timeframes"];

  function singleTaskFieldOrder(sheet, col) {
    if (isTaskSheet(sheet)) {
      if (col === "Transforms") return 10;
      if (Object.prototype.hasOwnProperty.call(TASK_SCHEMA_FIELD_ORDER, col)) return TASK_SCHEMA_FIELD_ORDER[col];
    }
    return null;
  }

  function isCompactLongField(sheet, col) {
    return (col === "Transforms") || isLongTextColumn(col) ||
      (isTaskSheet(sheet) && SOLO_ROW_TASK_SCHEMA_COLUMNS.indexOf(col) !== -1);
  }

  // Determines which short fields end up genuinely unpaired once laid out
  // in VISUAL order (i.e. after the `order` overrides above are applied),
  // by simulating the same "long fields force a new row, short fields
  // pair two-at-a-time" packing that the CSS flex-wrap layout performs.
  // This has to be computed here (not with a CSS :nth-child selector)
  // because visual order and DOM/source order are different once a
  // column's `order` has been overridden - a selector that only looks at
  // DOM order picks the wrong field on the task-schema pages (this is
  // what broke the Due date/Status pairing before this fix).
  function computeSoloShortFieldCols(sheet, columnsInDomOrder) {
    var descriptors = columnsInDomOrder.map(function (col, i) {
      var order = singleTaskFieldOrder(sheet, col);
      return { col: col, isLong: isCompactLongField(sheet, col), order: (order === null ? 0 : order), domIndex: i };
    });
    descriptors.sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      return a.domIndex - b.domIndex; // stable tie-break, matches CSS order:0 behavior
    });
    var solo = [];
    var pending = null;
    descriptors.forEach(function (item) {
      if (item.isLong) {
        if (pending) { solo.push(pending.col); pending = null; }
      } else if (pending) {
        pending = null; // paired with the previous pending short field
      } else {
        pending = item;
      }
    });
    if (pending) solo.push(pending.col);
    return solo;
  }

  function renderTableBody(sheet) {
    var items = getFilteredSortedRows(sheet);
    updateRowCountAndTaskNav(sheet, items);
    tableBodyEl.replaceChildren();

    if (isSingleTaskSwipeMode(sheet)) {
      var pages = getSwipePages(sheet, items);
      if (pages.length === 0) {
        var emptyTr = document.createElement("tr");
        var emptyTd = document.createElement("td");
        emptyTd.colSpan = sheet.columns.length + 1;
        emptyTd.className = "empty-state-cell";
        emptyTd.textContent = "No rows on this page.";
        emptyTr.appendChild(emptyTd);
        tableBodyEl.appendChild(emptyTr);
        return;
      }
      var idx = clampTaskIndex(sheet, pages.length);
      var page = pages[idx];
      if (sheet.name === "Summary" && page.length) {
        var projectName = ((page[0].row && page[0].row.Space) || "").toString().trim() || "(No space)";
        tableBodyEl.appendChild(buildSummarySpaceHeaderRow(sheet, projectName));
        var prevTiming = null;
        page.forEach(function (only, taskPos) {
          var t = (only.row && only.row.Timing) || "";
          if (t !== prevTiming) { tableBodyEl.appendChild(buildSummaryStatusRow(sheet, t)); prevTiming = t; }
          tableBodyEl.appendChild(buildSummaryTaskRow(only.row, only.idx, taskPos + 1));
        });
        return;
      }
      page.forEach(function (only) {
        tableBodyEl.appendChild(buildRowElement(sheet, only.row, only.idx, true));
      });
      return;
    }

    if (sheet.name === "Quick list") {
      tableBodyEl.appendChild(buildQuickListHeaderRow(sheet));
      items.forEach(function (item) {
        tableBodyEl.appendChild(buildQuickListRow(sheet, item.row, item.idx));
      });
      return;
    }

    if (sheet.name === "Week planning") {
      groupWeekItemsByDay(items).forEach(function (group) {
        tableBodyEl.appendChild(buildWeekDayHeaderRow(sheet, group.label, group.isToday));
        group.items.forEach(function (item) {
          tableBodyEl.appendChild(buildRowElement(sheet, item.row, item.idx, false));
        });
      });
      return;
    }

    var prevSpace = null, prevTiming = null;
    items.forEach(function (item) {
      if (sheet.name === "Summary") {
        var sp = (item.row && item.row.Space) || "", tm = (item.row && item.row.Timing) || "";
        if (sp !== prevSpace) tableBodyEl.appendChild(buildSummarySpaceHeaderRow(sheet, sp));
        if (sp !== prevSpace || tm !== prevTiming) { tableBodyEl.appendChild(buildSummaryStatusRow(sheet, tm)); prevSpace = sp; prevTiming = tm; }
      }
      var tr = buildRowElement(sheet, item.row, item.idx, false);
      tableBodyEl.appendChild(tr);
    });
  }

  // TimesX7: group rows under a weekday title (Monday..Friday, then
  // Saturday/Sunday if any rows fall there, then rows with no readable
  // date). All Mondays - past or future - land under one Monday heading.
  var WEEK_GROUP_ORDER = [
    { label: "Monday", day: 1 }, { label: "Tuesday", day: 2 }, { label: "Wednesday", day: 3 },
    { label: "Thursday", day: 4 }, { label: "Friday", day: 5 },
    { label: "Saturday", day: 6 }, { label: "Sunday", day: 0 }
  ];

  function weekRowDayIndex(row) {
    var v = String((row && row["Date/Day"]) || "");
    var m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
    if (m) {
      var d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
      if (!isNaN(d.getTime())) return d.getDay();
    }
    var a = DAY_ABBREV.indexOf(v.trim().slice(0, 3));
    return a === -1 ? null : a;
  }

  function weekRowTime(row) {
    var m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String((row && row["Date/Day"]) || ""));
    return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime() : Infinity;
  }

  function groupWeekItemsByDay(items) {
    var userSorted = !!sortState["Week planning"];
    var groups = WEEK_GROUP_ORDER.map(function (g) { return { label: g.label, day: g.day, items: [] }; });
    var other = { label: "No date", day: null, items: [] };
    var todayDay = new Date().getDay();
    groups.forEach(function (g) { g.isToday = (g.day === todayDay); });
    items.forEach(function (item) {
      var di = weekRowDayIndex(item.row);
      var g = groups.find(function (x) { return x.day === di; });
      (g || other).items.push(item);
    });
    groups.push(other);
    if (!userSorted) {
      groups.forEach(function (g) {
        // earliest date first within a weekday; ties keep original order
        g.items.sort(function (a, b) { return (weekRowTime(a.row) - weekRowTime(b.row)) || (a.idx - b.idx); });
      });
    }
    return groups.filter(function (g) { return g.items.length > 0; });
  }

  function buildWeekDayHeaderRow(sheet, label, isToday) {
    var tr = document.createElement("tr");
    tr.className = "week-day-header-row" + (isToday ? " week-day-today" : "");
    var td = document.createElement("td");
    td.colSpan = sheet.columns.length + (hasActionsColumn(sheet) ? 1 : 0);
    td.className = "week-day-header";
    td.textContent = isToday ? (label + " - Today") : label;
    tr.appendChild(td);
    return tr;
  }

  // TimesX7 Refresh: discard the rows on this page and rebuild them from
  // the Spaces (Life Ends) and Times (Time Zero on) pages, exactly the
  // way the automatic sync builds them.
  function handleRefreshWeek() {
    var week = workbook.find(function (s) { return s.name === "Week planning"; });
    if (!week) return;
    if (!window.confirm("Rebuild TimesX7 from the Spaces and Times pages?\n\nRows currently on this page (including any added or edited by hand) will be replaced.")) return;
    week.rows = [];
    clearWeekAutoAdded();
    autoAddToWeekPlanning(true); // Refresh also pulls in overdue items
    saveWorkbook();
    renderAll();
  }

  // Quick list: a bare checklist of one-line items. Column headings are
  // shown once via the normal <thead> (desktop) or this standalone
  // header row (phone width, where <thead> is hidden - see
  // buildQuickListHeaderRow), never repeated per row like the rest of
  // the app's mobile card layout. Tapping the radio button removes that
  // item immediately rather than marking it done - it's a fast add/
  // remove scratch list, not a tracked task list.
  function buildQuickListHeaderRow(sheet) {
    var tr = document.createElement("tr");
    tr.className = "quick-list-header-row";
    var tdItem = document.createElement("td");
    tdItem.className = "quick-list-header-item";
    tdItem.textContent = displayColumnLabel(sheet, "Small Times");
    tr.appendChild(tdItem);
    var tdRadio = document.createElement("td");
    tdRadio.className = "quick-list-header-radio";
    tr.appendChild(tdRadio);
    return tr;
  }

  function buildQuickListRow(sheet, row, sourceIdx) {
    var tr = document.createElement("tr");
    tr.className = "quick-list-row";
    tr.dataset.sourceIdx = String(sourceIdx);

    // The editable item field comes first in the DOM (so Add Row's
    // auto-focus lands here, not on the radio button) and is only
    // moved visually ahead of the radio button via CSS `order`.
    var tdItem = document.createElement("td");
    tdItem.className = "quick-list-item-cell";
    tdItem.appendChild(buildEditableCell(sheet, row, sourceIdx, "Small Times"));
    tr.appendChild(tdItem);

    var tdRadio = document.createElement("td");
    tdRadio.className = "quick-list-radio-cell";
    var radioBtn = document.createElement("button");
    radioBtn.type = "button";
    radioBtn.className = "quick-list-radio";
    radioBtn.setAttribute("aria-label", "Delete this entry");
    radioBtn.title = "Tap to delete this entry";
    radioBtn.addEventListener("click", function () {
      sheet.rows.splice(sourceIdx, 1);
      saveWorkbook();
      renderTable();
    });
    tdRadio.appendChild(radioBtn);
    tr.appendChild(tdRadio);

    return tr;
  }

  // On the Summary page's mobile swipe view, one page is a whole
  // project's worth of task rows (see getSwipePages). The project name
  // is shown once, inline as "Project: Name" (see buildSummaryProjectHeaderRow)
  // rather than repeated above every task, and each task below is a
  // single compact "Task N: ..." line (see buildSummaryTaskRow) rather
  // than a full field-labeled card, so more tasks fit on screen at once.
  function buildSummaryProjectHeaderRow(sheet, projectName) {
    var tr = document.createElement("tr");
    tr.className = "summary-project-header-row";
    var td = document.createElement("td");
    td.colSpan = sheet.columns.length;
    td.className = "summary-project-header";
    var label = document.createElement("span");
    label.className = "summary-project-header-label";
    label.textContent = "Space:";
    var name = document.createElement("span");
    name.className = "summary-project-header-name";
    name.textContent = projectName;
    td.appendChild(label);
    td.appendChild(name);
    tr.appendChild(td);
    return tr;
  }

  // Space group title: same look as TimesX7's weekday titles, but shown
  // exactly as typed (not forced to capitals).
  function buildSummarySpaceHeaderRow(sheet, name) {
    var tr = buildWeekDayHeaderRow(sheet, name, false);
    tr.classList.add("summary-space-title");
    return tr;
  }

  // Sub-heading above each status/timing group of a Space's tasks.
  function buildSummaryStatusRow(sheet, timing) {
    var tr = document.createElement("tr");
    tr.className = "summary-status-row";
    var td = document.createElement("td");
    td.colSpan = sheet.columns.length;
    td.className = "summary-status-cell";
    td.textContent = timing ? timing : "No status";
    tr.appendChild(td);
    return tr;
  }

  // Date shown in place of "Time 1:", "Time 2:" ... : the task's
  // "Time Zero on" (blank when empty). Opens the calendar on tap, cannot
  // go past the Space's Life Ends, and writes the date back to the same
  // row on the Times page so the dates stay in sync.
  function buildSummaryDateInput(row) {
    var input = document.createElement("input");
    input.type = "text";
    input.className = "due-date-input summary-date-input";
    input.readOnly = true;
    input.value = dateOnlyOf(row._date);
    input.placeholder = "";
    input.title = "Time Zero on (tap to pick a date)";
    input.setAttribute("aria-label", "Time Zero on date");

    function dailyRow() {
      var d = dailySheet();
      return (d && typeof row._dailyIdx === "number") ? d.rows[row._dailyIdx] : null;
    }
    // Picking a date must not also open the task on Times.
    input.addEventListener("click", function (e) { e.stopPropagation(); });
    input.addEventListener("keydown", function (e) { e.stopPropagation(); });

    function activate() {
      if (input.type === "date") return;
      var dr = dailyRow();
      if (!dr) { input.blur(); return; }
      input.readOnly = false;
      input.type = "date";
      input.value = mmddyyyyToIsoStr(dr["Time Zero on"] || "");
      var limit = lifeEndFor(dr.Space);
      if (limit) input.max = mmddyyyyToIsoStr(limit.str);
      if (typeof input.showPicker === "function") {
        try { input.showPicker(); } catch (e) { /* ignore */ }
      }
    }
    input.addEventListener("focus", activate);
    input.addEventListener("click", activate);

    input.addEventListener("change", function () {
      var dr = dailyRow();
      if (!dr) return;
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value);
      var mmddyyyy = m ? (m[2] + "/" + m[3] + "/" + m[1]) : "";
      if (input.value && !m) return;
      var limit = lifeEndFor(dr.Space);
      if (mmddyyyy && limit) {
        var ms = dateToUtcMs(mmddyyyy);
        if (ms !== null && ms > limit.ms) {
          input.value = mmddyyyyToIsoStr(dr["Time Zero on"] || "");
          warnPastLifeEnd(dr.Space, limit);
          return;
        }
      }
      dr["Time Zero on"] = mmddyyyy;
      row._date = mmddyyyy;
      saveWorkbook();
    });

    input.addEventListener("blur", function () {
      input.type = "text";
      input.readOnly = true;
      input.value = dateOnlyOf(row._date);
    });
    return input;
  }

  function buildSummaryTaskRow(row, sourceIdx, taskNumber) {
    var tr = document.createElement("tr");
    tr.className = "summary-task-row summary-task-link";
    tr.dataset.sourceIdx = String(sourceIdx);
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.title = "Tap to open this time on Daily planning";
    // Same two labelled fields as TimesX7: "Defined time on" and "Times".
    var tdDate = document.createElement("td");
    tdDate.className = "summary-date-td";
    tdDate.dataset.label = "Defined time on";
    tdDate.appendChild(buildSummaryDateInput(row));
    var tdText = document.createElement("td");
    tdText.className = "summary-times-td";
    tdText.dataset.label = "Times";
    var text = document.createElement("div");
    text.className = "cell-readonly summary-task-text week-times-link";
    text.textContent = (row["Time"] || "").toString();
    var sc2 = spaceColorClass(row.Space);
    if (sc2) text.classList.add(sc2);
    tdText.appendChild(text);
    tr.appendChild(tdDate);
    tr.appendChild(tdText);
    tr.addEventListener("click", function () {
      if (typeof row._dailyIdx === "number") goToDailyTaskFromSummary(row._dailyIdx);
    });
    tr.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (typeof row._dailyIdx === "number") goToDailyTaskFromSummary(row._dailyIdx);
      }
    });
    return tr;
  }

  function buildRowElement(sheet, row, sourceIdx, compact, omitCols) {
    var tr = document.createElement("tr");
    tr.dataset.sourceIdx = String(sourceIdx);
    if (compact) tr.classList.add("single-task-row");
    if (sheet.name === "Week planning") tr.classList.add("week-row");
    if (sheet.name === "Road Map - Pending") tr.classList.add("roadmap-row");

    var soloCols = newMap();
    if (compact) {
      computeSoloShortFieldCols(sheet, sheet.columns.concat(["Transforms"])).forEach(function (c) {
        soloCols[c] = true;
      });
    }

    function styleCompactCell(td, col) {
      if (!compact) return;
      var isLong = isCompactLongField(sheet, col);
      td.classList.add(isLong ? "long-field" : "short-field");
      if (!isLong && soloCols[col]) td.classList.add("short-field-solo");
      var order = singleTaskFieldOrder(sheet, col);
      if (order !== null) td.style.order = String(order);
    }

    sheet.columns.forEach(function (col) {
      if (omitCols && omitCols.indexOf(col) !== -1) return;
      var td = document.createElement("td");
      td.dataset.col = col;
      td.dataset.label = displayColumnLabel(sheet, col);
      styleCompactCell(td, col);
      if (col === "Timing" && isTaskSheet(sheet)) {
        td.appendChild(buildStatusCell(sheet, row, sourceIdx));
      } else if (isCalendarDateColumn(sheet, col)) {
        td.appendChild(sheet.name === "Week planning" ? buildWeekDateDayCell(sheet, row, sourceIdx, col) : buildDueDateCell(sheet, row, sourceIdx, col));
      } else if (sheet.name === "Week planning" && col === "Timeframes") {
        td.appendChild(buildWeekTimesLinkCell(row));
      } else if (sheet.name === "Road Map - Pending" && col === "Space") {
        td.appendChild(buildSpaceLine(sheet, row, sourceIdx, col, tr));
      } else if (sheet.name === "Road Map - Pending" && col === "Key milestones") {
        td.appendChild(buildCollapsibleMilestonesCell(sheet, row, sourceIdx, col));
      } else if (isComputedColumn(sheet, col)) {
        td.appendChild(buildComputedCell(sheet, row, col));
      } else {
        td.appendChild(buildEditableCell(sheet, row, sourceIdx, col));
      }
      tr.appendChild(td);
    });

    var tdActions = document.createElement("td");
    if (hasActionsColumn(sheet)) {
      tdActions.dataset.col = "Transforms";
      tdActions.dataset.label = "Transforms";
      styleCompactCell(tdActions, "Transforms");
      tdActions.appendChild(buildActionsCell(sheet, row, sourceIdx));
      tr.appendChild(tdActions);
    }

    return tr;
  }

  // execCommand("insertText", false, "\n") can normalize an inserted
  // newline into a <br> element in some browsers' contenteditable
  // implementation. That's fine while the cursor is still inside the
  // cell (a <br> still displays as a line break), but <br> elements
  // contribute nothing to .textContent - so on blur the line break
  // silently disappeared. insertTextAtCursor manually inserts a real
  // text node instead, so the newline is guaranteed to be literal text
  // (CSS white-space:pre-wrap on .cell-editable renders it as a line
  // break either way) and survives being read back out.
  function insertTextAtCursor(text) {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0);
    range.deleteContents();
    var node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Defense in depth: even with insertTextAtCursor above, walk the
  // actual DOM (rather than trusting .textContent) so that any stray
  // <br> or block element - from autocorrect, drag-and-drop, or any
  // other browser-specific contenteditable quirk - is still correctly
  // converted to a literal "\n" instead of silently vanishing.
  function extractPlainText(el) {
    var parts = [];
    function walk(node) {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue);
      } else if (node.nodeType === 1) {
        var tag = node.tagName;
        if (tag === "BR") {
          parts.push("\n");
          return;
        }
        var isBlock = (tag === "DIV" || tag === "P");
        if (isBlock && parts.length > 0) parts.push("\n");
        var children = node.childNodes;
        for (var i = 0; i < children.length; i++) walk(children[i]);
      }
    }
    var topChildren = el.childNodes;
    for (var j = 0; j < topChildren.length; j++) walk(topChildren[j]);
    return parts.join("");
  }

  // Opens the Spacetime page at one Space's group (phone: that Space's
  // page; desktop: scrolls to its title and highlights it).
  function goToSpacetimeForSpace(spaceName) {
    var idx = workbook.findIndex(function (sh) { return sh.name === "Summary"; });
    if (idx === -1) return;
    var sheet = workbook[idx];
    var target = String(spaceName || "").trim();
    clearSheetFilters(sheet.name);
    delete sortState[sheet.name];
    selectedSheetIndex = idx;
    persistSelectedSheet();
    if (isSingleTaskSwipeMode(sheet)) {
      var pages = getSwipePages(sheet, getFilteredSortedRows(sheet));
      for (var p = 0; p < pages.length; p++) {
        if (pages[p].some(function (item) { return String((item.row && item.row.Space) || "").trim() === target; })) {
          currentTaskIndexBySheet[sheet.name] = p;
          break;
        }
      }
    }
    renderAll();
    var activeBtn = document.querySelector(".nav-btn.active");
    if (activeBtn) activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    setTimeout(function () {
      var titles = tableBodyEl.querySelectorAll("tr.summary-space-title");
      for (var i = 0; i < titles.length; i++) {
        if (titles[i].textContent.trim() === target) {
          titles[i].scrollIntoView({ behavior: "smooth", block: "center" });
          titles[i].classList.add("row-highlight");
          (function (el) { setTimeout(function () { el.classList.remove("row-highlight"); }, 2200); })(titles[i]);
          break;
        }
      }
    }, 60);
  }

  // Spaces page: every Space is one collapsed line - "+  Space  [name]" -
  // and the + opens that Space's other rows (Time, life dates, Transforms).
  // Collapsed by default; a Space with no name yet starts open so a new
  // row can be filled in. Open/closed is remembered while the app is open.
  var expandedSpaceRows = new WeakSet();

  function buildSpaceLine(sheet, row, sourceIdx, col, tr) {
    var line = document.createElement("div");
    line.className = "space-line";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "space-toggle";
    var label = document.createElement("span");
    label.className = "space-line-label";
    label.textContent = displayColumnLabel(sheet, col);

    if (!String(row[col] || "").trim()) expandedSpaceRows.add(row);

    // Small "Began ... Ends ..." line under the name box, shown while the
    // Space is collapsed so the life dates are visible without opening it.
    var dates = document.createElement("div");
    dates.className = "space-dates";
    function paintDates() {
      var b = String(row["Life began"] || "").trim();
      var e = String(row["Life Ends"] || "").trim();
      dates.replaceChildren();
      dates.hidden = !(b || e);
      var sp = document.createElement("span");
      sp.className = "space-date-item";
      sp.textContent = (b + " \u2014 " + e).trim();
      dates.appendChild(sp);
    }

    function paint() {
      paintDates();
      var open = expandedSpaceRows.has(row);
      tr.classList.toggle("roadmap-collapsed", !open);
      btn.textContent = open ? "\u2212" : "+";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Hide the details of this Space" : "Show the details of this Space");
      btn.title = open ? "Tap to hide the details" : "Tap to show the details";
    }
    btn.addEventListener("click", function () {
      if (expandedSpaceRows.has(row)) expandedSpaceRows.delete(row);
      else expandedSpaceRows.add(row);
      paint();
    });
    paint();

    line.appendChild(btn);
    line.appendChild(label);
    line.appendChild(buildSpaceNavCell(sheet, row, sourceIdx, col));
    var block = document.createElement("div");
    block.className = "space-block";
    block.appendChild(line);
    block.appendChild(dates);
    return block;
  }

  // Spaces page "Space" cell: a single tap opens that Space on Spacetime;
  // a quick double-tap edits the name. An empty Space name is edited
  // straight away (new rows).
  function buildSpaceNavCell(sheet, row, sourceIdx, col) {
    var div = buildEditableCell(sheet, row, sourceIdx, col);
    var tapTimer = null;
    function lockIfNamed() {
      var named = String(row[col] || "").trim() !== "";
      div.contentEditable = named ? "false" : "true";
      div.classList.toggle("space-nav", named);
      div.title = named ? "Tap: open on Spacetime. Double-tap: rename" : "";
    }
    lockIfNamed();
    div.addEventListener("click", function () {
      if (div.contentEditable === "true") return;
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
        div.contentEditable = "true";
        div.classList.remove("space-nav");
        div.focus();
        return;
      }
      var name = row[col];
      tapTimer = setTimeout(function () { tapTimer = null; goToSpacetimeForSpace(name); }, 260);
    });
    div.addEventListener("blur", lockIfNamed);
    return div;
  }

  // Spaces page: the big Key milestones ("Time") text box is hidden behind
  // a down arrow so more Spaces fit on screen; tap the arrow to expand it
  // (up arrow collapses it again). Expanded state is remembered while the
  // app is open, per row.
  var expandedMilestoneRows = new WeakSet();

  function buildCollapsibleMilestonesCell(sheet, row, sourceIdx, col) {
    var wrap = document.createElement("div");
    wrap.className = "milestones-wrap";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "milestones-toggle";
    var box = buildEditableCell(sheet, row, sourceIdx, col);

    function paint() {
      var open = expandedMilestoneRows.has(row);
      wrap.classList.toggle("collapsed", !open);
      btn.textContent = open ? "\u25B2" : "\u25BC";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Hide the text box" : "Show the text box");
      btn.title = open ? "Tap to hide" : "Tap to show";
      btn.classList.toggle("has-content", !!String(row[col] || "").trim());
    }
    btn.addEventListener("click", function () {
      if (expandedMilestoneRows.has(row)) expandedMilestoneRows.delete(row);
      else expandedMilestoneRows.add(row);
      paint();
    });
    box.addEventListener("input", function () { btn.classList.toggle("has-content", !!box.textContent.trim()); });
    box.addEventListener("blur", function () { btn.classList.toggle("has-content", !!String(row[col] || "").trim()); });

    wrap.appendChild(btn);
    wrap.appendChild(box);
    paint();
    return wrap;
  }

  function buildEditableCell(sheet, row, sourceIdx, col) {
    var div = document.createElement("div");
    var large = (col === "Timeframe/Meeting" || col === "Next Timeframes");
    div.className = "cell-editable" + (large ? " cell-large" : "");
    div.contentEditable = "true";
    div.dataset.col = col;

    var rawVal = row[col] || "";
    setCellDisplay(div, col, rawVal, false);

    div.addEventListener("focus", function () {
      setCellDisplay(div, col, rawVal, true);
    });

    div.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        insertTextAtCursor("\n");
      }
    });

    // Only plain typed/pasted text is ever accepted. Dropped content
    // (which can carry rich HTML) and rich-text formatting commands are
    // blocked, so nothing but text can enter a cell.
    div.addEventListener("drop", function (e) { e.preventDefault(); });
    div.addEventListener("beforeinput", function (e) {
      var t = e.inputType || "";
      if (t === "insertFromDrop" || t === "insertFromPasteAsQuotation" || t.indexOf("format") === 0) {
        e.preventDefault();
      }
    });

    div.addEventListener("paste", function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData("text/plain");
      text = sanitizeTyped(text);
      insertTextAtCursor(text);
    });

    div.addEventListener("blur", function () {
      var text = sanitizeTyped(extractPlainText(div)).trim();
      row[col] = text;
      rawVal = text;
      saveWorkbook();
      setCellDisplay(div, col, text, false);
      refreshPillDependentUI(sheet);
    });

    return div;
  }

  function setCellDisplay(div, col, value, editing) {
    if (col === "Space") {
      // Space cells: gray box with the Space's colour strip on the left.
      Array.prototype.slice.call(div.classList).forEach(function (c) {
        if (c === "space-box" || /^space-color-\d+$/.test(c)) div.classList.remove(c);
      });
      var scc = spaceColorClass(value);
      if (scc) { div.classList.add("space-box"); div.classList.add(scc); }
      div.textContent = value;
      return;
    }
    if (editing) {
      div.textContent = value;
      return;
    }
    if (col === "Demand") {
      var pc = priorityPillClass(value);
      if (pc && value.trim().length > 0) {
        div.replaceChildren();
        var span = document.createElement("span");
        span.className = "pill " + pc;
        span.textContent = value;
        div.appendChild(span);
        return;
      }
    }
    div.textContent = value;
  }

  function refreshPillDependentUI(sheet) {
    // Re-render head (unique filter values may have changed) and body pills
    renderTableHead(sheet);
    renderTableBody(sheet);
    applyManualWidths(sheet);
    attachResizeHandles(sheet);
  }

  function buildStatusCell(sheet, row, sourceIdx) {
    var select = document.createElement("select");
    select.className = "status-select " + statusClass(row["Timing"] || "");
    STATUS_OPTIONS.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt;
      o.textContent = opt === "" ? "Select timing" : opt;
      select.appendChild(o);
    });
    select.value = row["Timing"] || "";
    select.addEventListener("change", function () {
      var newVal = select.value;
      if (sheet.name === "Daily planning - All tasks" && newVal === "Complete") {
        row["Timing"] = "Complete";
        moveRowToSheet(sheet, sourceIdx, "Completed tasks", true);
        return;
      }
      row["Timing"] = newVal;
      select.className = "status-select " + statusClass(newVal);
      saveWorkbook();
    });
    return select;
  }

  function buildDueDateCell(sheet, row, sourceIdx, col) {
    var input = document.createElement("input");
    input.type = "text";
    input.className = "due-date-input";
    input.readOnly = true;
    input.value = row[col] || "";
    input.placeholder = "";

    function mmddyyyyToIso(v) {
      var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
      if (!m) return "";
      return m[3] + "-" + m[1] + "-" + m[2];
    }
    function isoToMmddyyyy(v) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!m) return "";
      return m[2] + "/" + m[3] + "/" + m[1];
    }

    function activate() {
      // focus and click both call this; re-running it while the picker
      // is already open resets the control and closes the calendar.
      if (input.type === "date") return;
      input.readOnly = false;
      input.type = "date";
      var iso = mmddyyyyToIso(row[col] || "");
      input.value = iso;
      // Time Zero on cannot be later than the project's Life Ends.
      var limit = (sheet.name === "Daily planning - All tasks" && col === "Time Zero on") ? lifeEndFor(row.Space) : null;
      if (limit) input.max = mmddyyyyToIsoStr(limit.str);
      if (typeof input.showPicker === "function") {
        try { input.showPicker(); } catch (e) { /* ignore */ }
      }
    }

    input.addEventListener("focus", activate);
    input.addEventListener("click", activate);

    input.addEventListener("change", function () {
      var mmddyyyy = isoToMmddyyyy(input.value);
      if (mmddyyyy && sheet.name === "Daily planning - All tasks" && col === "Time Zero on") {
        var lim = lifeEndFor(row.Space);
        var pickedMs = dateToUtcMs(mmddyyyy);
        if (lim && pickedMs !== null && pickedMs > lim.ms) {
          input.value = mmddyyyyToIso(row[col] || "");
          warnPastLifeEnd(row.Space, lim);
          return;
        }
      }
      row[col] = mmddyyyy;
      if (sheet.name === "Road Map - Pending") row["Life span"] = roadMapDuration(row["Life began"], row["Life Ends"]);
      saveWorkbook();
      // Do NOT re-render the table here: iOS fires "change" as soon as the
      // calendar opens (pre-selecting today) and again as the wheel moves,
      // and rebuilding the table would destroy this input and close the
      // picker. Update the calculated Life span cell in place instead;
      // the TimesX7 sync runs when the cell loses focus (see focusout).
      if (sheet.name === "Road Map - Pending") {
        var tr = input.closest("tr");
        var spanCell = tr && tr.querySelector('td[data-col="Life span"] .cell-readonly');
        if (spanCell) spanCell.textContent = row["Life span"] || "";
      }
    });

    input.addEventListener("blur", function () {
      input.type = "text";
      input.readOnly = true;
      input.value = row[col] || "";
    });

    return input;
  }

  // The stored value keeps the weekday ("Thu, 09/24/2026") so existing
  // backups and grouping keep working, but only the date is displayed.
  function weekDateOnly(v) {
    var m = /\d{1,2}\/\d{1,2}\/\d{4}/.exec(String(v || ""));
    return m ? m[0] : String(v || "");
  }

  // Week planning's Date/Day is stored as "Thu, 09/24/2026" (weekday +
  // date) rather than a plain date, so it needs its own calendar-picker
  // cell: the picker itself only understands the MM/DD/YYYY part, and
  // the weekday abbreviation is recomputed from whatever date is picked
  // rather than trusted as stored text.
  function buildWeekDateDayCell(sheet, row, sourceIdx, col) {
    var wrap = document.createElement("div");
    wrap.className = "week-date-wrap";

    // Small radio button before the date: deletes this TimesX7 row and,
    // unless it is a recurring (Demand 99) task, its source row on Times.
    var radio = document.createElement("button");
    radio.type = "button";
    radio.className = "week-radio";
    radio.setAttribute("aria-label", "Delete this task");
    radio.title = "Tap to delete this task";
    radio.addEventListener("click", function () { deleteWeekRowAndSource(sheet, row); });
    wrap.appendChild(radio);

    // Recurring (Demand 99) tasks keep their dates: no editing here.
    var source = findWeekSource(row);
    var locked = !!(source && source.recurring);

    var input = document.createElement("input");
    input.type = "text";
    input.className = "due-date-input";
    input.readOnly = true;
    input.value = weekDateOnly(row[col]);
    input.placeholder = "";
    if (locked) input.title = "Recurring task (Demand 99): its dates stay the same";
    wrap.appendChild(input);

    function mmddyyyyToIso(v) { return mmddyyyyToIsoStr(v); }
    function isoToDateDay(v) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!m) return "";
      // Built from the picked year/month/day parts directly (rather than
      // parsed from the ISO string as UTC) so the weekday can't shift by
      // a day in timezones behind UTC.
      var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return formatDateDay(d);
    }

    function activate() {
      if (locked) { input.blur(); return; }
      // focus and click both call this; re-running it while the picker
      // is already open resets the control and closes the calendar.
      if (input.type === "date") return;
      input.readOnly = false;
      input.type = "date";
      var iso = mmddyyyyToIso(row[col] || "");
      input.value = iso;
      // Cannot go past the project's Life Ends on Spaces.
      var limit = lifeEndFor(weekRowSpace(row));
      if (limit) input.max = mmddyyyyToIsoStr(limit.str);
      if (typeof input.showPicker === "function") {
        try { input.showPicker(); } catch (e) { /* ignore */ }
      }
    }

    input.addEventListener("focus", activate);
    input.addEventListener("click", activate);

    input.addEventListener("change", function () {
      if (locked) return;
      var formatted = isoToDateDay(input.value);
      if (!formatted) return;
      var space = weekRowSpace(row);
      var limit = lifeEndFor(space);
      var newDate = dateOnlyOf(formatted);
      if (limit) {
        var ms = dateToUtcMs(newDate);
        if (ms !== null && ms > limit.ms) {
          input.value = mmddyyyyToIso(row[col] || "");
          warnPastLifeEnd(space, limit);
          return;
        }
      }
      // Find the Times row BEFORE changing the date (it is matched by it),
      // then keep its "Time Zero on" in sync with the new date.
      var src = findWeekSource(row);
      row[col] = formatted;
      if (src && !src.recurring) src.row["Time Zero on"] = newDate;
      saveWorkbook();
    });

    input.addEventListener("blur", function () {
      input.type = "text";
      input.readOnly = true;
      input.value = weekDateOnly(row[col]);
    });

    return wrap;
  }

  // TimesX7's Times column is display-only ("Space || Time"). Tapping it
  // opens the Times page at that task (found by its Space || Time text and
  // date; if there is no matching task it just opens the Times page).
  function buildWeekTimesLinkCell(row) {
    var div = document.createElement("div");
    div.className = "cell-readonly summary-task-link week-times-link";
    var wtext = String(row["Timeframes"] || "");
    var sepAt = wtext.indexOf(" || ");
    // The Space's colour is the background of the whole "Space || Time" box.
    var wcls = spaceColorClass(sepAt === -1 ? wtext : wtext.slice(0, sepAt));
    if (wcls) div.classList.add(wcls);
    div.textContent = wtext;
    div.title = "Tap to open this task on the Times page";
    div.tabIndex = 0;
    div.setAttribute("role", "button");
    function open() {
      var src = findWeekSource(row);
      var daily = dailySheet();
      var idx = (src && daily) ? daily.rows.indexOf(src.row) : -1;
      if (idx !== -1) {
        goToDailyTaskFromSummary(idx);
      } else {
        var di = workbook.findIndex(function (s) { return s.name === "Daily planning - All tasks"; });
        if (di !== -1) goToSheetIndex(di);
      }
    }
    div.addEventListener("click", open);
    div.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    return div;
  }

  // TimesX7 radio: removes the TimesX7 row; for a normal task also removes
  // its source row on Times (and so on NextIn-style copies are untouched).
  // A recurring Demand 99 task stays on Times - only this day is removed.
  function deleteWeekRowAndSource(sheet, row) {
    var idx = sheet.rows.indexOf(row);
    if (idx === -1) return;
    var src = findWeekSource(row);
    if (src && !src.recurring) {
      if (!window.confirm("Delete this task from TimesX7 and from the Times page?")) return;
      var daily = dailySheet();
      var di = daily.rows.indexOf(src.row);
      if (di !== -1) daily.rows.splice(di, 1);
      currentTaskIndexBySheet = newMap();
      refreshSummarySheet(workbook);
    }
    sheet.rows.splice(idx, 1);
    saveWorkbook();
    renderAll();
  }

  // Read-only cell for the Road Map's Life span column: always
  // recomputed from the row's current Life began/Life Ends rather than
  // trusted as stored data, so it can never drift out of sync with
  // those two fields.
  function buildDurationCell(row) {
    var div = document.createElement("div");
    div.className = "cell-readonly";
    row["Life span"] = roadMapDuration(row["Life began"], row["Life Ends"]);
    div.textContent = row["Life span"];
    div.title = "Calculated from Life began and Life Ends";
    return div;
  }

  // Dispatches a computed (read-only) column to the right builder.
  function buildComputedCell(sheet, row, col) {
    if (sheet.name === "Road Map - Pending" && col === "Life span") return buildDurationCell(row);
    if (sheet.name === "Summary" && col === "Time") return buildSummaryTaskLinkCell(row);
    if (sheet.name === "Summary" && col === "Date") return buildSummaryDateInput(row);
    var div = document.createElement("div");
    div.className = "cell-readonly";
    div.textContent = row[col] || "";
    div.title = "Generated automatically from Daily planning";
    return div;
  }

  // Summary's Time cell (desktop/tablet table view): tapping/clicking
  // it jumps straight to that same time's row on Daily planning - All
  // tasks, since Summary itself has no editable fields of its own.
  function buildSummaryTaskLinkCell(row) {
    var div = document.createElement("div");
    div.className = "cell-readonly summary-task-link week-times-link";
    var sc1 = spaceColorClass(row.Space);
    if (sc1) div.classList.add(sc1);
    div.textContent = row["Time"] || "";
    div.title = "Tap to open this time on Daily planning";
    div.tabIndex = 0;
    div.setAttribute("role", "button");
    div.addEventListener("click", function () {
      if (typeof row._dailyIdx === "number") goToDailyTaskFromSummary(row._dailyIdx);
    });
    div.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (typeof row._dailyIdx === "number") goToDailyTaskFromSummary(row._dailyIdx);
      }
    });
    return div;
  }

  // Jumps from a Summary row to the matching row on Daily planning - All
  // tasks: switches to that page, clears any filter/sort there that could
  // otherwise hide the target row, and scrolls to/highlights it (desktop)
  // or lands on its single-task swipe page (phone width).
  function goToDailyTaskFromSummary(dailyRowIdx) {
    var dailySheetIdx = workbook.findIndex(function (s) { return s.name === "Daily planning - All tasks"; });
    if (dailySheetIdx === -1) return;
    var dailySheet = workbook[dailySheetIdx];
    if (dailyRowIdx < 0 || dailyRowIdx >= dailySheet.rows.length) return;

    clearSheetFilters(dailySheet.name);
    delete sortState[dailySheet.name];

    selectedSheetIndex = dailySheetIdx;
    persistSelectedSheet();

    if (isSingleTaskSwipeMode(dailySheet)) {
      var pages = getSwipePages(dailySheet, getFilteredSortedRows(dailySheet));
      for (var p = 0; p < pages.length; p++) {
        if (pages[p].some(function (item) { return item.idx === dailyRowIdx; })) {
          currentTaskIndexBySheet[dailySheet.name] = p;
          break;
        }
      }
    }

    renderAll();
    var activeBtn = document.querySelector(".nav-btn.active");
    if (activeBtn) activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });

    setTimeout(function () {
      var tr = tableBodyEl.querySelector('tr[data-source-idx="' + dailyRowIdx + '"]');
      if (tr) {
        tr.scrollIntoView({ behavior: "smooth", block: "center" });
        tr.classList.add("row-highlight");
        setTimeout(function () { tr.classList.remove("row-highlight"); }, 1800);
      }
    }, 80);
  }

  function buildActionsCell(sheet, row, sourceIdx) {
    var wrap = document.createElement("div");
    wrap.className = "actions-cell";

    var copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "row-btn copy";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", function () {
      copyRow(sheet, sourceIdx);
    });
    wrap.appendChild(copyBtn);

    var moveTarget = hasOwn(MOVE_TARGETS, sheet.name) ? MOVE_TARGETS[sheet.name] : null;
    if (moveTarget) {
      var moveBtn = document.createElement("button");
      moveBtn.type = "button";
      moveBtn.className = "row-btn move";
      moveBtn.textContent = "Move";
      moveBtn.addEventListener("click", function () {
        moveRowToSheet(sheet, sourceIdx, moveTarget, false, true);
      });
      wrap.appendChild(moveBtn);
    }

    if (sheet.name === "Road Map - Pending") {
      var createTasksBtn = document.createElement("button");
      createTasksBtn.type = "button";
      createTasksBtn.className = "row-btn create-tasks";
      createTasksBtn.textContent = "Create Times";
      createTasksBtn.addEventListener("click", function () {
        createDailyTaskFromRoadMap(row);
      });
      wrap.appendChild(createTasksBtn);
    }

    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "row-btn delete";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", function () {
      if (sheet.name === "Road Map - Pending") {
        deleteSpaceWithTasks(sheet, sourceIdx);
        return;
      }
      if (window.confirm("Delete this row from the local portal?")) {
        sheet.rows.splice(sourceIdx, 1);
        saveWorkbook();
        renderTable();
      }
    });
    wrap.appendChild(delBtn);

    return wrap;
  }

  /* ---------------------------------------------------------
     Deleting a Space also deletes its tasks
     --------------------------------------------------------- */
  // Deleting a row on the Spaces page removes the Space and every task
  // that belongs to it: rows on Times, NextIn and NoSpace whose Space
  // matches (same trimmed, exact-case match that Spacetime groups by).
  // Spacetime is rebuilt from Times, so it follows automatically.
  // Safeguards: a Space with no name deletes only its own row (otherwise
  // every task without a Space would be wiped), and if another Spaces row
  // has the same name the Space still exists, so its tasks are kept.
  function deleteSpaceWithTasks(sheet, sourceIdx) {
    var name = String((sheet.rows[sourceIdx] && sheet.rows[sourceIdx].Space) || "").trim();
    var duplicate = name !== "" && sheet.rows.some(function (r, i) {
      return i !== sourceIdx && String((r && r.Space) || "").trim() === name;
    });
    var cascade = name !== "" && !duplicate;
    var targets = [];
    if (cascade) {
      TASK_SHEET_NAMES.forEach(function (n) {
        var t = workbook.find(function (x) { return x.name === n; });
        if (!t) return;
        var count = t.rows.filter(function (r) { return String((r && r.Space) || "").trim() === name; }).length;
        targets.push({ sheet: t, count: count });
      });
    }
    var msg;
    if (cascade) {
      var label = { "Daily planning - All tasks": "Times", "All future Tasks": "NextIn", "Completed tasks": "NoSpace" };
      msg = 'Delete space "' + name + '"?\n\nThis permanently deletes:\n- this row on Spaces';
      targets.forEach(function (t) { msg += "\n- " + t.count + " row(s) on " + label[t.sheet.name]; });
      msg += "\n\nSpacetime updates automatically. This cannot be undone - Export a backup first if unsure.";
    } else if (duplicate) {
      msg = 'Delete this row from Spaces?\n\nAnother Spaces row is also named "' + name + '", so its tasks are kept.';
    } else {
      msg = "Delete this row from the local portal?";
    }
    if (!window.confirm(msg)) return;
    sheet.rows.splice(sourceIdx, 1);
    targets.forEach(function (t) {
      t.sheet.rows = t.sheet.rows.filter(function (r) { return String((r && r.Space) || "").trim() !== name; });
    });
    currentTaskIndexBySheet = newMap();
    refreshSummarySheet(workbook);
    saveWorkbook();
    renderAll();
  }

  /* ---------------------------------------------------------
     Row operations
     --------------------------------------------------------- */
  function copyRow(sheet, sourceIdx) {
    if (sheet.rows.length >= MAX_ROWS) {
      window.alert("Row limit reached for this sheet.");
      return;
    }
    var copy = deepClone(sheet.rows[sourceIdx]);
    sheet.rows.splice(sourceIdx + 1, 0, copy);
    saveWorkbook();
    renderTable();
  }

  // Splits a Key milestones cell into individual milestone items, so each
  // one becomes its own task. Handles milestones typed on separate lines
  // (each optionally prefixed with "1.", "1)", "-", "*", etc.) as well as
  // a single line containing several inline numbered items like
  // "1. Abc 2. Jjjd 3. Kkr". A milestone with no numbering/bullets at all
  // is treated as one single item, same as before this feature existed.
  function splitMilestoneItems(text) {
    var raw = (text || "").toString();
    if (!raw.trim()) return [];
    var normalized = raw.replace(/\r\n|\r/g, "\n");
    // Break inline numbered items apart onto their own line by inserting
    // a line break before any numbered marker that isn't already at the
    // very start of the text.
    normalized = normalized.replace(/(?!^)(\s+)(\d{1,3}\s*[.)])/g, "\n$2");
    var items = [];
    normalized.split("\n").forEach(function (line) {
      var cleaned = line
        .replace(/^\s*[-*\u2022]\s*/, "")
        .replace(/^\s*\d{1,3}\s*[.)]\s*/, "")
        .trim();
      if (cleaned) items.push(cleaned);
    });
    return items;
  }

  // Spins a Road Map row's Space + Key milestones off into new rows on
  // Daily planning, dated today - one timeframe per milestone item, so a
  // list of milestones can be turned into individually trackable
  // timeframes without retyping them.
  function createDailyTaskFromRoadMap(roadRow) {
    var project = sanitizeCell(roadRow.Space, MAX_CELL_LEN).trim();
    var items = splitMilestoneItems(roadRow["Key milestones"]);
    if (!project || items.length === 0) {
      window.alert("Add both a Space and Key milestones value before creating times.");
      return;
    }
    var dailySheet = workbook.find(function (s) { return s.name === "Daily planning - All tasks"; });
    if (!dailySheet) return;
    var dailyLabel = shortSheetName(dailySheet);
    var room = MAX_ROWS - dailySheet.rows.length;
    if (room <= 0) {
      window.alert("Row limit reached for " + dailyLabel + ".");
      return;
    }
    var toCreate = items.slice(0, room);
    toCreate.forEach(function (milestone) {
      dailySheet.rows.push(blankTaskRow({ Date: todayLocalMMDDYYYY(), Space: project, "Timeframe/Meeting": milestone }));
    });
    saveWorkbook();
    var msg = toCreate.length === 1 ? ("1 time created in " + dailyLabel + ".") : (toCreate.length + " times created in " + dailyLabel + ".");
    if (toCreate.length < items.length) msg += " (" + (items.length - toCreate.length) + " skipped - row limit reached.)";
    window.alert(msg);
  }

  function moveRowToSheet(sourceSheet, sourceIdx, targetSheetName, forceComplete, insertAtBottom) {
    var row = sourceSheet.rows[sourceIdx];
    var targetSheet = workbook.find(function (s) { return s.name === targetSheetName; });
    if (!targetSheet) return;
    sourceSheet.rows.splice(sourceIdx, 1);
    var newRow = {};
    targetSheet.columns.forEach(function (col) {
      newRow[col] = row[col] !== undefined ? row[col] : "";
    });
    if (forceComplete) newRow["Timing"] = "Complete";
    if (insertAtBottom) {
      targetSheet.rows.push(newRow);
    } else {
      targetSheet.rows.unshift(newRow);
    }
    saveWorkbook();
    renderTable();
  }

  function handleAddRow() {
    var sheet = currentSheet();
    if (isComputedSheet(sheet)) {
      window.alert(shortSheetName(sheet) + " is generated automatically from Daily planning and can't be added to directly.");
      return;
    }
    if (sheet.rows.length >= MAX_ROWS) {
      window.alert("Row limit reached for this sheet.");
      return;
    }
    var newRow = {};
    sheet.columns.forEach(function (col) { newRow[col] = ""; });
    if (hasDateColumn(sheet)) newRow["Date"] = todayLocalMMDDYYYY();
    if (sheet.name === "Week planning") newRow["Date/Day"] = formatDateDay(new Date());
    sheet.rows.push(newRow);
    saveWorkbook();

    var newIdx = sheet.rows.length - 1;

    // iOS only raises the keyboard for focus() calls made synchronously
    // inside the tap. The new row doesn't exist until after the render
    // below, so focus a throwaway input right now (opening the keyboard),
    // then hand focus to the new row's text box once it's rendered - the
    // keyboard stays up during that hand-off.
    var kbHelper = document.createElement("input");
    kbHelper.type = "text";
    kbHelper.setAttribute("aria-hidden", "true");
    kbHelper.tabIndex = -1;
    kbHelper.className = "kb-helper";
    document.body.appendChild(kbHelper);
    kbHelper.focus({ preventScroll: true });

    // The mobile single-task swipe view only renders whichever one
    // page currentTaskIndexBySheet points at (see renderTableBody) -
    // so without this, the new row lands at the end of the sheet but
    // the view stays parked on the page it was already showing. Jump
    // the swipe position to the new row's page before rendering, so
    // Add Row actually navigates there (mirrors the desktop
    // scroll-to-new-row behavior below).
    if (isSingleTaskSwipeMode(sheet)) {
      var pages = getSwipePages(sheet, getFilteredSortedRows(sheet));
      for (var p = 0; p < pages.length; p++) {
        if (pages[p].some(function (item) { return item.idx === newIdx; })) {
          currentTaskIndexBySheet[sheet.name] = p;
          break;
        }
      }
    }

    renderTable();
    setTimeout(function () {
      var tr = tableBodyEl.querySelector('tr[data-source-idx="' + newIdx + '"]') ||
        Array.prototype.find.call(tableBodyEl.querySelectorAll("tr"), function (r) {
          return r.dataset.sourceIdx === String(newIdx);
        });
      if (!tr) {
        var rows = tableBodyEl.querySelectorAll("tr");
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].dataset.sourceIdx === String(newIdx)) { tr = rows[i]; break; }
        }
      }
      if (tr) {
        tr.scrollIntoView({ behavior: "smooth", block: "center" });
        tr.classList.add("row-highlight");
        setTimeout(function () { tr.classList.remove("row-highlight"); }, 1800);
        // Prefer a text cell: focusing a calendar input would pop its picker open.
        var focusable = tr.querySelector(".cell-editable") || tr.querySelector("input, select, button");
        if (focusable) focusable.focus({ preventScroll: true });
      }
      if (kbHelper.parentNode) kbHelper.parentNode.removeChild(kbHelper);
    }, 80);
  }

  function handleResetSheet() {
    var sheet = currentSheet();
    if (isComputedSheet(sheet)) {
      // Nothing user-entered here - repurpose Reset as a manual refresh
      // from Daily planning, in case Daily planning changed since Summary
      // was last viewed/recomputed.
      refreshSummarySheet(workbook);
      saveWorkbook();
      renderTable();
      return;
    }
    if (!window.confirm("Clear all rows from this sheet?")) return;
    sheet.rows = [];
    saveWorkbook();
    clearSheetFilters(sheet.name);
    delete sortState[sheet.name];
    renderTable();
  }

  /* ---------------------------------------------------------
     CSV export
     --------------------------------------------------------- */
  function csvFieldEscape(value) {
    var v = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    var needsQuote = /[",\r\n]/.test(v);
    v = v.replace(/"/g, '""');
    if (needsQuote) v = '"' + v + '"';
    return v;
  }

  function sanitizeFilename(name) {
    var f = String(name || "").toLowerCase().replace(/[^a-z0-9\-_]+/g, "-").replace(/^-+|-+$/g, "");
    if (!f) f = "sheet";
    return f;
  }

  function handleExportCsv() {
    var sheet = currentSheet();
    var lines = [];
    lines.push(sheet.columns.map(function (col) { return csvFieldEscape(displayColumnLabel(sheet, col)); }).join(","));
    sheet.rows.forEach(function (row) {
      lines.push(sheet.columns.map(function (col) { return csvFieldEscape(row[col]); }).join(","));
    });
    var csv = lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFilename(shortSheetName(sheet)) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------------------------------------------------------
     Daily backup reminder
     --------------------------------------------------------- */
  // Shows/hides the reminder banner. Sets an explicit inline display
  // style in addition to the hidden attribute/property, so visibility
  // never depends on how backup-prompt's own CSS display rule happens
  // to interact with the browser's [hidden] rule.
  function setBackupPromptVisible(visible) {
    if (!backupPromptEl) return;
    backupPromptEl.hidden = !visible;
    backupPromptEl.style.display = visible ? "" : "none";
  }

  // Shows the reminder banner once per calendar day: skipped if a JSON
  // backup has already been exported today, or if the user already
  // tapped "Not today" today. A home-screen web app on iOS has no
  // background execution, so this can't run silently in the background -
  // it can only check and prompt whenever the app is actually opened.
  function maybeShowBackupPrompt() {
    if (!backupPromptEl) return;
    var today = todayLocalMMDDYYYY();
    if (loadLastExportDate() === today) { setBackupPromptVisible(false); return; }
    if (loadLastPromptDismissDate() === today) { setBackupPromptVisible(false); return; }
    setBackupPromptVisible(true);
  }

  function markExportedToday() {
    saveLastExportDate(todayLocalMMDDYYYY());
    setBackupPromptVisible(false);
  }

  function handleBackupPromptExport() {
    handleExportJson();
  }

  function handleBackupPromptDismiss() {
    saveLastPromptDismissDate(todayLocalMMDDYYYY());
    setBackupPromptVisible(false);
  }

  /* ---------------------------------------------------------
     JSON export / import
     --------------------------------------------------------- */
  function handleExportJson() {
    var json = JSON.stringify(workbook, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "participant-spaces-and-time-local-backup.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    markExportedToday();
  }

  function handleImportFileChosen(e) {
    var input = e.target;
    var file = input.files && input.files[0];
    input.value = "";
    if (!file) return;

    if (file.size > MAX_IMPORT_BYTES) {
      window.alert("Backup file is too large.");
      return;
    }

    var reader = new FileReader();
    reader.onerror = function () {
      window.alert("Could not read selected file.");
    };
    reader.onload = function () {
      var text = reader.result;
      var normalized;
      try {
        var parsed = JSON.parse(text);
        normalized = normalizeWorkbook(parsed);
      } catch (err) {
        window.alert("Import blocked: " + err.message);
        return;
      }
      if (!window.confirm("Import this JSON backup and replace all current local data?")) return;
      workbook = normalized;
      clearWeekAutoAdded();
      selectedSheetIndex = 0;
      filters = newMap();
      sortState = newMap();
      currentTaskIndexBySheet = newMap();
      persistSelectedSheet();
      persistFilters();
      saveWorkbook();
      renderAll();
    };
    reader.readAsText(file);
  }

  /* ============================================================
     MANUAL COLUMN RESIZING
     ============================================================ */
  function applyManualWidths(sheet) {
    var cols = colgroupEl.querySelectorAll("col");
    var headCells = tableHeadEl.querySelectorAll("tr:first-child th");
    sheet.columns.forEach(function (col, i) {
      var saved = manualWidths[widthKey(sheet.name, col)];
      if (saved) {
        if (cols[i]) cols[i].style.width = saved + "px";
        if (headCells[i]) headCells[i].style.width = saved + "px";
      }
    });
    var savedActions = hasActionsColumn(sheet) ? manualWidths[widthKey(sheet.name, ACTIONS_KEY_TOKEN)] : 0;
    if (savedActions) {
      var lastCol = cols[cols.length - 1];
      var lastHead = headCells[headCells.length - 1];
      if (lastCol) lastCol.style.width = savedActions + "px";
      if (lastHead) lastHead.style.width = savedActions + "px";
    }
  }

  function attachResizeHandles(sheet) {
    var handles = tableHeadEl.querySelectorAll(".resize-handle");
    handles.forEach(function (handle) {
      handle.addEventListener("mousedown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var col = handle.dataset.col;
        var th = handle.parentElement;
        var startX = e.pageX;
        var startWidth = th.getBoundingClientRect().width;
        var colIndex = Array.prototype.indexOf.call(th.parentElement.children, th);
        var colEl = colgroupEl.querySelectorAll("col")[colIndex];

        handle.classList.add("resizing");

        function onMove(ev) {
          var delta = ev.pageX - startX;
          var newWidth = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(startWidth + delta)));
          th.style.width = newWidth + "px";
          if (colEl) colEl.style.width = newWidth + "px";
        }
        function onUp(ev) {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          handle.classList.remove("resizing");
          var delta = ev.pageX - startX;
          var finalWidth = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(startWidth + delta)));
          manualWidths[widthKey(sheet.name, col)] = finalWidth;
          persistWidths();
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  /* ============================================================
     AUTO BACKUP (File System Access API + IndexedDB)
     ============================================================ */
  var autoBackupHandle = null;
  var autoBackupEnabled = false;
  var snapshotBackupEnabled = false;
  var writeInProgress = false;
  var writePending = false;
  var backupDebounceTimer = null;

  var IDB_SNAPSHOT_KEY = "workbookSnapshotJson";

  // Tier 1: the File System Access picker (showSaveFilePicker) that lets the
  // user pick a real, visible file on disk. Chromium browsers only (Chrome,
  // Edge, Opera) - Safari and Firefox do not implement this picker API.
  function supportsFsaAutoBackup() {
    return typeof window.showSaveFilePicker === "function" && "indexedDB" in window;
  }

  // Tier 2: IndexedDB is available in every modern browser, including
  // Safari and Firefox, even when opening this page directly from disk
  // (file://) with no server. We use it to keep a genuine, silent,
  // automatically-updated backup snapshot that does not require any
  // picker dialog or repeated re-authorization after a restart.
  function supportsIdb() {
    return "indexedDB" in window;
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbSaveHandle(handle) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbLoadHandle() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readonly");
        var req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbSaveSnapshot(jsonText) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(jsonText, IDB_SNAPSHOT_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbLoadSnapshot() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readonly");
        var req = tx.objectStore(IDB_STORE).get(IDB_SNAPSHOT_KEY);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function triggerManualBackupDownload() {
    var json = JSON.stringify(workbook, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "participant-spaces-and-time-autobackup.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    markExportedToday();
  }

  function flashAutoBackupFeedback(text) {
    var btn = document.getElementById("btnAutoBackup");
    var prevText = btn.textContent;
    var prevBg = btn.style.background, prevColor = btn.style.color, prevBorder = btn.style.borderColor;
    btn.textContent = text;
    btn.style.background = "#d1fae5";
    btn.style.color = "#065f46";
    btn.style.borderColor = "#6ee7b7";
    setTimeout(function () {
      btn.textContent = prevText;
      btn.style.background = prevBg;
      btn.style.color = prevColor;
      btn.style.borderColor = prevBorder;
    }, 1600);
  }

  function setAutoBackupButtonState(state) {
    var btn = document.getElementById("btnAutoBackup");
    btn.classList.remove("btn-primary", "btn-danger");
    switch (state) {
      case "enabled":
        btn.textContent = "Backup On";
        btn.title = "Auto Backup Enabled - writing to your chosen file";
        btn.style.background = "#d1fae5";
        btn.style.color = "#065f46";
        btn.style.borderColor = "#6ee7b7";
        break;
      case "snapshot-enabled":
        btn.textContent = "Backup On";
        btn.title = "Auto Backup Enabled (Safari/Firefox browser-storage mode) - tap to download a copy now";
        btn.style.background = "#d1fae5";
        btn.style.color = "#065f46";
        btn.style.borderColor = "#6ee7b7";
        break;
      case "resume":
        btn.textContent = "Resume";
        btn.title = "Resume Auto Backup - tap to reauthorize";
        btn.style.background = "";
        btn.style.color = "";
        btn.style.borderColor = "";
        break;
      case "error":
        btn.textContent = "Error";
        btn.title = "Auto Backup Error - tap to retry";
        btn.style.background = "#fee2e2";
        btn.style.color = "#b91c1c";
        btn.style.borderColor = "#fca5a5";
        break;
      default:
        btn.textContent = "Backup";
        btn.title = "Enable Auto Backup";
        btn.style.background = "";
        btn.style.color = "";
        btn.style.borderColor = "";
    }
  }

  function initAutoBackupOnStartup() {
    if (supportsFsaAutoBackup()) {
      idbLoadHandle().then(function (handle) {
        if (!handle) return;
        autoBackupHandle = handle;
        return handle.queryPermission({ mode: "readwrite" }).then(function (perm) {
          if (perm === "granted") {
            autoBackupEnabled = true;
            setAutoBackupButtonState("enabled");
          } else {
            setAutoBackupButtonState("resume");
          }
        });
      }).catch(function () {
        setAutoBackupButtonState("error");
      });
      return;
    }
    if (supportsIdb()) {
      idbLoadSnapshot().then(function (snapshot) {
        if (snapshot) {
          snapshotBackupEnabled = true;
          setAutoBackupButtonState("snapshot-enabled");
        }
      }).catch(function () { /* leave default label */ });
    }
  }

  function handleAutoBackupButton() {
    if (supportsFsaAutoBackup()) {
      if (autoBackupHandle) {
        // Resume path: re-request permission
        autoBackupHandle.requestPermission({ mode: "readwrite" }).then(function (perm) {
          if (perm === "granted") {
            autoBackupEnabled = true;
            setAutoBackupButtonState("enabled");
            queueAutoBackupWrite();
          } else {
            setAutoBackupButtonState("resume");
          }
        }).catch(function () {
          setAutoBackupButtonState("error");
        });
        return;
      }
      window.showSaveFilePicker({
        suggestedName: "participant-spaces-and-time-autobackup.json",
        types: [{ description: "JSON file", accept: { "application/json": [".json"] } }]
      }).then(function (handle) {
        autoBackupHandle = handle;
        return idbSaveHandle(handle).then(function () {
          autoBackupEnabled = true;
          setAutoBackupButtonState("enabled");
          return writeAutoBackupNow();
        });
      }).catch(function (err) {
        if (err && err.name === "AbortError") return; // canceled picker - do nothing
        setAutoBackupButtonState("error");
        window.alert("Auto backup could not be enabled.");
      });
      return;
    }

    // Safari / Firefox / any browser without the File System Access picker:
    // use an automatically-maintained IndexedDB snapshot instead. This
    // works from a plain double-clicked index.html with no server, and
    // unlike the picker-based flow it never needs to be re-authorized
    // after a browser restart.
    if (!supportsIdb()) {
      window.alert("Automatic backup requires a browser with local storage (IndexedDB) support, which is not available here.");
      return;
    }
    if (!snapshotBackupEnabled) {
      var json = JSON.stringify(workbook, null, 2);
      idbSaveSnapshot(json).then(function () {
        snapshotBackupEnabled = true;
        setAutoBackupButtonState("snapshot-enabled");
      }).catch(function () {
        setAutoBackupButtonState("error");
        window.alert("Auto backup could not be enabled.");
      });
    } else {
      // Already enabled: this click downloads a fresh, portable copy of
      // the automatically-maintained backup right now.
      triggerManualBackupDownload();
      flashAutoBackupFeedback("Saved!");
    }
  }

  function queueAutoBackupWrite() {
    if (autoBackupEnabled && autoBackupHandle) {
      if (backupDebounceTimer) clearTimeout(backupDebounceTimer);
      backupDebounceTimer = setTimeout(function () {
        writeAutoBackupNow();
      }, 250);
      return;
    }
    if (snapshotBackupEnabled) {
      if (backupDebounceTimer) clearTimeout(backupDebounceTimer);
      backupDebounceTimer = setTimeout(function () {
        writeSnapshotBackupNow();
      }, 250);
    }
  }

  function writeSnapshotBackupNow() {
    if (!snapshotBackupEnabled) return Promise.resolve();
    if (writeInProgress) {
      writePending = true;
      return Promise.resolve();
    }
    writeInProgress = true;
    var json = JSON.stringify(workbook, null, 2);
    return idbSaveSnapshot(json).then(function () {
      writeInProgress = false;
      if (writePending) {
        writePending = false;
        queueAutoBackupWrite();
      }
    }).catch(function () {
      writeInProgress = false;
      // Silent - localStorage remains the primary, always-successful save.
    });
  }

  function writeAutoBackupNow() {
    if (!autoBackupHandle) return Promise.resolve();
    if (writeInProgress) {
      writePending = true;
      return Promise.resolve();
    }
    writeInProgress = true;
    return autoBackupHandle.queryPermission({ mode: "readwrite" }).then(function (perm) {
      if (perm !== "granted") {
        return autoBackupHandle.requestPermission({ mode: "readwrite" });
      }
      return perm;
    }).then(function (perm) {
      if (perm !== "granted") {
        setAutoBackupButtonState("resume");
        writeInProgress = false;
        return;
      }
      return autoBackupHandle.createWritable().then(function (writable) {
        return writable.write(JSON.stringify(workbook, null, 2)).then(function () {
          return writable.close();
        });
      }).then(function () {
        writeInProgress = false;
        if (writePending) {
          writePending = false;
          queueAutoBackupWrite();
        }
      });
    }).catch(function () {
      writeInProgress = false;
      setAutoBackupButtonState("error");
    });
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

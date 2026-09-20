"use strict";

/* ============================================================
   Personal Work Planning - Final Secure Portal
   Local-first, dependency-free vanilla JS application.
   ============================================================ */

(function () {
  var STORAGE_DATA_KEY = "workPlanningFinal.v2.data";
  var STORAGE_SHEET_KEY = "workPlanningFinal.v2.selectedSheet";
  var STORAGE_FILTERS_KEY = "workPlanningFinal.v2.filters";
  var STORAGE_WIDTHS_KEY = "workPlanningFinal.v2.safeManualColumnWidths";

  var IDB_NAME = "workPlanningFinal.v2.autoBackup";
  var IDB_VERSION = 1;
  var IDB_STORE = "handles";
  var IDB_KEY = "workbookJson";

  var TASK_COLUMNS = ["Date", "Project", "Priority", "Task/Meeting", "Raised by", "Work with", "Next steps", "Due date", "Status"];
  var TASK_SHEET_NAMES = ["Daily planning - All tasks", "All future Tasks", "Completed tasks"];
  var STATUS_OPTIONS = ["", "Complete", "In-Progress", "Not started", "Hold"];
  var MAX_ROWS = 5000;
  var MAX_CELL_LEN = 5000;
  var MAX_IMPORT_BYTES = 2 * 1024 * 1024;

  var LEGACY_MAP = {
    "Priority": ["Catogery"],
    "Raised by": ["Task-From"],
    "Work with": ["Assigned Resource"],
    "Next steps": ["Notes", "Deliver-TO"]
  };

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
      blankTaskRow({ Project: "AA", Priority: "1", "Task/Meeting": "Analyze the responses from esd - 123 etc" })
    ];
    sheets.push({ name: "Daily planning - All tasks", columns: TASK_COLUMNS.slice(), rows: dailyRows });

    // 2. Week planning
    var weekCols = ["Section", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    var weekRows = [];
    function weekRow(section) {
      return { Section: section, Monday: "", Tuesday: "", Wednesday: "", Thursday: "", Friday: "" };
    }
    for (var s = 1; s <= 10; s++) weekRows.push(weekRow(String(s)));
    weekRows.push(weekRow("Added today"));
    for (var s2 = 1; s2 <= 10; s2++) weekRows.push(weekRow(String(s2)));
    sheets.push({ name: "Week planning", columns: weekCols, rows: weekRows });

    // 3. All future Tasks
    var futureRows = [];
    for (var f = 0; f < 26; f++) futureRows.push(blankTaskRow({ Project: "ee" }));
    sheets.push({ name: "All future Tasks", columns: TASK_COLUMNS.slice(), rows: futureRows });

    // 4. Road Map - Pending
    var roadCols = ["Project", "Task/Meeting", "Notes"];
    var roadRows = [
      { Project: "RR 2.0", "Task/Meeting": "Dedicated", Notes: "" },
      { Project: "", "Task/Meeting": "", Notes: "" }
    ];
    sheets.push({ name: "Road Map - Pending", columns: roadCols, rows: roadRows });

    // 5. Completed tasks (kept last so completed/archived items sit at the
    // end of the page list rather than in the middle of the active pages)
    sheets.push({ name: "Completed tasks", columns: TASK_COLUMNS.slice(), rows: [] });

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
    var columns = Array.isArray(rawSheet.columns) ? rawSheet.columns.map(function (c) { return sanitizeName(c, 120); }).filter(function (c) { return c.length > 0; }) : [];
    if (columns.length === 0) columns = ["Notes"];
    var rows = Array.isArray(rawSheet.rows) ? rawSheet.rows : [];
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
    var outRows = rows.map(function (r) {
      if (!r || typeof r !== "object") r = {};
      var out = {};
      for (var i = 0; i < columns.length; i++) {
        out[columns[i]] = sanitizeCell(r[columns[i]], MAX_CELL_LEN);
      }
      return out;
    });
    return { name: name, columns: columns, rows: outRows };
  }

  // Pages that used to exist in earlier versions of this app and have
  // since been removed. Any older saved workbook that still has them is
  // silently dropped down to the current page set on the next load,
  // rather than showing stale pages that no longer have UI support.
  var REMOVED_PAGE_NAMES = ["Important TimeLines", "Rough Notes"];

  function normalizeWorkbook(raw) {
    if (!Array.isArray(raw)) throw new Error("workbook root must be an array of sheets");
    var sheets = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      if (!s || typeof s !== "object") throw new Error("each sheet must be an object");
      var name = sanitizeName(s.name, 120);
      if (!name) throw new Error("each sheet must have a name");
      if (REMOVED_PAGE_NAMES.indexOf(name) !== -1) continue;
      if (TASK_SHEET_NAMES.indexOf(name) !== -1) {
        sheets.push(normalizeTaskSheet(name, s));
      } else {
        if (!Array.isArray(s.columns) || s.columns.length === 0) throw new Error("sheet '" + name + "' must have a nonempty columns array");
        sheets.push(normalizeGenericSheet(s));
      }
    }
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
    return sheets;
  }

  /* ---------------------------------------------------------
     App State
     --------------------------------------------------------- */
  var workbook = [];
  var selectedSheetIndex = 0;
  var filters = {}; // { sheetName: { colName: { text, select } } }
  var manualWidths = {}; // { "sheet|col": px }
  var sortState = {}; // { sheetName: { col, dir } }

  function todayLocalMMDDYYYY() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    var yyyy = d.getFullYear();
    return mm + "/" + dd + "/" + yyyy;
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
  // MM/DD/YYYY). Keyed by sheet name -> column name.
  var CALENDAR_DATE_COLUMNS = {
    "Daily planning - All tasks": "Due date"
  };

  function isCalendarDateColumn(sheet, col) {
    return CALENDAR_DATE_COLUMNS[sheet.name] === col;
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
    "Daily planning - All tasks": "Daily",
    "Week planning": "Week",
    "All future Tasks": "Future",
    "Road Map - Pending": "Roadmap",
    "Completed tasks": "Completed"
  };

  function shortSheetName(sheet) {
    return NAV_SHORT_NAMES[sheet.name] || sheet.name;
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

  function loadFilters() {
    try {
      var stored = localStorage.getItem(STORAGE_FILTERS_KEY);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch (e) { /* ignore */ }
    return {};
  }

  function loadWidths() {
    try {
      var stored = localStorage.getItem(STORAGE_WIDTHS_KEY);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch (e) { /* ignore */ }
    return {};
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

  function saveWorkbook() {
    try {
      localStorage.setItem(STORAGE_DATA_KEY, JSON.stringify(workbook));
    } catch (e) { /* ignore - storage may be full */ }
    queueAutoBackupWrite();
  }

  /* ---------------------------------------------------------
     Filters helpers
     --------------------------------------------------------- */
  function getSheetFilters(sheetName) {
    if (!filters[sheetName]) filters[sheetName] = {};
    return filters[sheetName];
  }

  function getColFilter(sheetName, col) {
    var sf = getSheetFilters(sheetName);
    if (!sf[col]) sf[col] = { text: "", select: "" };
    return sf[col];
  }

  function clearSheetFilters(sheetName) {
    filters[sheetName] = {};
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
    if (col === "Task/Meeting") return 230;
    if (col === "Next steps") return 190;
    if (col === "Date" || col === "Project" || col === "Priority") return 64;
    if (col === "Raised by" || col === "Work with") return 105;
    if (col === "Status") return 126;
    if (col === "Due date") return 110;
    return 70;
  }

  function pctWidthForColumn(sheet, col) {
    if (isTaskSheet(sheet)) {
      if (col === "Task/Meeting") return 27;
      if (col === "Next steps") return 20;
      if (col === "Date" || col === "Project" || col === "Priority") return 5;
      if (col === "Status") return 10;
      if (col === "Due date") return 7;
      return 9;
    }
    if (col === "Task/Meeting" || col === "Notes" || col === "Next steps") return 27;
    if (col === "Project") return 13;
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

  function init() {
    navEl = document.getElementById("nav");
    pageTitleEl = document.getElementById("pageTitle");
    colgroupEl = document.getElementById("colgroup");
    tableHeadEl = document.getElementById("tableHead");
    tableBodyEl = document.getElementById("tableBody");
    tableScrollerEl = document.getElementById("tableScroller");

    workbook = loadWorkbook();
    selectedSheetIndex = loadSelectedSheetIndex(workbook.length);
    var rememberedName = loadPreviouslySelectedSheetName();
    if (rememberedName) {
      var byName = workbook.findIndex(function (s) { return s.name === rememberedName; });
      if (byName !== -1) selectedSheetIndex = byName;
    }
    filters = loadFilters();
    manualWidths = loadWidths();

    // Persist immediately in case normalization changed things (e.g. added Completed tasks)
    saveWorkbookSilently();

    document.getElementById("btnAddRow").addEventListener("click", handleAddRow);
    document.getElementById("btnAddRowFloating").addEventListener("click", handleAddRow);
    document.getElementById("btnExportJson").addEventListener("click", handleExportJson);
    document.getElementById("btnImportJson").addEventListener("click", function () {
      document.getElementById("fileImport").click();
    });
    document.getElementById("fileImport").addEventListener("change", handleImportFileChosen);
    document.getElementById("btnExportCsv").addEventListener("click", handleExportCsv);
    document.getElementById("btnResetSheet").addEventListener("click", handleResetSheet);
    document.getElementById("btnAutoBackup").addEventListener("click", handleAutoBackupButton);
    document.getElementById("taskPrevBtn").addEventListener("click", function () { stepTask(-1); });
    document.getElementById("taskNextBtn").addEventListener("click", function () { stepTask(1); });

    var resizeDebounceTimer = null;
    window.addEventListener("resize", function () {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(function () { renderTable(); }, 150);
    });

    renderAll();
    initAutoBackupOnStartup();
    initSwipeNavigation();
  }

  function saveWorkbookSilently() {
    try { localStorage.setItem(STORAGE_DATA_KEY, JSON.stringify(workbook)); } catch (e) { /* ignore */ }
  }

  function goToSheetIndex(idx) {
    if (idx < 0 || idx >= workbook.length || idx === selectedSheetIndex) return;
    selectedSheetIndex = idx;
    persistSelectedSheet();
    renderAll();
    var activeBtn = navEl.querySelector(".nav-btn.active");
    if (activeBtn) activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  // Swipe left/right anywhere in the main content area steps to the
  // next/previous row, but only while the current page is in single-task
  // swipe mode (see SINGLE_TASK_SWIPE_PAGES / isSingleTaskSwipeMode) -
  // i.e. only at phone width, and only on Daily planning - All tasks and
  // Completed tasks. Elsewhere, a swipe does nothing; switching pages is
  // done by tapping a nav pill. A swipe that starts on an editable cell,
  // an input/select, a button, or a column-resize handle is ignored, so
  // it never fights with text selection, typing, or dragging a control.
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

  function renderNav() {
    navEl.replaceChildren();
    workbook.forEach(function (sheet, idx) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-btn" + (idx === selectedSheetIndex ? " active" : "");
      btn.textContent = shortSheetName(sheet);
      btn.title = sheet.name;
      btn.addEventListener("click", function () {
        goToSheetIndex(idx);
      });
      navEl.appendChild(btn);
    });
  }

  function renderTable() {
    var sheet = currentSheet();
    pageTitleEl.textContent = sheet.name;

    // colgroup
    colgroupEl.replaceChildren();
    sheet.columns.forEach(function (col) {
      var c = document.createElement("col");
      var pct = pctWidthForColumn(sheet, col);
      var savedW = manualWidths[widthKey(sheet.name, col)];
      if (savedW) {
        c.style.width = savedW + "px";
      } else {
        c.style.width = pct + "%";
      }
      colgroupEl.appendChild(c);
    });
    var actionsCol = document.createElement("col");
    var savedActionsW = manualWidths[widthKey(sheet.name, ACTIONS_KEY_TOKEN)];
    if (savedActionsW) {
      actionsCol.style.width = savedActionsW + "px";
    } else {
      actionsCol.style.width = actionsPct(sheet) + "%";
    }
    colgroupEl.appendChild(actionsCol);

    renderTableHead(sheet);
    renderTableBody(sheet);
    applyManualWidths(sheet);
    attachResizeHandles(sheet);
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
      label.textContent = col + arrow;
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
    thActions.className = "col-actions";
    thActions.textContent = "Actions";
    thActions.style.minWidth = "190px";
    var handleActions = document.createElement("span");
    handleActions.className = "resize-handle";
    handleActions.title = "Drag to resize column";
    handleActions.dataset.col = ACTIONS_KEY_TOKEN;
    thActions.appendChild(handleActions);
    headRow.appendChild(thActions);
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
      search.placeholder = "Search " + col;
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
        opt.textContent = v;
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

    tableHeadEl.appendChild(filterRow);
  }

  function getUniqueValues(sheet, col) {
    var set = {};
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

  // Pages where, at phone width, the table shows one row at a time with
  // swipe/Prev/Next navigation instead of a long scrolling list - meant
  // for flipping through individual tasks one by one. Desktop/tablet
  // widths always show the full list regardless of page.
  var SINGLE_TASK_SWIPE_PAGES = ["Daily planning - All tasks", "Completed tasks"];
  var currentTaskIndexBySheet = {};

  function isMobileWidth() {
    return window.matchMedia && window.matchMedia("(max-width:680px)").matches;
  }

  function isSingleTaskSwipeMode(sheet) {
    return isMobileWidth() && SINGLE_TASK_SWIPE_PAGES.indexOf(sheet.name) !== -1;
  }

  function clampTaskIndex(sheet, itemsLength) {
    var idx = currentTaskIndexBySheet[sheet.name];
    if (typeof idx !== "number" || isNaN(idx)) idx = 0;
    if (idx < 0) idx = 0;
    if (idx > itemsLength - 1) idx = Math.max(0, itemsLength - 1);
    currentTaskIndexBySheet[sheet.name] = idx;
    return idx;
  }

  function stepTask(delta) {
    var sheet = currentSheet();
    if (!isSingleTaskSwipeMode(sheet)) return;
    var items = getFilteredSortedRows(sheet);
    var idx = clampTaskIndex(sheet, items.length);
    var newIdx = idx + delta;
    if (newIdx < 0 || newIdx > items.length - 1) return; // stop at the ends, no wraparound
    currentTaskIndexBySheet[sheet.name] = newIdx;
    renderTableBody(sheet);
  }

  function updateRowCountAndTaskNav(sheet, items) {
    var countEl = document.getElementById("rowCountIndicator");
    var swipeNavEl = document.getElementById("taskSwipeNav");
    var posEl = document.getElementById("taskPositionLabel");
    if (!countEl || !swipeNavEl || !posEl) return;
    if (isSingleTaskSwipeMode(sheet)) {
      countEl.hidden = true;
      swipeNavEl.hidden = false;
      if (items.length === 0) {
        posEl.textContent = "0 of 0";
      } else {
        var idx = clampTaskIndex(sheet, items.length);
        posEl.textContent = (idx + 1) + " of " + items.length;
      }
      var prevBtn = document.getElementById("taskPrevBtn");
      var nextBtn = document.getElementById("taskNextBtn");
      var curIdx = clampTaskIndex(sheet, items.length);
      if (prevBtn) prevBtn.disabled = (items.length === 0 || curIdx <= 0);
      if (nextBtn) nextBtn.disabled = (items.length === 0 || curIdx >= items.length - 1);
    } else {
      swipeNavEl.hidden = true;
      countEl.hidden = false;
      countEl.textContent = items.length + (items.length === 1 ? " row" : " rows");
    }
  }

  function renderTableBody(sheet) {
    var items = getFilteredSortedRows(sheet);
    updateRowCountAndTaskNav(sheet, items);
    tableBodyEl.replaceChildren();

    if (isSingleTaskSwipeMode(sheet)) {
      if (items.length === 0) {
        var emptyTr = document.createElement("tr");
        var emptyTd = document.createElement("td");
        emptyTd.colSpan = sheet.columns.length + 1;
        emptyTd.className = "empty-state-cell";
        emptyTd.textContent = "No rows on this page.";
        emptyTr.appendChild(emptyTd);
        tableBodyEl.appendChild(emptyTr);
        return;
      }
      var idx = clampTaskIndex(sheet, items.length);
      var only = items[idx];
      tableBodyEl.appendChild(buildRowElement(sheet, only.row, only.idx));
      return;
    }

    items.forEach(function (item) {
      var tr = buildRowElement(sheet, item.row, item.idx);
      tableBodyEl.appendChild(tr);
    });
  }

  function buildRowElement(sheet, row, sourceIdx) {
    var tr = document.createElement("tr");
    tr.dataset.sourceIdx = String(sourceIdx);

    sheet.columns.forEach(function (col) {
      var td = document.createElement("td");
      td.dataset.label = col;
      if (col === "Status" && isTaskSheet(sheet)) {
        td.appendChild(buildStatusCell(sheet, row, sourceIdx));
      } else if (isCalendarDateColumn(sheet, col)) {
        td.appendChild(buildDueDateCell(sheet, row, sourceIdx, col));
      } else {
        td.appendChild(buildEditableCell(sheet, row, sourceIdx, col));
      }
      tr.appendChild(td);
    });

    var tdActions = document.createElement("td");
    tdActions.dataset.label = "Actions";
    tdActions.appendChild(buildActionsCell(sheet, row, sourceIdx));
    tr.appendChild(tdActions);

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

  function buildEditableCell(sheet, row, sourceIdx, col) {
    var div = document.createElement("div");
    var large = (col === "Task/Meeting" || col === "Next steps");
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
    if (editing) {
      div.textContent = value;
      return;
    }
    if (col === "Priority") {
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
    if (col === "Project") {
      var pjc = projectPillClass(value);
      if (pjc && value.trim().length > 0) {
        div.replaceChildren();
        var span2 = document.createElement("span");
        span2.className = "pill " + pjc;
        span2.textContent = value;
        div.appendChild(span2);
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
    select.className = "status-select " + statusClass(row["Status"] || "");
    STATUS_OPTIONS.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt;
      o.textContent = opt === "" ? "Select status" : opt;
      select.appendChild(o);
    });
    select.value = row["Status"] || "";
    select.addEventListener("change", function () {
      var newVal = select.value;
      if (sheet.name === "Daily planning - All tasks" && newVal === "Complete") {
        row["Status"] = "Complete";
        moveRowToSheet(sheet, sourceIdx, "Completed tasks", true);
        return;
      }
      row["Status"] = newVal;
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
      input.readOnly = false;
      input.type = "date";
      var iso = mmddyyyyToIso(row[col] || "");
      input.value = iso;
      if (typeof input.showPicker === "function") {
        try { input.showPicker(); } catch (e) { /* ignore */ }
      }
    }

    input.addEventListener("focus", activate);
    input.addEventListener("click", activate);

    input.addEventListener("change", function () {
      var mmddyyyy = isoToMmddyyyy(input.value);
      row[col] = mmddyyyy;
      saveWorkbook();
    });

    input.addEventListener("blur", function () {
      input.type = "text";
      input.readOnly = true;
      input.value = row[col] || "";
    });

    return input;
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

    var moveTarget = MOVE_TARGETS[sheet.name];
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

    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "row-btn delete";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", function () {
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

  function moveRowToSheet(sourceSheet, sourceIdx, targetSheetName, forceComplete, insertAtBottom) {
    var row = sourceSheet.rows[sourceIdx];
    var targetSheet = workbook.find(function (s) { return s.name === targetSheetName; });
    if (!targetSheet) return;
    sourceSheet.rows.splice(sourceIdx, 1);
    var newRow = {};
    targetSheet.columns.forEach(function (col) {
      newRow[col] = row[col] !== undefined ? row[col] : "";
    });
    if (forceComplete) newRow["Status"] = "Complete";
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
    if (sheet.rows.length >= MAX_ROWS) {
      window.alert("Row limit reached for this sheet.");
      return;
    }
    var newRow = {};
    sheet.columns.forEach(function (col) { newRow[col] = ""; });
    if (hasDateColumn(sheet)) newRow["Date"] = todayLocalMMDDYYYY();
    sheet.rows.push(newRow);
    saveWorkbook();
    renderTable();

    var newIdx = sheet.rows.length - 1;
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
        var focusable = tr.querySelector('[contenteditable="true"], input, select, button');
        if (focusable) focusable.focus({ preventScroll: true });
      }
    }, 80);
  }

  function handleResetSheet() {
    if (!window.confirm("Clear all rows from this sheet?")) return;
    var sheet = currentSheet();
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
    var needsQuote = /[",\n]/.test(v);
    v = v.replace(/"/g, '""');
    if (needsQuote) v = '"' + v + '"';
    return v;
  }

  function sanitizeFilename(name) {
    var f = (name || "").toLowerCase().replace(/[^a-z0-9\-_]+/g, "-").replace(/^-+|-+$/g, "");
    if (!f) f = "sheet";
    return f;
  }

  function handleExportCsv() {
    var sheet = currentSheet();
    var lines = [];
    lines.push(sheet.columns.map(csvFieldEscape).join(","));
    sheet.rows.forEach(function (row) {
      lines.push(sheet.columns.map(function (col) { return csvFieldEscape(row[col]); }).join(","));
    });
    var csv = lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFilename(sheet.name) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
    a.download = "personal-work-planning-local-backup.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
      selectedSheetIndex = 0;
      filters = {};
      sortState = {};
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
    var savedActions = manualWidths[widthKey(sheet.name, ACTIONS_KEY_TOKEN)];
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
          var newWidth = Math.max(60, Math.round(startWidth + delta));
          th.style.width = newWidth + "px";
          if (colEl) colEl.style.width = newWidth + "px";
        }
        function onUp(ev) {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          handle.classList.remove("resizing");
          var delta = ev.pageX - startX;
          var finalWidth = Math.max(60, Math.round(startWidth + delta));
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
    a.download = "personal-work-planning-autobackup.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
        suggestedName: "personal-work-planning-autobackup.json",
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

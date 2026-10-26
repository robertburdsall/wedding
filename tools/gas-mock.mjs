// A small in-memory imitation of the Google Apps Script services Code.gs uses
// (SpreadsheetApp, MailApp, LockService, ContentService, Utilities, Session).
// It runs the real Code.gs file unchanged inside a Node VM so it can be tested locally.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Sheets creates dates in the spreadsheet's time zone; match it so tests behave the same on any machine.
process.env.TZ = 'America/New_York';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CODE_GS_PATH = process.env.CODE_GS_PATH || path.join(root, 'apps-script', 'Code.gs');

// Returns an object whose unknown methods are chainable no-ops (formatting calls, builders, ...).
function chain(target = {}) {
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'then') return undefined;
      if (prop === 'build') return () => ({});
      return () => proxy;
    },
  });
  return proxy;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Imitates Google Sheets turning typed text into numbers and dates.
function autoParse(value, numberFormat) {
  if (typeof value !== 'string') return { v: value };
  if (value.startsWith("'")) return { v: value.slice(1) };
  if (value.startsWith('=')) return { v: '', f: value };
  if (numberFormat === '@') return { v: value };
  const s = value.trim();
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return { v: Number(s) };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { v: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { v: new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) };
  m = s.match(/^(?:[a-z]+,\s*)?([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m && MONTHS.includes(m[1].toLowerCase())) return { v: new Date(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2])) };
  m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
    return { v: new Date(1899, 11, 30, h, Number(m[2])) };
  }
  return { v: value };
}

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) {
      throw new Error(`Invalid range ${row},${col},${numRows},${numCols}`);
    }
    Object.assign(this, { sheet, row, col, numRows, numCols });
    return chain(this);
  }
  cell(r, c) { return this.sheet.cell(this.row + r, this.col + c); }
  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getLastRow() { return this.row + this.numRows - 1; }
  getLastColumn() { return this.col + this.numCols - 1; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        const cell = this.sheet.peek(this.row + r, this.col + c);
        row.push(cell ? (cell.v instanceof Date ? new Date(cell.v.getTime()) : cell.v) : '');
      }
      out.push(row);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  getFormula() { const c = this.sheet.peek(this.row, this.col); return (c && c.f) || ''; }
  setValues(values) {
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
      throw new Error(`The number of rows or columns in the data does not match the range (${this.numRows}x${this.numCols}).`);
    }
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.write(this.row + i, this.col + j, v)));
    return this;
  }
  setValue(v) {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.write(this.row + r, this.col + c, v);
    return this;
  }
  setFormula(f) { const c = this.cell(0, 0); c.f = f; c.v = ''; return this; }
  setNumberFormat(fmt) {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.cell(r, c).fmt = fmt;
    return this;
  }
  setNote(note) { this.cell(0, 0).note = note; return this; }
  getNote() { const c = this.sheet.peek(this.row, this.col); return (c && c.note) || ''; }
}

export class MockSheet {
  constructor(ss, name) {
    this.ss = ss;
    this.name = name;
    this.data = []; // data[r][c] = { v, f, fmt, note }  (0-based)
    this.maxRows = 1000;
    this.frozenRows = 0;
    this.writes = 0;
    return chain(this);
  }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  peek(r, c) { return this.data[r - 1] && this.data[r - 1][c - 1]; }
  cell(r, c) {
    if (!this.data[r - 1]) this.data[r - 1] = [];
    if (!this.data[r - 1][c - 1]) this.data[r - 1][c - 1] = { v: '' };
    return this.data[r - 1][c - 1];
  }
  write(r, c, value) {
    const cell = this.cell(r, c);
    const parsed = autoParse(value, cell.fmt);
    cell.v = parsed.v;
    cell.f = parsed.f || '';
    this.writes++;
  }
  hasContent(cell) { return cell && ((cell.v !== '' && cell.v !== null && cell.v !== undefined) || cell.f); }
  getLastRow() {
    for (let r = this.data.length; r >= 1; r--) {
      if ((this.data[r - 1] || []).some((c) => this.hasContent(c))) return r;
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach((row) => (row || []).forEach((c, i) => { if (this.hasContent(c)) max = Math.max(max, i + 1); }));
    return max;
  }
  getMaxRows() { return this.maxRows; }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row === 'string') throw new Error('A1 notation is not supported by the mock');
    return new MockRange(this, row, col, numRows, numCols);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(values) {
    const r = this.getLastRow() + 1;
    values.forEach((v, i) => this.write(r, i + 1, v));
    return this;
  }
  insertRowBefore(r) { this.data.splice(r - 1, 0, []); return this; }
  clear() { this.data = []; return this; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  getActiveRangeList() { return { getRanges: () => this.ss.activeRanges } ; }

  // Test helpers (not part of the real API)
  rows() { return this.getDataRange().getValues(); }
  objects() {
    const [header, ...rows] = this.rows();
    return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  }
}

export class MockSpreadsheet {
  constructor() {
    this.sheets = [new MockSheet(this, 'Sheet1')];
    this.activeSheet = this.sheets[0];
    this.activeRanges = [];
  }
  getSheetByName(name) { return this.sheets.find((s) => s.getName() === name) || null; }
  getSheets() { return this.sheets.slice(); }
  insertSheet(name, index) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const sheet = new MockSheet(this, name);
    if (index === undefined) this.sheets.push(sheet); else this.sheets.splice(index, 0, sheet);
    return sheet;
  }
  deleteSheet(sheet) {
    if (this.sheets.length === 1) throw new Error('You can\'t remove all the sheets in a document.');
    this.sheets = this.sheets.filter((s) => s !== sheet);
  }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/MOCK/edit'; }
  toast() {}
  // Test helper: pretend the user selected some rows on a sheet.
  select(sheetName, ...rowRanges) {
    this.activeSheet = this.getSheetByName(sheetName);
    this.activeRanges = rowRanges.map(([from, to = from]) => this.activeSheet.getRange(from, 1, to - from + 1, 1));
  }
}

function formatDate(date, timeZone, pattern) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const month = Number(parts.month);
  const hour = Number(parts.hour);
  const tokens = {
    yyyy: parts.year, MMMM: MONTHS[month - 1][0].toUpperCase() + MONTHS[month - 1].slice(1), MM: String(month).padStart(2, '0'),
    dd: String(parts.day).padStart(2, '0'), d: String(Number(parts.day)), EEEE: parts.weekday,
    HH: String(hour).padStart(2, '0'), h: String(hour % 12 || 12), mm: parts.minute, a: hour < 12 ? 'AM' : 'PM',
  };
  return pattern.replace(/yyyy|MMMM|MM|dd|d|EEEE|HH|h|mm|a/g, (t) => tokens[t]);
}

/**
 * Creates a fresh fake Google environment with Code.gs loaded into it.
 * Returns { gs, ss, mail, ui, lock, logs } where `gs` holds Code.gs's global functions.
 */
export function createGas({ timeZone = 'America/New_York', quota = 100, ownerEmail = 'owner@example.com', code } = {}) {
  const ss = new MockSpreadsheet();
  const mail = { sent: [], quota, failNext: false };
  const lock = { held: false, acquired: 0, released: 0 };
  const ui = { alerts: [], menus: [], nextAnswer: 'OK' };
  const logs = { errors: [] };
  // CacheService with a clock tests can move forward (cache.advance(ms)).
  const cache = {
    store: new Map(), offsetMs: 0,
    now() { return Date.now() + this.offsetMs; },
    advance(ms) { this.offsetMs += ms; },
  };

  const env = {
    Date, // share the Date class so `instanceof Date` works across the VM boundary
    console: { log() {}, info() {}, warn() {}, error: (...a) => logs.errors.push(a.join(' ')) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getActiveSheet: () => ss.activeSheet,
      flush: () => {},
      getUi: () => ({
        alert: (msg, buttons) => { ui.alerts.push(msg); return buttons ? ui.nextAnswer : 'OK'; },
        createMenu: (name) => {
          const menu = { name, items: [] };
          ui.menus.push(menu);
          const m = { addItem: (label, fn) => { menu.items.push([label, fn]); return m; }, addSeparator: () => m, addToUi: () => {} };
          return m;
        },
        ButtonSet: { OK: 'OK_ONLY', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
        Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' },
      }),
      newDataValidation: () => chain(),
      newConditionalFormatRule: () => chain(),
    },
    MailApp: {
      sendEmail(opts) {
        if (typeof opts !== 'object') throw new Error('mock only supports sendEmail(options)');
        if (mail.failNext) { mail.failNext = false; throw new Error('Service invoked too many times for one day: email.'); }
        const recipients = String(opts.to).split(',').length;
        if (recipients > mail.quota) throw new Error('Service invoked too many times for one day: email.');
        mail.quota -= recipients;
        mail.sent.push(opts);
      },
      getRemainingDailyQuota: () => mail.quota,
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (lock.held) throw new Error('Lock already held (re-entrant call?)'); lock.held = true; lock.acquired++; },
        tryLock() { this.waitLock(); return true; },
        releaseLock() { if (lock.held) { lock.held = false; lock.released++; } },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput(content) {
        const out = { content, mimeType: 'text/plain', setMimeType(m) { this.mimeType = m; return this; }, getContent() { return this.content; } };
        return out;
      },
    },
    Utilities: { formatDate, getUuid: () => randomUUID() },
    CacheService: {
      getScriptCache: () => ({
        get(key) {
          const e = cache.store.get(key);
          if (!e) return null;
          if (e.expires <= cache.now()) { cache.store.delete(key); return null; }
          return e.value;
        },
        put(key, value, seconds = 600) {
          if (typeof value !== 'string') throw new Error('CacheService values must be strings');
          if (seconds > 21600) throw new Error('CacheService expiration is at most 21600 seconds');
          cache.store.set(key, { value, expires: cache.now() + seconds * 1000 });
        },
        remove(key) { cache.store.delete(key); },
      }),
    },
    Session: { getScriptTimeZone: () => timeZone, getActiveUser: () => ({ getEmail: () => ownerEmail }) },
  };

  const context = vm.createContext(env);
  vm.runInContext(code ?? readFileSync(CODE_GS_PATH, 'utf8'), context, { filename: 'Code.gs' });

  // Arrays/objects made inside the VM have the VM's prototypes; copy them into this realm so
  // assert.deepStrictEqual compares them by value.
  const vmObjectProto = vm.runInContext('Object.prototype', context);
  const normalize = (v) => {
    if (Array.isArray(v)) return Array.from(v, normalize); // Array.from builds an array in this realm
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === vmObjectProto) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
    }
    return v;
  };
  const gs = new Proxy(context, {
    get(t, prop) {
      const v = t[prop];
      return typeof v === 'function' ? (...args) => normalize(v.apply(t, args)) : normalize(v);
    },
    set(t, prop, value) { t[prop] = value; return true; },
  });
  return { gs, ss, mail, ui, lock, logs, cache, timeZone };
}

/** Sets up the sheets and adds guests. Each guest is an object keyed by column header. */
export function seed(env, guests = [], settings = {}) {
  const c = env.gs.ctx_();
  env.gs.setupSheets_(c);
  const sheet = env.ss.getSheetByName('Guests');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  guests.forEach((g) => sheet.appendRow(header.map((h) => (g[h] !== undefined ? g[h] : ''))));
  setSettings(env, settings);
  return c;
}

export function setSettings(env, settings) {
  const sheet = env.ss.getSheetByName('Settings');
  const keys = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map((r) => r[0]);
  for (const [k, v] of Object.entries(settings)) {
    const i = keys.indexOf(k);
    if (i < 0) throw new Error(`Unknown setting ${k}`);
    sheet.getRange(i + 1, 2).setValue(v);
  }
}

/** Calls doGet/doPost the way the Apps Script web app does, returning the parsed JSON. */
export function apiGet(env, params) {
  return JSON.parse(env.gs.doGet({ parameter: params }).getContent());
}
export function apiPost(env, body) {
  const contents = typeof body === 'string' ? body : JSON.stringify(body);
  return JSON.parse(env.gs.doPost({ postData: { contents, type: 'text/plain' } }).getContent());
}

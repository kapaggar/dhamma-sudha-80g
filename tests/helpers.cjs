const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const sources = fs.readdirSync(root).filter(f => f.endsWith('.gs'));

function donor(overrides = {}) {
  const row = Array(26).fill('');
  Object.assign(row, { 0: 'TEST-1', 3: 'Sample Donor', 4: 'sample@example.invalid', 20: 'need_pan' }, overrides);
  return row;
}

function harness(options = {}) {
  const logs = [], events = [], fetches = [];
  let locked = false;
  const props = { SHEET_ID: 'test-sheet', TOKEN_SECRET: 'synthetic-test-secret', ...options.props };
  function sheet(rows) {
    return {
      rows: rows.map(r => r.slice()),
      getLastRow() { return this.rows.length; },
      getLastColumn() { return Math.max(1, ...this.rows.map(r => r.length)); },
      getMaxRows() { return this.rows.length; },
      getMaxColumns() { return this.getLastColumn(); },
      setFrozenRows() {},
      getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); },
      getRange(r, c, height = 1, width = 1) {
        const self = this;
        return {
          getValues() {
            events.push(locked ? 'read:locked' : 'read:unlocked');
            return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => self.rows[r - 1 + y]?.[c - 1 + x] ?? ''));
          },
          getValue() { return this.getValues()[0][0]; },
          setValues(values) {
            values.forEach((row, y) => row.forEach((v, x) => {
              self.rows[r - 1 + y] ??= [];
              self.rows[r - 1 + y][c - 1 + x] = v;
            }));
            events.push('write');
            return this;
          },
          setValue(v) { return this.setValues([[v]]); },
          clear() { return this.setValues(Array.from({ length: height }, () => Array(width).fill(''))); },
          setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }
        };
      },
      appendRow(row) { this.rows.push(row.slice()); events.push('write'); }
    };
  }
  const sheets = {
    donors_input: sheet([Array(26).fill('header'), ...(options.donors || [])]),
    submissions: sheet([Array(12).fill('header')]),
    email_log: sheet([Array(7).fill('header')]),
    audit_log: sheet([Array(8).fill('header')])
  };
  if (options.noSubmissions) delete sheets.submissions;
  const spreadsheet = {
    getId: () => options.activeId || 'test-sheet',
    getSheetByName: name => sheets[name] || null,
    insertSheet: name => (sheets[name] = sheet([]))
  };
  const context = vm.createContext({
    Date, JSON, Set, Map,
    Logger: { log: v => logs.push(String(v)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props[key] ?? null,
      setProperty: (key, value) => { props[key] = value; },
      deleteProperty: key => { delete props[key]; }
    }) },
    SpreadsheetApp: {
      openById: () => spreadsheet,
      getActiveSpreadsheet: () => options.anonymous ? null : spreadsheet,
      flush: () => events.push('flush'),
      getUi: () => ({ alert() {} })
    },
    LockService: { getScriptLock: () => ({
      waitLock() { if (options.busy) throw Error('busy'); locked = true; events.push('lock'); },
      releaseLock() { locked = false; events.push('unlock'); }
    }) },
    Utilities: {
      computeHmacSha256Signature: (payload, secret) => Array.from(crypto.createHmac('sha256', secret).update(payload).digest()),
      base64EncodeWebSafe: s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Decode: s => Array.from(Buffer.from(s, 'base64')),
      getUuid: () => crypto.randomUUID(), sleep() {},
      newBlob(bytes, type, name) {
        const data = Buffer.from(bytes);
        return { getBytes: () => Array.from(data), getContentType: () => type, getName: () => name, getDataAsString: () => data.toString() };
      },
      formatDate: d => d.toISOString().slice(0, 10)
    },
    UrlFetchApp: { fetch(url, opts) { fetches.push({ url, opts }); throw Error('Network disabled in tests'); } },
    ScriptApp: { getOAuthToken: () => 'synthetic-oauth' }
  });
  for (const file of sources) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return { context, logs, events, sheets, props, fetches };
}

module.exports = { harness, donor, sources, root };

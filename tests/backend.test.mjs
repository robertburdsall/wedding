// Tests for apps-script/Code.gs, run against an in-memory imitation of Google Sheets.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGas, seed, setSettings, apiGet, apiPost } from '../tools/gas-mock.mjs';

const FULL = 'Wedding + Reception';
const CER = 'Ceremony Only';

const GUESTS = [
  { 'Guest Names': 'Alice Smith, Bob Smith', Email: 'smiths@example.com', 'Invite Type': FULL, 'Plus One': 'No' },
  { 'Guest Names': 'Carol Jones', Email: 'carol@example.com, carol.work@example.com', 'Invite Type': FULL, 'Plus One': 'Yes' },
  { 'Guest Names': 'Dan Brown, Erin Brown, Finn Brown', Email: 'browns@example.com', 'Invite Type': CER, 'Plus One': 'No' },
  { 'Guest Names': 'Gina Lee', Email: 'gina@example.com', 'Invite Type': CER, 'Plus One': 'Yes' },
];

const SETTINGS = {
  'Site URL': 'https://stephanieandrobert.test/',
  'Ceremony Date': 'Saturday, June 6, 2099', // made-up date: the real one never goes in this public repo
  'Ceremony Time': '4:00 PM',
  'Ceremony Venue': 'Chapel on the Hill',
  'Reception Venue': 'Secret Barn',
  'Reception Address': '1 Hidden Lane',
  'Send RSVP Confirmations': 'No',
};

function setup({ guests = GUESTS, settings = SETTINGS, ...opts } = {}) {
  const env = createGas(opts);
  const c = seed(env, guests, settings);
  env.gs.generateCodes_(c);
  env.c = c;
  env.sheet = env.ss.getSheetByName('Guests');
  env.row = (i) => env.sheet.objects()[i];
  env.code = (i) => env.row(i).Code;
  return env;
}

const rsvp = (env, i, attendance, plusOne) =>
  apiPost(env, { action: 'rsvp', code: env.code(i), attendance, ...(plusOne ? { plusOne } : {}) });

// Works out the Summary tab's numbers the way Google Sheets would, for the handful of formula
// shapes the Summary uses (COUNTA, SUM, COUNTIF(S), SUMIF(S), the comma-counting SUMPRODUCT,
// references to other Summary cells, and + / -). Returns { label: number }.
function summaryValues(env) {
  const sheets = {};
  const column = (sheetName, letter) => {
    if (!sheets[sheetName]) sheets[sheetName] = env.ss.getSheetByName(sheetName).rows();
    let idx = 0;
    for (const ch of letter) idx = idx * 26 + (ch.charCodeAt(0) - 64);
    return sheets[sheetName].slice(1).map((r) => r[idx - 1]);
  };
  const range = (ref) => {
    const m = ref.trim().match(/^'((?:[^']|'')+)'!([A-Z]+)2:\2$/);
    if (!m) throw new Error(`Unexpected range: ${ref}`);
    return column(m[1].replace(/''/g, "'"), m[2]);
  };
  const crit = (s) => s.trim().replace(/^"|"$/g, '').toLowerCase();
  const matches = (v, c) => String(v ?? '').trim().toLowerCase() === c;
  const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
  function args(inner) {
    const out = []; let depth = 0, quoted = false, cur = '';
    for (const ch of inner) {
      if (ch === '"') quoted = !quoted;
      if (!quoted && ch === '(') depth++;
      if (!quoted && ch === ')') depth--;
      if (!quoted && depth === 0 && ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    return out.concat(cur);
  }
  const summary = env.ss.getSheetByName('Summary');
  const rows = summary.rows();
  const cache = {};
  function cell(r) {
    if (r in cache) return cache[r];
    const f = summary.getRange(r, 2).getFormula();
    return (cache[r] = f ? evaluate(f.slice(1)) : num(rows[r - 1][1]));
  }
  function term(t) {
    t = t.trim();
    let m;
    if ((m = t.match(/^B(\d+)$/))) return cell(Number(m[1]));
    if ((m = t.match(/^SUMPRODUCT\(\(LEN\(TRIM\((.+?)\)\)>0\)\*\(LEN\(\1\)-LEN\(SUBSTITUTE\(\1,"(.)",""\)\)\+1\)\)$/))) {
      return range(m[1]).reduce((n, v) => n + (String(v ?? '').trim() ? String(v).split(m[2]).length : 0), 0);
    }
    if (!(m = t.match(/^([A-Z]+)\((.*)\)$/))) throw new Error(`Unexpected formula part: ${t}`);
    const a = args(m[2]);
    const pairs = (list) => { const out = []; for (let i = 0; i < list.length; i += 2) out.push([range(list[i]), crit(list[i + 1])]); return out; };
    const ok = (conds, i) => conds.every(([vals, c]) => matches(vals[i], c));
    switch (m[1]) {
      case 'COUNTA': return range(a[0]).filter((v) => String(v ?? '').trim() !== '').length;
      case 'SUM': return range(a[0]).reduce((n, v) => n + num(v), 0);
      case 'COUNTIF': case 'COUNTIFS': { const conds = pairs(a); return conds[0][0].filter((_, i) => ok(conds, i)).length; }
      case 'SUMIF': { const vals = range(a[0]), c = crit(a[1]), sums = range(a[2]); return sums.reduce((n, v, i) => n + (matches(vals[i], c) ? num(v) : 0), 0); }
      case 'SUMIFS': { const sums = range(a[0]), conds = pairs(a.slice(1)); return sums.reduce((n, v, i) => n + (ok(conds, i) ? num(v) : 0), 0); }
      default: throw new Error(`Unsupported function: ${m[1]}`);
    }
  }
  function evaluate(expr) {
    // Split on top-level + and - (outside quotes and parentheses).
    let depth = 0, quoted = false, cur = '', sign = 1, total = 0;
    for (const ch of expr) {
      if (ch === '"') quoted = !quoted;
      if (!quoted && ch === '(') depth++;
      if (!quoted && ch === ')') depth--;
      if (!quoted && depth === 0 && (ch === '+' || ch === '-') && cur.trim()) { total += sign * term(cur); sign = ch === '+' ? 1 : -1; cur = ''; } else cur += ch;
    }
    return total + sign * term(cur);
  }
  const out = {};
  rows.forEach((r, i) => { if (r[0] && summary.getRange(i + 1, 2).getFormula()) { try { out[r[0]] = cell(i + 1); } catch (err) { /* formula shapes this helper doesn't cover */ } } });
  return out;
}

const eventCounts = (values, ev) => Object.fromEntries(Object.entries(values)
  .filter(([k]) => k.startsWith(`${ev}: `)).map(([k, v]) => [k.slice(ev.length + 2), v]));

/* ------------------------------------------------------------------ */
describe('sheet setup', () => {
  test('creates all tabs with the expected headers and removes the blank Sheet1', () => {
    const env = createGas();
    env.gs.setupSheets_(env.gs.ctx_());
    assert.deepEqual(env.ss.getSheets().map((s) => s.getName()), ['Guests', 'Summary', 'Settings', 'Photos', 'RSVP Log']);
    assert.deepEqual(env.ss.getSheetByName('Guests').rows()[0], [
      'Code', 'Guest Names', 'Email', 'Invite Type', 'Plus One', 'RSVP Status', 'Ceremony Attending',
      'Reception Attending', 'Ceremony Declined', 'Reception Declined', 'Plus One Name', 'Plus One Status', 'Responded At', 'Invite Sent At', 'Invite Opened At', 'Reminder Sent At', 'Invite Link', 'Text Message', 'Party Size',
      'Meal Choices', 'Dietary Notes', 'Meals Chosen At', 'Meal Link', 'Meal Text Message', 'Guest Emails', 'Camera Emails Sent', 'Album Emails Sent', 'Notes',
    ]);
    const settingKeys = env.ss.getSheetByName('Settings').rows().map((r) => r[0]);
    assert.equal(settingKeys[0], 'Setting');
    assert.ok(settingKeys.includes('RSVP Deadline'));
    assert.ok(settingKeys.includes('Reception Venue'));
  });

  test('running setup again keeps guests, custom columns and settings', () => {
    const env = setup();
    const sheet = env.sheet;
    // The family adds their own column and changes a setting.
    const free = sheet.getLastColumn() + 1;
    sheet.getRange(1, free).setValue('Table #');
    sheet.getRange(2, free).setValue('7');
    setSettings(env, { 'Ceremony Venue': 'Changed Venue' });
    const before = sheet.rows();

    env.gs.setupSheets_(env.c);
    assert.deepEqual(sheet.rows(), before);
    assert.equal(env.gs.readSettings_(env.c)['Ceremony Venue'], 'Changed Venue');
    assert.equal(env.ss.getSheets().length, 5);
  });

  test('adds missing columns to an older sheet without moving existing ones', () => {
    const env = createGas();
    const g = env.ss.insertSheet('Guests');
    g.appendRow(['Guest Names', 'Email', 'Invite Type', 'Plus One']);
    g.appendRow(['Zed Zee', 'z@example.com', CER, 'No']);
    env.gs.setupSheets_(env.gs.ctx_());
    const header = g.rows()[0];
    assert.deepEqual(header.slice(0, 4), ['Guest Names', 'Email', 'Invite Type', 'Plus One']);
    assert.ok(header.includes('Code') && header.includes('Ceremony Attending'));
    assert.equal(g.objects()[0]['Guest Names'], 'Zed Zee');
  });

  test('summary formulas point at the right guest columns', () => {
    const env = setup();
    const summary = env.ss.getSheetByName('Summary');
    const formulas = {};
    for (let r = 1; r <= summary.getLastRow(); r++) formulas[summary.getRange(r, 1).getValue()] = summary.getRange(r, 2).getFormula();
    assert.equal(formulas['Households invited'], "=COUNTA('Guests'!B2:B)");
    assert.match(formulas['Ceremony: attending (people, incl. plus ones)'], /'Guests'!G2:G/);
    assert.match(formulas['Reception: attending (people, incl. plus ones)'], /'Guests'!H2:H/);
    assert.match(formulas['Ceremony: declined (people)'], /'Guests'!I2:I/);
    assert.match(formulas['Reception: declined (people)'], /'Guests'!J2:J/);
    assert.equal(formulas['"Ceremony Only" households'], `=COUNTIF('Guests'!D2:D,"${CER}")`);
    assert.equal(formulas['Households waiting on'], '=B3-B10');
    assert.match(formulas['Invites opened'], /=COUNTA\('Guests'!O2:O\)/);
    assert.equal(formulas['Plus ones coming'], `=COUNTIF('Guests'!L2:L,"Bringing a guest")`);
    assert.equal(formulas['Plus ones not coming'], `=COUNTIF('Guests'!L2:L,"Not bringing a guest")`);
    assert.equal(summary.getRange(3, 1).getValue(), 'Households invited');
    assert.equal(summary.getRange(10, 1).getValue(), 'Households responded');
  });

  test('the Summary counts the ceremony and the reception separately, with who is still waiting', () => {
    const env = setup();
    // Smiths and Carol (Wedding + Reception) answer; the Browns and Gina (Ceremony Only) haven't yet.
    rsvp(env, 0, { ceremony: ['Alice Smith', 'Bob Smith'], reception: ['Alice Smith'] });
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: ['Carol Jones'] }, { name: 'Plus Person', ceremony: true, reception: true });
    const value = summaryValues(env);
    assert.deepEqual(eventCounts(value, 'Ceremony'), {
      'households invited': 4, 'people invited (not counting plus ones)': 7, 'plus ones offered': 2,
      'most possible (everyone invited + every plus one)': 9,
      'attending (people, incl. plus ones)': 4, 'declined (people)': 0,
      'households still waiting on': 2, 'people still waiting on (not counting plus ones)': 4, 'plus ones still waiting on': 1,
      'total if everyone still waiting says yes': 9,
    });
    assert.deepEqual(eventCounts(value, 'Reception'), {
      'households invited': 2, 'people invited (not counting plus ones)': 3, 'plus ones offered': 1,
      'most possible (everyone invited + every plus one)': 4,
      'attending (people, incl. plus ones)': 3, 'declined (people)': 1,
      'households still waiting on': 0, 'people still waiting on (not counting plus ones)': 0, 'plus ones still waiting on': 0,
      'total if everyone still waiting says yes': 3,
    });
    // The Browns say no: the ceremony's best case shrinks, the reception's doesn't change.
    rsvp(env, 2, { ceremony: [] });
    const after = summaryValues(env);
    const cer = eventCounts(after, 'Ceremony');
    assert.equal(cer['declined (people)'], 3);
    assert.equal(cer['households still waiting on'], 1);
    assert.equal(cer['people still waiting on (not counting plus ones)'], 1);
    assert.equal(cer['total if everyone still waiting says yes'], 6);
    assert.equal(eventCounts(after, 'Reception')['total if everyone still waiting says yes'], 3);
    // Every invited person is attending, declined or still waiting: nobody is counted twice or missed.
    for (const ev of ['Ceremony', 'Reception']) {
      const n = eventCounts(after, ev);
      const plusOnesComing = 1; // Carol's guest, at both
      assert.equal(n['attending (people, incl. plus ones)'] - plusOnesComing + n['declined (people)'] + n['people still waiting on (not counting plus ones)'],
        n['people invited (not counting plus ones)'], ev);
    }
    // The section headings are there, and the old rows other tabs rely on are unchanged.
    const labels = env.ss.getSheetByName('Summary').rows().map((r) => r[0]);
    assert.ok(labels.includes('CEREMONY') && labels.includes('RECEPTION'));
    assert.equal(after['Households waiting on'], 1); // just Gina
  });

  test('summary "people" formula counts comma-separated names', () => {
    // Evaluate the formula logic in JS: nonblank cells count commas + 1.
    const env = setup();
    rsvp(env, 0, { ceremony: ['Alice Smith', 'Bob Smith'], reception: ['Alice Smith'] });
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: ['Carol Jones'] }, { name: 'Plus Person', ceremony: true, reception: true });
    rsvp(env, 2, { ceremony: [] });
    const count = (col) => env.sheet.objects().reduce((n, r) => n + (String(r[col]).trim() ? String(r[col]).split(',').length : 0), 0);
    assert.equal(count('Ceremony Attending'), 4);
    assert.equal(count('Reception Attending'), 3);
  });
});

/* ------------------------------------------------------------------ */
describe('codes and invite links', () => {
  test('every household gets a unique 8-character code and a link', () => {
    const env = setup();
    const rows = env.sheet.objects();
    const codes = rows.map((r) => r.Code);
    assert.equal(new Set(codes).size, rows.length);
    for (const r of rows) {
      assert.match(r.Code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      assert.equal(r['Invite Link'], `https://stephanieandrobert.test/invite/?code=${r.Code}`);
      assert.equal(r['RSVP Status'], 'Not responded');
    }
  });

  test('re-running does not change existing codes', () => {
    const env = setup();
    const before = env.sheet.objects().map((r) => r.Code);
    assert.equal(env.gs.generateCodes_(env.c), 0);
    assert.deepEqual(env.sheet.objects().map((r) => r.Code), before);
  });

  test('skips blank rows and rows without names', () => {
    const env = setup({ guests: [...GUESTS, { Email: 'nobody@example.com', 'Invite Type': CER }] });
    assert.equal(env.row(4).Code, '');
    env.sheet.appendRow(['']);
    assert.equal(env.gs.generateCodes_(env.c), 0);
  });

  test('changing the Site URL updates every link', () => {
    const env = setup();
    setSettings(env, { 'Site URL': 'https://newdomain.test' });
    env.gs.generateCodes_(env.c);
    for (const r of env.sheet.objects()) assert.equal(r['Invite Link'], `https://newdomain.test/invite/?code=${r.Code}`);
  });

  test('codes that look like numbers stay text and all-digit codes are never used', () => {
    const env = createGas();
    const c = seed(env, [GUESTS[0], GUESTS[1]], SETTINGS);
    const queue = ['234567', '22E222', 'ABC234'];
    const real = env.gs.randomCode_;
    let calls = 0;
    env.gs.randomCode_ = function () {
      calls++;
      if (!queue.length) return real(); // later codes (like the review code) don't matter here
      const next = queue.shift();
      return /^[0-9]+$/.test(next) ? env.gs.randomCode_() : next; // same rule as the real function
    };
    env.gs.generateCodes_(c);
    const rows = env.ss.getSheetByName('Guests').objects();
    assert.equal(rows[0].Code, '22E222'); // Sheets would turn this into the number 2.2e223 without text formatting
    assert.equal(typeof rows[0].Code, 'string');
    assert.equal(rows[1].Code, 'ABC234');
    assert.ok(calls >= 3);
    env.gs.randomCode_ = real;
    for (let i = 0; i < 2000; i++) assert.doesNotMatch(env.gs.randomCode_(), /^[0-9]+$/);
  });

  test('500 households all get distinct codes', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ 'Guest Names': `Guest ${i}`, Email: `g${i}@example.com`, 'Invite Type': CER }));
    const env = setup({ guests: many });
    const codes = env.sheet.objects().map((r) => r.Code);
    assert.equal(codes.filter(Boolean).length, 500);
    assert.equal(new Set(codes).size, 500);
  });

  test('onEdit gives a newly typed guest a code right away (Guests tab only)', () => {
    const env = setup();
    env.sheet.appendRow(['', 'New Person', 'new@example.com', CER, 'No']);
    const newRow = env.sheet.getLastRow();
    env.gs.onEdit({ range: env.sheet.getRange(newRow, 2) });
    assert.match(env.row(newRow - 2).Code, /^[A-Z2-9]{8}$/);

    const settings = env.ss.getSheetByName('Settings');
    const writesBefore = env.sheet.writes;
    env.gs.onEdit({ range: settings.getRange(2, 2) });
    assert.equal(env.sheet.writes, writesBefore);
    env.gs.onEdit({ range: env.sheet.getRange(1, 2) }); // header edit: ignored
    assert.equal(env.sheet.writes, writesBefore);
  });

  test('onEdit never throws, even if the sheet is broken', () => {
    const env = createGas();
    const s = env.ss.insertSheet('Guests');
    assert.doesNotThrow(() => env.gs.onEdit({ range: s.getRange(2, 1) }));
    assert.doesNotThrow(() => env.gs.onEdit(undefined));
  });
});

/* ------------------------------------------------------------------ */
describe('looking up an invitation (GET)', () => {
  test('Wedding + Reception invite includes both events and settings details', () => {
    const env = setup();
    const res = apiGet(env, { action: 'invite', code: env.code(0) });
    assert.equal(res.ok, true);
    const d = res.data;
    assert.equal(d.type, 'full');
    assert.deepEqual(d.guests, ['Alice Smith', 'Bob Smith']);
    assert.equal(d.plusOneAllowed, false);
    assert.equal(d.response.plusOne, null);
    assert.deepEqual(d.events.map((e) => e.id), ['ceremony', 'reception']);
    assert.deepEqual(d.events[0], {
      id: 'ceremony', title: 'Ceremony', date: 'Saturday, June 6, 2099', time: '4:00 PM', venue: 'Chapel on the Hill', address: '',
    });
    assert.equal(d.events[1].venue, 'Secret Barn');
    assert.equal(d.events[1].address, '1 Hidden Lane');
    assert.deepEqual(d.response, { responded: false, ceremony: [], reception: [], plusOne: null });
    assert.deepEqual(d.rsvp, { deadline: null, deadlineText: '', open: true });
  });

  test('Ceremony Only invite never reveals reception details', () => {
    const env = setup();
    for (const i of [2, 3]) {
      const res = apiGet(env, { action: 'invite', code: env.code(i) });
      assert.equal(res.data.type, 'ceremony');
      assert.deepEqual(res.data.events.map((e) => e.id), ['ceremony']);
      const raw = JSON.stringify(res);
      assert.ok(!raw.includes('Secret Barn'), 'reception venue leaked');
      assert.ok(!raw.includes('Hidden Lane'), 'reception address leaked');
      assert.ok(!/reception/i.test(JSON.stringify(res.data.events)));
    }
  });

  test('plus one info is included only when offered', () => {
    const env = setup();
    assert.deepEqual(apiGet(env, { code: env.code(1) }).data.response.plusOne, { name: '', ceremony: false, reception: false });
    assert.equal(apiGet(env, { code: env.code(0) }).data.response.plusOne, null);
  });

  test('codes are matched regardless of case, spaces or dashes', () => {
    const env = setup();
    const code = env.code(1);
    for (const variant of [code.toLowerCase(), ` ${code} `, `${code.slice(0, 3)}-${code.slice(3)}`]) {
      assert.equal(apiGet(env, { code: variant }).data.code, code, variant);
    }
  });

  test('a code typed into the sheet by hand (lowercase) still works', () => {
    const env = setup();
    env.sheet.getRange(2, 1).setValue('handmade');
    assert.equal(apiGet(env, { code: 'HANDMADE' }).data.guests[0], 'Alice Smith');
  });

  test('bad codes give friendly errors', () => {
    const env = setup();
    assert.equal(apiGet(env, { code: 'NOPE99' }).error, 'not_found');
    assert.equal(apiGet(env, {}).error, 'bad_request');
    assert.equal(apiGet(env, { code: '!!!' }).error, 'bad_request');
    assert.equal(apiGet(env, { action: 'hack', code: env.code(0) }).error, 'bad_request');
    assert.match(apiGet(env, { code: 'NOPE99' }).message, /couldn't find/i);
  });

  test('a row missing its Invite Type is "not ready" rather than guessed', () => {
    const env = setup({ guests: [{ 'Guest Names': 'Typo Tom', Email: 't@example.com', 'Invite Type': '' }] });
    const res = apiGet(env, { code: env.code(0) });
    assert.equal(res.error, 'not_ready');
  });

  test('Invite Type is read leniently', () => {
    const cases = { 'wedding + reception': 'full', 'Wedding & Reception': 'full', 'reception': 'full', 'Ceremony only': 'ceremony', 'ceremony': 'ceremony', 'Wedding': 'ceremony', 'Brunch': null, '': null };
    const env = createGas();
    for (const [input, expected] of Object.entries(cases)) assert.equal(env.gs.parseType_(input), expected, input);
  });

  test('Plus One is read leniently', () => {
    const env = createGas();
    for (const v of ['Yes', 'yes', 'Y', 'TRUE', true, 'x', '1']) assert.equal(env.gs.parseYes_(v), true, String(v));
    for (const v of ['No', 'no', '', 'maybe', false, '0', null]) assert.equal(env.gs.parseYes_(v), false, String(v));
  });

  test('guest names split on commas and new lines, ignoring extra spaces', () => {
    const env = createGas();
    assert.deepEqual(env.gs.splitList_(' Ann  Lee ,Bo Ray,\nCy Doe, ,'), ['Ann Lee', 'Bo Ray', 'Cy Doe']);
  });

  test('columns can be reordered and extra columns added', () => {
    const env = createGas();
    const g = env.ss.insertSheet('Guests');
    const header = ['Notes', 'Plus One', 'Invite Type', 'My Column', 'Guest Names', 'Email', 'Code', 'RSVP Status',
      'Plus One Name', 'Reception Attending', 'Ceremony Attending', 'Responded At'];
    g.appendRow(header);
    g.appendRow(['hi', 'Yes', FULL, 'zzz', 'Reo Rder', 'r@example.com', 'ABCDEF', '', '', '', '', '']);
    const res = apiPost(env, { action: 'rsvp', code: 'ABCDEF', attendance: { ceremony: ['Reo Rder'], reception: ['Reo Rder'] }, plusOne: { name: 'Pal', ceremony: false, reception: true } });
    assert.equal(res.ok, true, res.message);
    const row = g.objects()[0];
    assert.equal(row['Ceremony Attending'], 'Reo Rder');
    assert.equal(row['Reception Attending'], 'Reo Rder, Pal');
    assert.equal(row['My Column'], 'zzz');
    assert.equal(row.Notes, 'hi');
  });

  test('a missing required column gives a setup error', () => {
    const env = createGas();
    const g = env.ss.insertSheet('Guests');
    g.appendRow(['Code', 'Guest Names', 'Invite Type']);
    g.appendRow(['ABCDEF', 'X', FULL]);
    const res = apiGet(env, { code: 'ABCDEF' });
    assert.equal(res.error, 'setup');
    assert.match(res.message, /Plus One/);
  });

  test('no Guests tab at all gives a setup error', () => {
    const env = createGas();
    assert.equal(apiGet(env, { code: 'ABCDEF' }).error, 'setup');
  });

  test('Settings values that Sheets turned into dates/times are shown as text', () => {
    const env = setup({ settings: { ...SETTINGS, 'Ceremony Date': 'June 13, 2099', 'Reception Time': '6:30 PM' } });
    const d = apiGet(env, { code: env.code(0) }).data;
    assert.equal(d.events[0].date, 'Saturday, June 13, 2099');
    assert.equal(d.events[0].time, '4:00 PM');
    assert.equal(d.events[1].time, '6:30 PM');
  });

  test('ping reports the version', () => {
    const env = setup();
    assert.deepEqual(apiGet(env, { action: 'ping' }), { ok: true, data: { version: env.gs.VERSION } });
  });
});

/* ------------------------------------------------------------------ */
describe('submitting an RSVP (POST)', () => {
  test('everyone attending everything is written to the right row', () => {
    const env = setup();
    const res = rsvp(env, 0, { ceremony: ['Alice Smith', 'Bob Smith'], reception: ['Alice Smith', 'Bob Smith'] });
    assert.equal(res.ok, true, res.message);
    const row = env.row(0);
    assert.equal(row['RSVP Status'], 'Attending');
    assert.equal(row['Ceremony Attending'], 'Alice Smith, Bob Smith');
    assert.equal(row['Reception Attending'], 'Alice Smith, Bob Smith');
    assert.equal(row['Plus One Name'], '');
    assert.ok(row['Responded At'] instanceof Date);
    assert.deepEqual(res.data.response, { responded: true, ceremony: ['Alice Smith', 'Bob Smith'], reception: ['Alice Smith', 'Bob Smith'], plusOne: null });
  });

  test('other households are never touched', () => {
    const env = setup();
    const before = env.sheet.objects();
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: [] });
    const after = env.sheet.objects();
    for (const i of [0, 2, 3]) assert.deepEqual(after[i], before[i]);
    assert.notDeepEqual(after[1], before[1]);
  });

  test('partial attendance: some people, some events', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: ['Bob Smith'], reception: ['Alice Smith'] });
    const row = env.row(0);
    assert.equal(row['RSVP Status'], 'Attending');
    assert.equal(row['Ceremony Attending'], 'Bob Smith');
    assert.equal(row['Reception Attending'], 'Alice Smith');
  });

  test('declining everything marks the household Declined', () => {
    const env = setup();
    const res = rsvp(env, 0, { ceremony: [], reception: [] });
    assert.equal(res.ok, true);
    assert.equal(env.row(0)['RSVP Status'], 'Declined');
    assert.equal(env.row(0)['Ceremony Attending'], '');
    assert.equal(res.data.response.responded, true);
  });

  test('missing attendance lists count as not attending', () => {
    const env = setup();
    assert.equal(apiPost(env, { action: 'rsvp', code: env.code(0) }).ok, true);
    assert.equal(env.row(0)['RSVP Status'], 'Declined');
  });

  test('names are matched case-insensitively and stored as written in the sheet, in sheet order, without duplicates', () => {
    const env = setup();
    rsvp(env, 2, { ceremony: ['finn brown', '  DAN   BROWN ', 'Finn Brown'] });
    assert.equal(env.row(2)['Ceremony Attending'], 'Dan Brown, Finn Brown');
  });

  test('changing an RSVP replaces the old answer', () => {
    const env = setup();
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: ['Carol Jones'] }, { name: 'Sam Plus', ceremony: true, reception: true });
    assert.equal(env.row(1)['Plus One Name'], 'Sam Plus');
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: [] }, { name: 'Sam Plus', ceremony: false, reception: false });
    const row = env.row(1);
    assert.equal(row['Ceremony Attending'], 'Carol Jones');
    assert.equal(row['Reception Attending'], '');
    assert.equal(row['Plus One Name'], '');
    assert.equal(row['RSVP Status'], 'Attending');
  });

  test('a previous answer is returned so the form can be pre-filled', () => {
    const env = setup();
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: ['Carol Jones'] }, { name: 'Sam Plus', ceremony: true, reception: false });
    const d = apiGet(env, { code: env.code(1) }).data;
    assert.deepEqual(d.response, { responded: true, ceremony: ['Carol Jones'], reception: ['Carol Jones'], plusOne: { name: 'Sam Plus', ceremony: true, reception: false } });
  });

  test('answers typed into the sheet by hand (e.g. after a phone call) show up on the invite', () => {
    const env = setup();
    const cols = env.sheet.rows()[0];
    env.sheet.getRange(4, cols.indexOf('Ceremony Attending') + 1).setValue('erin brown');
    env.sheet.getRange(4, cols.indexOf('RSVP Status') + 1).setValue('Attending');
    const d = apiGet(env, { code: env.code(2) }).data;
    assert.deepEqual(d.response.ceremony, ['Erin Brown']);
    assert.equal(d.response.responded, true);
  });

  describe('ceremony-only invitations', () => {
    test('can RSVP to the ceremony', () => {
      const env = setup();
      const res = rsvp(env, 2, { ceremony: ['Dan Brown', 'Erin Brown'] });
      assert.equal(res.ok, true);
      assert.equal(env.row(2)['Ceremony Attending'], 'Dan Brown, Erin Brown');
      assert.equal(env.row(2)['Reception Attending'], '');
    });

    test('cannot RSVP to the reception, and nothing is saved when they try', () => {
      const env = setup();
      const before = env.row(2);
      const res = rsvp(env, 2, { ceremony: ['Dan Brown'], reception: ['Dan Brown'] });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'bad_request');
      assert.deepEqual(env.row(2), before);
    });

    test('an empty reception list is fine', () => {
      const env = setup();
      assert.equal(rsvp(env, 2, { ceremony: ['Dan Brown'], reception: [] }).ok, true);
    });

    test('their plus one can attend the ceremony but not the reception', () => {
      const env = setup();
      assert.equal(rsvp(env, 3, { ceremony: ['Gina Lee'] }, { name: 'Gina Guest', ceremony: true }).ok, true);
      assert.equal(env.row(3)['Ceremony Attending'], 'Gina Lee, Gina Guest');
      assert.equal(env.row(3)['Reception Attending'], '');
      assert.equal(rsvp(env, 3, { ceremony: ['Gina Lee'] }, { name: 'Gina Guest', ceremony: true, reception: true }).error, 'bad_request');
    });
  });

  describe('plus ones', () => {
    test('are saved in the attending lists and their own column', () => {
      const env = setup();
      const res = rsvp(env, 1, { ceremony: ['Carol Jones'], reception: ['Carol Jones'] }, { name: 'Sam Plus', ceremony: true, reception: true });
      assert.equal(res.ok, true);
      const row = env.row(1);
      assert.equal(row['Ceremony Attending'], 'Carol Jones, Sam Plus');
      assert.equal(row['Reception Attending'], 'Carol Jones, Sam Plus');
      assert.equal(row['Plus One Name'], 'Sam Plus');
    });

    test('are refused when the household was not given one', () => {
      const env = setup();
      const res = rsvp(env, 0, { ceremony: ['Alice Smith'] }, { name: 'Gatecrasher', ceremony: true });
      assert.equal(res.error, 'bad_request');
      assert.equal(env.row(0)['RSVP Status'], 'Not responded');
    });

    test('a name sent without attendance is ignored for households without a plus one', () => {
      const env = setup();
      assert.equal(rsvp(env, 0, { ceremony: ['Alice Smith'] }, { name: 'Ignored', ceremony: false }).ok, true);
      assert.equal(env.row(0)['Plus One Name'], '');
    });

    test('need a name', () => {
      const env = setup();
      for (const name of ['', '   ', undefined, null, ',,,']) {
        assert.equal(rsvp(env, 1, { ceremony: ['Carol Jones'] }, { name, ceremony: true }).error, 'plus_one_name', String(name));
      }
    });

    test("can't use the name of someone already on the invitation", () => {
      const env = setup();
      assert.equal(rsvp(env, 1, { ceremony: ['Carol Jones'] }, { name: 'carol jones', ceremony: true }).error, 'plus_one_name');
    });

    test("can't attend an event nobody from the household is attending", () => {
      const env = setup();
      assert.equal(rsvp(env, 1, { ceremony: [], reception: ['Carol Jones'] }, { name: 'Pal', ceremony: true }).error, 'plus_one_alone');
      assert.equal(rsvp(env, 1, { ceremony: ['Carol Jones'], reception: [] }, { name: 'Pal', reception: true }).error, 'plus_one_alone');
    });

    test('names are cleaned: commas, brackets, extra spaces and very long names', () => {
      const env = setup();
      rsvp(env, 1, { ceremony: ['Carol Jones'] }, { name: '  Smith,  John <b>Jr</b>\n ', ceremony: true });
      assert.equal(env.row(1)['Plus One Name'], 'Smith John b Jr /b');
      assert.equal(env.row(1)['Ceremony Attending'], 'Carol Jones, Smith John b Jr /b');
      rsvp(env, 1, { ceremony: ['Carol Jones'] }, { name: 'A'.repeat(500), ceremony: true });
      assert.equal(env.row(1)['Plus One Name'].length, 80);
    });

    test('only `true` counts as attending (no "yes" strings)', () => {
      const env = setup();
      rsvp(env, 1, { ceremony: ['Carol Jones'] }, { name: 'Pal', ceremony: 'yes' });
      assert.equal(env.row(1)['Plus One Name'], '');
    });

    test('typed text can never become a spreadsheet formula', () => {
      const env = setup();
      for (const name of ['=IMPORTXML("http://evil")', '+1+1', '-2', '@SUM(A1)']) {
        assert.equal(rsvp(env, 1, { ceremony: ['Carol Jones'] }, { name, ceremony: true }).ok, true);
        const cols = env.sheet.rows()[0];
        const cell = env.sheet.getRange(3, cols.indexOf('Plus One Name') + 1);
        assert.equal(cell.getFormula(), '', name);
        assert.equal(cell.getValue(), name);
      }
      const log = env.ss.getSheetByName('RSVP Log');
      for (let r = 1; r <= log.getLastRow(); r++) for (let col = 1; col <= 7; col++) assert.equal(log.getRange(r, col).getFormula(), '');
    });
  });

  describe('rejects bad requests without changing the sheet', () => {
    const cases = {
      'unknown guest name': (env) => rsvp(env, 0, { ceremony: ['Mallory'] }),
      'guest from another household': (env) => rsvp(env, 0, { ceremony: ['Carol Jones'] }),
      'attendance is a string': (env) => rsvp(env, 0, { ceremony: 'Alice Smith' }),
      'attendance contains a non-string': (env) => rsvp(env, 0, { ceremony: [{ name: 'Alice Smith' }] }),
      'attendance is not an object': (env) => apiPost(env, { action: 'rsvp', code: env.code(0), attendance: 'all' }),
      'missing code': (env) => apiPost(env, { action: 'rsvp', attendance: { ceremony: [] } }),
      'wrong code': (env) => apiPost(env, { action: 'rsvp', code: 'WRONG1', attendance: { ceremony: [] } }),
      'unknown action': (env) => apiPost(env, { action: 'delete', code: env.code(0) }),
      'not JSON': (env) => apiPost(env, 'hello'),
      'JSON array': (env) => apiPost(env, '[1,2]'),
      'JSON null': (env) => apiPost(env, 'null'),
      'empty body': (env) => apiPost(env, ''),
      'huge body': (env) => apiPost(env, JSON.stringify({ action: 'rsvp', code: env.code(0), pad: 'x'.repeat(20000) })),
    };
    for (const [name, send] of Object.entries(cases)) {
      test(name, () => {
        const env = setup();
        const before = env.sheet.rows();
        const res = send(env);
        assert.equal(res.ok, false);
        assert.ok(['bad_request', 'unknown_guest', 'not_found'].includes(res.error), res.error);
        assert.equal(typeof res.message, 'string');
        assert.deepEqual(env.sheet.rows(), before);
      });
    }

    test('doPost with no event object at all', () => {
      const env = setup();
      assert.equal(JSON.parse(env.gs.doPost(undefined).getContent()).error, 'bad_request');
      assert.equal(JSON.parse(env.gs.doGet(undefined).getContent()).error, 'bad_request');
    });
  });

  test('every RSVP is recorded in the RSVP Log', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: ['Alice Smith'], reception: [] });
    rsvp(env, 0, { ceremony: [], reception: [] });
    rsvp(env, 2, { ceremony: ['Dan Brown'] });
    const log = env.ss.getSheetByName('RSVP Log').objects();
    assert.equal(log.length, 3);
    assert.equal(log[0].Code, env.code(0));
    assert.equal(log[0].Status, 'Attending');
    assert.equal(log[1].Status, 'Declined');
    assert.equal(log[2].Reception, 'n/a');
    assert.ok(log[0].Time instanceof Date);
    assert.equal(JSON.parse(log[0]['Raw Response']).code, env.code(0));
  });

  test('the RSVP Log tab is recreated if someone deletes it', () => {
    const env = setup();
    env.ss.deleteSheet(env.ss.getSheetByName('RSVP Log'));
    assert.equal(rsvp(env, 0, { ceremony: [] }).ok, true);
    assert.equal(env.ss.getSheetByName('RSVP Log').objects().length, 1);
  });

  test('the lock is always released, even when the RSVP is rejected', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: ['Alice Smith'] });
    rsvp(env, 0, { ceremony: ['Mallory'] });
    apiPost(env, { action: 'rsvp', code: 'WRONG1' });
    assert.equal(env.lock.acquired, 3);
    assert.equal(env.lock.released, 3);
    assert.equal(env.lock.held, false);
  });

  test('an unexpected crash returns a generic error instead of internals', () => {
    const env = setup();
    env.sheet.getRange = () => { throw new Error('secret internal detail'); };
    const res = apiGet(env, { code: 'ABCDEF' });
    assert.equal(res.error, 'server_error');
    assert.ok(!res.message.includes('secret'));
    assert.equal(env.logs.errors.length, 1);
  });
});

/* ------------------------------------------------------------------ */
describe('RSVP deadline', () => {
  const at = (iso) => new Date(iso);

  test('open through the end of the deadline day (in the wedding time zone), closed after', () => {
    const env = setup({ settings: { ...SETTINGS, 'RSVP Deadline': '2099-11-20' } });
    const body = { action: 'rsvp', code: env.code(0), attendance: { ceremony: ['Alice Smith'] } };
    assert.doesNotThrow(() => env.gs.submitRsvp_(env.c, body, at('2099-11-20T23:59:00-05:00')));
    assert.throws(() => env.gs.submitRsvp_(env.c, body, at('2099-11-21T00:01:00-05:00')), (e) => e.code === 'closed');
    // 11:30pm Nov 20 in New York is already Nov 21 in UTC; still open.
    assert.doesNotThrow(() => env.gs.submitRsvp_(env.c, body, at('2099-11-21T04:30:00Z')));
  });

  test('closed RSVPs keep the saved answer and say when they closed', () => {
    const env = setup({ settings: { ...SETTINGS, 'RSVP Deadline': '2099-11-20' } });
    env.gs.submitRsvp_(env.c, { action: 'rsvp', code: env.code(0), attendance: { ceremony: ['Alice Smith'] } }, at('2099-11-01T12:00:00Z'));
    const d = env.gs.handleGet_(env.c, { code: env.code(0) }, at('2099-12-01T12:00:00Z'));
    assert.deepEqual(d.rsvp, { deadline: '2099-11-20', deadlineText: 'November 20, 2099', open: false });
    assert.deepEqual(d.response.ceremony, ['Alice Smith']);
    assert.throws(() => env.gs.submitRsvp_(env.c, { action: 'rsvp', code: env.code(0), attendance: { ceremony: [] } }, at('2099-12-01T12:00:00Z')),
      (e) => e.code === 'closed' && /November 20, 2099/.test(e.message));
    assert.equal(env.row(0)['Ceremony Attending'], 'Alice Smith');
  });

  test('accepts the date formats people actually type', () => {
    const env = createGas();
    assert.equal(env.gs.dateKey_('2099-11-20'), '2099-11-20');
    assert.equal(env.gs.dateKey_('2099-1-5'), '2099-01-05');
    assert.equal(env.gs.dateKey_('11/20/2099'), '2099-11-20');
    assert.equal(env.gs.dateKey_(new Date(2099, 10, 20)), '2099-11-20');
    assert.equal(env.gs.dateKey_(''), null);
    assert.equal(env.gs.dateKey_('next friday'), null);
  });

  test('a deadline typed as "November 20, 2099" (which Sheets turns into a date) works', () => {
    const env = setup({ settings: { ...SETTINGS, 'RSVP Deadline': 'November 20, 2099' } });
    assert.equal(apiGet(env, { code: env.code(0) }).data.rsvp.deadline, '2099-11-20');
  });

  test('via the real doPost, a past deadline blocks RSVPs', () => {
    const env = setup({ settings: { ...SETTINGS, 'RSVP Deadline': '2001-01-01' } });
    assert.equal(rsvp(env, 0, { ceremony: [] }).error, 'closed');
  });

  test('"Ceremony Only" households can have their own, later deadline', () => {
    const env = setup({ settings: { ...SETTINGS, 'RSVP Deadline': '2099-11-22', 'RSVP Deadline (Ceremony Only)': '2099-11-28' } });
    const full = env.code(0); // the Smiths: Wedding + Reception
    const cer = env.code(2); // the Browns: Ceremony Only
    // Each invitation shows its own date.
    assert.equal(env.gs.handleGet_(env.c, { code: full }, at('2099-11-01T12:00:00Z')).rsvp.deadlineText, 'November 22, 2099');
    assert.equal(env.gs.handleGet_(env.c, { code: cer }, at('2099-11-01T12:00:00Z')).rsvp.deadlineText, 'November 28, 2099');
    // So does each household's ready-to-send text, and the invitation email.
    assert.match(env.row(0)['Text Message'], /by November 22, 2099/);
    assert.match(env.row(2)['Text Message'], /by November 28, 2099/);
    const t = env.gs.readGuests_(env.c);
    assert.match(env.gs.buildInviteEmail_(t.guests[2], env.gs.readSettings_(env.c), 'invite').body, /RSVP by November 28, 2099/);
    assert.match(env.gs.buildInviteEmail_(t.guests[0], env.gs.readSettings_(env.c), 'invite').body, /RSVP by November 22, 2099/);
    // On Nov 25, the reception households are closed but ceremony-only ones can still answer.
    const nov25 = at('2099-11-25T12:00:00Z');
    assert.throws(() => env.gs.submitRsvp_(env.c, { action: 'rsvp', code: full, attendance: { ceremony: [], reception: [] } }, nov25), (e) => e.code === 'closed');
    assert.doesNotThrow(() => env.gs.submitRsvp_(env.c, { action: 'rsvp', code: cer, attendance: { ceremony: ['Dan Brown'] } }, nov25));
    // After Nov 28, everyone is closed.
    assert.throws(() => env.gs.submitRsvp_(env.c, { action: 'rsvp', code: cer, attendance: { ceremony: [] } }, at('2099-11-29T17:00:00Z')), (e) => e.code === 'closed' && /November 28, 2099/.test(e.message));
  });

  test('with no ceremony-only deadline, everyone uses the RSVP Deadline', () => {
    const env = setup({ settings: { ...SETTINGS, 'RSVP Deadline': '2099-11-22' } });
    assert.equal(apiGet(env, { code: env.code(2) }).data.rsvp.deadline, '2099-11-22');
    assert.match(env.row(2)['Text Message'], /by November 22, 2099/);
    // And a ceremony-only deadline that isn't a date is reported by the guest list check.
    setSettings(env, { 'RSVP Deadline (Ceremony Only)': 'the 28th' });
    assert.match(env.gs.validateGuestList_(env.c).join('\n'), /RSVP Deadline \(Ceremony Only\)" is not a date/);
  });
});

/* ------------------------------------------------------------------ */
describe('RSVP emails', () => {
  test('guests get a confirmation summary when turned on', () => {
    const env = setup({ settings: { ...SETTINGS, 'Send RSVP Confirmations': 'Yes', 'Reply-To Email': 'couple@example.com' } });
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: [] }, { name: 'Sam Plus', ceremony: true });
    assert.equal(env.mail.sent.length, 1);
    const m = env.mail.sent[0];
    assert.equal(m.to, 'carol@example.com,carol.work@example.com');
    assert.equal(m.replyTo, 'couple@example.com');
    assert.match(m.body, /Ceremony: Carol Jones & Sam Plus \(guest\) attending/);
    assert.match(m.body, /Reception: no one attending/);
    assert.match(m.htmlBody, new RegExp(env.code(1)));
  });

  test('ceremony-only confirmations never mention the reception', () => {
    const env = setup({ settings: { ...SETTINGS, 'Send RSVP Confirmations': 'Yes' } });
    rsvp(env, 2, { ceremony: ['Dan Brown'] });
    const m = env.mail.sent[0];
    assert.match(m.body, /Ceremony: Dan Brown attending \(Erin Brown & Finn Brown not attending\)/);
    assert.doesNotMatch(m.body + m.htmlBody, /reception/i);
  });

  test('no confirmation when turned off', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: [] });
    assert.equal(env.mail.sent.length, 0);
  });

  test('the couple can be notified of every RSVP', () => {
    const env = setup({ settings: { ...SETTINGS, 'Notify Email': 'stephanie@example.com, robert@example.com' } });
    rsvp(env, 0, { ceremony: ['Alice Smith'], reception: [] });
    assert.equal(env.mail.sent.length, 1);
    assert.equal(env.mail.sent[0].to, 'stephanie@example.com,robert@example.com');
    assert.equal(env.mail.sent[0].subject, 'RSVP: Alice Smith, Bob Smith (Attending)');
  });

  test('if email fails, the RSVP is still saved and the guest still sees success', () => {
    const env = setup({ settings: { ...SETTINGS, 'Send RSVP Confirmations': 'Yes' } });
    env.mail.failNext = true;
    const res = rsvp(env, 0, { ceremony: ['Alice Smith'], reception: ['Alice Smith'] });
    assert.equal(res.ok, true);
    assert.equal(env.row(0)['Ceremony Attending'], 'Alice Smith');
    assert.equal(env.logs.errors.length, 1);
  });

  test('no confirmation is attempted when the daily quota is used up', () => {
    const env = setup({ settings: { ...SETTINGS, 'Send RSVP Confirmations': 'Yes' }, quota: 0 });
    assert.equal(rsvp(env, 0, { ceremony: [] }).ok, true);
    assert.equal(env.mail.sent.length, 0);
    assert.equal(env.logs.errors.length, 0);
  });
});

/* ------------------------------------------------------------------ */
describe('sending invitations', () => {
  const allRows = (env) => env.sheet.objects().map((_, i) => i + 2);

  test('emails each household its own link and marks it sent', () => {
    const env = setup();
    const result = env.gs.sendEmails_(env.c, allRows(env), 'invite');
    assert.equal(result.sent.length, 4);
    assert.equal(env.mail.sent.length, 4);
    env.sheet.objects().forEach((row, i) => {
      const m = env.mail.sent[i];
      assert.ok(row['Invite Sent At'] instanceof Date);
      assert.ok(m.htmlBody.includes(row['Invite Link']));
      assert.ok(m.body.includes(row.Code));
      assert.equal(m.name, 'Stephanie & Robert');
    });
    assert.equal(env.mail.sent[1].to, 'carol@example.com,carol.work@example.com');
  });

  test('invite wording matches the invite type and plus one', () => {
    const env = setup({ settings: { ...SETTINGS, 'RSVP Deadline': '2099-11-20' } });
    env.gs.sendEmails_(env.c, allRows(env), 'invite');
    const [smiths, carol, browns, gina] = env.mail.sent;
    assert.match(smiths.body, /^Dear Alice Smith, Bob Smith,/);
    assert.match(smiths.body, /ceremony and the reception to follow/);
    assert.doesNotMatch(smiths.body, /bring a guest/);
    assert.match(carol.body, /bring a guest/);
    assert.match(browns.body, /^Dear Dan Brown, Erin Brown, Finn Brown,/);
    for (const m of [browns, gina]) assert.doesNotMatch(m.body + m.htmlBody, /reception/i);
    assert.match(gina.body, /bring a guest/);
    for (const m of env.mail.sent) assert.match(m.body, /Please RSVP by November 20, 2099\./);
  });

  test('names are HTML-escaped in emails', () => {
    const env = setup({ guests: [{ 'Guest Names': '<img src=x onerror=alert(1)>', Email: 'x@example.com', 'Invite Type': CER }] });
    env.gs.sendEmails_(env.c, [2], 'invite');
    assert.ok(!env.mail.sent[0].htmlBody.includes('<img src=x'));
    assert.ok(env.mail.sent[0].htmlBody.includes('&lt;img'));
  });

  test('skips rows that cannot be emailed and says why', () => {
    const env = setup({
      guests: [
        ...GUESTS,
        { 'Guest Names': 'No Email', 'Invite Type': CER },
        { 'Guest Names': 'Bad Email', Email: 'not-an-email', 'Invite Type': CER },
        { 'Guest Names': 'No Type', Email: 'notype@example.com' },
      ],
    });
    const result = env.gs.sendEmails_(env.c, allRows(env), 'invite');
    assert.equal(result.sent.length, 4);
    assert.deepEqual(result.skipped, ['No Email: no valid email address', 'Bad Email: no valid email address', 'No Type: Invite Type is missing']);
    assert.equal(env.row(4)['Invite Sent At'], '');
  });

  test('"send all unsent" only picks rows not yet sent, so it can be re-run safely', () => {
    const env = setup();
    env.gs.sendEmails_(env.c, [2, 3], 'invite');
    assert.deepEqual(env.gs.unsentRows_(env.c), [4, 5]);
    env.gs.sendEmails_(env.c, env.gs.unsentRows_(env.c), 'invite');
    assert.deepEqual(env.gs.unsentRows_(env.c), []);
    assert.equal(env.mail.sent.length, 4);
  });

  test('stops cleanly at the daily email limit and finishes the rest the next day', () => {
    const env = setup({ quota: 3 }); // household 2 has 2 addresses
    const day1 = env.gs.sendEmails_(env.c, env.gs.unsentRows_(env.c), 'invite');
    assert.deepEqual(day1.sent, ['Alice Smith, Bob Smith', 'Carol Jones']);
    assert.equal(day1.quotaHit, true);
    assert.equal(day1.skipped.length, 2);
    assert.deepEqual(env.gs.unsentRows_(env.c), [4, 5]);

    env.mail.quota = 100; // next day
    const day2 = env.gs.sendEmails_(env.c, env.gs.unsentRows_(env.c), 'invite');
    assert.equal(day2.sent.length, 2);
    assert.equal(env.mail.sent.length, 4);
  });

  test('generates codes for brand-new rows before sending', () => {
    const env = setup();
    env.sheet.appendRow(['', 'Late Addition', 'late@example.com', CER, 'No']);
    const row = env.sheet.getLastRow();
    env.gs.sendEmails_(env.c, [row], 'invite');
    const code = env.row(row - 2).Code;
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.ok(env.mail.sent[0].body.includes(code));
  });

  test('reminders go only to households that were invited and have not replied', () => {
    const env = setup();
    env.gs.sendEmails_(env.c, [2, 3, 4], 'invite');
    rsvp(env, 0, { ceremony: ['Alice Smith'], reception: [] });
    env.mail.sent = [];
    const rows = env.gs.reminderRows_(env.c);
    assert.deepEqual(rows, [3, 4]); // row 5 (Gina) was never invited
    const result = env.gs.sendEmails_(env.c, rows, 'reminder');
    assert.equal(result.sent.length, 2);
    assert.match(env.mail.sent[0].subject, /Reminder/);
    assert.match(env.mail.sent[0].body, /haven't received your RSVP/);
    assert.ok(env.row(1)['Reminder Sent At'] instanceof Date);
    assert.equal(env.row(0)['Reminder Sent At'], '');
  });

  test('reminders skip anyone who replied in the meantime', () => {
    const env = setup();
    env.gs.sendEmails_(env.c, [2], 'invite');
    rsvp(env, 0, { ceremony: [] });
    const result = env.gs.sendEmails_(env.c, [2], 'reminder');
    assert.deepEqual(result.skipped, ['Alice Smith, Bob Smith: already responded']);
  });
});

/* ------------------------------------------------------------------ */
describe('spreadsheet menu', () => {
  test('onOpen adds the Wedding menu and every item points at a real function', () => {
    const env = setup();
    env.gs.onOpen();
    const menu = env.ui.menus[0];
    assert.equal(menu.name, '💌 Wedding');
    assert.ok(menu.items.length >= 8);
    for (const [, fn] of menu.items) assert.equal(typeof env.gs[fn], 'function', fn);
  });

  test('Send all unsent asks first, and does nothing on Cancel', () => {
    const env = setup();
    env.ui.nextAnswer = 'CANCEL';
    env.gs.menuSendAllUnsent();
    assert.equal(env.mail.sent.length, 0);
    assert.match(env.ui.alerts[0], /Send invitations to 4 households\?/);
    env.ui.nextAnswer = 'OK';
    env.gs.menuSendAllUnsent();
    assert.equal(env.mail.sent.length, 4);
    assert.match(env.ui.alerts.at(-1), /Sent 4 emails\./);
  });

  test('Send to selected rows only emails the selection', () => {
    const env = setup();
    env.ss.select('Guests', [3, 4]);
    env.gs.menuSendSelected();
    assert.deepEqual(env.mail.sent.map((m) => m.to), ['carol@example.com,carol.work@example.com', 'browns@example.com']);
  });

  test('Send to selected rows ignores the header row and asks you to select rows on the Guests tab', () => {
    const env = setup();
    env.ss.select('Guests', [1, 2]);
    env.gs.menuSendSelected();
    assert.equal(env.mail.sent.length, 1);
    env.ss.select('Settings', [2]);
    env.gs.menuSendSelected();
    assert.match(env.ui.alerts.at(-1), /select the rows/);
  });

  test('Send a test invite goes to you and does not mark the guest as sent', () => {
    const env = setup();
    env.ss.select('Guests', [4]);
    env.gs.menuSendTestInvite();
    assert.equal(env.mail.sent[0].to, 'owner@example.com');
    assert.match(env.mail.sent[0].subject, /^\[TEST\]/);
    assert.match(env.mail.sent[0].body, /Dan Brown/);
    assert.equal(env.row(2)['Invite Sent At'], '');
  });

  test('Generate codes and Set up report what happened', () => {
    const env = setup();
    env.gs.menuGenerateCodes();
    assert.match(env.ui.alerts.at(-1), /already has a code/);
    env.gs.menuSetup();
    assert.match(env.ui.alerts.at(-1), /All set/);
  });
});

/* ------------------------------------------------------------------ */
describe('checking the guest list', () => {
  test('a clean list has no problems', () => {
    const env = setup();
    assert.deepEqual(env.gs.validateGuestList_(env.c), []);
  });

  test('flags common mistakes', () => {
    const env = setup({
      guests: [
        ...GUESTS,
        { 'Guest Names': 'Ham & Eggs', Email: 'ham@example.com', 'Invite Type': CER },
        { 'Guest Names': 'Typo Type', Email: 'typo@example.com', 'Invite Type': 'Brunch', 'Plus One': 'Maybe' },
        { 'Guest Names': 'No Mail', 'Invite Type': CER },
        { 'Guest Names': 'Bad Mail', Email: 'bad@', 'Invite Type': CER },
        { 'Guest Names': 'Dupe Mail', Email: 'SMITHS@example.com', 'Invite Type': CER },
        { 'Guest Names': 'Carol Jones', Email: 'carol2@example.com', 'Invite Type': CER },
        { Email: 'orphan@example.com', 'Invite Type': CER },
      ],
      settings: { 'RSVP Deadline': 'next friday' },
    });
    const problems = env.gs.validateGuestList_(env.c).join('\n');
    assert.match(problems, /Row 6: separate guest names with commas/);
    assert.match(problems, /Row 7: Invite Type should be/);
    assert.match(problems, /Row 7: Plus One should be Yes or No \(found "Maybe"\)/);
    assert.doesNotMatch(problems, /Row 8/); // no email is fine: they can be texted
    assert.match(problems, /Row 9: "bad@" does not look like an email/);
    assert.match(problems, /Row 10: SMITHS@example.com is also used on row 2/);
    assert.match(problems, /Row 11: Carol Jones is also listed on row 3/);
    assert.match(problems, /Row 12: no guest names/);
    assert.match(problems, /Site URL" is still the example address/);
    assert.match(problems, /RSVP Deadline" is not a date/);
  });

  test('flags duplicate codes', () => {
    const env = setup();
    env.sheet.getRange(3, 1).setValue(env.code(0));
    assert.match(env.gs.validateGuestList_(env.c).join('\n'), /Row 3: code .* is also used on row 2/);
  });

  test('the menu shows the problems', () => {
    const env = setup({ settings: { 'Site URL': 'https://example.com' } });
    env.gs.menuCheckGuestList();
    assert.match(env.ui.alerts[0], /Found 1 thing to check/);
  });
});

/* ------------------------------------------------------------------ */
describe('inviting by text', () => {
  test('every household gets a ready-to-send text with its own link', () => {
    const env = setup();
    const [smiths, carol, browns, gina] = env.sheet.objects();
    assert.equal(smiths['Text Message'],
      "Hi Alice & Bob! We're getting married and would love for you to join us for " +
      `our wedding ceremony and the reception to follow. Here's your invitation, where you can RSVP: ${smiths['Invite Link']}`);
    assert.match(carol['Text Message'], /^Hi Carol! .*You're welcome to bring a guest! Here's your invitation/);
    assert.match(browns['Text Message'], /^Hi Dan, Erin & Finn! /);
    for (const r of [browns, gina]) {
      assert.doesNotMatch(r['Text Message'], /reception/i);
      assert.ok(r['Text Message'].endsWith(r['Invite Link']));
    }
    assert.match(gina['Text Message'], /bring a guest/);
  });

  test('the RSVP deadline is included once it is set', () => {
    const env = setup({ settings: { ...SETTINGS, 'RSVP Deadline': '2099-11-20' } });
    assert.match(env.row(0)['Text Message'], /where you can RSVP by November 20, 2099: https/);
  });

  test('the wording can be changed on the Settings tab', () => {
    const env = setup();
    setSettings(env, { 'Text Message': 'Hey {NAMES}, code {code}, {events} on {date}. {link}' });
    env.gs.generateCodes_(env.c);
    const r = env.row(2);
    assert.equal(r['Text Message'], `Hey Dan Brown, Erin Brown, Finn Brown, code ${r.Code}, our wedding ceremony on Saturday, June 6, 2099. ${r['Invite Link']}`);
  });

  test('editing the Settings tab refreshes every text right away', () => {
    const env = setup();
    setSettings(env, { 'RSVP Deadline': '2099-11-15' });
    const settings = env.ss.getSheetByName('Settings');
    env.gs.onEdit({ range: settings.getRange(3, 2) });
    for (const r of env.sheet.objects()) assert.match(r['Text Message'], /by November 15, 2099/);
  });

  test('changing a guest row (names, invite type, plus one) updates its text', () => {
    const env = setup();
    const cols = env.sheet.rows()[0];
    env.sheet.getRange(4, cols.indexOf('Invite Type') + 1).setValue(FULL);
    env.sheet.getRange(4, cols.indexOf('Plus One') + 1).setValue('Yes');
    env.gs.onEdit({ range: env.sheet.getRange(4, cols.indexOf('Invite Type') + 1, 1, 2) });
    assert.match(env.row(2)['Text Message'], /reception to follow\. You're welcome to bring a guest!/);
  });

  test('rows without an Invite Type get no text yet (nothing wrong gets sent)', () => {
    const env = setup({ guests: [{ 'Guest Names': 'Typo Tom', 'Invite Type': '' }] });
    assert.match(env.row(0).Code, /^[A-Z2-9]{8}$/);
    assert.equal(env.row(0)['Text Message'], '');
  });

  test('"Mark selected rows as invited" records the date without touching rows already marked', () => {
    const env = setup({ guests: GUESTS.map((g) => ({ ...g, Email: '' })) });
    env.ss.select('Guests', [2, 3]);
    env.gs.menuMarkTexted();
    assert.match(env.ui.alerts.at(-1), /Marked 2 households as invited/);
    const first = env.row(0)['Invite Sent At'];
    assert.ok(first instanceof Date);
    assert.equal(env.row(2)['Invite Sent At'], '');

    env.ss.select('Guests', [2, 4]);
    env.gs.menuMarkTexted();
    assert.match(env.ui.alerts.at(-1), /Marked 1 household as invited/);
    assert.equal(env.row(0)['Invite Sent At'].getTime(), first.getTime());
    assert.equal(env.mail.sent.length, 0);
  });

  test('"Mark selected rows" asks you to select rows on the Guests tab', () => {
    const env = setup();
    env.ss.select('Settings', [2]);
    env.gs.menuMarkTexted();
    assert.match(env.ui.alerts.at(-1), /select the rows you texted/);
  });

  test('texted guests with no email can still RSVP', () => {
    const env = setup({ guests: [{ 'Guest Names': 'Text Only', 'Invite Type': CER }], settings: { ...SETTINGS, 'Send RSVP Confirmations': 'Yes' } });
    assert.equal(rsvp(env, 0, { ceremony: ['Text Only'] }).ok, true);
    assert.equal(env.row(0)['RSVP Status'], 'Attending');
    assert.equal(env.mail.sent.length, 0);
  });
});

/* ------------------------------------------------------------------ */
describe('abuse protection', () => {
  const T0 = new Date('2099-11-01T12:00:00Z');
  const later = (ms) => new Date(T0.getTime() + ms);

  test('after 60 wrong codes in 10 minutes, all lookups pause; they resume in the next window', () => {
    const env = setup();
    for (let i = 0; i < 60; i++) {
      assert.throws(() => env.gs.handleGet_(env.c, { code: `WRONG${i}` }, later(i * 1000)), (e) => e.code === 'not_found');
    }
    // Even a real code is refused while paused, so a guesser can't learn anything.
    assert.throws(() => env.gs.handleGet_(env.c, { code: env.code(0) }, later(70000)), (e) => e.code === 'rate_limited');
    assert.throws(() => env.gs.submitRsvp_(env.c, { action: 'rsvp', code: env.code(0), attendance: {} }, later(70000)), (e) => e.code === 'rate_limited');
    assert.equal(env.row(0)['RSVP Status'], 'Not responded');
    assert.equal(env.gs.handleGet_(env.c, { code: env.code(0) }, later(10 * 60 * 1000)).code, env.code(0));
  });

  test('normal use (real codes, a few typos) is never paused', () => {
    const env = setup();
    for (let i = 0; i < 200; i++) env.gs.handleGet_(env.c, { code: env.code(i % 4) }, later(i * 100));
    for (let i = 0; i < 5; i++) assert.throws(() => env.gs.handleGet_(env.c, { code: 'TYPO' + i }, later(i)), (e) => e.code === 'not_found');
    assert.equal(env.gs.handleGet_(env.c, { code: env.code(0) }, later(1000)).code, env.code(0));
  });

  test('wrong codes sent to the RSVP form count too', () => {
    const env = setup();
    for (let i = 0; i < 60; i++) {
      assert.throws(() => env.gs.submitRsvp_(env.c, { action: 'rsvp', code: `NOPE${i}` }, later(i)), (e) => e.code === 'not_found');
    }
    assert.throws(() => env.gs.handleGet_(env.c, { code: env.code(0) }, later(100)), (e) => e.code === 'rate_limited');
    assert.equal(env.lock.held, false);
  });

  test('the web API returns a friendly rate-limit message', () => {
    const env = setup();
    for (let i = 0; i < 60; i++) apiGet(env, { code: `WRONG${i}` });
    const res = apiGet(env, { code: env.code(0) });
    assert.equal(res.error, 'rate_limited');
    assert.match(res.message, /wait a few minutes/);
  });

  test('confirmation emails go out at most once per household every 10 minutes', () => {
    const env = setup({ settings: { ...SETTINGS, 'Send RSVP Confirmations': 'Yes', 'Notify Email': 'us@example.com' } });
    for (let i = 0; i < 20; i++) assert.equal(rsvp(env, 0, { ceremony: i % 2 ? ['Alice Smith'] : [] }).ok, true);
    assert.equal(env.mail.sent.length, 2); // one confirmation + one notification
    assert.equal(env.row(0)['RSVP Status'], 'Attending'); // every RSVP is still saved

    rsvp(env, 1, { ceremony: ['Carol Jones'] }); // other households are unaffected
    assert.equal(env.mail.sent.length, 4);

    env.cache.advance(10 * 60 * 1000 + 1);
    rsvp(env, 0, { ceremony: [] });
    assert.equal(env.mail.sent.length, 6);
  });
});

/* ------------------------------------------------------------------ */
describe('invitation cards', () => {
  const CARD = {
    ...SETTINGS,
    'Invitation Date & Time': "Saturday, the sixth of June / two thousand ninety-nine / at four o'clock in the afternoon",
    'Invitation Location': '123 Placeholder Ave, Springfield',
    'Full Invite: Hosts': 'Mr. and Mrs. Sample',
    'Full Invite: Request': 'request the pleasure of your company at / the marriage of their daughter',
    'Full Invite: First Name': 'Stephanie Example',
    'Full Invite: Joiner': 'to',
    'Full Invite: Second Name': 'Robert Example',
    'Full Invite: Under Names': 'son of Mr. and Mrs. Example',
    'Ceremony Invite: Intro': 'You are invited to',
    'Ceremony Invite: Names': "Stephanie & Robert's",
    'Ceremony Invite: Title': 'Wedding',
  };

  test('Wedding + Reception guests get the formal card, split into lines at " / "', () => {
    const env = setup({ settings: CARD });
    assert.deepEqual(apiGet(env, { code: env.code(0) }).data.invitation, {
      design: 'full',
      hosts: ['Mr. and Mrs. Sample'],
      request: ['request the pleasure of your company at', 'the marriage of their daughter'],
      firstName: 'Stephanie Example',
      joiner: 'to',
      secondName: 'Robert Example',
      underNames: ['son of Mr. and Mrs. Example'],
      when: ['Saturday, the sixth of June', 'two thousand ninety-nine', "at four o'clock in the afternoon"],
      where: ['123 Placeholder Ave, Springfield'],
      closing: ['Reception to follow'],
    });
  });

  test('the closing line can be changed or cleared, and never reaches ceremony-only guests', () => {
    const env = setup({ settings: { ...CARD, 'Full Invite: Closing Line': '' } });
    assert.deepEqual(apiGet(env, { code: env.code(0) }).data.invitation.closing, []);
    const raw = JSON.stringify(apiGet(env, { code: env.code(2) }));
    assert.ok(!raw.includes('closing') && !/reception to follow/i.test(raw));
  });

  test('Ceremony Only guests get the "You are invited to" card and none of the formal card wording', () => {
    const env = setup({ settings: CARD });
    const res = apiGet(env, { code: env.code(2) });
    assert.deepEqual(res.data.invitation, {
      design: 'ceremony',
      intro: ['You are invited to'],
      names: "Stephanie & Robert's",
      title: 'Wedding',
      when: ['Saturday, the sixth of June', 'two thousand ninety-nine', "at four o'clock in the afternoon"],
      where: ['123 Placeholder Ave, Springfield'],
    });
    const raw = JSON.stringify(res);
    assert.ok(!raw.includes('Mr. and Mrs. Sample') && !raw.includes('marriage of their daughter'));
  });

  test('line breaks typed inside a cell (Ctrl+Enter) also start new lines', () => {
    const env = setup({ settings: { ...CARD, 'Invitation Date & Time': 'Line one\nLine two' } });
    assert.deepEqual(apiGet(env, { code: env.code(0) }).data.invitation.when, ['Line one', 'Line two']);
  });

  test('a typed "\n" also starts a new line (e.g. two sets of hosts)', () => {
    const env = setup({ settings: { ...CARD, 'Full Invite: Hosts': 'Mr. and Mrs. Sample One & \\n Mr. and Mrs. Sample Two' } });
    assert.deepEqual(apiGet(env, { code: env.code(0) }).data.invitation.hosts, ['Mr. and Mrs. Sample One &', 'Mr. and Mrs. Sample Two']);
  });

  test('a "/" without spaces (like 6/6) is not treated as a line break', () => {
    const env = setup({ settings: { ...CARD, 'Invitation Date & Time': 'on 6/6 at four' } });
    assert.deepEqual(apiGet(env, { code: env.code(0) }).data.invitation.when, ['on 6/6 at four']);
  });

  test('the defaults in the public code contain no date, time or place', () => {
    const env = createGas();
    const defaults = env.gs.SETTINGS_DEFAULTS.map((d) => String(d[1])).join(' | ');
    assert.doesNotMatch(defaults, /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
    assert.doesNotMatch(defaults, /\b(19|20)\d\d\b/);
    assert.doesNotMatch(defaults, /o'clock|\b\d{1,2}:\d\d\b/i);
  });

  test('emails show the date in the header only when it is set', () => {
    const env = setup({ settings: { ...SETTINGS, 'Ceremony Date': '' } });
    env.gs.sendEmails_(env.c, [2], 'invite');
    assert.doesNotMatch(env.mail.sent[0].htmlBody, /JUNE/);
    assert.match(env.mail.sent[0].body, /join us for our wedding ceremony and the reception to follow\./);
    const env2 = setup();
    env2.gs.sendEmails_(env2.c, [2], 'invite');
    assert.match(env2.mail.sent[0].htmlBody, /SATURDAY, JUNE 6, 2099/);
    assert.match(env2.mail.sent[0].body, /to follow on Saturday, June 6, 2099\./);
  });
});

/* ------------------------------------------------------------------ */
describe('declined columns and counts', () => {
  test('partial answers list who said no to each event', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: ['Bob Smith'], reception: ['Alice Smith'] });
    assert.equal(env.row(0)['Ceremony Declined'], 'Alice Smith');
    assert.equal(env.row(0)['Reception Declined'], 'Bob Smith');
  });

  test('declining everything lists everyone; attending everything leaves them blank', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: [], reception: [] });
    assert.equal(env.row(0)['Ceremony Declined'], 'Alice Smith, Bob Smith');
    assert.equal(env.row(0)['Reception Declined'], 'Alice Smith, Bob Smith');
    rsvp(env, 0, { ceremony: ['Alice Smith', 'Bob Smith'], reception: ['Alice Smith', 'Bob Smith'] });
    assert.equal(env.row(0)['Ceremony Declined'], '');
    assert.equal(env.row(0)['Reception Declined'], '');
  });

  test('ceremony-only invitations never get a reception "declined"', () => {
    const env = setup();
    rsvp(env, 2, { ceremony: ['Dan Brown'] });
    assert.equal(env.row(2)['Ceremony Declined'], 'Erin Brown, Finn Brown');
    assert.equal(env.row(2)['Reception Declined'], '');
  });

  test('plus ones are never counted as declined', () => {
    const env = setup();
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: [] }, { name: '', ceremony: false, reception: false });
    assert.equal(env.row(1)['Ceremony Declined'], '');
    assert.equal(env.row(1)['Reception Declined'], 'Carol Jones');
  });

  test('households that have not responded have blank declined columns', () => {
    const env = setup();
    for (const r of env.sheet.objects()) {
      assert.equal(r['Ceremony Declined'], '');
      assert.equal(r['Reception Declined'], '');
    }
  });

  test('typing a phone RSVP into the sheet fills in the declined columns', () => {
    const env = setup();
    const cols = env.sheet.rows()[0];
    env.sheet.getRange(4, cols.indexOf('RSVP Status') + 1).setValue('Attending');
    env.sheet.getRange(4, cols.indexOf('Ceremony Attending') + 1).setValue('erin brown');
    env.gs.onEdit({ range: env.sheet.getRange(4, cols.indexOf('Ceremony Attending') + 1) });
    assert.equal(env.row(2)['Ceremony Declined'], 'Dan Brown, Finn Brown');
  });

  test('upgrading an older sheet adds the columns and fills them in for existing answers', () => {
    const env = createGas();
    const g = env.ss.insertSheet('Guests');
    g.appendRow(['Code', 'Guest Names', 'Email', 'Invite Type', 'Plus One', 'RSVP Status', 'Ceremony Attending', 'Reception Attending', 'Plus One Name', 'Responded At']);
    g.appendRow(['ABCDEFGH', 'Old One, Old Two', 'o@example.com', FULL, 'No', 'Attending', 'Old One', 'Old One, Old Two', '', '']);
    env.gs.menuSetup();
    const row = g.objects()[0];
    assert.equal(row['Ceremony Declined'], 'Old Two');
    assert.equal(row['Reception Declined'], '');
    assert.equal(row['Ceremony Attending'], 'Old One');
  });

  test('the Summary counts declined people per event', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: ['Bob Smith'], reception: [] });
    rsvp(env, 2, { ceremony: [] });
    const count = (col) => env.sheet.objects().reduce((n, r) => n + (String(r[col]).trim() ? String(r[col]).split(',').length : 0), 0);
    assert.equal(count('Ceremony Declined'), 4); // Alice + the three Browns
    assert.equal(count('Reception Declined'), 2); // Alice + Bob
    const value = summaryValues(env);
    assert.equal(value['Ceremony: declined (people)'], 4);
    assert.equal(value['Reception: declined (people)'], 2);
  });
});

/* ------------------------------------------------------------------ */
describe('tracking opened invitations', () => {
  test('just loading the invitation (like a link preview does) records nothing', () => {
    const env = setup();
    const before = env.sheet.rows();
    apiGet(env, { action: 'invite', code: env.code(1) });
    apiGet(env, { code: env.code(1) });
    assert.deepEqual(env.sheet.rows(), before);
  });

  test('the first time a household taps the envelope open, the time is recorded', () => {
    const env = setup();
    assert.equal(env.row(1)['Invite Opened At'], '');
    const first = new Date('2099-01-02T15:00:00Z');
    assert.deepEqual(env.gs.handleGet_(env.c, { action: 'opened', code: env.code(1) }, first), { opened: true });
    assert.equal(env.row(1)['Invite Opened At'].getTime(), first.getTime());
    for (const i of [0, 2, 3]) assert.equal(env.row(i)['Invite Opened At'], '');
  });

  test('opening it again keeps the first time', () => {
    const env = setup();
    const first = new Date('2099-01-02T15:00:00Z');
    env.gs.handleGet_(env.c, { action: 'opened', code: env.code(0) }, first);
    env.gs.handleGet_(env.c, { action: 'opened', code: env.code(0) }, new Date('2099-01-05T15:00:00Z'));
    assert.equal(env.row(0)['Invite Opened At'].getTime(), first.getTime());
  });

  test('the real web API records it too, and wrong codes record nothing', () => {
    const env = setup();
    const before = env.sheet.rows();
    assert.equal(apiGet(env, { action: 'opened', code: 'WRONG123' }).error, 'not_found');
    assert.deepEqual(env.sheet.rows(), before);
    assert.equal(apiGet(env, { action: 'opened', code: env.code(2) }).ok, true);
    assert.ok(env.row(2)['Invite Opened At'] instanceof Date);
  });

  test('an RSVP also counts as opened (in case the open was never recorded)', () => {
    const env = setup();
    rsvp(env, 3, { ceremony: ['Gina Lee'] });
    assert.ok(env.row(3)['Invite Opened At'] instanceof Date);
  });

  test('clearing the cell (after testing it yourself) resets it', () => {
    const env = setup();
    apiGet(env, { action: 'opened', code: env.code(0) });
    const col = env.sheet.rows()[0].indexOf('Invite Opened At') + 1;
    env.sheet.getRange(2, col).setValue('');
    assert.equal(env.row(0)['Invite Opened At'], '');
    apiGet(env, { action: 'opened', code: env.code(0) });
    assert.ok(env.row(0)['Invite Opened At'] instanceof Date);
  });

  test('older sheets without the column still work, and Set up sheets adds it', () => {
    const env = createGas();
    const g = env.ss.insertSheet('Guests');
    g.appendRow(['Code', 'Guest Names', 'Email', 'Invite Type', 'Plus One', 'RSVP Status', 'Ceremony Attending', 'Reception Attending', 'Plus One Name', 'Responded At']);
    g.appendRow(['ABCDEFGH', 'Old One', 'o@example.com', CER, 'No', '', '', '', '', '']);
    assert.equal(apiGet(env, { code: 'ABCDEFGH' }).ok, true);
    env.gs.menuSetup();
    assert.ok(g.rows()[0].includes('Invite Opened At'));
    apiGet(env, { action: 'opened', code: 'ABCDEFGH' });
    assert.ok(g.objects()[0]['Invite Opened At'] instanceof Date);
  });

  test('a problem recording the open never blocks the invitation', () => {
    const env = setup();
    const real = env.gs.writeRow_;
    env.gs.writeRow_ = () => { throw new Error('sheet is busy'); };
    const res = apiGet(env, { action: 'opened', code: env.code(0) });
    env.gs.writeRow_ = real;
    assert.equal(res.ok, true);
    assert.equal(env.logs.errors.length, 1);
  });

  test('ping reports the current version', () => {
    const env = setup();
    assert.equal(apiGet(env, { action: 'ping' }).data.version, env.gs.VERSION);
  });
});

/* ------------------------------------------------------------------ */
describe('formal names ("Mr. & Mrs. …")', () => {
  const FORMAL = [
    { 'Guest Names': 'Mr. & Mrs. Sample Parker', 'Invite Type': FULL, 'Plus One': 'No' },
    { 'Guest Names': 'Mrs. Mary Example', 'Invite Type': CER, 'Plus One': 'Yes' },
    { 'Guest Names': 'Mr. and Mrs. Tim Testerson, Miss Emma Testerson', Email: 'b@example.com', 'Invite Type': FULL },
  ];

  test('splits couples into one person per RSVP row', () => {
    const env = createGas();
    const cases = {
      'Mr. & Mrs. Sample Parker': ['Mr. Sample Parker', 'Mrs. Sample Parker'],
      'Mr. and Mrs. Doug Placeholder': ['Mr. Doug Placeholder', 'Mrs. Doug Placeholder'],
      'Mr & Mrs Tim Testerson': ['Mr Tim Testerson', 'Mrs Tim Testerson'],
      'Dr. & Mr. Sam Lee': ['Dr. Sam Lee', 'Mr. Sam Lee'],
      'John & Jane Smith': ['John Smith', 'Jane Smith'],
      'Mrs. Mary Example': ['Mrs. Mary Example'],
      'Brandon Anderson': ['Brandon Anderson'],
      'Mary Ann & Joe Smith': ['Mary Ann & Joe Smith'],
    };
    for (const [entry, people] of Object.entries(cases)) assert.deepEqual(env.gs.peopleIn_([entry]), people, entry);
  });

  test('the invite shows the formal wording on the envelope and a row per person on the form', () => {
    const env = setup({ guests: FORMAL });
    const d = apiGet(env, { code: env.code(0) }).data;
    assert.equal(d.addressee, 'Mr. & Mrs. Sample Parker');
    assert.deepEqual(d.guests, ['Mr. Sample Parker', 'Mrs. Sample Parker']);
    const d3 = apiGet(env, { code: env.code(2) }).data;
    assert.equal(d3.addressee, 'Mr. and Mrs. Tim Testerson, Miss Emma Testerson');
    assert.deepEqual(d3.guests, ['Mr. Tim Testerson', 'Mrs. Tim Testerson', 'Miss Emma Testerson']);
  });

  test('both people can RSVP separately, and the sheet counts them separately', () => {
    const env = setup({ guests: FORMAL });
    const res = rsvp(env, 0, { ceremony: ['Mr. Sample Parker', 'Mrs. Sample Parker'], reception: ['Mrs. Sample Parker'] });
    assert.equal(res.ok, true, res.message);
    const row = env.row(0);
    assert.equal(row['Ceremony Attending'], 'Mr. Sample Parker, Mrs. Sample Parker');
    assert.equal(row['Reception Attending'], 'Mrs. Sample Parker');
    assert.equal(row['Reception Declined'], 'Mr. Sample Parker');
    assert.equal(row['Guest Names'], 'Mr. & Mrs. Sample Parker'); // never rewritten
  });

  test('Party Size counts the people, and the Summary adds it up', () => {
    const env = setup({ guests: FORMAL });
    assert.deepEqual(env.sheet.objects().map((r) => r['Party Size']), [2, 1, 3]);
    const summary = env.ss.getSheetByName('Summary');
    const label = summary.getRange(4, 1).getValue();
    assert.equal(label, 'People invited (not counting plus ones)');
    assert.match(summary.getRange(4, 2).getFormula(), /^=SUM\('Guests'!\w+2:\w+\)$/);
  });

  test('editing the names updates Party Size right away', () => {
    const env = setup({ guests: FORMAL });
    const cols = env.sheet.rows()[0];
    env.sheet.getRange(3, cols.indexOf('Guest Names') + 1).setValue('Mr. & Mrs. Robert Example');
    env.gs.onEdit({ range: env.sheet.getRange(3, cols.indexOf('Guest Names') + 1) });
    assert.equal(env.row(1)['Party Size'], 2);
  });

  test('texts and emails greet the household formally', () => {
    const env = setup({ guests: FORMAL });
    assert.match(env.row(0)['Text Message'], /^Hi Mr\. & Mrs\. Sample Parker! /);
    assert.match(env.row(1)['Text Message'], /^Hi Mrs\. Mary Example! /);
    env.gs.sendEmails_(env.c, [4], 'invite');
    assert.match(env.mail.sent[0].body, /^Dear Mr\. and Mrs\. Tim Testerson, Miss Emma Testerson,/);
  });

  test('informal names still greet by first name', () => {
    const env = setup({ guests: [{ 'Guest Names': 'John & Jane Smith', 'Invite Type': CER }, { 'Guest Names': 'Alice Smith, Bob Smith', 'Invite Type': CER }] });
    assert.match(env.row(0)['Text Message'], /^Hi John & Jane! /);
    assert.match(env.row(1)['Text Message'], /^Hi Alice & Bob! /);
  });

  test('"& Guest" means that person plus a plus one', () => {
    const env = setup({ guests: [
      { 'Guest Names': 'Mr. Sample Person & Guest', 'Invite Type': FULL },
      { 'Guest Names': 'Ms. Other Person and guest', 'Invite Type': CER, 'Plus One': 'No' },
      { 'Guest Names': 'Pat Example +1', 'Invite Type': CER },
    ] });
    const d = apiGet(env, { code: env.code(0) }).data;
    assert.deepEqual(d.guests, ['Mr. Sample Person']);
    assert.equal(d.plusOneAllowed, true);
    assert.equal(d.addressee, 'Mr. Sample Person & Guest');
    assert.equal(env.row(0)['Party Size'], 1);
    assert.match(env.row(0)['Text Message'], /^Hi Mr\. Sample Person! .*bring a guest/);
    assert.deepEqual(apiGet(env, { code: env.code(2) }).data.guests, ['Pat Example']);
    const ok = rsvp(env, 0, { ceremony: ['Mr. Sample Person'], reception: ['Mr. Sample Person'] }, { name: 'Their Date', ceremony: true, reception: true });
    assert.equal(ok.ok, true, ok.message);
    assert.equal(env.row(0)['Ceremony Attending'], 'Mr. Sample Person, Their Date');
    assert.match(env.gs.validateGuestList_(env.c).join('\n'), /Row 3: the names say "& Guest" but Plus One is "No"/);
  });

  test('the envelope uses the wording exactly as typed, commas and all', () => {
    const env = setup({ guests: [{ 'Guest Names': 'Mr. & Mrs. Sample Parent, Kid One, Kid Two', 'Invite Type': FULL }] });
    const d = apiGet(env, { code: env.code(0) }).data;
    assert.equal(d.addressee, 'Mr. & Mrs. Sample Parent, Kid One, Kid Two');
    assert.deepEqual(d.guests, ['Mr. Sample Parent', 'Mrs. Sample Parent', 'Kid One', 'Kid Two']);
    assert.equal(env.row(0)['Party Size'], 4);
  });

  test('the guest list check accepts formal couples but flags names it cannot split', () => {
    const env = setup({ guests: [...FORMAL, { 'Guest Names': 'Mary Ann & Joe Smith', 'Invite Type': CER }] });
    const problems = env.gs.validateGuestList_(env.c).join('\n');
    assert.doesNotMatch(problems, /Row [234]:.*separate/);
    assert.match(problems, /Row 5: separate guest names with commas, or write couples as "Mr\. & Mrs\. Full Name" \(couldn't split "Mary Ann & Joe Smith"\)/);
  });
});

/* ------------------------------------------------------------------ */
describe('plus one status column', () => {
  const status = (env, i) => env.row(i)['Plus One Status'];

  test('blank when no plus one was offered; "Waiting for RSVP" until they reply', () => {
    const env = setup(); // rows: Smiths (no +1), Carol (+1), Browns (no +1), Gina (+1)
    assert.deepEqual(env.sheet.objects().map((r) => r['Plus One Status']), ['', 'Waiting for RSVP', '', 'Waiting for RSVP']);
  });

  test('"Not bringing a guest" when they RSVP without one (blank Plus One Name)', () => {
    const env = setup();
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: ['Carol Jones'] }, { name: '', ceremony: false, reception: false });
    assert.equal(env.row(1)['Plus One Name'], '');
    assert.equal(status(env, 1), 'Not bringing a guest');
  });

  test('"Not bringing a guest" when they name a guest but mark them not attending', () => {
    const env = setup();
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: [] }, { name: 'Maybe Person', ceremony: false, reception: false });
    assert.equal(status(env, 1), 'Not bringing a guest');
  });

  test('"Bringing a guest" when their guest is coming, and it updates if they change their answer', () => {
    const env = setup();
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: [] }, { name: 'Sam Plus', ceremony: true, reception: false });
    assert.equal(status(env, 1), 'Bringing a guest');
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: [] }, { name: '', ceremony: false, reception: false });
    assert.equal(status(env, 1), 'Not bringing a guest');
  });

  test('works for "& Guest" households', () => {
    const env = setup({ guests: [{ 'Guest Names': 'Mr. Sample Person & Guest', 'Invite Type': FULL }] });
    assert.equal(status(env, 0), 'Waiting for RSVP');
    rsvp(env, 0, { ceremony: ['Mr. Sample Person'], reception: ['Mr. Sample Person'] });
    assert.equal(status(env, 0), 'Not bringing a guest');
  });

  test('declining the whole invitation also shows "Not bringing a guest"', () => {
    const env = setup();
    rsvp(env, 3, { ceremony: [] });
    assert.equal(status(env, 3), 'Not bringing a guest');
  });

  test('upgrading fills it in for RSVPs that came in before the column existed', () => {
    const env = createGas();
    const g = env.ss.insertSheet('Guests');
    g.appendRow(['Code', 'Guest Names', 'Email', 'Invite Type', 'Plus One', 'RSVP Status', 'Ceremony Attending', 'Reception Attending', 'Plus One Name', 'Responded At']);
    g.appendRow(['ABCDEFGH', 'Mr. Early Bird & Guest', '', FULL, '', 'Attending', 'Mr. Early Bird', 'Mr. Early Bird', '', '']);
    g.appendRow(['HGFEDCBA', 'Other Early', '', CER, 'Yes', 'Attending', 'Other Early, Their Pal', '', 'Their Pal', '']);
    env.gs.menuSetup();
    const rows = g.objects();
    assert.equal(rows[0]['Plus One Status'], 'Not bringing a guest');
    assert.equal(rows[1]['Plus One Status'], 'Bringing a guest');
  });

  test('the Summary counts plus ones coming, not coming, and still waiting', () => {
    const env = setup();
    const labels = env.ss.getSheetByName('Summary').rows().map((r) => r[0]);
    for (const l of ['Plus ones coming', 'Plus ones not coming', 'Plus ones still waiting on an RSVP']) assert.ok(labels.includes(l), l);
  });
});

/* ------------------------------------------------------------------ */
describe('reception dinner selection', () => {
  const meal = (env, i, choices, notes) => apiPost(env, { action: 'meal', code: env.code(i), choices, ...(notes !== undefined ? { notes } : {}) });
  const menu = (env, i) => apiGet(env, { action: 'meal', code: env.code(i) });

  test('Wedding + Reception households get a meal link and a ready-to-send meal text; ceremony-only do not', () => {
    const env = setup();
    const rows = env.sheet.objects();
    assert.equal(rows[0]['Meal Link'], `https://stephanieandrobert.test/meal/?code=${rows[0].Code}`);
    assert.equal(rows[0]['Meal Text Message'], `Hi Alice & Bob! Please choose your dinner for our reception: ${rows[0]['Meal Link']}`);
    for (const i of [2, 3]) {
      assert.equal(rows[i]['Meal Link'], '');
      assert.equal(rows[i]['Meal Text Message'], '');
    }
  });

  test('the meal deadline appears in the meal text once set', () => {
    const env = setup({ settings: { ...SETTINGS, 'Meal Deadline': '2099-05-01' } });
    assert.match(env.row(0)['Meal Text Message'], /dinner for our reception by May 1, 2099: https/);
  });

  test('before anyone RSVPs for the reception, the menu has no one to choose for', () => {
    const env = setup();
    const d = menu(env, 0).data;
    assert.deepEqual(d.people, []);
    assert.deepEqual(d.options, ['North Atlantic Salmon', 'Filet Mignon']);
    assert.equal(d.responded, false);
    assert.equal(d.complete, false);
    assert.equal(meal(env, 0, {}).error, 'no_reception_guests');
  });

  test('ceremony-only guests cannot open or save the dinner menu', () => {
    const env = setup();
    assert.equal(menu(env, 2).error, 'not_reception');
    assert.equal(meal(env, 2, { 'Dan Brown': 'Filet Mignon' }).error, 'not_reception');
  });

  test('everyone coming to the reception (including a plus one) picks a meal, and the row shows it', () => {
    const env = setup();
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: ['Carol Jones'] }, { name: 'Sam Plus', ceremony: true, reception: true });
    assert.deepEqual(menu(env, 1).data.people, ['Carol Jones', 'Sam Plus']);
    const res = meal(env, 1, { 'Carol Jones': 'Filet Mignon', 'Sam Plus': 'north atlantic salmon' }, 'Sam is allergic to shellfish');
    assert.equal(res.ok, true, res.message);
    const row = env.row(1);
    assert.equal(row['Meal Choices'], 'Carol Jones: Filet Mignon; Sam Plus: North Atlantic Salmon');
    assert.equal(row['Dietary Notes'], 'Sam is allergic to shellfish');
    assert.ok(row['Meals Chosen At'] instanceof Date);
    assert.deepEqual(res.data.choices, { 'Carol Jones': 'Filet Mignon', 'Sam Plus': 'North Atlantic Salmon' });
    assert.equal(res.data.complete, true);
  });

  test('only people coming to the reception are asked (not ceremony-only members of the party)', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: ['Alice Smith', 'Bob Smith'], reception: ['Bob Smith'] });
    assert.deepEqual(menu(env, 0).data.people, ['Bob Smith']);
    assert.equal(meal(env, 0, { 'Alice Smith': 'Filet Mignon', 'Bob Smith': 'Filet Mignon' }).error, 'unknown_guest');
  });

  test('every reception guest must choose, and only from the menu', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith', 'Bob Smith'] });
    assert.equal(meal(env, 0, { 'Alice Smith': 'Filet Mignon' }).error, 'meal_missing');
    assert.match(meal(env, 0, { 'Alice Smith': 'Filet Mignon' }).message, /Bob Smith/);
    assert.equal(meal(env, 0, { 'Alice Smith': 'Pizza', 'Bob Smith': 'Filet Mignon' }).error, 'bad_request');
    assert.equal(meal(env, 0, { 'Alice Smith': 7, 'Bob Smith': 'Filet Mignon' }).error, 'bad_request');
    assert.equal(apiPost(env, { action: 'meal', code: env.code(0), choices: 'all salmon' }).error, 'bad_request');
    assert.equal(env.row(0)['Meal Choices'], '');
  });

  test('dietary notes are optional, tidied, capped and can never become a formula', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith'] });
    assert.equal(meal(env, 0, { 'Alice Smith': 'Filet Mignon' }).ok, true);
    assert.equal(env.row(0)['Dietary Notes'], '');
    meal(env, 0, { 'Alice Smith': 'Filet Mignon' }, '  gluten free\n\nno nuts  ');
    assert.equal(env.row(0)['Dietary Notes'], 'gluten free no nuts');
    meal(env, 0, { 'Alice Smith': 'Filet Mignon' }, '=IMPORTXML("x")');
    const col = env.sheet.rows()[0].indexOf('Dietary Notes') + 1;
    assert.equal(env.sheet.getRange(2, col).getFormula(), '');
    meal(env, 0, { 'Alice Smith': 'Filet Mignon' }, 'x'.repeat(2000));
    assert.equal(env.row(0)['Dietary Notes'].length, 500);
    assert.equal(meal(env, 0, { 'Alice Smith': 'Filet Mignon' }, { evil: true }).error, 'bad_request');
  });

  test('changing meals replaces the old choices, and the menu remembers them', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith', 'Bob Smith'] });
    meal(env, 0, { 'Alice Smith': 'Filet Mignon', 'Bob Smith': 'Filet Mignon' });
    meal(env, 0, { 'Alice Smith': 'North Atlantic Salmon', 'Bob Smith': 'Filet Mignon' }, 'none');
    assert.equal(env.row(0)['Meal Choices'], 'Alice Smith: North Atlantic Salmon; Bob Smith: Filet Mignon');
    const d = menu(env, 0).data;
    assert.deepEqual(d.choices, { 'Alice Smith': 'North Atlantic Salmon', 'Bob Smith': 'Filet Mignon' });
    assert.equal(d.notes, 'none');
  });

  test('if someone drops the reception later, their meal is removed', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith', 'Bob Smith'] });
    meal(env, 0, { 'Alice Smith': 'Filet Mignon', 'Bob Smith': 'North Atlantic Salmon' });
    rsvp(env, 0, { ceremony: [], reception: ['Bob Smith'] });
    assert.equal(env.row(0)['Meal Choices'], 'Bob Smith: North Atlantic Salmon');
    const d = menu(env, 0).data;
    assert.deepEqual(d.people, ['Bob Smith']);
    assert.equal(d.complete, true);
  });

  test('someone newly added to the reception shows up without a meal, so the menu asks again', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: [], reception: ['Bob Smith'] });
    meal(env, 0, { 'Bob Smith': 'North Atlantic Salmon' });
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith', 'Bob Smith'] });
    const d = menu(env, 0).data;
    assert.deepEqual(d.choices, { 'Bob Smith': 'North Atlantic Salmon' });
    assert.equal(d.complete, false);
  });

  test('the meal deadline closes changes', () => {
    const env = setup({ settings: { ...SETTINGS, 'Meal Deadline': '2001-01-01' } });
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith'] });
    assert.equal(meal(env, 0, { 'Alice Smith': 'Filet Mignon' }).error, 'closed');
    assert.equal(menu(env, 0).data.deadline.open, false);
  });

  test('the meal options come from the Settings tab', () => {
    const env = setup({ settings: { ...SETTINGS, 'Meal Options': 'Chicken / Fish / Vegetarian Risotto' } });
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith'] });
    assert.deepEqual(menu(env, 0).data.options, ['Chicken', 'Fish', 'Vegetarian Risotto']);
    assert.equal(meal(env, 0, { 'Alice Smith': 'vegetarian risotto' }).ok, true);
    assert.equal(env.row(0)['Meal Choices'], 'Alice Smith: Vegetarian Risotto');
  });

  test('wrong codes on the meal page count toward the guessing limit', () => {
    const env = setup();
    for (let i = 0; i < 60; i++) apiGet(env, { action: 'meal', code: `NOPE${i}XX` });
    assert.equal(menu(env, 0).error, 'rate_limited');
  });

  test('meal saves are recorded in the RSVP Log', () => {
    const env = setup();
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith'] });
    meal(env, 0, { 'Alice Smith': 'Filet Mignon' }, 'no nuts');
    const log = env.ss.getSheetByName('RSVP Log').objects();
    assert.equal(log.at(-1).Status, 'Meal choices');
    assert.equal(log.at(-1).Ceremony, 'Alice Smith: Filet Mignon');
  });

  test('the Summary counts each meal and who still needs to choose', () => {
    const env = setup();
    const summary = env.ss.getSheetByName('Summary');
    const rows = summary.rows();
    const find = (label) => rows.findIndex((r) => r[0] === label) + 1;
    const cols = env.sheet.rows()[0];
    const L = String.fromCharCode(65 + cols.indexOf('Meal Choices'));
    assert.ok(find('Meals: North Atlantic Salmon') > 0);
    assert.equal(summary.getRange(find('Meals: Filet Mignon'), 2).getFormula(),
      `=SUMPRODUCT((LEN('Guests'!${L}2:${L})-LEN(SUBSTITUTE('Guests'!${L}2:${L},": Filet Mignon","")))/LEN(": Filet Mignon"))`);
    assert.match(summary.getRange(find('Reception guests who still need to choose a meal'), 2).getFormula(), /^=SUMPRODUCT\(.*'Guests'!H2:H.*\)-SUMPRODUCT\(.*";".*\)$/);
    // The formulas' logic, checked in JS: count ": <meal>" occurrences, and entries split by ";".
    rsvp(env, 0, { ceremony: [], reception: ['Alice Smith', 'Bob Smith'] });
    rsvp(env, 1, { ceremony: [], reception: ['Carol Jones'] });
    meal(env, 0, { 'Alice Smith': 'Filet Mignon', 'Bob Smith': 'North Atlantic Salmon' });
    const all = env.sheet.objects().map((r) => String(r['Meal Choices'])).join('|');
    assert.equal(all.split(': Filet Mignon').length - 1, 1);
    assert.equal(all.split(': North Atlantic Salmon').length - 1, 1);
  });
});

/* ------------------------------------------------------------------ */
describe('photo sharing', () => {
  // A tiny stand-in for a JPEG: the server only checks it starts like one.
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake photo bytes for testing')]).toString('base64');
  const photoCode = (env) => env.gs.readSettings_(env.c)['Photo Code'];
  // Uploads come from one test phone, and the list is asked for from that phone, so it shows
  // that phone's own photos (all anyone gets back before the album is published).
  const PHONE = 'test-phone-0001';
  const upload = (env, extra = {}) => apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, device: PHONE, ...extra });
  const list = (env, code = photoCode(env), device = PHONE) => apiGet(env, { action: 'photos', t: code, device });
  const photoRows = (env) => env.ss.getSheetByName('Photos').objects();

  test('setup makes a Photos tab, a secret photo code and the photo links', () => {
    const env = setup();
    assert.deepEqual(env.ss.getSheetByName('Photos').rows()[0],
      ['Uploaded At', 'Taken At', 'From', 'Caption', 'Table', 'Hidden', 'Preview', 'Photo', 'File ID', 'Width', 'Height', 'Upload ID', 'Uploader ID', 'Album Status', 'Type', 'Filter', 'Seconds', 'Still File ID']);
    const s = env.gs.readSettings_(env.c);
    assert.match(s['Photo Code'], /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    assert.equal(s['Photo Page Link'], `https://stephanieandrobert.test/photos/?t=${s['Photo Code']}`);
    assert.equal(s['Photo Slideshow Link'], `https://stephanieandrobert.test/photos/slideshow.html?t=${s['Photo Code']}`);
    assert.equal(s['Photo Table Cards Link'], `https://stephanieandrobert.test/photos/cards.html?t=${s['Photo Code']}`);
    // Running it again keeps the same code.
    env.gs.setupSheets_(env.c);
    env.gs.generateCodes_(env.c);
    assert.equal(photoCode(env), s['Photo Code']);
  });

  test('changing the Site URL or clearing the code updates the links', () => {
    const env = setup();
    const old = photoCode(env);
    setSettings(env, { 'Site URL': 'https://new.test', 'Photo Code': '' });
    env.gs.generateCodes_(env.c);
    const s = env.gs.readSettings_(env.c);
    assert.notEqual(s['Photo Code'], old);
    assert.equal(s['Photo Page Link'], `https://new.test/photos/?t=${s['Photo Code']}`);
    assert.equal(list(env, old).error, 'not_found');
  });

  test('the timeline needs the photo code; invitation codes and guesses do not work', () => {
    const env = setup();
    assert.equal(list(env, 'WRONGONE').error, 'not_found');
    assert.equal(list(env, env.code(0)).error, 'not_found');
    assert.equal(list(env, '').error, 'bad_request');
    const res = list(env, photoCode(env).toLowerCase());
    assert.equal(res.ok, true);
    assert.deepEqual(res.data.photos, []);
    assert.equal(res.data.uploads.open, true);
  });

  test('wrong photo codes count toward the brute-force limit', () => {
    const env = setup();
    for (let i = 0; i < 60; i++) list(env, `WRONG${i}`);
    assert.equal(list(env).error, 'rate_limited');
    assert.equal(upload(env).error, 'rate_limited');
  });

  test('an upload is saved to a shared Drive folder and listed on the timeline', () => {
    const env = setup();
    const now = Date.now();
    const res = upload(env, { from: 'Aunt Sue', caption: 'First dance!', table: '7', takenAt: new Date(now - 3600e3).toISOString(), width: 3000, height: 2000, uploadId: 'u-1' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.duplicate, false);
    const folderUrl = env.gs.readSettings_(env.c)['Photo Folder'];
    assert.match(folderUrl, /^https:\/\/drive\.google\.com\/drive\/folders\//);
    assert.equal(env.drive.folders.size, 1);
    const [folder] = env.drive.folders.values();
    assert.equal(folder.name, 'Stephanie & Robert — Wedding Photos');
    const [file] = env.drive.files.values();
    assert.equal(file.folder, folder.id);
    assert.equal(file.contentType, 'image/jpeg');
    assert.deepEqual(file.sharing, { access: 'ANYONE_WITH_LINK', permission: 'VIEW' });
    assert.equal(file.bytes.toString('base64'), JPEG);
    assert.match(file.name, /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2} Aunt Sue\.jpg$/);
    assert.equal(file.description, 'First dance!');

    const [row] = photoRows(env);
    assert.equal(row.From, 'Aunt Sue');
    assert.equal(row.Caption, 'First dance!');
    assert.equal(row.Table, 7); // Sheets turns "7" into a number
    assert.equal(row.Hidden, false);
    assert.equal(row['File ID'], file.id);
    assert.equal(row.Photo, file.getUrl());
    assert.equal(row['Taken At'].getTime(), now - 3600e3);
    assert.ok(row['Uploaded At'] instanceof Date);
    assert.equal(row.Width, 3000);
    const formula = env.ss.getSheetByName('Photos').getRange(2, 7).getFormula();
    assert.equal(formula, `=IMAGE("https://drive.google.com/thumbnail?id=${file.id}&sz=w200")`);

    const { photos } = list(env).data;
    assert.equal(photos.length, 1);
    assert.deepEqual(photos[0], {
      id: file.id, w: 3000, h: 2000, takenAt: new Date(now - 3600e3).toISOString(), uploadedAt: row['Uploaded At'].toISOString(),
      from: 'Aunt Sue', caption: 'First dance!', table: '7', kind: 'photo', filter: '',
    });
    assert.deepEqual(res.data.photo, photos[0]);
  });

  test('a second upload reuses the same folder; the timeline is in the order photos were taken', () => {
    const env = setup();
    const t = Date.now();
    upload(env, { from: 'Late', takenAt: new Date(t - 1000).toISOString() });
    upload(env, { from: 'Early', takenAt: new Date(t - 5000).toISOString() });
    upload(env, { from: 'No time' });
    assert.equal(env.drive.folders.size, 1);
    assert.deepEqual(list(env).data.photos.map((p) => p.from), ['Early', 'Late', 'No time']);
  });

  test('before the album is published, nobody sees anyone else’s photos', () => {
    const env = setup();
    upload(env, { from: 'Mine', device: 'phone-aaaa-1111' });
    upload(env, { from: 'Theirs', device: 'phone-bbbb-2222' });
    upload(env, { from: 'No phone id', device: '' });
    const seen = (device) => list(env, photoCode(env), device).data.photos.map((p) => p.from);
    assert.deepEqual(seen('phone-aaaa-1111'), ['Mine']);
    assert.deepEqual(seen('phone-bbbb-2222'), ['Theirs']);
    // No phone id (like the slideshow) or a made-up one: nothing at all.
    assert.deepEqual(seen(''), []);
    assert.deepEqual(seen('phone-zzzz-9999'), []);
    assert.deepEqual(apiGet(env, { action: 'photos', t: photoCode(env) }).data.photos, []);
    // Publishing opens the album to everyone, minus what the couple hid.
    env.ss.getSheetByName('Photos').getRange(3, 6).setValue(true);
    env.gs.publishAlbum_(env.c, new Date());
    assert.deepEqual(seen('').sort(), ['Mine', 'No phone id']);
    assert.deepEqual(seen('phone-bbbb-2222').sort(), ['Mine', 'No phone id']);
  });

  test('a retried upload (same upload id) is only saved once', () => {
    const env = setup();
    const a = upload(env, { uploadId: 'abc-123' });
    const b = upload(env, { uploadId: 'abc-123' });
    assert.equal(b.data.duplicate, true);
    assert.equal(b.data.photo.id, a.data.photo.id);
    assert.equal(photoRows(env).length, 1);
    assert.equal(env.drive.files.size, 1);
  });

  test('ticking Hidden takes a photo off the timeline', () => {
    const env = setup();
    upload(env, { from: 'Keep' });
    upload(env, { from: 'Hide me' });
    const sheet = env.ss.getSheetByName('Photos');
    sheet.getRange(3, 6).setValue(true);
    assert.deepEqual(list(env).data.photos.map((p) => p.from), ['Keep']);
    sheet.getRange(3, 6).setValue(false);
    assert.equal(list(env).data.photos.length, 2);
  });

  test('deleting a row takes the photo off; rows without a file are ignored', () => {
    const env = setup();
    upload(env, { from: 'One' });
    env.ss.getSheetByName('Photos').appendRow(['', '', 'Typed by hand']);
    assert.deepEqual(list(env).data.photos.map((p) => p.from), ['One']);
  });

  test('only JPEG photos are accepted, and not too large', () => {
    const env = setup();
    assert.equal(upload(env, { data: Buffer.from('<svg onload=alert(1)>').toString('base64') }).error, 'bad_photo');
    assert.equal(upload(env, { data: '/9j/not base64!!' }).error, 'bad_photo');
    assert.equal(upload(env, { data: '' }).error, 'bad_request');
    assert.equal(upload(env, { data: 42 }).error, 'bad_request');
    assert.equal(upload(env, { data: '/9j/' + 'A'.repeat(15 * 1024 * 1024) }).error, 'too_large');
    assert.equal(upload(env, { data: `data:image/jpeg;base64,${JPEG}` }).ok, true);
    assert.equal(env.drive.files.size, 1);
  });

  test('a big upload is fine, but other requests stay small', () => {
    const env = setup();
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3 * 1024 * 1024, 7)]).toString('base64');
    assert.equal(upload(env, { data: big }).ok, true);
    const res = apiPost(env, { action: 'rsvp', code: env.code(0), attendance: { ceremony: [], reception: [] }, pad: 'x'.repeat(20000) });
    assert.equal(res.error, 'bad_request');
  });

  test('names, captions and tables are cleaned and cannot become formulas', () => {
    const env = setup();
    const res = upload(env, { from: '=HYPERLINK("http://evil")', caption: '  multi\nline\tcaption  ', table: '<b>12</b>' });
    assert.equal(res.ok, true);
    const [row] = photoRows(env);
    assert.equal(row.From, '=HYPERLINK("http://evil")'); // stored as text, not a formula
    assert.equal(env.ss.getSheetByName('Photos').getRange(2, 3).getFormula(), '');
    assert.equal(row.Caption, 'multi line caption');
    assert.equal(row.Table, 'b12b');
    assert.equal(upload(env, { from: 'x'.repeat(500) }).data.photo.from.length, 60);
    assert.equal(upload(env, { caption: 'y'.repeat(900) }).data.photo.caption.length, 200);
  });

  test('impossible "taken at" times fall back to the upload time', () => {
    const env = setup();
    const future = upload(env, { takenAt: new Date(Date.now() + 86400e3).toISOString() }).data.photo;
    assert.equal(future.takenAt, future.uploadedAt);
    const junk = upload(env, { takenAt: 'yesterday-ish' }).data.photo;
    assert.equal(junk.takenAt, junk.uploadedAt);
    const ancient = upload(env, { takenAt: '1970-01-01T00:00:00Z' }).data.photo;
    assert.equal(ancient.takenAt, ancient.uploadedAt);
    const throwback = upload(env, { takenAt: '2015-07-04T12:00:00.000Z' }).data.photo;
    assert.equal(throwback.takenAt, '2015-07-04T12:00:00.000Z');
  });

  test('uploads close after "Photo Uploads Until", but the timeline stays open', () => {
    const env = setup();
    upload(env, { from: 'Before' });
    setSettings(env, { 'Photo Uploads Until': '2000-01-01' });
    const res = upload(env);
    assert.equal(res.error, 'closed');
    assert.match(res.message, /January 1, 2000/);
    const data = list(env).data;
    assert.equal(data.photos.length, 1);
    assert.deepEqual(data.uploads, { open: false, until: '2000-01-01', untilText: 'January 1, 2000' });
  });

  test('a pasted Photo Folder link is used; a broken one gives a clear message', () => {
    const env = setup();
    const mine = env.gs.DriveApp.createFolder('Our own folder');
    setSettings(env, { 'Photo Folder': `https://drive.google.com/drive/u/0/folders/${mine.getId()}?usp=sharing` });
    upload(env);
    const [file] = env.drive.files.values();
    assert.equal(file.folder, mine.getId());
    setSettings(env, { 'Photo Folder': 'https://drive.google.com/drive/folders/DOESNOTEXIST123' });
    assert.equal(upload(env).error, 'setup');
  });

  test('if Drive refuses to share the file, the photo is still saved', () => {
    const env = setup();
    env.drive.failSharing = true;
    assert.equal(upload(env).ok, true);
    assert.equal(photoRows(env).length, 1);
    assert.match(env.logs.errors.join('\n'), /Could not share photo/);
  });

  test('photos work before "Set up sheets" adds the Photos tab', () => {
    const env = setup();
    env.ss.deleteSheet(env.ss.getSheetByName('Photos'));
    assert.deepEqual(list(env).data.photos, []);
    assert.equal(upload(env, { from: 'First' }).ok, true);
    assert.equal(photoRows(env)[0].From, 'First');
  });

  test('the Summary counts shared and hidden photos', () => {
    const env = setup();
    const summary = env.ss.getSheetByName('Summary');
    const labels = summary.rows().map((r) => r[0]);
    const find = (label) => labels.indexOf(label) + 1;
    assert.equal(summary.getRange(find('Photos shared'), 2).getFormula(), `=COUNTA('Photos'!I2:I)-COUNTIF('Photos'!O2:O,"Video")`);
    assert.equal(summary.getRange(find('Videos shared'), 2).getFormula(), `=COUNTIF('Photos'!O2:O,"Video")`);
    assert.equal(summary.getRange(find('Photos hidden'), 2).getFormula(), "=COUNTIF('Photos'!F2:F,TRUE)");
  });

  test('the menu shows the photo links and makes the Drive folder', () => {
    const env = setup();
    env.gs.menuPhotoLinks();
    assert.equal(env.drive.folders.size, 1);
    const msg = env.ui.alerts.at(-1);
    assert.match(msg, /photos\/cards\.html\?t=/);
    assert.match(msg, /photos\/slideshow\.html\?t=/);
    assert.match(msg, /drive\.google\.com\/drive\/folders\//);
    env.gs.onOpen();
    assert.ok(env.ui.menus.at(-1).items.some(([, fn]) => fn === 'menuPhotoLinks'));
  });

  test('Set up sheets from the menu makes the folder once', () => {
    const env = setup();
    env.gs.menuSetup();
    env.gs.menuSetup();
    assert.equal(env.drive.folders.size, 1);
  });
});

/* ------------------------------------------------------------------ */
describe('reception guests: emails, personal cameras and the album', () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake photo bytes')]).toString('base64');
  const photoCode = (env) => env.gs.readSettings_(env.c)['Photo Code'];
  const upload = (env, extra = {}) => apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, ...extra });
  const list = (env, extra = {}) => apiGet(env, { action: 'photos', t: photoCode(env), ...extra });
  const saveMeals = (env, i, choices, emails, extra = {}) => apiPost(env, { action: 'meal', code: env.code(i), choices, emails, ...extra });
  const me = (env, i, name) => env.gs.cameraLink_(env.gs.readSettings_(env.c), env.code(i), name).split('me=')[1];
  const ALL_FISH = { 'Alice Smith': 'North Atlantic Salmon', 'Bob Smith': 'Filet Mignon' };

  // Alice & Bob (row 0) and Carol (row 1) come to the reception; the Browns (row 2) are ceremony only.
  function ready(settings = {}) {
    const env = setup({ settings: { ...SETTINGS, ...settings } });
    rsvp(env, 0, { ceremony: ['Alice Smith', 'Bob Smith'], reception: ['Alice Smith', 'Bob Smith'] });
    rsvp(env, 1, { ceremony: ['Carol Jones'], reception: ['Carol Jones'] });
    rsvp(env, 2, { ceremony: ['Dan Brown'] });
    return env;
  }

  test('the meal page saves an email for each reception guest', () => {
    const env = ready();
    const res = saveMeals(env, 0, ALL_FISH, { 'Alice Smith': ' Alice@Example.com ', 'Bob Smith': 'bob@example.com', 'Dan Brown': 'dan@example.com' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(env.row(0)['Guest Emails'], 'Alice Smith: alice@example.com; Bob Smith: bob@example.com');
    assert.deepEqual(res.data.emails, { 'Alice Smith': 'alice@example.com', 'Bob Smith': 'bob@example.com' });
    assert.deepEqual(apiGet(env, { action: 'meal', code: env.code(0) }).data.emails, res.data.emails);
    // Clearing one removes it; leaving one out keeps it.
    saveMeals(env, 0, ALL_FISH, { 'Bob Smith': '' });
    assert.equal(env.row(0)['Guest Emails'], 'Alice Smith: alice@example.com');
  });

  test('emails are optional, and a typo is caught without saving anything', () => {
    const env = ready();
    assert.equal(saveMeals(env, 1, { 'Carol Jones': 'Filet Mignon' }).ok, true);
    assert.equal(env.row(1)['Guest Emails'], '');
    const bad = saveMeals(env, 1, { 'Carol Jones': 'North Atlantic Salmon' }, { 'Carol Jones': 'carol@example' });
    assert.equal(bad.error, 'bad_email');
    assert.match(bad.message, /Carol Jones/);
    assert.equal(env.row(1)['Meal Choices'], 'Carol Jones: Filet Mignon');
    assert.equal(saveMeals(env, 1, { 'Carol Jones': 'Filet Mignon' }, ['carol@example.com']).error, 'bad_request');
  });

  test('an email typed as a formula is stored as text', () => {
    const env = ready();
    saveMeals(env, 1, { 'Carol Jones': 'Filet Mignon' }, { 'Carol Jones': '=evil@example.com' });
    assert.equal(env.sheet.getRange(3, env.sheet.rows()[0].indexOf('Guest Emails') + 1).getFormula(), '');
  });

  test('each reception guest gets a personal camera link that knows who they are', () => {
    const env = ready();
    const link = env.gs.cameraLink_(env.gs.readSettings_(env.c), env.code(0), 'Alice Smith');
    assert.match(link, new RegExp(`^https://stephanieandrobert\\.test/photos/\\?t=${photoCode(env)}&me=${env.code(0)}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$`));
    assert.notEqual(me(env, 0, 'Alice Smith'), me(env, 0, 'Bob Smith'));
    const you = list(env, { me: me(env, 0, 'Alice Smith') }).data.you;
    assert.deepEqual(you, { limit: 50, used: 0, left: 50, name: 'Alice Smith', videos: { limit: 10, used: 0, left: 10, seconds: 30 } });
    // Made-up or ceremony-only links are just anonymous.
    assert.equal(list(env, { me: `${env.code(0)}-ZZZZZZ` }).data.you.name, '');
    assert.equal(list(env, { me: me(env, 2, 'Dan Brown') }).data.you.name, '');
    assert.equal(list(env, { me: 'garbage' }).ok, true);
  });

  test('each camera can share up to "Photos Per Person" photos, hidden ones included', () => {
    const env = ready({ 'Photos Per Person': 2 });
    const alice = me(env, 0, 'Alice Smith');
    assert.equal(upload(env, { me: alice }).data.you.left, 1);
    const second = upload(env, { me: alice });
    assert.deepEqual(second.data.you, { limit: 2, used: 2, left: 0, name: 'Alice Smith', videos: { limit: 10, used: 0, left: 10, seconds: 30 } });
    const third = upload(env, { me: alice });
    assert.equal(third.error, 'limit_reached');
    assert.match(third.message, /all 2 of your photos/);
    // Bob has his own allowance; hiding a photo doesn't give a shot back.
    assert.equal(upload(env, { me: me(env, 0, 'Bob Smith') }).ok, true);
    env.ss.getSheetByName('Photos').getRange(2, 6).setValue(true);
    assert.equal(upload(env, { me: alice }).error, 'limit_reached');
    assert.equal([...env.drive.files.values()].filter((f) => !f.trashed).length, 3);
  });

  test('table-card scans are counted per phone', () => {
    const env = ready({ 'Photos Per Person': 1 });
    assert.equal(upload(env, { device: 'phone-aaaaaaaa' }).ok, true);
    assert.equal(upload(env, { device: 'phone-aaaaaaaa' }).error, 'limit_reached');
    assert.equal(upload(env, { device: 'phone-bbbbbbbb' }).ok, true);
    assert.deepEqual(list(env, { device: 'phone-aaaaaaaa' }).data.you, { limit: 1, used: 1, left: 0, name: '', videos: { limit: 10, used: 0, left: 10, seconds: 30 } });
    // A blank Photos Per Person means no limit.
    setSettings(env, { 'Photos Per Person': '' });
    assert.equal(upload(env, { device: 'phone-aaaaaaaa' }).ok, true);
    assert.equal(list(env).data.you.limit, null);
  });

  test("a personal camera fills in the guest's name", () => {
    const env = ready();
    const res = upload(env, { me: me(env, 1, 'Carol Jones') });
    assert.equal(res.data.photo.from, 'Carol Jones');
    assert.equal(env.ss.getSheetByName('Photos').objects()[0]['Uploader ID'], `p:${me(env, 1, 'Carol Jones')}`);
    assert.equal(upload(env, { me: me(env, 1, 'Carol Jones'), from: 'Aunt Carol' }).data.photo.from, 'Aunt Carol');
  });

  test('camera emails are due from "Camera Email Days Before" through the wedding day', () => {
    const env = ready();
    const s = () => env.gs.readSettings_(env.c);
    const due = (d) => env.gs.cameraEmailDue_(s(), d);
    assert.equal(due(new Date(2099, 5, 2, 23, 0)), false);
    assert.equal(due(new Date(2099, 5, 3, 9, 0)), true);
    assert.equal(due(new Date(2099, 5, 6, 20, 0)), true);
    assert.equal(due(new Date(2099, 5, 7, 9, 0)), false);
    setSettings(env, { 'Camera Email Days Before': '' });
    assert.equal(due(new Date(2099, 5, 4)), false);
    setSettings(env, { 'Camera Email Days Before': 3, 'Ceremony Date': '' });
    assert.equal(due(new Date(2099, 5, 4)), false);
  });

  test('camera emails go once to each address, with each person\'s own link', () => {
    const env = ready();
    saveMeals(env, 0, ALL_FISH, { 'Alice Smith': 'smiths@example.com', 'Bob Smith': 'smiths@example.com' });
    saveMeals(env, 1, { 'Carol Jones': 'Filet Mignon' }, { 'Carol Jones': 'carol@example.com' });
    const r = env.gs.sendCameraEmails_(env.c);
    assert.deepEqual(r, { emails: 2, people: 3, quotaHit: false });
    const smiths = env.mail.sent.find((m) => m.to === 'smiths@example.com');
    assert.equal(smiths.subject, 'Your camera for our wedding');
    assert.ok(smiths.htmlBody.includes(`me=${me(env, 0, 'Alice Smith')}`));
    assert.ok(smiths.htmlBody.includes(`me=${me(env, 0, 'Bob Smith')}`));
    assert.match(smiths.htmlBody, /OPEN ALICE&#39;S CAMERA/);
    assert.match(smiths.body, /up to 50 photos and 10 short videos each/);
    assert.equal(env.row(0)['Camera Emails Sent'], 'smiths@example.com');
    // Running again sends nothing new; a new address gets its own.
    assert.equal(env.gs.sendCameraEmails_(env.c).emails, 0);
    saveMeals(env, 0, ALL_FISH, { 'Bob Smith': 'bob@example.com' });
    assert.equal(env.gs.sendCameraEmails_(env.c).emails, 1);
    assert.equal(env.mail.sent.at(-1).to, 'bob@example.com');
    assert.ok(!env.mail.sent.some((m) => /dan/i.test(m.to)));
  });

  test('test camera emails are the real email, sent to the addresses typed, and not marked as sent', () => {
    const env = ready();
    saveMeals(env, 0, ALL_FISH, { 'Alice Smith': 'smiths@example.com', 'Bob Smith': 'smiths@example.com' });
    // Cancelling sends nothing.
    env.gs.menuSendTestCameraEmails();
    assert.equal(env.mail.sent.length, 0);
    env.ui.nextPrompt = { button: 'OK', text: ' Smiths@Example.com, stranger@example.com; smiths@example.com, not-an-email ' };
    env.gs.menuSendTestCameraEmails();
    assert.deepEqual(env.mail.sent.map((m) => m.to), ['smiths@example.com', 'stranger@example.com']);
    const [smiths, stranger] = env.mail.sent;
    // Exactly what the Smiths get before the wedding: same subject, both personal cameras.
    const real = env.gs.buildCameraEmail_(['Alice Smith', 'Bob Smith'].map((n) => ({ name: n, link: env.gs.cameraLink_(env.gs.readSettings_(env.c), env.code(0), n) })), env.gs.readSettings_(env.c));
    assert.equal(smiths.subject, 'Your camera for our wedding');
    assert.equal(smiths.htmlBody, real.html);
    assert.ok(smiths.htmlBody.includes(`me=${me(env, 0, 'Alice Smith')}`));
    // Someone not on the list gets the shared photo page.
    assert.ok(stranger.htmlBody.includes(`/photos/?t=${photoCode(env)}"`));
    assert.ok(!stranger.htmlBody.includes('me='));
    assert.match(env.ui.alerts.at(-1), /smiths@example\.com \(Alice Smith, Bob Smith's camera\)/);
    // Not marked as sent, so the real one still goes out on the day.
    assert.equal(env.row(0)['Camera Emails Sent'], '');
    assert.equal(env.gs.sendCameraEmails_(env.c).emails, 1);
    env.gs.onOpen();
    assert.ok(env.ui.menus.at(-1).items.some(([, fn]) => fn === 'menuSendTestCameraEmails'));
  });

  test('camera emails stop at the daily limit and pick up where they left off', () => {
    const env = ready();
    saveMeals(env, 0, ALL_FISH, { 'Alice Smith': 'alice@example.com', 'Bob Smith': 'bob@example.com' });
    saveMeals(env, 1, { 'Carol Jones': 'Filet Mignon' }, { 'Carol Jones': 'carol@example.com' });
    env.mail.quota = 1;
    assert.deepEqual(env.gs.sendCameraEmails_(env.c), { emails: 1, people: 1, quotaHit: true });
    env.mail.quota = 100;
    assert.equal(env.gs.sendCameraEmails_(env.c).emails, 2);
    assert.deepEqual(env.mail.sent.map((m) => m.to).sort(), ['alice@example.com', 'bob@example.com', 'carol@example.com']);
  });

  test('once camera links have gone out, adding an email on the meal page sends one right away', () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const env = ready({ 'Ceremony Date': key, 'Camera Email Days Before': 3 });
    saveMeals(env, 1, { 'Carol Jones': 'Filet Mignon' }, { 'Carol Jones': 'carol@example.com' });
    assert.equal(env.mail.sent.filter((m) => m.to === 'carol@example.com').length, 1);
    saveMeals(env, 1, { 'Carol Jones': 'Filet Mignon' }, { 'Carol Jones': 'carol@example.com' });
    assert.equal(env.mail.sent.filter((m) => m.to === 'carol@example.com').length, 1);
  });

  test('Set up sheets installs one daily trigger, and it sends camera links when due', () => {
    const env = ready();
    env.gs.menuSetup();
    env.gs.menuSetup();
    assert.equal(env.triggers.length, 1);
    assert.equal(env.triggers[0].handler, 'dailyTasks');
    assert.equal(env.triggers[0].atHour, 9);
    saveMeals(env, 1, { 'Carol Jones': 'Filet Mignon' }, { 'Carol Jones': 'carol@example.com' });
    env.gs.dailyTasks(); // not due yet (the test wedding is far away)
    assert.equal(env.mail.sent.length, 0);
    const today = new Date();
    setSettings(env, { 'Ceremony Date': `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate() + 0).padStart(2, '0')}` });
    env.gs.dailyTasks();
    assert.equal(env.mail.sent.length, 1);
  });

  test('a test camera email goes only to you', () => {
    const env = ready();
    env.gs.menuSendTestCameraEmail();
    assert.equal(env.mail.sent.length, 1);
    assert.equal(env.mail.sent[0].to, 'owner@example.com');
    assert.match(env.mail.sent[0].subject, /^\[TEST\]/);
    assert.ok(!env.mail.sent[0].htmlBody.includes('me='));
  });

  test('publishing the album leaves out hidden photos, shares the folder, closes uploads and emails everyone', () => {
    const env = ready();
    saveMeals(env, 0, ALL_FISH, { 'Alice Smith': 'smiths@example.com', 'Bob Smith': 'smiths@example.com' });
    upload(env, { from: 'Keep' });
    upload(env, { from: 'Blurry' });
    const photos = env.ss.getSheetByName('Photos');
    photos.getRange(3, 6).setValue(true);
    const r = env.gs.publishAlbum_(env.c, new Date());
    assert.equal(r.leftOut, 1);
    const folder = [...env.drive.folders.values()].find((f) => f.name.endsWith('Wedding Photos'));
    const leftOut = [...env.drive.folders.values()].find((f) => /left out/.test(f.name));
    assert.deepEqual(folder.sharing, { access: 'ANYONE_WITH_LINK', permission: 'VIEW' });
    const [keep, blurry] = photos.objects().map((p) => env.drive.files.get(p['File ID']));
    assert.equal(keep.folder, folder.id);
    assert.equal(blurry.folder, leftOut.id);
    assert.deepEqual(blurry.sharing, { access: 'PRIVATE', permission: 'NONE' });
    assert.equal(photos.objects()[1]['Album Status'], 'Left out');
    // Uploads close; the page shows the album with a download link.
    assert.equal(upload(env).error, 'closed');
    const data = list(env).data;
    assert.equal(data.uploads.open, false);
    assert.deepEqual(data.album, { published: true, url: folder.getUrl() });
    assert.deepEqual(data.photos.map((p) => p.from), ['Keep']);
    // Everyone with an email gets the album once.
    assert.equal(r.mail.emails, 1);
    const mail = env.mail.sent.at(-1);
    assert.equal(mail.to, 'smiths@example.com');
    assert.equal(mail.subject, 'Our wedding photos are here!');
    assert.ok(mail.htmlBody.includes(folder.getUrl()));
    assert.equal(env.gs.publishAlbum_(env.c, new Date()).mail.emails, 0);
  });

  test('un-hiding a photo and publishing again puts it back in the album', () => {
    const env = ready();
    upload(env, { from: 'Second thoughts' });
    const photos = env.ss.getSheetByName('Photos');
    photos.getRange(2, 6).setValue(true);
    env.gs.publishAlbum_(env.c, new Date());
    photos.getRange(2, 6).setValue(false);
    const r = env.gs.publishAlbum_(env.c, new Date());
    assert.equal(r.restored, 1);
    const file = env.drive.files.get(photos.objects()[0]['File ID']);
    const folder = [...env.drive.folders.values()].find((f) => f.name.endsWith('Wedding Photos'));
    assert.equal(file.folder, folder.id);
    assert.deepEqual(file.sharing, { access: 'ANYONE_WITH_LINK', permission: 'VIEW' });
    assert.equal(photos.objects()[0]['Album Status'], '');
  });

  test('clearing "Photo Album Published" reopens photo sharing', () => {
    const env = ready();
    env.gs.publishAlbum_(env.c, new Date());
    assert.equal(upload(env).error, 'closed');
    setSettings(env, { 'Photo Album Published': '' });
    assert.equal(upload(env).ok, true);
  });

  test('the Summary counts emails, and the menu has the new items', () => {
    const env = ready();
    const labels = env.ss.getSheetByName('Summary').rows().map((r) => r[0]);
    for (const l of ['Reception guests with an email address', 'Camera links emailed (addresses)', 'Album emailed (addresses)']) assert.ok(labels.includes(l), l);
    env.gs.onOpen();
    const fns = env.ui.menus.at(-1).items.map(([, fn]) => fn);
    for (const fn of ['menuSendCameraEmails', 'menuSendTestCameraEmail', 'menuPublishAlbum']) assert.ok(fns.includes(fn), fn);
  });
});

/* ------------------------------------------------------------------ */
describe('videos, filters and the highlight builder', () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake still bytes')]).toString('base64');
  const PIECE = 256 * 1024;
  const GUEST = 9 * 256 * 1024; // the size of guests' video pieces
  const photoCode = (env) => env.gs.readSettings_(env.c)['Photo Code'];
  const reviewCode = (env) => env.gs.readSettings_(env.c)['Review Code'];
  const list = (env, extra = {}) => apiGet(env, { action: 'photos', t: photoCode(env), ...extra });
  const review = (env, k = reviewCode(env)) => apiGet(env, { action: 'review', k });
  const photoRows = (env) => env.ss.getSheetByName('Photos').objects();
  // A made-up "video": about 2.3 pieces of patterned bytes.
  const fakeVideo = (size = Math.round(GUEST * 2.3), seed = 7) => {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++) b[i] = (i * seed + (i >> 8)) & 255;
    return b;
  };

  // Sends a whole video the way the camera page does: start, pieces, finish.
  function sendVideo(env, bytes, { code = photoCode(env), k, ...extra } = {}) {
    const auth = k ? { k } : { code };
    const uploadId = extra.uploadId || `vid-${Math.random().toString(36).slice(2)}`;
    const start = apiPost(env, { action: 'video', step: 'start', ...auth, uploadId, mime: 'video/mp4', size: bytes.length, seconds: 12, device: 'phone-vvvv-0001', ...extra });
    if (!start.ok || start.data.complete) return start;
    const piece = start.data.chunkSize;
    let offset = start.data.received;
    while (offset < bytes.length) {
      const r = apiPost(env, { action: 'video', step: 'chunk', ...auth, uploadId, offset, data: bytes.subarray(offset, offset + piece).toString('base64') });
      if (!r.ok) return r;
      offset = r.data.received;
    }
    return apiPost(env, { action: 'video', step: 'finish', ...auth, uploadId, poster: JPEG });
  }

  test('a guest\'s video goes to Drive in pieces and gets a row, a still and its filter', () => {
    const env = setup();
    const bytes = fakeVideo();
    const res = sendVideo(env, bytes, { from: 'Aunt Sue', caption: 'Cake!', table: '4', filter: 'b&w', width: 720, height: 1280, seconds: 12.4 });
    assert.equal(res.ok, true, JSON.stringify(res));
    const video = [...env.drive.files.values()].find((f) => f.contentType === 'video/mp4');
    assert.ok(video.bytes.equals(bytes), 'the saved video is byte-for-byte what was recorded');
    const folder = env.drive.folders.get(video.folder);
    assert.equal(folder.name, 'Stephanie & Robert — Wedding Photos');
    assert.match(video.name, /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2} Aunt Sue\.mp4$/);
    assert.deepEqual(video.sharing, { access: 'ANYONE_WITH_LINK', permission: 'VIEW' });
    // The still lives in its own folder, so the album download is just photos and videos.
    const still = [...env.drive.files.values()].find((f) => f.contentType === 'image/jpeg');
    assert.equal(env.drive.folders.get(still.folder).name, 'Stephanie & Robert — Wedding Photos (video stills)');
    assert.match(env.gs.readSettings_(env.c)['Video Stills Folder'], /folders\//);
    const [row] = photoRows(env);
    assert.equal(row.Type, 'Video');
    assert.equal(row.Filter, 'B&W');
    assert.equal(row.Seconds, 12.4);
    assert.equal(row['Still File ID'], still.id);
    assert.equal(row['File ID'], video.id);
    assert.equal(env.ss.getSheetByName('Photos').getRange(2, 7).getFormula(), `=IMAGE("https://drive.google.com/thumbnail?id=${still.id}&sz=w200")`);
    assert.deepEqual(res.data.photo, {
      id: video.id, w: 720, h: 1280, takenAt: res.data.photo.takenAt, uploadedAt: res.data.photo.uploadedAt, from: 'Aunt Sue', caption: 'Cake!', table: '4',
      kind: 'video', filter: 'B&W', seconds: 12.4, poster: still.id,
    });
    assert.deepEqual(res.data.you.videos, { limit: 10, used: 1, left: 9, seconds: 30 });
    assert.equal(res.data.you.used, 0, 'videos don\'t use up photos');
    // Only that phone sees it before the album is published.
    assert.equal(list(env, { device: 'phone-vvvv-0001' }).data.photos[0].kind, 'video');
    assert.deepEqual(list(env, { device: 'phone-zzzz-9999' }).data.photos, []);
    // Nothing is left in the upload cache, and the pieces were thrown away.
    assert.equal([...env.cache.store.keys()].filter((k) => k.startsWith('upload:')).length, 0);
    const pieces = [...env.drive.files.values()].filter((f) => f.contentType === 'text/plain');
    assert.equal(pieces.length, 3);
    assert.ok(pieces.every((f) => f.trashed));
    assert.equal(env.drive.folders.get(pieces[0].folder).name, 'Stephanie & Robert — Wedding Photos (uploads in progress)');
    // Guests' videos never use Drive's separate upload service.
    assert.equal(env.drive.fetches.length, 0);
  });

  test('a piece that already arrived is skipped, a wrong-sized one is refused, and a lost reply isn\'t saved twice', () => {
    const env = setup();
    const bytes = fakeVideo();
    const uploadId = 'vid-retry-1';
    const base = { action: 'video', code: photoCode(env), uploadId };
    const start = apiPost(env, { ...base, step: 'start', mime: 'video/webm;codecs=vp9,opus', size: bytes.length, seconds: 9, device: 'phone-rrrr-0001' });
    assert.deepEqual(start.data, { chunkSize: GUEST, received: 0 });
    const piece = (offset, size = GUEST) => apiPost(env, { ...base, step: 'chunk', offset, data: bytes.subarray(offset, offset + size).toString('base64') });
    assert.equal(piece(0).data.received, GUEST);
    // The phone didn't hear back and sends the first piece again: told to carry on from GUEST.
    assert.deepEqual(piece(0).data, { received: GUEST, complete: false });
    // A piece of the wrong size (which couldn't be joined back up) is refused.
    assert.equal(piece(GUEST, GUEST - 3).error, 'bad_request');
    assert.equal(piece(GUEST).data.received, 2 * GUEST);
    // Finishing before the last piece arrives just asks for the rest.
    assert.equal(apiPost(env, { ...base, step: 'finish', poster: JPEG }).error, 'upload_incomplete');
    assert.deepEqual(piece(2 * GUEST).data, { received: bytes.length, complete: true });
    const done = apiPost(env, { ...base, step: 'finish', poster: JPEG });
    assert.equal(done.ok, true, JSON.stringify(done));
    // The reply to "finish" got lost, so the phone sends it again (or starts over).
    assert.equal(apiPost(env, { ...base, step: 'finish', poster: JPEG }).data.duplicate, true);
    assert.equal(apiPost(env, { ...base, step: 'start', mime: 'video/webm', size: bytes.length, device: 'phone-rrrr-0001' }).data.duplicate, true);
    assert.equal(photoRows(env).length, 1);
    const video = env.drive.files.get(done.data.photo.id);
    assert.equal(video.contentType, 'video/webm');
    assert.ok(video.bytes.equals(bytes));
  });

  test('pieces of videos that never finished are cleared out each morning', () => {
    const env = setup();
    const bytes = fakeVideo();
    const base = { action: 'video', code: photoCode(env), uploadId: 'vid-abandoned' };
    apiPost(env, { ...base, step: 'start', mime: 'video/mp4', size: bytes.length, device: 'phone-aaaa-0009' });
    apiPost(env, { ...base, step: 'chunk', offset: 0, data: bytes.subarray(0, GUEST).toString('base64') });
    const piece = [...env.drive.files.values()].find((f) => f.contentType === 'text/plain');
    env.gs.dailyTasks();
    assert.equal(piece.trashed, false, 'a fresh piece is kept (the guest may still be uploading)');
    piece.created = new Date(Date.now() - 25 * 3600e3); // a day later
    env.gs.dailyTasks();
    assert.equal(piece.trashed, true);
  });

  test('an upload that waited too long starts over cleanly', () => {
    const env = setup();
    const bytes = fakeVideo(PIECE + 10);
    const base = { action: 'video', code: photoCode(env), uploadId: 'vid-slow-1' };
    apiPost(env, { ...base, step: 'start', mime: 'video/mp4', size: bytes.length, device: 'phone-ssss-0001' });
    env.cache.advance(7 * 3600e3);
    const r = apiPost(env, { ...base, step: 'chunk', offset: 0, data: bytes.subarray(0, PIECE).toString('base64') });
    assert.equal(r.error, 'upload_expired');
    assert.equal(sendVideo(env, bytes, { uploadId: 'vid-slow-1', device: 'phone-ssss-0001' }).ok, true);
  });

  test('videos have their own allowance, length limit and file checks', () => {
    const env = setup({ settings: { ...SETTINGS, 'Videos Per Person': 1, 'Photos Per Person': 1, 'Video Seconds': 20 } });
    const small = fakeVideo(1000);
    assert.equal(sendVideo(env, small).ok, true);
    const second = sendVideo(env, small);
    assert.equal(second.error, 'limit_reached');
    assert.match(second.message, /all 1 of your videos/);
    // Photos are counted separately.
    const photo = apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, device: 'phone-vvvv-0001' });
    assert.equal(photo.ok, true, JSON.stringify(photo));
    assert.equal(photo.data.you.left, 0);
    assert.equal(photo.data.you.videos.left, 0);
    // Too long, too big, or not a video.
    assert.equal(sendVideo(env, small, { device: 'phone-other-01', seconds: 60 }).error, 'too_long');
    assert.equal(apiPost(env, { action: 'video', step: 'start', code: photoCode(env), uploadId: 'big-1', mime: 'video/mp4', size: 61 * 1024 * 1024 }).error, 'too_large');
    assert.equal(apiPost(env, { action: 'video', step: 'start', code: photoCode(env), uploadId: 'gif-1', mime: 'image/gif', size: 100 }).error, 'bad_video');
    // Pieces must be the right size (Drive needs multiples of 256 KB), and need the photo code.
    const bytes = fakeVideo(PIECE + 100);
    apiPost(env, { action: 'video', step: 'start', code: photoCode(env), uploadId: 'odd-1', mime: 'video/mp4', size: bytes.length, device: 'phone-odd-0001' });
    assert.equal(apiPost(env, { action: 'video', step: 'chunk', code: photoCode(env), uploadId: 'odd-1', offset: 0, data: bytes.subarray(0, 1000).toString('base64') }).error, 'bad_request');
    assert.equal(apiPost(env, { action: 'video', step: 'chunk', code: 'WRONGONE', uploadId: 'odd-1', offset: 0, data: 'AAAA' }).error, 'not_found');
    // "0" turns videos off; blank means no limit.
    setSettings(env, { 'Videos Per Person': 0 });
    assert.equal(sendVideo(env, small, { device: 'phone-new-0001' }).error, 'no_videos');
    setSettings(env, { 'Videos Per Person': '' });
    assert.equal(list(env).data.you.videos.limit, null);
  });

  test('uploads close for videos too once sharing ends or the album is published', () => {
    const env = setup({ settings: { ...SETTINGS, 'Photo Uploads Until': '2000-01-01' } });
    assert.equal(sendVideo(env, fakeVideo(1000)).error, 'closed');
  });

  test('photos keep their filter too, and the couple can change or clear it on the sheet', () => {
    const env = setup();
    const res = apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, filter: 'vintage', device: 'phone-ffff-0001' });
    assert.equal(res.data.photo.filter, 'Vintage');
    assert.equal(photoRows(env)[0].Type, 'Photo');
    assert.equal(apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, filter: '<script>', device: 'phone-ffff-0001' }).data.photo.filter, '');
    const sheet = env.ss.getSheetByName('Photos');
    const col = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf('Filter') + 1;
    sheet.getRange(2, col).setValue('Warm');
    assert.equal(list(env, { device: 'phone-ffff-0001' }).data.photos[0].filter, 'Warm');
    sheet.getRange(2, col).setValue('');
    assert.equal(list(env, { device: 'phone-ffff-0001' }).data.photos[0].filter, '');
  });

  test('only tacos and hearts are left of the silly filters', () => {
    const env = setup();
    const taco = apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, filter: 'taco rain', device: 'phone-fun-0001' });
    assert.equal(taco.data.photo.filter, 'Taco Rain');
    // The face filters were taken out: an old one on the sheet just shows the original.
    const old = apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, filter: 'Mustache', device: 'phone-fun-0001' });
    assert.equal(old.data.photo.filter, '');
    const sheet = env.ss.getSheetByName('Photos');
    const col = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf('Filter') + 1;
    sheet.getRange(2, col).setValue('Top Hat');
    assert.equal(list(env, { device: 'phone-fun-0001' }).data.photos[0].filter, '');
  });

  test('guests can remove what they shared, with their link or from the same phone, until the album is published', () => {
    const env = setup();
    env.gs.submitRsvp_(env.c, { action: 'rsvp', code: env.code(0), attendance: { ceremony: ['Alice Smith'], reception: ['Alice Smith', 'Bob Smith'] } }, new Date());
    const alice = env.gs.cameraLink_(env.gs.readSettings_(env.c), env.code(0), 'Alice Smith').split('me=')[1];
    const bob = env.gs.cameraLink_(env.gs.readSettings_(env.c), env.code(0), 'Bob Smith').split('me=')[1];
    const del = (extra) => apiPost(env, { action: 'delete', code: photoCode(env), ...extra });
    const photo = apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, me: alice, device: 'phone-alice-01' }).data.photo;
    const video = sendVideo(env, fakeVideo(1000), { me: alice, device: 'phone-alice-01' }).data.photo;
    const other = apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, device: 'phone-table-02' }).data.photo;
    // Someone else (another guest's link, another phone, a guess) can't.
    assert.equal(del({ id: photo.id, me: bob }).error, 'not_yours');
    assert.equal(del({ id: photo.id, device: 'phone-zzzz-9999' }).error, 'not_yours');
    assert.equal(del({ id: photo.id }).error, 'not_yours');
    assert.equal(del({ id: photo.id, code: 'WRONGONE', me: alice }).error, 'not_found');
    // Alice can, from her link on any phone. The file goes to the trash and she gets the shot back.
    const r = del({ id: photo.id, me: alice, device: 'phone-other-99' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.you.used, 0);
    assert.equal(env.drive.files.get(photo.id).trashed, true);
    assert.equal(del({ id: photo.id, me: alice }).error, 'not_found');
    // Her video (and its still) too.
    assert.equal(del({ id: video.id, me: alice }).data.you.videos.used, 0);
    assert.equal(env.drive.files.get(video.id).trashed, true);
    assert.equal(env.drive.files.get(video.poster).trashed, true);
    // A table-card guest can remove theirs from the same phone.
    assert.deepEqual(photoRows(env).map((row) => row['File ID']), [other.id]);
    // After the album is published, nothing can be removed from the page.
    env.gs.publishAlbum_(env.c, new Date());
    assert.equal(del({ id: other.id, device: 'phone-table-02' }).error, 'closed');
    assert.equal(photoRows(env).length, 1);
  });

  test('an unexpected error is written to an Error Log tab and its reason comes back', () => {
    const env = setup();
    const k = reviewCode(env);
    const photo = apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, device: 'phone-err-0001' }).data.photo;
    // Drive's download service failing (like a missing permission) falls back to reading the file.
    env.drive.throwFetch = true;
    const r = apiGet(env, { action: 'media', k, id: photo.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(Buffer.from(r.data.data, 'base64').toString('base64'), JPEG);
    const log = env.ss.getSheetByName('Error Log');
    assert.ok(log, 'the error was logged');
    assert.match(String(log.rows()[1][1]), /permission to call UrlFetchApp/);
    // Saving a highlight can't fall back, so the reason comes back to the page.
    const h = apiPost(env, { action: 'video', step: 'start', k, uploadId: 'hl-err', mime: 'video/mp4', size: 1000 });
    assert.equal(h.error, 'server_error');
    assert.match(h.detail, /permission to call UrlFetchApp/);
    assert.equal(log.rows().length, 3);
    // Guests' videos don't need it at all.
    assert.equal(sendVideo(env, fakeVideo(1000), { device: 'phone-err-0001' }).ok, true);
  });

  test('an older Photos tab gets the new columns the first time a video arrives', () => {
    const env = setup();
    const sheet = env.ss.getSheetByName('Photos');
    const old = ['Uploaded At', 'Taken At', 'From', 'Caption', 'Table', 'Hidden', 'Preview', 'Photo', 'File ID', 'Width', 'Height', 'Upload ID', 'Uploader ID', 'Album Status'];
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).setValues([sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h, i) => old[i] || '')]);
    assert.equal(sendVideo(env, fakeVideo(1000)).ok, true);
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    for (const h of ['Type', 'Filter', 'Seconds', 'Still File ID']) assert.ok(header.includes(h), h);
    assert.equal(photoRows(env)[0].Type, 'Video');
  });

  test('the highlight builder has its own secret code and sees everything, hidden included', () => {
    const env = setup();
    const s = env.gs.readSettings_(env.c);
    assert.match(s['Review Code'], /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    assert.notEqual(s['Review Code'], s['Photo Code']);
    assert.equal(s['Highlight Builder Link'], `https://stephanieandrobert.test/photos/highlight.html?k=${s['Review Code']}`);
    sendVideo(env, fakeVideo(1000), { device: 'phone-aaaa-0001', filter: 'Film' });
    apiPost(env, { action: 'photo', code: photoCode(env), data: JPEG, device: 'phone-bbbb-0002' });
    env.ss.getSheetByName('Photos').getRange(3, 6).setValue(true);
    const r = review(env);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.data.items.map((i) => [i.kind, i.hidden]), [['video', false], ['photo', true]]);
    assert.equal(r.data.items[0].filter, 'Film');
    assert.deepEqual(r.data.filters, ['Warm', 'Film', 'B&W', 'Soft', 'Vivid', 'Cool', 'Vintage', 'Taco Rain', 'Hearts']);
    // The photo code (on every table card) doesn't open it, and wrong guesses count as misses.
    assert.equal(review(env, photoCode(env)).error, 'not_found');
    assert.equal(review(env, '').error, 'bad_request');
    // Clearing the code makes a new one.
    setSettings(env, { 'Review Code': '' });
    env.gs.generateCodes_(env.c);
    assert.notEqual(reviewCode(env), s['Review Code']);
    assert.equal(review(env, s['Review Code']).error, 'not_found');
  });

  test('the builder can fetch any shared photo or video (in pieces), and nothing else in Drive', () => {
    const env = setup();
    const bytes = fakeVideo(Math.round(3.5 * 1024 * 1024)); // more than one fetch piece
    const sent = sendVideo(env, bytes, { device: 'phone-aaaa-0001' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const { id, poster } = sent.data.photo;
    const parts = [];
    let offset = 0, size = Infinity, mime = '';
    while (offset < size) {
      const r = apiGet(env, { action: 'media', k: reviewCode(env), id, offset });
      assert.equal(r.ok, true, JSON.stringify(r));
      size = r.data.size;
      mime = r.data.mime;
      const piece = Buffer.from(r.data.data, 'base64');
      parts.push(piece);
      offset += piece.length;
    }
    assert.equal(parts.length, 2);
    assert.equal(mime, 'video/mp4');
    assert.ok(Buffer.concat(parts).equals(bytes));
    assert.equal(apiGet(env, { action: 'media', k: reviewCode(env), id: poster }).ok, true, 'stills can be fetched too');
    // Some other file in the account: refused, even though the script could read it.
    const other = env.gs.DriveApp.createFolder('Tax returns').createFile(env.gs.Utilities.newBlob([1, 2, 3], 'application/pdf', 'taxes.pdf'));
    assert.equal(apiGet(env, { action: 'media', k: reviewCode(env), id: other.getId() }).error, 'not_found');
    assert.equal(apiGet(env, { action: 'media', k: photoCode(env), id }).error, 'not_found');
  });

  test('the finished highlight is saved with the review code, shared, and shown with the album', () => {
    const env = setup();
    const bytes = fakeVideo(PIECE * 3 + 5);
    // Guests can't save a highlight (the photo code isn't the review code).
    assert.equal(sendVideo(env, bytes, { k: photoCode(env) }).error, 'not_found');
    env.drive.failPieces = 1; // a Drive hiccup: the builder just tries that piece again
    let res = sendVideo(env, bytes, { k: reviewCode(env), seconds: 180, uploadId: 'hl-1' });
    assert.equal(res.error, 'upload_failed');
    res = sendVideo(env, bytes, { k: reviewCode(env), seconds: 180, uploadId: 'hl-2' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(env.drive.fetches.every((f) => f.headers.Authorization === 'Bearer mock-oauth-token'));
    const file = env.drive.files.get(res.data.highlight.id);
    assert.ok(file.bytes.equals(bytes));
    assert.match(file.name, /^Highlight video \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.mp4$/);
    assert.deepEqual(file.sharing, { access: 'ANYONE_WITH_LINK', permission: 'VIEW' });
    assert.equal(env.gs.readSettings_(env.c)['Highlight Video'], file.getUrl());
    assert.equal(photoRows(env).length, 0, 'the highlight isn\'t one of the guests\' photos');
    assert.equal(review(env).data.highlight, file.getUrl());
    // Guests only see the link once the album is published.
    assert.equal(list(env).data.album.highlight, undefined);
    env.gs.publishAlbum_(env.c, new Date());
    assert.equal(list(env).data.album.highlight, file.getUrl());
  });

  test('a hidden video is left out of the published album like a photo', () => {
    const env = setup();
    const res = sendVideo(env, fakeVideo(1000), { device: 'phone-aaaa-0001' });
    env.ss.getSheetByName('Photos').getRange(2, 6).setValue(true);
    env.gs.publishAlbum_(env.c, new Date());
    const video = env.drive.files.get(res.data.photo.id);
    assert.deepEqual(video.sharing, { access: 'PRIVATE', permission: 'NONE' });
    assert.deepEqual(list(env).data.photos, []);
  });
});

/* ------------------------------------------------------------------ */
describe('built-in self-test (the one you run inside Google Sheets)', () => {
  test('passes in the mock and cleans up after itself', () => {
    const env = setup();
    const before = env.ss.getSheets().map((s) => s.getName());
    const guestsBefore = env.sheet.rows();
    const results = env.gs.runSelfTest();
    const failed = results.filter((r) => !r.pass);
    assert.deepEqual(failed, []);
    assert.ok(results.length >= 12);
    assert.deepEqual(env.ss.getSheets().map((s) => s.getName()), before);
    assert.deepEqual(env.sheet.rows(), guestsBefore);
    assert.equal(env.gs.CTX_OVERRIDE_, null);
    assert.equal(env.mail.sent.length, 0);
    assert.match(env.ui.alerts.at(-1), /All \d+ checks passed/);
  });
});

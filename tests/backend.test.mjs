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

/* ------------------------------------------------------------------ */
describe('sheet setup', () => {
  test('creates all tabs with the expected headers and removes the blank Sheet1', () => {
    const env = createGas();
    env.gs.setupSheets_(env.gs.ctx_());
    assert.deepEqual(env.ss.getSheets().map((s) => s.getName()), ['Guests', 'Summary', 'Settings', 'RSVP Log']);
    assert.deepEqual(env.ss.getSheetByName('Guests').rows()[0], [
      'Code', 'Guest Names', 'Email', 'Invite Type', 'Plus One', 'RSVP Status', 'Ceremony Attending',
      'Reception Attending', 'Ceremony Declined', 'Reception Declined', 'Plus One Name', 'Responded At', 'Invite Sent At', 'Invite Opened At', 'Reminder Sent At', 'Invite Link', 'Text Message', 'Party Size', 'Notes',
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
    sheet.getRange(1, 20).setValue('Table #');
    sheet.getRange(2, 20).setValue('7');
    setSettings(env, { 'Ceremony Venue': 'Changed Venue' });
    const before = sheet.rows();

    env.gs.setupSheets_(env.c);
    assert.deepEqual(sheet.rows(), before);
    assert.equal(env.gs.readSettings_(env.c)['Ceremony Venue'], 'Changed Venue');
    assert.equal(env.ss.getSheets().length, 4);
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
    assert.match(formulas['Invites opened'], /=COUNTA\('Guests'!N2:N\)/);
    assert.equal(summary.getRange(3, 1).getValue(), 'Households invited');
    assert.equal(summary.getRange(10, 1).getValue(), 'Households responded');
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
    });
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
    const labels = env.ss.getSheetByName('Summary').rows().map((r) => r[0]);
    assert.deepEqual(labels.slice(13, 17), [
      'Ceremony: attending (people, incl. plus ones)', 'Ceremony: declined (people)',
      'Reception: attending (people, incl. plus ones)', 'Reception: declined (people)',
    ]);
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

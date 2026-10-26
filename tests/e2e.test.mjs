// End-to-end tests: the website's real api.js talking over HTTP to Code.gs running behind a
// fake script.google.com that redirects and refuses CORS preflights like the real one does.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServers } from '../tools/dev-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = (p) => path.join(root, 'site', p);

// fetch() that applies the browser's CORS rules for a page served from `pageOrigin`.
function browserFetch(pageOrigin, log) {
  const SIMPLE_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
  return async function (url, opts = {}) {
    const target = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    const crossOrigin = target.origin !== pageOrigin;
    const contentType = String(headers['Content-Type'] || headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extraHeaders = Object.keys(headers).filter((h) => h.toLowerCase() !== 'content-type');
    const needsPreflight = crossOrigin && (!['GET', 'HEAD', 'POST'].includes(method) || (contentType && !SIMPLE_TYPES.includes(contentType)) || extraHeaders.length);
    if (needsPreflight) {
      log.push('preflight');
      const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: pageOrigin, 'Access-Control-Request-Method': method } });
      if (!pre.ok || !pre.headers.get('access-control-allow-origin')) throw new TypeError('Failed to fetch (CORS preflight rejected)');
    }
    // Follow redirects by hand so each hop gets the CORS check a browser would do.
    let current = url, m = method, body = opts.body;
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, { method: m, headers: { ...headers, Origin: pageOrigin }, body, redirect: 'manual', signal: opts.signal });
      log.push(`${m} ${new URL(current).pathname} -> ${res.status}`);
      if (crossOrigin && res.headers.get('access-control-allow-origin') !== '*' && res.headers.get('access-control-allow-origin') !== pageOrigin) {
        throw new TypeError('Failed to fetch (missing Access-Control-Allow-Origin)');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        current = new URL(res.headers.get('location'), current).toString();
        if (res.status !== 307 && res.status !== 308) { m = 'GET'; body = undefined; }
        continue;
      }
      return res;
    }
    throw new TypeError('Too many redirects');
  };
}

// Loads the site's api.js into a fake browser window.
function loadApiJs(apiUrl, fetchImpl) {
  const window = { WEDDING_CONFIG: { apiUrl } };
  const ctx = vm.createContext({ window, fetch: fetchImpl, URL, AbortController, setTimeout, clearTimeout, Error, JSON, Object });
  vm.runInContext(readFileSync(site('js/api.js'), 'utf8'), ctx, { filename: 'api.js' });
  return window.WeddingAPI;
}

describe('website ↔ Apps Script over HTTP', () => {
  let dev, api, log;
  before(async () => {
    dev = await startDevServers({ sitePort: 0, apiPort: 0, quiet: true, settings: { 'Send RSVP Confirmations': 'No' } });
    log = [];
    api = loadApiJs(dev.apiUrl, browserFetch(dev.siteUrl, log));
  });
  after(() => dev.close());

  const code = (i) => dev.links[i].code;
  const guestsRow = (i) => dev.env.ss.getSheetByName('Guests').objects()[i];

  test('the API is on a different origin than the site (like github.io vs script.google.com)', () => {
    assert.notEqual(new URL(dev.apiUrl).origin, new URL(dev.siteUrl).origin);
  });

  test('loading an invitation follows the Apps Script redirect', async () => {
    log.length = 0;
    const data = await api.getInvite(code(0));
    assert.deepEqual(data.guests, ['Alice Smith', 'Bob Smith']);
    assert.deepEqual(log, ['GET /macros/s/MOCK/exec -> 302', 'GET /macros/echo -> 200']);
  });

  test('submitting an RSVP is a simple request (no preflight) and lands in the sheet', async () => {
    log.length = 0;
    const data = await api.submitRsvp({
      code: code(1),
      attendance: { ceremony: ['Carol Jones'], reception: ['Carol Jones'] },
      plusOne: { name: 'Taylor Guest', ceremony: true, reception: false },
    });
    assert.ok(!log.includes('preflight'), 'POST must not trigger a CORS preflight');
    assert.deepEqual(log, ['POST /macros/s/MOCK/exec -> 302', 'GET /macros/echo -> 200']);
    assert.deepEqual(data.response.plusOne, { name: 'Taylor Guest', ceremony: true, reception: false });
    const row = guestsRow(1);
    assert.equal(row['RSVP Status'], 'Attending');
    assert.equal(row['Ceremony Attending'], 'Carol Jones, Taylor Guest');
    assert.equal(row['Reception Attending'], 'Carol Jones');
  });

  test('a JSON content type WOULD be blocked by the real Apps Script (why api.js uses text/plain)', async () => {
    const f = browserFetch(dev.siteUrl, []);
    await assert.rejects(
      f(dev.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      /preflight/
    );
  });

  test('tapping the envelope open is recorded over HTTP', async () => {
    assert.equal(guestsRow(2)['Invite Opened At'], '');
    assert.deepEqual(await api.markOpened(code(2)), { opened: true });
    assert.ok(guestsRow(2)['Invite Opened At'] instanceof Date);
    await assert.rejects(api.markOpened('NOPE9999'), (err) => err.code === 'not_found');
  });

  test('server errors come back as ApiError with the server message', async () => {
    await assert.rejects(api.getInvite('NOPE99'), (err) => err.code === 'not_found' && /couldn't find/.test(err.message));
    await assert.rejects(
      api.submitRsvp({ code: code(2), attendance: { ceremony: [], reception: ['Dan Brown'] } }),
      (err) => err.code === 'bad_request'
    );
    assert.equal(guestsRow(2)['RSVP Status'], 'Not responded');
  });

  test('ceremony-only invitations contain no reception details over the wire', async () => {
    const res = await fetch(`${dev.apiUrl}?action=invite&code=${code(3)}`);
    const text = await res.text();
    assert.ok(!/reception/i.test(text), text);
  });

  test('network failure gives a friendly error', async () => {
    const offline = loadApiJs('http://127.0.0.1:9/exec', async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(offline.getInvite('ABCDEF'), (err) => err.code === 'network');
  });

  test('a non-JSON reply (e.g. a Google error page) gives a friendly error', async () => {
    const html = loadApiJs('http://x.test/exec', async () => new Response('<html>Error</html>', { status: 200 }));
    await assert.rejects(html.getInvite('ABCDEF'), (err) => err.code === 'network');
  });

  test('a site without an API URL yet says invitations are not open', async () => {
    const unset = loadApiJs('PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE', fetch);
    await assert.rejects(unset.getInvite('ABCDEF'), (err) => err.code === 'not_configured');
  });

  test('many guests RSVPing at once all get saved', async () => {
    const results = await Promise.all(dev.links.map((l, i) => api.submitRsvp({ code: l.code, attendance: { ceremony: [], reception: [] } })));
    assert.equal(results.length, dev.links.length);
    const rows = dev.env.ss.getSheetByName('Guests').objects();
    for (const r of rows) assert.equal(r['RSVP Status'], 'Declined');
  });
});

describe('static site', () => {
  let dev;
  before(async () => { dev = await startDevServers({ sitePort: 0, apiPort: 0, quiet: true }); });
  after(() => dev.close());

  test('pages are served, and the dev config points at the fake API', async () => {
    for (const p of ['/', '/invite/', `/invite/?code=${dev.links[0].code}`]) {
      const res = await fetch(dev.siteUrl + p);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type'), /text\/html/);
    }
    const cfg = await (await fetch(`${dev.siteUrl}/js/config.js`)).text();
    assert.ok(cfg.includes(dev.apiUrl));
  });

  test('/invite redirects to /invite/ like GitHub Pages', async () => {
    const res = await fetch(`${dev.siteUrl}/invite?code=ABC`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/invite/?code=ABC');
  });

  test('paths outside the site folder are refused', async () => {
    const res = await fetch(`${dev.siteUrl}/..%2f..%2fpackage.json`);
    assert.notEqual(res.status, 200);
  });

  test('every local file referenced by the HTML exists', () => {
    for (const page of ['index.html', 'invite/index.html']) {
      const html = readFileSync(site(page), 'utf8');
      const refs = [...html.matchAll(/(?:href|src|srcset)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:|data:)/.test(u));
      assert.ok(refs.length > 3, page);
      for (const ref of refs) {
        const resolved = path.join(path.dirname(site(page)), ref.split('?')[0]);
        const file = ref.endsWith('/') ? path.join(resolved, 'index.html') : resolved;
        assert.ok(existsSync(file), `${page} references missing ${ref}`);
      }
    }
  });

  test('the public website files contain no date, time or year', () => {
    const files = ['index.html', 'invite/index.html', 'js/main.js', 'js/invite.js', 'js/api.js', 'js/config.js', 'js/invitation-card.js'];
    for (const f of files) {
      const text = readFileSync(site(f), 'utf8');
      assert.doesNotMatch(text, /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i, f);
      assert.doesNotMatch(text, /\b20[2-3]\d\b/, f); // any year the wedding could be in
      assert.doesNotMatch(text, /o'clock|countdown/i, f);
    }
  });

  test('the invitation artwork exists', () => {
    for (const f of ['floral-top-right.png', 'floral-bottom-left.png', 'ornament-blossoms.png', 'ampersand.png']) {
      assert.ok(existsSync(site('images/' + f)), f);
    }
  });

  test('every photo in photos.json exists', () => {
    const photos = JSON.parse(readFileSync(site('images/photos/photos.json'), 'utf8'));
    assert.ok(photos.length > 0);
    for (const p of photos) {
      assert.ok(existsSync(site(p.src)), p.src);
      assert.ok(existsSync(site(p.thumb)), p.thumb);
      assert.ok(p.width > 0 && p.height > 0);
    }
  });

  test('the public site never contains guest or reception details', () => {
    const files = ['index.html', 'invite/index.html', 'js/main.js', 'js/invite.js', 'js/api.js', 'js/config.js', 'js/invitation-card.js'];
    for (const f of files) {
      const text = readFileSync(site(f), 'utf8');
      assert.doesNotMatch(text, /Reception Venue|Reception Address|@gmail\.com/i, f);
    }
    assert.doesNotMatch(readFileSync(site('index.html'), 'utf8'), /reception/i);
  });
});

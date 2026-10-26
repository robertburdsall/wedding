// Local preview of the whole system:
//   - serves the website from site/
//   - runs apps-script/Code.gs against a fake in-memory Google Sheet, behind a fake
//     "script.google.com" that behaves like the real one (302 redirects, no CORS preflight)
//
// Usage: npm run dev   then open the printed links.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGas, seed } from './gas-mock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(root, 'site');

export const SAMPLE_GUESTS = [
  { 'Guest Names': 'Alice Smith, Bob Smith', Email: 'smiths@example.com', 'Invite Type': 'Wedding + Reception', 'Plus One': 'No' },
  { 'Guest Names': 'Carol Jones', Email: 'carol@example.com', 'Invite Type': 'Wedding + Reception', 'Plus One': 'Yes' },
  { 'Guest Names': 'Dan Brown, Erin Brown, Finn Brown', Email: 'browns@example.com', 'Invite Type': 'Ceremony Only', 'Plus One': 'No' },
  { 'Guest Names': 'Gina Lee', Email: 'gina@example.com', 'Invite Type': 'Ceremony Only', 'Plus One': 'Yes' },
  { 'Guest Names': 'Mr. & Mrs. Sample Formal', Email: 'formal@example.com', 'Invite Type': 'Wedding + Reception', 'Plus One': 'No' },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startDevServers({ sitePort = 5173, apiPort = 5174, guests = SAMPLE_GUESTS, settings = {}, quiet = false } = {}) {
  const env = createGas();
  const pending = new Map(); // redirect id -> JSON text (like script.googleusercontent.com)
  const servers = [];

  /* ---------- fake script.google.com ---------- */
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/macros/s/MOCK/exec') {
      if (req.method === 'OPTIONS') {
        // Real Apps Script does not handle CORS preflight; a browser request that needs one fails.
        res.writeHead(405, { 'Content-Type': 'text/html' });
        return res.end('Method not allowed');
      }
      let output;
      if (req.method === 'GET') {
        output = env.gs.doGet({ parameter: Object.fromEntries(url.searchParams) });
      } else if (req.method === 'POST') {
        const contents = await readBody(req);
        output = env.gs.doPost({ parameter: Object.fromEntries(url.searchParams), postData: { contents, type: req.headers['content-type'] || '' } });
      } else {
        res.writeHead(405);
        return res.end();
      }
      const id = randomUUID();
      pending.set(id, output.getContent());
      res.writeHead(302, { Location: `http://127.0.0.1:${apiPortActual}/macros/echo?user_content_key=${id}`, 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    if (url.pathname === '/macros/echo' && req.method === 'GET') {
      const id = url.searchParams.get('user_content_key');
      const body = pending.get(id);
      pending.delete(id);
      if (!body) { res.writeHead(404); return res.end('expired'); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  const apiPortActual = await listen(api, apiPort);
  servers.push(api);
  const apiUrl = `http://127.0.0.1:${apiPortActual}/macros/s/MOCK/exec`;

  /* ---------- website + debug pages ---------- */
  const site = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/js/config.js') {
        const real = await readFile(path.join(siteDir, 'js', 'config.js'), 'utf8');
        res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        return res.end(real.replace(/apiUrl:\s*'[^']*'/, `apiUrl: '${apiUrl}'`));
      }
      if (url.pathname === '/__sheet') return sendHtml(res, renderSheets(env));
      if (url.pathname === '/__emails') return sendHtml(res, renderEmails(env));
      if (url.pathname === '/__send-invites' && req.method === 'POST') {
        const result = env.gs.sendEmails_(env.gs.ctx_(), env.gs.unsentRows_(env.gs.ctx_()), 'invite');
        res.writeHead(303, { Location: '/__emails' });
        return res.end(JSON.stringify(result));
      }

      let file = path.normalize(path.join(siteDir, decodeURIComponent(url.pathname)));
      if (!file.startsWith(siteDir)) { res.writeHead(403); return res.end('Forbidden'); }
      let info = await stat(file).catch(() => null);
      if (info && info.isDirectory()) {
        // Like GitHub Pages: /invite -> /invite/ so relative links on that page work.
        if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' + url.search }); return res.end(); }
        file = path.join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(err && err.stack));
    }
  });
  const sitePortActual = await listen(site, sitePort);
  servers.push(site);
  const siteUrl = `http://localhost:${sitePortActual}`;

  const c = seed(env, guests, {
    'Site URL': siteUrl,
    // Made-up sample wording. The real wording only ever lives in the Google Sheet.
    'Ceremony Date': 'Saturday, June 6, 2099',
    'Ceremony Time': '4:00 PM',
    'Ceremony Venue': 'Ceremony Venue (placeholder)',
    'Ceremony Address': '123 Placeholder Ave, Springfield',
    'Reception Time': '6:00 PM',
    'Reception Venue': 'Reception Venue (placeholder)',
    'Reception Address': '456 Example St, Springfield',
    'Invitation Date & Time': "Saturday, the sixth of June / two thousand ninety-nine / at four o'clock in the afternoon",
    'Invitation Location': '123 Placeholder Ave, Springfield, Anystate',
    'Full Invite: Hosts': 'Mr. and Mrs. Sample Parents',
    'Full Invite: Request': 'request the pleasure of your company at / the marriage of their daughter',
    'Full Invite: First Name': 'Stephanie Marie Example',
    'Full Invite: Joiner': 'to',
    'Full Invite: Second Name': 'Robert James',
    'Full Invite: Under Names': 'son of Mr. and Mrs. Example Parents',
    'Send RSVP Confirmations': 'Yes',
    ...settings,
    ...(process.env.DEV_SETTINGS ? JSON.parse(await readFile(process.env.DEV_SETTINGS, 'utf8')) : {}),
  });
  env.gs.generateCodes_(c);

  const links = env.ss.getSheetByName('Guests').objects().map((r) => ({ names: r['Guest Names'], type: r['Invite Type'], plusOne: r['Plus One'], code: r.Code, link: r['Invite Link'] }));
  if (!quiet) {
    console.log(`\n  Website:      ${siteUrl}/`);
    console.log(`  Fake sheet:   ${siteUrl}/__sheet`);
    console.log(`  Sent emails:  ${siteUrl}/__emails\n`);
    console.log('  Sample invitations:');
    for (const l of links) console.log(`    ${l.link}   ${l.names} (${l.type}${l.plusOne === 'Yes' ? ', +1' : ''})`);
    console.log('');
  }

  return {
    env, siteUrl, apiUrl, links,
    close: () => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))),
  };
}

function sendHtml(res, body) {
  res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dev</title>
<style>body{font:14px system-ui,sans-serif;margin:20px;background:#fff;color:#222}table{border-collapse:collapse;margin:0 0 28px}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top;white-space:pre-wrap}th{background:#15322a;color:#fff}h2{margin:24px 0 8px}.email{border:1px solid #ccc;margin:0 0 24px}.meta{background:#f4f4f4;padding:8px 12px}</style>
<p><a href="/">Website</a> · <a href="/__sheet">Sheet</a> · <a href="/__emails">Emails</a></p>${body}`);
}

function renderSheets(env) {
  return env.ss.getSheets().map((s) => {
    const rows = s.getLastRow() ? s.rows() : [];
    const fmt = (v) => (v instanceof Date ? v.toLocaleString() : v);
    return `<h2>${escapeHtml(s.getName())}</h2><table>${rows.map((r, i) => `<tr>${r.map((v) => (i === 0 ? `<th>${escapeHtml(fmt(v))}</th>` : `<td>${escapeHtml(fmt(v))}</td>`)).join('')}</tr>`).join('')}</table>`;
  }).join('');
}

function renderEmails(env) {
  const button = '<form method="post" action="/__send-invites"><button>Send all unsent invites (fake)</button></form>';
  if (!env.mail.sent.length) return `${button}<p>No emails sent yet.</p>`;
  return button + env.mail.sent.slice().reverse().map((m) => `<div class="email"><div class="meta"><b>To:</b> ${escapeHtml(m.to)}<br><b>From:</b> ${escapeHtml(m.name || '')}<br><b>Subject:</b> ${escapeHtml(m.subject)}</div>${m.htmlBody || `<pre>${escapeHtml(m.body)}</pre>`}</div>`).join('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDevServers({ sitePort: Number(process.env.PORT) || 5173 });
}

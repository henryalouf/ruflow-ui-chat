const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// Access gate
//
// This server listens on 0.0.0.0 and spawns the Claude CLI with
// --dangerously-skip-permissions. Before the gate existed, anyone who reached
// the public address could drive that agent: no auth, no Origin check, CORS '*'.
//
// The WebSocket cases matter most. The socket is what reaches handleChat and so
// what spawns the CLI, and WebSockets are NOT covered by the same-origin policy
// — a token-only check would still let any page the operator visits open a
// socket with their cookie attached and drive the box.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.AUTH_TEST_PORT || 3098);
const TOKEN = 'test-token-0123456789abcdefghijkl';
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let child;

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), RUFLOW_TOKEN: TOKEN, RUFLOW_OPEN: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('gated test server did not start');
});

after(() => { if (child) child.kill('SIGKILL'); });

function openWs(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers });
    const settle = (v) => { try { ws.terminate(); } catch (_) {} resolve(v); };
    ws.on('open', () => settle({ ok: true }));
    ws.on('unexpected-response', (_q, res) => settle({ ok: false, status: res.statusCode }));
    ws.on('error', () => settle({ ok: false, status: 0 }));
    setTimeout(() => settle({ ok: false, status: -1 }), 4000);
  });
}

describe('access gate — HTTP', () => {
  it('refuses the app with no token', async () => {
    assert.strictEqual((await fetch(`${BASE}/`, { redirect: 'manual' })).status, 401);
  });

  it('refuses a wrong token', async () => {
    const r = await fetch(`${BASE}/?k=not-the-token`, { redirect: 'manual' });
    assert.strictEqual(r.status, 401);
  });

  it('refuses a token of the right length but wrong value', async () => {
    const near = 'x'.repeat(TOKEN.length);
    assert.strictEqual((await fetch(`${BASE}/?k=${near}`, { redirect: 'manual' })).status, 401);
  });

  it('accepts ?k= and promotes it to a cookie, dropping it from the URL', async () => {
    const r = await fetch(`${BASE}/?k=${TOKEN}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.get('set-cookie') || '', /ruflow_token=/);
    assert.match(r.headers.get('set-cookie') || '', /HttpOnly/);
    assert.match(r.headers.get('set-cookie') || '', /SameSite=Strict/);
    assert.ok(!(r.headers.get('location') || '').includes('k='), 'token must not survive in the URL');
  });

  it('accepts a valid cookie', async () => {
    const r = await fetch(`${BASE}/`, { headers: { Cookie: `ruflow_token=${TOKEN}` } });
    assert.strictEqual(r.status, 200);
  });

  it('protects the upload endpoint', async () => {
    assert.strictEqual((await fetch(`${BASE}/upload`, { method: 'POST' })).status, 401);
  });

  it('protects the memory API', async () => {
    assert.strictEqual((await fetch(`${BASE}/api/memory`)).status, 401);
  });

  it('leaves /healthz open for monitoring but exposes nothing', async () => {
    const r = await fetch(`${BASE}/healthz`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.text()).trim(), 'ok');
  });

  it('does not send a wildcard CORS origin', async () => {
    const r = await fetch(`${BASE}/healthz`, { headers: { Origin: 'https://evil.example' } });
    assert.notStrictEqual(r.headers.get('access-control-allow-origin'), '*');
  });
});

describe('access gate — WebSocket', () => {
  it('refuses a socket with no token', async () => {
    assert.strictEqual((await openWs({})).ok, false);
  });

  it('refuses a socket with a wrong token', async () => {
    assert.strictEqual((await openWs({ Cookie: 'ruflow_token=nope' })).ok, false);
  });

  it('accepts a socket with a valid token and matching Origin', async () => {
    const r = await openWs({ Cookie: `ruflow_token=${TOKEN}`, Origin: ORIGIN });
    assert.strictEqual(r.ok, true);
  });

  it('refuses a valid token presented from a foreign origin', async () => {
    // The drive-by case. WebSockets ignore same-origin policy, so without this
    // check any page the operator visits could open a socket with their cookie
    // and drive an agent running --dangerously-skip-permissions.
    const r = await openWs({ Cookie: `ruflow_token=${TOKEN}`, Origin: 'https://evil.example' });
    assert.strictEqual(r.ok, false, 'cross-origin socket must be refused');
    assert.strictEqual(r.status, 403);
  });
});

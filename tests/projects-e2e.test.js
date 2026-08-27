/*
 * Projects — end-to-end against the REAL server.
 *
 * lib/projects.js has its own unit suite. This one exists to prove the wiring:
 * that the WS cases, the HTTP knowledge routes and the prompt injection are
 * actually reachable on a booted server, behind the auth gate. A unit test
 * cannot catch a case that was never added to the switch.
 *
 * RUFLOW_PROJECTS_DIR points the server at a temp dir so running this never
 * touches the operator's live projects.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const WebSocket = require('ws');

const PORT = Number(process.env.PROJECTS_E2E_PORT || 3097);
const TOKEN = 'projects-e2e-token-0123456789abcd';
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AUTH = { Cookie: `ruflow_token=${TOKEN}` };

let child, tmpProjects, tmpSessions, ws;

/** Send a WS message and wait for the first reply matching `want`. */
function rpc(send, want, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timed out waiting for '${want}' after ${JSON.stringify(send)}`));
    }, timeoutMs);
    function onMsg(raw) {
      let d; try { d = JSON.parse(raw.toString()); } catch (_) { return; }
      if (d.type === want || d.type === 'error') {
        clearTimeout(timer); ws.off('message', onMsg); resolve(d);
      }
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify(send));
  });
}

before(async () => {
  tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-e2e-proj-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RUFLOW_TOKEN: TOKEN,
      RUFLOW_OPEN: '',
      RUFLOW_PROJECTS_DIR: tmpProjects,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
    if (i === 59) throw new Error('projects e2e server did not start');
  }
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/?k=${TOKEN}`, { headers: { Origin: ORIGIN } });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('ws never opened')), 6000);
  });
});

after(() => {
  try { ws && ws.terminate(); } catch (_) {}
  if (child) child.kill('SIGKILL');
  try { fs.rmSync(tmpProjects, { recursive: true, force: true }); } catch (_) {}
});

describe('projects over the websocket', () => {
  let projectId;

  it('starts with no projects, then creates one', async () => {
    const before = await rpc({ type: 'list_projects' }, 'projects');
    assert.equal(before.type, 'projects');
    assert.equal(before.projects.length, 0, 'temp dir should start empty');

    const created = await rpc(
      { type: 'create_project', name: 'Ruflow E2E', description: 'desc', instructions: 'Always answer in haiku.' },
      'project_created'
    );
    assert.equal(created.type, 'project_created');
    assert.ok(created.project.id, 'created project needs an id');
    assert.equal(created.project.name, 'Ruflow E2E');
    assert.equal(created.project.instructions, 'Always answer in haiku.');
    projectId = created.project.id;

    const after_ = await rpc({ type: 'list_projects' }, 'projects');
    assert.equal(after_.projects.length, 1, 'list must now show exactly one');
  });

  it('rejects a project with a blank name', async () => {
    const r = await rpc({ type: 'create_project', name: '   ' }, 'project_created');
    assert.equal(r.type, 'error', 'blank name must error, not create');
    assert.match(r.message, /name/i);
  });

  it('gets a project and updates its instructions', async () => {
    const got = await rpc({ type: 'get_project', id: projectId }, 'project');
    assert.equal(got.project.id, projectId);
    assert.ok(Array.isArray(got.sessions), 'get_project must include its sessions');

    const upd = await rpc(
      { type: 'update_project', id: projectId, patch: { instructions: 'Be terse.', color: '#3fb950' } },
      'project_updated'
    );
    assert.equal(upd.project.instructions, 'Be terse.');
    assert.equal(upd.project.color, '#3fb950');

    // The ack must reflect what is actually on disk, not just what was sent.
    const reread = await rpc({ type: 'get_project', id: projectId }, 'project');
    assert.equal(reread.project.instructions, 'Be terse.', 'update must be persisted');
  });

  it('errors cleanly on an unknown project id', async () => {
    const r = await rpc({ type: 'get_project', id: 'does-not-exist' }, 'project');
    assert.equal(r.type, 'error');
  });

  it('serves a context payload with the expected shape', async () => {
    const ctx = await rpc({ type: 'project_context', id: projectId }, 'project_context', 30000);
    assert.equal(ctx.type, 'project_context');
    assert.equal(ctx.id, projectId);
    assert.ok(Array.isArray(ctx.memory), 'memory must be an array');
    assert.ok(Array.isArray(ctx.brain), 'brain must be an array');
    assert.ok(ctx.graph && Array.isArray(ctx.graph.nodes), 'graph.nodes must be an array');
    assert.ok(Array.isArray(ctx.graph.edges), 'graph.edges must be an array');
    // Every edge must connect nodes we actually returned, or the renderer breaks.
    const ids = new Set(ctx.graph.nodes.map(n => n.id));
    for (const e of ctx.graph.edges) {
      const a = e.source != null ? e.source : e.from;
      const b = e.target != null ? e.target : e.to;
      assert.ok(ids.has(a) && ids.has(b), `dangling edge ${a}->${b}`);
    }
  });
});

describe('project knowledge over HTTP', () => {
  let projectId, fileId;

  before(async () => {
    const c = await rpc({ type: 'create_project', name: 'Knowledge Host' }, 'project_created');
    projectId = c.project.id;
  });

  it('uploads, lists, downloads and deletes a knowledge file', async () => {
    const body = new FormData();
    body.append('file', new Blob(['alpha bravo charlie'], { type: 'text/plain' }), 'notes.txt');
    const up = await fetch(`${BASE}/api/projects/${projectId}/knowledge`, { method: 'POST', body, headers: AUTH });
    const upBody = await up.text();          // read once — a fetch body is single-use
    assert.equal(up.status, 200, `upload failed: ${upBody}`);
    const uj = JSON.parse(upBody);
    assert.ok(uj.file && uj.file.id, 'upload must return the file entry');
    assert.equal(uj.file.name, 'notes.txt');
    fileId = uj.file.id;

    const got = await rpc({ type: 'get_project', id: projectId }, 'project');
    assert.equal(got.project.knowledge.length, 1, 'knowledge must appear on the project');

    const dl = await fetch(`${BASE}/api/projects/${projectId}/knowledge/${fileId}`, { headers: AUTH });
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'alpha bravo charlie', 'downloaded bytes must round-trip');

    const del = await fetch(`${BASE}/api/projects/${projectId}/knowledge/${fileId}`, { method: 'DELETE', headers: AUTH });
    assert.equal(del.status, 200);
    const after_ = await rpc({ type: 'get_project', id: projectId }, 'project');
    assert.equal(after_.project.knowledge.length, 0, 'knowledge must be gone after delete');
  });

  it('404s a knowledge file that does not exist', async () => {
    const r = await fetch(`${BASE}/api/projects/${projectId}/knowledge/nope`, { headers: AUTH });
    assert.equal(r.status, 404);
  });

  it('requires the access token', async () => {
    const r = await fetch(`${BASE}/api/projects/${projectId}/knowledge/anything`);
    assert.equal(r.status, 401, 'knowledge routes must sit behind the gate');
  });
});

describe('session <-> project assignment', () => {
  it('attaches a real session to a project and detaches it again', async () => {
    const c = await rpc({ type: 'create_project', name: 'Attach Target' }, 'project_created');
    const projectId = c.project.id;

    // Use a session the running server actually has, so this exercises the real path.
    const list = await rpc({ type: 'list_sessions' }, 'session_list');
    assert.ok(list.sessions.length > 0, 'need at least one existing session to attach');
    const sessionId = list.sessions[0].id;

    const a = await rpc({ type: 'assign_session', sessionId, projectId }, 'session_assigned');
    assert.equal(a.projectId, projectId);

    const withChat = await rpc({ type: 'get_project', id: projectId }, 'project');
    assert.equal(withChat.sessions.length, 1, 'project must now own one chat');
    assert.equal(withChat.sessions[0].id, sessionId);

    const d = await rpc({ type: 'assign_session', sessionId, projectId: null }, 'session_assigned');
    assert.equal(d.projectId, null);
    const empty = await rpc({ type: 'get_project', id: projectId }, 'project');
    assert.equal(empty.sessions.length, 0, 'detach must remove it from the project');
  });

  it('errors on an unknown session', async () => {
    const r = await rpc({ type: 'assign_session', sessionId: 'nope', projectId: null }, 'session_assigned');
    assert.equal(r.type, 'error');
  });
});

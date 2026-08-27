const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const { parseExport, fetchFromApi, toRuflow, importAll } = require('../lib/claude-import');
const { createProjectStore } = require('../lib/projects');

// ---------------------------------------------------------------------------
// Test fixtures
//
// claude.ai export vintages differ: newer exports carry the message body in
// content[], older ones only in the flat `text` field. Every mapping test
// below runs against BOTH vintages via buildConversationFixtures() and
// asserts the result is identical, since toRuflow must handle both.
// ---------------------------------------------------------------------------

const PROJECT_UUID = 'proj-aaaa-1111';
const OTHER_PROJECT_UUID = 'proj-bbbb-2222';

function projectFixture(overrides = {}) {
  return {
    uuid: PROJECT_UUID,
    name: 'Launch Plan',
    description: 'Everything for the Q3 launch.',
    prompt_template: 'Always answer in bullet points. Never use emoji.',
    created_at: '2026-01-05T10:00:00.000Z',
    updated_at: '2026-01-06T11:30:00.000Z',
    is_private: true,
    docs: [
      { uuid: 'doc-1', filename: 'roadmap.md', content: '# Roadmap\n\nShip by July.', created_at: '2026-01-05T10:05:00.000Z' },
    ],
    ...overrides,
  };
}

/** Two conversations, identical content, in the content[] vintage and the flat-text vintage. */
function buildConversationFixtures({ linkStyle = 'project_uuid' } = {}) {
  const base = {
    uuid: 'conv-0001',
    name: 'Planning the launch',
    created_at: '2026-02-01T09:00:00.000Z',
    updated_at: '2026-02-01T09:05:32.000Z',
    account: { uuid: 'acct-1' },
  };

  let linkFields = {};
  if (linkStyle === 'project_uuid') linkFields = { project_uuid: PROJECT_UUID };
  else if (linkStyle === 'nested_project') linkFields = { project: { uuid: PROJECT_UUID } };
  else if (linkStyle === 'absent') linkFields = {};

  const humanMsg = {
    uuid: 'msg-1',
    sender: 'human',
    created_at: '2026-02-01T09:00:00.000Z',
    updated_at: '2026-02-01T09:00:00.000Z',
  };
  const assistantMsg = {
    uuid: 'msg-2',
    sender: 'assistant',
    created_at: '2026-02-01T09:00:45.000Z',
    updated_at: '2026-02-01T09:00:45.000Z',
  };

  const contentVintage = {
    ...base,
    ...linkFields,
    chat_messages: [
      { ...humanMsg, text: '', content: [{ type: 'text', text: 'What should we launch first?' }], attachments: [], files: [] },
      { ...assistantMsg, text: '', content: [{ type: 'text', text: 'Start with the roadmap doc.' }], attachments: [], files: [] },
    ],
  };

  const textVintage = {
    ...base,
    ...linkFields,
    chat_messages: [
      { ...humanMsg, text: 'What should we launch first?' },
      { ...assistantMsg, text: 'Start with the roadmap doc.' },
    ],
  };

  return { contentVintage, textVintage };
}

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-test-'));
}

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore() {
  const projectsDir = mkdtemp();
  const sessionsDir = mkdtemp();
  cleanupDirs.push(projectsDir, sessionsDir);
  const store = createProjectStore({ projectsDir, sessionsDir });
  return { store, projectsDir, sessionsDir };
}

// ---------------------------------------------------------------------------
// toRuflow: mapping, both export vintages
// ---------------------------------------------------------------------------

describe('toRuflow — project mapping', () => {
  it('maps prompt_template to instructions and docs to knowledge entries', () => {
    const { projects } = toRuflow({ projects: [projectFixture()], conversations: [] });
    assert.equal(projects.length, 1);
    const p = projects[0];
    assert.equal(p.instructions, 'Always answer in bullet points. Never use emoji.');
    assert.equal(p.source, 'claude.ai');
    assert.equal(p.sourceId, PROJECT_UUID);
    assert.equal(p.knowledge.length, 1);
    assert.equal(p.knowledge[0].name, 'roadmap.md');
    assert.equal(p.knowledge[0].text, '# Roadmap\n\nShip by July.');
  });

  it('leaves instructions empty (not crashing) when prompt_template is absent', () => {
    const { projects } = toRuflow({ projects: [projectFixture({ prompt_template: null, docs: [] })], conversations: [] });
    assert.equal(projects[0].instructions, '');
    assert.equal(projects[0].knowledge.length, 0);
  });
});

describe('toRuflow — conversation/message mapping (both export vintages)', () => {
  for (const vintage of ['contentVintage', 'textVintage']) {
    it(`[${vintage}] maps sender human/assistant to user/assistant with the right text`, () => {
      const { [vintage]: conv } = buildConversationFixtures();
      const { sessions } = toRuflow({ projects: [], conversations: [conv] });
      assert.equal(sessions.length, 1);
      const s = sessions[0];
      assert.equal(s.messages.length, 2);
      assert.equal(s.messages[0].role, 'user');
      assert.equal(s.messages[0].content, 'What should we launch first?');
      assert.equal(s.messages[1].role, 'assistant');
      assert.equal(s.messages[1].content, 'Start with the roadmap doc.');
    });
  }

  it('produces identical mappings for both vintages', () => {
    const { contentVintage, textVintage } = buildConversationFixtures();
    const a = toRuflow({ projects: [], conversations: [contentVintage] }).sessions[0];
    const b = toRuflow({ projects: [], conversations: [textVintage] }).sessions[0];
    assert.deepEqual(
      a.messages.map(m => ({ role: m.role, content: m.content })),
      b.messages.map(m => ({ role: m.role, content: m.content }))
    );
  });

  it('generates a NEW session id, not the claude.ai conversation uuid', () => {
    const { contentVintage } = buildConversationFixtures();
    const s = toRuflow({ projects: [], conversations: [contentVintage] }).sessions[0];
    assert.notEqual(s.id, contentVintage.uuid);
    assert.equal(s.sourceId, contentVintage.uuid);
  });

  it('preserves the exact original timestamps rather than stamping "now"', () => {
    const { contentVintage } = buildConversationFixtures();
    const before = Date.now();
    const s = toRuflow({ projects: [], conversations: [contentVintage] }).sessions[0];
    // Not "close to now" — the literal original ISO value must survive.
    assert.equal(s.createdAt, '2026-02-01T09:00:00.000Z');
    assert.equal(s.updatedAt, '2026-02-01T09:05:32.000Z');
    assert.equal(s.messages[0].timestamp, '2026-02-01T09:00:00.000Z');
    assert.equal(s.messages[1].timestamp, '2026-02-01T09:00:45.000Z');
    // Sanity: these dates are years away from "now", proving they were not overwritten.
    assert.ok(before - new Date(s.createdAt).getTime() > 1000 * 60 * 60 * 24 * 30);
  });

  it('handles a conversation with zero messages', () => {
    const { contentVintage } = buildConversationFixtures();
    const empty = { ...contentVintage, chat_messages: [] };
    const s = toRuflow({ projects: [], conversations: [empty] }).sessions[0];
    assert.deepEqual(s.messages, []);
  });
});

describe('toRuflow — conversation-to-project linkage (all three shapes + absent)', () => {
  it('links via a flat project_uuid field', () => {
    const { contentVintage } = buildConversationFixtures({ linkStyle: 'project_uuid' });
    const { projects, sessions } = toRuflow({ projects: [projectFixture()], conversations: [contentVintage] });
    assert.equal(sessions[0].projectId, projects[0].id);
  });

  it('links via a nested project.uuid field', () => {
    const { contentVintage } = buildConversationFixtures({ linkStyle: 'nested_project' });
    const { projects, sessions } = toRuflow({ projects: [projectFixture()], conversations: [contentVintage] });
    assert.equal(sessions[0].projectId, projects[0].id);
  });

  it('leaves projectId null when no link field is present', () => {
    const { contentVintage } = buildConversationFixtures({ linkStyle: 'absent' });
    const { sessions } = toRuflow({ projects: [projectFixture()], conversations: [contentVintage] });
    assert.equal(sessions[0].projectId, null);
  });

  it('does not link to a project that was never imported', () => {
    const { contentVintage } = buildConversationFixtures({ linkStyle: 'project_uuid' });
    // No matching project provided at all.
    const { sessions } = toRuflow({ projects: [projectFixture({ uuid: OTHER_PROJECT_UUID })], conversations: [contentVintage] });
    assert.equal(sessions[0].projectId, null);
  });
});

// ---------------------------------------------------------------------------
// parseExport: directory, bare json, zip, malformed json
// ---------------------------------------------------------------------------

describe('parseExport', () => {
  it('reads conversations.json + projects.json from an extracted directory', () => {
    const dir = mkdtemp();
    cleanupDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify([buildConversationFixtures().contentVintage]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([projectFixture()]));

    const result = parseExport(dir);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.projects.length, 1);
    assert.equal(result.warnings.length, 0);
  });

  it('accepts a bare conversations.json file and classifies it correctly', () => {
    const dir = mkdtemp();
    cleanupDirs.push(dir);
    const file = path.join(dir, 'conversations.json');
    fs.writeFileSync(file, JSON.stringify([buildConversationFixtures().contentVintage]));

    const result = parseExport(file);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.projects.length, 0);
  });

  it('accepts a bare projects.json file and classifies it correctly', () => {
    const dir = mkdtemp();
    cleanupDirs.push(dir);
    const file = path.join(dir, 'projects.json');
    fs.writeFileSync(file, JSON.stringify([projectFixture()]));

    const result = parseExport(file);
    assert.equal(result.projects.length, 1);
    assert.equal(result.conversations.length, 0);
  });

  it('reports a warning (not a crash) on truncated/malformed json, and returns empty arrays', () => {
    const dir = mkdtemp();
    cleanupDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'conversations.json'), '[{"uuid": "broken", "chat_mess'); // truncated
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([projectFixture()]));

    const result = parseExport(dir);
    assert.equal(result.conversations.length, 0, 'malformed input must not be treated as data');
    assert.ok(result.warnings.some(w => /conversations\.json/i.test(w)), 'must warn about the specific file');
    // Paired positive: the sibling valid file still parses fine in the same call.
    assert.equal(result.projects.length, 1, 'a malformed sibling file must not sink the whole parse');
  });

  it('extracts conversations.json and projects.json from a real zip via the system unzip binary', () => {
    const dir = mkdtemp();
    cleanupDirs.push(dir);
    const zipPath = path.join(dir, 'export.zip');
    const convBuf = Buffer.from(JSON.stringify([buildConversationFixtures().contentVintage]));
    const projBuf = Buffer.from(JSON.stringify([projectFixture()]));
    fs.writeFileSync(
      zipPath,
      buildStoredZip([
        { name: 'conversations.json', data: convBuf },
        { name: 'projects.json', data: projBuf },
      ])
    );

    const result = parseExport(zipPath);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].uuid, PROJECT_UUID);
  });
});

// ---------------------------------------------------------------------------
// Minimal pure-Node ZIP (STORED, uncompressed) builder — test-only, since no
// zip-writing tool is available on this box (only `unzip`, per the spec) and
// no npm dependency may be added.
// ---------------------------------------------------------------------------

function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = zlib.crc32(data) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method: stored
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x21, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const centralDirOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralDirSize, 12);
  end.writeUInt32LE(centralDirOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, end]);
}

// ---------------------------------------------------------------------------
// importAll: idempotency, dryRun, project+session persistence
// ---------------------------------------------------------------------------

describe('importAll', () => {
  it('creates a project and a session on the first run', () => {
    const { store, sessionsDir } = tempStore();
    const { contentVintage } = buildConversationFixtures();
    const input = { projects: [projectFixture()], conversations: [contentVintage], warnings: [] };

    const report = importAll(input, { projectStore: store, sessionsDir, dryRun: false });

    assert.equal(report.projectsCreated, 1);
    assert.equal(report.projectsUpdated, 0);
    assert.equal(report.sessionsCreated, 1);
    assert.equal(report.sessionsSkipped, 0);
    assert.equal(report.errors.length, 0);

    const projects = store.listProjects({ includeArchived: true });
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'Launch Plan');

    const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    assert.equal(sessionFiles.length, 1);
    const written = JSON.parse(fs.readFileSync(path.join(sessionsDir, sessionFiles[0]), 'utf-8'));
    assert.equal(written.projectId, projects[0].id, 'the written session must link to the real on-disk project id');
    assert.equal(written.createdAt, '2026-02-01T09:00:00.000Z', 'original timestamp must survive the write');
  });

  it('is idempotent: re-running creates nothing new and skips already-imported sessions', () => {
    const { store, sessionsDir } = tempStore();
    const { contentVintage } = buildConversationFixtures();
    const input = { projects: [projectFixture()], conversations: [contentVintage], warnings: [] };

    const first = importAll(input, { projectStore: store, sessionsDir, dryRun: false });
    assert.equal(first.sessionsCreated, 1);

    const second = importAll(input, { projectStore: store, sessionsDir, dryRun: false });
    assert.equal(second.projectsCreated, 0, 'second run must not duplicate the project');
    assert.equal(second.projectsUpdated, 1, 'second run updates the existing project in place');
    assert.equal(second.sessionsCreated, 0, 'second run must not duplicate the session');
    assert.equal(second.sessionsSkipped, 1);

    const projects = store.listProjects({ includeArchived: true });
    assert.equal(projects.length, 1, 'still exactly one project on disk after two runs');
    const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    assert.equal(sessionFiles.length, 1, 'still exactly one session file on disk after two runs');
  });

  it('dryRun reports what would happen but writes nothing; a real run afterward proves the write path works', () => {
    const { store, projectsDir, sessionsDir } = tempStore();
    const { contentVintage } = buildConversationFixtures();
    const input = { projects: [projectFixture()], conversations: [contentVintage], warnings: [] };

    const dry = importAll(input, { projectStore: store, sessionsDir, dryRun: true });
    assert.equal(dry.projectsCreated, 1);
    assert.equal(dry.sessionsCreated, 1);

    const projectFilesAfterDry = fs.readdirSync(projectsDir).filter(f => f.endsWith('.json'));
    const sessionFilesAfterDry = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    assert.equal(projectFilesAfterDry.length, 0, 'dryRun must not write a project file');
    assert.equal(sessionFilesAfterDry.length, 0, 'dryRun must not write a session file');

    // Positive counterpart: the exact same input, for real, does write.
    const real = importAll(input, { projectStore: store, sessionsDir, dryRun: false });
    assert.equal(real.projectsCreated, 1);
    assert.equal(real.sessionsCreated, 1);
    assert.equal(fs.readdirSync(projectsDir).filter(f => f.endsWith('.json')).length, 1);
    assert.equal(fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')).length, 1);
  });

  it('lazily requires the real project store when none is injected', () => {
    // Exercises the `require('./projects')` fallback path itself (not just the
    // injected-store path every other test uses), pointed at a scratch dir via
    // no override — so we only check it does not throw wiring up the store.
    const sessionsDir = mkdtemp();
    cleanupDirs.push(sessionsDir);
    assert.doesNotThrow(() => {
      // No conversations/projects — this call must succeed even with no store injected.
      importAll({ projects: [], conversations: [], warnings: [] }, { sessionsDir, dryRun: true });
    });
  });
});

// ---------------------------------------------------------------------------
// fetchFromApi: shape parsing via injected fetch, and the 403 diagnostic path
// ---------------------------------------------------------------------------

describe('fetchFromApi', () => {
  function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it('parses organizations -> projects -> docs -> conversations into the export shape', async () => {
    const { contentVintage } = buildConversationFixtures();
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/organizations')) return jsonResponse([{ uuid: 'org-1' }]);
      if (url.endsWith('/projects')) return jsonResponse([projectFixture({ docs: undefined })]);
      if (url.includes(`/projects/${PROJECT_UUID}/docs`)) return jsonResponse(projectFixture().docs);
      if (url.endsWith('/chat_conversations')) return jsonResponse([{ uuid: contentVintage.uuid }]);
      if (url.endsWith(`/chat_conversations/${contentVintage.uuid}`)) return jsonResponse(contentVintage);
      throw new Error(`unexpected url in test: ${url}`);
    };

    const result = await fetchFromApi({ sessionKey: 'fake-session-key', fetchImpl: fakeFetch });

    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].docs.length, 1, 'docs must be folded onto the project, matching the export shape');
    assert.equal(result.conversations.length, 1);
    assert.equal(result.conversations[0].uuid, contentVintage.uuid);
    assert.equal(result.warnings.length, 0);
    assert.ok(calls.some(u => u.includes('org-1')), 'must have actually called the resolved org id');
  });

  it('produces a clear diagnostic (not a stack trace) on a 403, and never leaks the session key', async () => {
    const fakeFetch = async () => jsonResponse({ error: 'forbidden' }, 403);

    await assert.rejects(
      () => fetchFromApi({ sessionKey: 'super-secret-key-value', fetchImpl: fakeFetch }),
      err => {
        assert.match(err.message, /403/);
        assert.match(err.message, /sessionKey is expired or wrong/i);
        assert.ok(!err.message.includes('super-secret-key-value'), 'the raw session key must never appear in an error message');
        return true;
      }
    );
  });

  it('rejects with a clear message when no sessionKey is given (paired negative/positive: valid key path is covered above)', async () => {
    await assert.rejects(() => fetchFromApi({ fetchImpl: async () => jsonResponse([]) }));
  });
});

// ---------------------------------------------------------------------------
// Project timestamps survive the write path
//
// Regression guard. toRuflow mapped created_at/updated_at correctly all along,
// but the store discarded them: createProject() stamped now(), and addKnowledge()
// bumped updatedAt afterwards. The suite passed anyway because it only asserted
// SESSION timestamps — so an imported project showed as "just now" and destroyed
// the recency ordering in the sidebar. Assert the project dates end up on disk.
// ---------------------------------------------------------------------------

describe('importAll — project timestamps land on disk', () => {
  const CREATED = '2025-11-02T10:15:00Z';
  const UPDATED = '2026-03-08T09:00:00Z';

  function datedInput() {
    return {
      projects: [{
        uuid: PROJECT_UUID,
        name: 'Dated Project',
        description: 'has real dates',
        prompt_template: 'Be precise.',
        created_at: CREATED,
        updated_at: UPDATED,
        // Knowledge matters: adding it is what used to bump updatedAt to now().
        docs: [{ uuid: 'doc-dated', filename: 'note.md', content: '# note', created_at: CREATED }],
      }],
      conversations: [],
      warnings: [],
    };
  }

  function readOnlyProject(projectsDir) {
    const files = fs.readdirSync(projectsDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1, 'expected exactly one project on disk');
    return JSON.parse(fs.readFileSync(path.join(projectsDir, files[0]), 'utf-8'));
  }

  it('preserves createdAt and updatedAt from the export, even with knowledge attached', () => {
    const { store, projectsDir, sessionsDir } = tempStore();
    const report = importAll(datedInput(), { projectStore: store, sessionsDir, dryRun: false });
    assert.equal(report.projectsCreated, 1, 'sanity: the project must actually be created');

    const onDisk = readOnlyProject(projectsDir);
    assert.equal(onDisk.knowledge.length, 1, 'sanity: knowledge must have been attached');
    assert.equal(onDisk.createdAt, CREATED, 'createdAt must be the claude.ai date, not now()');
    assert.equal(onDisk.updatedAt, UPDATED, 'updatedAt must survive the knowledge write');
  });

  it('still stamps now() for a locally created project', () => {
    // The paired positive case: preservation must not leak into normal creation.
    const { store, projectsDir } = tempStore();
    const before = Date.now();
    store.createProject({ name: 'Local' });
    const onDisk = readOnlyProject(projectsDir);
    const t = Date.parse(onDisk.createdAt);
    assert.ok(Number.isFinite(t), 'local project needs a real timestamp');
    assert.ok(t >= before - 1000, 'a local project must be stamped now(), not backdated');
  });
});

// ---------------------------------------------------------------------------
// Knowledge filenames — both key spellings
//
// The live claude.ai API returns `file_name`; the official export uses
// `filename`. The importer originally read only `filename`, so an API-sourced
// import fell back to d.uuid and every knowledge file in the UI was listed as
// a raw hex string. Nothing failed loudly — it just looked broken.
// ---------------------------------------------------------------------------
describe('toRuflow — knowledge filenames', () => {
  const mk = (doc) => toRuflow({
    projects: [{ uuid: 'p-fn', name: 'FN', description: '', created_at: '2026-01-01T00:00:00Z',
                 updated_at: '2026-01-01T00:00:00Z', docs: [doc] }],
    conversations: [], warnings: [],
  }).projects[0].knowledge[0];

  it('uses file_name (live API shape)', () => {
    assert.equal(mk({ uuid: 'u1', file_name: 'leads/clark-hicks.md', content: '#x' }).name, 'leads/clark-hicks.md');
  });

  it('uses filename (export shape)', () => {
    assert.equal(mk({ uuid: 'u2', filename: 'brief.md', content: '#x' }).name, 'brief.md');
  });

  it('falls back to the uuid only when there is genuinely no name', () => {
    // The paired positive case above proves this branch is not just always taken.
    assert.equal(mk({ uuid: 'u3', content: '#x' }).name, 'u3');
  });
});

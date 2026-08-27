const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProjectStore } = require('../lib/projects');

// ---------------------------------------------------------------------------
// Setup — fresh temp dirs per test, never touch the real projects/sessions.
// ---------------------------------------------------------------------------

let tmpRoot, projectsDir, sessionsDir, store;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflow-projects-test-'));
  projectsDir = path.join(tmpRoot, 'projects');
  sessionsDir = path.join(tmpRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  store = createProjectStore({ projectsDir, sessionsDir });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSessionFile(id, overrides = {}) {
  const session = {
    id,
    name: overrides.name || `Session ${id}`,
    cliSessionId: null,
    model: 'sonnet',
    messages: overrides.messages || [],
    createdAt: new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
    projectId: overrides.projectId !== undefined ? overrides.projectId : null,
  };
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2));
  return session;
}

// ===========================================================================
// Create / get / update round trip
// ===========================================================================

describe('Projects — create/get/update round trip', () => {
  it('creates a project and reads it back with all fields', () => {
    const project = store.createProject({
      name: 'My Project',
      description: 'A test project',
      instructions: 'Be concise.',
      color: '#123456',
      source: 'local',
    });

    assert.ok(project.id, 'created project has an id');
    const loaded = store.getProject(project.id);
    assert.ok(loaded, 'getProject returns the project');
    assert.equal(loaded.name, 'My Project');
    assert.equal(loaded.description, 'A test project');
    assert.equal(loaded.instructions, 'Be concise.');
    assert.equal(loaded.color, '#123456');
    assert.equal(loaded.source, 'local');
    assert.deepEqual(loaded.knowledge, []);
    assert.equal(loaded.pinned, false);
    assert.equal(loaded.archived, false);
    assert.ok(loaded.createdAt);
    assert.ok(loaded.updatedAt);
  });

  it('getProject returns null for a nonexistent id', () => {
    const result = store.getProject('11111111-1111-1111-1111-111111111111');
    assert.equal(result, null);
  });

  it('updates patchable fields and persists them', () => {
    const project = store.createProject({ name: 'Original' });
    const updated = store.updateProject(project.id, {
      name: 'Renamed',
      description: 'New desc',
      instructions: 'New instructions',
      color: '#abcdef',
      pinned: true,
      archived: false,
    });

    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.description, 'New desc');
    assert.equal(updated.instructions, 'New instructions');
    assert.equal(updated.color, '#abcdef');
    assert.equal(updated.pinned, true);

    const reloaded = store.getProject(project.id);
    assert.equal(reloaded.name, 'Renamed');
    assert.equal(reloaded.pinned, true);
  });

  it('updateProject returns null for a nonexistent id', () => {
    const result = store.updateProject('22222222-2222-2222-2222-222222222222', { name: 'x' });
    assert.equal(result, null);
  });
});

// ===========================================================================
// Patch cannot overwrite id/createdAt/knowledge
// ===========================================================================

describe('Projects — patch cannot overwrite protected fields', () => {
  it('ignores id/createdAt/knowledge in the patch, keeps everything else patchable', () => {
    const project = store.createProject({ name: 'Protected' });
    const originalId = project.id;
    const originalCreatedAt = project.createdAt;

    const updated = store.updateProject(project.id, {
      id: 'hijacked-id',
      createdAt: '1999-01-01T00:00:00.000Z',
      knowledge: [{ id: 'fake', name: 'fake.txt' }],
      name: 'Still renamable',
    });

    assert.equal(updated.id, originalId, 'id must not change');
    assert.equal(updated.createdAt, originalCreatedAt, 'createdAt must not change');
    assert.deepEqual(updated.knowledge, [], 'knowledge must not be overwritten by patch');
    assert.equal(updated.name, 'Still renamable', 'name is still patchable');
  });

  it('ignores unknown keys silently without throwing', () => {
    const project = store.createProject({ name: 'Unknown Keys' });
    assert.doesNotThrow(() => {
      store.updateProject(project.id, { totallyMadeUp: 'value', name: 'Kept' });
    });
    const reloaded = store.getProject(project.id);
    assert.equal(reloaded.name, 'Kept');
    assert.equal(reloaded.totallyMadeUp, undefined);
  });
});

// ===========================================================================
// Delete / archive
// ===========================================================================

describe('Projects — archive and hard delete', () => {
  it('archives by default, detaching sessions but preserving session files', () => {
    const project = store.createProject({ name: 'To Archive' });
    const s1 = writeSessionFile('sess-1', { projectId: project.id });
    const s2 = writeSessionFile('sess-2', { projectId: project.id });
    writeSessionFile('sess-3', { projectId: null }); // unrelated session

    const result = store.deleteProject(project.id);
    assert.equal(result.archived, true);

    // Project file still exists (soft delete)
    const reloaded = store.getProject(project.id);
    assert.ok(reloaded, 'project json still exists after soft delete');
    assert.equal(reloaded.archived, true);

    // Session files still exist on disk
    assert.ok(fs.existsSync(path.join(sessionsDir, 'sess-1.json')), 'session 1 file preserved');
    assert.ok(fs.existsSync(path.join(sessionsDir, 'sess-2.json')), 'session 2 file preserved');

    // But detached from the project
    const reloadedS1 = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sess-1.json'), 'utf-8'));
    const reloadedS2 = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sess-2.json'), 'utf-8'));
    assert.equal(reloadedS1.projectId, null, 'session 1 detached');
    assert.equal(reloadedS2.projectId, null, 'session 2 detached');

    // Unrelated session untouched
    const reloadedS3 = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sess-3.json'), 'utf-8'));
    assert.equal(reloadedS3.projectId, null);
  });

  it('hard delete removes the project json and its knowledge dir', () => {
    const project = store.createProject({ name: 'To Hard Delete' });
    store.addKnowledge(project.id, {
      name: 'notes.txt',
      mime: 'text/plain',
      buffer: Buffer.from('hello world'),
    });

    const knowledgeDir = path.join(projectsDir, project.id, 'knowledge');
    assert.ok(fs.existsSync(knowledgeDir), 'knowledge dir exists before delete');
    assert.ok(fs.existsSync(path.join(projectsDir, `${project.id}.json`)), 'project json exists before delete');

    store.deleteProject(project.id, { hard: true });

    assert.ok(!fs.existsSync(path.join(projectsDir, `${project.id}.json`)), 'project json removed');
    assert.ok(!fs.existsSync(path.join(projectsDir, project.id)), 'project dir (incl. knowledge) removed');
    assert.equal(store.getProject(project.id), null, 'getProject returns null after hard delete');
  });

  it('deleteProject returns null for a nonexistent id', () => {
    const result = store.deleteProject('33333333-3333-3333-3333-333333333333');
    assert.equal(result, null);
  });
});

// ===========================================================================
// Path traversal rejected
// ===========================================================================

describe('Projects — path traversal safety', () => {
  it('rejects a traversal-style project id on read (returns null, never throws)', () => {
    assert.doesNotThrow(() => {
      const result = store.getProject('../../../etc/passwd');
      assert.equal(result, null);
    });
    // Confirm nothing escaped the projects dir
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'etc', 'passwd')));
  });

  it('accepts a legitimate uuid project id (positive case for the above)', () => {
    const project = store.createProject({ name: 'Legit' });
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(project.id));
    assert.ok(store.getProject(project.id));
  });

  it('rejects a traversal-style project id on update/delete', () => {
    assert.equal(store.updateProject('../../../etc/passwd', { name: 'x' }), null);
    assert.equal(store.deleteProject('../../../etc/passwd'), null);
  });

  it('rejects a traversal-style fileId on removeKnowledge/readKnowledge/getKnowledgeText', () => {
    const project = store.createProject({ name: 'Knowledge Owner' });
    store.addKnowledge(project.id, {
      name: 'real.txt',
      mime: 'text/plain',
      buffer: Buffer.from('real content'),
    });

    assert.equal(store.removeKnowledge(project.id, '../../../etc/passwd'), false);
    assert.equal(store.readKnowledge(project.id, '../../../etc/passwd'), null);
    assert.equal(store.getKnowledgeText(project.id, '../../../etc/passwd'), null);

    // Nothing outside the temp root was touched
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'etc', 'passwd')));
  });

  it('accepts a legitimate fileId on readKnowledge (positive case for the above)', () => {
    const project = store.createProject({ name: 'Knowledge Owner 2' });
    const entry = store.addKnowledge(project.id, {
      name: 'real.txt',
      mime: 'text/plain',
      buffer: Buffer.from('real content'),
    });
    const buf = store.readKnowledge(project.id, entry.id);
    assert.ok(buf);
    assert.equal(buf.toString('utf-8'), 'real content');
  });

  it('rejects a traversal-style project id on addKnowledge (never touches fs)', () => {
    assert.equal(
      store.addKnowledge('../../../etc', { name: 'x.txt', mime: 'text/plain', buffer: Buffer.from('x') }),
      null
    );
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'etc')));
  });
});

// ===========================================================================
// Knowledge size cap
// ===========================================================================

describe('Projects — knowledge 10MB cap', () => {
  it('throws when a knowledge file exceeds the 10MB limit', () => {
    const project = store.createProject({ name: 'Big Files' });
    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);
    assert.throws(
      () => store.addKnowledge(project.id, { name: 'huge.bin', mime: 'application/octet-stream', buffer: tooBig }),
      /10MB|limit/i
    );
  });

  it('accepts a file just under the limit (positive case for the above)', () => {
    const project = store.createProject({ name: 'Ok Size' });
    const okBuf = Buffer.alloc(10 * 1024 * 1024); // exactly 10MB, at the boundary
    const entry = store.addKnowledge(project.id, { name: 'ok.bin', mime: 'application/octet-stream', buffer: okBuf });
    assert.ok(entry);
    assert.equal(entry.bytes, okBuf.length);
  });
});

// ===========================================================================
// getKnowledgeText — binary vs text
// ===========================================================================

describe('Projects — getKnowledgeText binary vs text', () => {
  it('returns null for a binary file', () => {
    const project = store.createProject({ name: 'Binary Test' });
    const entry = store.addKnowledge(project.id, {
      name: 'image.png',
      mime: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    });
    assert.equal(store.getKnowledgeText(project.id, entry.id), null);
  });

  it('returns the decoded text for a text file (positive case for the above)', () => {
    const project = store.createProject({ name: 'Text Test' });
    const entry = store.addKnowledge(project.id, {
      name: 'readme.md',
      mime: 'text/markdown',
      buffer: Buffer.from('# Hello\nWorld'),
    });
    assert.equal(store.getKnowledgeText(project.id, entry.id), '# Hello\nWorld');
  });

  it('returns null for an unrecognized fileId', () => {
    const project = store.createProject({ name: 'Missing Knowledge' });
    assert.equal(store.getKnowledgeText(project.id, 'nonexistent-file-id'), null);
  });
});

// ===========================================================================
// removeKnowledge
// ===========================================================================

describe('Projects — removeKnowledge', () => {
  it('deletes the knowledge entry and its file from disk', () => {
    const project = store.createProject({ name: 'Remove Test' });
    const entry = store.addKnowledge(project.id, {
      name: 'to-remove.txt',
      mime: 'text/plain',
      buffer: Buffer.from('bye'),
    });
    const filePath = path.join(projectsDir, project.id, 'knowledge', entry.id);
    assert.ok(fs.existsSync(filePath), 'file exists before removal');

    const removed = store.removeKnowledge(project.id, entry.id);
    assert.equal(removed, true);
    assert.ok(!fs.existsSync(filePath), 'file removed from disk');

    const reloaded = store.getProject(project.id);
    assert.equal(reloaded.knowledge.length, 0);
  });

  it('returns false for a fileId that does not exist', () => {
    const project = store.createProject({ name: 'Remove Missing' });
    assert.equal(store.removeKnowledge(project.id, 'nonexistent-file-id'), false);
  });
});

// ===========================================================================
// buildProjectPrompt
// ===========================================================================

describe('Projects — buildProjectPrompt', () => {
  it('returns null when the project has no instructions, description, or knowledge', () => {
    const project = store.createProject({ name: 'Empty Project' });
    assert.equal(store.buildProjectPrompt(project.id), null);
  });

  it('returns null for a nonexistent project', () => {
    assert.equal(store.buildProjectPrompt('44444444-4444-4444-4444-444444444444'), null);
  });

  it('contains instructions and knowledge text when populated (positive case)', () => {
    const project = store.createProject({
      name: 'Populated Project',
      description: 'A helpful assistant project.',
      instructions: 'Always answer in haiku.',
    });
    store.addKnowledge(project.id, {
      name: 'facts.txt',
      mime: 'text/plain',
      buffer: Buffer.from('The sky is blue.'),
    });

    const prompt = store.buildProjectPrompt(project.id);
    assert.ok(prompt, 'prompt is non-null when populated');
    assert.ok(prompt.includes('PROJECT: Populated Project'));
    assert.ok(prompt.includes('A helpful assistant project.'));
    assert.ok(prompt.includes('Always answer in haiku.'));
    assert.ok(prompt.includes('PROJECT KNOWLEDGE'));
    assert.ok(prompt.includes('## facts.txt'));
    assert.ok(prompt.includes('The sky is blue.'));
  });

  it('does not inject binary knowledge content into the prompt', () => {
    const project = store.createProject({ name: 'Binary Knowledge Project', instructions: 'Do stuff.' });
    store.addKnowledge(project.id, {
      name: 'image.png',
      mime: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    });
    const prompt = store.buildProjectPrompt(project.id);
    assert.ok(prompt.includes('Do stuff.'));
    assert.ok(!prompt.includes('## image.png'), 'binary file should not be included as a knowledge section');
  });

  it('adds a [truncated] marker when a single file exceeds the per-file cap', () => {
    const project = store.createProject({ name: 'Big File Project', instructions: 'x' });
    const bigText = 'A'.repeat(25000); // over the 20000-char per-file cap
    store.addKnowledge(project.id, { name: 'big.txt', mime: 'text/plain', buffer: Buffer.from(bigText) });

    const prompt = store.buildProjectPrompt(project.id);
    assert.ok(prompt.includes('[truncated]'), 'truncation marker present when over the per-file cap');
  });

  it('does not add a [truncated] marker when comfortably under both caps (positive case)', () => {
    const project = store.createProject({ name: 'Small File Project', instructions: 'x' });
    store.addKnowledge(project.id, { name: 'small.txt', mime: 'text/plain', buffer: Buffer.from('tiny content') });

    const prompt = store.buildProjectPrompt(project.id);
    assert.ok(!prompt.includes('[truncated]'), 'no truncation marker when content is small');
  });

  it('caps total knowledge content at the total budget across multiple files', () => {
    const project = store.createProject({ name: 'Multi File Project', instructions: 'x' });
    // 4 files of 18000 chars each = 72000 chars, over the 60000 total cap,
    // each individually under the 20000 per-file cap.
    for (let i = 0; i < 4; i++) {
      store.addKnowledge(project.id, {
        name: `file-${i}.txt`,
        mime: 'text/plain',
        buffer: Buffer.from('B'.repeat(18000)),
      });
    }
    const prompt = store.buildProjectPrompt(project.id);
    assert.ok(prompt.includes('[truncated]'), 'truncation marker present when total exceeds the cap');

    // The knowledge section itself should not exceed the total budget by much
    // (header lines add some overhead, but the actual content is capped).
    const knowledgeSectionIdx = prompt.indexOf('--- PROJECT KNOWLEDGE ---');
    const knowledgeSection = prompt.slice(knowledgeSectionIdx);
    assert.ok(knowledgeSection.length < 62000, 'knowledge section stays near the 60000 char total budget');
  });
});

// ===========================================================================
// assignSession / listProjectSessions
// ===========================================================================

describe('Projects — assignSession and listProjectSessions', () => {
  it('assigns a session to a project and reads it back via listProjectSessions', () => {
    const project = store.createProject({ name: 'Session Owner' });
    writeSessionFile('assign-1');

    const ok = store.assignSession('assign-1', project.id);
    assert.equal(ok, true);

    const sessions = store.listProjectSessions(project.id);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'assign-1');
    assert.ok('name' in sessions[0]);
    assert.ok('updatedAt' in sessions[0]);
    assert.ok('messageCount' in sessions[0]);
  });

  it('preserves every other field on the session when assigning', () => {
    writeSessionFile('assign-2', { messages: [{ role: 'user', content: 'hi', blocks: [] }] });
    const project = store.createProject({ name: 'Field Preserver' });

    store.assignSession('assign-2', project.id);

    const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'assign-2.json'), 'utf-8'));
    assert.equal(raw.projectId, project.id);
    assert.equal(raw.model, 'sonnet');
    assert.equal(raw.messages.length, 1);
    assert.equal(raw.messages[0].content, 'hi');
  });

  it('returns false when assigning a nonexistent session', () => {
    const project = store.createProject({ name: 'No Session' });
    assert.equal(store.assignSession('nonexistent-session-id', project.id), false);
  });

  it('unassigns a session by passing null', () => {
    writeSessionFile('assign-3');
    const project = store.createProject({ name: 'Unassign Test' });
    store.assignSession('assign-3', project.id);
    assert.equal(store.listProjectSessions(project.id).length, 1);

    store.assignSession('assign-3', null);
    assert.equal(store.listProjectSessions(project.id).length, 0);
  });

  it('listProjectSessions returns an empty array for a project with no sessions', () => {
    const project = store.createProject({ name: 'Lonely Project' });
    assert.deepEqual(store.listProjectSessions(project.id), []);
  });
});

// ===========================================================================
// listProjects — chatCount, knowledgeCount, ordering, archived filter
// ===========================================================================

describe('Projects — listProjects', () => {
  it('computes chatCount correctly with sessions present', () => {
    const project = store.createProject({ name: 'Chatty Project' });
    writeSessionFile('chat-1', { projectId: project.id });
    writeSessionFile('chat-2', { projectId: project.id });
    writeSessionFile('chat-3', { projectId: null });

    const list = store.listProjects();
    const found = list.find(p => p.id === project.id);
    assert.ok(found);
    assert.equal(found.chatCount, 2, 'only sessions assigned to this project are counted');
  });

  it('computes chatCount as zero when no sessions are assigned (positive case for the above)', () => {
    const project = store.createProject({ name: 'No Chats Project' });
    writeSessionFile('chat-unrelated', { projectId: null });

    const list = store.listProjects();
    const found = list.find(p => p.id === project.id);
    assert.equal(found.chatCount, 0);
  });

  it('computes knowledgeCount', () => {
    const project = store.createProject({ name: 'Knowledge Count Project' });
    store.addKnowledge(project.id, { name: 'a.txt', mime: 'text/plain', buffer: Buffer.from('a') });
    store.addKnowledge(project.id, { name: 'b.txt', mime: 'text/plain', buffer: Buffer.from('b') });

    const list = store.listProjects();
    const found = list.find(p => p.id === project.id);
    assert.equal(found.knowledgeCount, 2);
  });

  it('sorts newest-updated first', () => {
    const p1 = store.createProject({ name: 'Older' });
    const p2 = store.createProject({ name: 'Newer' });

    // Force deterministic timestamps directly on disk (avoids flakiness from
    // system-clock millisecond resolution), same approach as session.test.js.
    const p1Raw = JSON.parse(fs.readFileSync(path.join(projectsDir, `${p1.id}.json`), 'utf-8'));
    p1Raw.updatedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(path.join(projectsDir, `${p1.id}.json`), JSON.stringify(p1Raw, null, 2));

    const p2Raw = JSON.parse(fs.readFileSync(path.join(projectsDir, `${p2.id}.json`), 'utf-8'));
    p2Raw.updatedAt = '2030-01-01T00:00:00.000Z';
    fs.writeFileSync(path.join(projectsDir, `${p2.id}.json`), JSON.stringify(p2Raw, null, 2));

    const list = store.listProjects();
    const idx1 = list.findIndex(p => p.id === p1.id);
    const idx2 = list.findIndex(p => p.id === p2.id);
    assert.ok(idx2 < idx1, 'the more recently updated project should come first');
  });

  it('excludes archived projects by default, includes them with includeArchived', () => {
    const active = store.createProject({ name: 'Active Project' });
    const archived = store.createProject({ name: 'Archived Project' });
    store.deleteProject(archived.id); // soft delete = archive

    const defaultList = store.listProjects();
    assert.ok(defaultList.find(p => p.id === active.id), 'active project is listed');
    assert.ok(!defaultList.find(p => p.id === archived.id), 'archived project is excluded by default');

    const fullList = store.listProjects({ includeArchived: true });
    assert.ok(fullList.find(p => p.id === archived.id), 'archived project is included when requested');
  });

  it('skips a corrupt project file without throwing, but still counts it', () => {
    const project = store.createProject({ name: 'Valid Neighbor' });
    fs.writeFileSync(path.join(projectsDir, 'corrupt-project.json'), 'NOT JSON {{{');

    let list;
    assert.doesNotThrow(() => {
      list = store.listProjects();
    });
    assert.ok(list.find(p => p.id === project.id), 'valid project still appears');
    const corruptEntry = list.find(p => p.id === 'corrupt-project');
    assert.ok(corruptEntry, 'corrupt project is still surfaced in the list');
    assert.equal(corruptEntry.corrupt, true);
  });

  it('returns an empty array when there are no projects at all', () => {
    assert.deepEqual(store.listProjects(), []);
  });
});

// ---------------------------------------------------------------------------
// buildProjectPrompt — retrieval, not a dump
//
// Every turn in a project injects this. Dumping all knowledge cost ~16.5k
// tokens per message on a 16-file project, nearly all of it irrelevant to what
// was actually asked. With a query it ranks and inlines only what matters, and
// names the rest so an omission can never read as "the project has nothing
// about that".
// ---------------------------------------------------------------------------
describe('Projects — buildProjectPrompt retrieval', () => {
  function seed() {
    const p = store.createProject({ name: 'Leads', description: '', instructions: 'Be concrete.' });
    store.addKnowledge(p.id, { name: 'vendor-contract-terms.md', mime: 'text/markdown',
      buffer: Buffer.from('Acme Corp agreed one thousand for the build.') });
    store.addKnowledge(p.id, { name: 'unrelated-pricing.md', mime: 'text/markdown',
      buffer: Buffer.from('Generic pricing notes with no names in them at all.') });
    store.addKnowledge(p.id, { name: 'another-unrelated.md', mime: 'text/markdown',
      buffer: Buffer.from('Something else entirely, about hosting uptime.') });
    return p;
  }

  it('inlines the matching file and lists the others by name', () => {
    const p = seed();
    const out = store.buildProjectPrompt(p.id, { query: 'what did acme corp agree', budget: 4000 });

    assert.ok(out.includes('Acme Corp agreed one thousand'), 'the matching file must be inlined');
    assert.ok(out.includes('OTHER FILES IN THIS PROJECT'), 'non-matching files must still be named');
    assert.ok(out.includes('unrelated-pricing.md'), 'a skipped file must appear in the index');
    assert.ok(!out.includes('Generic pricing notes'), 'a skipped file must NOT be inlined');
    assert.ok(out.includes('Be concrete.'), 'instructions are always kept');
  });

  it('still returns everything when there is no query (paired positive case)', () => {
    const p = seed();
    const out = store.buildProjectPrompt(p.id);
    assert.ok(out.includes('Acme Corp agreed'), 'no-query path keeps file 1');
    assert.ok(out.includes('Generic pricing notes'), 'no-query path keeps file 2');
    assert.ok(out.includes('Something else entirely'), 'no-query path keeps file 3');
  });

  it('is materially smaller with a query than without', () => {
    const p = seed();
    const full = store.buildProjectPrompt(p.id);
    const retrieved = store.buildProjectPrompt(p.id, { query: 'acme corp', budget: 4000 });
    assert.ok(retrieved.length < full.length,
      `retrieval must shrink the prompt (got ${retrieved.length} vs ${full.length})`);
  });

  it('falls back to stored order when nothing matches, rather than injecting nothing', () => {
    const p = seed();
    const out = store.buildProjectPrompt(p.id, { query: 'zzzzz nonexistent topic', budget: 4000 });
    assert.ok(out && out.length > 0, 'must not return an empty prompt');
    assert.ok(out.includes('Be concrete.'), 'instructions survive a zero-match query');
  });
});

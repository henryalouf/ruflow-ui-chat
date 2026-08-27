// ---------------------------------------------------------------------------
// Projects data layer
// ---------------------------------------------------------------------------
// Mirrors server.js's sync fs style (sessionPath/loadSession/saveSession,
// _listSessionsCache). A "project" holds custom instructions + knowledge
// files and owns a set of chats (sessions), like Claude.ai Projects.
//
// Exposed as a factory so it's testable against a temp dir instead of the
// live projects/ and sessions/ directories.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_KNOWLEDGE_BYTES = 10 * 1024 * 1024; // 10MB per file
const MAX_PROMPT_PER_FILE = 20000;
const MAX_PROMPT_TOTAL = 60000;

const TEXT_MIME_RE = /^text\/|^application\/(json|xml|javascript|typescript)$/i;
const TEXT_EXT_RE = /\.(md|markdown|js|jsx|ts|tsx|py|rb|go|java|c|cpp|h|hpp|cs|rs|sh|bash|zsh|yml|yaml|toml|ini|cfg|conf|csv|tsv|sql|html|htm|css|scss|less|xml|json|txt|log)$/i;

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && ID_RE.test(id);
}

function assertValidId(id, label) {
  if (!isValidId(id)) {
    throw new Error(`Invalid ${label || 'id'}: must match ${ID_RE}`);
  }
}

function isTextish(name, mime) {
  if (mime && TEXT_MIME_RE.test(mime)) return true;
  if (name && TEXT_EXT_RE.test(name)) return true;
  return false;
}

function atomicWriteFileSync(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function getDateGroupSort(a, b) {
  return new Date(b.updatedAt) - new Date(a.updatedAt);
}

/**
 * @param {{projectsDir: string, sessionsDir: string}} opts
 */
function createProjectStore({ projectsDir, sessionsDir }) {
  fs.mkdirSync(projectsDir, { recursive: true });

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  function projectPath(id) {
    assertValidId(id, 'project id');
    return path.join(projectsDir, `${id}.json`);
  }

  function projectKnowledgeDir(id) {
    assertValidId(id, 'project id');
    return path.join(projectsDir, id, 'knowledge');
  }

  function knowledgeFilePath(id, fileId) {
    assertValidId(id, 'project id');
    assertValidId(fileId, 'file id');
    return path.join(projectKnowledgeDir(id), fileId);
  }

  function sessionPath(id) {
    const safe = path.basename(id);
    return path.join(sessionsDir, `${safe}.json`);
  }

  // -------------------------------------------------------------------------
  // Project CRUD
  // -------------------------------------------------------------------------

  function loadProjectRaw(id) {
    if (!isValidId(id)) return null;
    const p = projectPath(id);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (_) {
      return null;
    }
  }

  /*
   * touch:false is for imports, which carry their original claude.ai updatedAt.
   * Every other write bumps it, same as saveSession in server.js.
   */
  function saveProject(project, { touch = true } = {}) {
    if (touch) project.updatedAt = new Date().toISOString();
    atomicWriteFileSync(projectPath(project.id), JSON.stringify(project, null, 2));
    return project;
  }

  function getProject(id) {
    return loadProjectRaw(id);
  }

  function createProject({ name, description, instructions, color, source, sourceId, createdAt, updatedAt } = {}) {
    const now = new Date().toISOString();
    const project = {
      id: uuidv4(),
      name: name || 'Untitled Project',
      description: description || '',
      instructions: instructions || '',
      knowledge: [],
      color: color || '#ff6b35',
      source: source === 'claude.ai' ? 'claude.ai' : 'local',
      sourceId: sourceId || null,
      // Imports carry their original claude.ai dates; local projects stamp now.
      createdAt: createdAt || now,
      updatedAt: updatedAt || createdAt || now,
      pinned: false,
      archived: false,
    };
    fs.mkdirSync(projectKnowledgeDir(project.id), { recursive: true });
    saveProject(project, { touch: false });   // createdAt/updatedAt already resolved above
    return project;
  }

  /*
   * Import-only. Adding knowledge bumps updatedAt, which would show every
   * imported claude.ai project as "just now" and destroy the real recency
   * ordering the operator expects. The importer calls this last to restore the
   * original dates. Deliberately NOT part of the patch surface.
   */
  function setImportedTimestamps(id, { createdAt, updatedAt }) {
    const project = loadProjectRaw(id);
    if (!project) return false;
    if (createdAt) project.createdAt = createdAt;
    if (updatedAt) project.updatedAt = updatedAt;
    saveProject(project, { touch: false });
    return true;
  }

  const PATCHABLE_FIELDS = ['name', 'description', 'instructions', 'color', 'pinned', 'archived'];

  function updateProject(id, patch = {}) {
    const project = loadProjectRaw(id);
    if (!project) return null;
    for (const key of PATCHABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        project[key] = patch[key];
      }
    }
    // Never let a patch overwrite id/createdAt/knowledge, even if the
    // caller passed them.
    saveProject(project);
    return project;
  }

  function detachSessionsFromProject(projectId) {
    let files;
    try {
      files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    } catch (_) {
      return;
    }
    for (const file of files) {
      const full = path.join(sessionsDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(full, 'utf-8'));
      } catch (_) {
        continue;
      }
      if (data.projectId === projectId) {
        data.projectId = null;
        data.updatedAt = new Date().toISOString();
        atomicWriteFileSync(full, JSON.stringify(data, null, 2));
      }
    }
  }

  function deleteProject(id, { hard = false } = {}) {
    const project = loadProjectRaw(id);
    if (!project) return null;

    // Never delete the user's chats — only detach them from the project.
    detachSessionsFromProject(id);

    if (hard) {
      const p = projectPath(id);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      const dir = path.join(projectsDir, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return { ...project, archived: true, deleted: true };
    }

    project.archived = true;
    saveProject(project);
    return project;
  }

  // -------------------------------------------------------------------------
  // Listing (mtime+count cache signature, mirroring server.js's
  // _listSessionsCache so repeated calls don't re-read every file)
  // -------------------------------------------------------------------------

  let _listProjectsCache = { sig: null, data: [] };

  function computeChatCount(projectId, sessionSummaries) {
    let count = 0;
    for (const s of sessionSummaries) {
      if (s.projectId === projectId) count++;
    }
    return count;
  }

  function readSessionSummaries() {
    let files;
    try {
      files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    } catch (_) {
      return [];
    }
    const summaries = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
        summaries.push({
          id: data.id,
          name: data.name,
          updatedAt: data.updatedAt,
          messageCount: (data.messages || []).length,
          projectId: data.projectId || null,
        });
      } catch (_) {
        // skip corrupt files
      }
    }
    return summaries;
  }

  function listProjects({ includeArchived = false } = {}) {
    let files;
    try {
      files = fs.readdirSync(projectsDir).filter(f => f.endsWith('.json'));
    } catch (_) {
      files = [];
    }
    let maxMtime = 0;
    for (const file of files) {
      try {
        const m = fs.statSync(path.join(projectsDir, file)).mtimeMs;
        if (m > maxMtime) maxMtime = m;
      } catch (_) {}
    }
    // Sessions also affect chatCount, so fold their signature in too.
    let sessionFiles = [];
    try {
      sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    } catch (_) {}
    let sessionMaxMtime = 0;
    for (const file of sessionFiles) {
      try {
        const m = fs.statSync(path.join(sessionsDir, file)).mtimeMs;
        if (m > sessionMaxMtime) sessionMaxMtime = m;
      } catch (_) {}
    }
    const sig = `${files.length}:${maxMtime}:${sessionFiles.length}:${sessionMaxMtime}`;

    let all;
    if (_listProjectsCache.sig === sig) {
      all = _listProjectsCache.data;
    } else {
      const sessionSummaries = readSessionSummaries();
      const projects = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(projectsDir, file), 'utf-8');
          const data = JSON.parse(raw);
          projects.push({
            id: data.id,
            name: data.name,
            description: data.description,
            color: data.color,
            source: data.source,
            sourceId: data.sourceId,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            pinned: !!data.pinned,
            archived: !!data.archived,
            chatCount: computeChatCount(data.id, sessionSummaries),
            knowledgeCount: Array.isArray(data.knowledge) ? data.knowledge.length : 0,
            corrupt: false,
          });
        } catch (_) {
          // Skip corrupt files like listSessions does, but still count them
          // so callers can surface it.
          const idGuess = path.basename(file, '.json');
          projects.push({
            id: idGuess,
            name: '(corrupt project)',
            corrupt: true,
            chatCount: 0,
            knowledgeCount: 0,
          });
        }
      }
      projects.sort(getDateGroupSort);
      all = projects;
      _listProjectsCache = { sig, data: all };
    }

    if (includeArchived) return all;
    return all.filter(p => !p.archived);
  }

  // -------------------------------------------------------------------------
  // Knowledge files
  // -------------------------------------------------------------------------

  function addKnowledge(id, { name, mime, buffer, sourceId } = {}) {
    const project = loadProjectRaw(id);
    if (!project) return null;
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('addKnowledge requires a Buffer');
    }
    if (buffer.length > MAX_KNOWLEDGE_BYTES) {
      throw new Error(`Knowledge file exceeds ${MAX_KNOWLEDGE_BYTES} byte (10MB) limit`);
    }

    const fileId = uuidv4();
    const dir = projectKnowledgeDir(id);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(knowledgeFilePath(id, fileId), buffer);

    const entry = {
      id: fileId,
      name: name || fileId,
      mime: mime || 'application/octet-stream',
      bytes: buffer.length,
      addedAt: new Date().toISOString(),
      path: `${id}/knowledge/${fileId}`,
      // Stable identity from the source system. Dedupe must not key on `name`:
      // a filename can change (it did — file_name vs filename), and every
      // renamed doc then re-imported as a duplicate.
      sourceId: sourceId || null,
    };
    project.knowledge = project.knowledge || [];
    project.knowledge.push(entry);
    saveProject(project);
    return entry;
  }

  function removeKnowledge(id, fileId) {
    if (!isValidId(fileId)) return false;
    const project = loadProjectRaw(id);
    if (!project) return false;
    const knowledge = project.knowledge || [];
    const idx = knowledge.findIndex(k => k.id === fileId);
    if (idx === -1) return false;

    const filePath = knowledgeFilePath(id, fileId);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    knowledge.splice(idx, 1);
    project.knowledge = knowledge;
    saveProject(project);
    return true;
  }

  function readKnowledge(id, fileId) {
    if (!isValidId(id) || !isValidId(fileId)) return null;
    const filePath = knowledgeFilePath(id, fileId);
    if (!fs.existsSync(filePath)) return null;
    try {
      return fs.readFileSync(filePath);
    } catch (_) {
      return null;
    }
  }

  function getKnowledgeText(id, fileId) {
    const project = loadProjectRaw(id);
    if (!project) return null;
    const entry = (project.knowledge || []).find(k => k.id === fileId);
    if (!entry) return null;
    if (!isTextish(entry.name, entry.mime)) return null;
    const buf = readKnowledge(id, fileId);
    if (buf == null) return null;
    return buf.toString('utf-8');
  }

  // -------------------------------------------------------------------------
  // Session <-> project linking
  // -------------------------------------------------------------------------

  function assignSession(sessionId, projectId) {
    const p = sessionPath(sessionId);
    if (!fs.existsSync(p)) return false;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (_) {
      return false;
    }
    data.projectId = projectId || null;
    data.updatedAt = new Date().toISOString();
    atomicWriteFileSync(p, JSON.stringify(data, null, 2));
    return true;
  }

  function listProjectSessions(projectId) {
    const summaries = readSessionSummaries();
    return summaries
      .filter(s => s.projectId === projectId)
      .map(({ id, name, updatedAt, messageCount }) => ({ id, name, updatedAt, messageCount }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  // -------------------------------------------------------------------------
  // Prompt assembly
  // -------------------------------------------------------------------------

  /**
   * Score a knowledge file against the user's message.
   *
   * Cheap term overlap, deliberately not embeddings: this runs on every turn and
   * has to be effectively free. Filename matches weigh more than body matches
   * because a file called `vendor-contract-...md` is a strong signal when the user
   * says "acme corp", and a body mention is often incidental.
   */
  function scoreKnowledge(entry, text, terms) {
    if (!terms.length) return 0;
    const name = String(entry.name || '').toLowerCase();
    const body = String(text || '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name.includes(t)) score += 5;
      if (body.includes(t)) score += 1;
    }
    return score;
  }

  function queryTerms(query) {
    if (!query) return [];
    const stop = new Set(['this','that','with','from','have','what','when','where','which',
      'about','into','your','their','they','been','being','does','some','such','only','than',
      'then','just','also','very','both','the','and','for','you','are','can','how','why']);
    const seen = new Set();
    const out = [];
    for (const tok of String(query).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)) {
      if (tok.length < 4 || stop.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= 12) break;
    }
    return out;
  }

  /**
   * Assemble the project's contribution to the system prompt.
   *
   * `query` (the user's current message) turns this from a dump into a
   * retrieval. Injecting every knowledge file on every turn cost ~16k tokens per
   * message on a 16-file project, most of it irrelevant to what was asked. With
   * a query we rank files, inject the top ones in full, and list the rest by
   * name so the model still knows they exist and can ask for one.
   */
  function buildProjectPrompt(id, { query, budget } = {}) {
    const project = loadProjectRaw(id);
    if (!project) return null;

    const hasInstructions = !!(project.instructions && project.instructions.trim());
    const hasDescription = !!(project.description && project.description.trim());
    const knowledge = project.knowledge || [];

    if (!hasInstructions && !hasDescription && knowledge.length === 0) return null;

    const parts = [`--- PROJECT: ${project.name} ---`];
    if (hasDescription) parts.push(project.description.trim());
    if (hasInstructions) parts.push(project.instructions.trim());

    if (knowledge.length > 0) {
      const knowledgeParts = [];
      let total = 0;
      let truncatedTotal = false;

      const terms = queryTerms(query);
      const cap = typeof budget === 'number' ? budget : MAX_PROMPT_TOTAL;

      // Rank when we have something to rank against; otherwise keep stored order.
      let ordered = knowledge;
      const skipped = [];
      if (terms.length) {
        const scored = knowledge.map((entry) => {
          const text = getKnowledgeText(id, entry.id);
          return { entry, text, score: scoreKnowledge(entry, text, terms) };
        });
        scored.sort((a, b) => b.score - a.score);
        const relevant = scored.filter((x) => x.score > 0);
        // Nothing matched: fall back to stored order rather than injecting nothing.
        const chosen = relevant.length ? relevant : scored;
        ordered = chosen.map((x) => x.entry);
        for (const x of scored) {
          if (!chosen.includes(x)) skipped.push(x.entry.name);
        }
      }

      for (const entry of ordered) {
        if (truncatedTotal) break;
        const text = getKnowledgeText(id, entry.id);
        if (text == null) continue; // binary — never inject binary garbage

        let fileText = text;
        let fileTruncated = false;
        if (fileText.length > MAX_PROMPT_PER_FILE) {
          fileText = fileText.slice(0, MAX_PROMPT_PER_FILE);
          fileTruncated = true;
        }

        const remaining = cap - total;
        if (fileText.length > remaining) {
          fileText = fileText.slice(0, Math.max(0, remaining));
          fileTruncated = true;
          truncatedTotal = true;
        }

        total += fileText.length;
        const marker = fileTruncated ? '\n[truncated]' : '';
        knowledgeParts.push(`## ${entry.name}\n${fileText}${marker}`);

        if (total >= cap) {
          truncatedTotal = true;
          // Everything after this point is listed by name below, not dropped silently.
          const idx = ordered.indexOf(entry);
          for (let i = idx + 1; i < ordered.length; i++) skipped.push(ordered[i].name);
        }
      }
      if (knowledgeParts.length > 0) {
        parts.push('--- PROJECT KNOWLEDGE ---');
        parts.push(knowledgeParts.join('\n\n'));
      }
      // Name the files we did NOT inline. Without this the model cannot know
      // they exist, and a silent omission reads as "the project has nothing
      // about that" — the confidently-wrong-empty-answer failure mode.
      const uniqueSkipped = [...new Set(skipped)].filter(Boolean);
      if (uniqueSkipped.length > 0) {
        parts.push(
          '--- OTHER FILES IN THIS PROJECT (not included above; ask if you need one) ---\n' +
          uniqueSkipped.map((n) => `- ${n}`).join('\n')
        );
      }
    }

    return parts.join('\n\n');
  }

  return {
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    addKnowledge,
    removeKnowledge,
    readKnowledge,
    getKnowledgeText,
    assignSession,
    listProjectSessions,
    buildProjectPrompt,
    setImportedTimestamps,
  };
}

module.exports = { createProjectStore };

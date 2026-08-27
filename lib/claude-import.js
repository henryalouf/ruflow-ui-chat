// ---------------------------------------------------------------------------
// claude.ai importer
// ---------------------------------------------------------------------------
// Imports a user's OWN claude.ai account data (projects + conversations)
// into ruflow-ui as projects + sessions. Two input paths:
//   1. parseExport   — the official Settings -> Privacy -> Export Data .zip
//                       (also accepts an already-extracted dir, or a bare
//                       .json file, since the zip format varies by vintage).
//   2. fetchFromApi  — claude.ai's internal (unofficial) API via a session
//                       cookie the user already has. Every response shape is
//                       treated as untrusted — nothing is assumed present.
//
// toRuflow() maps the claude.ai shape onto ruflow's project/session model.
// importAll() persists that mapping idempotently (dedup on sourceId) and
// supports dryRun.
//
// Style note: mirrors lib/projects.js — sync fs, factory-free here since
// there's no per-call directory state to close over until importAll.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const API_BASE = 'https://claude.ai/api';
const API_CONCURRENCY = 4;
const API_BATCH_DELAY_MS = 300;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------------------------------------------------------------------
// parseExport — zip / directory / bare json
// ---------------------------------------------------------------------------

function looksLikeZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/** List member paths inside a zip via the system `unzip` binary. */
function listZipMembers(zipPath) {
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

/** Read one member's raw bytes out of a zip via `unzip -p`. */
function readZipMember(zipPath, member) {
  return execFileSync('unzip', ['-p', zipPath, member], { maxBuffer: 512 * 1024 * 1024 });
}

function findMember(members, basename) {
  const target = basename.toLowerCase();
  return members.find(m => path.basename(m).toLowerCase() === target) || null;
}

/** Tolerant JSON.parse: never throws, reports into warnings instead. */
function safeParseJson(text, label, warnings) {
  if (text == null) return null;
  const trimmed = typeof text === 'string' ? text.trim() : text;
  if (trimmed === '') return null;
  try {
    return typeof trimmed === 'string' ? JSON.parse(trimmed) : trimmed;
  } catch (err) {
    warnings.push(`Could not parse ${label}: ${err.message}`);
    return null;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.projects)) return value.projects;
  if (value && Array.isArray(value.conversations)) return value.conversations;
  return [];
}

/** Guess whether a bare .json file holds conversations or projects. */
function classifyBareJson(data) {
  const arr = Array.isArray(data) ? data : asArray(data);
  if (arr.length === 0) return 'unknown';
  const sample = arr[0] || {};
  if ('chat_messages' in sample) return 'conversations';
  if ('prompt_template' in sample || 'docs' in sample) return 'projects';
  return 'unknown';
}

/**
 * @param {string} input Path to a .zip export, an extracted directory, or a
 *   single conversations.json / projects.json file.
 * @returns {{projects: object[], conversations: object[], warnings: string[]}}
 */
function parseExport(input) {
  const warnings = [];
  let projectsRaw = [];
  let conversationsRaw = [];

  if (!input || typeof input !== 'string') {
    warnings.push('parseExport requires a file or directory path');
    return { projects: [], conversations: [], warnings };
  }
  if (!fs.existsSync(input)) {
    warnings.push(`Path does not exist: ${input}`);
    return { projects: [], conversations: [], warnings };
  }

  const stat = fs.statSync(input);

  if (stat.isDirectory()) {
    const files = fs.readdirSync(input);
    const convFile = files.find(f => f.toLowerCase() === 'conversations.json');
    const projFile = files.find(f => f.toLowerCase() === 'projects.json');
    if (convFile) {
      const text = fs.readFileSync(path.join(input, convFile), 'utf-8');
      conversationsRaw = asArray(safeParseJson(text, convFile, warnings));
    } else {
      warnings.push('No conversations.json found in directory');
    }
    if (projFile) {
      const text = fs.readFileSync(path.join(input, projFile), 'utf-8');
      projectsRaw = asArray(safeParseJson(text, projFile, warnings));
    } else {
      warnings.push('No projects.json found in directory');
    }
    return { projects: projectsRaw, conversations: conversationsRaw, warnings };
  }

  // Single file: either a zip or a bare json.
  const buf = fs.readFileSync(input);
  const isZip = input.toLowerCase().endsWith('.zip') || looksLikeZip(buf);

  if (isZip) {
    let members;
    try {
      members = listZipMembers(input);
    } catch (err) {
      warnings.push(`Could not read zip (${err.message}) — is 'unzip' installed?`);
      return { projects: [], conversations: [], warnings };
    }
    const convMember = findMember(members, 'conversations.json');
    const projMember = findMember(members, 'projects.json');
    if (convMember) {
      try {
        const text = readZipMember(input, convMember).toString('utf-8');
        conversationsRaw = asArray(safeParseJson(text, convMember, warnings));
      } catch (err) {
        warnings.push(`Could not extract ${convMember}: ${err.message}`);
      }
    } else {
      warnings.push('No conversations.json found in export zip');
    }
    if (projMember) {
      try {
        const text = readZipMember(input, projMember).toString('utf-8');
        projectsRaw = asArray(safeParseJson(text, projMember, warnings));
      } catch (err) {
        warnings.push(`Could not extract ${projMember}: ${err.message}`);
      }
    } else {
      warnings.push('No projects.json found in export zip');
    }
    return { projects: projectsRaw, conversations: conversationsRaw, warnings };
  }

  // Bare json file — could be either conversations.json or projects.json.
  const text = buf.toString('utf-8');
  const parsed = safeParseJson(text, path.basename(input), warnings);
  const kind = classifyBareJson(parsed);
  const arr = Array.isArray(parsed) ? parsed : asArray(parsed);
  if (kind === 'conversations') {
    conversationsRaw = arr;
  } else if (kind === 'projects') {
    projectsRaw = arr;
  } else if (arr.length > 0) {
    warnings.push(`Could not determine whether ${path.basename(input)} is projects or conversations — ignoring`);
  }
  return { projects: projectsRaw, conversations: conversationsRaw, warnings };
}

// ---------------------------------------------------------------------------
// fetchFromApi — live claude.ai internal API via session cookie
// ---------------------------------------------------------------------------

function apiHeaders(sessionKey) {
  return {
    Cookie: `sessionKey=${sessionKey}`,
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
}

function diagnoseStatus(status, context) {
  if (status === 401 || status === 403) {
    return `claude.ai returned ${status} — the sessionKey is expired or wrong (${context})`;
  }
  if (status === 429) {
    return `claude.ai returned 429 — rate limited, try again later (${context})`;
  }
  if (status >= 500) {
    return `claude.ai returned ${status} — the service is unavailable right now (${context})`;
  }
  return `claude.ai returned ${status} for ${context}`;
}

async function apiGet(fetchImpl, url, sessionKey, context) {
  let res;
  try {
    res = await fetchImpl(url, { headers: apiHeaders(sessionKey) });
  } catch (err) {
    throw new Error(`Network error calling claude.ai (${context}): ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(diagnoseStatus(res.status, context));
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`claude.ai returned unparseable JSON for ${context}: ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {{sessionKey: string, orgId?: string, onProgress?: Function, fetchImpl?: Function}} opts
 * @returns {Promise<{projects: object[], conversations: object[], warnings: string[]}>}
 */
async function fetchFromApi({ sessionKey, orgId, onProgress, fetchImpl } = {}) {
  const warnings = [];
  const fetcher = fetchImpl || globalThis.fetch;
  if (!sessionKey) {
    throw new Error('fetchFromApi requires a sessionKey');
  }
  if (typeof fetcher !== 'function') {
    throw new Error('No fetch implementation available (Node 20+ or pass fetchImpl)');
  }
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  let org = orgId;
  if (!org) {
    const orgs = await apiGet(fetcher, `${API_BASE}/organizations`, sessionKey, 'GET /organizations');
    const list = Array.isArray(orgs) ? orgs : [];
    if (list.length === 0) {
      throw new Error('claude.ai returned no organizations for this account');
    }
    org = list[0] && list[0].uuid;
    if (!org) {
      throw new Error('claude.ai organization response had no uuid — shape may have changed');
    }
  }
  progress({ stage: 'org', orgId: org });

  let projectsRaw = [];
  try {
    const projects = await apiGet(fetcher, `${API_BASE}/organizations/${org}/projects`, sessionKey, 'GET projects');
    projectsRaw = Array.isArray(projects) ? projects : [];
  } catch (err) {
    warnings.push(err.message);
  }
  progress({ stage: 'projects', count: projectsRaw.length });

  // Docs live behind a per-project endpoint; fetch them and fold into each
  // project so downstream mapping matches the export shape (project.docs[]).
  for (const project of projectsRaw) {
    if (!project || !project.uuid) continue;
    try {
      const docs = await apiGet(
        fetcher,
        `${API_BASE}/organizations/${org}/projects/${project.uuid}/docs`,
        sessionKey,
        `GET docs for project ${project.uuid}`
      );
      project.docs = Array.isArray(docs) ? docs : [];
    } catch (err) {
      warnings.push(err.message);
      project.docs = project.docs || [];
    }
  }

  let conversationList = [];
  try {
    const list = await apiGet(
      fetcher,
      `${API_BASE}/organizations/${org}/chat_conversations`,
      sessionKey,
      'GET chat_conversations'
    );
    conversationList = Array.isArray(list) ? list : [];
  } catch (err) {
    warnings.push(err.message);
  }
  progress({ stage: 'conversation-list', count: conversationList.length });

  const conversationsRaw = [];
  for (let i = 0; i < conversationList.length; i += API_CONCURRENCY) {
    const batch = conversationList.slice(i, i + API_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async summary => {
        const id = summary && summary.uuid;
        if (!id) return null;
        try {
          return await apiGet(
            fetcher,
            `${API_BASE}/organizations/${org}/chat_conversations/${id}`,
            sessionKey,
            `GET conversation ${id}`
          );
        } catch (err) {
          warnings.push(err.message);
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) conversationsRaw.push(r);
    }
    progress({ stage: 'conversations', done: Math.min(i + API_CONCURRENCY, conversationList.length), total: conversationList.length });
    if (i + API_CONCURRENCY < conversationList.length) {
      await sleep(API_BATCH_DELAY_MS);
    }
  }

  return { projects: projectsRaw, conversations: conversationsRaw, warnings };
}

// ---------------------------------------------------------------------------
// toRuflow — pure mapping, no fs
// ---------------------------------------------------------------------------

function mapSender(sender) {
  if (sender === 'human') return 'user';
  if (sender === 'assistant') return 'assistant';
  return sender || 'assistant';
}

/** Prefer content[].text (newer exports); fall back to the flat text field. */
function messageText(msg) {
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const parts = msg.content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text);
    if (parts.length > 0) return parts.join('\n\n');
  }
  if (typeof msg.text === 'string' && msg.text.length > 0) return msg.text;
  return '';
}

function resolveConversationProjectUuid(conv) {
  if (conv.project_uuid) return conv.project_uuid;
  if (conv.project && conv.project.uuid) return conv.project.uuid;
  return null;
}

/**
 * @param {{projects: object[], conversations: object[]}} input Raw claude.ai shapes.
 * @returns {{projects: object[], sessions: object[]}} ruflow-shaped projects/sessions.
 */
function toRuflow({ projects = [], conversations = [] } = {}) {
  const now = new Date().toISOString();
  const rProjects = [];
  const sourceIdToRuflowId = new Map();

  for (const p of projects) {
    if (!p || !p.uuid) continue;
    const id = uuidv4();
    sourceIdToRuflowId.set(p.uuid, id);
    const docs = Array.isArray(p.docs) ? p.docs : [];
    const knowledge = docs
      .filter(d => d && typeof d.content === 'string')
      .map(d => ({
        name: d.filename || d.uuid || 'untitled',
        mime: 'text/plain',
        text: d.content,
      }));

    rProjects.push({
      id,
      name: p.name || 'Untitled Project',
      description: p.description || '',
      instructions: p.prompt_template || '',
      knowledge,
      color: '#ff6b35',
      source: 'claude.ai',
      sourceId: p.uuid,
      createdAt: p.created_at || now,
      updatedAt: p.updated_at || p.created_at || now,
      pinned: false,
      archived: false,
    });
  }

  const rSessions = [];
  for (const conv of conversations) {
    if (!conv || !conv.uuid) continue;
    const messages = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
    const rMessages = messages.map(m => {
      const role = mapSender(m.sender);
      const content = messageText(m);
      const timestamp = m.created_at || m.updated_at || conv.created_at || now;
      const blocks = content ? [{ k: 'say', lane: 'main', seq: 1, text: content }] : [];
      return { role, content, timestamp, toolBlocks: [], blocks };
    });

    const claudeProjectUuid = resolveConversationProjectUuid(conv);
    const projectId = claudeProjectUuid ? sourceIdToRuflowId.get(claudeProjectUuid) || null : null;

    rSessions.push({
      id: uuidv4(),
      name: conv.name || 'Imported chat',
      cliSessionId: null,
      model: 'sonnet',
      messages: rMessages,
      createdAt: conv.created_at || now,
      updatedAt: conv.updated_at || conv.created_at || now,
      projectId,
      source: 'claude.ai',
      sourceId: conv.uuid,
    });
  }

  return { projects: rProjects, sessions: rSessions };
}

// ---------------------------------------------------------------------------
// importAll — persist the mapping idempotently
// ---------------------------------------------------------------------------

function readAllSessionFiles(sessionsDir) {
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8')));
    } catch (_) {
      // skip corrupt session files
    }
  }
  return out;
}

function atomicWriteFileSync(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/**
 * @param {{projects: object[], conversations: object[], warnings?: string[]}} input
 *   Raw output of parseExport() or fetchFromApi().
 * @param {{projectStore?: object, sessionsDir: string, dryRun?: boolean}} opts
 * @returns {{projectsCreated: number, projectsUpdated: number, sessionsCreated: number,
 *   sessionsSkipped: number, warnings: string[], errors: string[]}}
 */
function importAll(input, { projectStore, sessionsDir, dryRun = false } = {}) {
  const warnings = [...(input && input.warnings ? input.warnings : [])];
  const errors = [];
  const report = { projectsCreated: 0, projectsUpdated: 0, sessionsCreated: 0, sessionsSkipped: 0, warnings, errors };

  if (!sessionsDir) {
    errors.push('importAll requires opts.sessionsDir');
    return report;
  }

  let store = projectStore;
  if (!store) {
    const { createProjectStore } = require('./projects');
    store = createProjectStore({ projectsDir: path.join(__dirname, '..', 'projects'), sessionsDir });
  }

  const mapped = toRuflow({ projects: (input && input.projects) || [], conversations: (input && input.conversations) || [] });

  // Existing projects, indexed by sourceId, so re-runs update instead of duplicating.
  let existingProjects = [];
  try {
    existingProjects = store.listProjects({ includeArchived: true });
  } catch (err) {
    errors.push(`Could not list existing projects: ${err.message}`);
  }
  const existingBySourceId = new Map();
  for (const p of existingProjects) {
    if (p.source === 'claude.ai' && p.sourceId) existingBySourceId.set(p.sourceId, p);
  }

  // toRuflow-generated project id -> the id it actually ends up with on disk.
  const finalProjectId = new Map();

  for (const p of mapped.projects) {
    const existing = existingBySourceId.get(p.sourceId);
    if (existing) {
      finalProjectId.set(p.id, existing.id);
      if (!dryRun) {
        try {
          store.updateProject(existing.id, {
            name: p.name,
            description: p.description,
            instructions: p.instructions,
          });
          const full = store.getProject(existing.id);
          const existingNames = new Set((full && full.knowledge || []).map(k => k.name));
          for (const k of p.knowledge) {
            if (existingNames.has(k.name)) continue; // already imported this doc
            store.addKnowledge(existing.id, { name: k.name, mime: k.mime, buffer: Buffer.from(k.text, 'utf-8') });
          }
        } catch (err) {
          errors.push(`Updating project ${p.name}: ${err.message}`);
        }
      }
      report.projectsUpdated++;
    } else {
      if (!dryRun) {
        try {
          const created = store.createProject({
            name: p.name,
            description: p.description,
            instructions: p.instructions,
            source: 'claude.ai',
            sourceId: p.sourceId,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          });
          finalProjectId.set(p.id, created.id);
          for (const k of p.knowledge) {
            try {
              store.addKnowledge(created.id, { name: k.name, mime: k.mime, buffer: Buffer.from(k.text, 'utf-8') });
            } catch (err) {
              errors.push(`Adding knowledge "${k.name}" to project ${p.name}: ${err.message}`);
            }
          }
          // Knowledge writes bump updatedAt — restore the real claude.ai dates last.
          if (typeof store.setImportedTimestamps === 'function') {
            store.setImportedTimestamps(created.id, { createdAt: p.createdAt, updatedAt: p.updatedAt });
          }
        } catch (err) {
          errors.push(`Creating project ${p.name}: ${err.message}`);
          finalProjectId.set(p.id, p.id); // best-effort so sessions still resolve in the report
        }
      } else {
        finalProjectId.set(p.id, p.id); // placeholder — nothing is written in dryRun
      }
      report.projectsCreated++;
    }
  }

  const existingSessions = readAllSessionFiles(sessionsDir);
  const existingSessionSourceIds = new Set(
    existingSessions.filter(s => s.source === 'claude.ai' && s.sourceId).map(s => s.sourceId)
  );

  for (const s of mapped.sessions) {
    if (existingSessionSourceIds.has(s.sourceId)) {
      report.sessionsSkipped++;
      continue;
    }
    const resolvedProjectId = s.projectId ? finalProjectId.get(s.projectId) || null : null;
    const toWrite = { ...s, projectId: resolvedProjectId };
    if (!dryRun) {
      try {
        atomicWriteFileSync(path.join(sessionsDir, `${toWrite.id}.json`), JSON.stringify(toWrite, null, 2));
      } catch (err) {
        errors.push(`Writing session "${toWrite.name}": ${err.message}`);
        continue;
      }
    }
    report.sessionsCreated++;
  }

  return report;
}

module.exports = { parseExport, fetchFromApi, toRuflow, importAll };

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { createEmitStream, createStreamEventProcessor } = require('./lib/stream-events');
const { createProjectStore } = require('./lib/projects');
const { createContextEngine } = require('./lib/project-context');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;
const WORK_DIR = '/home/claude-user/workspace/repos/ruflow/';
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
/*
 * Raised from 5MB for data imports. A claude.ai conversations.json carrying
 * full message bodies for a few hundred chats runs well past the old cap, and
 * the failure surfaced as a bare rejected upload with no usable reason.
 * Images stay at 10MB; this only widens text/data documents.
 */
const DOC_MAX_SIZE = 50 * 1024 * 1024; // 50 MB
const CANCEL_KILL_TIMEOUT = 5000; // ms before SIGKILL after SIGTERM
const HEARTBEAT_FILE = path.join(__dirname, 'HEARTBEAT.md');
const MEMORY_DIR = path.join(__dirname, 'memory');
const MEMORY_FILE = path.join(MEMORY_DIR, 'store.json');
// Overridable so the e2e suite can exercise the real server without writing
// into the operator's live projects directory.
const PROJECTS_DIR = process.env.RUFLOW_PROJECTS_DIR || path.join(__dirname, 'projects');

/*
 * U6-SUBAGENT flags — both one-line revertible, per spec.
 *
 * RUFLOW_SUBAGENT_TEXT: adds --forward-subagent-text to the CLI spawn, which is
 * the entire unlock for subagent visibility (SPEC-v2.md "What the backend can
 * actually observe"). Default on.
 *
 * SUBAGENT_DELTAS: the acceptance-gate escape hatch. The live stream_event
 * envelope's parent_tool_use_id has not been verified against this CLI build
 * (SPEC-v2.md "Verification step before default-on") — if it turns out absent,
 * set this to 'off' to suppress token-level delta routing while any lane is
 * open and derive lane text from the complete `assistant` blocks only, which
 * ARE verified to carry it. Deterministic, slightly less live, never wrong.
 */
const SUBAGENT_TEXT_ON = process.env.RUFLOW_SUBAGENT_TEXT !== 'off';
const SUBAGENT_DELTAS_ON = process.env.SUBAGENT_DELTAS !== 'off';

// ---------------------------------------------------------------------------
// Memory System — persistent cross-session memory with search
// ---------------------------------------------------------------------------

fs.mkdirSync(MEMORY_DIR, { recursive: true });

function loadMemoryStore() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
  } catch (_) {}
  return { entries: [], version: 1 };
}

function saveMemoryStore(store) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
}

function addMemory(key, value, tags = [], source = 'user') {
  const store = loadMemoryStore();
  // Update existing or add new
  const existing = store.entries.findIndex(e => e.key === key);
  const entry = {
    id: uuidv4(),
    key,
    value,
    tags,
    source,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (existing >= 0) {
    entry.id = store.entries[existing].id;
    entry.createdAt = store.entries[existing].createdAt;
    store.entries[existing] = entry;
  } else {
    store.entries.push(entry);
  }
  saveMemoryStore(store);
  return entry;
}

function searchMemory(query, limit = 10) {
  const store = loadMemoryStore();
  const q = query.toLowerCase();
  return store.entries
    .filter(e => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q)))
    .slice(0, limit)
    .map(e => ({ id: e.id, key: e.key, value: e.value.slice(0, 200), tags: e.tags, updatedAt: e.updatedAt }));
}

function deleteMemory(id) {
  const store = loadMemoryStore();
  store.entries = store.entries.filter(e => e.id !== id);
  saveMemoryStore(store);
}

function listMemory(limit = 20) {
  const store = loadMemoryStore();
  return store.entries.slice(-limit).reverse()
    .map(e => ({ id: e.id, key: e.key, value: e.value.slice(0, 200), tags: e.tags, source: e.source, updatedAt: e.updatedAt }));
}

// Auto-extract memories from conversation (simple keyword extraction)
function autoExtractMemory(userText, assistantText, sessionName) {
  // Store significant exchanges as memories
  if (!userText || userText.length < 20) return;
  if (!assistantText || assistantText.length < 50) return;

  // Create a condensed summary as memory
  const key = (sessionName || userText.slice(0, 50)).replace(/\n/g, ' ').trim();
  const value = 'Q: ' + userText.slice(0, 200) + '\nA: ' + assistantText.slice(0, 500);
  const tags = ['auto', 'conversation'];

  // Only store if it seems meaningful (has code, commands, or technical content)
  const isTechnical = /function |class |import |require\(|def |sudo |npm |git |docker |curl /i.test(userText + assistantText);
  if (isTechnical) {
    addMemory(key, value, tags, 'auto');
  }
}

// ---------------------------------------------------------------------------
// AgentDB Integration — sync Ruflow Chat sessions to vector database
// ---------------------------------------------------------------------------

const AGENTDB_DIR = path.join(WORK_DIR, 'scripts/memory-db');
const AGENTDB_SCRIPT = path.join(AGENTDB_DIR, 'lib.js');
const AGENTDB_PATH = path.join(WORK_DIR, 'data/memory/agentdb.sqlite');

/*
 * The vector DB is a SHARED sql.js file. scripts/memory-db/ingest.js, the session
 * hooks and a twice-daily cron all write to it as well.
 *
 * This used to cache one Database in module scope for the life of the process and,
 * on every sync, export that whole in-memory image over the file. Anything another
 * process wrote after ruflow-ui first loaded it was silently destroyed by the next
 * chat message. It also explains why 22 sessions had produced exactly one chat row:
 * errors here are swallowed by a .catch(() => {}) at the call site, so a sync that
 * never worked looked identical to one that did.
 *
 * Now: open the file fresh per sync, apply, write, discard. Still read-modify-write
 * rather than truly concurrent-safe, but the window is milliseconds instead of hours.
 * Writes go through a temp file and rename, which is atomic, so a concurrent reader
 * never sees a half-written database.
 */

let _sqlJs = null;
async function loadSqlJs() {
  if (_sqlJs) return _sqlJs;
  const resolved = require.resolve('sql.js', { paths: [AGENTDB_DIR] });
  _sqlJs = await require(resolved)();
  return _sqlJs;
}

function chunkTextSafe(text) {
  try {
    return require(AGENTDB_SCRIPT).chunkText(text, 500, 100);
  } catch (_) {
    return text ? [text] : [];
  }
}

/** Pair each user message with the assistant reply that follows it. */
function pairExchanges(messages) {
  const pairs = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== 'user') continue;
    let j = i + 1;
    while (j < messages.length && messages[j]?.role !== 'assistant') j++;
    if (j < messages.length) pairs.push({ index: i, user: messages[i], assistant: messages[j] });
  }
  return pairs;
}

// Serialise syncs within this process so it cannot race itself.
let _syncChain = Promise.resolve();

function syncSessionToVectorDb(session) {
  _syncChain = _syncChain.then(() => doSyncSession(session)).catch((e) => {
    console.error('[agentdb] Sync error:', e.message);
  });
  return _syncChain;
}

async function doSyncSession(session) {
  const SQL = await loadSqlJs();
  if (!fs.existsSync(AGENTDB_PATH)) {
    console.error('[agentdb] Sync skipped: database missing at ' + AGENTDB_PATH);
    return;
  }

  // Fresh read, so we build on whatever other processes have written since.
  const db = new SQL.Database(fs.readFileSync(AGENTDB_PATH));
  try {
    const messages = session.messages || [];

    db.run(`INSERT OR REPLACE INTO sessions (id, started_at, summary, topics, model, message_count)
            VALUES (?, ?, ?, ?, ?, ?)`,
      [session.id, session.createdAt, session.name,
       messages.map(m => (m.content || '').slice(0, 100)).join(' | ').slice(0, 500),
       session.model || 'sonnet',
       messages.length]);

    for (const { index, user, assistant } of pairExchanges(messages)) {
      const name = 'chat:' + session.id + ':' + index;
      const userText = user.content || '';
      const assistantText = assistant.content || '';

      /*
       * source_path carries a UNIQUE index (idx_memories_source), and every chat
       * memory here used the literal string 'ruflow-ui'. So all 22 sessions were
       * competing for one row: INSERT OR REPLACE saw the collision, replaced, and
       * reported success. That is the whole reason this database held exactly one
       * 384-character chat memory. It must be unique per exchange.
       */
      const sourcePath = 'ruflow-ui:' + session.id + ':' + index;

      // Full content. It was previously clipped to 300 and 500 characters, which
      // meant recall never saw more than the opening of any substantial answer.
      const content = 'Q: ' + userText + '\nA: ' + assistantText;

      // Re-syncing a growing session must update this exchange, not add another.
      db.run('DELETE FROM search_index WHERE memory_id IN (SELECT id FROM memories WHERE source_path = ?)', [sourcePath]);
      db.run('DELETE FROM memories WHERE source_path = ?', [sourcePath]);

      db.run(`INSERT INTO memories (type, name, description, content, source_path, session_id, tags)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['chat', name, userText.slice(0, 200), content, sourcePath, session.id, 'chat,ruflow-ui']);

      const memoryId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];

      // Chunk properly rather than storing one truncated 2000-character blob.
      const chunks = chunkTextSafe(content);
      chunks.forEach((chunk, ci) => {
        db.run(`INSERT INTO search_index (memory_id, chunk_text, chunk_index, tokens)
                VALUES (?, ?, ?, ?)`, [memoryId, chunk, ci, chunk]);
      });
    }

    const buffer = Buffer.from(db.export());
    const tmp = AGENTDB_PATH + '.tmp-' + process.pid;
    await fs.promises.writeFile(tmp, buffer);
    await fs.promises.rename(tmp, AGENTDB_PATH);
  } finally {
    try { db.close(); } catch (_) {}
  }
}

// Write heartbeat file on startup and every 60 seconds
function writeHeartbeat() {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const sessions = listSessions ? listSessions().length : 0;
  const content = `# Ruflow Chat Heartbeat\n\n` +
    `- **Status**: Running\n` +
    `- **PID**: ${process.pid}\n` +
    `- **Uptime**: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s\n` +
    `- **Memory**: ${Math.round(mem.rss / 1024 / 1024)}MB RSS\n` +
    `- **Sessions**: ${sessions}\n` +
    `- **Last Beat**: ${new Date().toISOString()}\n` +
    `- **Port**: ${PORT}\n` +
    `- **Working Dir**: ${WORK_DIR}\n`;
  try { fs.writeFileSync(HEARTBEAT_FILE, content); } catch (_) {}
}

const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const ALLOWED_DOC_EXTS = new Set(['.pdf', '.txt', '.md', '.js', '.ts', '.json', '.py', '.html', '.css']);

// ---------------------------------------------------------------------------
// Ensure required directories exist
// ---------------------------------------------------------------------------

for (const dir of [SESSIONS_DIR, UPLOADS_DIR, PUBLIC_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Smart Skill Router — auto-detects task type and loads relevant skills
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.join(WORK_DIR, '.agents/skills/antigravity-awesome-skills/skills');

const SKILL_ROUTES = [
  {
    patterns: [/codebase.*structure|explain.*code|refactor.*module|which file.*handles|entry.?point|god.?node|how.*architecture|code.*organized|module.*depends/i],
    skills: [],
    instructions: `CODE ARCHITECTURE QUESTION — read graphify-out/GRAPH_REPORT.md for god nodes and community structure before answering. The graph has 2,094 nodes across 42 communities.`
  },
  {
    patterns: [/redesign|website|landing.?page|web.?page|html.*css|build.*site|frontend|UI|homepage|hero.?section/i],
    skills: ['ui-ux-pro-max', 'frontend-design', 'theme-factory', 'landing-page-generator', 'wcag-audit-patterns', 'seo-technical'],
    instructions: `WEBSITE/DESIGN TASK DETECTED. You MUST:
1. If a URL is provided, fetch it with WebFetch first to understand the existing site
2. NEVER use dark/neon/cyberpunk themes unless explicitly requested. Default to clean, professional, light design
3. Ask about brand colors, target audience, and tone BEFORE coding if not provided
4. Use professional fonts (Inter, DM Sans, Geist, Poppins) — never monospace for body
5. Make it mobile responsive (375px, 768px, 1024px, 1440px)
6. WCAG AA: 4.5:1 contrast, 44px touch targets, semantic HTML
7. Write real copy from the site content — no lorem ipsum
8. Include: hero, features/services, about, testimonials, CTA, footer
9. Present your design approach BEFORE coding — get approval first
10. Run accessibility check on the output`
  },
  {
    patterns: [/react|next\.?js|vue|angular|svelte|component|state.?management/i],
    skills: ['react-best-practices', 'react-patterns', 'nextjs-best-practices', 'frontend-developer', 'typescript-pro'],
    instructions: `FRONTEND FRAMEWORK TASK DETECTED. Follow the skill best practices for components, state management, and performance.`
  },
  {
    patterns: [/api|endpoint|rest|graphql|backend|server|express|fastapi|django/i],
    skills: ['api-design-principles', 'api-patterns', 'backend-dev-guidelines', 'api-security-best-practices'],
    instructions: `API/BACKEND TASK DETECTED. Follow RESTful design, proper error handling, input validation, and security patterns.`
  },
  {
    patterns: [/security|pentest|vulnerability|audit|owasp|xss|sql.?inject|auth/i],
    skills: ['security-auditor', 'ethical-hacking-methodology', 'top-web-vulnerabilities', 'api-security-best-practices'],
    instructions: `SECURITY TASK DETECTED. Follow the security skill methodology systematically.`
  },
  {
    patterns: [/docker|kubernetes|k8s|deploy|ci.?cd|pipeline|terraform|aws|gcp|azure/i],
    skills: ['docker-expert', 'kubernetes-architect', 'terraform-specialist', 'deployment-procedures'],
    instructions: `DEVOPS/INFRA TASK DETECTED. Follow infrastructure best practices from the skills.`
  },
  {
    patterns: [/test|spec|coverage|unit.?test|e2e|playwright|jest|pytest/i],
    skills: ['test-driven-development', 'e2e-testing-patterns', 'testing-patterns'],
    instructions: `TESTING TASK DETECTED. Follow TDD methodology from the skills.`
  },
  {
    patterns: [/python|pip|flask|django|pandas|numpy/i],
    skills: ['python-pro', 'python-patterns', 'python-testing-patterns'],
    instructions: `PYTHON TASK DETECTED. Follow Pythonic best practices from the skills.`
  },
  {
    patterns: [/seo|search.?engine|meta.?tag|sitemap|schema.?markup|ranking/i],
    skills: ['seo-audit', 'seo-technical', 'seo-content', 'seo-schema'],
    instructions: `SEO TASK DETECTED. Run a systematic audit using the SEO skills.`
  },
  {
    patterns: [/database|sql|postgres|mongo|redis|schema|migration/i],
    skills: ['database-design', 'postgresql', 'nosql-expert'],
    instructions: `DATABASE TASK DETECTED. Follow data modeling best practices from the skills.`
  },
  {
    patterns: [/mobile|react.?native|ios|android|flutter|expo/i],
    skills: ['react-native-architecture', 'mobile-design', 'mobile-developer'],
    instructions: `MOBILE TASK DETECTED. Follow mobile-first patterns from the skills.`
  },
];

// Load skills index once at startup for fast searching
let skillsIndex = [];
try {
  const indexPath = path.join(WORK_DIR, '.agents/skills/antigravity-awesome-skills/skills_index.json');
  if (fs.existsSync(indexPath)) {
    skillsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    console.log('[skills] Loaded', skillsIndex.length, 'skills from index');
  }
} catch (e) {
  console.error('[skills] Failed to load index:', e.message);
}

function detectSkillsForMessage(userText) {
  const matched = [];
  // First: check hardcoded routes for critical task types
  for (const route of SKILL_ROUTES) {
    if (route.patterns.some(p => p.test(userText))) {
      matched.push(route);
    }
  }
  return matched;
}

// Dynamic skill search — find relevant skills from the 1,330+ index
function searchSkillsForMessage(userText, limit = 5) {
  if (!skillsIndex.length) return [];
  const words = userText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (words.length === 0) return [];

  const scored = skillsIndex.map(skill => {
    const text = ((skill.name || '') + ' ' + (skill.description || '') + ' ' + (skill.tags || []).join(' ')).toLowerCase();
    let score = 0;
    for (const word of words) {
      if (text.includes(word)) score++;
      if ((skill.name || '').toLowerCase().includes(word)) score += 2; // name match is stronger
    }
    return { skill, score };
  }).filter(s => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.skill);
}

function loadSkillContent(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  try {
    if (fs.existsSync(skillPath)) {
      const content = fs.readFileSync(skillPath, 'utf-8');
      // Load first section — key guidelines
      return content.slice(0, 1500);
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

/* ---------------------------------------------------------------------------
 * Access gate
 *
 * This process listens on 0.0.0.0 and spawns the Claude CLI with
 * --dangerously-skip-permissions as claude-user. Until this gate existed there
 * was no authentication of any kind, no Origin check, and CORS was '*', so
 * anyone who reached the public address could drive an agent with no permission
 * prompts and full filesystem access on a box that holds an SSH key to another
 * server, Pinata credentials, Supabase keys and Google OAuth tokens.
 *
 * A single shared token is the right weight here: this is a personal tool with
 * one operator, and anything heavier would not get used. The token is generated
 * on first boot into ruflow-ui/.env, which is gitignored.
 *
 * Set RUFLOW_OPEN=1 to bypass, which is only sane when bound to localhost.
 * ------------------------------------------------------------------------- */

const ENV_FILE = path.join(__dirname, '.env');

function loadEnvFile() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
}
loadEnvFile();

const OPEN_MODE = process.env.RUFLOW_OPEN === '1';

function ensureToken() {
  if (process.env.RUFLOW_TOKEN) return process.env.RUFLOW_TOKEN;
  const token = require('crypto').randomBytes(24).toString('base64url');
  try {
    fs.appendFileSync(ENV_FILE, `${fs.existsSync(ENV_FILE) ? '' : ''}RUFLOW_TOKEN=${token}\n`, { mode: 0o600 });
    fs.chmodSync(ENV_FILE, 0o600);
  } catch (e) {
    console.error('[auth] Could not persist token to .env:', e.message);
  }
  process.env.RUFLOW_TOKEN = token;
  return token;
}

const ACCESS_TOKEN = OPEN_MODE ? null : ensureToken();
const COOKIE_NAME = 'ruflow_token';

/** Constant-time compare, so a wrong token cannot be narrowed by timing. */
function tokenMatches(candidate) {
  if (!candidate || !ACCESS_TOKEN) return false;
  const crypto = require('crypto');
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenFromRequest(req) {
  const cookie = /(?:^|;\s*)ruflow_token=([^;]+)/.exec(req.headers.cookie || '');
  if (cookie) return decodeURIComponent(cookie[1]);
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('k');
  } catch (_) { return null; }
}

/** Same-origin only. A token in a cookie is otherwise usable by any page. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client, already token-gated
  try {
    return new URL(origin).host === req.headers.host;
  } catch (_) { return false; }
}

app.use((req, res, next) => {
  // Same-origin only; '*' plus a cookie is a standing invitation.
  const origin = req.headers.origin;
  if (origin && originAllowed(req)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Liveness only — no session data, so monitoring does not need the token.
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

app.use((req, res, next) => {
  if (OPEN_MODE) return next();

  const supplied = tokenFromRequest(req);
  if (tokenMatches(supplied)) {
    // Promote a ?k= token to a cookie once, then drop it from the URL so it
    // stops appearing in history, referrers and any proxy log.
    const fromQuery = !/(?:^|;\s*)ruflow_token=/.test(req.headers.cookie || '');
    if (fromQuery) {
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(supplied)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      const clean = req.url.replace(/([?&])k=[^&]*(&|$)/, '$1').replace(/[?&]$/, '');
      if (clean !== req.url) return res.redirect(302, clean || '/');
    }
    return next();
  }

  res.status(401).type('html').send(`<!doctype html><meta charset="utf8">
<title>Ruflow — locked</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#131215;color:#EDEAE6;
      font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
 main{max-width:38rem;padding:0 1.5rem}
 h1{font-size:1.35rem;margin:0 0 .6rem;letter-spacing:-.02em}
 p{color:#9A938C;margin:.6rem 0}
 code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#232027;padding:.15em .45em;border-radius:3px;color:#EDEAE6}
</style>
<main>
 <h1>Ruflow is locked</h1>
 <p>Append your access token to the URL once and it will be remembered on this device:</p>
 <p><code>${req.headers.host ? 'http://' + req.headers.host : ''}/?k=YOUR_TOKEN</code></p>
 <p>The token is in <code>ruflow-ui/.env</code> as <code>RUFLOW_TOKEN</code>, or run
 <code>pm2 logs ruflow-ui</code> and look for the unlock line printed at startup.</p>
</main>`);
});

app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// File upload endpoint
// ---------------------------------------------------------------------------

const upload = multer({
  dest: UPLOADS_DIR,
  // Must be the larger of the two caps — multer rejects before handleUpload
  // runs, so a low value here silently overrides DOC_MAX_SIZE.
  limits: { fileSize: Math.max(IMAGE_MAX_SIZE, DOC_MAX_SIZE) },
});

function handleUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const originalName = req.file.originalname;
    const ext = path.extname(originalName).toLowerCase();

    // Sanitize — prevent directory traversal
    const safeName = path.basename(originalName);

    const isImage = ALLOWED_IMAGE_EXTS.has(ext);
    const isDoc = ALLOWED_DOC_EXTS.has(ext);

    if (!isImage && !isDoc) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `File type ${ext} not allowed` });
    }

    if (isDoc && req.file.size > DOC_MAX_SIZE) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Document exceeds 5MB limit' });
    }

    const storedName = `${uuidv4()}-${safeName}`;
    const storedPath = path.join(UPLOADS_DIR, storedName);
    fs.renameSync(req.file.path, storedPath);

    const result = {
      filename: storedName,
      originalName: safeName,
      size: req.file.size,
      path: storedPath,
    };

    // For document files, read and include text content
    if (isDoc && ext !== '.pdf') {
      try {
        result.content = fs.readFileSync(storedPath, 'utf-8');
      } catch (_) {
        // binary or unreadable — skip content
      }
    }

    return res.json(result);
  } catch (err) {
    console.error('[upload] error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
}

// Multer error handler wrapper
function uploadMiddleware(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds maximum size limit (10MB)' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}

app.post('/upload', uploadMiddleware, handleUpload);
app.post('/api/upload', uploadMiddleware, handleUpload);

// ---------------------------------------------------------------------------
// Project knowledge files
//
// Kept on HTTP rather than the WebSocket because these are multipart bodies and
// can be megabytes — pushing them through the socket would block the stream that
// every live turn depends on.
// ---------------------------------------------------------------------------

const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.post('/api/projects/:id/knowledge', (req, res) => {
  knowledgeUpload.single('file')(req, res, (err) => {
    if (err) {
      // multer's own limit error is the 10MB cap; report it as such rather than a 500.
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'File exceeds the 10MB limit' : err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
      const entry = projectStore.addKnowledge(req.params.id, {
        name: path.basename(req.file.originalname || 'file'),
        mime: req.file.mimetype || 'application/octet-stream',
        buffer: req.file.buffer,
      });
      if (!entry) return res.status(404).json({ error: 'Project not found' });
      res.json({ ok: true, file: entry });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

app.delete('/api/projects/:id/knowledge/:fileId', (req, res) => {
  try {
    const ok = projectStore.removeKnowledge(req.params.id, req.params.fileId);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/projects/:id/knowledge/:fileId', (req, res) => {
  try {
    const buf = projectStore.readKnowledge(req.params.id, req.params.fileId);
    if (!buf) return res.status(404).json({ error: 'Not found' });
    const proj = projectStore.getProject(req.params.id);
    const meta = (proj && proj.knowledge || []).find(k => k.id === req.params.fileId);
    res.type((meta && meta.mime) || 'application/octet-stream');
    // Never let a stored filename drive an inline render.
    res.setHeader('Content-Disposition', 'attachment');
    res.send(buf);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Health check endpoint
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    sessions: listSessions().length,
    version: '1.0.0'
  });
});

app.get('/api/memory', (req, res) => {
  const q = req.query.q;
  if (q) {
    res.json({ results: searchMemory(q, parseInt(req.query.limit) || 10) });
  } else {
    res.json({ entries: listMemory(parseInt(req.query.limit) || 20) });
  }
});

app.post('/api/memory', express.json(), (req, res) => {
  const { key, value, tags } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'key and value required' });
  res.json({ entry: addMemory(key, value, tags || [], 'api') });
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = http.createServer(app);

/*
 * The socket is the actual control channel — it is what reaches handleChat and
 * therefore what spawns the CLI. Gating only the HTTP side would leave the door
 * open, since a WebSocket can be opened directly without ever loading the page.
 *
 * Origin is checked as well as the token: a cookie alone is presentable by any
 * site the operator visits, and WebSockets are not covered by the same-origin
 * policy, so a token-only check would still allow cross-site drive-by control.
 */
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_SIZE,
  verifyClient({ req, origin }, done) {
    if (OPEN_MODE) return done(true);
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch (_) {}
      if (!ok) {
        console.warn('[auth] WS rejected, cross-origin:', origin);
        return done(false, 403, 'Forbidden');
      }
    }
    if (!tokenMatches(tokenFromRequest(req))) {
      console.warn('[auth] WS rejected, bad or missing token from', req.socket.remoteAddress);
      return done(false, 401, 'Unauthorized');
    }
    done(true);
  },
});

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function sessionPath(id) {
  // Sanitize to prevent directory traversal
  const safe = path.basename(id);
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

function loadSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

/** Disk-side fallback for fetch_tool_output — walks every message's blocks[]
 *  (U2-PERSIST), descending into agent blocks for subagent-lane tool calls. */
function findToolOutputInMessages(messages, toolId) {
  for (const m of messages || []) {
    const found = searchBlocksForTool(m.blocks, toolId);
    if (found != null) return found;
  }
  return null;
}

function searchBlocksForTool(blockList, toolId) {
  for (const b of blockList || []) {
    if (b.k === 'act' && b.toolId === toolId) return b.output;
    if (b.k === 'agent') {
      const nested = searchBlocksForTool(b.blocks, toolId);
      if (nested != null) return nested;
    }
  }
  return null;
}

const TRASH_DIR = path.join(__dirname, 'sessions', '.trash');
fs.mkdirSync(TRASH_DIR, { recursive: true });

/* Projects: instructions + knowledge + the second-brain context feed. */
const projectStore = createProjectStore({ projectsDir: PROJECTS_DIR, sessionsDir: SESSIONS_DIR });
const contextEngine = createContextEngine({
  repoRoot: WORK_DIR,
  graphPath: path.join(WORK_DIR, 'graphify-out', 'graph.json'),
  agentdbSearchScript: path.join(WORK_DIR, 'scripts', 'memory-db', 'search.js'),
  brainMemoryDir: path.join(WORK_DIR, '.brain-memory'),
});

function deleteSessionFile(id) {
  // Don't actually delete — mark as archived
  const session = loadSession(id);
  if (session) {
    session.archived = true;
    session.archivedAt = new Date().toISOString();
    saveSession(session);
  }
}

function permanentDeleteSession(id) {
  const p = sessionPath(id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// Auto-cleanup trash older than 7 days
function cleanupTrash() {
  try {
    const files = fs.readdirSync(TRASH_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(TRASH_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    }
  } catch (_) {}
}
setInterval(cleanupTrash, 24 * 60 * 60 * 1000); // daily

function getDateGroup(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Past 7 Days';
  if (days < 30) return 'Past 30 Days';
  return 'Older';
}

/*
 * listSessions() used to readFileSync + JSON.parse every session file on
 * every call, and it is called from /api/health, get_status, list_sessions,
 * broadcastSessionUpdate after every turn, AND writeHeartbeat on a 60s timer
 * — ~1.3MB of parsing on a forever-loop whether or not anything changed.
 *
 * The cache key is cheap metadata only (file count + latest mtime, via
 * readdir + stat, no file content read) so a call between two turns that
 * touched no session file is nearly free, while any save — including one
 * from another process — is still picked up on the very next call.
 */
let _listSessionsCache = { sig: null, data: [] };

function listSessions() {
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  let maxMtime = 0;
  for (const file of files) {
    try {
      const m = fs.statSync(path.join(SESSIONS_DIR, file)).mtimeMs;
      if (m > maxMtime) maxMtime = m;
    } catch (_) {}
  }
  const sig = files.length + ':' + maxMtime;
  if (_listSessionsCache.sig === sig) return _listSessionsCache.data;

  const sessions = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
      const data = JSON.parse(raw);
      sessions.push({
        id: data.id,
        name: data.name,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: (data.messages || []).length,
        group: getDateGroup(data.updatedAt),
        pinned: !!data.pinned,
        archived: !!data.archived,
        projectId: data.projectId || null,
      });
    } catch (_) {
      // skip corrupt files
    }
  }
  // Sort newest first
  sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  _listSessionsCache = { sig, data: sessions };
  return sessions;
}

function createSession(model) {
  const session = {
    id: uuidv4(),
    name: 'New Chat',
    cliSessionId: null,
    model: model || 'sonnet',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveSession(session);
  return session;
}

// ---------------------------------------------------------------------------
// Broadcast to all connected clients (live sync)
// ---------------------------------------------------------------------------

function broadcast(data, excludeWs) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(msg);
    }
  });
}

function broadcastSessionUpdate() {
  const sessions = listSessions();
  broadcast({ type: 'session_list', sessions });
}

// ---------------------------------------------------------------------------
// WebSocket connection handler
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  let activeProcess = null;
  let killTimer = null;
  const messageQueue = [];
  let processing = false;
  // The stream-events processor for the current (or most recently finished)
  // run — fetch_tool_output reads full tool output out of it before falling
  // back to the session file. See handleFetchToolOutput.
  let currentProcessor = null;

  function send(obj) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function cleanupProcess() {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    activeProcess = null;
    // Process next queued message if any
    if (messageQueue.length > 0) {
      const next = messageQueue.shift();
      setImmediate(() => handleChat(next));
    }
  }

  ws.on('close', () => {
    if (activeProcess) {
      try { activeProcess.kill('SIGTERM'); } catch (_) {}
      cleanupProcess();
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return send({ type: 'error', message: 'Invalid JSON' });
    }

    try {
      handleMessage(msg);
    } catch (err) {
      console.error('[ws] handler error:', err);
      send({ type: 'error', message: err.message || 'Internal error' });
    }
  });

  function handleMessage(msg) {
    switch (msg.type) {
      case 'list_sessions':
        return send({ type: 'session_list', sessions: listSessions() });

      case 'load_session':
        return handleLoadSession(msg);

      case 'delete_session':
        return handleDeleteSession(msg);

      case 'restore_session':
        return handleRestoreSession(msg);

      case 'list_trash':
        return handleListTrash();

      case 'rename_session':
        return handleRenameSession(msg);

      case 'pin_session':
        return handlePinSession(msg);

      case 'unpin_session':
        return handleUnpinSession(msg);

      case 'update_system_prompt':
        return handleUpdateSystemPrompt(msg);

      case 'auto_title':
        return handleAutoTitle(msg);

      case 'export_session':
        return handleExportSession(msg);

      case 'search_sessions':
        return handleSearchSessions(msg);

      case 'fetch_tool_output':
        return handleFetchToolOutput(msg);

      case 'memory_add':
        return send({ type: 'memory_added', entry: addMemory(msg.key, msg.value, msg.tags || [], msg.source || 'user') });

      case 'memory_search':
        return send({ type: 'memory_results', results: searchMemory(msg.query || '', msg.limit || 10) });

      case 'memory_list':
        return send({ type: 'memory_list', entries: listMemory(msg.limit || 20) });

      case 'memory_delete':
        deleteMemory(msg.id);
        return send({ type: 'memory_deleted', id: msg.id });

      case 'memory_clear':
        saveMemoryStore({ entries: [], version: 1 });
        return send({ type: 'memory_cleared' });

      case 'get_status':
        return send({
          type: 'status_info',
          gateway: { uptime: process.uptime(), memory: process.memoryUsage(), pid: process.pid },
          session: msg.sessionId ? (() => { const s = loadSession(msg.sessionId); return s ? { id: s.id, name: s.name, model: s.model, messageCount: (s.messages||[]).length, cliSessionId: s.cliSessionId, createdAt: s.createdAt } : null; })() : null,
          activeSessions: listSessions().length,
          workDir: WORK_DIR
        });

      case 'compact_session':
        return handleCompactSession(msg);

      case 'get_session_stats':
        return handleSessionStats(msg);

      case 'duplicate_session':
        return handleDuplicateSession(msg);

      case 'edit_message':
        return handleEditMessage(msg);

      case 'regenerate':
        return handleRegenerate(msg);

      case 'chat':
        if (activeProcess) {
          if (!msg.sessionId) {
            // New chat — kill old process and start fresh
            messageQueue.length = 0;
            try { activeProcess.kill('SIGTERM'); } catch (_) {}
            // Wait briefly for cleanup, then start new chat
            setTimeout(() => {
              cleanupProcess();
              handleChat(msg);
            }, 500);
          } else {
            // Same session — queue the message
            messageQueue.push(msg);
            send({ type: 'chat_queued', position: messageQueue.length });
          }
        } else {
          handleChat(msg);
        }
        return;

      case 'list_projects':
        return send({ type: 'projects', projects: projectStore.listProjects({ includeArchived: !!msg.includeArchived }) });

      case 'get_project':
        return handleGetProject(msg);

      case 'create_project':
        return handleCreateProject(msg);

      case 'update_project':
        return handleUpdateProject(msg);

      case 'delete_project':
        return handleDeleteProject(msg);

      case 'assign_session':
        return handleAssignSession(msg);

      case 'project_context':
        return handleProjectContext(msg);

      case 'unarchive_session':
        return handleUnarchiveSession(msg);

      case 'permanent_delete_session':
        return handlePermanentDelete(msg);

      case 'cancel':
        // Clear the queue too
        messageQueue.length = 0;
        return handleCancel();

      default:
        return send({ type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  // --- Session operations ---------------------------------------------------

  function handleListTrash() {
    try {
      const files = fs.readdirSync(TRASH_DIR).filter(f => f.endsWith('.json'));
      const trashItems = [];
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(TRASH_DIR, f), 'utf-8'));
          trashItems.push({ file: f, id: data.id, name: data.name, deletedAt: fs.statSync(path.join(TRASH_DIR, f)).mtimeMs });
        } catch (_) {}
      }
      trashItems.sort((a, b) => b.deletedAt - a.deletedAt);
      send({ type: 'trash_list', items: trashItems });
    } catch (_) {
      send({ type: 'trash_list', items: [] });
    }
  }

  function handleRestoreSession(msg) {
    const fileName = msg.file;
    if (!fileName) return send({ type: 'error', message: 'No file specified' });
    const trashPath = path.join(TRASH_DIR, path.basename(fileName));
    if (!fs.existsSync(trashPath)) return send({ type: 'error', message: 'File not found in trash' });
    try {
      const data = JSON.parse(fs.readFileSync(trashPath, 'utf-8'));
      const restorePath = sessionPath(data.id);
      fs.renameSync(trashPath, restorePath);
      send({ type: 'session_restored', session: { id: data.id, name: data.name } });
      broadcastSessionUpdate();
    } catch (e) {
      send({ type: 'error', message: 'Failed to restore: ' + e.message });
    }
  }

  function handleUnarchiveSession(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) return send({ type: 'error', message: 'Session not found' });
    session.archived = false;
    delete session.archivedAt;
    saveSession(session);
    send({ type: 'session_unarchived', sessionId: msg.sessionId });
    broadcastSessionUpdate();
  }

  function handlePermanentDelete(msg) {
    permanentDeleteSession(msg.sessionId);
    send({ type: 'session_deleted', sessionId: msg.sessionId });
    broadcast({ type: 'session_deleted', sessionId: msg.sessionId }, ws);
    broadcastSessionUpdate();
  }

  function handleLoadSession(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) {
      return send({ type: 'error', message: 'Session not found' });
    }
    send({ type: 'session_loaded', session });
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  function sendProjectList() {
    const projects = projectStore.listProjects({});
    send({ type: 'projects', projects });
    broadcast({ type: 'projects', projects }, ws);
  }

  function handleGetProject(msg) {
    const project = projectStore.getProject(msg.id);
    if (!project) return send({ type: 'error', message: 'Project not found' });
    send({ type: 'project', project, sessions: projectStore.listProjectSessions(msg.id) });
  }

  function handleCreateProject(msg) {
    const name = String(msg.name || '').trim();
    if (!name) return send({ type: 'error', message: 'Project name is required' });
    const project = projectStore.createProject({
      name,
      description: msg.description || '',
      instructions: msg.instructions || '',
      color: msg.color,
    });
    send({ type: 'project_created', project });
    sendProjectList();
  }

  function handleUpdateProject(msg) {
    const project = projectStore.updateProject(msg.id, msg.patch || {});
    if (!project) return send({ type: 'error', message: 'Project not found' });
    // The ack the UI's save indicator waits on. Only sent after the write lands.
    send({ type: 'project_updated', project });
    sendProjectList();
  }

  function handleDeleteProject(msg) {
    const ok = projectStore.deleteProject(msg.id, { hard: !!msg.hard });
    if (!ok) return send({ type: 'error', message: 'Project not found' });
    send({ type: 'project_deleted', id: msg.id });
    sendProjectList();
    broadcastSessionUpdate();
  }

  function handleAssignSession(msg) {
    const ok = projectStore.assignSession(msg.sessionId, msg.projectId || null);
    if (!ok) return send({ type: 'error', message: 'Session not found' });
    send({ type: 'session_assigned', sessionId: msg.sessionId, projectId: msg.projectId || null });
    sendProjectList();
    broadcastSessionUpdate();
  }

  function handleProjectContext(msg) {
    const project = projectStore.getProject(msg.id);
    if (!project) return send({ type: 'error', message: 'Project not found' });
    /*
     * Graph extraction touches a 52MB file behind a cache. Never let a slow or
     * broken context read take the socket down — the panel degrades to empty.
     */
    try {
      const ctx = contextEngine.projectContext(project, { recentText: msg.query || '' });
      send({ type: 'project_context', id: msg.id, memory: ctx.memory, graph: ctx.graph, brain: ctx.brain });
    } catch (e) {
      console.warn('[projects] context failed:', e.message);
      send({ type: 'project_context', id: msg.id, memory: [], graph: { nodes: [], edges: [], stats: {} }, brain: [], error: e.message });
    }
  }

  function handleDeleteSession(msg) {
    deleteSessionFile(msg.sessionId);
    send({ type: 'session_deleted', sessionId: msg.sessionId });
    broadcast({ type: 'session_deleted', sessionId: msg.sessionId }, ws);
    broadcastSessionUpdate();
  }

  function handleRenameSession(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) {
      return send({ type: 'error', message: 'Session not found' });
    }
    session.name = msg.name;
    saveSession(session);
    send({ type: 'session_renamed', sessionId: msg.sessionId, name: msg.name });
    broadcast({ type: 'session_renamed', sessionId: msg.sessionId, name: msg.name }, ws);
    broadcastSessionUpdate();
  }

  function handleExportSession(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) return send({ type: 'error', message: 'Session not found' });
    let md = `# ${session.name}\n\n`;
    for (const m of session.messages || []) {
      if (m.role === 'user') {
        md += `## User\n\n${m.content}\n\n`;
      } else {
        md += `## Assistant\n\n${m.content}\n\n`;
        for (const tb of m.toolBlocks || []) {
          md += `> **${tb.toolName}**\n`;
          if (tb.toolInput) md += `> Input: \`${JSON.stringify(tb.toolInput).slice(0, 200)}\`\n`;
          md += '\n';
        }
      }
    }
    send({ type: 'session_exported', sessionId: msg.sessionId, markdown: md });
  }

  function handleSearchSessions(msg) {
    const query = (msg.query || '').toLowerCase();
    if (!query) return send({ type: 'search_results', results: [] });
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const results = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
        const nameMatch = (data.name || '').toLowerCase().includes(query);
        const contentMatch = (data.messages || []).some(m =>
          (m.content || '').toLowerCase().includes(query)
        );
        if (nameMatch || contentMatch) {
          results.push({ id: data.id, name: data.name, updatedAt: data.updatedAt,
            messageCount: (data.messages || []).length });
        }
      } catch (_) {}
    }
    send({ type: 'search_results', results });
  }

  /*
   * fetch_tool_output — the client's escape hatch past TOOL_OUTPUT_WIRE_CHARS.
   * Checks the in-memory map for the run that produced it first (cheap, still
   * warm); falls back to the session file's persisted blocks[] (U2-PERSIST)
   * once the process has exited and the map is gone or was overwritten by a
   * later run on this same connection.
   */
  function handleFetchToolOutput(msg) {
    const toolId = msg.toolId;
    if (!toolId) return send({ type: 'error', message: 'toolId required' });

    if (currentProcessor) {
      const live = currentProcessor.getFullToolOutput(toolId);
      if (live != null) return send({ type: 'tool_output_full', toolId, content: live });
    }

    if (msg.sessionId) {
      const session = loadSession(msg.sessionId);
      const fromDisk = session && findToolOutputInMessages(session.messages, toolId);
      if (fromDisk != null) return send({ type: 'tool_output_full', toolId, content: fromDisk });
    }

    send({ type: 'tool_output_full', toolId, content: null });
  }

  function handlePinSession(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) return send({ type: 'error', message: 'Session not found' });
    session.pinned = true;
    saveSession(session);
    send({ type: 'session_pinned', sessionId: msg.sessionId });
    broadcastSessionUpdate();
  }

  function handleUnpinSession(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) return send({ type: 'error', message: 'Session not found' });
    session.pinned = false;
    saveSession(session);
    send({ type: 'session_unpinned', sessionId: msg.sessionId });
    broadcastSessionUpdate();
  }

  function handleUpdateSystemPrompt(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) return send({ type: 'error', message: 'Session not found' });
    session.systemPrompt = msg.prompt || '';
    saveSession(session);
    send({ type: 'system_prompt_updated', sessionId: msg.sessionId });
  }

  function handleAutoTitle(msg) {
    // This uses claude to generate a title — we'll just do a simple extraction
    const session = loadSession(msg.sessionId);
    if (!session || !session.messages || session.messages.length < 2) return;
    const firstUser = session.messages.find(m => m.role === 'user');
    const firstAssistant = session.messages.find(m => m.role === 'assistant');
    if (!firstUser || !firstAssistant) return;
    // Generate a title from the content (simple heuristic - take first sentence of assistant)
    let title = (firstAssistant.content || '').split(/[.\n!?]/)[0].trim();
    if (title.length > 50) title = title.slice(0, 47) + '...';
    if (title.length < 3) title = (firstUser.content || '').slice(0, 40).trim();
    session.name = title || session.name;
    saveSession(session);
    send({ type: 'session_renamed', sessionId: msg.sessionId, name: session.name });
    broadcastSessionUpdate();
  }

  // --- Compact, Stats, Duplicate handlers -----------------------------------

  function handleCompactSession(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) return send({ type: 'error', message: 'Session not found' });
    const keepCount = msg.keepCount || 10; // keep last N messages
    const originalCount = session.messages.length;
    if (session.messages.length > keepCount) {
      const summary = 'Context compacted: ' + (session.messages.length - keepCount) + ' older messages removed.';
      session.messages = session.messages.slice(-keepCount);
      // Prepend a system note about compaction
      session.messages.unshift({ role: 'assistant', content: '[Context compacted — ' + (originalCount - keepCount) + ' earlier messages removed]', timestamp: new Date().toISOString(), toolBlocks: [] });
    }
    saveSession(session);
    send({ type: 'session_compacted', sessionId: msg.sessionId, originalCount, newCount: session.messages.length });
  }

  function handleSessionStats(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) return send({ type: 'error', message: 'Session not found' });
    const msgs = session.messages || [];
    const userMsgs = msgs.filter(m => m.role === 'user');
    const assistantMsgs = msgs.filter(m => m.role === 'assistant');
    const totalToolBlocks = msgs.reduce((sum, m) => sum + (m.toolBlocks || []).length, 0);
    const totalChars = msgs.reduce((sum, m) => sum + (m.content || '').length, 0);
    send({
      type: 'session_stats',
      sessionId: msg.sessionId,
      stats: {
        messageCount: msgs.length,
        userMessages: userMsgs.length,
        assistantMessages: assistantMsgs.length,
        toolCalls: totalToolBlocks,
        totalCharacters: totalChars,
        estimatedTokens: Math.round(totalChars / 4),
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
    });
  }

  function handleDuplicateSession(msg) {
    const source = loadSession(msg.sessionId);
    if (!source) return send({ type: 'error', message: 'Session not found' });
    const newSession = createSession(source.model);
    newSession.name = source.name + ' (copy)';
    newSession.messages = JSON.parse(JSON.stringify(source.messages));
    newSession.systemPrompt = source.systemPrompt;
    saveSession(newSession);
    send({ type: 'session_created', session: { id: newSession.id, name: newSession.name } });
  }

  // --- Edit / Regenerate handlers -------------------------------------------

  function handleEditMessage(msg) {
    const session = loadSession(msg.sessionId);
    if (!session) return send({ type: 'error', message: 'Session not found' });
    const idx = session.messages.findIndex(m => m.timestamp === msg.timestamp && m.role === 'user');
    if (idx < 0) return send({ type: 'error', message: 'Message not found' });
    // Truncate conversation at this point (branch)
    session.messages = session.messages.slice(0, idx);
    session.messages.push({ role: 'user', content: msg.newContent, timestamp: new Date().toISOString(), toolBlocks: [] });
    // Clear CLI session so it starts fresh from this branch point
    session.cliSessionId = null;
    saveSession(session);
    send({ type: 'message_edited', sessionId: msg.sessionId, messages: session.messages });
  }

  function handleRegenerate(msg) {
    const session = loadSession(msg.sessionId);
    if (!session || !session.messages.length) return send({ type: 'error', message: 'Nothing to regenerate' });
    // Remove last assistant message, keep the user message before it
    while (session.messages.length > 0 && session.messages[session.messages.length - 1].role === 'assistant') {
      session.messages.pop();
    }
    const lastUserMsg = session.messages[session.messages.length - 1];
    if (!lastUserMsg || lastUserMsg.role !== 'user') return send({ type: 'error', message: 'No user message to regenerate from' });
    saveSession(session);
    // Re-send the last user message as a new chat
    handleChat({ type: 'chat', message: lastUserMsg.content, sessionId: msg.sessionId, model: msg.model || session.model || 'sonnet' });
  }

  // --- Follow-up suggestion generator ----------------------------------------

  function generateFollowUps(assistantText, toolBlocks) {
    const suggestions = [];
    if (toolBlocks.length > 0) {
      const toolNames = [...new Set(toolBlocks.map(t => t.toolName))];
      if (toolNames.includes('Read')) suggestions.push('Can you explain what this code does?');
      if (toolNames.includes('Write') || toolNames.includes('Edit')) suggestions.push('Can you add tests for this?');
      if (toolNames.includes('Bash')) suggestions.push('What was the output? Any issues?');
    }
    if (assistantText.includes('```')) suggestions.push('Can you improve this code?');
    if (assistantText.includes('error') || assistantText.includes('Error')) suggestions.push('How can we fix this error?');
    if (suggestions.length < 3) suggestions.push('Tell me more about this');
    if (suggestions.length < 3) suggestions.push('What should I do next?');
    if (suggestions.length < 3) suggestions.push('Can you explain this differently?');
    return suggestions.slice(0, 3);
  }

  // --- Chat / Claude CLI ---------------------------------------------------

  function handleChat(msg) {
    const userText = msg.message || '';
    const model = msg.model || 'sonnet';
    const images = msg.images || [];
    const files = msg.files || [];

    // Resolve or create session
    let session;
    if (msg.sessionId) {
      session = loadSession(msg.sessionId);
    }
    if (!session) {
      session = createSession(model);
      // Set session name from first user message
      if (userText) {
        session.name = userText.slice(0, 40).replace(/\n/g, ' ').trim() || 'New Chat';
        saveSession(session);
      }
      send({ type: 'session_created', session: { id: session.id, name: session.name } });
      broadcastSessionUpdate();
    }

    // Build the prompt — save images to disk (base64 is too large for stdin)
    let prompt = '';
    const tempImagePaths = [];

    for (const img of images) {
      try {
        const imgName = `${uuidv4()}-${path.basename(img.name || 'image.png')}`;
        const imgPath = path.join(UPLOADS_DIR, imgName);
        fs.writeFileSync(imgPath, Buffer.from(img.data, 'base64'));
        tempImagePaths.push(imgPath);
        prompt += `[The user uploaded an image: ${imgPath}]\n`;
      } catch (e) {
        console.error('[image save]', e.message);
      }
    }
    for (const file of files) {
      prompt += `[File: ${file.name}]\n---\n${file.content}\n---\n\n`;
    }
    prompt += userText;

    // Build CLI command args
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--model', model,
    ];

    if (SUBAGENT_TEXT_ON) args.push('--forward-subagent-text');

    if (session.cliSessionId) {
      args.push('--resume', session.cliSessionId);
    }

    // Add system prompt with professional standards and skill routing
    const systemParts = [];
    systemParts.push(`You are Ruflow — a professional AI assistant with 1,340+ skills. You run on a VPS (Ubuntu Linux) as user claude-user. Working directory: ${WORK_DIR}

You have full filesystem access, can run shell commands, read/write/edit files, and use all tools without permission prompts.

KARPATHY CODING PRINCIPLES (follow these for ALL coding work):

THINK BEFORE CODING: State assumptions explicitly. If uncertain, ASK. If multiple interpretations exist, present them — don't pick silently. If a simpler approach exists, say so.

SIMPLICITY FIRST: Minimum code that solves the problem. No features beyond what was asked. No abstractions for single-use code. If you write 200 lines and it could be 50, rewrite it.

SURGICAL CHANGES: Touch only what you must. Don't "improve" adjacent code. Match existing style. Every changed line should trace to the user's request.

GOAL-DRIVEN EXECUTION: Define success criteria before starting. "Add validation" → write tests first. "Fix bug" → reproduce it first. Verify each step.

PROFESSIONAL STANDARDS:
- You represent Ruflow to clients. No sloppy work.
- Ask clarifying questions before making assumptions (especially design).
- Present your approach BEFORE implementing. Get approval for big tasks.
- Read existing code/content before modifying. Understand first, then act.
- Run linters and tests after changes. Verify before claiming done.
- Explain WHY you made choices, not just what you did.
- NEVER use dark/neon/cyberpunk themes unless explicitly asked. Default: clean, professional, light.
- For website work: fetch the existing site first, preserve brand identity, use professional typography.
- Skills matching your task are AUTO-LOADED below. Follow their guidance.

GRAPHIFY (use ONLY for code/architecture tasks — not for general chat):
- When working on code, architecture, or codebase questions: read graphify-out/GRAPH_REPORT.md for structure
- After modifying code files: run graphify update to keep graph current
- For normal conversation, questions, or non-code tasks: do NOT use graphify — just respond naturally`);

    if (session.systemPrompt) {
      systemParts.push(session.systemPrompt);
    }

    /*
     * Project instructions + knowledge, and the second-brain slice. Same channel the
     * per-session prompt uses, so a project behaves exactly like Claude.ai Projects:
     * every turn in the project inherits its instructions. Wrapped in try/catch
     * because a broken project file must degrade to a normal chat, never kill a turn.
     */
    if (session.projectId) {
      try {
        // Pass the user's message so knowledge is retrieved, not dumped wholesale.
        const projectPrompt = projectStore.buildProjectPrompt(session.projectId, { query: prompt, budget: 14000 });
        if (projectPrompt) systemParts.push(projectPrompt);
        const proj = projectStore.getProject(session.projectId);
        if (proj) {
          const ctx = contextEngine.projectContext(proj, { recentText: prompt });
          const ctxText = contextEngine.formatForPrompt(ctx);
          if (ctxText) systemParts.push(ctxText);
        }
      } catch (e) {
        console.warn('[projects] context injection failed:', e.message);
      }
    }

    // Smart skill auto-loading: detect task type and inject relevant skill content
    const detectedRoutes = detectSkillsForMessage(prompt);
    const loadedSkillNames = new Set();

    // 1. Load skills from hardcoded routes (critical patterns)
    if (detectedRoutes.length > 0) {
      for (const route of detectedRoutes) {
        systemParts.push('--- AUTO-DETECTED TASK INSTRUCTIONS ---\n' + route.instructions);
        const loadedSkills = [];
        for (const skillName of route.skills.slice(0, 3)) {
          const content = loadSkillContent(skillName);
          if (content) {
            loadedSkills.push('### Skill: ' + skillName + '\n' + content);
            loadedSkillNames.add(skillName);
          }
        }
        if (loadedSkills.length > 0) {
          systemParts.push('--- LOADED SKILL REFERENCE ---\n' + loadedSkills.join('\n\n---\n\n'));
        }
      }
    }

    // 2. Dynamic skill search — find additional relevant skills from the 1,330+ index
    const dynamicSkills = searchSkillsForMessage(prompt, 5);
    const extraSkills = dynamicSkills.filter(s => !loadedSkillNames.has(s.name)).slice(0, 3);
    if (extraSkills.length > 0) {
      const skillList = extraSkills.map(s => '- ' + s.name + ': ' + (s.description || '').slice(0, 100)).join('\n');
      systemParts.push('--- ADDITIONAL RELEVANT SKILLS (read these if needed) ---\n' +
        'These skills match your task. Read them with: cat ' + SKILLS_DIR + '/SKILL_NAME/SKILL.md\n\n' + skillList);
      // Load the top dynamic skill's content if no hardcoded route matched
      if (detectedRoutes.length === 0 && extraSkills[0]) {
        const content = loadSkillContent(extraSkills[0].name);
        if (content) {
          systemParts.push('### Skill: ' + extraSkills[0].name + '\n' + content);
        }
      }
    }

    args.push('--append-system-prompt', systemParts.join('\n\n'));

    // Prepare env — full VPS access, no nested session conflicts
    const env = { ...process.env, CLAUDE_ENTRYPOINT: 'worker' };
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_PARENT_SESSION_ID;
    // Ensure PATH includes common tool locations
    env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:'
      + '/home/claude-user/.local/bin:/home/claude-user/.nvm/versions/node/v22.22.0/bin:'
      + (env.PATH || '');
    env.HOME = '/home/claude-user';
    env.USER = 'claude-user';

    /*
     * Envelope + per-lane text coalescing (U1-WIRE, U8-PERF).
     *
     * emitStream() below is the ONE place stream events get runId/seq/lane
     * (createEmitStream, lib/stream-events.js) — everything downstream, in
     * server.js and in the processor, sends through it rather than `send`
     * directly, so no event can accidentally skip the envelope.
     *
     * stream_text specifically is buffered per lane and flushed on 50ms or
     * 400 chars, whichever comes first, except the very first delta of the
     * run, which flushes immediately — time-to-first-token must not regress.
     * Above ws.bufferedAmount > 1e6 the window widens to 200ms so a slow
     * client can't queue unbounded server memory (U8-PERF item 14); this is
     * mandatory before subagent forwarding runs multiple lanes at once.
     * Any NON-text event flushes all pending lane buffers first, so a tool
     * row or stream_end can never arrive on the wire ahead of the sentence
     * that precedes it.
     */
    const { emitStream: baseEmitStream } = createEmitStream({ send });
    const laneTextBuffers = new Map(); // lane -> { text, timer }
    let firstTextFlushed = false;

    function flushLane(lane) {
      const buf = laneTextBuffers.get(lane);
      if (!buf || !buf.text) return;
      const text = buf.text;
      buf.text = '';
      if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
      baseEmitStream({ type: 'stream_text', text, lane });
    }

    function flushAllLanes() {
      for (const lane of laneTextBuffers.keys()) flushLane(lane);
    }

    function emitStream(o) {
      /*
       * Tag housekeeping turns on the wire so the client can stream the text
       * (the title logic needs the reply) without drawing a run header for a
       * turn the user never sent.
       */
      if (msg.isSystemRequest) o.system = true;

      if (o.type !== 'stream_text') {
        flushAllLanes();
        return baseEmitStream(o);
      }

      const lane = o.lane || 'main';
      let buf = laneTextBuffers.get(lane);
      if (!buf) { buf = { text: '', timer: null }; laneTextBuffers.set(lane, buf); }
      buf.text += o.text;

      if (!firstTextFlushed) {
        firstTextFlushed = true;
        flushLane(lane);
        return o;
      }
      if (buf.text.length >= 400) {
        flushLane(lane);
        return o;
      }
      if (!buf.timer) {
        const window = ws.bufferedAmount > 1_000_000 ? 200 : 50;
        buf.timer = setTimeout(() => flushLane(lane), window);
      }
      return o;
    }

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: WORK_DIR,
    });

    activeProcess = child;

    emitStream({ type: 'stream_lifecycle', phase: 'spawning' });
    emitStream({ type: 'stream_start', sessionId: session.id, model, requestedModel: model });

    // child.stdin.write below has no error handler upstream of this fix — if
    // claude exits before reading stdin (bad flag, auth failure), the EPIPE
    // surfaces as an unhandled stream error and takes the whole server down.
    child.stdin.on('error', (err) => {
      console.error('[claude] stdin write error:', err.message);
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();

    // --- Stream parsing --------------------------------------------------
    let stdoutBuffer = '';
    let stderrOutput = '';

    const processor = createStreamEventProcessor({
      isSystemRequest: !!msg.isSystemRequest,
      emitStream,
      session,
      userText,
      model,
      saveSession,
      autoExtractMemory,
      syncSessionToVectorDb,
      broadcastSessionUpdate,
      generateFollowUps,
      subagentDeltasOn: SUBAGENT_DELTAS_ON,
    });
    currentProcessor = processor; // scopes fetch_tool_output to this run

    // Timeout: if no output after 30 seconds, something's wrong
    const spawnTimeout = setTimeout(() => {
      if (!processor.getAccumulatedText() && processor.getToolBlocks().length === 0 && !processor.getCostInfo()) {
        emitStream({ type: 'stream_error', error: 'Claude is taking too long to respond. The process may be stuck.' });
        try { child.kill('SIGTERM'); } catch (_) {}
        cleanupProcess();
      }
    }, 90000); // 90s timeout — skill-loaded tasks take longer to start

    child.stdout.on('data', (chunk) => {
      clearTimeout(spawnTimeout);
      stdoutBuffer += chunk.toString();

      // Process complete lines
      const lines = stdoutBuffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch (_) {
          continue; // not JSON, skip
        }

        processor.processStreamEvent(parsed);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(spawnTimeout);
      console.error('[claude] spawn error:', err);
      let errorMsg = err.message;
      if (err.code === 'ENOENT') {
        errorMsg = 'Claude CLI not found. Ensure "claude" is installed and available in PATH.';
      } else if (err.code === 'EACCES') {
        errorMsg = 'Permission denied when launching Claude CLI. Check file permissions.';
      } else if (err.code === 'ENOMEM') {
        errorMsg = 'Not enough memory to spawn Claude process.';
      }
      emitStream({ type: 'stream_error', error: errorMsg });
      cleanupProcess();
    });

    child.on('close', (code) => {
      clearTimeout(spawnTimeout);
      // Process any remaining buffered data
      if (stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer.trim());
          processor.processStreamEvent(parsed);
        } catch (_) {}
      }

      if (stderrOutput.trim()) {
        console.error('[claude] stderr:', stderrOutput.trim());
      }

      if (code !== 0 && code !== null) {
        emitStream({ type: 'stream_error', error: `Claude process exited with code ${code}` });
      }

      // Safety net: saves the exchange (now including blocks[]) and emits a
      // fallback stream_end if the 'result' event never arrived.
      processor.finalizeIfUnsaved();

      cleanupProcess();
    });
  }

  // --- Cancel handling ------------------------------------------------------

  function handleCancel() {
    if (!activeProcess) return;

    try {
      activeProcess.kill('SIGTERM');
    } catch (_) {}

    killTimer = setTimeout(() => {
      if (activeProcess) {
        try {
          activeProcess.kill('SIGKILL');
        } catch (_) {}
      }
      cleanupProcess();
    }, CANCEL_KILL_TIMEOUT);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`Ruflow UI server running on http://localhost:${PORT}`);
  console.log(`  Static files: ${PUBLIC_DIR}`);
  console.log(`  Sessions dir: ${SESSIONS_DIR}`);
  console.log(`  Working dir:  ${WORK_DIR}`);
  if (OPEN_MODE) {
    console.warn('  Auth:         DISABLED (RUFLOW_OPEN=1) — only safe bound to localhost');
  } else {
    console.log(`  Unlock:       http://<host>:${PORT}/?k=${ACCESS_TOKEN}`);
    console.log('                token lives in ruflow-ui/.env (gitignored, mode 600)');
  }
  writeHeartbeat();
  setInterval(writeHeartbeat, 60000);
});

// ---------------------------------------------------------------------------
// Project context engine — the "second brain" feed for a project
// ---------------------------------------------------------------------------
// A project's connected memory has three sources, all read-only and all
// outside this repo:
//   - AgentDB (TF-IDF session/memory search) — queried by shelling out to the
//     existing scripts/memory-db/search.js, never opened with a raw driver.
//   - Graphify's knowledge graph (graphify-out/graph.json, ~52MB, ~40k nodes /
//     115k edges) — never sent whole to the browser, never JSON.parse'd on
//     every call. A compact node index is built once and cached to disk,
//     keyed by the source file's mtime+size so it rebuilds when graphify
//     re-runs; edges are streamed fresh from the raw file per query so the
//     cache never holds the (much larger) edge list.
//   - .brain-memory — curated markdown notes with YAML frontmatter.
//
// Exposed as a factory (mirrors lib/projects.js) so it's testable against
// synthetic fixtures instead of the live repo files.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

// ---------------------------------------------------------------------------
// AgentDB search (shell out — never require the sqlite driver directly)
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Parse the colorized text search.js prints on stdout into structured hits.
 * Real observed shape per result (after stripping ANSI codes):
 *
 *   #1 chat:59b02cdc-...:4
 *      Type: chat  Score: 36.8% ==================
 *      Date: 2026-08-10 16:05:06
 *      Session: 59b02cdc-...
 *      Source: ruflow-ui
 *      ---
 *      <snippet, may itself span multiple lines, may contain blank lines>
 *
 *   Found 5 result(s).
 *
 * Only the result header ("#N ...") and the terminator ("Found N result(s).")
 * start at column 0; every other line inside a record is indented, which is
 * what lets a snippet safely contain blank lines without breaking parsing.
 */
function parseSearchOutput(stdout) {
  const clean = String(stdout || '').replace(ANSI_RE, '');
  const lines = clean.split('\n');
  const results = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    current.snippet = current.snippetLines.join('\n').trim();
    delete current.snippetLines;
    delete current.inSnippet;
    results.push(current);
    current = null;
  };

  for (const line of lines) {
    if (/^Found \d+ result/.test(line)) {
      flush();
      break;
    }
    const header = line.match(/^#\d+\s+(.+)$/);
    if (header) {
      flush();
      current = { name: header[1].trim(), snippet: '', score: 0, source: null, snippetLines: [], inSnippet: false };
      continue;
    }
    if (!current) continue;

    if (!current.inSnippet) {
      const trimmed = line.trim();
      const scoreMatch = trimmed.match(/Score:\s*([\d.]+)%/);
      if (scoreMatch) current.score = parseFloat(scoreMatch[1]) / 100;
      const sourceMatch = trimmed.match(/^Source:\s*(.+)$/);
      if (sourceMatch) current.source = sourceMatch[1].trim();
      if (trimmed === '---') current.inSnippet = true;
      continue;
    }

    current.snippetLines.push(line.replace(/^\s{0,4}/, ''));
  }
  flush();
  return results;
}

/**
 * Search AgentDB memory via the existing CLI script.
 * Shells out with execFileSync (argv array — the query is user input and must
 * never reach a shell). On any failure returns [] but attaches a `lastError`
 * property to the returned array so the caller can distinguish "no results"
 * from "the search subsystem is broken" without a confidently-wrong empty
 * result being mistaken for success.
 *
 * lastError is deliberately NON-ENUMERABLE: it is diagnostic metadata, not an
 * element. Making it enumerable would mean a failed search no longer deep-equals
 * [] and would leak into JSON.stringify of the results, which is exactly what a
 * caller serialising to the client does not want.
 */
/*
 * Memoise search results.
 *
 * searchMemory spawns a fresh Node subprocess via execFileSync, which blocks the
 * entire single-threaded server for 300-1200ms. That is on the hot path — it runs
 * for the side panel AND on every turn inside a project — and a /healthz poller
 * was measured stalling 307ms mid-call. The graph cache never helped because the
 * spawn itself is the cost. Identical queries are very common (open a project,
 * then chat in it, and the derived terms are the same), so a short TTL removes
 * most spawns outright.
 */
const SEARCH_TTL_MS = 60000;
const FAILURE_TTL_MS = 5000;
const _searchCache = new Map();

function cachedSearch(key) {
  const hit = _searchCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || SEARCH_TTL_MS)) return hit.results;
  if (hit) _searchCache.delete(key);
  return null;
}

function putSearch(key, results, ttl) {
  // Bounded — this is a long-lived process; an unbounded map is a slow leak.
  if (_searchCache.size > 200) {
    for (const k of Array.from(_searchCache.keys()).slice(0, 100)) _searchCache.delete(k);
  }
  _searchCache.set(key, { at: Date.now(), results, ttl: ttl || SEARCH_TTL_MS });
}

/**
 * Async twin of searchMemory, sharing the same cache.
 *
 * execFileSync freezes the whole server for the duration of the subprocess.
 * Anything that can await should use this instead, so one client loading its
 * second-brain panel does not stall every other client's traffic.
 */
function searchMemoryAsync(agentdbSearchScript, query, { limit = 10 } = {}) {
  const cacheKey = agentdbSearchScript + '::' + limit + '::' + query;
  const cached = cachedSearch(cacheKey);
  if (cached) return Promise.resolve(cached);

  const results = [];
  const setLastError = (v) =>
    Object.defineProperty(results, 'lastError', { value: v, enumerable: false, configurable: true, writable: true });
  setLastError(null);
  if (!query || !String(query).trim()) return Promise.resolve(results);

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [agentdbSearchScript, String(query), '--limit', String(limit)],
      { timeout: 10000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) setLastError(err.message || String(err));
        else {
          try { for (const r of parseSearchOutput(stdout)) results.push(r); }
          catch (e) { setLastError(e.message); }
        }
        putSearch(cacheKey, results, results.lastError ? FAILURE_TTL_MS : SEARCH_TTL_MS);
        resolve(results);
      }
    );
  });
}

function searchMemory(agentdbSearchScript, query, { limit = 10 } = {}) {
  const cacheKey = agentdbSearchScript + '::' + limit + '::' + query;
  const cached = cachedSearch(cacheKey);
  if (cached) return cached;
  const results = [];
  const setLastError = (v) =>
    Object.defineProperty(results, 'lastError', { value: v, enumerable: false, configurable: true, writable: true });
  setLastError(null);
  if (!query || !String(query).trim()) return results;
  try {
    const stdout = execFileSync(
      process.execPath,
      [agentdbSearchScript, String(query), '--limit', String(limit)],
      { timeout: 10000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    const parsed = parseSearchOutput(stdout);
    for (const r of parsed) results.push(r);
  } catch (e) {
    setLastError(e && e.message ? e.message : String(e));
  }
  /*
   * Cache failures far more briefly than successes. Holding a failed search for
   * the full 60s meant one transient subprocess hiccup blanked the second-brain
   * panel for a minute even though a retry two seconds later would have worked.
   * Short enough to recover quickly, long enough to stop a hot retry loop.
   */
  putSearch(cacheKey, results, results.lastError ? FAILURE_TTL_MS : SEARCH_TTL_MS);
  return results;
}

// ---------------------------------------------------------------------------
// Brain memory (.brain-memory) — curated frontmatter'd markdown
// ---------------------------------------------------------------------------

/**
 * Shallow YAML frontmatter parser. Handles the two-level shape actually used
 * in .brain-memory: top-level `key: value` lines, and one level of nesting
 * under a key whose own line has no value (e.g. `metadata:` followed by
 * indented `type:` / `node_type:` lines). Good enough for this repo's files;
 * not a general YAML parser.
 */
function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const top = {};
  let curKey = null;
  const stripQuotes = (v) => v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

  for (const line of m[1].split(/\r?\n/)) {
    const topMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (topMatch) {
      curKey = topMatch[1];
      top[curKey] = stripQuotes(topMatch[2]);
      continue;
    }
    const nestedMatch = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (nestedMatch && curKey) {
      if (!top[curKey] || typeof top[curKey] !== 'object') top[curKey] = {};
      top[curKey][nestedMatch[1]] = stripQuotes(nestedMatch[2]);
    }
  }
  return top;
}

/** List every curated memory file that has valid frontmatter. */
function listBrainMemory(brainMemoryDir) {
  let files;
  try {
    files = fs.readdirSync(brainMemoryDir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(brainMemoryDir, file), 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    if (!fm || !fm.name) continue; // skip files without frontmatter (e.g. MEMORY.md itself)
    const type = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata.type : null;
    out.push({ name: fm.name, description: fm.description || '', type: type || null, file });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graphify subgraph — lazy disk-cached node index + per-query edge streaming
// ---------------------------------------------------------------------------

function graphSignature(graphPath) {
  const st = fs.statSync(graphPath); // throws if missing — caller catches
  return `${st.size}:${st.mtimeMs}`;
}

/**
 * Parse graph.json fully. This is the one place the whole file gets
 * JSON.parse'd, and it is deliberate: an earlier version of this module
 * tried to avoid that by splitting on a `/\{[^{}]+\}/g` object-boundary
 * regex, which is WRONG for this file — some node labels are themselves
 * things like function parameter destructuring ("{start, end, text}"),
 * so a brace-counting regex slices right through them and produces
 * malformed fragments. A real parser is the only correct way to do this,
 * and it's cheap: ~450ms cold for the real ~54MB / 41k-node / 117k-edge
 * graph (measured), well under the 2s budget even before any caching.
 */
function parseGraphFile(graphPath) {
  const raw = fs.readFileSync(graphPath, 'utf8'); // throws if missing
  const parsed = JSON.parse(raw); // throws if malformed
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const links = Array.isArray(parsed.links) ? parsed.links : [];

  const nodeIndex = nodes.map((n) => ({
    id: n.id,
    label: n.label,
    community: n.community,
    file_type: n.file_type,
    source_file: n.source_file,
  }));
  const edgeIndex = links.map((l) => ({
    source: l._src != null ? l._src : l.source,
    target: l._tgt != null ? l._tgt : l.target,
    relation: l.relation || null,
  }));

  return { nodeIndex, edgeIndex, totalNodes: nodeIndex.length, totalEdges: edgeIndex.length };
}

// Two-tier cache, keyed by cache file path:
//   - disk: the compact node index only (id/label/community/file_type/
//     source_file + stats) — NEVER the edge list — keyed by graph.json's
//     mtime+size so it rebuilds when graphify re-runs.
//   - in-memory: the disk contents PLUS the parsed edges, for the life of
//     this process. Edges never touch disk, so on a fresh process a valid
//     disk cache still needs one full parse to recover them — but only
//     once; every graphSubgraph() call after that hits this Map directly
//     with no file I/O at all, which is what actually keeps repeat queries
//     fast.
const _memCache = new Map();

function ensureGraphData(graphPath, cachePath) {
  let sig;
  try {
    sig = graphSignature(graphPath);
  } catch {
    return { nodes: [], totalNodes: 0, totalEdges: 0, edges: [] };
  }

  const mem = _memCache.get(cachePath);
  if (mem && mem.sig === sig) return mem;

  let diskHit = false;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached && cached.sig === sig) diskHit = true;
  } catch {
    // no cache yet, or stale/corrupt — fall through to a full parse
  }

  let built;
  try {
    built = parseGraphFile(graphPath);
  } catch {
    return { nodes: [], totalNodes: 0, totalEdges: 0, edges: [] };
  }

  if (!diskHit) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ sig, nodes: built.nodeIndex, totalNodes: built.totalNodes, totalEdges: built.totalEdges })
      );
    } catch {
      // read-only fs or similar — index still works for this process, just
      // won't persist across restarts
    }
  }

  const entry = {
    sig,
    nodes: built.nodeIndex,
    totalNodes: built.totalNodes,
    totalEdges: built.totalEdges,
    edges: built.edgeIndex,
  };
  _memCache.set(cachePath, entry);
  return entry;
}

/** Every edge whose source AND target are both in the returned node set. */
function edgesForNodes(edges, idSet) {
  if (idSet.size === 0) return [];
  const out = [];
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) out.push({ source: e.source, target: e.target, relation: e.relation });
  }
  return out;
}

/**
 * graphSubgraph(terms, {maxNodes}) -> {nodes, edges, stats}
 * Matches nodes by case-insensitive substring on label/source_file, scores by
 * match quality (label hits weighted over source_file hits), takes the top
 * `maxNodes`, then keeps only the edges directly connecting the returned
 * nodes to each other — so every edge returned has both endpoints in the
 * returned node set.
 */
function graphSubgraph(graphPath, cachePath, terms, { maxNodes = 150 } = {}) {
  const data = ensureGraphData(graphPath, cachePath);
  if (!data.totalNodes) {
    return { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, matched: 0, returned: 0, communities: 0 } };
  }

  const termList = (terms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const scored = [];
  if (termList.length) {
    for (const n of data.nodes) {
      const label = String(n.label || '').toLowerCase();
      const src = String(n.source_file || '').toLowerCase();
      let score = 0;
      for (const t of termList) {
        if (label.includes(t)) score += 2;
        if (src.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ node: n, score });
    }
    scored.sort((a, b) => b.score - a.score);
  }

  const selected = scored.slice(0, maxNodes).map((m) => m.node);
  const idSet = new Set(selected.map((n) => n.id));
  const communities = new Set(selected.map((n) => n.community));
  const edges = edgesForNodes(data.edges, idSet);

  return {
    nodes: selected,
    edges,
    stats: {
      totalNodes: data.totalNodes,
      totalEdges: data.totalEdges,
      matched: scored.length,
      returned: selected.length,
      communities: communities.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Term derivation + combined context + prompt formatting
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'has', 'had',
  'will', 'would', 'shall', 'should', 'could', 'about', 'into', 'over',
  'after', 'before', 'between', 'under', 'again', 'further', 'once', 'here',
  'there', 'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom',
  'because', 'until', 'while', 'during', 'through', 'above', 'below', 'down',
  'your', 'their', 'them', 'they', 'were', 'been', 'being', 'does', 'doing',
  'each', 'more', 'most', 'some', 'such', 'only', 'same', 'than', 'then',
  'just', 'also', 'very', 'both', 'project', 'instructions',
]);

/*
 * Generic code-domain nouns, dropped on top of the English stopwords.
 *
 * These are lethal on a real knowledge graph rather than merely unhelpful: a
 * project named "Authentication Service" derives the bare token "service",
 * which substring-matches every *Service node in a 41k-node graph and buries
 * the handful of nodes the project is actually about. Compound tokens are
 * unaffected — "authservice" is specific and still matches — so this only
 * strips the words that carry no discriminating signal on their own.
 */
const GENERIC_CODE_TERMS = new Set([
  'service', 'services', 'controller', 'controllers', 'manager', 'handler',
  'handlers', 'component', 'components', 'module', 'modules', 'helper',
  'helpers', 'util', 'utils', 'utility', 'utilities', 'index', 'main',
  'config', 'configs', 'configuration', 'client', 'server', 'common',
  'shared', 'core', 'base', 'data', 'file', 'files', 'code', 'class',
  'classes', 'function', 'functions', 'method', 'methods', 'system',
  'systems', 'model', 'models', 'view', 'views', 'page', 'pages',
  'test', 'tests', 'spec', 'specs', 'build', 'src', 'lib', 'app',
  'application', 'provider', 'factory', 'wrapper', 'interface', 'types',
  /*
   * Everyday words that collide with code vocabulary. The graph is a graphify
   * of THIS repo, so a business project called "Bin Works" derived the single
   * term "works" and matched hasWorkStealingData()/create_workspace(); "First
   * Calls" derived "call" and matched .handleToolCall(); "ScaleClients IO"
   * derived "process" and matched 776 stream-processor nodes. Every one of
   * those looked like a plausible result set and was pure noise. Code nouns
   * alone were never enough — these are the words that actually did the damage.
   */
  'call', 'calls', 'called', 'work', 'works', 'working', 'process', 'processes',
  'processing', 'run', 'runs', 'running', 'make', 'makes', 'made', 'need',
  'needs', 'want', 'wants', 'give', 'gives', 'take', 'takes', 'used', 'using',
  'send', 'sends', 'read', 'reads', 'write', 'writes', 'open', 'opens',
  'close', 'closes', 'start', 'starts', 'stop', 'stops', 'check', 'checks',
  'update', 'updates', 'create', 'creates', 'delete', 'deletes', 'list',
  'lists', 'name', 'names', 'value', 'values', 'result', 'results', 'item',
  'items', 'time', 'times', 'part', 'parts', 'thing', 'things', 'help',
  'free', 'first', 'next', 'last', 'good', 'best', 'real', 'full', 'live',
]);

function deriveTerms(project, recentText) {
  const text = [project && project.name, project && project.description, project && project.instructions, recentText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');

  const counts = new Map();
  for (const tok of text.split(/\s+/)) {
    if (tok.length < 4) continue;
    if (STOPWORDS.has(tok)) continue;
    if (GENERIC_CODE_TERMS.has(tok)) continue;
    counts.set(tok, (counts.get(tok) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
}

function relevantBrainNotes(brainMemoryDir, termList) {
  const all = listBrainMemory(brainMemoryDir);
  if (!termList.length) return [];
  const scored = [];
  for (const note of all) {
    const hay = `${note.name} ${note.description}`.toLowerCase();
    let score = 0;
    for (const t of termList) if (hay.includes(t)) score++;
    if (score > 0) scored.push({ note, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10).map((s) => s.note);
}

const PROMPT_CHAR_CAP = 8000;

function formatForPrompt(context) {
  if (!context) return null;
  const memoryList = context.memory || [];
  const graph = context.graph || { nodes: [], edges: [], stats: {} };
  const brain = context.brain || [];
  const hasGraph = Array.isArray(graph.nodes) && graph.nodes.length > 0;

  if (memoryList.length === 0 && brain.length === 0 && !hasGraph) return null;

  const parts = ['## Project context (second brain)'];

  if (memoryList.length) {
    parts.push('\n### Related memory');
    for (const m of memoryList.slice(0, 8)) {
      const pct = typeof m.score === 'number' ? ` (${Math.round(m.score * 100)}%)` : '';
      const snippet = String(m.snippet || '').replace(/\s+/g, ' ').trim();
      parts.push(`- ${m.name}${pct}: ${snippet}`);
    }
  }

  if (hasGraph) {
    const stats = graph.stats || {};
    parts.push(
      `\n### Knowledge graph (${stats.returned != null ? stats.returned : graph.nodes.length} of ` +
        `${stats.matched != null ? stats.matched : graph.nodes.length} matched nodes, ${stats.communities || 0} communities)`
    );
    for (const n of graph.nodes.slice(0, 25)) {
      parts.push(`- ${n.label} [${n.file_type || '?'}] ${n.source_file || ''}`);
    }
    if (graph.edges && graph.edges.length) {
      parts.push('Relations:');
      for (const e of graph.edges.slice(0, 25)) {
        parts.push(`  ${e.source} --${e.relation || 'related'}--> ${e.target}`);
      }
    }
  }

  if (brain.length) {
    parts.push('\n### Curated notes');
    for (const b of brain.slice(0, 10)) {
      parts.push(`- ${b.name}: ${b.description}`);
    }
  }

  let out = parts.join('\n');
  if (out.length > PROMPT_CHAR_CAP) {
    out = out.slice(0, PROMPT_CHAR_CAP - 20).trimEnd() + '\n…(truncated)';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createContextEngine({ repoRoot, graphPath, agentdbSearchScript, brainMemoryDir }) {
  const cachePath = path.join(repoRoot, '.cache', 'graph-index.json');

  return {
    searchMemory(query, opts) {
      return searchMemory(agentdbSearchScript, query, opts);
    },
    listBrainMemory() {
      return listBrainMemory(brainMemoryDir);
    },
    graphSubgraph(terms, opts) {
      return graphSubgraph(graphPath, cachePath, terms, opts);
    },
    /** Async variant — use wherever the caller can await, to keep the loop free. */
    async projectContextAsync(project, { recentText } = {}) {
      const terms = deriveTerms(project, recentText);
      const memory = await searchMemoryAsync(agentdbSearchScript, terms.join(' '), { limit: 10 });
      const graph = graphSubgraph(graphPath, cachePath, terms, { maxNodes: 150 });
      const brain = relevantBrainNotes(brainMemoryDir, terms);
      const memoryError = memory && memory.lastError ? String(memory.lastError) : null;
      if (memoryError) console.error('[second-brain] memory search failed:', memoryError);
      const graphError = graph && graph.stats && graph.stats.totalNodes === 0
        ? 'knowledge graph unavailable or unreadable' : null;
      if (graphError) console.error('[second-brain]', graphError);
      return { memory, graph, brain, memoryError, graphError };
    },

    projectContext(project, { recentText } = {}) {
      const terms = deriveTerms(project, recentText);
      const query = terms.join(' ');
      const memory = query ? searchMemory(agentdbSearchScript, query, { limit: 10 }) : [];
      const graph = graphSubgraph(graphPath, cachePath, terms, { maxNodes: 150 });
      const brain = relevantBrainNotes(brainMemoryDir, terms);
      /*
       * Surface a broken search subsystem. lastError was set correctly and read
       * by nobody: JSON.stringify drops a non-enumerable property, so a failing
       * AgentDB looked exactly like "no related memory" in the UI and in the
       * logs. An empty result that means "broken" must not be indistinguishable
       * from an empty result that means "nothing matched".
       */
      const memoryError = memory && memory.lastError ? String(memory.lastError) : null;
      if (memoryError) console.error('[second-brain] memory search failed:', memoryError);
      const graphError = graph && graph.stats && graph.stats.totalNodes === 0
        ? 'knowledge graph unavailable or unreadable' : null;
      if (graphError) console.error('[second-brain]', graphError);
      return { memory, graph, brain, memoryError, graphError };
    },
    formatForPrompt,
  };
}

module.exports = { createContextEngine };

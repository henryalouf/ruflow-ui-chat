const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createContextEngine } = require('../lib/project-context');

// ---------------------------------------------------------------------------
// Real repo paths, used only by the integration test which skips gracefully
// if they're absent (e.g. a fresh checkout with no graphify run yet).
// ---------------------------------------------------------------------------
const REAL_REPO_ROOT = path.resolve(__dirname, '..', '..');
const REAL_GRAPH_PATH = path.join(REAL_REPO_ROOT, 'graphify-out', 'graph.json');
const REAL_SEARCH_SCRIPT = path.join(REAL_REPO_ROOT, 'scripts', 'memory-db', 'search.js');
const REAL_BRAIN_DIR = path.join(REAL_REPO_ROOT, '.brain-memory');

// ---------------------------------------------------------------------------
// Setup — fresh temp dir per test, never touch the real repo files.
// ---------------------------------------------------------------------------

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflow-context-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeEngine(overrides = {}) {
  return createContextEngine({
    repoRoot: tmpRoot,
    graphPath: overrides.graphPath || path.join(tmpRoot, 'graph.json'),
    agentdbSearchScript: overrides.agentdbSearchScript || path.join(tmpRoot, 'search.js'),
    brainMemoryDir: overrides.brainMemoryDir || path.join(tmpRoot, 'brain-memory'),
  });
}

// ---------------------------------------------------------------------------
// Synthetic graph fixture — small, deterministic, mirrors the real shape
// {nodes:[{id,label,file_type,source_file,community}], links:[{_src,_tgt,relation}]}
// discovered by inspecting the real graphify-out/graph.json.
//
// n1 AuthService, n2 AuthController, n3 authHelper(), n5 auth-config.yaml all
// match the term "auth" on label and/or source_file (each scores 3: +2 label,
// +1 source_file). n4 PaymentService matches nothing. Edges: n1->n2, n2->n3,
// n1->n4, n3->n5, n4->n5 — the two touching n4 must never survive a query
// that excludes n4.
// ---------------------------------------------------------------------------
function writeSyntheticGraph(graphPath) {
  const graph = {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      { id: 'n1', label: 'AuthService', file_type: 'code', source_file: 'src/auth.js', community: 1 },
      { id: 'n2', label: 'AuthController', file_type: 'code', source_file: 'src/authController.js', community: 1 },
      { id: 'n3', label: 'authHelper()', file_type: 'code', source_file: 'src/authHelper.js', community: 2 },
      { id: 'n4', label: 'PaymentService', file_type: 'code', source_file: 'src/payment.js', community: 3 },
      { id: 'n5', label: 'auth-config.yaml', file_type: 'config', source_file: 'config/auth-config.yaml', community: 1 },
    ],
    links: [
      { relation: 'calls', _src: 'n1', _tgt: 'n2', source: 'n1', target: 'n2' },
      { relation: 'calls', _src: 'n2', _tgt: 'n3', source: 'n2', target: 'n3' },
      { relation: 'uses', _src: 'n1', _tgt: 'n4', source: 'n1', target: 'n4' },
      { relation: 'reads', _src: 'n3', _tgt: 'n5', source: 'n3', target: 'n5' },
      { relation: 'reads', _src: 'n4', _tgt: 'n5', source: 'n4', target: 'n5' },
    ],
  };
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(graphPath, JSON.stringify(graph));
}

/**
 * A bigger synthetic graph, purely to make the cold-vs-warm timing assertion
 * meaningful (the 5-node fixture above is too small for a timing comparison
 * to mean anything). Still fully synthetic and deterministic.
 */
function writeLargeSyntheticGraph(graphPath, nodeCount = 4000) {
  const nodes = [];
  const links = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `node_${i}`,
      label: i % 7 === 0 ? `authThing${i}` : `thing${i}`,
      file_type: 'code',
      source_file: `src/file${i}.js`,
      community: i % 20,
    });
    if (i > 0) {
      links.push({ relation: 'calls', _src: `node_${i - 1}`, _tgt: `node_${i}`, source: `node_${i - 1}`, target: `node_${i}` });
    }
  }
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(graphPath, JSON.stringify({ directed: false, multigraph: false, graph: {}, nodes, links }));
}

// ===========================================================================
// graphSubgraph — matching, capping, edge integrity
// ===========================================================================

describe('graphSubgraph — synthetic fixture', () => {
  it('matches nodes by label/source_file substring and returns connecting edges only', () => {
    const graphPath = path.join(tmpRoot, 'graph.json');
    writeSyntheticGraph(graphPath);
    const engine = makeEngine({ graphPath });

    const result = engine.graphSubgraph(['auth'], { maxNodes: 150 });

    assert.equal(result.stats.totalNodes, 5);
    assert.equal(result.stats.totalEdges, 5);
    assert.equal(result.stats.matched, 4); // n1, n2, n3, n5 — not n4 (PaymentService)
    assert.equal(result.stats.returned, 4);
    assert.equal(result.nodes.length, 4);
    assert.ok(!result.nodes.some((n) => n.id === 'n4'), 'PaymentService must not match "auth"');

    const idSet = new Set(result.nodes.map((n) => n.id));
    assert.ok(result.edges.length > 0, 'expect at least one connecting edge among matched nodes');
    for (const e of result.edges) {
      assert.ok(idSet.has(e.source), `edge source ${e.source} must be in the returned node set`);
      assert.ok(idSet.has(e.target), `edge target ${e.target} must be in the returned node set`);
    }
    // n1->n4 and n4->n5 must be excluded since n4 never matched.
    assert.ok(!result.edges.some((e) => e.source === 'n4' || e.target === 'n4'));
  });

  it('respects maxNodes and only keeps edges among the capped set', () => {
    const graphPath = path.join(tmpRoot, 'graph.json');
    writeSyntheticGraph(graphPath);
    const engine = makeEngine({ graphPath });

    const result = engine.graphSubgraph(['auth'], { maxNodes: 2 });

    assert.equal(result.stats.matched, 4, 'matched count is pre-cap');
    assert.equal(result.stats.returned, 2);
    assert.equal(result.nodes.length, 2);

    const idSet = new Set(result.nodes.map((n) => n.id));
    for (const e of result.edges) {
      assert.ok(idSet.has(e.source) && idSet.has(e.target), 'dangling edge would break any renderer');
    }
  });

  it('returns nothing but does not throw when no terms are given', () => {
    const graphPath = path.join(tmpRoot, 'graph.json');
    writeSyntheticGraph(graphPath);
    const engine = makeEngine({ graphPath });

    const result = engine.graphSubgraph([], { maxNodes: 150 });
    assert.equal(result.nodes.length, 0);
    assert.equal(result.edges.length, 0);
    assert.equal(result.stats.totalNodes, 5, 'totals still reflect the whole graph');
  });

  it('a corrupt graph.json yields an empty result, never throws', () => {
    const graphPath = path.join(tmpRoot, 'graph.json');
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, '{ this is not valid json {{{');
    const engine = makeEngine({ graphPath });

    let result;
    assert.doesNotThrow(() => {
      result = engine.graphSubgraph(['auth'], { maxNodes: 150 });
    });
    assert.equal(result.stats.totalNodes, 0);
    assert.equal(result.nodes.length, 0);
    assert.equal(result.edges.length, 0);
  });

  it('a missing graph.json yields an empty result, never throws', () => {
    const engine = makeEngine({ graphPath: path.join(tmpRoot, 'does-not-exist.json') });
    let result;
    assert.doesNotThrow(() => {
      result = engine.graphSubgraph(['auth'], { maxNodes: 150 });
    });
    assert.equal(result.stats.totalNodes, 0);
  });
});

describe('graphSubgraph — cache reuse', () => {
  it('builds a disk cache once and reuses it on the second call (real timings reported)', () => {
    const graphPath = path.join(tmpRoot, 'graph.json');
    writeLargeSyntheticGraph(graphPath, 4000);
    const engine = makeEngine({ graphPath });
    const cachePath = path.join(tmpRoot, '.cache', 'graph-index.json');

    assert.ok(!fs.existsSync(cachePath), 'no cache before the first call');

    const t0 = process.hrtime.bigint();
    const first = engine.graphSubgraph(['auth'], { maxNodes: 50 });
    const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;

    assert.ok(fs.existsSync(cachePath), 'first call must write the disk cache');
    const cacheContents = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.ok(!('edges' in cacheContents), 'the disk cache must never hold the edge list');
    assert.ok(Array.isArray(cacheContents.nodes) && cacheContents.nodes.length === 4000);
    const mtimeAfterFirst = fs.statSync(cachePath).mtimeMs;

    const t1 = process.hrtime.bigint();
    const second = engine.graphSubgraph(['auth'], { maxNodes: 50 });
    const warmMs = Number(process.hrtime.bigint() - t1) / 1e6;
    const mtimeAfterSecond = fs.statSync(cachePath).mtimeMs;

    console.log(`[project-context.test] synthetic graph (4000 nodes) cold=${coldMs.toFixed(2)}ms warm=${warmMs.toFixed(2)}ms`);

    // Strongest proof the cache was reused: the cache file was not rewritten.
    assert.equal(mtimeAfterSecond, mtimeAfterFirst, 'second call must not rewrite the cache file');
    assert.ok(warmMs <= coldMs, `warm call (${warmMs}ms) should not be slower than cold (${coldMs}ms)`);
    assert.deepEqual(second.stats, first.stats);
  });

  it('rebuilds the cache when graph.json changes (mtime+size signature)', () => {
    const graphPath = path.join(tmpRoot, 'graph.json');
    writeSyntheticGraph(graphPath);
    const engine = makeEngine({ graphPath });
    const cachePath = path.join(tmpRoot, '.cache', 'graph-index.json');

    engine.graphSubgraph(['auth'], { maxNodes: 150 });
    const sig1 = JSON.parse(fs.readFileSync(cachePath, 'utf8')).sig;

    // Rewrite with different content — size/mtime will change.
    writeLargeSyntheticGraph(graphPath, 10);
    const result = engine.graphSubgraph(['thing'], { maxNodes: 150 });
    const sig2 = JSON.parse(fs.readFileSync(cachePath, 'utf8')).sig;

    assert.notEqual(sig1, sig2, 'signature must change once graph.json is rewritten');
    assert.equal(result.stats.totalNodes, 10);
  });
});

// ===========================================================================
// searchMemory — real script success path + failure path
// ===========================================================================

describe('searchMemory', () => {
  it('parses real search.js output into structured hits', (t) => {
    if (!fs.existsSync(REAL_SEARCH_SCRIPT)) {
      t.skip('scripts/memory-db/search.js not present in this checkout');
      return;
    }
    const engine = makeEngine({ agentdbSearchScript: REAL_SEARCH_SCRIPT });
    const results = engine.searchMemory('ruflow ui memory', { limit: 5 });

    assert.equal(results.lastError, null);
    assert.ok(Array.isArray(results));
    // The real AgentDB may or may not have data in every environment, but if
    // it returns anything, every entry must have the documented shape.
    for (const r of results) {
      assert.equal(typeof r.name, 'string');
      assert.equal(typeof r.snippet, 'string');
      assert.equal(typeof r.score, 'number');
      assert.ok(r.source === null || typeof r.source === 'string');
    }
  });

  it('returns [] and sets lastError when the search script does not exist', () => {
    const engine = makeEngine({ agentdbSearchScript: path.join(tmpRoot, 'nonexistent-search.js') });
    const results = engine.searchMemory('anything', { limit: 5 });

    assert.equal(results.length, 0);
    assert.ok(results.lastError, 'lastError must be set — an empty result must not look like confident success');
    assert.equal(typeof results.lastError, 'string');
  });

  it('returns [] with no lastError for an empty query, without shelling out', () => {
    const engine = makeEngine({ agentdbSearchScript: path.join(tmpRoot, 'nonexistent-search.js') });
    const results = engine.searchMemory('', { limit: 5 });
    assert.equal(results.length, 0);
    assert.equal(results.lastError, null);
  });
});

// ===========================================================================
// listBrainMemory
// ===========================================================================

describe('listBrainMemory', () => {
  it('parses frontmatter and skips files without it', () => {
    const brainDir = path.join(tmpRoot, 'brain-memory');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(
      path.join(brainDir, 'feedback_example.md'),
      [
        '---',
        'name: feedback_example',
        'description: "Example feedback note"',
        'metadata:',
        '  type: feedback',
        '  node_type: memory',
        '---',
        '',
        'Body text.',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(brainDir, 'project_example.md'),
      ['---', 'name: project_example', 'description: Example project note', 'metadata:', '  type: project', '---', ''].join('\n')
    );
    fs.writeFileSync(path.join(brainDir, 'MEMORY.md'), '# Memory Index\n\nNo frontmatter here.\n');

    const engine = makeEngine({ brainMemoryDir: brainDir });
    const entries = engine.listBrainMemory();

    assert.equal(entries.length, 2, 'MEMORY.md (no frontmatter) must be skipped');
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    assert.equal(byName.feedback_example.description, 'Example feedback note');
    assert.equal(byName.feedback_example.type, 'feedback');
    assert.equal(byName.feedback_example.file, 'feedback_example.md');
    assert.equal(byName.project_example.type, 'project');
  });

  it('returns [] for a missing directory, does not throw', () => {
    const engine = makeEngine({ brainMemoryDir: path.join(tmpRoot, 'does-not-exist') });
    let entries;
    assert.doesNotThrow(() => {
      entries = engine.listBrainMemory();
    });
    assert.deepEqual(entries, []);
  });
});

// ===========================================================================
// formatForPrompt
// ===========================================================================

describe('formatForPrompt', () => {
  it('returns null when memory, graph and brain are all empty', () => {
    const engine = makeEngine();
    const out = engine.formatForPrompt({ memory: [], graph: { nodes: [], edges: [], stats: {} }, brain: [] });
    assert.equal(out, null);
  });

  it('returns null for a null/undefined context', () => {
    const engine = makeEngine();
    assert.equal(engine.formatForPrompt(null), null);
    assert.equal(engine.formatForPrompt(undefined), null);
  });

  it('formats non-empty context into a bounded text block', () => {
    const engine = makeEngine();
    const context = {
      memory: [{ name: 'session-1', snippet: 'talked about auth flow', score: 0.42, source: 'x' }],
      graph: {
        nodes: [{ id: 'n1', label: 'AuthService', file_type: 'code', source_file: 'src/auth.js', community: 1 }],
        edges: [{ source: 'n1', target: 'n1', relation: 'self' }],
        stats: { totalNodes: 5, totalEdges: 5, matched: 1, returned: 1, communities: 1 },
      },
      brain: [{ name: 'feedback_example', description: 'Example', type: 'feedback', file: 'feedback_example.md' }],
    };
    const out = engine.formatForPrompt(context);
    assert.ok(out !== null);
    assert.ok(out.includes('AuthService'));
    assert.ok(out.includes('session-1'));
    assert.ok(out.includes('feedback_example'));
    assert.ok(out.length <= 8000);
  });

  it('caps output at 8000 chars for a large context', () => {
    const engine = makeEngine();
    const memory = [];
    for (let i = 0; i < 200; i++) {
      memory.push({ name: `hit-${i}`, snippet: 'x'.repeat(200), score: 0.5, source: 's' });
    }
    const out = engine.formatForPrompt({ memory, graph: { nodes: [], edges: [], stats: {} }, brain: [] });
    assert.ok(out !== null);
    assert.ok(out.length <= 8000, `expected <=8000 chars, got ${out.length}`);
  });
});

// ===========================================================================
// projectContext — end-to-end combination
// ===========================================================================

describe('projectContext', () => {
  it('derives terms from the project and returns combined memory/graph/brain', () => {
    const graphPath = path.join(tmpRoot, 'graph.json');
    writeSyntheticGraph(graphPath);
    const brainDir = path.join(tmpRoot, 'brain-memory');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(
      path.join(brainDir, 'feedback_auth.md'),
      ['---', 'name: feedback_auth', 'description: "Authentication service notes"', 'metadata:', '  type: feedback', '---', ''].join(
        '\n'
      )
    );
    fs.writeFileSync(
      path.join(brainDir, 'feedback_unrelated.md'),
      ['---', 'name: feedback_unrelated', 'description: "Completely unrelated topic"', 'metadata:', '  type: feedback', '---', ''].join(
        '\n'
      )
    );

    const engine = makeEngine({
      graphPath,
      brainMemoryDir: brainDir,
      agentdbSearchScript: path.join(tmpRoot, 'nonexistent-search.js'), // deterministic: no real DB dependency
    });

    const project = {
      name: 'Authentication Service',
      description: 'Everything about the AuthService and AuthController',
      instructions: 'Focus on auth flows',
    };
    const ctx = engine.projectContext(project, { recentText: '' });

    assert.ok(Array.isArray(ctx.memory));
    assert.deepEqual(ctx.memory, [], 'nonexistent search script yields no memory hits');
    assert.equal(typeof ctx.memory.lastError, 'string', 'lastError must be set since the search script does not exist');
    assert.ok(ctx.graph.nodes.length > 0, 'expect the AuthService/AuthController nodes to match derived terms');
    assert.ok(ctx.graph.nodes.every((n) => n.id !== 'n4'), 'PaymentService is unrelated to this project');
    assert.ok(ctx.brain.some((b) => b.name === 'feedback_auth'));
    assert.ok(!ctx.brain.some((b) => b.name === 'feedback_unrelated'), 'unrelated brain note should not be pulled in');

    const formatted = engine.formatForPrompt(ctx);
    assert.ok(formatted !== null);
    assert.ok(formatted.length <= 8000);
  });

  it('returns empty-but-valid context for a project with no matchable content', () => {
    const engine = makeEngine({ agentdbSearchScript: path.join(tmpRoot, 'nonexistent-search.js') });
    const ctx = engine.projectContext({ name: '', description: '', instructions: '' }, { recentText: '' });
    assert.deepEqual(ctx.memory, []);
    assert.equal(ctx.graph.nodes.length, 0);
    assert.deepEqual(ctx.brain, []);
    assert.equal(engine.formatForPrompt(ctx), null);
  });
});

// ===========================================================================
// Integration — real graph.json + real search.js (skips if absent)
// ===========================================================================

describe('integration — real repo data', () => {
  it('finds real matches in the real graph and stays within the performance budget', (t) => {
    if (!fs.existsSync(REAL_GRAPH_PATH) || !fs.existsSync(REAL_SEARCH_SCRIPT)) {
      t.skip('real graphify-out/graph.json or scripts/memory-db/search.js not present');
      return;
    }

    const engine = makeEngine({
      graphPath: REAL_GRAPH_PATH,
      agentdbSearchScript: REAL_SEARCH_SCRIPT,
      brainMemoryDir: fs.existsSync(REAL_BRAIN_DIR) ? REAL_BRAIN_DIR : path.join(tmpRoot, 'brain-memory'),
    });

    const t0 = process.hrtime.bigint();
    const cold = engine.graphSubgraph(['memory', 'agent', 'session'], { maxNodes: 150 });
    const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const t1 = process.hrtime.bigint();
    const warm = engine.graphSubgraph(['memory', 'agent', 'session'], { maxNodes: 150 });
    const warmMs = Number(process.hrtime.bigint() - t1) / 1e6;

    console.log(`[project-context.test] REAL graph.json cold=${coldMs.toFixed(2)}ms warm=${warmMs.toFixed(2)}ms totalNodes=${cold.stats.totalNodes}`);

    assert.ok(cold.stats.totalNodes > 1000, `expected >1000 nodes in the real graph, got ${cold.stats.totalNodes}`);
    assert.ok(cold.stats.matched > 0, 'expected non-empty matches for common terms — do not let this pass vacuously');
    assert.ok(warm.nodes.length > 0);
    assert.ok(warmMs < 2000, `warm graphSubgraph call must stay under the 2s budget, took ${warmMs}ms`);

    const memResults = engine.searchMemory('ruflow project context', { limit: 5 });
    assert.equal(memResults.lastError, null);
  });
});

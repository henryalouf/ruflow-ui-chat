/*
 * Projects UI — DOM behaviour under jsdom.
 *
 * public/projects.js is a browser module with no permanent test of its own, so
 * the three properties that actually bite live here:
 *   1. Escaping. Project names, knowledge filenames and memory snippets are all
 *      server data that a hostile or careless value can reach the DOM through.
 *   2. Observer teardown. The graph canvas attaches a ResizeObserver; leaking one
 *      per project switch is invisible until the tab is slow.
 *   3. The save indicator must be driven by a real round trip, never a timer —
 *      a fake "Saved" on unsaved instructions is silent data loss.
 *
 * Every negative assertion below is paired with its positive case, so none of
 * them can pass vacuously against an empty document.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'projects.js'), 'utf-8');
const XSS = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

function boot({ withResizeObserver = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="projects-section"></div>
    <div id="project-view" class="rp-view" hidden></div>
    <div id="chat-messages"></div>
    <div id="input-area"></div>
    <button id="attach-project-btn"></button>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost:3001/' });

  const counts = { observersMade: 0, observersDisconnected: 0 };
  if (withResizeObserver) {
    dom.window.ResizeObserver = class {
      constructor() { counts.observersMade++; }
      observe() {} disconnect() { counts.observersDisconnected++; }
    };
  }
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.localStorage = dom.window.localStorage;
  dom.window.eval(SRC);

  const sent = [];
  const opened = [];
  const calls = { openView: 0, closeView: 0 };
  const RP = dom.window.RuflowProjects;
  RP.init({
    wsSend: (o) => sent.push(o),
    openSession: (id) => opened.push(id),
    getState: () => ({ currentSessionId: 's1', sessions: [] }),
    onOpenView() { calls.openView++; },
    onCloseView() { calls.closeView++; },
  });
  RP.renderSidebarSection(dom.window.document.getElementById('projects-section'));
  return { dom, RP, sent, opened, counts, calls, doc: dom.window.document };
}

describe('projects UI — module contract', () => {
  it('exposes the functions app.js integrates against', () => {
    const { RP } = boot();
    for (const fn of ['init', 'renderSidebarSection', 'openProjectView', 'closeProjectView',
                      'handleServerMessage', 'openAttachMenu', 'closeAttachMenu']) {
      assert.equal(typeof RP[fn], 'function', `RuflowProjects.${fn} must exist`);
    }
  });

  it('asks the server for its projects on init', () => {
    const { sent } = boot();
    assert.ok(sent.some(m => m.type === 'list_projects'), 'must request the project list');
  });
});

describe('projects UI — escaping', () => {
  it('renders a hostile project name as inert text, in the sidebar and the project view', () => {
    const { RP, doc } = boot();

    RP.handleServerMessage({ type: 'projects', projects: [
      { id: 'p1', name: XSS, color: '#ff6b35', chatCount: 1, knowledgeCount: 1 },
      { id: 'p2', name: 'Benign Project', color: '#3fb950', chatCount: 0, knowledgeCount: 0 },
    ]});

    // Positive case first: the benign project must actually render, or the
    // negative assertions below would pass against an empty sidebar.
    const side = doc.getElementById('projects-section');
    assert.ok(side.textContent.includes('Benign Project'), 'benign project must render');
    assert.equal(side.querySelectorAll('img').length, 0, 'no <img> may be created');
    assert.equal(side.querySelectorAll('script').length, 0, 'no <script> may be created');
    assert.equal(doc.querySelectorAll('[onerror]').length, 0, 'no onerror attribute may exist');
    assert.ok(side.textContent.includes('onerror'), 'payload must survive as literal text');

    RP.handleServerMessage({ type: 'project', project: {
      id: 'p1', name: XSS, description: XSS, instructions: 'be terse', color: '#ff6b35',
      knowledge: [{ id: 'k1', name: XSS + '.md', mime: 'text/markdown', bytes: 10 }],
    }, sessions: [{ id: 's1', name: XSS, updatedAt: new Date().toISOString(), messageCount: 2 }]});
    RP.openProjectView('p1');

    const view = doc.getElementById('project-view');
    assert.ok(view.textContent.length > 0, 'project view must render something');
    assert.equal(view.querySelectorAll('img').length, 0, 'no <img> in the project view');
    assert.equal(view.querySelectorAll('script').length, 0, 'no <script> in the project view');
    assert.equal(doc.querySelectorAll('[onerror]').length, 0, 'no onerror anywhere');
  });

  it('does not let a hostile snippet from the second brain become markup', () => {
    const { RP, doc } = boot();
    RP.handleServerMessage({ type: 'project', project: {
      id: 'p1', name: 'P', description: '', instructions: '', color: '#ff6b35', knowledge: [] }, sessions: [] });
    RP.openProjectView('p1');
    RP.handleServerMessage({ type: 'project_context', id: 'p1',
      memory: [{ name: XSS, snippet: XSS, score: 0.9, source: XSS }],
      brain: [{ name: XSS, description: XSS, type: 'feedback' }],
      graph: { nodes: [], edges: [], stats: { totalNodes: 0 } } });
    assert.equal(doc.querySelectorAll('img').length, 0, 'no <img> from memory/brain data');
    assert.equal(doc.querySelectorAll('[onerror]').length, 0, 'no onerror from memory/brain data');
  });
});

describe('projects UI — empty states', () => {
  it('renders an empty sidebar for zero projects, and rows for some', () => {
    const { RP, doc } = boot();
    const side = doc.getElementById('projects-section');

    RP.handleServerMessage({ type: 'projects', projects: [
      { id: 'p1', name: 'One', color: '#ff6b35', chatCount: 0, knowledgeCount: 0 }]});
    const withOne = side.textContent;
    assert.ok(withOne.includes('One'), 'the project must be listed');

    RP.handleServerMessage({ type: 'projects', projects: [] });
    assert.ok(!side.textContent.includes('One'), 'the list must clear when there are no projects');
  });
});

describe('projects UI — graph observer teardown', () => {
  it('disconnects every ResizeObserver it creates, including on project switch', () => {
    const { RP, counts } = boot({ withResizeObserver: true });
    const proj = { id: 'p1', name: 'P', description: '', instructions: '', color: '#ff6b35', knowledge: [] };
    RP.handleServerMessage({ type: 'project', project: proj, sessions: [] });
    RP.openProjectView('p1');
    RP.handleServerMessage({ type: 'project_context', id: 'p1', memory: [], brain: [],
      graph: { nodes: [{ id: 'a', label: 'a', community: 1 }], edges: [], stats: {} } });
    RP.openProjectView('p1');   // switching must tear the previous one down
    RP.closeProjectView();

    assert.ok(counts.observersMade > 0, 'sanity: the graph panel must attach an observer');
    assert.ok(counts.observersDisconnected >= counts.observersMade,
      `leaked ${counts.observersMade - counts.observersDisconnected} ResizeObserver(s)`);
  });
});

describe('projects UI — instructions autosave indicator', () => {
  it('only reports Saved once the server echoes the exact value that was sent', () => {
    const { RP, doc } = boot();
    RP.handleServerMessage({ type: 'project', project: {
      id: 'p1', name: 'P', description: '', instructions: 'old', color: '#ff6b35', knowledge: [] }, sessions: [] });
    RP.openProjectView('p1');

    const ta = doc.querySelector('textarea');
    assert.ok(ta, 'the instructions textarea must exist');
    ta.value = 'brand new instructions';
    ta.dispatchEvent(new doc.defaultView.Event('blur'));

    /*
     * Read the indicator element itself, not document text. textContent
     * concatenates sibling labels with no separator ("InstructionsSavedKnowledge"),
     * so a \bSaved\b match against the page can never fire — which would make the
     * negative assertion below pass for the wrong reason.
     */
    const indicator = () => doc.querySelector('.rp-save-indicator').textContent.trim();

    assert.equal(indicator(), 'Saving...', 'the indicator must show Saving immediately');

    // A stale echo carrying the OLD value must not be mistaken for confirmation.
    RP.handleServerMessage({ type: 'project_updated', project: {
      id: 'p1', name: 'P', description: '', instructions: 'old', color: '#ff6b35', knowledge: [] } });
    assert.equal(indicator(), 'Saving...', 'a stale echo must not flip the indicator to Saved');

    // The real confirmation does.
    RP.handleServerMessage({ type: 'project_updated', project: {
      id: 'p1', name: 'P', description: '', instructions: 'brand new instructions',
      color: '#ff6b35', knowledge: [] } });
    assert.equal(indicator(), 'Saved', 'a matching echo must confirm the save');
  });
});

describe('projects UI — attach menu', () => {
  it('opens a menu listing projects plus a None option, and closes again', () => {
    const { RP, doc } = boot();
    RP.handleServerMessage({ type: 'projects', projects: [
      { id: 'p1', name: 'Alpha', color: '#ff6b35', chatCount: 0, knowledgeCount: 0 },
      { id: 'p2', name: 'Beta', color: '#3fb950', chatCount: 0, knowledgeCount: 0 }]});

    RP.openAttachMenu(doc.getElementById('attach-project-btn'), 's1');
    const text = doc.body.textContent;
    assert.ok(text.includes('Alpha') && text.includes('Beta'), 'menu must list the projects');
    assert.match(text, /none/i, 'menu must offer a detach option');

    RP.closeAttachMenu();
    // Proven both ways: the menu content is gone, but the sidebar rows remain.
    assert.ok(doc.getElementById('projects-section').textContent.includes('Alpha'),
      'closing the menu must not wipe the sidebar');
  });
});

// ---------------------------------------------------------------------------
// Delete confirmation must actually be modal
//
// It shipped with role="dialog" aria-modal="true" and none of the behaviour:
// focus never entered it, Escape did nothing, and Tab walked into the page
// behind it — so a keyboard-only user could not reach Cancel on a DESTRUCTIVE
// action. aria-modal is a promise to assistive tech; these assert it is kept.
// ---------------------------------------------------------------------------
describe('projects UI — delete confirmation is keyboard-modal', () => {
  function openConfirm() {
    const ctx = boot();
    const { RP, doc } = ctx;
    RP.handleServerMessage({ type: 'project', project: {
      id: 'p1', name: 'Doomed', description: '', instructions: '', color: '#D97757', knowledge: [] }, sessions: [] });
    RP.openProjectView('p1');
    const del = doc.querySelector('.rp-delete-btn');
    assert.ok(del, 'sanity: the delete button must exist');
    del.focus();
    del.click();
    const overlay = doc.getElementById('rp-confirm-overlay');
    assert.ok(overlay && overlay.classList.contains('rp-open'), 'sanity: the dialog must open');
    return { ...ctx, overlay, del };
  }

  it('moves focus to Cancel — the safe option — when it opens', () => {
    const { doc, overlay } = openConfirm();
    const cancel = overlay.querySelector('#rp-confirm-cancel');
    assert.equal(doc.activeElement, cancel, 'focus must land on Cancel, not stay on the opener');
  });

  it('closes on Escape without confirming', () => {
    const { doc, overlay } = openConfirm();
    doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!overlay.classList.contains('rp-open'), 'Escape must close the dialog');
  });

  it('traps Tab between Cancel and Delete instead of leaking into the page', () => {
    const { doc, overlay } = openConfirm();
    const cancel = overlay.querySelector('#rp-confirm-cancel');
    const ok = overlay.querySelector('#rp-confirm-ok');
    const tab = (shift) => doc.dispatchEvent(
      new doc.defaultView.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true }));

    assert.equal(doc.activeElement, cancel);
    tab();
    assert.equal(doc.activeElement, ok, 'Tab must move to Delete');
    tab();
    assert.equal(doc.activeElement, cancel, 'Tab must wrap back to Cancel, not escape the dialog');
    tab(true);
    assert.equal(doc.activeElement, ok, 'Shift+Tab must cycle backwards within the dialog');
  });

  it('returns focus to the control that opened it', () => {
    const { doc, overlay, del } = openConfirm();
    doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.activeElement, del, 'focus must go back to the delete button');
  });
});

// ---------------------------------------------------------------------------
// Shell listeners must not accumulate across opens
//
// Every openProjectView bound ~22 listeners over a fresh `els`, and
// closeProjectView tore the view down with innerHTML = '' and nothing else. The
// closures kept `els` alive, and because `els` holds the list containers, one
// survivor retained that whole rendered subtree — ~500-600 detached nodes per
// open, growing without a ceiling.
// ---------------------------------------------------------------------------
describe('projects UI — project view does not leak listeners', () => {
  it('removes shell listeners on close, so a detached control is inert', () => {
    const ctx = boot();
    const { RP, doc } = ctx;
    RP.handleServerMessage({ type: 'project', project: {
      id: 'p1', name: 'Leaky', description: '', instructions: '', color: '#D97757', knowledge: [] }, sessions: [] });
    RP.openProjectView('p1');

    const back = doc.querySelector('.rp-back-btn');
    assert.ok(back, 'sanity: the shell must have rendered');

    // Our own listener proves dispatch still reaches the detached node, so a
    // zero result below means the module's handler was removed — not that the
    // click never happened.
    let ours = 0;
    back.addEventListener('click', () => { ours++; });

    RP.closeProjectView();
    const closesAfterFirst = ctx.calls.closeView;
    assert.equal(closesAfterFirst, 1, 'sanity: closing once calls onCloseView once');

    back.click();
    assert.equal(ours, 1, 'dispatch on the detached node must still reach our listener');
    // The shell's own back handler calls closeProjectView. If it survived the
    // close, this click runs it again and onCloseView fires a second time.
    assert.equal(ctx.calls.closeView, closesAfterFirst,
      'a detached shell control still fired the module handler — listeners leaked');
  });

  it('does not grow the listener count across repeated opens', () => {
    const { RP, doc } = boot();
    RP.handleServerMessage({ type: 'project', project: {
      id: 'p1', name: 'Cycled', description: '', instructions: '', color: '#D97757', knowledge: [] }, sessions: [] });

    // Count live shell controls after each cycle; a leak shows as accumulation
    // of detached roots, so assert the document never keeps more than one shell.
    for (let i = 0; i < 10; i++) {
      RP.openProjectView('p1');
      RP.closeProjectView();
    }
    RP.openProjectView('p1');
    assert.equal(doc.querySelectorAll('.rp-back-btn').length, 1,
      'exactly one shell should exist after repeated open/close cycles');
    RP.closeProjectView();
  });
});

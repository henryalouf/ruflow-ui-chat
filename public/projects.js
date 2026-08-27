/**
 * Ruflow Projects - client module (public/projects.js)
 *
 * Vanilla JS, no frameworks, no build step - mirrors public/app.js's idiom
 * (ES5-flavoured var/function, DOM built with createElement + textContent for
 * safety, escapeHtml/escapeAttr for the spots that need innerHTML).
 *
 * Exposes window.RuflowProjects. Everything it needs from the host app is
 * injected via init({ wsSend, openSession, getState, onOpenView, onCloseView })
 * - this module never reaches into app.js's internals directly.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Escaping - mirrors public/app.js's escapeHtml/escapeAttr exactly. Cannot
  // import from app.js, so it's replicated here. See app.js's comment on why
  // escapeHtml alone is not attribute-safe (it leaves `"` unescaped).
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str == null ? '' : String(str)));
    return div.innerHTML;
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  var PALETTE = ['#ff6b35', '#1f6feb', '#3fb950', '#f85149', '#a371f7', '#e3b341', '#39c5cf', '#f778ba'];
  var DEFAULT_COLOR = PALETTE[0];
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;
  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  var SAVE_DEBOUNCE_MS = 800;
  var SAVED_INDICATOR_MS = 2000;
  var MAX_GRAPH_NODES = 150;
  var LABEL_COUNT = 10;

  function safeColor(c) {
    return (typeof c === 'string' && HEX_RE.test(c)) ? c : DEFAULT_COLOR;
  }

  function raf(cb) {
    if (window.requestAnimationFrame) return window.requestAnimationFrame(cb);
    return setTimeout(cb, 16);
  }
  function caf(id) {
    if (window.cancelAnimationFrame) window.cancelAnimationFrame(id);
    else clearTimeout(id);
  }
  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function relativeTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - new Date(ts).getTime();
    if (diff < 0) diff = 0;
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    if (hours < 48) return 'yesterday';
    var d = new Date(ts);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getDate();
  }

  // ---------------------------------------------------------------------------
  // Host plumbing (injected by init) + module state
  // ---------------------------------------------------------------------------
  var host = {
    wsSend: function () {},
    openSession: function () {},
    getState: function () { return { sessions: [], currentSessionId: null }; },
    onOpenView: function () {},
    onCloseView: function () {}
  };

  var pstate = {
    projects: [],
    sidebarCollapsed: readCollapsed(),
    creating: false,
    sidebarEl: null,
    openProjectId: null,
    projectDetail: null,
    context: null,            // { memory, graph, brain }
    contextTab: 'memory',
    uploads: {},               // tempId -> { name, size, progress }
    root: null,                // #project-view element
    els: null,                 // cached refs into the rendered shell
    saveState: 'idle',         // idle | saving | saved
    saveTimer: null,
    saveToken: 0,
    lastSentInstructions: null,
    lastConfirmedInstructions: '',
    pendingCreate: false,
    graphSim: null
  };

  function readCollapsed() {
    try { return localStorage.getItem('ruflow-projects-collapsed') === '1'; } catch (e) { return false; }
  }
  function writeCollapsed(v) {
    try { localStorage.setItem('ruflow-projects-collapsed', v ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Small self-contained UI helpers (toasts + confirm modal). projects.js can't
  // call app.js's showNotification/showConfirmModal, so it carries scoped
  // equivalents, styled via projects.css under the .rp- prefix.
  // ---------------------------------------------------------------------------
  function notify(message, type) {
    var box = document.getElementById('rp-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rp-toasts';
      box.className = 'rp-toasts';
      document.body.appendChild(box);
    }
    var el = document.createElement('div');
    el.className = 'rp-toast rp-toast-' + (type || 'info');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(function () {
      el.classList.add('rp-toast-out');
      setTimeout(function () { el.remove(); }, 200);
    }, 3600);
  }

  /**
   * Read a knowledge file in place.
   *
   * The GET route sends Content-Disposition: attachment so a stored filename can
   * never drive an inline render, which means we cannot just navigate to it —
   * that would download. Fetch the bytes and paint them into a dialog instead.
   */
  function viewKnowledgeFile(fileId, fileName) {
    var pid = pstate.openProjectId;
    if (!pid) return;
    var overlay = document.getElementById('rp-view-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'rp-view-overlay';
      overlay.className = 'rp-modal-overlay';
      overlay.innerHTML =
        '<div class="rp-modal rp-modal-wide" role="dialog" aria-modal="true" aria-labelledby="rp-view-title">' +
          '<div class="rp-view-head">' +
            '<h3 id="rp-view-title"></h3>' +
            '<button type="button" class="rp-btn rp-btn-ghost" id="rp-view-close">Close</button>' +
          '</div>' +
          '<pre class="rp-view-body" id="rp-view-body" tabindex="0"></pre>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.classList.remove('rp-open');
      });
      overlay.querySelector('#rp-view-close').addEventListener('click', function () {
        overlay.classList.remove('rp-open');
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') overlay.classList.remove('rp-open');
      });
    }
    overlay.querySelector('#rp-view-title').textContent = fileName || 'File';
    var body = overlay.querySelector('#rp-view-body');
    body.textContent = 'Loading\u2026';
    overlay.classList.add('rp-open');

    fetch('/api/projects/' + encodeURIComponent(pid) + '/knowledge/' + encodeURIComponent(fileId), {
      credentials: 'same-origin',
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Server returned ' + r.status);
        return r.text();
      })
      .then(function (text) {
        // textContent, never innerHTML — this is untrusted file content.
        body.textContent = text;
        body.focus();
      })
      .catch(function (err) {
        body.textContent = 'Could not open this file: ' + err.message;
      });
  }

  function confirmDialog(title, message, confirmLabel, onConfirm) {
    var overlay = document.getElementById('rp-confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'rp-confirm-overlay';
      overlay.className = 'rp-modal-overlay';
      overlay.innerHTML =
        '<div class="rp-modal" role="dialog" aria-modal="true" aria-labelledby="rp-confirm-title">' +
          '<h3 id="rp-confirm-title"></h3>' +
          '<p id="rp-confirm-msg"></p>' +
          '<div class="rp-modal-actions">' +
            '<button type="button" class="rp-btn rp-btn-ghost" id="rp-confirm-cancel">Cancel</button>' +
            '<button type="button" class="rp-btn rp-btn-danger" id="rp-confirm-ok">Delete</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
    }
    overlay.querySelector('#rp-confirm-title').textContent = title;
    overlay.querySelector('#rp-confirm-msg').textContent = message;
    var okBtn = overlay.querySelector('#rp-confirm-ok');
    var cancelBtn = overlay.querySelector('#rp-confirm-cancel');
    okBtn.textContent = confirmLabel || 'Delete';
    // Replace with clones to drop any listeners from a previous invocation.
    var newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    var newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    overlay.classList.add('rp-open');
    function close() { overlay.classList.remove('rp-open'); }
    newOk.addEventListener('click', function () { close(); onConfirm(); });
    newCancel.addEventListener('click', close);
  }

  // ---------------------------------------------------------------------------
  // Document-level listeners (bound once, never per-render, so repeated opens
  // of the project view never stack up duplicate document click handlers).
  // ---------------------------------------------------------------------------
  var docListenersBound = false;
  var attachMenu = { el: null, anchor: null };

  function bindDocListenersOnce() {
    if (docListenersBound) return;
    docListenersBound = true;
    document.addEventListener('click', function (e) {
      var popover = pstate.els && pstate.els.colorPopover;
      if (popover && !popover.hidden && !popover.contains(e.target) && e.target !== pstate.els.colorBtn) {
        popover.hidden = true;
      }
      if (attachMenu.el && !attachMenu.el.contains(e.target) && e.target !== attachMenu.anchor) {
        closeAttachMenu();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var popover = pstate.els && pstate.els.colorPopover;
      if (popover) popover.hidden = true;
      closeAttachMenu();
    });
  }

  // ---------------------------------------------------------------------------
  // Sidebar section
  // ---------------------------------------------------------------------------
  function renderSidebarSection(containerEl) {
    if (!containerEl) return;
    pstate.sidebarEl = containerEl;
    containerEl.innerHTML = '';

    var section = document.createElement('div');
    section.className = 'rp-section';

    var head = document.createElement('div');
    head.className = 'rp-side-head';
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', pstate.sidebarCollapsed ? 'false' : 'true');
    head.setAttribute('aria-controls', 'rp-project-list');

    var chevron = document.createElement('span');
    chevron.className = 'rp-side-chevron' + (pstate.sidebarCollapsed ? ' rp-collapsed' : '');
    chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var title = document.createElement('span');
    title.className = 'rp-side-title';
    title.textContent = 'Projects';

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'rp-add-btn';
    addBtn.setAttribute('aria-label', 'New project');
    addBtn.title = 'New project';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      pstate.creating = true;
      pstate.sidebarCollapsed = false;
      writeCollapsed(false);
      renderSidebarSection(containerEl);
      var input = containerEl.querySelector('.rp-new-input');
      if (input) input.focus();
    });

    function toggleCollapsed() {
      pstate.sidebarCollapsed = !pstate.sidebarCollapsed;
      writeCollapsed(pstate.sidebarCollapsed);
      renderSidebarSection(containerEl);
    }
    head.addEventListener('click', toggleCollapsed);
    head.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed(); }
    });

    head.appendChild(chevron);
    head.appendChild(title);
    head.appendChild(addBtn);
    section.appendChild(head);

    var list = document.createElement('div');
    list.className = 'rp-project-list';
    list.id = 'rp-project-list';
    if (pstate.sidebarCollapsed) list.hidden = true;

    if (pstate.creating) {
      list.appendChild(buildNewProjectRow(containerEl));
    }

    if (pstate.projects.length === 0 && !pstate.creating) {
      var empty = document.createElement('div');
      empty.className = 'rp-empty rp-side-empty';
      empty.textContent = 'No projects yet';
      list.appendChild(empty);
    } else {
      var sorted = pstate.projects.slice().sort(function (a, b) {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      for (var i = 0; i < sorted.length; i++) {
        list.appendChild(buildProjectRow(sorted[i]));
      }
    }

    section.appendChild(list);
    containerEl.appendChild(section);
  }

  function buildNewProjectRow(containerEl) {
    var row = document.createElement('div');
    row.className = 'rp-new-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'rp-new-input';
    input.placeholder = 'Project name';
    input.setAttribute('aria-label', 'New project name');
    input.maxLength = 120;

    function cancel() {
      pstate.creating = false;
      renderSidebarSection(containerEl);
    }
    function commit() {
      var name = input.value.trim();
      if (!name) { cancel(); return; }
      pstate.pendingCreate = true;
      host.wsSend({ type: 'create_project', name: name, description: '', instructions: '' });
      pstate.creating = false;
      renderSidebarSection(containerEl);
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', cancel);
    row.appendChild(input);
    return row;
  }

  function chatCountFor(projectId) {
    var st = host.getState() || {};
    var sessions = st.sessions || [];
    var n = 0;
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].projectId === projectId) n++;
    }
    return n;
  }

  function buildProjectRow(p) {
    var row = document.createElement('div');
    row.className = 'rp-project-row' + (p.id === pstate.openProjectId ? ' active' : '');
    row.setAttribute('data-id', p.id);
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');

    var dot = document.createElement('span');
    dot.className = 'rp-dot';
    dot.style.background = safeColor(p.color);
    row.appendChild(dot);

    var name = document.createElement('span');
    name.className = 'rp-project-name';
    name.textContent = p.name || 'Untitled project';
    row.appendChild(name);

    var count = document.createElement('span');
    count.className = 'rp-project-count';
    var n = typeof p.chatCount === 'number' ? p.chatCount : chatCountFor(p.id);
    count.textContent = n === 1 ? '1 chat' : n + ' chats';
    row.appendChild(count);

    function open() { openProjectView(p.id); }
    row.addEventListener('click', open);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return row;
  }

  function refreshSidebar() {
    if (pstate.sidebarEl) renderSidebarSection(pstate.sidebarEl);
  }

  // ---------------------------------------------------------------------------
  // Attach-to-project control (used from a chat: assigns a session to a
  // project, or detaches it with "None"). Additive to the required API -
  // the host wires a trigger button to call this.
  // ---------------------------------------------------------------------------
  function openAttachMenu(anchorEl, sessionId) {
    closeAttachMenu();
    if (!anchorEl) return;
    var st = host.getState() || {};
    var current = null;
    var sessions = st.sessions || [];
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId) { current = sessions[i].projectId || null; break; }
    }

    var menu = document.createElement('div');
    menu.className = 'rp-attach-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Assign to project');

    function addItem(label, color, projectId) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'rp-attach-item' + (current === projectId ? ' active' : '');
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', current === projectId ? 'true' : 'false');
      if (color) {
        var d = document.createElement('span');
        d.className = 'rp-attach-dot';
        d.style.background = color;
        item.appendChild(d);
      } else {
        var spacer = document.createElement('span');
        spacer.className = 'rp-attach-dot rp-attach-dot-none';
        item.appendChild(spacer);
      }
      var t = document.createElement('span');
      t.textContent = label;
      item.appendChild(t);
      item.addEventListener('click', function () {
        host.wsSend({ type: 'assign_session', sessionId: sessionId, projectId: projectId });
        closeAttachMenu();
      });
      menu.appendChild(item);
    }

    addItem('None', null, null);
    for (var j = 0; j < pstate.projects.length; j++) {
      var p = pstate.projects[j];
      addItem(p.name || 'Untitled project', safeColor(p.color), p.id);
    }

    document.body.appendChild(menu);
    var rect = anchorEl.getBoundingClientRect();
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    menu.style.left = (rect.left + window.scrollX) + 'px';
    attachMenu.el = menu;
    attachMenu.anchor = anchorEl;
  }
  function closeAttachMenu() {
    if (attachMenu.el && attachMenu.el.parentNode) attachMenu.el.parentNode.removeChild(attachMenu.el);
    attachMenu.el = null;
    attachMenu.anchor = null;
  }

  // ---------------------------------------------------------------------------
  // Project view shell (built once per open, then targeted updates keep it in
  // sync with server pushes without clobbering in-progress edits).
  // ---------------------------------------------------------------------------
  function shellHtml() {
    var swatches = '';
    for (var i = 0; i < PALETTE.length; i++) {
      swatches += '<button type="button" class="rp-color-swatch" data-color="' + PALETTE[i] + '" style="background:' + PALETTE[i] + '" aria-label="Set project color"></button>';
    }
    return (
      '<div class="rp-scroll">' +
        '<div class="rp-header">' +
          '<div class="rp-header-top">' +
            '<button type="button" class="rp-back-btn" aria-label="Back to chat">' +
              '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button>' +
            '<div class="rp-color-wrap">' +
              '<button type="button" class="rp-color-dot" aria-label="Change project color" aria-haspopup="true"></button>' +
              '<div class="rp-color-popover" hidden role="menu" aria-label="Project color">' + swatches + '</div>' +
            '</div>' +
            '<span class="rp-name" tabindex="0" role="button" aria-label="Project name, click to rename"></span>' +
            '<input type="text" class="rp-name-input" hidden aria-label="Edit project name" maxlength="120">' +
            '<span class="rp-header-spacer"></span>' +
            '<button type="button" class="rp-delete-btn" aria-label="Delete project" title="Delete project">' +
              '<svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M11 4v7a2 2 0 01-2 2H5a2 2 0 01-2-2V4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button>' +
          '</div>' +
          '<span class="rp-desc" tabindex="0" role="button" aria-label="Project description, click to edit"></span>' +
          '<input type="text" class="rp-desc-input" hidden aria-label="Edit project description" maxlength="500">' +
        '</div>' +
        /*
         * Layout mirrors Claude Projects: the chats you actually work in sit at
         * the top next to the project's knowledge, and the second brain — which
         * is reference material, not the task — spans the full width below.
         */
        '<div class="rp-top">' +
          '<div class="rp-col rp-col-main">' +
            '<div class="rp-section">' +
              '<div class="rp-section-head"><span class="rp-section-title">Chats in this project</span><span class="rp-chats-count"></span></div>' +
              '<ul class="rp-chats-list"></ul>' +
            '</div>' +
          '</div>' +
          '<div class="rp-col rp-col-side">' +
            '<div class="rp-section">' +
              '<div class="rp-section-head"><span class="rp-section-title">Instructions</span><span class="rp-save-indicator"></span></div>' +
              '<textarea class="rp-instructions" placeholder="Custom instructions injected into every chat in this project..." aria-label="Project instructions"></textarea>' +
            '</div>' +
            '<div class="rp-section">' +
              '<div class="rp-section-head"><span class="rp-section-title">Knowledge</span></div>' +
              '<div class="rp-dropzone" tabindex="0" role="button" aria-label="Upload knowledge files, up to 10 megabytes each">' +
                '<span class="rp-dropzone-icon">&#8593;</span>' +
                '<span>Drop files here, or click to upload</span>' +
                '<span class="rp-dropzone-hint">Up to 10 MB per file</span>' +
              '</div>' +
              '<input type="file" class="rp-file-input" multiple hidden aria-hidden="true">' +
              '<ul class="rp-knowledge-list"></ul>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="rp-bottom">' +
          '<div class="rp-section rp-brain">' +
            '<div class="rp-section-head"><span class="rp-section-title">Second brain</span><span class="rp-brain-meta"></span></div>' +
            '<div class="rp-tabs" role="tablist" aria-label="Second brain data">' +
              '<button type="button" class="rp-tab active" role="tab" id="rp-tab-memory" aria-selected="true" aria-controls="rp-panel-memory" tabindex="0">Memory</button>' +
              '<button type="button" class="rp-tab" role="tab" id="rp-tab-graph" aria-selected="false" aria-controls="rp-panel-graph" tabindex="-1">Graph</button>' +
              '<button type="button" class="rp-tab" role="tab" id="rp-tab-brain" aria-selected="false" aria-controls="rp-panel-brain" tabindex="-1">Brain</button>' +
            '</div>' +
            '<div class="rp-tabpanel" id="rp-panel-memory" role="tabpanel" aria-labelledby="rp-tab-memory"><ul class="rp-memory-list"></ul></div>' +
            '<div class="rp-tabpanel" id="rp-panel-graph" role="tabpanel" aria-labelledby="rp-tab-graph" hidden>' +
              '<div class="rp-graph-wrap">' +
                '<canvas class="rp-graph-canvas"></canvas>' +
                '<div class="rp-graph-empty"></div>' +
                '<div class="rp-graph-hint">Drag to pan &middot; scroll to zoom &middot; hover a node</div>' +
              '</div>' +
            '</div>' +
            '<div class="rp-tabpanel" id="rp-panel-brain" role="tabpanel" aria-labelledby="rp-tab-brain" hidden><ul class="rp-brain-list"></ul></div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderProjectShell(root) {
    root.innerHTML = shellHtml();
    var els = {
      backBtn: root.querySelector('.rp-back-btn'),
      colorBtn: root.querySelector('.rp-color-dot'),
      colorPopover: root.querySelector('.rp-color-popover'),
      nameEl: root.querySelector('.rp-name'),
      nameInput: root.querySelector('.rp-name-input'),
      descEl: root.querySelector('.rp-desc'),
      descInput: root.querySelector('.rp-desc-input'),
      deleteBtn: root.querySelector('.rp-delete-btn'),
      instructions: root.querySelector('.rp-instructions'),
      saveIndicator: root.querySelector('.rp-save-indicator'),
      dropzone: root.querySelector('.rp-dropzone'),
      fileInput: root.querySelector('.rp-file-input'),
      knowledgeList: root.querySelector('.rp-knowledge-list'),
      chatsCount: root.querySelector('.rp-chats-count'),
      chatsList: root.querySelector('.rp-chats-list'),
      tabs: {
        memory: root.querySelector('#rp-tab-memory'),
        graph: root.querySelector('#rp-tab-graph'),
        brain: root.querySelector('#rp-tab-brain')
      },
      panels: {
        memory: root.querySelector('#rp-panel-memory'),
        graph: root.querySelector('#rp-panel-graph'),
        brain: root.querySelector('#rp-panel-brain')
      },
      memoryList: root.querySelector('.rp-memory-list'),
      brainList: root.querySelector('.rp-brain-list'),
      graphPanelWrap: root.querySelector('.rp-graph-wrap'),
      graphCanvas: root.querySelector('.rp-graph-canvas'),
      graphEmpty: root.querySelector('.rp-graph-empty')
    };
    pstate.els = els;
    wireShellEvents(els);
    return els;
  }

  function wireShellEvents(els) {
    els.backBtn.addEventListener('click', closeProjectView);

    // --- Color popover ---
    els.colorBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      els.colorPopover.hidden = !els.colorPopover.hidden;
    });
    var swatches = els.colorPopover.querySelectorAll('.rp-color-swatch');
    for (var i = 0; i < swatches.length; i++) {
      swatches[i].addEventListener('click', function (e) {
        var color = e.currentTarget.getAttribute('data-color');
        els.colorPopover.hidden = true;
        els.colorBtn.style.background = color;
        patchProject({ color: color });
      });
    }

    // --- Inline name edit ---
    function startNameEdit() {
      els.nameInput.value = (pstate.projectDetail && pstate.projectDetail.name) || '';
      els.nameEl.hidden = true;
      els.nameInput.hidden = false;
      els.nameInput.focus();
      els.nameInput.select();
    }
    function commitName() {
      var val = els.nameInput.value.trim();
      els.nameInput.hidden = true;
      els.nameEl.hidden = false;
      if (val && pstate.projectDetail && val !== pstate.projectDetail.name) {
        pstate.projectDetail.name = val;
        els.nameEl.textContent = val;
        patchProject({ name: val });
      }
    }
    function cancelNameEdit() {
      els.nameInput.hidden = true;
      els.nameEl.hidden = false;
    }
    els.nameEl.addEventListener('click', startNameEdit);
    els.nameEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startNameEdit(); }
    });
    els.nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitName(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelNameEdit(); }
    });
    els.nameInput.addEventListener('blur', commitName);

    // --- Inline description edit ---
    function startDescEdit() {
      els.descInput.value = (pstate.projectDetail && pstate.projectDetail.description) || '';
      els.descEl.hidden = true;
      els.descInput.hidden = false;
      els.descInput.focus();
      els.descInput.select();
    }
    function commitDesc() {
      var val = els.descInput.value.trim();
      els.descInput.hidden = true;
      els.descEl.hidden = false;
      if (pstate.projectDetail && val !== pstate.projectDetail.description) {
        pstate.projectDetail.description = val;
        renderDescText(els, val);
        patchProject({ description: val });
      }
    }
    function cancelDescEdit() {
      els.descInput.hidden = true;
      els.descEl.hidden = false;
    }
    els.descEl.addEventListener('click', startDescEdit);
    els.descEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startDescEdit(); }
    });
    els.descInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitDesc(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelDescEdit(); }
    });
    els.descInput.addEventListener('blur', commitDesc);

    // --- Delete project ---
    els.deleteBtn.addEventListener('click', function () {
      var p = pstate.projectDetail;
      var name = (p && p.name) || 'this project';
      confirmDialog(
        'Delete project?',
        'This deletes "' + name + '" and its knowledge files. Chats stay, but are detached from the project.',
        'Delete',
        function () {
          host.wsSend({ type: 'delete_project', id: pstate.openProjectId });
        }
      );
    });

    // --- Instructions autosave ---
    els.instructions.addEventListener('input', function () {
      clearTimeout(pstate.saveTimer);
      pstate.saveTimer = setTimeout(triggerInstructionsSave, SAVE_DEBOUNCE_MS);
    });
    els.instructions.addEventListener('blur', function () {
      clearTimeout(pstate.saveTimer);
      triggerInstructionsSave();
    });

    // --- Knowledge upload ---
    els.dropzone.addEventListener('click', function () { els.fileInput.click(); });
    els.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
    });
    els.dropzone.addEventListener('dragover', function (e) {
      e.preventDefault();
      els.dropzone.classList.add('rp-drag-active');
    });
    els.dropzone.addEventListener('dragleave', function () {
      els.dropzone.classList.remove('rp-drag-active');
    });
    els.dropzone.addEventListener('drop', function (e) {
      e.preventDefault();
      els.dropzone.classList.remove('rp-drag-active');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
    els.fileInput.addEventListener('change', function () {
      handleFiles(els.fileInput.files);
      els.fileInput.value = '';
    });

    // --- Second-brain tabs (roving tabindex ARIA tabs pattern) ---
    var order = ['memory', 'graph', 'brain'];
    function focusTab(idx) {
      var name = order[(idx + order.length) % order.length];
      els.tabs[name].focus();
    }
    order.forEach(function (name, idx) {
      els.tabs[name].addEventListener('click', function () { switchTab(name); });
      els.tabs[name].addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); switchTab(order[(idx + 1) % order.length]); focusTab(idx + 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); switchTab(order[(idx - 1 + order.length) % order.length]); focusTab(idx - 1); }
      });
    });

    if (window.ResizeObserver) {
      // window-qualified to match the guard, as with MutationObserver above.
      els.graphResizeObserver = new window.ResizeObserver(function () {
        if (pstate.graphSim) { resizeGraphCanvas(pstate.graphSim); scheduleGraphDraw(); }
      });
      els.graphResizeObserver.observe(els.graphPanelWrap);
    }
  }

  function renderDescText(els, val) {
    if (val) {
      els.descEl.textContent = val;
      els.descEl.classList.remove('rp-placeholder');
    } else {
      els.descEl.textContent = 'Add a description...';
      els.descEl.classList.add('rp-placeholder');
    }
  }

  function patchProject(patch) {
    if (!pstate.openProjectId) return;
    host.wsSend({ type: 'update_project', id: pstate.openProjectId, patch: patch });
    refreshProjectList();
  }
  function refreshProjectList() {
    host.wsSend({ type: 'list_projects' });
  }

  // ---------------------------------------------------------------------------
  // Instructions autosave - a genuine round trip. We send the patch, then
  // re-request the project; the indicator only flips to "Saved" once the
  // re-fetched copy actually matches what we sent.
  // ---------------------------------------------------------------------------
  var SAVE_TIMEOUT_MS = 8000;

  function triggerInstructionsSave() {
    if (!pstate.els || !pstate.openProjectId) return;
    var val = pstate.els.instructions.value;
    if (val === pstate.lastConfirmedInstructions && pstate.saveState !== 'saving') return;
    pstate.lastSentInstructions = val;
    setSaveState('saving');
    var token = ++pstate.saveToken;
    host.wsSend({ type: 'update_project', id: pstate.openProjectId, patch: { instructions: val } });
    host.wsSend({ type: 'get_project', id: pstate.openProjectId });
    // Safety net: the WS protocol has no explicit error ack, so if the
    // re-fetch never echoes our value back within a reasonable window, stop
    // showing "Saving..." forever and surface it as unconfirmed instead.
    setTimeout(function () {
      if (pstate.saveToken === token && pstate.saveState === 'saving') setSaveState('error');
    }, SAVE_TIMEOUT_MS);
  }

  function setSaveState(state) {
    pstate.saveState = state;
    if (!pstate.els) return;
    var el = pstate.els.saveIndicator;
    el.className = 'rp-save-indicator rp-save-' + state;
    el.textContent = state === 'saving' ? 'Saving...' : (state === 'saved' ? 'Saved' : (state === 'error' ? 'Not saved - retrying on next edit' : ''));
  }

  // ---------------------------------------------------------------------------
  // Knowledge upload
  // ---------------------------------------------------------------------------
  function handleFiles(fileList) {
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      if (file.size > MAX_UPLOAD_BYTES) {
        notify('"' + file.name + '" is over the 10 MB limit', 'error');
        continue;
      }
      uploadFile(file);
    }
  }

  function uploadFile(file) {
    var projectId = pstate.openProjectId;
    var tempId = 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    pstate.uploads[tempId] = { name: file.name, size: file.size, progress: 0 };
    renderKnowledgeList();

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects/' + encodeURIComponent(projectId) + '/knowledge');
    xhr.upload.addEventListener('progress', function (e) {
      if (!e.lengthComputable || !pstate.uploads[tempId]) return;
      pstate.uploads[tempId].progress = Math.round((e.loaded / e.total) * 100);
      renderKnowledgeList();
    });
    xhr.addEventListener('load', function () {
      delete pstate.uploads[tempId];
      if (xhr.status >= 200 && xhr.status < 300) {
        host.wsSend({ type: 'get_project', id: projectId });
      } else {
        notify('Upload failed: ' + file.name, 'error');
        renderKnowledgeList();
      }
    });
    xhr.addEventListener('error', function () {
      delete pstate.uploads[tempId];
      notify('Upload failed: ' + file.name, 'error');
      renderKnowledgeList();
    });

    var fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  }

  function removeKnowledgeFile(fileId) {
    var projectId = pstate.openProjectId;
    fetch('/api/projects/' + encodeURIComponent(projectId) + '/knowledge/' + encodeURIComponent(fileId), {
      method: 'DELETE',
      credentials: 'same-origin'
    }).then(function (r) {
      if (!r.ok) throw new Error('bad status');
      host.wsSend({ type: 'get_project', id: projectId });
    }).catch(function () {
      notify('Could not remove file', 'error');
    });
  }

  function renderKnowledgeList() {
    var els = pstate.els;
    if (!els) return;
    var list = els.knowledgeList;
    list.innerHTML = '';
    var files = (pstate.projectDetail && pstate.projectDetail.knowledge) || [];
    var uploadIds = Object.keys(pstate.uploads);

    if (files.length === 0 && uploadIds.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'rp-empty';
      empty.textContent = 'No knowledge files yet';
      list.appendChild(empty);
      return;
    }

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var li = document.createElement('li');
      li.className = 'rp-knowledge-item';
      // Clickable: the content is on disk and was previously unreachable from
      // the UI — the row rendered a name and a size and nothing opened it.
      var name = document.createElement('button');
      name.type = 'button';
      name.className = 'rp-file-name';
      name.title = 'Open ' + (f.name || 'file');
      name.setAttribute('aria-label', 'Open ' + (f.name || 'file'));
      name.textContent = f.name || 'file';
      (function (fileId, fileName) {
        name.addEventListener('click', function () { viewKnowledgeFile(fileId, fileName); });
      })(f.id, f.name);
      li.appendChild(name);
      var size = document.createElement('span');
      size.className = 'rp-file-size';
      size.textContent = fmtBytes(f.bytes);
      li.appendChild(size);
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rp-file-remove';
      rm.setAttribute('aria-label', 'Remove ' + (f.name || 'file'));
      rm.innerHTML = '&times;';
      (function (fileId) {
        rm.addEventListener('click', function () { removeKnowledgeFile(fileId); });
      })(f.id);
      li.appendChild(rm);
      list.appendChild(li);
    }

    for (var j = 0; j < uploadIds.length; j++) {
      var u = pstate.uploads[uploadIds[j]];
      var uli = document.createElement('li');
      uli.className = 'rp-knowledge-item rp-uploading';
      var uname = document.createElement('span');
      uname.className = 'rp-file-name';
      uname.textContent = u.name;
      uli.appendChild(uname);
      var track = document.createElement('span');
      track.className = 'rp-progress-track';
      var fill = document.createElement('span');
      fill.className = 'rp-progress-fill';
      fill.style.width = u.progress + '%';
      track.appendChild(fill);
      uli.appendChild(track);
      list.appendChild(uli);
    }
  }

  // ---------------------------------------------------------------------------
  // Chats in this project
  // ---------------------------------------------------------------------------
  function renderChatsList() {
    var els = pstate.els;
    if (!els) return;
    var st = host.getState() || {};
    var sessions = (st.sessions || []).filter(function (s) { return s.projectId === pstate.openProjectId; });
    sessions.sort(function (a, b) { return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0); });

    els.chatsCount.textContent = sessions.length === 1 ? '1 chat' : sessions.length + ' chats';
    els.chatsList.innerHTML = '';
    if (sessions.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'rp-empty';
      empty.textContent = 'No chats in this project yet';
      els.chatsList.appendChild(empty);
      return;
    }
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var li = document.createElement('li');
      li.className = 'rp-chat-item';
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      var name = document.createElement('span');
      name.className = 'rp-chat-name';
      name.textContent = s.name || 'Untitled';
      li.appendChild(name);
      var time = document.createElement('span');
      time.className = 'rp-chat-time';
      time.textContent = relativeTime(s.updatedAt);
      li.appendChild(time);
      (function (id) {
        function open() { host.openSession(id); }
        li.addEventListener('click', open);
        li.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
      })(s.id);
      els.chatsList.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Second-brain tabs
  // ---------------------------------------------------------------------------
  function switchTab(name) {
    pstate.contextTab = name;
    var els = pstate.els;
    if (!els) return;
    ['memory', 'graph', 'brain'].forEach(function (n) {
      var active = n === name;
      els.tabs[n].classList.toggle('active', active);
      els.tabs[n].setAttribute('aria-selected', active ? 'true' : 'false');
      els.tabs[n].tabIndex = active ? 0 : -1;
      els.panels[n].hidden = !active;
    });
    if (name === 'graph') {
      renderGraphTab();
    } else if (pstate.graphSim) {
      stopGraphLoop(pstate.graphSim);
    }
  }

  function scoreFraction(score) {
    var n = typeof score === 'number' ? score : parseFloat(score);
    if (!isFinite(n) || n < 0) return 0;
    if (n > 1) n = n / 100;
    if (n > 1) n = 1;
    return n;
  }

  function renderMemoryTab() {
    var els = pstate.els;
    if (!els) return;
    var list = els.memoryList;
    list.innerHTML = '';
    if (!pstate.context) {
      var loading = document.createElement('li');
      loading.className = 'rp-empty';
      loading.textContent = 'Loading memory...';
      list.appendChild(loading);
      return;
    }
    var hits = pstate.context.memory || [];
    if (hits.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'rp-empty';
      empty.textContent = 'No memory matches for this project yet';
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var li = document.createElement('li');
      li.className = 'rp-memory-item';
      var name = document.createElement('div');
      name.className = 'rp-memory-name';
      name.textContent = h.name || 'Untitled';
      li.appendChild(name);
      if (h.snippet) {
        var snippet = document.createElement('div');
        snippet.className = 'rp-memory-snippet';
        snippet.textContent = h.snippet;
        li.appendChild(snippet);
      }
      var track = document.createElement('div');
      track.className = 'rp-score-track';
      var fill = document.createElement('div');
      fill.className = 'rp-score-fill';
      fill.style.width = Math.round(scoreFraction(h.score) * 100) + '%';
      track.appendChild(fill);
      li.appendChild(track);
      list.appendChild(li);
    }
  }

  function renderBrainTab() {
    var els = pstate.els;
    if (!els) return;
    var list = els.brainList;
    list.innerHTML = '';
    if (!pstate.context) {
      var loading = document.createElement('li');
      loading.className = 'rp-empty';
      loading.textContent = 'Loading brain memory...';
      list.appendChild(loading);
      return;
    }
    var entries = pstate.context.brain || [];
    if (entries.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'rp-empty';
      empty.textContent = 'No curated memories linked to this project';
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var li = document.createElement('li');
      li.className = 'rp-brain-item';
      var top = document.createElement('div');
      top.className = 'rp-brain-top';
      var badge = document.createElement('span');
      badge.className = 'rp-brain-badge';
      badge.textContent = e.type || 'reference';
      top.appendChild(badge);
      var name = document.createElement('span');
      name.className = 'rp-brain-name';
      name.textContent = e.name || 'Untitled';
      top.appendChild(name);
      li.appendChild(top);
      if (e.description) {
        var desc = document.createElement('div');
        desc.className = 'rp-brain-desc';
        desc.textContent = e.description;
        li.appendChild(desc);
      }
      list.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Graph tab - a small hand-rolled force-directed layout on <canvas>. No
  // external library. Semi-implicit (symplectic) Euler integration with
  // velocity damping - same family as velocity-Verlet, chosen for stability
  // at a fixed small step. Caps at MAX_GRAPH_NODES and stops once the system's
  // kinetic energy settles below a threshold, so it never spins forever.
  // ---------------------------------------------------------------------------
  var SIM = { repulsion: 2400, spring: 0.02, idealLen: 70, centerK: 0.006, damping: 0.82, energyThreshold: 0.02, maxFrames: 600, maxSpeedSq: 400 };

  function prepareGraph(raw) {
    var nodesIn = (raw && raw.nodes) || [];
    if (nodesIn.length > MAX_GRAPH_NODES) nodesIn = nodesIn.slice(0, MAX_GRAPH_NODES);
    var idIndex = {};
    var nodes = [];
    for (var i = 0; i < nodesIn.length; i++) {
      var n = nodesIn[i] || {};
      var id = n.id != null ? String(n.id) : String(i);
      idIndex[id] = nodes.length;
      var angle = (nodes.length / Math.max(1, nodesIn.length)) * Math.PI * 2;
      var r = 40 + ((i * 37) % 100);
      nodes.push({
        id: id,
        label: n.label || n.name || id,
        community: n.community != null ? n.community : 0,
        degree: 0,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0, vy: 0
      });
    }
    var edgesIn = (raw && raw.edges) || (raw && raw.links) || [];
    var links = [];
    for (var j = 0; j < edgesIn.length; j++) {
      var e = edgesIn[j];
      if (!e) continue;
      var s = resolveEndpoint(e.source, idIndex, nodes.length);
      var t = resolveEndpoint(e.target, idIndex, nodes.length);
      if (s == null || t == null || s === t) continue;
      links.push({ s: s, t: t });
      nodes[s].degree++;
      nodes[t].degree++;
    }
    return { nodes: nodes, links: links };
  }

  function resolveEndpoint(v, idIndex, n) {
    if (v == null) return null;
    if (typeof v === 'number' && v >= 0 && v < n) return v;
    var key = String(v);
    if (Object.prototype.hasOwnProperty.call(idIndex, key)) return idIndex[key];
    return null;
  }

  function topDegreeIndexes(nodes, count) {
    var idxs = [];
    for (var i = 0; i < nodes.length; i++) idxs.push(i);
    idxs.sort(function (a, b) { return nodes[b].degree - nodes[a].degree; });
    return idxs.slice(0, Math.min(count, idxs.length));
  }

  function nodeRadius(degree) {
    return Math.min(14, 3 + Math.sqrt(degree || 0) * 2.4);
  }

  function communityColor(community) {
    var s = String(community == null ? 'default' : community);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    var hue = Math.abs(h) % 360;
    return 'hsl(' + hue + ', 58%, 55%)';
  }

  function truncateLabel(label) {
    var s = String(label || '');
    return s.length > 22 ? s.slice(0, 21) + '…' : s;
  }

  function simStep(g) {
    var nodes = g.nodes, links = g.links, n = nodes.length;
    var i, j, a, b, dx, dy, distSq, dist, force, fx, fy;
    for (i = 0; i < n; i++) {
      a = nodes[i];
      for (j = i + 1; j < n; j++) {
        b = nodes[j];
        dx = a.x - b.x; dy = a.y - b.y;
        distSq = dx * dx + dy * dy + 0.01;
        dist = Math.sqrt(distSq);
        force = SIM.repulsion / distSq;
        fx = (dx / dist) * force; fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    for (i = 0; i < links.length; i++) {
      a = nodes[links[i].s]; b = nodes[links[i].t];
      dx = b.x - a.x; dy = b.y - a.y;
      dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      force = (dist - SIM.idealLen) * SIM.spring;
      fx = (dx / dist) * force; fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    var energy = 0;
    for (i = 0; i < n; i++) {
      a = nodes[i];
      a.vx -= a.x * SIM.centerK; a.vy -= a.y * SIM.centerK;
      a.vx *= SIM.damping; a.vy *= SIM.damping;
      var sp = a.vx * a.vx + a.vy * a.vy;
      if (sp > SIM.maxSpeedSq) {
        var sc = Math.sqrt(SIM.maxSpeedSq / sp);
        a.vx *= sc; a.vy *= sc;
      }
      a.x += a.vx; a.y += a.vy;
      energy += a.vx * a.vx + a.vy * a.vy;
    }
    return energy / Math.max(1, n);
  }

  function settleSync(sim) {
    for (var f = 0; f < SIM.maxFrames; f++) {
      var e = simStep(sim.g);
      if (e < SIM.energyThreshold && f > 20) break;
    }
    sim.settled = true;
  }

  function startGraphLoop(sim) {
    stopGraphLoop(sim);
    var frame = 0;
    function tick() {
      var e = simStep(sim.g);
      drawGraph(sim);
      frame++;
      if ((e < SIM.energyThreshold && frame > 20) || frame > SIM.maxFrames) {
        sim.settled = true;
        sim.raf = null;
        return;
      }
      sim.raf = raf(tick);
    }
    sim.raf = raf(tick);
  }
  function stopGraphLoop(sim) {
    if (sim && sim.raf != null) { caf(sim.raf); sim.raf = null; }
  }

  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    return {
      bg: (cs.getPropertyValue('--bg-primary') || '#0d1117').trim() || '#0d1117',
      edge: (cs.getPropertyValue('--border-color') || '#30363d').trim() || '#30363d',
      accent: (cs.getPropertyValue('--accent-primary') || '#ff6b35').trim() || '#ff6b35',
      text: (cs.getPropertyValue('--text-secondary') || '#8b949e').trim() || '#8b949e',
      font: getComputedStyle(document.body).fontFamily || 'sans-serif'
    };
  }

  function resizeGraphCanvas(sim) {
    var canvas = sim.canvas;
    var cssW = canvas.clientWidth || 300;
    var cssH = canvas.clientHeight || 300;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    sim.dpr = dpr;
  }

  function eventToGraphCoords(sim, evt) {
    var rect = sim.canvas.getBoundingClientRect();
    var cx = evt.clientX - rect.left;
    var cy = evt.clientY - rect.top;
    var cssW = sim.canvas.clientWidth, cssH = sim.canvas.clientHeight;
    return {
      x: (cx - (cssW / 2 + sim.panX)) / sim.scale,
      y: (cy - (cssH / 2 + sim.panY)) / sim.scale
    };
  }

  function scheduleGraphDraw() {
    var sim = pstate.graphSim;
    if (!sim || sim.drawScheduled) return;
    sim.drawScheduled = true;
    raf(function () { sim.drawScheduled = false; drawGraph(sim); });
  }

  function drawGraph(sim) {
    var ctx = sim.ctx;
    if (!ctx) return;
    var canvas = sim.canvas;
    var cssW = canvas.clientWidth || 1, cssH = canvas.clientHeight || 1;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(sim.dpr || 1, sim.dpr || 1);
    ctx.fillStyle = sim.colors.bg;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.translate(cssW / 2 + sim.panX, cssH / 2 + sim.panY);
    ctx.scale(sim.scale, sim.scale);

    var g = sim.g;
    var hoverIdx = sim.hoverIdx;
    var neighborSet = null;
    var i;
    if (hoverIdx != null) {
      neighborSet = {};
      for (i = 0; i < g.links.length; i++) {
        if (g.links[i].s === hoverIdx) neighborSet[g.links[i].t] = true;
        if (g.links[i].t === hoverIdx) neighborSet[g.links[i].s] = true;
      }
    }

    ctx.lineWidth = 1 / sim.scale;
    for (i = 0; i < g.links.length; i++) {
      var l = g.links[i];
      var hi = hoverIdx != null && (l.s === hoverIdx || l.t === hoverIdx);
      ctx.strokeStyle = hi ? sim.colors.accent : sim.colors.edge;
      ctx.globalAlpha = hoverIdx == null ? 0.5 : (hi ? 0.9 : 0.1);
      ctx.beginPath();
      ctx.moveTo(g.nodes[l.s].x, g.nodes[l.s].y);
      ctx.lineTo(g.nodes[l.t].x, g.nodes[l.t].y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    for (i = 0; i < g.nodes.length; i++) {
      var node = g.nodes[i];
      var dimmed = hoverIdx != null && i !== hoverIdx && !(neighborSet && neighborSet[i]);
      var r = nodeRadius(node.degree);
      ctx.globalAlpha = dimmed ? 0.25 : 1;
      ctx.fillStyle = communityColor(node.community);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (i === hoverIdx) {
        ctx.lineWidth = 2 / sim.scale;
        ctx.strokeStyle = sim.colors.accent;
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
    ctx.font = (11 / sim.scale) + 'px ' + sim.colors.font;
    ctx.fillStyle = sim.colors.text;
    ctx.textAlign = 'center';
    for (i = 0; i < sim.labelIdxs.length; i++) {
      var ln = g.nodes[sim.labelIdxs[i]];
      ctx.fillText(truncateLabel(ln.label), ln.x, ln.y - nodeRadius(ln.degree) - 3 / sim.scale);
    }
    if (hoverIdx != null && sim.labelIdxs.indexOf(hoverIdx) === -1) {
      var hn = g.nodes[hoverIdx];
      ctx.fillText(truncateLabel(hn.label), hn.x, hn.y - nodeRadius(hn.degree) - 3 / sim.scale);
    }
    ctx.restore();
  }

  function attachGraphInteraction(sim) {
    var canvas = sim.canvas;
    var dragging = false, lastX = 0, lastY = 0;
    function onDown(e) { dragging = true; lastX = e.clientX; lastY = e.clientY; }
    function onWinMove(e) {
      if (!dragging) return;
      sim.panX += e.clientX - lastX;
      sim.panY += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      scheduleGraphDraw();
    }
    function onWinUp() { dragging = false; }
    function onHoverMove(e) {
      if (dragging) return;
      var p = eventToGraphCoords(sim, e);
      var best = null, bestDist = Infinity;
      for (var i = 0; i < sim.g.nodes.length; i++) {
        var n = sim.g.nodes[i];
        var dx = n.x - p.x, dy = n.y - p.y;
        var d = dx * dx + dy * dy;
        var r = nodeRadius(n.degree) + 4;
        if (d < r * r && d < bestDist) { bestDist = d; best = i; }
      }
      if (best !== sim.hoverIdx) { sim.hoverIdx = best; scheduleGraphDraw(); }
    }
    function onLeave() {
      if (sim.hoverIdx != null) { sim.hoverIdx = null; scheduleGraphDraw(); }
    }
    function onWheel(e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      sim.scale = Math.max(0.2, Math.min(4, sim.scale * factor));
      scheduleGraphDraw();
    }
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onHoverMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);
    sim.teardownInteraction = function () {
      window.removeEventListener('mousemove', onWinMove);
      window.removeEventListener('mouseup', onWinUp);
    };
  }

  function initGraphSim(canvas, rawGraph) {
    var g = prepareGraph(rawGraph);
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    var sim = {
      canvas: canvas, ctx: ctx, g: g,
      panX: 0, panY: 0, scale: 1, dpr: 1,
      hoverIdx: null, settled: false, raf: null, drawScheduled: false,
      colors: themeColors(),
      labelIdxs: topDegreeIndexes(g.nodes, LABEL_COUNT)
    };
    resizeGraphCanvas(sim);
    attachGraphInteraction(sim);
    return sim;
  }

  function destroyGraphSim() {
    if (pstate.graphSim) {
      stopGraphLoop(pstate.graphSim);
      if (pstate.graphSim.teardownInteraction) pstate.graphSim.teardownInteraction();
      pstate.graphSim = null;
    }
  }

  function renderGraphTab() {
    var els = pstate.els;
    if (!els) return;
    var ctx = pstate.context;
    if (!ctx) {
      els.graphEmpty.hidden = false;
      els.graphEmpty.textContent = 'Loading graph...';
      els.graphCanvas.hidden = true;
      return;
    }
    var raw = ctx.graph;
    if (!raw || !raw.nodes || raw.nodes.length === 0) {
      destroyGraphSim();
      els.graphEmpty.hidden = false;
      els.graphEmpty.textContent = 'No graph nodes for this project yet';
      els.graphCanvas.hidden = true;
      return;
    }
    els.graphEmpty.hidden = true;
    els.graphCanvas.hidden = false;
    if (!pstate.graphSim) {
      pstate.graphSim = initGraphSim(els.graphCanvas, raw);
      if (prefersReducedMotion()) {
        settleSync(pstate.graphSim);
        drawGraph(pstate.graphSim);
      } else {
        startGraphLoop(pstate.graphSim);
      }
    } else {
      resizeGraphCanvas(pstate.graphSim);
      if (!pstate.graphSim.settled && !prefersReducedMotion()) startGraphLoop(pstate.graphSim);
      else drawGraph(pstate.graphSim);
    }
  }

  // ---------------------------------------------------------------------------
  // Project header/detail updates driven by server data
  // ---------------------------------------------------------------------------
  function updateProjectHeader(p) {
    var els = pstate.els;
    if (!els) return;
    els.nameEl.textContent = p.name || 'Untitled project';
    renderDescText(els, p.description || '');
    els.colorBtn.style.background = safeColor(p.color);
  }

  function applyProjectData(p) {
    pstate.projectDetail = p;
    updateProjectHeader(p);
    renderKnowledgeList();
    renderChatsList();

    if (pstate.saveState === 'saving' && pstate.lastSentInstructions != null) {
      if (p.instructions === pstate.lastSentInstructions) {
        pstate.lastConfirmedInstructions = p.instructions || '';
        pstate.lastSentInstructions = null;
        setSaveState('saved');
        var token = ++pstate.saveToken;
        setTimeout(function () {
          if (pstate.saveToken === token) setSaveState('idle');
        }, SAVED_INDICATOR_MS);
      }
      // else: a stale fetch raced ahead of the update - a later 'project'
      // push will match. Leave the indicator on "saving".
    } else if (document.activeElement !== pstate.els.instructions) {
      pstate.els.instructions.value = p.instructions || '';
      pstate.lastConfirmedInstructions = p.instructions || '';
    } else {
      pstate.lastConfirmedInstructions = p.instructions || '';
    }
  }

  // ---------------------------------------------------------------------------
  // Open / close the project view
  // ---------------------------------------------------------------------------
  function openProjectView(projectId) {
    var root = document.getElementById('project-view');
    if (!root) return;
    pstate.root = root;
    destroyGraphSim();
    if (pstate.els && pstate.els.graphResizeObserver) pstate.els.graphResizeObserver.disconnect();
    pstate.openProjectId = projectId;
    pstate.projectDetail = null;
    pstate.context = null;
    pstate.contextTab = 'memory';
    pstate.saveState = 'idle';
    pstate.lastSentInstructions = null;
    pstate.lastConfirmedInstructions = '';
    clearTimeout(pstate.saveTimer);

    root.removeAttribute('hidden');
    renderProjectShell(root);
    var els = pstate.els;
    els.nameEl.textContent = 'Loading...';
    renderKnowledgeList();
    renderChatsList();
    renderMemoryTab();
    switchTab('memory');

    host.onOpenView();
    host.wsSend({ type: 'get_project', id: projectId });
    host.wsSend({ type: 'project_context', id: projectId });
    refreshSidebar();
  }

  function closeProjectView() {
    destroyGraphSim();
    clearTimeout(pstate.saveTimer);
    var root = pstate.root || document.getElementById('project-view');
    if (root) {
      if (pstate.els && pstate.els.graphResizeObserver) pstate.els.graphResizeObserver.disconnect();
      root.setAttribute('hidden', '');
      root.innerHTML = '';
    }
    pstate.openProjectId = null;
    pstate.projectDetail = null;
    pstate.context = null;
    pstate.els = null;
    host.onCloseView();
    refreshSidebar();
  }

  // ---------------------------------------------------------------------------
  // WebSocket message routing
  // ---------------------------------------------------------------------------
  function handleServerMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'projects':
        pstate.projects = msg.projects || [];
        refreshSidebar();
        break;

      case 'project':
        if (msg.project && msg.project.id === pstate.openProjectId) {
          applyProjectData(msg.project);
        }
        break;

      case 'project_created':
        if (msg.project) {
          var exists = false;
          for (var i = 0; i < pstate.projects.length; i++) {
            if (pstate.projects[i].id === msg.project.id) { exists = true; break; }
          }
          if (!exists) pstate.projects.unshift(msg.project);
          refreshSidebar();
          if (pstate.pendingCreate) {
            pstate.pendingCreate = false;
            openProjectView(msg.project.id);
          }
        }
        break;

      case 'project_updated':
        if (msg.project) {
          for (var j = 0; j < pstate.projects.length; j++) {
            if (pstate.projects[j].id === msg.project.id) { pstate.projects[j] = msg.project; break; }
          }
          refreshSidebar();
          if (msg.project.id === pstate.openProjectId) applyProjectData(msg.project);
        }
        break;

      case 'project_deleted':
        pstate.projects = pstate.projects.filter(function (p) { return p.id !== msg.id; });
        refreshSidebar();
        if (msg.id === pstate.openProjectId) closeProjectView();
        break;

      case 'project_context':
        if (msg.id === pstate.openProjectId) {
          pstate.context = { memory: msg.memory || [], graph: msg.graph || null, brain: msg.brain || [] };
          renderMemoryTab();
          renderBrainTab();
          if (pstate.contextTab === 'graph') renderGraphTab();
        }
        break;

      case 'session_assigned':
        // app.js's own switch updates state.sessions right after this
        // handler returns, so defer the re-render until that lands.
        setTimeout(function () {
          if (pstate.openProjectId) renderChatsList();
          refreshSidebar();
        }, 0);
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------
  function init(opts) {
    opts = opts || {};
    if (typeof opts.wsSend === 'function') host.wsSend = opts.wsSend;
    if (typeof opts.openSession === 'function') host.openSession = opts.openSession;
    if (typeof opts.getState === 'function') host.getState = opts.getState;
    if (typeof opts.onOpenView === 'function') host.onOpenView = opts.onOpenView;
    if (typeof opts.onCloseView === 'function') host.onCloseView = opts.onCloseView;
    bindDocListenersOnce();
    host.wsSend({ type: 'list_projects' });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (pstate.graphSim && pstate.contextTab === 'graph' && pstate.openProjectId) {
        resizeGraphCanvas(pstate.graphSim);
        scheduleGraphDraw();
      }
    }, 150);
  });

  if (window.MutationObserver) {
    // window-qualified to match the guard — a bare global is identical in a
    // browser but unresolvable under jsdom, which makes this file untestable.
    new window.MutationObserver(function () {
      if (pstate.graphSim) {
        pstate.graphSim.colors = themeColors();
        scheduleGraphDraw();
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  window.RuflowProjects = {
    init: init,
    renderSidebarSection: renderSidebarSection,
    openProjectView: openProjectView,
    closeProjectView: closeProjectView,
    handleServerMessage: handleServerMessage,
    openAttachMenu: openAttachMenu,
    closeAttachMenu: closeAttachMenu
  };
})();

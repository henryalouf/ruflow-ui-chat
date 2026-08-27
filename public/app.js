/**
 * Ruflow Chat Interface - Client Application
 * Vanilla JS, no frameworks, no modules.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var state = {
    currentSessionId: null,
    sessions: [],
    isStreaming: false,
    attachedFiles: [],
    isRecording: false,
    ws: null,
    // SPEC-v2.md U4-RENDER: the single-bubble accumulator (currentAssistantText/
    // currentAssistantEl/currentToolBlocks) is gone. A turn is now a RunRender
    // view over a RunModel Run (public/run-model.js, public/run-render.js) —
    // currentRunView is the run currently streaming (or null between turns);
    // allRunViews keeps every view mounted in the current chat (live + saved)
    // so a tool_output_full reply can be routed without a separate toolId index
    // (RunView.setToolOutput() is a no-op on any view that doesn't own the id).
    currentRunView: null,
    allRunViews: [],
    reconnectAttempts: 0,
    userHasScrolledUp: false,
    recognition: null,
    sessionTotalCost: 0,
    sessionTotalDuration: 0,
    lastUserMessage: '',
    // Feature additions
    slashMenuOpen: false,
    slashMenuIndex: 0,
    multiSelectMode: false,
    selectedMessages: new Set(),
    sessionSortMode: localStorage.getItem('ruflow-session-sort') || 'recent',
    commandPaletteOpen: false,
    systemPrompts: JSON.parse(localStorage.getItem('ruflow-system-prompts') || '{}'),
    pinnedSessions: JSON.parse(localStorage.getItem('ruflow-pinned-sessions') || '[]'),
    chatZoom: parseInt(localStorage.getItem('ruflow-chat-zoom') || '100', 10),
    searchOpen: false,
    searchMatches: [],
    searchMatchIndex: -1,
    verbose: localStorage.getItem('ruflow-verbose') === 'true',
    thinkingLevel: localStorage.getItem('ruflow-think-level') || 'medium',
    ttsEnabled: localStorage.getItem('ruflow-tts') !== 'off'
  };

  // This box's HOME (server.js sets env.HOME to the same value at spawn) —
  // passed to RunRender as `home` so tool-target paths display as `~/...`
  // instead of the full absolute path. Display-only, never mutates model data.
  var RUFLOW_HOME = '/home/claude-user';

  var MAX_RECONNECT_ATTEMPTS = 10;
  var RECONNECT_DELAY = 1000;
  var IMAGE_MAX_SIZE = 10 * 1024 * 1024;
  var DOC_MAX_SIZE = 5 * 1024 * 1024;
  var IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  var DOC_EXTENSIONS = ['pdf', 'txt', 'md', 'js', 'ts', 'json', 'py', 'html', 'css'];

  // ---------------------------------------------------------------------------
  // Markdown setup
  // ---------------------------------------------------------------------------
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      highlight: function (code, lang) {
        if (typeof hljs !== 'undefined') {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return hljs.highlightAuto(code).value;
        }
        return code;
      },
      breaks: true
    });
  }

  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return escapeHtml(text).replace(/\n/g, '<br>');
    var html = marked.parse(text || '');
    if (typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(html);
    }
    return html;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /*
   * escapeHtml is NOT safe inside an attribute.
   *
   * It serialises a text node, and text-node serialisation escapes &, < and >
   * but leaves the double quote alone, because a quote is not special in text.
   * Inside alt="..." that quote closes the attribute early. Tag injection still
   * fails — < is escaped — but ATTRIBUTE injection succeeds: an uploaded file
   * named  x" onerror="…  lands an onerror handler on the img. Verified in
   * chromium; the rendered element came back with class, src, alt AND onerror.
   *
   * That is a session compromise rather than a defacement, because the page
   * holding the WebSocket is the page executing it — script there can call
   * wsSend({type:'chat'}) directly against a --dangerously-skip-permissions CLI.
   * The server's upload gate does not help: path.extname('x" onerror="….png')
   * is still '.png'.
   */
  function escapeAttr(str) {
    return escapeHtml(String(str == null ? '' : str)).replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------------
  // SVG icons for tools
  // ---------------------------------------------------------------------------
  var TOOL_ICONS = {
    Read: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    Grep: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    Glob: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    Write: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    Edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    Bash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
  };

  function getToolIcon(toolName) {
    if (TOOL_ICONS[toolName]) return TOOL_ICONS[toolName];
    if (/read|grep|glob/i.test(toolName)) return TOOL_ICONS.Grep;
    if (/write/i.test(toolName)) return TOOL_ICONS.Write;
    if (/edit/i.test(toolName)) return TOOL_ICONS.Edit;
    if (/bash|terminal|shell/i.test(toolName)) return TOOL_ICONS.Bash;
    return TOOL_ICONS.Read;
  }

  // ---------------------------------------------------------------------------
  // WebSocket with improved reconnect (#8)
  // ---------------------------------------------------------------------------
  /*
   * Projects module wiring. Everything it needs is injected, so it never reaches
   * into app.js state directly — that keeps this integration to these few lines.
   */
  var PROJECT_MSG_TYPES = {
    projects: 1, project: 1, project_created: 1, project_updated: 1,
    project_deleted: 1, project_context: 1, session_assigned: 1,
  };
  var projectsBooted = false;

  function initProjects() {
    if (projectsBooted || !window.RuflowProjects) return;
    projectsBooted = true;
    window.RuflowProjects.init({
      wsSend: wsSend,
      openSession: function (id) {
        window.RuflowProjects.closeProjectView();
        showChatArea();
        wsSend({ type: 'load_session', sessionId: id });
      },
      getState: function () {
        return { currentSessionId: state.currentSessionId, sessions: state.sessions };
      },
      onOpenView: function () { hideChatArea(); },
      onCloseView: function () { showChatArea(); },
    });
    window.RuflowProjects.renderSidebarSection(document.getElementById('projects-section'));

    /*
     * "Add this chat to a project". The menu itself lives in projects.js; this is
     * only its trigger, because that module cannot reach into this file. Disabled
     * until a session actually exists — attaching nothing is a no-op that would
     * silently do nothing and read as broken.
     */
    var attachBtn = document.getElementById('attach-project-btn');
    if (attachBtn) {
      attachBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!state.currentSessionId) return;
        window.RuflowProjects.openAttachMenu(attachBtn, state.currentSessionId);
      });
    }
  }

  function hideChatArea() {
    var cm = document.getElementById('chat-messages');
    var ia = document.getElementById('input-area');
    if (cm) cm.hidden = true;
    if (ia) ia.hidden = true;
  }

  function showChatArea() {
    var cm = document.getElementById('chat-messages');
    var ia = document.getElementById('input-area');
    if (cm) cm.hidden = false;
    if (ia) ia.hidden = false;
  }

  function connectWebSocket() {
    var WS_URL = 'ws://' + window.location.host;
    var ws = new WebSocket(WS_URL);
    state.ws = ws;

    ws.onopen = function () {
      state.reconnectAttempts = 0;
      showReconnectBanner('connected');
      updateConnectionStatus(true);
      ws.send(JSON.stringify({ type: 'list_sessions' }));
      ws.send(JSON.stringify({ type: 'list_projects' }));
      initProjects();
    };

    ws.onclose = function () {
      state.ws = null;
      updateConnectionStatus(false);
      if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        var delay = Math.min(RECONNECT_DELAY * Math.pow(2, state.reconnectAttempts), 15000);
        showReconnectBanner('disconnected', state.reconnectAttempts);
        setTimeout(connectWebSocket, delay);
        state.reconnectAttempts++;
      } else {
        showReconnectBanner('failed');
      }
    };

    ws.onerror = function () {};
    ws.onmessage = handleMessage;
  }

  function wsSend(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function updateConnectionStatus(connected) {
    var dot = document.getElementById('connection-status');
    if (dot) {
      dot.className = 'connection-dot ' + (connected ? 'connected' : 'disconnected');
      dot.title = connected ? 'Connected' : 'Disconnected';
    }
  }

  function showReconnectBanner(status, attempt) {
    var banner = document.getElementById('reconnect-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'reconnect-banner';
      document.body.appendChild(banner);
    }
    if (status === 'connected') {
      if (attempt !== undefined || banner.dataset.wasDisconnected === 'true') {
        banner.className = 'reconnect-banner connected';
        banner.innerHTML = 'Reconnected';
        banner.style.display = 'block';
        banner.dataset.wasDisconnected = 'false';
        setTimeout(function () { banner.style.display = 'none'; }, 3000);
      } else {
        banner.style.display = 'none';
      }
    } else if (status === 'disconnected') {
      banner.className = 'reconnect-banner disconnected';
      banner.innerHTML = 'Connection lost. Reconnecting... (attempt ' + ((attempt || 0) + 1) + ')';
      banner.style.display = 'block';
      banner.dataset.wasDisconnected = 'true';
    } else if (status === 'failed') {
      banner.className = 'reconnect-banner failed';
      banner.innerHTML = 'Unable to connect. <button onclick="window.__retryConnect()">Click to retry</button>';
      banner.style.display = 'block';
    }
  }

  window.__retryConnect = function () {
    state.reconnectAttempts = 0;
    connectWebSocket();
  };

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------
  function handleMessage(event) {
    var data;
    try { data = JSON.parse(event.data); } catch (e) { return; }

    /*
     * Projects own their own message types. Routed before the main switch so the
     * module stays self-contained — app.js never has to know its internals.
     */
    if (window.RuflowProjects && PROJECT_MSG_TYPES[data.type]) {
      window.RuflowProjects.handleServerMessage(data);
      if (data.type !== 'session_assigned') return;
    }

    switch (data.type) {
      case 'session_list':
        state.sessions = data.sessions || [];
        renderSessionList();
        break;

      case 'session_loaded':
        state.currentSessionId = data.session.id;
        state.sessionTotalCost = 0;
        state.sessionTotalDuration = 0;
        highlightActiveSession();
        renderAllMessages(data.session.messages || []);
        updateSessionName(data.session.name || 'Chat');
        updateContextIndicator(data.session.messages ? data.session.messages.length : 0);
        loadSystemPromptForSession();
        break;

      case 'session_created':
        state.currentSessionId = data.session.id;
        state.sessionTotalCost = 0;
        state.sessionTotalDuration = 0;
        state.sessions.unshift(data.session);
        renderSessionList();
        clearChatArea();
        updateSessionName(data.session.name || 'New Chat');
        updateContextIndicator(0);
        break;

      case 'session_deleted':
        state.sessions = state.sessions.filter(function (s) { return s.id !== data.sessionId; });
        renderSessionList();
        if (state.currentSessionId === data.sessionId) {
          state.currentSessionId = null;
          if (state.sessions.length > 0) {
            wsSend({ type: 'load_session', sessionId: state.sessions[0].id });
          } else {
            clearChatArea();
            showWelcomeScreen();
            updateContextIndicator(0);
          }
        }
        break;

      case 'session_renamed':
        for (var i = 0; i < state.sessions.length; i++) {
          if (state.sessions[i].id === data.sessionId) {
            state.sessions[i].name = data.name;
            break;
          }
        }
        renderSessionList();
        if (state.currentSessionId === data.sessionId) {
          updateSessionName(data.name);
        }
        break;

      // SPEC-v2.md U4-RENDER: every stream_* event (envelope already carries
      // runId/seq/lane, stamped server-side by lib/stream-events.js's
      // emitStream) is a thin dispatch into the RunModel/RunRender pipeline —
      // no per-type DOM building here, that all lives in run-render.js.
      case 'stream_lifecycle':
        if (data.phase === 'spawning') beginRun(data);
        else if (state.currentRunView) state.currentRunView.ingest(data);
        break;

      case 'stream_start':
        state.isStreaming = true;
        showCancelButton();
        if (state.currentRunView) state.currentRunView.ingest(data);
        break;

      case 'stream_text':
      case 'stream_thinking':
      case 'stream_tool_start':
      case 'stream_tool_result':
      case 'stream_lane_open':
      case 'stream_lane_close':
      case 'stream_fallback':
        if (state.currentRunView) state.currentRunView.ingest(data);
        break;

      case 'stream_end':
        state.isStreaming = false;
        hideCancelButton();
        if (state.currentRunView) {
          state.currentRunView.ingest(data);
          addRunActions(state.currentRunView);
          appendFollowUps(state.currentRunView, data.followUps);
        }
        if (document.hidden) playNotifSound();
        if (data.duration && Number(data.duration) > 5000) flashTabTitle('Task completed');
        // Track session totals (#5, #6)
        if (data.cost) state.sessionTotalCost += Number(data.cost);
        if (data.duration) state.sessionTotalDuration += Number(data.duration);
        updateContextIndicator(countTurnEls());
        maybeAutoTitle();
        state.currentRunView = null;
        break;

      case 'stream_error':
        state.isStreaming = false;
        hideCancelButton();
        var rawError = data.error || data.message || 'An error occurred';
        var friendlyError;
        if (rawError.indexOf('exit code') !== -1) {
          friendlyError = 'Claude process crashed. Try again.';
        } else if (rawError.indexOf('SIGTERM') !== -1) {
          friendlyError = 'Response was cancelled.';
        } else {
          friendlyError = rawError;
        }
        if (state.currentRunView) {
          // Same envelope, friendlier text — onError() just stores it in a
          // note block, so this is the one place to swap the string.
          state.currentRunView.ingest(Object.assign({}, data, { error: friendlyError }));
          // Some failure paths (spawn ENOENT, etc.) never reach a 'result'
          // event server-side, so a stream_end that would otherwise stop this
          // run's ticker may never arrive. Stop it now — ingest() above is
          // still safe to call again later if stream_end does show up.
          state.currentRunView.destroy();
        } else {
          appendErrorMessage(friendlyError);
        }
        break;

      case 'tool_output_full':
        // The "Load full output" button past TOOL_OUTPUT_RENDER_CHARS
        // (run-render.js) — setToolOutput() is a no-op on any view that
        // doesn't own this toolId, so broadcasting to all of them is safe.
        for (var rvi = 0; rvi < state.allRunViews.length; rvi++) {
          state.allRunViews[rvi].setToolOutput(data.toolId, data.content);
        }
        break;

      case 'session_exported':
        downloadAsFile(data.markdown, (state.sessions.find(function(s){ return s.id === data.sessionId; }) || {}).name + '.md', 'text/markdown');
        break;

      case 'search_results':
        renderSearchResults(data.results || []);
        break;

      case 'status_info':
        showStatusPanel(data);
        break;

      case 'session_compacted':
        showNotification('Session compacted: ' + data.originalCount + ' → ' + data.newCount + ' messages', 'info');
        if (state.currentSessionId === data.sessionId) {
          wsSend({ type: 'load_session', sessionId: data.sessionId });
        }
        break;

      case 'session_stats':
        showSessionStatsPanel(data.stats);
        break;

      case 'chat_queued':
        showNotification('Message queued (position ' + data.position + '). Waiting for current response...', 'info');
        break;

      case 'memory_added':
        break;

      case 'memory_results':
        showMemoryPanel('Search Results', data.results || []);
        break;

      case 'memory_list':
        showMemoryPanel('Memories', data.entries || []);
        break;

      case 'memory_deleted':
        showNotification('Memory entry deleted', 'info');
        break;

      case 'memory_cleared':
        showNotification('All memories cleared', 'info');
        break;

      case 'trash_list':
        showTrashPanel(data.items || []);
        break;

      case 'session_restored':
        showNotification('Session restored: ' + (data.session?.name || 'unknown'), 'info');
        wsSend({ type: 'list_sessions' });
        break;

      case 'message_edited':
        if (data.sessionId === state.currentSessionId) {
          renderAllMessages(data.messages);
          showNotification('Message edited — conversation branched', 'info');
        }
        break;

      case 'error':
        showNotification(data.message || data.error || 'Error', 'error');
        break;
    }
  }

  function downloadAsFile(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'export.md';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderSearchResults(results) {
    var list = document.getElementById('session-list');
    if (!list) return;
    if (results.length === 0) { showNotification('No sessions found', 'info'); renderSessionList(); return; }
    list.innerHTML = '';
    for (var i = 0; i < results.length; i++) {
      var s = results[i];
      var item = document.createElement('div');
      item.className = 'session-item' + (s.id === state.currentSessionId ? ' active' : '');
      item.setAttribute('data-id', s.id);
      item.innerHTML = '<span class="session-name">' + escapeHtml(s.name || 'Untitled') + '</span><span class="session-time">' + s.messageCount + ' msgs</span>';
      list.appendChild(item);
    }
  }

  // ---------------------------------------------------------------------------
  // SPEC-v2.md U4-RENDER — mount/replay a Run through public/run-render.js.
  //
  // This replaces the old single-bubble path (state.currentAssistantText,
  // createAssistantMessageEl, renderStreamingContent, finalizeAssistantMessage,
  // and the 80ms full re-parse timer that drove it). A live turn is now a
  // RunView mounted at spawn and fed every subsequent event via .ingest();
  // a reloaded turn with a persisted blocks[] replays through the SAME
  // builders via RunRender.renderSavedRun() — "one renderer, two entry
  // points" (SPEC-v2.md U2-PERSIST). Old sessions with no blocks[] still go
  // through the legacy bubble path in renderSavedMessage() below.
  // ---------------------------------------------------------------------------
  function beginRun(data) {
    /*
     * Housekeeping turns (title generation) stream like any other but were
     * never asked for by the user, so they get no run header and no place in
     * the transcript. Without this the title call renders as a stray empty run
     * under the real answer.
     */
    if (data && data.system) return;
    var container = document.getElementById('chat-messages');
    if (!container) return;
    hideWelcomeScreen();
    // Defensive: a prior run's stream_end never arrived (e.g. the ENOENT
    // spawn-failure path, which has no guaranteed close-then-result chain
    // server-side) — stop its ticker before this one starts registering.
    if (state.currentRunView) state.currentRunView.destroy();
    var view = RunRender.mountRun(container, {
      id: data.runId, sessionId: state.currentSessionId, startedAt: Date.now(), home: RUFLOW_HOME,
    });
    state.currentRunView = view;
    state.allRunViews.push(view);
    autoScroll(true);
  }

  // run-render.js owns the run's own DOM (header/trail/verdict/footer) but,
  // being mounted outside any `.message`, has no equivalent of the old
  // bubble's hover-revealed copy/regenerate/speak row (`.msg-actions` is
  // only shown via a `.message:hover` rule in style.css — not mine to
  // extend here). Appended as an always-visible sibling instead of leaving
  // these controls gone entirely.
  function addRunActions(view) {
    if (!view || !view.root || !view.root.parentNode) return;
    var actions = document.createElement('div');
    actions.className = 'msg-actions run-actions';
    actions.style.opacity = '1';

    function runText() {
      var text = '';
      view.root.querySelectorAll('.message-text').forEach(function (t) { text += t.textContent + '\n\n'; });
      return text.trim();
    }

    var copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    copyBtn.onclick = function () {
      navigator.clipboard.writeText(runText()).then(function () { showNotification('Copied to clipboard', 'info'); });
    };
    actions.appendChild(copyBtn);

    var speakBtn = document.createElement('button');
    speakBtn.className = 'msg-action-btn';
    speakBtn.title = 'Read aloud';
    speakBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"/></svg>';
    speakBtn.onclick = function () { speakText(runText()); };
    actions.appendChild(speakBtn);

    var regenBtn = document.createElement('button');
    regenBtn.className = 'msg-action-btn';
    regenBtn.title = 'Regenerate';
    regenBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
    regenBtn.onclick = function () {
      if (state.currentSessionId) {
        wsSend({ type: 'regenerate', sessionId: state.currentSessionId, model: document.getElementById('model-selector')?.value || 'sonnet' });
      }
    };
    actions.appendChild(regenBtn);

    view.root.parentNode.insertBefore(actions, view.root.nextSibling);
  }

  // Same follow-up chips the old finalizeAssistantMessage() built, now
  // appended after the run's own DOM instead of inside a bubble.
  function appendFollowUps(view, followUps) {
    if (!followUps || followUps.length === 0 || !view || !view.root || !view.root.parentNode) return;
    var sugDiv = document.createElement('div');
    sugDiv.className = 'follow-up-suggestions';
    for (var fi = 0; fi < followUps.length; fi++) {
      var chip = document.createElement('button');
      chip.className = 'follow-up-chip';
      chip.textContent = followUps[fi];
      chip.addEventListener('click', (function (text) {
        return function () {
          var ta = document.getElementById('message-input');
          if (ta) { ta.value = text; ta.focus(); autoResizeTextarea(); }
          var sb = document.getElementById('send-btn');
          if (sb) sb.disabled = false;
        };
      })(followUps[fi]));
      sugDiv.appendChild(chip);
    }
    view.root.parentNode.insertBefore(sugDiv, view.root.nextSibling);
  }

  // Turns rendered via RunRender are `.run` sections, not `.message` bubbles —
  // every place that used to count `#chat-messages .message` for context
  // size / auto-title gating needs both now.
  function countTurnEls() {
    var cm = document.getElementById('chat-messages');
    return cm ? cm.querySelectorAll(':scope > .message, :scope > .run').length : 0;
  }

  function findSessionModel() {
    var s = state.sessions.find(function (s) { return s.id === state.currentSessionId; });
    return (s && s.model) || null;
  }

  function makeCollapsibleIfLong(el) {
    var content = el.querySelector('.message-text');
    if (!content) return;
    // Wait a frame for render
    requestAnimationFrame(function() {
      if (content.scrollHeight > 600) {
        el.classList.add('collapsible');
        el.classList.add('collapsed');
        var toggle = document.createElement('button');
        toggle.className = 'collapse-toggle-btn';
        toggle.textContent = 'Show more';
        toggle.addEventListener('click', function() {
          el.classList.toggle('collapsed');
          toggle.textContent = el.classList.contains('collapsed') ? 'Show more' : 'Show less';
        });
        el.appendChild(toggle);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Create / render messages
  // ---------------------------------------------------------------------------
  function renderAllMessages(messages) {
    clearChatArea();
    if (!messages || messages.length === 0) { showWelcomeScreen(); return; }
    hideWelcomeScreen();
    for (var i = 0; i < messages.length; i++) {
      renderSavedMessage(messages[i], i);
    }
    autoScroll(true);
  }

  function renderSavedMessage(msg, idx) {
    var chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    // U2-PERSIST: an assistant message with an ordered blocks[] replays
    // through the SAME run renderer a live turn used (SPEC-v2.md "one
    // renderer, two entry points"). Older sessions have no blocks[] and fall
    // through to the legacy bubble path below — expected and acceptable per
    // spec ("DO NOT backfill interleaving into old sessions"), not a bug.
    if (msg.role === 'assistant' && msg.blocks && msg.blocks.length > 0) {
      var savedView = RunRender.renderSavedRun(chatMessages, {
        id: 'run_' + (idx != null ? idx : Math.random()) + '_' + (msg.timestamp || Date.now()),
        sessionId: state.currentSessionId,
        model: findSessionModel(),
        blocks: msg.blocks,
        // Persisted assistant messages don't carry duration/cost/model/status
        // today (lib/stream-events.js's persistTurn() only writes
        // content/toolBlocks/blocks) — the trail still opens correctly on a
        // failed turn regardless, since wrapTrail() counts each block's own
        // err state, not this top-level flag. The footer just reads blank
        // where those fields are missing.
        status: 'ok',
        duration: msg.duration != null ? msg.duration : null,
        cost: msg.cost != null ? msg.cost : null,
        outputTokens: msg.outputTokens != null ? msg.outputTokens : null,
        tokensPerSecond: msg.tokensPerSecond != null ? msg.tokensPerSecond : null,
        home: RUFLOW_HOME,
      });
      state.allRunViews.push(savedView);
      addRunActions(savedView);
      return;
    }

    var el = document.createElement('div');
    el.className = 'message ' + (msg.role || 'user');

    if (msg.role === 'user') {
      var content = '<div class="msg-avatar">U</div><div class="message-content"><div class="message-text">' + escapeHtml(msg.content || '').replace(/\n/g, '<br>') + '</div>';
      if (msg.images && msg.images.length > 0) {
        content += '<div class="message-images">';
        for (var j = 0; j < msg.images.length; j++) {
          content += '<img class="message-image" src="data:image/png;base64,' + msg.images[j].data + '" alt="' + escapeAttr(msg.images[j].name) + '" />';
        }
        content += '</div>';
      }
      if (msg.files && msg.files.length > 0) {
        content += '<div class="message-files">';
        for (var k = 0; k < msg.files.length; k++) {
          content += '<span class="file-badge">' + escapeHtml(msg.files[k].name) + '</span>';
        }
        content += '</div>';
      }
      content += '</div>';
      el.innerHTML = content;
    } else {
      var html = '<div class="msg-avatar">C</div><div class="message-content"><div class="message-text">' + renderMarkdown(msg.content || '') + '</div>';
      var tools = msg.toolBlocks || msg.tools || [];
      if (tools.length > 0) {
        html += '<div class="tool-blocks">';
        for (var t = 0; t < tools.length; t++) {
          html += buildToolBlockHtml(tools[t]);
        }
        html += '</div>';
      }
      html += '</div>';
      el.innerHTML = html;
    }

    appendToChat(chatMessages, el);
    enhanceCodeBlocks(el);
    addMessageActions(el, msg.role || 'user');
    if (msg.timestamp) {
      var ts = document.createElement('div');
      ts.className = 'msg-timestamp';
      ts.setAttribute('data-iso', msg.timestamp);
      ts.textContent = relativeTime(msg.timestamp);
      ts.title = new Date(msg.timestamp).toLocaleString();
      el.appendChild(ts);
    }
    addWordCountTooltip(el);
    if (msg.role === 'assistant') enhanceInlineImages(el);
    makeCollapsibleIfLong(el);
  }

  /*
   * Everything in the transcript must go in before #tail-sentinel.
   *
   * run-render.js mounts every run with insertBefore(runEl, sentinel), so the
   * sentinel is the end-of-transcript marker. appendChild puts a node AFTER it,
   * which is why user messages were sinking below the run that answered them —
   * you typed at the bottom and your question appeared under the reply.
   *
   * The sentinel has to stay last for its IntersectionObserver to mean
   * "scrolled to the end", so the fix is to append before it rather than to
   * move it.
   */
  function appendToChat(container, el) {
    var sentinel = container.querySelector('#tail-sentinel');
    if (sentinel && sentinel.parentNode === container) container.insertBefore(el, sentinel);
    else container.appendChild(el);
    return el;
  }

  function appendUserMessage(text, images, files) {
    var chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;
    hideWelcomeScreen();
    var el = document.createElement('div');
    el.className = 'message user';
    var content = '<div class="msg-avatar">U</div><div class="message-content"><div class="message-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
    if (images && images.length > 0) {
      content += '<div class="message-images">';
      for (var j = 0; j < images.length; j++) {
        content += '<img class="message-image" src="data:image/png;base64,' + images[j].data + '" alt="' + escapeAttr(images[j].name) + '" />';
      }
      content += '</div>';
    }
    if (files && files.length > 0) {
      content += '<div class="message-files">';
      for (var k = 0; k < files.length; k++) {
        content += '<span class="file-badge">' + escapeHtml(files[k].name) + '</span>';
      }
      content += '</div>';
    }
    content += '</div>';
    el.innerHTML = content;
    appendToChat(chatMessages, el);
    addTimestamp(el);
    addMessageActions(el, 'user');
    animateMessageEntrance(el);
    autoScroll(true);
  }

  function appendErrorMessage(message) {
    var chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;
    var el = document.createElement('div');
    el.className = 'message assistant';
    el.innerHTML = '<div class="message-content"><div class="message-text"><div class="error-message">' + escapeHtml(message) + '</div></div></div>';
    appendToChat(chatMessages, el);
    autoScroll();
  }

  // ---------------------------------------------------------------------------
  // Feature #10: Message actions (Copy, Retry, Delete)
  // ---------------------------------------------------------------------------
  function addMessageActions(el, role) {
    if (el.querySelector('.msg-actions')) return;
    var actions = document.createElement('div');
    actions.className = 'msg-actions';

    // Copy button
    var copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    copyBtn.onclick = function () {
      var textEl = el.querySelector('.message-text');
      if (textEl) {
        navigator.clipboard.writeText(textEl.textContent).then(function () {
          showNotification('Copied to clipboard', 'info');
        });
      }
    };
    actions.appendChild(copyBtn);

    // Retry button (user messages only)
    if (role === 'user') {
      var retryBtn = document.createElement('button');
      retryBtn.className = 'msg-action-btn';
      retryBtn.title = 'Retry';
      retryBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
      retryBtn.onclick = function () {
        var textEl = el.querySelector('.message-text');
        if (textEl) {
          var text = textEl.textContent;
          var modelSelect = document.getElementById('model-selector');
          var model = modelSelect ? modelSelect.value : 'sonnet';
          wsSend({ type: 'chat', message: text, sessionId: state.currentSessionId, model: model });
        }
      };
      actions.appendChild(retryBtn);

      var editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.title = 'Edit';
      editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      editBtn.onclick = function() {
        var textEl = el.querySelector('.message-text');
        if (textEl) {
          var ta = document.getElementById('message-input');
          if (ta) { ta.value = textEl.textContent; ta.focus(); autoResizeTextarea(); }
          var sb = document.getElementById('send-btn');
          if (sb) sb.disabled = false;
        }
      };
      actions.appendChild(editBtn);
    }

    // TTS button (assistant messages only)
    if (role === 'assistant') {
      var speakBtn = document.createElement('button');
      speakBtn.className = 'msg-action-btn';
      speakBtn.title = 'Read aloud';
      speakBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"/></svg>';
      speakBtn.onclick = function() {
        var textEl = el.querySelector('.message-text');
        if (textEl) speakText(textEl.textContent);
      };
      actions.appendChild(speakBtn);

      var regenBtn = document.createElement('button');
      regenBtn.className = 'msg-action-btn';
      regenBtn.title = 'Regenerate';
      regenBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
      regenBtn.onclick = function() {
        if (state.currentSessionId) {
          wsSend({ type: 'regenerate', sessionId: state.currentSessionId, model: document.getElementById('model-selector')?.value || 'sonnet' });
        }
      };
      actions.appendChild(regenBtn);
    }

    el.appendChild(actions);
  }

  // ---------------------------------------------------------------------------
  // Feature #7: Enhanced tool blocks
  // ---------------------------------------------------------------------------
  function extractToolPath(toolName, input) {
    if (!input) return '';
    try {
      var parsed = typeof input === 'string' ? JSON.parse(input) : input;
      if (parsed.file_path) return parsed.file_path;
      if (parsed.path) return parsed.path;
      if (parsed.command) return parsed.command.length > 60 ? parsed.command.substring(0, 60) + '...' : parsed.command;
      if (parsed.pattern) return parsed.pattern;
    } catch (e) {}
    if (typeof input === 'string' && input.length < 80) return input;
    return '';
  }

  function getToolSummary(toolName, input, output) {
    var name = (toolName || '').replace(/^mcp__.*__/, '');
    try {
      var inp = typeof input === 'string' ? JSON.parse(input) : (input || {});
      var out = typeof output === 'string' ? output : '';
      if (name === 'Read' && inp.file_path) {
        var lines = out.split('\n').length;
        return inp.file_path.split('/').pop() + ' (' + lines + ' lines)';
      }
      if (name === 'Bash' && inp.command) {
        return '$ ' + (inp.command.length > 50 ? inp.command.substring(0, 50) + '...' : inp.command);
      }
      if (name === 'Write' && inp.file_path) {
        var wlines = (inp.content || '').split('\n').length;
        return inp.file_path.split('/').pop() + ' (' + wlines + ' lines written)';
      }
      if (name === 'Edit' && inp.file_path) {
        return inp.file_path.split('/').pop();
      }
    } catch (e) {}
    return extractToolPath(toolName, input);
  }

  function buildToolBlockHtml(tool) {
    var isError = tool.isError || tool.status === 'error';
    var statusClass = isError ? 'error' : (tool.status === 'running' ? 'running' : 'done');
    var statusText = isError ? 'Error' : (tool.status === 'running' ? 'Running' : 'Done');
    var name = tool.toolName || tool.name || 'Tool';
    var input = tool.toolInput || tool.input;
    var output = tool.toolOutput || tool.output;
    var summary = getToolSummary(name, input, output);
    var icon = getToolIcon(name);
    var inputStr = '';
    if (input) { inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2); }
    var outputStr = '';
    if (output) {
      outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      if (outputStr.length > 5000) {
        outputStr = outputStr.substring(0, 5000) + '\n... (truncated, ' + outputStr.length + ' chars total)';
      }
    }

    var copyOutputBtn = outputStr ? '<button class="tool-copy-btn" onclick="window.__copyToolOutput(this)">Copy</button>' : '';

    return '<div class="tool-block" data-tool-id="' + escapeAttr(tool.toolId || tool.id || '') + '">' +
      '<div class="tool-header" onclick="window.__toggleToolBlock(this)">' +
      '<span class="tool-icon">' + icon + '</span>' +
      '<span class="tool-name">' + escapeHtml(name.replace(/^mcp__.*__/, '')) + '</span>' +
      '<span class="tool-path">' + escapeHtml(summary) + '</span>' +
      '<span class="tool-status ' + statusClass + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="tool-body">' +
      (inputStr ? '<div class="tool-input"><pre>' + escapeHtml(inputStr) + '</pre></div>' : '') +
      '<div class="tool-output">' + copyOutputBtn + (outputStr ? '<pre>' + escapeHtml(outputStr) + '</pre>' : '') + '</div>' +
      '</div></div>';
  }

  // addToolBlock()/updateToolBlock() — the live-streaming counterparts of
  // buildToolBlockHtml() above — are gone. stream_tool_start/stream_tool_result
  // now route into the RunModel/RunRender pipeline (see the handleMessage
  // switch); buildToolBlockHtml() itself stays, still used by the legacy
  // no-blocks[] replay path in renderSavedMessage() below.

  window.__toggleToolBlock = function (header) {
    var block = header.parentElement;
    if (block) block.classList.toggle('expanded');
  };

  window.__copyToolOutput = function (btn) {
    var pre = btn.parentElement.querySelector('pre');
    if (pre) {
      navigator.clipboard.writeText(pre.textContent).then(function () {
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Feature #11: Enhanced code blocks (line numbers, wrap toggle)
  // ---------------------------------------------------------------------------
  function enhanceCodeBlocks(container) {
    if (!container) container = document;
    var blocks = container.querySelectorAll('pre code');
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var pre = block.parentElement;
      if (!pre || pre.querySelector('.copy-btn')) continue;
      pre.style.position = 'relative';

      // Copy button
      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', (function (codeBlock, button) {
        return function () {
          navigator.clipboard.writeText(codeBlock.textContent).then(function () {
            button.textContent = 'Copied!';
            setTimeout(function () { button.textContent = 'Copy'; }, 2000);
          });
        };
      })(block, btn));
      pre.appendChild(btn);

      // Language label
      var langMatch = block.className.match(/language-(\w+)/);
      if (langMatch) {
        var label = document.createElement('span');
        label.className = 'code-lang';
        label.textContent = langMatch[1];
        pre.appendChild(label);
      }

      // Line numbers for blocks over 5 lines
      var lines = block.textContent.split('\n');
      if (lines.length > 5) {
        pre.classList.add('has-line-numbers');
        var nums = document.createElement('span');
        nums.className = 'line-numbers';
        nums.setAttribute('aria-hidden', 'true');
        var numHtml = '';
        for (var ln = 1; ln <= lines.length; ln++) { numHtml += ln + '\n'; }
        nums.textContent = numHtml;
        pre.insertBefore(nums, pre.firstChild);
      }

      // Wrap toggle for long lines
      var hasLongLine = lines.some(function (l) { return l.length > 100; });
      if (hasLongLine) {
        var wrapBtn = document.createElement('button');
        wrapBtn.className = 'wrap-toggle-btn';
        wrapBtn.textContent = 'Wrap';
        wrapBtn.addEventListener('click', (function (preEl, wBtn) {
          return function () {
            preEl.classList.toggle('wrap-lines');
            wBtn.textContent = preEl.classList.contains('wrap-lines') ? 'No Wrap' : 'Wrap';
          };
        })(pre, wrapBtn));
        pre.appendChild(wrapBtn);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------
  function renderSessionList() {
    var list = document.getElementById('session-list');
    if (!list) return;
    var sorted = state.sessions.slice().sort(getSessionSortFn());
    // Separate pinned and unpinned
    var pinned = sorted.filter(function (s) { return state.pinnedSessions.indexOf(s.id) !== -1; });
    var unpinned = sorted.filter(function (s) { return state.pinnedSessions.indexOf(s.id) === -1; });
    list.innerHTML = '';
    // Pinned section
    if (pinned.length > 0) {
      var pinnedSection = document.createElement('div');
      pinnedSection.className = 'pinned-section';
      var pinnedLabel = document.createElement('div');
      pinnedLabel.className = 'pinned-section-label';
      pinnedLabel.textContent = 'Pinned';
      pinnedSection.appendChild(pinnedLabel);
      for (var p = 0; p < pinned.length; p++) {
        pinnedSection.appendChild(buildSessionItem(pinned[p], true));
      }
      list.appendChild(pinnedSection);
    }
    var lastGroup = null;
    for (var i = 0; i < unpinned.length; i++) {
      if (unpinned[i].group && unpinned[i].group !== lastGroup) {
        var gl = document.createElement('div');
        gl.className = 'session-group-label';
        gl.textContent = unpinned[i].group;
        list.appendChild(gl);
        lastGroup = unpinned[i].group;
      }
      list.appendChild(buildSessionItem(unpinned[i], false));
    }
    highlightActiveSession();
  }

  function buildSessionItem(s, isPinned) {
      var item = document.createElement('div');
      var isArchived = !!s.archived;
      item.className = 'session-item' + (s.id === state.currentSessionId ? ' active' : '') + (isPinned ? ' pinned' : '') + (isArchived ? ' archived' : '');
      item.setAttribute('data-id', s.id);
      item.addEventListener('contextmenu', function (e) { showSessionContextMenu(e, s.id); });
      var nameSpan = document.createElement('span');
      nameSpan.className = 'session-name';
      var displayName = s.name || 'Untitled';
      nameSpan.textContent = (isArchived ? '🗄 ' : '') + (displayName.length > 35 ? displayName.substring(0, 35) + '...' : displayName);
      item.appendChild(nameSpan);
      var metaSpan = document.createElement('span');
      metaSpan.className = 'session-time';
      var metaParts = [relativeTime(s.updatedAt)];
      if (s.messageCount) metaParts.push(s.messageCount + ' msgs');
      if (isArchived) metaParts.push('archived');
      metaSpan.textContent = metaParts.join(' \u00B7 ');
      item.appendChild(metaSpan);
      // Show restore button for archived, delete for active
      if (isArchived) {
        var restoreBtn = document.createElement('button');
        restoreBtn.className = 'session-restore-btn';
        restoreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
        restoreBtn.setAttribute('data-session-id', s.id);
        restoreBtn.title = 'Restore';
        item.appendChild(restoreBtn);
      }
      var delBtn = document.createElement('button');
      delBtn.className = 'session-delete-btn';
      /*
       * This had no accessible name at all: an icon-only DESTRUCTIVE button
       * announced as just "button", once per session — ~140 of them on a real
       * sidebar. The sibling restore button already gets its name from `title`,
       * so the pattern existed here and simply was not applied.
       */
      var delLabel = isArchived
        ? 'Permanently delete "' + (s.name || 'Untitled chat') + '"'
        : 'Archive "' + (s.name || 'Untitled chat') + '"';
      delBtn.title = delLabel;
      delBtn.setAttribute('aria-label', delLabel);
      delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      delBtn.setAttribute('data-session-id', s.id);
      delBtn.setAttribute('data-archived', isArchived ? '1' : '0');
      item.appendChild(delBtn);
      return item;
  }

  function highlightActiveSession() {
    var items = document.querySelectorAll('.session-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-id') === state.currentSessionId);
    }
  }

  function updateSessionName(name) {
    var el = document.getElementById('session-name');
    if (el) el.textContent = name || 'Chat';
  }

  // Feature #5: Context indicator
  function updateContextIndicator(msgCount) {
    var el = document.getElementById('context-indicator');
    if (!el) return;
    if (!state.currentSessionId || msgCount === 0) {
      el.innerHTML = '<span class="ctx-text">New session</span>';
      el.className = 'context-indicator';
    } else {
      var pct = Math.min(100, Math.round((msgCount / 80) * 100));
      var color = pct > 90 ? 'var(--error-red)' : pct > 70 ? '#f59e0b' : 'var(--success-green)';
      el.innerHTML = '<span class="ctx-text">' + msgCount + ' msgs</span>' +
        '<div class="ctx-bar"><div class="ctx-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
      if (state.sessionTotalCost > 0) {
        el.innerHTML += '<span class="ctx-cost">$' + state.sessionTotalCost.toFixed(3) + '</span>';
      }
      el.className = 'context-indicator';
    }
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
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getDate();
  }

  // ---------------------------------------------------------------------------
  // Feature #12: Welcome screen with quick actions
  // ---------------------------------------------------------------------------
  function clearChatArea() {
    // A live run's ticker must not keep counting against a torn-down DOM.
    if (state.currentRunView) state.currentRunView.destroy();
    state.currentRunView = null;
    state.allRunViews = [];
    var chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
      // run-render.js's ensureContainer() caches a context (the #tail-sentinel
      // reference every mountRun/renderSavedRun inserts before) on the
      // container element itself. The innerHTML replacement below destroys
      // that sentinel as a DOM node without app.js's help — clearing the
      // cached context here is what makes ensureContainer() rebuild it next
      // time, instead of insertBefore()-ing against a detached node.
      chatMessages._runRenderCtx = null;
      chatMessages.innerHTML = '<div id="welcome-screen" class="welcome-screen" style="display:none;">' +
        '<div class="welcome-logo">⚡</div>' +
        '<h1>Ruflow <span class="welcome-accent">Chat</span></h1>' +
        '<p>Your AI coding assistant — powered by Claude Code</p>' +
        '<div class="welcome-actions">' +
        '<button class="welcome-btn" data-prompt="Help me write a function that "><span class="welcome-btn-icon">💻</span>Start coding</button>' +
        '<button class="welcome-btn" data-prompt="Review this code for bugs:\\n\\n"><span class="welcome-btn-icon">🔍</span>Review code</button>' +
        '<button class="welcome-btn" data-prompt="I have a bug: "><span class="welcome-btn-icon">🐛</span>Debug issue</button>' +
        '<button class="welcome-btn" data-prompt="Explain how this works:\\n\\n"><span class="welcome-btn-icon">📖</span>Explain code</button>' +
        '</div>' +
        '<div class="welcome-hint"><kbd>Ctrl+K</kbd> Command palette · <kbd>Ctrl+N</kbd> New chat · <kbd>/</kbd> Slash commands</div>' +
        '</div>';
    }
  }

  function showWelcomeScreen() {
    var welcome = document.getElementById('welcome-screen');
    if (welcome) welcome.style.display = 'flex';
  }

  function hideWelcomeScreen() {
    var welcome = document.getElementById('welcome-screen');
    if (welcome) welcome.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------
  function autoScroll(force) {
    var chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;
    if (!force && state.userHasScrolledUp) return;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  /*
   * Coalesced to one read per frame.
   *
   * This is bound directly to the native scroll event, and it reads
   * scrollHeight/scrollTop/clientHeight — three synchronous layout flushes on
   * every scroll frame, which is exactly the stall the v2 renderer's
   * IntersectionObserver was introduced to remove.
   *
   * Not deleted, because new-format runs use the observer but LEGACY sessions
   * still render through this path, and old history has to keep working. rAF
   * coalescing gets the win without that trade.
   */
  var _scrollReadQueued = false;
  function checkScrollPosition() {
    if (_scrollReadQueued) return;
    _scrollReadQueued = true;
    requestAnimationFrame(function () {
      _scrollReadQueued = false;
      var chatMessages = document.getElementById('chat-messages');
      if (!chatMessages) return;
      state.userHasScrolledUp = (chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight) > 100;
      updateScrollToBottomBtn();
    });
  }

  // ---------------------------------------------------------------------------
  // Sending messages
  // ---------------------------------------------------------------------------
  function sendMessage() {
    // Allow sending while streaming — server will queue it
    var textarea = document.getElementById('message-input');
    if (!textarea) return;
    var text = textarea.value.trim();

    // Feature #1: Handle slash commands
    if (text.startsWith('/')) {
      // Handle new OpenClaw-style commands
      if (text === '/status') {
        wsSend({ type: 'get_status', sessionId: state.currentSessionId });
        showNotification('Loading status...', 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/compact') {
        if (state.currentSessionId) {
          wsSend({ type: 'compact_session', sessionId: state.currentSessionId, keepCount: 10 });
          showNotification('Compacting session context...', 'info');
        } else {
          showNotification('No active session to compact', 'error');
        }
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/usage') {
        if (state.currentSessionId) {
          wsSend({ type: 'get_session_stats', sessionId: state.currentSessionId });
          showNotification('Loading usage stats...', 'info');
        } else {
          showNotification('No active session. Send a message first.', 'error');
        }
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/duplicate') {
        if (state.currentSessionId) {
          wsSend({ type: 'duplicate_session', sessionId: state.currentSessionId });
          showNotification('Duplicating session...', 'info');
        }
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/doctor') {
        var diag = [];
        diag.push('WebSocket: ' + (state.ws && state.ws.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected'));
        diag.push('Session: ' + (state.currentSessionId || 'None'));
        diag.push('Sessions loaded: ' + state.sessions.length);
        diag.push('Streaming: ' + state.isStreaming);
        diag.push('Files attached: ' + state.attachedFiles.length);
        diag.push('Zoom: ' + state.chatZoom + '%');
        diag.push('Theme: ' + (document.documentElement.getAttribute('data-theme') || 'dark'));
        showNotification('Diagnostics:\n' + diag.join('\n'), 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text.startsWith('/think')) {
        var level = text.split(' ')[1] || 'medium';
        state.thinkingLevel = level;
        localStorage.setItem('ruflow-think-level', level);
        showNotification('Thinking level set to: ' + level, 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/tts') {
        state.ttsEnabled = !state.ttsEnabled;
        localStorage.setItem('ruflow-tts', state.ttsEnabled ? 'on' : 'off');
        showNotification('Text-to-speech: ' + (state.ttsEnabled ? 'ON' : 'OFF'), 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/cron') {
        wsSend({ type: 'chat', message: 'Run these commands and show the output:\n1. pm2 list\n2. crontab -l 2>/dev/null || echo "No crontab"\nFormat the output nicely.', sessionId: state.currentSessionId, model: document.getElementById('model-selector')?.value || 'sonnet' });
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/memory') {
        if (state.currentSessionId) {
          wsSend({ type: 'get_session_stats', sessionId: state.currentSessionId });
          showNotification('Loading session memory...', 'info');
        } else {
          showNotification('No active session. Send a message first.', 'error');
        }
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/heartbeat') {
        wsSend({ type: 'get_status', sessionId: state.currentSessionId });
        showNotification('Loading server status...', 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/trash') {
        wsSend({ type: 'list_trash' });
        showNotification('Loading trash...', 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text.startsWith('/restore')) {
        var restoreFile = text.substring(8).trim();
        if (restoreFile) {
          wsSend({ type: 'restore_session', file: restoreFile });
          showNotification('Restoring session...', 'info');
        } else {
          showNotification('Usage: /trash to see deleted sessions, then /restore <filename>', 'info');
        }
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text.startsWith('/remember ')) {
        var parts = text.substring(10).split('=');
        if (parts.length >= 2) {
          wsSend({ type: 'memory_add', key: parts[0].trim(), value: parts.slice(1).join('=').trim(), tags: ['user'] });
          showNotification('Saved to memory: ' + parts[0].trim(), 'info');
        } else {
          showNotification('Usage: /remember key = value', 'error');
        }
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text.startsWith('/recall')) {
        var q = text.substring(7).trim();
        if (q) {
          wsSend({ type: 'memory_search', query: q });
          showNotification('Searching memory...', 'info');
        } else {
          wsSend({ type: 'memory_list' });
          showNotification('Loading memories...', 'info');
        }
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/memories') {
        wsSend({ type: 'memory_list', limit: 50 });
        showNotification('Loading all memories...', 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/forget') {
        wsSend({ type: 'memory_clear' });
        showNotification('All memories cleared', 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/regenerate') {
        if (state.currentSessionId) {
          wsSend({ type: 'regenerate', sessionId: state.currentSessionId, model: document.getElementById('model-selector')?.value || 'sonnet' });
          showNotification('Regenerating...', 'info');
        }
        textarea.value = '';
        autoResizeTextarea();
        return;
      }
      if (text === '/verbose') {
        state.verbose = !state.verbose;
        localStorage.setItem('ruflow-verbose', state.verbose ? 'true' : 'false');
        showNotification('Verbose mode ' + (state.verbose ? 'enabled' : 'disabled'), 'info');
        textarea.value = '';
        autoResizeTextarea();
        return;
      }

      var cmd = text.split(' ')[0].toLowerCase();
      var matched = SLASH_COMMANDS.find(function (c) { return c.cmd === cmd; });
      if (matched) { executeSlashCommand(cmd, text); return; }
    }

    var images = [];
    var files = [];
    for (var i = 0; i < state.attachedFiles.length; i++) {
      var f = state.attachedFiles[i];
      if (f.isImage) { images.push({ name: f.name, data: f.data }); }
      else { files.push({ name: f.name, content: f.data }); }
    }
    if (!text && images.length === 0 && files.length === 0) return;

    state.lastUserMessage = text;
    appendUserMessage(text, images, files);

    // Feature #12: Prepend system prompt if set
    var sysPrompt = getSystemPrompt();
    var fullMessage = sysPrompt ? '[System: ' + sysPrompt + ']\n\n' + text : text;

    var modelSelect = document.getElementById('model-selector');
    var model = modelSelect ? modelSelect.value : 'sonnet';
    wsSend({
      type: 'chat', message: fullMessage, sessionId: state.currentSessionId || null,
      model: model,
      images: images.length > 0 ? images : undefined,
      files: files.length > 0 ? files : undefined
    });
    textarea.value = '';
    autoResizeTextarea();
    updateTokenCounter();
    clearFilePreview();
    state.attachedFiles = [];
    var sendBtnEl = document.getElementById('send-btn');
    if (sendBtnEl) sendBtnEl.disabled = true;
  }

  // ---------------------------------------------------------------------------
  // Cancel streaming (Bug #3)
  // ---------------------------------------------------------------------------
  function showCancelButton() {
    var btn = document.getElementById('cancel-btn');
    if (btn) { btn.style.display = 'inline-flex'; btn.classList.add('visible'); }
  }

  function hideCancelButton() {
    var btn = document.getElementById('cancel-btn');
    if (btn) { btn.style.display = 'none'; btn.classList.remove('visible'); }
  }

  function cancelStreaming() {
    wsSend({ type: 'cancel' });
    state.isStreaming = false;
    hideCancelButton();
    // The server still finalizes the turn after a cancel — processor.
    // finalizeIfUnsaved() (lib/stream-events.js) persists whatever text/
    // blocks exist so far and emits a stream_end, which this run's own
    // ingest() will pick up and render normally (partial answer, trail,
    // footer) — nothing to hand-build here. Just stop the ticker immediately
    // so the elapsed clock doesn't keep counting up while the process winds
    // down; ingesting the eventual stream_end into an unregistered view is
    // still safe (RunView.ingest has no "destroyed" guard).
    if (state.currentRunView) state.currentRunView.destroy();
  }

  // ---------------------------------------------------------------------------
  // Auto-resize textarea
  // ---------------------------------------------------------------------------
  function autoResizeTextarea() {
    var textarea = document.getElementById('message-input');
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  // ---------------------------------------------------------------------------
  // File upload
  // ---------------------------------------------------------------------------
  function openFilePicker() {
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = IMAGE_EXTENSIONS.map(function (e) { return '.' + e; }).join(',') + ',' +
      DOC_EXTENSIONS.map(function (e) { return '.' + e; }).join(',');
    input.onchange = function () { if (input.files) processFiles(input.files); };
    input.click();
  }

  function processFiles(fileList) {
    for (var i = 0; i < fileList.length; i++) processFile(fileList[i]);
  }

  function processFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var isImage = IMAGE_EXTENSIONS.indexOf(ext) !== -1;
    if (isImage && file.size > IMAGE_MAX_SIZE) { showNotification('Image "' + file.name + '" exceeds 10MB', 'error'); return; }
    if (!isImage && file.size > DOC_MAX_SIZE) { showNotification('File "' + file.name + '" exceeds 5MB', 'error'); return; }
    var reader = new FileReader();
    if (isImage) {
      reader.onload = function (e) {
        state.attachedFiles.push({ name: file.name, type: file.type, data: e.target.result.split(',')[1], isImage: true });
        renderFilePreview();
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = function (e) {
        state.attachedFiles.push({ name: file.name, type: file.type, data: e.target.result, isImage: false });
        renderFilePreview();
      };
      reader.readAsText(file);
    }
  }

  function renderFilePreview() {
    var container = document.getElementById('file-preview');
    if (!container) return;
    container.innerHTML = '';
    var sendBtnEl = document.getElementById('send-btn');
    if (state.attachedFiles.length === 0) {
      container.style.display = 'none';
      if (sendBtnEl) { var ta = document.getElementById('message-input'); sendBtnEl.disabled = !(ta && ta.value.trim()); }
      return;
    }
    container.style.display = 'flex';
    if (sendBtnEl) sendBtnEl.disabled = false;
    for (var i = 0; i < state.attachedFiles.length; i++) {
      var f = state.attachedFiles[i];
      var item = document.createElement('div');
      item.className = 'file-preview-item';
      if (f.isImage) {
        var img = document.createElement('img');
        img.src = 'data:image/png;base64,' + f.data;
        img.alt = f.name;
        item.appendChild(img);
      } else {
        var nameEl = document.createElement('span');
        nameEl.textContent = f.name;
        item.appendChild(nameEl);
      }
      var removeBtn = document.createElement('button');
      removeBtn.className = 'file-preview-remove';
      removeBtn.textContent = '\u00D7';
      removeBtn.addEventListener('click', (function (idx) {
        return function () { state.attachedFiles.splice(idx, 1); renderFilePreview(); };
      })(i));
      item.appendChild(removeBtn);
      container.appendChild(item);
    }
  }

  function clearFilePreview() {
    var c = document.getElementById('file-preview');
    if (c) { c.innerHTML = ''; c.style.display = 'none'; }
  }

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------
  function setupDragDrop() {
    var overlay = document.getElementById('drag-overlay');
    var counter = 0;
    document.addEventListener('dragenter', function (e) { e.preventDefault(); counter++; if (overlay) overlay.style.display = 'flex'; });
    document.addEventListener('dragleave', function (e) { e.preventDefault(); counter--; if (counter <= 0) { counter = 0; if (overlay) overlay.style.display = 'none'; } });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); counter = 0; if (overlay) overlay.style.display = 'none'; if (e.dataTransfer && e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files); });
  }

  // ---------------------------------------------------------------------------
  // Bug #2: Voice input with error handling
  // ---------------------------------------------------------------------------
  function initVoiceInput() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    var micBtn = document.getElementById('mic-btn');
    if (!SpeechRecognition) {
      if (micBtn) micBtn.addEventListener('click', function () {
        showNotification('Voice input not supported in this browser', 'error');
      });
      return;
    }
    var recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    state.recognition = recognition;
    recognition.onresult = function (e) {
      var transcript = '';
      for (var i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      var textarea = document.getElementById('message-input');
      if (textarea) { textarea.value = transcript; autoResizeTextarea(); var sb = document.getElementById('send-btn'); if (sb) sb.disabled = !transcript.trim(); }
    };
    recognition.onend = function () { setRecordingState(false); };
    recognition.onerror = function (e) {
      setRecordingState(false);
      if (e.error === 'not-allowed') showNotification('Microphone access denied', 'error');
      else if (e.error !== 'aborted') showNotification('Voice recognition error: ' + e.error, 'error');
    };
  }

  function toggleRecording() {
    if (!state.recognition) { showNotification('Voice input not supported in this browser', 'error'); return; }
    if (state.isRecording) { state.recognition.stop(); setRecordingState(false); }
    else {
      try { state.recognition.start(); setRecordingState(true); }
      catch (e) { showNotification('Could not start voice input', 'error'); }
    }
  }

  function setRecordingState(recording) {
    state.isRecording = recording;
    var micBtn = document.getElementById('mic-btn');
    if (micBtn) micBtn.classList.toggle('recording', recording);
  }

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------
  function showImageModal(src) {
    var modal = document.getElementById('image-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'image-modal';
      modal.className = 'image-modal';
      modal.innerHTML = '<div class="image-modal-backdrop"></div><img class="image-modal-img" />';
      document.body.appendChild(modal);
      modal.querySelector('.image-modal-backdrop').addEventListener('click', closeImageModal);
      modal.addEventListener('click', function (e) { if (e.target === modal) closeImageModal(); });
    }
    modal.querySelector('.image-modal-img').src = src;
    modal.style.display = 'flex';
  }

  function closeImageModal() {
    var modal = document.getElementById('image-modal');
    if (modal) modal.style.display = 'none';
  }

  function showConfirmModal(message, onConfirm) {
    var modal = document.getElementById('confirm-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'confirm-modal';
      modal.className = 'confirm-modal';
      modal.innerHTML = '<div class="confirm-modal-content"><p class="confirm-message"></p><div class="confirm-buttons"><button class="confirm-cancel-btn">Cancel</button><button class="confirm-ok-btn">Delete</button></div></div>';
      document.body.appendChild(modal);
    }
    modal.querySelector('.confirm-message').textContent = message;
    modal.style.display = 'flex';
    var okBtn = modal.querySelector('.confirm-ok-btn');
    var cancelBtn = modal.querySelector('.confirm-cancel-btn');
    var cleanup = function () { modal.style.display = 'none'; okBtn.replaceWith(okBtn.cloneNode(true)); cancelBtn.replaceWith(cancelBtn.cloneNode(true)); };
    okBtn.addEventListener('click', function () { cleanup(); if (onConfirm) onConfirm(); });
    cancelBtn.addEventListener('click', cleanup);
  }

  function showNotification(message, type) {
    var container = document.getElementById('notifications');
    if (!container) {
      container = document.createElement('div');
      container.id = 'notifications';
      container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(container);
    }
    var notif = document.createElement('div');
    notif.className = 'notification ' + (type || 'info');
    notif.textContent = message;
    container.appendChild(notif);
    setTimeout(function () { notif.classList.add('fade-out'); setTimeout(function () { notif.remove(); }, 300); }, 4000);
  }

  function showStatusPanel(data) {
    var lines = [];
    lines.push('=== Ruflow Chat Status ===');
    if (data.gateway) {
      lines.push('Uptime: ' + Math.floor(data.gateway.uptime / 60) + 'm ' + Math.floor(data.gateway.uptime % 60) + 's');
      lines.push('Memory: ' + Math.round(data.gateway.memory.rss / 1024 / 1024) + 'MB');
      lines.push('PID: ' + data.gateway.pid);
    }
    if (data.session) {
      lines.push('--- Session ---');
      lines.push('Model: ' + (data.session.model || 'sonnet'));
      lines.push('Messages: ' + data.session.messageCount);
      lines.push('CLI Session: ' + (data.session.cliSessionId ? 'Active' : 'None'));
      lines.push('Created: ' + new Date(data.session.createdAt).toLocaleString());
    }
    lines.push('Active sessions: ' + data.activeSessions);
    lines.push('Working dir: ' + data.workDir);

    var chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
      hideWelcomeScreen();
      var el = document.createElement('div');
      el.className = 'message assistant system-message';
      el.innerHTML = '<div class="message-content"><div class="message-text"><pre class="status-output">' + escapeHtml(lines.join('\n')) + '</pre></div></div>';
      appendToChat(chatMessages, el);
      autoScroll(true);
    }
  }

  function showSessionStatsPanel(stats) {
    var lines = [];
    lines.push('=== Session Usage ===');
    lines.push('Messages: ' + stats.messageCount + ' (' + stats.userMessages + ' user, ' + stats.assistantMessages + ' assistant)');
    lines.push('Tool calls: ' + stats.toolCalls);
    lines.push('Characters: ' + stats.totalCharacters.toLocaleString());
    lines.push('Est. tokens: ~' + stats.estimatedTokens.toLocaleString());
    lines.push('Model: ' + (stats.model || 'sonnet'));
    lines.push('Created: ' + new Date(stats.createdAt).toLocaleString());

    var chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
      hideWelcomeScreen();
      var el = document.createElement('div');
      el.className = 'message assistant system-message';
      el.innerHTML = '<div class="message-content"><div class="message-text"><pre class="status-output">' + escapeHtml(lines.join('\n')) + '</pre></div></div>';
      appendToChat(chatMessages, el);
      autoScroll(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Memory panel display
  // ---------------------------------------------------------------------------
  function showTrashPanel(items) {
    var chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;
    hideWelcomeScreen();
    var lines = ['=== Deleted Sessions (' + items.length + ') ==='];
    if (items.length === 0) {
      lines.push('Trash is empty. Deleted sessions appear here for 7 days.');
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      lines.push('');
      lines.push('[' + (item.name || 'Untitled') + ']');
      lines.push('  file: ' + item.file);
      lines.push('  deleted: ' + new Date(item.deletedAt).toLocaleString());
      lines.push('  restore: type /restore ' + item.file);
    }
    var el = document.createElement('div');
    el.className = 'message assistant system-message';
    el.innerHTML = '<div class="message-content"><div class="message-text"><pre class="status-output">' + escapeHtml(lines.join('\n')) + '</pre></div></div>';
    appendToChat(chatMessages, el);
    autoScroll(true);
  }

  function showMemoryPanel(title, entries) {
    var chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;
    hideWelcomeScreen();
    var lines = ['=== ' + title + ' (' + entries.length + ' entries) ==='];
    if (entries.length === 0) {
      lines.push('No memories found. Use /remember key = value to save.');
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      lines.push('');
      lines.push('[' + (e.key || 'untitled') + ']');
      lines.push(e.value || '');
      if (e.tags && e.tags.length > 0) lines.push('  tags: ' + e.tags.join(', '));
      lines.push('  updated: ' + (e.updatedAt ? new Date(e.updatedAt).toLocaleString() : 'unknown'));
    }
    var el = document.createElement('div');
    el.className = 'message assistant system-message';
    el.innerHTML = '<div class="message-content"><div class="message-text"><pre class="status-output">' + escapeHtml(lines.join('\n')) + '</pre></div></div>';
    appendToChat(chatMessages, el);
    autoScroll(true);
  }

  // ---------------------------------------------------------------------------
  // Sidebar toggle
  // ---------------------------------------------------------------------------
  function toggleSidebar() {
    var sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.toggle('open');
  }

  function closeSidebar() {
    var sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('open');
  }

  // ---------------------------------------------------------------------------
  // Feature #9: Keyboard shortcuts
  // ---------------------------------------------------------------------------
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function (e) {
      var isInput = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.isContentEditable;
      var mod = e.ctrlKey || e.metaKey;

      // Escape: close modals / cancel streaming / close search / close palette
      if (e.key === 'Escape') {
        if (state.commandPaletteOpen) { closeCommandPalette(); return; }
        if (state.searchOpen) { closeChatSearch(); return; }
        if (state.slashMenuOpen) { closeSlashMenu(); return; }
        closeImageModal();
        var cm = document.getElementById('confirm-modal');
        if (cm) cm.style.display = 'none';
        if (state.isStreaming) cancelStreaming();
        return;
      }

      // Ctrl+N: New chat
      if (mod && e.key === 'n') {
        e.preventDefault();
        state.currentSessionId = null;
        clearChatArea();
        showWelcomeScreen();
        updateSessionName('New Chat');
        updateContextIndicator(0);
        highlightActiveSession();
        document.getElementById('message-input')?.focus();
        return;
      }

      // Ctrl+L: Clear display
      if (mod && e.key === 'l' && !e.shiftKey) {
        e.preventDefault();
        clearChatArea();
        return;
      }

      // Ctrl+/: Toggle sidebar
      if (mod && e.key === '/') {
        e.preventDefault();
        var sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.toggle('collapsed');
        var stb = document.getElementById('sidebar-toggle-btn');
        if (stb) stb.classList.toggle('rotated');
        return;
      }

      // Feature #4: Ctrl+F: In-chat search
      if (mod && e.key === 'f') {
        e.preventDefault();
        openChatSearch();
        return;
      }

      // Feature #11: Ctrl+K: Command palette
      if (mod && e.key === 'k') {
        e.preventDefault();
        if (state.commandPaletteOpen) closeCommandPalette();
        else openCommandPalette();
        return;
      }

      // Feature #9: Ctrl+Shift+A: Multi-select toggle
      if (mod && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        toggleMultiSelectMode();
        return;
      }

      // Feature #16: F11: Fullscreen
      if (e.key === 'F11') {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      // Up arrow in empty input: edit last message
      if (e.key === 'ArrowUp' && isInput) {
        var ta = document.getElementById('message-input');
        if (ta && ta === e.target && !ta.value.trim() && state.lastUserMessage) {
          e.preventDefault();
          ta.value = state.lastUserMessage;
          autoResizeTextarea();
          var sb = document.getElementById('send-btn');
          if (sb) sb.disabled = false;
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------
  function setupEventListeners() {
    var sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.addEventListener('click', sendMessage);

    var textarea = document.getElementById('message-input');
    if (textarea) {
      textarea.addEventListener('keydown', function (e) {
        // Slash menu navigation
        if (state.slashMenuOpen) {
          if (e.key === 'ArrowDown') { e.preventDefault(); state.slashMenuIndex++; updateSlashMenu(textarea.value); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); state.slashMenuIndex = Math.max(0, state.slashMenuIndex - 1); updateSlashMenu(textarea.value); return; }
          if (e.key === 'Enter') {
            var activeItem = document.querySelector('.slash-menu-item.active');
            if (activeItem) {
              e.preventDefault();
              textarea.value = activeItem.getAttribute('data-cmd');
              closeSlashMenu();
              sendMessage();
              return;
            }
          }
          if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      });
      textarea.addEventListener('input', function () {
        autoResizeTextarea();
        updateTokenCounter();
        updateSlashMenu(textarea.value);
        var sb = document.getElementById('send-btn');
        if (sb) sb.disabled = !textarea.value.trim() && state.attachedFiles.length === 0;
      });
    }

    document.getElementById('cancel-btn')?.addEventListener('click', cancelStreaming);
    document.getElementById('attach-btn')?.addEventListener('click', openFilePicker);
    document.getElementById('mic-btn')?.addEventListener('click', toggleRecording);

    // Session search
    var searchInput = document.getElementById('session-search');
    if (searchInput) {
      var searchTimer = null;
      searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        var q = searchInput.value.trim();
        if (!q) { renderSessionList(); return; }
        searchTimer = setTimeout(function () { wsSend({ type: 'search_sessions', query: q }); }, 300);
      });
    }

    // Settings button — export current session
    var settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', function () {
      if (state.currentSessionId) {
        wsSend({ type: 'export_session', sessionId: state.currentSessionId });
      } else {
        showNotification('No active session to export', 'info');
      }
    });

    var newChatBtn = document.getElementById('new-chat-btn');
    if (newChatBtn) newChatBtn.addEventListener('click', function () {
      state.currentSessionId = null; clearChatArea(); showWelcomeScreen();
      updateSessionName('New Chat'); updateContextIndicator(0); highlightActiveSession();
      var msgInput = document.getElementById('message-input');
      if (msgInput) msgInput.focus();
    });

    var sidebarToggle = document.getElementById('sidebar-toggle-btn');
    if (sidebarToggle) sidebarToggle.addEventListener('click', function () {
      var sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.toggle('collapsed');
      sidebarToggle.classList.toggle('rotated');
    });

    document.getElementById('hamburger-btn')?.addEventListener('click', toggleSidebar);
    document.getElementById('collapse-btn')?.addEventListener('click', function () {
      var sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.add('collapsed');
      var stb = document.getElementById('sidebar-toggle-btn');
      if (stb) stb.classList.add('rotated');
    });

    // Session list (event delegation)
    var sessionList = document.getElementById('session-list');
    if (sessionList) sessionList.addEventListener('click', function (e) {
      // Restore button (archived sessions)
      var restoreBtn = e.target.closest('.session-restore-btn');
      if (restoreBtn) {
        e.stopPropagation();
        wsSend({ type: 'unarchive_session', sessionId: restoreBtn.getAttribute('data-session-id') });
        showNotification('Session restored', 'info');
        return;
      }
      // Delete button
      var deleteBtn = e.target.closest('.session-delete-btn');
      if (deleteBtn) {
        e.stopPropagation();
        var isArchived = deleteBtn.getAttribute('data-archived') === '1';
        if (isArchived) {
          // Already archived — permanent delete
          showConfirmModal('Permanently delete this archived session? This cannot be undone.', function () {
            wsSend({ type: 'permanent_delete_session', sessionId: deleteBtn.getAttribute('data-session-id') });
          });
        } else {
          // First delete — just archive it
          wsSend({ type: 'delete_session', sessionId: deleteBtn.getAttribute('data-session-id') });
          showNotification('Session archived. Click restore to bring it back.', 'info');
        }
        return;
      }
      var item = e.target.closest('.session-item');
      if (item) {
        var id = item.getAttribute('data-id');
        if (id && id !== state.currentSessionId) {
          showNotification('Loading session...', 'info');
          wsSend({ type: 'load_session', sessionId: id });
        }
        closeSidebar();
      }
    });

    // Session name editing
    var sessionNameEl = document.getElementById('session-name');
    if (sessionNameEl) {
      sessionNameEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sessionNameEl.blur(); } });
      sessionNameEl.addEventListener('blur', function () {
        var newName = sessionNameEl.textContent.trim();
        if (newName && state.currentSessionId) wsSend({ type: 'rename_session', sessionId: state.currentSessionId, name: newName });
      });
    }

    document.getElementById('chat-messages')?.addEventListener('scroll', checkScrollPosition, { passive: true });

    // run-render.js's "Load full output" button (past TOOL_OUTPUT_RENDER_CHARS)
    // dispatches this on the mount container instead of touching the socket
    // itself (it isn't run-render.js's to open) — see its header comment.
    document.getElementById('chat-messages')?.addEventListener('ruflow:fetch-tool-output', function (e) {
      var toolId = e.detail && e.detail.toolId;
      if (!toolId) return;
      wsSend({ type: 'fetch_tool_output', toolId: toolId, sessionId: state.currentSessionId });
    });

    // Welcome screen quick action buttons (event delegation)
    document.addEventListener('click', function (e) {
      if (e.target.classList.contains('message-image')) showImageModal(e.target.src);
      if (e.target.classList.contains('welcome-btn')) {
        var prompt = e.target.getAttribute('data-prompt');
        if (prompt) {
          var ta = document.getElementById('message-input');
          if (ta) { ta.value = prompt; ta.focus(); autoResizeTextarea(); var sb = document.getElementById('send-btn'); if (sb) sb.disabled = false; }
        }
      }
      // Feature #9: Multi-select message click
      if (state.multiSelectMode) {
        var msgEl = e.target.closest('.message');
        if (msgEl && document.getElementById('chat-messages').contains(msgEl)) {
          msgEl.classList.toggle('msg-selected');
          var idx = Array.prototype.indexOf.call(document.querySelectorAll('#chat-messages .message'), msgEl);
          if (msgEl.classList.contains('msg-selected')) state.selectedMessages.add(idx);
          else state.selectedMessages.delete(idx);
          var countEl = document.getElementById('select-count');
          if (countEl) countEl.textContent = state.selectedMessages.size + ' selected';
        }
      }
    });

    // Feature #10: Session sort dropdown
    var sessionSearch = document.getElementById('session-search');
    if (sessionSearch) {
      var sortSelect = document.createElement('select');
      sortSelect.className = 'session-sort-select';
      sortSelect.innerHTML = '<option value="recent">Recent</option><option value="name">Name A-Z</option><option value="messages">Most msgs</option><option value="oldest">Oldest</option>';
      sortSelect.value = state.sessionSortMode;
      sortSelect.addEventListener('change', function () {
        state.sessionSortMode = sortSelect.value;
        localStorage.setItem('ruflow-session-sort', sortSelect.value);
        renderSessionList();
      });
      sessionSearch.parentNode.insertBefore(sortSelect, sessionSearch.nextSibling);
    }

    window.addEventListener('beforeunload', function () { if (state.ws) { state.ws.close(); state.ws = null; } });
  }

  // ---------------------------------------------------------------------------
  // Feature #13: Dark/Light theme toggle
  // ---------------------------------------------------------------------------
  function initTheme() {
    var saved = localStorage.getItem('ruflow-theme') || 'dark';
    if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
    updateThemeIcon();
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    var next = current === 'light' ? 'dark' : 'light';
    if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('ruflow-theme', next);
    updateThemeIcon();
    // Swap hljs theme — vendored + pinned now (U7-MARKDOWN), not the CDN
    // paths this used to hardcode; see highlight-wire.js's header.
    var hljsLink = document.querySelector('link[href*="highlightjs"]');
    if (hljsLink) {
      hljsLink.href = next === 'light'
        ? 'vendor/highlightjs/styles/github.min.css'
        : 'vendor/highlightjs/styles/github-dark.min.css';
    }
  }

  function updateThemeIcon() {
    var icon = document.getElementById('theme-icon');
    if (!icon) return;
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    icon.innerHTML = isLight
      ? '<path d="M9 1a8 8 0 107.5 10.8A6 6 0 019 1z" stroke="currentColor" stroke-width="1.5" fill="none"/>'
      : '<circle cx="9" cy="9" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.05 3.05l1.41 1.41M13.54 13.54l1.41 1.41M3.05 14.95l1.41-1.41M13.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
  }

  // ---------------------------------------------------------------------------
  // Feature #14: Notification sound
  // ---------------------------------------------------------------------------
  var notifSoundEnabled = localStorage.getItem('ruflow-sound') !== 'off';

  // Flash browser tab title when task completes
  var originalTitle = document.title;
  var flashInterval = null;

  function flashTabTitle(message) {
    if (flashInterval) clearInterval(flashInterval);
    var isOriginal = true;
    flashInterval = setInterval(function () {
      document.title = isOriginal ? '✅ ' + message + ' — Ruflow' : originalTitle;
      isOriginal = !isOriginal;
    }, 1000);
    // Stop flashing when user focuses the tab
    var stopFlash = function () {
      if (flashInterval) { clearInterval(flashInterval); flashInterval = null; }
      document.title = originalTitle;
      window.removeEventListener('focus', stopFlash);
    };
    window.addEventListener('focus', stopFlash);
    // Auto-stop after 30 seconds
    setTimeout(stopFlash, 30000);
  }

  function playNotifSound() {
    if (!notifSoundEnabled) return;
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 660;
      gain.gain.value = 0.08;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.stop(ctx.currentTime + 0.3);
    } catch (_) {}
  }

  function speakText(text) {
    if (!state.ttsEnabled || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    var clean = text.replace(/```[\s\S]*?```/g, '').replace(/[#*_`~\[\]]/g, '').replace(/\n+/g, '. ').trim();
    if (!clean) return;
    // Split into chunks under 200 chars for better TTS
    var chunks = clean.match(/.{1,200}[.!?\s]|.{1,200}/g) || [clean];
    chunks.forEach(function(chunk) {
      var utt = new SpeechSynthesisUtterance(chunk.trim());
      utt.rate = 1.0;
      utt.pitch = 1.0;
      window.speechSynthesis.speak(utt);
    });
  }

  // ---------------------------------------------------------------------------
  // Feature #20: Inject CSS for all new features
  // ---------------------------------------------------------------------------
  // U4-RENDER (SPEC-v2.md): trimmed down, not deleted outright. Deleting this
  // wholesale would also delete '.command-palette-overlay.open' and
  // '.system-prompt-panel.open' — style.css only defines the '.visible'
  // variant of those two, but app.js actually toggles '.open'
  // (openCommandPalette/toggleSystemPromptPanel), so those two rules are the
  // ONLY thing making the command palette and system-prompt panel visible
  // today. What's removed below is exactly the set that duplicates a
  // selector style.css already defines (and app.js already triggers) —
  // .slash-menu, .scroll-bottom-btn, .multi-select-bar (container/visible/
  // button), .breadcrumb-step/.breadcrumb-arrow, .zoom-controls/.zoom-btn —
  // where this array's wrong var(--accent,#hex)/var(--bg-hover,#hex)
  // fallbacks were winning the cascade (this <style> tag is appended after
  // style.css's <link>) and silently forcing dark-mode-only hex colors, per
  // SPEC-v2.md's performance plan item 11. Also dropped: '.thinking-indicator
  // .thinking-text' and '.stream-timer', which targeted DOM nodes nothing
  // creates anymore now that the old streaming bubble path is gone.

  // ---------------------------------------------------------------------------
  // Feature #1: Slash commands
  // ---------------------------------------------------------------------------
  var SLASH_COMMANDS = [
    { cmd: '/clear', desc: 'Clear chat display' },
    { cmd: '/new', desc: 'Start a new session' },
    { cmd: '/export', desc: 'Export session as markdown' },
    { cmd: '/model', desc: 'Switch model: /model opus|sonnet|haiku|fable|opus[1m]' },
    { cmd: '/help', desc: 'Show keyboard shortcuts' },
    { cmd: '/system', desc: 'Set system prompt for this session' },
    { cmd: '/status', desc: 'Show session info, model, and usage' },
    { cmd: '/compact', desc: 'Compress context (keep last 10 messages)' },
    { cmd: '/think', desc: 'Set thinking depth: /think high|medium|low|off' },
    { cmd: '/verbose', desc: 'Toggle verbose tool output' },
    { cmd: '/usage', desc: 'Show token usage and cost for this session' },
    { cmd: '/duplicate', desc: 'Duplicate current session' },
    { cmd: '/doctor', desc: 'Run diagnostics check' },
    { cmd: '/tts', desc: 'Toggle text-to-speech on/off' },
    { cmd: '/cron', desc: 'Show scheduled tasks (pm2 and system cron)' },
    { cmd: '/memory', desc: 'Show session memory and context history' },
    { cmd: '/heartbeat', desc: 'Show server health and heartbeat info' },
    { cmd: '/trash', desc: 'Show deleted sessions (recoverable)' },
    { cmd: '/restore', desc: 'Restore a deleted session from trash' },
    { cmd: '/remember', desc: 'Save to memory: /remember key = value' },
    { cmd: '/recall', desc: 'Search memory: /recall search query' },
    { cmd: '/memories', desc: 'List all saved memories' },
    { cmd: '/forget', desc: 'Clear all memories' },
    { cmd: '/regenerate', desc: 'Regenerate the last response' },
    { cmd: '/edit', desc: 'Edit the last user message' }
  ];

  function createSlashMenu() {
    if (document.getElementById('slash-menu')) return;
    var inputArea = document.getElementById('input-area');
    if (!inputArea) return;
    inputArea.style.position = 'relative';
    var menu = document.createElement('div');
    menu.id = 'slash-menu';
    menu.className = 'slash-menu';
    inputArea.appendChild(menu);
  }

  function updateSlashMenu(text) {
    var menu = document.getElementById('slash-menu');
    if (!menu) return;
    if (!text.startsWith('/')) { closeSlashMenu(); return; }
    var query = text.split(' ')[0].toLowerCase();
    var filtered = SLASH_COMMANDS.filter(function (c) { return c.cmd.indexOf(query) === 0; });
    if (filtered.length === 0) { closeSlashMenu(); return; }
    state.slashMenuOpen = true;
    state.slashMenuIndex = Math.min(state.slashMenuIndex, filtered.length - 1);
    menu.innerHTML = '';
    for (var i = 0; i < filtered.length; i++) {
      var item = document.createElement('div');
      item.className = 'slash-menu-item' + (i === state.slashMenuIndex ? ' active' : '');
      item.innerHTML = '<span class="slash-cmd">' + escapeHtml(filtered[i].cmd) + '</span><span class="slash-desc">' + escapeHtml(filtered[i].desc) + '</span>';
      item.setAttribute('data-cmd', filtered[i].cmd);
      item.addEventListener('mousedown', (function(cmd) {
        return function (e) {
          e.preventDefault();
          var ta = document.getElementById('message-input');
          if (ta) ta.value = cmd;
          closeSlashMenu();
          sendMessage();
        };
      })(filtered[i].cmd));
      menu.appendChild(item);
    }
    menu.classList.add('visible');
    menu.style.display = 'block';
  }

  function closeSlashMenu() {
    var menu = document.getElementById('slash-menu');
    if (menu) { menu.classList.remove('visible'); menu.style.display = 'none'; }
    state.slashMenuOpen = false;
    state.slashMenuIndex = 0;
  }

  function executeSlashCommand(cmd, fullText) {
    closeSlashMenu();
    var textarea = document.getElementById('message-input');
    if (textarea) { textarea.value = ''; autoResizeTextarea(); }
    var args = fullText ? fullText.substring(cmd.length).trim() : '';
    switch (cmd) {
      case '/clear':
        clearChatArea(); showWelcomeScreen();
        showNotification('Chat cleared', 'info');
        break;
      case '/new':
        state.currentSessionId = null; clearChatArea(); showWelcomeScreen();
        updateSessionName('New Chat'); updateContextIndicator(0); highlightActiveSession();
        showNotification('New session', 'info');
        break;
      case '/export':
        if (state.currentSessionId) wsSend({ type: 'export_session', sessionId: state.currentSessionId });
        else showNotification('No active session', 'error');
        break;
      case '/model':
        var validModels = ['opus', 'sonnet', 'haiku'];
        var model = (args || '').toLowerCase();
        if (validModels.indexOf(model) !== -1) {
          var sel = document.getElementById('model-selector');
          if (sel) { sel.value = model; showNotification('Model set to ' + model, 'info'); }
        } else { showNotification('Usage: /model opus|sonnet|haiku', 'info'); }
        break;
      case '/help':
        showNotification('Ctrl+N: New chat | Ctrl+L: Clear | Ctrl+/: Sidebar | Ctrl+K: Command palette | Ctrl+F: Search | F11: Fullscreen', 'info');
        break;
      case '/system':
        if (args) {
          state.systemPrompts[state.currentSessionId || '_default'] = args;
          localStorage.setItem('ruflow-system-prompts', JSON.stringify(state.systemPrompts));
          showNotification('System prompt set', 'info');
        } else { toggleSystemPromptPanel(); }
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Feature #2: Message timestamps
  // ---------------------------------------------------------------------------
  function addTimestamp(el) {
    var now = new Date();
    var ts = document.createElement('div');
    ts.className = 'msg-timestamp';
    ts.setAttribute('data-iso', now.toISOString());
    ts.textContent = 'just now';
    ts.title = now.toLocaleString();
    el.appendChild(ts);
  }

  function updateTimestamps() {
    var stamps = document.querySelectorAll('.msg-timestamp');
    for (var i = 0; i < stamps.length; i++) {
      var iso = stamps[i].getAttribute('data-iso');
      if (iso) stamps[i].textContent = relativeTime(iso);
    }
  }

  // ---------------------------------------------------------------------------
  // Feature #3: Scroll to bottom button
  // ---------------------------------------------------------------------------
  function createScrollToBottomBtn() {
    if (document.getElementById('scroll-bottom-btn')) return;
    var chatArea = document.getElementById('chat-messages');
    if (!chatArea) return;
    var parent = chatArea;
    parent.style.position = 'relative';
    var btn = document.createElement('button');
    btn.id = 'scroll-bottom-btn';
    btn.className = 'scroll-bottom-btn';
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';
    btn.addEventListener('click', function () { autoScroll(true); });
    parent.appendChild(btn);
  }

  function updateScrollToBottomBtn() {
    var btn = document.getElementById('scroll-bottom-btn');
    if (btn) btn.classList.toggle('visible', state.userHasScrolledUp);
  }

  // ---------------------------------------------------------------------------
  // Feature #4: In-chat search (Ctrl+F)
  // ---------------------------------------------------------------------------
  function createChatSearchBar() {
    if (document.getElementById('chat-search-bar')) return;
    var chatArea = document.getElementById('chat-messages');
    if (!chatArea) return;
    var parent = chatArea.parentElement || chatArea;
    parent.style.position = 'relative';
    var bar = document.createElement('div');
    bar.id = 'chat-search-bar';
    bar.className = 'chat-search-bar';
    bar.innerHTML = '<input type="text" placeholder="Search in chat..." id="chat-search-input" />' +
      '<span class="search-count" id="chat-search-count"></span>' +
      '<button id="chat-search-prev" title="Previous">&uarr;</button>' +
      '<button id="chat-search-next" title="Next">&darr;</button>' +
      '<button id="chat-search-close" title="Close">&times;</button>';
    parent.insertBefore(bar, parent.firstChild);

    document.getElementById('chat-search-input').addEventListener('input', function () { performChatSearch(this.value); });
    document.getElementById('search-prev-btn').addEventListener('click', function () { navigateSearchMatch(-1); });
    document.getElementById('search-next-btn').addEventListener('click', function () { navigateSearchMatch(1); });
    document.getElementById('search-close-btn').addEventListener('click', closeChatSearch);
  }

  function openChatSearch() {
    var bar = document.getElementById('chat-search-bar');
    if (bar) { bar.classList.add('open'); state.searchOpen = true; document.getElementById('chat-search-input').focus(); }
  }

  function closeChatSearch() {
    var bar = document.getElementById('chat-search-bar');
    if (bar) { bar.classList.remove('open'); state.searchOpen = false; }
    clearSearchHighlights();
    var input = document.getElementById('chat-search-input');
    if (input) input.value = '';
    var count = document.getElementById('search-count');
    if (count) count.textContent = '';
    state.searchMatches = [];
    state.searchMatchIndex = -1;
  }

  function clearSearchHighlights() {
    var marks = document.querySelectorAll('mark.search-highlight');
    for (var i = 0; i < marks.length; i++) {
      var parent = marks[i].parentNode;
      parent.replaceChild(document.createTextNode(marks[i].textContent), marks[i]);
      parent.normalize();
    }
  }

  function performChatSearch(query) {
    clearSearchHighlights();
    state.searchMatches = [];
    state.searchMatchIndex = -1;
    if (!query || query.length < 2) {
      var ct = document.getElementById('search-count');
      if (ct) ct.textContent = '';
      return;
    }
    // Widened from '.message .message-text' — a run's say/verdict/prompt
    // text also carries the .message-text class (run-render.js), just under
    // a `.run` ancestor instead of `.message` (SPEC-v2.md U2-PERSIST: "so
    // existing copy/search/word-count/collapse code keeps working").
    var messages = document.querySelectorAll('#chat-messages .message-text');
    var regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    messages.forEach(function (msgEl) {
      var walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT, null, false);
      var textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach(function (node) {
        if (regex.test(node.textContent)) {
          var span = document.createElement('span');
          span.innerHTML = node.textContent.replace(regex, '<mark class="search-highlight">$1</mark>');
          node.parentNode.replaceChild(span, node);
        }
      });
    });
    state.searchMatches = Array.from(document.querySelectorAll('mark.search-highlight'));
    var countEl = document.getElementById('search-count');
    if (countEl) countEl.textContent = state.searchMatches.length > 0 ? '0/' + state.searchMatches.length : 'No results';
    if (state.searchMatches.length > 0) navigateSearchMatch(1);
  }

  function navigateSearchMatch(dir) {
    if (state.searchMatches.length === 0) return;
    if (state.searchMatchIndex >= 0 && state.searchMatches[state.searchMatchIndex]) {
      state.searchMatches[state.searchMatchIndex].classList.remove('current');
    }
    state.searchMatchIndex += dir;
    if (state.searchMatchIndex >= state.searchMatches.length) state.searchMatchIndex = 0;
    if (state.searchMatchIndex < 0) state.searchMatchIndex = state.searchMatches.length - 1;
    var match = state.searchMatches[state.searchMatchIndex];
    if (match) {
      match.classList.add('current');
      match.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    var countEl = document.getElementById('search-count');
    if (countEl) countEl.textContent = (state.searchMatchIndex + 1) + '/' + state.searchMatches.length;
  }

  // ---------------------------------------------------------------------------
  // Feature #5: Session folders / Pinned sessions
  // ---------------------------------------------------------------------------
  function togglePinSession(sessionId) {
    var idx = state.pinnedSessions.indexOf(sessionId);
    if (idx === -1) { state.pinnedSessions.push(sessionId); showNotification('Session pinned', 'info'); }
    else { state.pinnedSessions.splice(idx, 1); showNotification('Session unpinned', 'info'); }
    localStorage.setItem('ruflow-pinned-sessions', JSON.stringify(state.pinnedSessions));
    renderSessionList();
  }

  function showSessionContextMenu(e, sessionId) {
    e.preventDefault();
    var existing = document.getElementById('session-ctx-menu');
    if (existing) existing.remove();
    var menu = document.createElement('div');
    menu.id = 'session-ctx-menu';
    menu.className = 'session-ctx-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    var isPinned = state.pinnedSessions.indexOf(sessionId) !== -1;
    var pinItem = document.createElement('div');
    pinItem.className = 'session-ctx-menu-item';
    pinItem.textContent = isPinned ? 'Unpin session' : 'Pin session';
    pinItem.addEventListener('click', function () { togglePinSession(sessionId); menu.remove(); });
    menu.appendChild(pinItem);
    var deleteItem = document.createElement('div');
    deleteItem.className = 'session-ctx-menu-item';
    deleteItem.textContent = 'Delete session';
    deleteItem.addEventListener('click', function () {
      menu.remove();
      showConfirmModal('Delete this chat session?', function () {
        wsSend({ type: 'delete_session', sessionId: sessionId });
      });
    });
    menu.appendChild(deleteItem);
    document.body.appendChild(menu);
    var closeMenu = function () { menu.remove(); document.removeEventListener('click', closeMenu); };
    setTimeout(function () { document.addEventListener('click', closeMenu); }, 0);
  }

  // Feature #7 (typing indicator text) and Feature #8 (response time counter)
  // are gone: both were driven off state.currentAssistantEl/currentAssistantText,
  // which no longer exist, and both purposes — "something is happening", "how
  // long has it been running" — are now served by the run header's own live
  // elapsed clock (run-render.js's shared 1s ticker), which is exactly what
  // SPEC-v2.md's performance plan asks liveness to come from instead.

  // ---------------------------------------------------------------------------
  // Feature #9: Multi-select messages
  // ---------------------------------------------------------------------------
  function toggleMultiSelectMode() {
    state.multiSelectMode = !state.multiSelectMode;
    state.selectedMessages.clear();
    var chatMessages = document.getElementById('chat-messages');
    if (chatMessages) chatMessages.classList.toggle('multi-select-active', state.multiSelectMode);
    var bar = document.getElementById('multi-select-bar');
    if (bar) bar.classList.toggle('visible', state.multiSelectMode);
    if (!state.multiSelectMode) {
      document.querySelectorAll('.message.msg-selected').forEach(function (m) { m.classList.remove('msg-selected'); });
    }
    showNotification(state.multiSelectMode ? 'Multi-select ON (click messages)' : 'Multi-select OFF', 'info');
  }

  function createMultiSelectBar() {
    if (document.getElementById('multi-select-bar')) return;
    var chatArea = document.getElementById('chat-messages');
    if (!chatArea) return;
    var parent = chatArea.parentElement || chatArea;
    parent.style.position = 'relative';
    var bar = document.createElement('div');
    bar.id = 'multi-select-bar';
    bar.className = 'multi-select-bar';
    bar.innerHTML = '<span id="multi-select-count">0 selected</span>' +
      '<button id="ms-copy-btn">Copy</button>' +
      '<button id="ms-export-btn">Export</button>' +
      '<button id="ms-cancel-btn">Cancel</button>';
    parent.appendChild(bar);
    document.getElementById('select-copy-btn').addEventListener('click', function () {
      var texts = [];
      document.querySelectorAll('.message.msg-selected').forEach(function (m) {
        var role = m.classList.contains('user') ? 'User' : 'Assistant';
        var t = m.querySelector('.message-text');
        if (t) texts.push(role + ': ' + t.textContent);
      });
      navigator.clipboard.writeText(texts.join('\n\n')).then(function () { showNotification('Copied ' + texts.length + ' messages', 'info'); });
    });
    document.getElementById('select-delete-btn').addEventListener('click', function () {
      var texts = [];
      document.querySelectorAll('.message.msg-selected').forEach(function (m) {
        var role = m.classList.contains('user') ? '**User**' : '**Assistant**';
        var t = m.querySelector('.message-text');
        if (t) texts.push(role + '\n\n' + t.textContent);
      });
      downloadAsFile(texts.join('\n\n---\n\n'), 'selection.md', 'text/markdown');
    });
    document.getElementById('select-cancel-btn').addEventListener('click', toggleMultiSelectMode);
  }

  // ---------------------------------------------------------------------------
  // Feature #10: Session sort options
  // ---------------------------------------------------------------------------
  function getSessionSortFn() {
    switch (state.sessionSortMode) {
      case 'name': return function (a, b) { return (a.name || '').localeCompare(b.name || ''); };
      case 'messages': return function (a, b) { return (b.messageCount || 0) - (a.messageCount || 0); };
      case 'oldest': return function (a, b) { return new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime(); };
      default: return function (a, b) { return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(); };
    }
  }

  // ---------------------------------------------------------------------------
  // Feature #11: Command palette (Ctrl+K)
  // ---------------------------------------------------------------------------
  var PALETTE_COMMANDS = [
    { name: 'New chat', key: 'Ctrl+N', action: function () { state.currentSessionId = null; clearChatArea(); showWelcomeScreen(); updateSessionName('New Chat'); updateContextIndicator(0); } },
    { name: 'Clear chat', key: 'Ctrl+L', action: function () { clearChatArea(); showWelcomeScreen(); } },
    { name: 'Toggle sidebar', key: 'Ctrl+/', action: function () { var sb = document.getElementById('sidebar'); if (sb) sb.classList.toggle('collapsed'); } },
    { name: 'Export session', key: '', action: function () { if (state.currentSessionId) wsSend({ type: 'export_session', sessionId: state.currentSessionId }); } },
    { name: 'Toggle theme', key: '', action: toggleTheme },
    { name: 'Toggle fullscreen', key: 'F11', action: toggleFullscreen },
    { name: 'Switch to Opus', key: '', action: function () { var s = document.getElementById('model-selector'); if (s) { s.value = 'opus'; showNotification('Model: Opus', 'info'); } } },
    { name: 'Switch to Sonnet', key: '', action: function () { var s = document.getElementById('model-selector'); if (s) { s.value = 'sonnet'; showNotification('Model: Sonnet', 'info'); } } },
    { name: 'Switch to Haiku', key: '', action: function () { var s = document.getElementById('model-selector'); if (s) { s.value = 'haiku'; showNotification('Model: Haiku', 'info'); } } },
    { name: 'Search in chat', key: 'Ctrl+F', action: openChatSearch },
    { name: 'Multi-select messages', key: 'Ctrl+Shift+A', action: toggleMultiSelectMode },
    { name: 'System prompt', key: '', action: toggleSystemPromptPanel },
    { name: 'Zoom in', key: '', action: function () { adjustZoom(10); } },
    { name: 'Zoom out', key: '', action: function () { adjustZoom(-10); } },
    { name: 'Reset zoom', key: '', action: function () { state.chatZoom = 100; applyZoom(); } },
    { name: 'Share conversation', key: '', action: shareConversation }
  ];

  function createCommandPalette() {
    if (document.getElementById('command-palette-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'command-palette-overlay';
    overlay.className = 'command-palette-overlay';
    overlay.innerHTML = '<div class="command-palette">' +
      '<input type="text" id="cp-input" placeholder="Type a command..." />' +
      '<div class="command-palette-list" id="cp-list"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeCommandPalette(); });
    document.getElementById('command-palette-input').addEventListener('input', function () { renderPaletteItems(this.value); });
    document.getElementById('command-palette-input').addEventListener('keydown', function (e) {
      var items = document.querySelectorAll('#cp-list .command-palette-item');
      var active = document.querySelector('#cp-list .command-palette-item.active');
      var idx = Array.prototype.indexOf.call(items, active);
      if (e.key === 'ArrowDown') { e.preventDefault(); if (idx < items.length - 1) { if (active) active.classList.remove('active'); items[idx + 1].classList.add('active'); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (idx > 0) { if (active) active.classList.remove('active'); items[idx - 1].classList.add('active'); } }
      else if (e.key === 'Enter') { e.preventDefault(); var a = document.querySelector('#cp-list .command-palette-item.active'); if (a) a.click(); }
      else if (e.key === 'Escape') { closeCommandPalette(); }
    });
  }

  function openCommandPalette() {
    var overlay = document.getElementById('command-palette-overlay');
    if (overlay) { overlay.classList.add('open'); state.commandPaletteOpen = true; var input = document.getElementById('command-palette-input'); if (input) { input.value = ''; input.focus(); } renderPaletteItems(''); }
  }

  function closeCommandPalette() {
    var overlay = document.getElementById('command-palette-overlay');
    if (overlay) overlay.classList.remove('open');
    state.commandPaletteOpen = false;
  }

  function renderPaletteItems(query) {
    var list = document.getElementById('command-list');
    if (!list) return;
    var q = (query || '').toLowerCase();
    var filtered = PALETTE_COMMANDS.filter(function (c) { return c.name.toLowerCase().indexOf(q) !== -1; });
    list.innerHTML = '';
    for (var i = 0; i < filtered.length; i++) {
      var item = document.createElement('div');
      item.className = 'command-palette-item' + (i === 0 ? ' active' : '');
      item.innerHTML = '<span>' + escapeHtml(filtered[i].name) + '</span>' + (filtered[i].key ? '<span class="cp-key">' + escapeHtml(filtered[i].key) + '</span>' : '');
      item.addEventListener('click', (function (cmd) { return function () { closeCommandPalette(); cmd.action(); }; })(filtered[i]));
      list.appendChild(item);
    }
  }

  // ---------------------------------------------------------------------------
  // Feature #12: Persistent system prompt
  // ---------------------------------------------------------------------------
  function createSystemPromptPanel() {
    if (document.getElementById('system-prompt-panel')) return;
    var topBar = document.getElementById('top-bar');
    if (!topBar) return;
    topBar.style.position = 'relative';
    var panel = document.createElement('div');
    panel.id = 'system-prompt-panel';
    panel.className = 'system-prompt-panel';
    panel.innerHTML = '<label>System prompt (prepended to every message in this session)</label>' +
      '<textarea id="system-prompt-textarea" placeholder="e.g. You are a helpful coding assistant..."></textarea>';
    topBar.appendChild(panel);
    var ta = document.getElementById('system-prompt-input');
    if (ta) {
      ta.addEventListener('input', function () {
        var key = state.currentSessionId || '_default';
        state.systemPrompts[key] = ta.value;
        localStorage.setItem('ruflow-system-prompts', JSON.stringify(state.systemPrompts));
      });
    }
    // Add brain icon button
    var brainBtn = document.createElement('button');
    brainBtn.className = 'fullscreen-btn';
    brainBtn.title = 'System prompt';
    brainBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 2.5-1.3 4.8-3.5 6v2.5a1.5 1.5 0 01-1.5 1.5h-4a1.5 1.5 0 01-1.5-1.5V15C6.3 13.8 5 11.5 5 9a7 7 0 017-7z"/><line x1="10" y1="21" x2="14" y2="21"/></svg>';
    brainBtn.addEventListener('click', toggleSystemPromptPanel);
    var actions = topBar.querySelector('.top-bar-actions') || topBar;
    actions.insertBefore(brainBtn, actions.firstChild);
  }

  function toggleSystemPromptPanel() {
    var panel = document.getElementById('system-prompt-panel');
    if (panel) {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) loadSystemPromptForSession();
    }
  }

  function loadSystemPromptForSession() {
    var ta = document.getElementById('system-prompt-input');
    if (ta) ta.value = state.systemPrompts[state.currentSessionId || '_default'] || '';
  }

  function getSystemPrompt() {
    return state.systemPrompts[state.currentSessionId || '_default'] || '';
  }

  // ---------------------------------------------------------------------------
  // Feature #13: Token counter in input
  // ---------------------------------------------------------------------------
  function createTokenCounter() {
    if (document.getElementById('input-counter')) return;
    var inputArea = document.getElementById('input-area');
    if (!inputArea) return;
    var counter = document.createElement('div');
    counter.id = 'token-counter';
    counter.className = 'token-counter';
    counter.textContent = '0 chars \u00B7 0 words';
    inputArea.appendChild(counter);
  }

  function updateTokenCounter() {
    var textarea = document.getElementById('message-input');
    var counter = document.getElementById('input-counter');
    if (!textarea || !counter) return;
    var text = textarea.value;
    var chars = text.length;
    var words = text.trim() ? text.trim().split(/\s+/).length : 0;
    counter.textContent = chars + ' chars \u00B7 ' + words + ' words';
  }

  // Feature #14 (breadcrumb tool progress bar) is gone \u2014 it tracked the same
  // "what's happening right now" signal the run header's tool rows now show
  // directly, in place, as they happen. #tool-breadcrumb stays in index.html
  // (unused, harmless) since removing markup wasn't part of this task.

  // ---------------------------------------------------------------------------
  // Feature #16: Fullscreen mode
  // ---------------------------------------------------------------------------
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    } else {
      document.exitFullscreen().catch(function () {});
    }
  }

  // ---------------------------------------------------------------------------
  // Feature #17: Message word count tooltip
  // ---------------------------------------------------------------------------
  function addWordCountTooltip(el) {
    var textEl = el.querySelector('.message-text');
    if (!textEl) return;
    el.style.position = 'relative';
    var tooltip = document.createElement('div');
    tooltip.className = 'msg-word-tooltip';
    var text = textEl.textContent || '';
    var words = text.trim() ? text.trim().split(/\s+/).length : 0;
    var codeBlocks = el.querySelectorAll('pre code').length;
    var toolBlocks = el.querySelectorAll('.tool-block').length;
    var parts = [words + ' words'];
    if (codeBlocks > 0) parts.push(codeBlocks + ' code block' + (codeBlocks > 1 ? 's' : ''));
    if (toolBlocks > 0) parts.push(toolBlocks + ' tool call' + (toolBlocks > 1 ? 's' : ''));
    tooltip.textContent = parts.join(' \u00B7 ');
    el.appendChild(tooltip);
  }

  // ---------------------------------------------------------------------------
  // Feature #18: Auto-title from AI
  // ---------------------------------------------------------------------------
  function maybeAutoTitle() {
    if (!state.currentSessionId) return;
    var session = state.sessions.find(function (s) { return s.id === state.currentSessionId; });
    if (!session) return;
    var msgCount = countTurnEls();
    // Only after first exchange (2 messages = 1 user + 1 assistant)
    if (msgCount < 2 || msgCount > 4) return;
    var name = (session.name || '').trim();
    var firstUserMsg = state.lastUserMessage || '';
    // If name looks like a truncated first message
    if (name && firstUserMsg && (firstUserMsg.indexOf(name) === 0 || name.length <= 30)) {
      // Send a title generation request
      wsSend({
        type: 'chat',
        message: 'Generate a concise 3-5 word title for this conversation. Reply with ONLY the title, nothing else.',
        sessionId: state.currentSessionId,
        model: 'haiku',
        isSystemRequest: true
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Feature #19: Zoom control
  // ---------------------------------------------------------------------------
  function createZoomControls() {
    if (document.getElementById('zoom-in-btn')) return;
    var topBar = document.getElementById('top-bar');
    if (!topBar) return;
    var container = document.createElement('div');
    container.className = 'zoom-controls';
    container.innerHTML = '<button class="zoom-btn" id="zoom-out-btn" title="Zoom out">A-</button>' +
      '<span class="zoom-level" id="zoom-level">' + state.chatZoom + '%</span>' +
      '<button class="zoom-btn" id="zoom-in-btn" title="Zoom in">A+</button>';
    topBar.insertBefore(container, topBar.firstChild);
    document.getElementById('zoom-in-btn').addEventListener('click', function () { adjustZoom(10); });
    document.getElementById('zoom-out-btn').addEventListener('click', function () { adjustZoom(-10); });
    applyZoom();
  }

  function adjustZoom(delta) {
    state.chatZoom = Math.max(60, Math.min(150, state.chatZoom + delta));
    localStorage.setItem('ruflow-chat-zoom', String(state.chatZoom));
    applyZoom();
  }

  function applyZoom() {
    var chatMessages = document.getElementById('chat-messages');
    if (chatMessages) chatMessages.style.fontSize = state.chatZoom + '%';
    var levelEl = document.getElementById('zoom-level');
    if (levelEl) levelEl.textContent = state.chatZoom + '%';
  }

  // ---------------------------------------------------------------------------
  // Feature #20: Smooth message entrance animation
  // ---------------------------------------------------------------------------
  function animateMessageEntrance(el) {
    el.classList.add('msg-enter');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add('msg-enter-active'); });
    });
    setTimeout(function () { el.classList.remove('msg-enter', 'msg-enter-active'); }, 300);
  }

  // ---------------------------------------------------------------------------
  // Feature #21: Share/Copy conversation
  // ---------------------------------------------------------------------------
  function shareConversation() {
    // Widened from '.message' to also pick up '.run' turns, and from a
    // single querySelector to querySelectorAll — a run can hold several
    // .message-text nodes (one per say block plus the verdict), where a
    // bubble only ever had one.
    var turns = document.querySelectorAll('#chat-messages > .message, #chat-messages > .run');
    if (turns.length === 0) { showNotification('No messages to share', 'info'); return; }
    var text = '';
    turns.forEach(function (m) {
      var role = m.classList.contains('user') ? 'User' : 'Assistant';
      var parts = [];
      m.querySelectorAll('.message-text').forEach(function (t) { parts.push(t.textContent); });
      if (parts.length) text += '## ' + role + '\n\n' + parts.join('\n\n') + '\n\n---\n\n';
    });
    navigator.clipboard.writeText(text.trim()).then(function () {
      showNotification('Conversation copied to clipboard', 'info');
    }).catch(function () { showNotification('Failed to copy', 'error'); });
  }

  // ---------------------------------------------------------------------------
  // Feature #22: Inline image preview
  // ---------------------------------------------------------------------------
  function enhanceInlineImages(el) {
    if (!el) return;
    var textEl = el.querySelector('.message-text');
    if (!textEl) return;
    var html = textEl.innerHTML;
    // Match URLs ending with image extensions
    var imgRegex = /(https?:\/\/[^\s<>"]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s<>"]*)?)/gi;
    if (imgRegex.test(html)) {
      textEl.innerHTML = html.replace(imgRegex, function (url) {
        return '<a href="' + url + '" target="_blank"><img src="' + url + '" alt="inline image" style="max-width:100%;max-height:300px;border-radius:6px;margin:4px 0;cursor:pointer;" onerror="this.style.display=\'none\'" /></a>';
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Feature #15: Double-click to edit session name in sidebar
  // ---------------------------------------------------------------------------
  function setupSidebarDblClickRename() {
    var sessionList = document.getElementById('session-list');
    if (!sessionList) return;
    sessionList.addEventListener('dblclick', function (e) {
      var nameEl = e.target.closest('.session-name');
      if (!nameEl) return;
      var item = nameEl.closest('.session-item');
      if (!item) return;
      var sessionId = item.getAttribute('data-id');
      e.stopPropagation();
      var original = nameEl.textContent;
      var input = document.createElement('input');
      input.type = 'text';
      input.value = original;
      input.style.cssText = 'width:100%;background:var(--bg-input,#181825);border:1px solid var(--accent,#f5a623);border-radius:4px;padding:2px 6px;color:var(--text-primary,#cdd6f4);font-size:13px;outline:none;';
      nameEl.innerHTML = '';
      nameEl.appendChild(input);
      input.focus();
      input.select();
      var save = function () {
        var newName = input.value.trim() || original;
        nameEl.textContent = newName;
        if (newName !== original && sessionId) {
          wsSend({ type: 'rename_session', sessionId: sessionId, name: newName });
        }
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = original; input.blur(); }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Double-click on code blocks to copy
  // ---------------------------------------------------------------------------
  document.addEventListener('dblclick', function (e) {
    if (e.target.tagName === 'CODE' || e.target.closest('pre code')) {
      var codeEl = e.target.tagName === 'CODE' ? e.target : e.target.closest('code');
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent).then(function () {
          showNotification('Code copied to clipboard', 'info');
        });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    connectWebSocket();
    initVoiceInput();
    setupEventListeners();
    setupKeyboardShortcuts();
    setupDragDrop();
    showWelcomeScreen();
    updateContextIndicator(0);

    // Theme toggle button
    var themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    // New feature inits
    createSlashMenu();
    createScrollToBottomBtn();
    createChatSearchBar();
    createMultiSelectBar();
    createCommandPalette();
    createSystemPromptPanel();
    createTokenCounter();
    createZoomControls();
    setupSidebarDblClickRename();
    applyZoom();

    // Periodically update relative timestamps
    setInterval(updateTimestamps, 30000);
  });

})();

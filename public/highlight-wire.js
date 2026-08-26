/**
 * highlight-wire.js — sealed-block markdown renderer (SPEC-v2.md, U7-MARKDOWN)
 *
 * WHY THIS FILE EXISTS
 * Syntax highlighting was DEAD, not missing. app.js set marked's `highlight`
 * option (marked.setOptions({ highlight: fn })) — that option was removed in
 * marked v5. index.html pulled `marked/marked.min.js` unpinned from a CDN, so
 * it silently resolved to whatever "latest" marked build was current at the
 * time (well past v5), the option was ignored, hljs never ran, and the
 * loaded github-dark stylesheet had no `.hljs-*` spans to paint. This file
 * fixes it by overriding `marked.Renderer#code` — the v5+ replacement API —
 * against pinned, vendored copies instead of a moving CDN target, because an
 * unpinned CDN load is exactly how this broke the first time.
 *
 * VENDORED, PINNED VERSIONS (public/vendor/ — no CDN reference anywhere)
 *   marked        12.0.2   public/vendor/marked/marked.min.js
 *                          upstream npm dist file, unmodified.
 *                          sha256 15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894
 *   highlight.js  11.9.0   public/vendor/highlightjs/highlight.min.js
 *                          NOT the upstream all-languages build (~200 langs,
 *                          multiple MB). Built locally from the official
 *                          11.9.0 npm package's lib/core.js + a curated set
 *                          of lib/languages/*.js (esbuild --bundle --minify
 *                          --format=iife --global-name=hljs), so it is the
 *                          real, unmodified highlight.js source for those
 *                          languages, just not the full language set.
 *                          Registered languages, see LANGUAGES below.
 *                          sha256 1801f1be02ca63428dbb160fcfefc99f6e779a6c5abd2d1409272ac3ca9644f0
 *                          Also vendored: styles/github.min.css,
 *                          styles/github-dark.min.css (upstream, unmodified).
 *   DOMPurify     3.0.6    public/vendor/dompurify/purify.min.js
 *                          upstream npm dist file, unmodified.
 *                          sha256 ea4b09082ca4ba0ae71be6431a097678751d0453b9c52a4d2c7c39a2166ed9fc
 *
 * REQUIRED SCRIPT TAGS, in this order, before this file (index.html is owned
 * by the integration agent — this is the exact snippet to add there):
 *   <link  rel="stylesheet" href="vendor/highlightjs/styles/github-dark.min.css">
 *   <script src="vendor/marked/marked.min.js"></script>
 *   <script src="vendor/highlightjs/highlight.min.js"></script>
 *   <script src="vendor/dompurify/purify.min.js"></script>
 *   <script src="highlight-wire.js"></script>
 * (github.min.css is the light-theme counterpart; app.js already contains
 * theme-swap logic that toggles between a github/github-dark stylesheet
 * link by href substring match — point it at the two vendored paths above
 * instead of the CDN URLs it currently hardcodes.)
 *
 * PUBLIC API — window.RuflowHighlight
 *   .render(markdown)          Sanitised HTML, code fences highlighted.
 *                               For text you already know is well-formed:
 *                               historical/reloaded blocks, complete strings.
 *   .renderSealed(markdown)    Same, but runs repairFences() first. This is
 *                               what run-render.js's seal() must call — a
 *                               seal can fire mid-stream (tool start or the
 *                               4s idle timer, per SPEC-v2.md "the seal
 *                               rule"), which can leave a code fence open.
 *   .repairFences(text)        Exported standalone (pure string -> string)
 *                               for unit testing and reuse.
 *   .highlightCode(code, lang) Sanitised <pre><code> HTML for a single code
 *                               string outside a full markdown document.
 *                               Exposed for reuse by the shell/diff
 *                               highlighters SPEC-v2.md's U7 section
 *                               describes — not called from this file.
 *   .LANGUAGES                 Array of the hljs language keys this build
 *                               registered (see below).
 *
 * WHAT THIS FILE MUST NEVER DO (per SPEC-v2.md "Do NOT do")
 * It must never be called on the live streaming tail. A live `say` block is
 * one text node updated with appendData — no parse, no innerHTML, no
 * highlight — until the moment it seals. This module only runs at seal,
 * once, forever (the sealed block is then immutable).
 *
 * SECURITY
 * Model output is untrusted and is rendered into innerHTML. DOMPurify.sanitize()
 * runs on every code path that returns HTML — render(), renderSealed(), and
 * highlightCode() — there is no bypass. hljs.highlight()/highlightAuto()
 * output is already HTML-entity-escaped by hljs itself (verified empirically:
 * hljs.highlight('<script>...</script>', {language:'javascript'}).value comes
 * back as `&lt;script&gt;...&lt;/script&gt;`); the no-hljs / unknown-language
 * fallback path escapes manually. DOMPurify then sanitises the *whole*
 * document on top of that, which is what neutralises raw HTML/script tags
 * and javascript: URLs sitting in the markdown source outside of code fences.
 */
(function (global) {
  'use strict';

  if (typeof global.marked === 'undefined') {
    throw new Error('highlight-wire.js: marked must load first (public/vendor/marked/marked.min.js)');
  }
  if (typeof global.DOMPurify === 'undefined') {
    throw new Error('highlight-wire.js: DOMPurify must load first (public/vendor/dompurify/purify.min.js)');
  }
  var marked = global.marked;
  var DOMPurify = global.DOMPurify;
  // hljs is treated as optional-but-expected: if it is somehow missing, fall
  // back to safe, sanitised, uncoloured code blocks rather than throwing and
  // losing the whole message.
  var hljs = global.hljs;

  // -------------------------------------------------------------------
  // hljs wiring — a marked.Renderer#code override, not the removed
  // `highlight` option. marked 12's Renderer#code signature is positional:
  // code(code, infostring, escaped). This changed to a single token object
  // ({text, lang, escaped}) starting in marked 13+ — if this vendor pin is
  // ever bumped past 12.x, this override's signature has to move with it.
  // -------------------------------------------------------------------
  var HLJS_AUTODETECT_MAX_CHARS = 50000; // guard against pathological highlightAuto cost on huge fences

  function escapeHtmlManual(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Returns { html, lang } where html is ALREADY HTML-escaped (either by
  // hljs itself, or by escapeHtmlManual below) — callers must not re-escape.
  function highlightCodeBlock(code, infostring) {
    var requestedLang = (infostring || '').match(/\S*/)[0];
    requestedLang = requestedLang ? requestedLang.toLowerCase() : '';

    if (!hljs) {
      return { html: escapeHtmlManual(code), lang: '' };
    }
    try {
      if (requestedLang && hljs.getLanguage(requestedLang)) {
        return { html: hljs.highlight(code, { language: requestedLang }).value, lang: requestedLang };
      }
      if (code.length <= HLJS_AUTODETECT_MAX_CHARS) {
        var auto = hljs.highlightAuto(code);
        return { html: auto.value, lang: auto.language || '' };
      }
    } catch (e) {
      // hljs can throw on pathological input (e.g. catastrophic regex cases
      // in a language grammar) — fall through to a plain, safe escape.
    }
    return { html: escapeHtmlManual(code), lang: '' };
  }

  var renderer = new marked.Renderer();
  renderer.code = function (code, infostring) {
    var result = highlightCodeBlock(code, infostring);
    var cls = result.lang ? ' class="hljs language-' + result.lang + '"' : ' class="hljs"';
    return '<pre><code' + cls + '>' + result.html + '\n</code></pre>\n';
  };

  marked.setOptions({ renderer: renderer, breaks: true });

  // -------------------------------------------------------------------
  // Fence repair — sealed-block path only. A seal can fire mid-generation
  // (tool start, or the 4s idle timer — see SPEC-v2.md "the seal rule"),
  // which can leave a ``` or ~~~ fence open. An unrepaired open fence makes
  // marked swallow every following line as literal code text. This scans
  // line-by-line for fence markers and appends a matching closer if the
  // text ends still "inside" one. It does not touch inline single/double
  // backtick spans — only whole fence lines.
  // -------------------------------------------------------------------
  var FENCE_OPEN_RE = /^([ \t]{0,3})(`{3,}|~{3,})/;             // opener: markers + optional info string
  var FENCE_CLOSE_RE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*$/;      // closer: markers + nothing but whitespace after

  function repairFences(text) {
    if (typeof text !== 'string' || (text.indexOf('```') === -1 && text.indexOf('~~~') === -1)) {
      return text;
    }
    var lines = text.split('\n');
    var open = null; // { indent, ch, len }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!open) {
        var m = FENCE_OPEN_RE.exec(line);
        if (m) open = { indent: m[1], ch: m[2].charAt(0), len: m[2].length };
        continue;
      }
      var c = FENCE_CLOSE_RE.exec(line);
      if (c && c[2].charAt(0) === open.ch && c[2].length >= open.len) {
        open = null;
      }
    }
    if (!open) return text;
    var closer = open.indent + new Array(open.len + 1).join(open.ch);
    return (text.charAt(text.length - 1) === '\n' ? text : text + '\n') + closer + '\n';
  }

  // -------------------------------------------------------------------
  // Public entry points — DOMPurify runs on every path that returns HTML.
  // -------------------------------------------------------------------
  function render(markdown) {
    var html = marked.parse(markdown || '');
    return DOMPurify.sanitize(html);
  }

  function renderSealed(markdown) {
    return render(repairFences(markdown || ''));
  }

  function highlightCode(code, lang) {
    var result = highlightCodeBlock(code || '', lang || '');
    var cls = result.lang ? ' class="hljs language-' + result.lang + '"' : ' class="hljs"';
    return DOMPurify.sanitize('<pre><code' + cls + '>' + result.html + '</code></pre>');
  }

  global.RuflowHighlight = {
    render: render,
    renderSealed: renderSealed,
    repairFences: repairFences,
    highlightCode: highlightCode,
    LANGUAGES: hljs ? hljs.listLanguages() : []
  };
})(typeof window !== 'undefined' ? window : this);

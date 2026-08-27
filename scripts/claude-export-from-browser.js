/* ===========================================================================
 * Pull your claude.ai projects + conversations from your OWN browser.
 *
 * WHY THIS EXISTS
 * claude.ai sits behind Cloudflare, which serves a JS challenge to requests
 * coming from a datacenter IP. So a server-side import with a copied
 * sessionKey gets a 403 from Cloudflare before Anthropic's API ever sees it.
 * This is not an auth failure and no amount of header-spoofing fixes it.
 *
 * This script sidesteps that without circumventing anything: it runs in your
 * own logged-in tab, so the requests are same-origin, already authenticated,
 * and come from the browser that already satisfied the challenge. It is the
 * same thing the page itself does.
 *
 * HOW TO USE
 *   1. Open https://claude.ai and make sure you are logged in.
 *   2. Open devtools (F12) -> Console.
 *   3. Paste this whole file in and press Enter.
 *   4. Wait — it prints progress. It downloads two files when done:
 *        projects.json      conversations.json
 *   5. Put BOTH files in one folder, then on the box:
 *        node scripts/import-claude.js --export /path/to/that/folder --dry-run
 *        node scripts/import-claude.js --export /path/to/that/folder
 *
 * The output matches the official data-export shape, so the importer treats
 * it identically to a real export .zip.
 * =========================================================================== */
(async () => {
  const API = '/api';
  const CONCURRENCY = 4;          // be gentle; this is a real account
  const log = (...a) => console.log('[claude-export]', ...a);

  async function get(pathname) {
    const r = await fetch(API + pathname, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`GET ${pathname} -> ${r.status}`);
    return r.json();
  }

  /** Run tasks with a small concurrency cap, reporting progress. */
  async function pool(items, worker, label) {
    const out = new Array(items.length);
    let next = 0, done = 0;
    async function run() {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await worker(items[i], i);
        } catch (e) {
          out[i] = null;
          console.warn(`[claude-export] ${label} ${i} failed:`, e.message);
        }
        if (++done % 10 === 0 || done === items.length) log(`${label}: ${done}/${items.length}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
    return out;
  }

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // --- organization -------------------------------------------------------
  const orgs = await get('/organizations');
  if (!Array.isArray(orgs) || !orgs.length) throw new Error('No organizations returned — are you logged in?');
  const org = orgs[0].uuid;
  log(`organization: ${orgs[0].name || org}`);

  // --- projects (+ their knowledge docs) ----------------------------------
  let projects = [];
  try {
    projects = await get(`/organizations/${org}/projects`);
    projects = Array.isArray(projects) ? projects : [];
    log(`projects: ${projects.length}`);
    await pool(projects, async (p) => {
      try {
        p.docs = await get(`/organizations/${org}/projects/${p.uuid}/docs`);
      } catch (_) {
        p.docs = p.docs || [];      // a project with no docs 404s on some accounts
      }
      return p;
    }, 'project docs');
  } catch (e) {
    console.warn('[claude-export] projects unavailable:', e.message);
  }

  // --- conversations ------------------------------------------------------
  let list = await get(`/organizations/${org}/chat_conversations`);
  list = Array.isArray(list) ? list : [];
  log(`conversations: ${list.length} — fetching full messages, this is the slow part`);

  const full = await pool(
    list,
    (c) => get(`/organizations/${org}/chat_conversations/${c.uuid}`),
    'conversations'
  );

  // Keep the summary row if the detail fetch failed, so nothing silently vanishes.
  const conversations = full.map((f, i) => f || list[i]).filter(Boolean);
  const failed = full.filter((f) => !f).length;

  log(`done. projects=${projects.length} conversations=${conversations.length}` +
      (failed ? ` (${failed} fell back to summary only)` : ''));

  download('projects.json', projects);
  download('conversations.json', conversations);
  log('two downloads triggered — put both files in one folder and point the importer at it.');
})().catch((e) => console.error('[claude-export] FAILED:', e));

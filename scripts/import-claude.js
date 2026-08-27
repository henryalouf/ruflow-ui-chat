#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CLI: import a user's own claude.ai projects + conversations into ruflow-ui.
//
//   node scripts/import-claude.js --export <path>            # zip/dir/json
//   node scripts/import-claude.js --api                      # RUFLOW_CLAUDE_SESSION_KEY
//   node scripts/import-claude.js --export <path> --dry-run
//
// Never prints the session key.
// ---------------------------------------------------------------------------

const path = require('path');
const { parseExport, fetchFromApi, importAll } = require('../lib/claude-import');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export') args.export = argv[++i];
    else if (a === '--api') args.api = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--session-key') args.sessionKey = argv[++i];
    else if (a === '--org') args.org = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/import-claude.js --export <path> [--dry-run]
  node scripts/import-claude.js --api [--org <orgId>] [--session-key <key>] [--dry-run]

  --export <path>    Path to a claude.ai export .zip, an extracted directory,
                      or a bare conversations.json / projects.json file.
  --api               Import live from claude.ai using a session cookie.
                      Reads RUFLOW_CLAUDE_SESSION_KEY if --session-key is not given.
  --org <orgId>       Organization uuid (--api only). Defaults to the first one found.
  --dry-run           Parse and report what would happen; write nothing.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.export && !args.api)) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  let parsed;
  try {
    if (args.api) {
      const sessionKey = args.sessionKey || process.env.RUFLOW_CLAUDE_SESSION_KEY;
      if (!sessionKey) {
        console.error('No session key given. Pass --session-key or set RUFLOW_CLAUDE_SESSION_KEY.');
        process.exit(1);
      }
      parsed = await fetchFromApi({
        sessionKey,
        orgId: args.org,
        onProgress: p => {
          if (p.stage === 'conversations') {
            console.error(`Fetching conversations… ${p.done}/${p.total}`);
          } else if (p.stage === 'conversation-list') {
            console.error(`Found ${p.count} conversations.`);
          } else if (p.stage === 'projects') {
            console.error(`Found ${p.count} projects.`);
          }
        },
      });
    } else {
      parsed = parseExport(args.export);
    }
  } catch (err) {
    console.error(`Import failed: ${err.message}`);
    process.exit(1);
  }

  // Overridable so an import can be rehearsed against a scratch dir before it
  // touches the operator's live projects and chats.
  const sessionsDir = process.env.RUFLOW_SESSIONS_DIR || path.join(__dirname, '..', 'sessions');
  const projectsDir = process.env.RUFLOW_PROJECTS_DIR || path.join(__dirname, '..', 'projects');
  const { createProjectStore } = require('../lib/projects');
  const projectStore = createProjectStore({ projectsDir, sessionsDir });
  const report = importAll(parsed, { projectStore, sessionsDir, dryRun: args.dryRun });

  const verb = args.dryRun ? 'Would import' : 'Imported';
  console.log(
    `${verb} ${report.projectsCreated} new project(s) and updated ${report.projectsUpdated} existing project(s).`
  );
  console.log(
    `${verb === 'Imported' ? 'Imported' : 'Would import'} ${report.sessionsCreated} chat(s); skipped ${report.sessionsSkipped} already-imported chat(s).`
  );

  if (report.warnings.length > 0) {
    console.log(`\nWarnings (${report.warnings.length}):`);
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
  if (report.errors.length > 0) {
    console.log(`\nErrors (${report.errors.length}):`);
    for (const e of report.errors) console.log(`  - ${e}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});

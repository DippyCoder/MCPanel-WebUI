#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   npm run temp - a single-use alternative admin credential.

   Creates a brand-new admin-role account through the accounts CLI addon,
   prints its password to the terminal exactly once, then watches for the
   first sign-in and deletes the account the moment one happens - so the
   printed password is only ever good for one login. It self-expires the
   same way if nobody uses it within the timeout.

   The real admin account and its password are never touched. This never
   touches the WebUI's session cookie, cache or HTTP layer either - it talks
   straight to the CLI, same as running the mcpanel commands by hand would.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('crypto');
const cli = require('../server/cli');

const POLL_MS = 2000;
const DEFAULT_TIMEOUT_MIN = 10;

function parseArgs(argv) {
  const out = { role: 'admin', timeoutMin: DEFAULT_TIMEOUT_MIN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-r' || a === '--role') out.role = argv[++i];
    else if (a === '--timeout') out.timeoutMin = Number(argv[++i]) || DEFAULT_TIMEOUT_MIN;
  }
  return out;
}

function genPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

function genUsername() {
  return `temp-${crypto.randomBytes(4).toString('hex')}`;
}

async function runJsonWithInput(argv, payload) {
  const { stdout, stderr, code } = await cli.execMcpanelWithInput(
    ['api', ...argv],
    JSON.stringify(payload),
  );
  if (code !== 0 && !stdout) throw new Error(stderr || `mcpanel exited with code ${code}`);
  let r;
  try { r = JSON.parse(stdout); } catch { throw new Error(`Unexpected CLI output: ${stdout || stderr}`); }
  if (!r || r.error || r.success === false) throw new Error((r && r.error) || 'Command failed');
  return r;
}

async function createTempAccount(user, password, role) {
  return runJsonWithInput(
    ['accounts', 'create', '-u', user, '-r', role, '--password-stdin'],
    { password },
  );
}

async function deleteTempAccount(user) {
  return cli.runCliJson(['accounts', 'delete', '-u', user]);
}

async function listSessionHashes(user) {
  const r = await cli.runCliJson(['accounts', 'sessions', 'list', '-u', user]);
  const sessions = (r && r.sessions) || [];
  return new Set(sessions.map((s) => s.tokenHash));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { role, timeoutMin } = parseArgs(process.argv.slice(2));

  const health = await cli.checkCli();
  if (!health.ok) {
    console.error(`mcpanel CLI not available: ${health.error}`);
    process.exitCode = 1;
    return;
  }

  const user = genUsername();
  const password = genPassword();

  console.log(`Creating a temporary "${role}" account...`);
  await createTempAccount(user, password, role);

  console.log('');
  console.log('='.repeat(60));
  console.log('  Single-use admin credential:');
  console.log('');
  console.log(`    username: ${user}`);
  console.log(`    password: ${password}`);
  console.log('');
  console.log('  It is deleted the moment a session is opened with it.');
  console.log('  The real admin account and password are untouched. Not');
  console.log('  written to disk or cookies.');
  console.log('='.repeat(60));
  console.log('');

  let settled = false;
  const cleanup = async (why) => {
    if (settled) return;
    settled = true;
    try {
      await deleteTempAccount(user);
    } catch (e) {
      console.error(`Warning: could not delete "${user}" - ${e.message}`);
      console.error(`Remove it by hand: mcpanel accounts delete -u ${user}`);
      return;
    }
    console.log(why);
  };

  process.on('SIGINT', async () => {
    console.log('\nCancelled - removing the temporary account before exit.');
    await cleanup('Temporary account removed.');
    process.exit(130);
  });

  console.log(`Waiting for it to be used (timeout ${timeoutMin}m, Ctrl+C to cancel)...`);
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let current;
    try {
      current = await listSessionHashes(user);
    } catch (e) {
      console.error(`Warning: could not poll sessions - ${e.message}`);
      continue;
    }
    if (current.size > 0) {
      await cleanup('Signed in - the temporary account has been removed.');
      return;
    }
  }

  await cleanup(`Unused after ${timeoutMin} minutes - the temporary account has been removed.`);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exitCode = 1;
});

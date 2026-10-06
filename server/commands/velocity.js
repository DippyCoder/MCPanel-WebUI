/* ═══════════════════════════════════════════════════════════════════════════
   Velocity proxy link - `proxy_info` / `link_to_proxy` / `get_velocity_secret`.

   Linking and reading the try list are delegated to MCPanel-CLI
   (`mcpanel api proxy info|link`). The link touches velocity.toml,
   server.properties and config/paper-global.yml in two server folders plus
   config.json, and the CLI does that as one transaction: if any write fails,
   every file already written is restored and the reply says so
   ({error, code: "proxy_link_failed", failedStep, rolledBack}). This module
   used to re-implement the edits itself, silently skipping failed writes -
   which could leave the proxy and the backend out of sync.

   Every CLI result is passed through untouched, so the frontend shows the
   CLI's own error message and the CLI owns the wording.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const applog = require('../applog');
const util = require('../util');
const cli = require('../cli');

/** Runs a CLI command, turning a failure to run it into the usual {error, code}. */
async function runCli(args) {
  try {
    return await cli.runCliJson(args);
  } catch (e) {
    return { error: e.message, code: e.code || 'error' };
  }
}

async function proxy_info({ velocityId }) {
  if (!velocityId) return { error: 'No Velocity server selected', code: 'invalid_arguments' };
  return runCli(['proxy', 'info', '--velocity-id', String(velocityId)]);
}

async function link_to_proxy({ paperId, velocityId, serverName, priority, customIp }) {
  const args = ['proxy', 'link', '-id', String(paperId), '--velocity-id', String(velocityId)];
  if (serverName) args.push('--server-name', String(serverName));
  if (priority !== undefined && priority !== null && priority !== '') {
    args.push('--priority', String(parseInt(priority, 10) || 0));
  }
  // The CLI accepts a bare host here and appends the backend's port itself.
  if (customIp) args.push('--custom-ip', String(customIp));

  const r = await runCli(args);
  if (r && r.error) {
    applog.warn(`Proxy link ${paperId} -> ${velocityId} failed [${r.code || 'error'}]: ${r.error}`);
  } else {
    applog.info(`Linked server "${r.serverName}" (${r.address}) to Velocity proxy -id ${velocityId}`);
  }
  return r;
}

/**
 * Rust's `str::lines()`: splits on \n, tolerates \r\n, and treats a trailing
 * newline as a terminator rather than as an extra empty line.
 */
function rustLines(s) {
  const parts = String(s).split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The quoted value on a `key = "value"` line, or null. */
function quotedValue(line) {
  const s = line.indexOf('"');
  if (s === -1) return null;
  const e = line.indexOf('"', s + 1);
  return e === -1 ? null : line.slice(s + 1, e);
}

/**
 * The forwarding secret, checked in the order Velocity itself resolves it:
 * a `forwarding-secret-file` directive, then an inline `forwarding-secret`,
 * then the legacy plain-text `forwarding.secret` file.
 */
function readVelocitySecretStr(velocityDir) {
  let contents = null;
  try {
    contents = fs.readFileSync(path.join(velocityDir, 'velocity.toml'), 'utf8');
  } catch { /* fall through to the legacy file */ }

  if (contents !== null) {
    for (const line of rustLines(contents)) {
      const t = line.trim();
      if (t.startsWith('forwarding-secret-file') && t.includes('=')) {
        const fname = quotedValue(t);
        if (fname) {
          try {
            const secret = fs.readFileSync(path.join(velocityDir, fname), 'utf8').trim();
            if (secret) return secret;
          } catch { /* keep looking */ }
        }
      }
    }
    for (const line of rustLines(contents)) {
      const t = line.trim();
      if (t.startsWith('forwarding-secret') && !t.startsWith('forwarding-secret-file') && t.includes('=')) {
        const secret = quotedValue(t);
        if (secret) return secret;
      }
    }
  }

  try {
    const secret = fs.readFileSync(path.join(velocityDir, 'forwarding.secret'), 'utf8').trim();
    if (secret) return secret;
  } catch { /* not present */ }

  return null;
}

async function get_velocity_secret({ id }) {
  let dir;
  try {
    dir = util.getServerDir(id);
  } catch (e) {
    return { error: e.message, code: 'server_not_found' };
  }
  const secret = readVelocitySecretStr(dir);
  if (secret) return { secret };
  return {
    error: 'Forwarding secret not found. Check velocity.toml or forwarding.secret.',
    code: 'secret_missing',
  };
}

module.exports = {
  proxy_info,
  link_to_proxy,
  get_velocity_secret,

  // Exported for tests; not dispatchable commands (the RPC registry only ever
  // looks up the snake_case command names above).
  _internals: {
    rustLines,
    readVelocitySecretStr,
  },
};

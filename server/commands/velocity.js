/* ═══════════════════════════════════════════════════════════════════════════
   Velocity proxy link - port of the `proxy_info` / `link_to_proxy` /
   `get_velocity_secret` half of src-tauri/src/commands.rs (lines 2112-2520).

   Linking a Paper server to a Velocity proxy touches three files the user also
   edits by hand: velocity.toml, server.properties and config/paper-global.yml.
   Everything here is deliberately line-oriented string surgery rather than a
   TOML/YAML round-trip - parsing and re-serialising would reflow the file and
   drop the comments Velocity and Paper ship in their default configs. The
   MCPanel desktop app edits these same files the same way, so the two apps can
   be pointed at one MCPANEL_HOME and stay interchangeable.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const applog = require('../applog');
const util = require('../util');

/**
 * Rust's `str::lines()`: splits on \n, tolerates \r\n, and treats a trailing
 * newline as a terminator rather than as an extra empty line. JS's split('\n')
 * differs on that last point, which would otherwise append a blank line to the
 * file on every single link operation.
 */
function rustLines(s) {
  const parts = String(s).split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Rust's `trim_matches(ch)` - strips every leading AND trailing `ch`. */
function trimMatches(s, ch) {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

/** Rust's `trim_end()` - trailing whitespace, newlines included. */
function trimEnd(s) {
  return s.replace(/\s+$/, '');
}

/**
 * Locates the `try = [...]` array inside the `[servers]` section.
 * Handles both the single-line form (`try = ["a", "b"]`) and the multi-line
 * form terminated by a lone `]` / `],`.
 * Returns { tryStart, tryEnd, entries } or null when there is no such array.
 */
function findVelocityTryArray(lines) {
  let inServers = false;
  let tryStart = null;
  let inArray = false;
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '[servers]') {
      inServers = true;
      continue;
    }
    if (inServers && t.startsWith('[') && t !== '[servers]') {
      inServers = false;
    }
    if (!inServers) continue;

    if (tryStart === null && t.startsWith('try')) {
      const eq = t.indexOf('=');
      if (eq !== -1) {
        const after = t.slice(eq + 1).trim();
        if (after.startsWith('[')) {
          tryStart = i;
          if (after.endsWith(']')) {
            const inner = after.slice(1, after.length - 1);
            for (const part of inner.split(',')) {
              const s = trimMatches(part.trim(), '"').trim();
              if (s) entries.push(s);
            }
            return { tryStart: i, tryEnd: i, entries };
          }
          inArray = true;
          continue;
        }
      }
    }

    if (inArray) {
      if (t === ']' || t === '],') {
        return { tryStart, tryEnd: i, entries };
      }
      const entry = trimMatches(trimMatches(t, ',').trim(), '"').trim();
      if (entry) entries.push(entry);
    }
  }
  return null;
}

function parseVelocityTryList(contents) {
  const found = findVelocityTryArray(rustLines(contents));
  return found ? found.entries : [];
}

function getServerPortFromConfig(id) {
  let dir;
  try {
    dir = util.getServerDir(id);
  } catch {
    return 25565;
  }
  let contents;
  try {
    contents = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  } catch {
    return 25565;
  }
  for (const line of rustLines(contents)) {
    if (line.startsWith('server-port=')) {
      const p = parseInt(line.slice('server-port='.length).trim(), 10);
      if (Number.isInteger(p) && p >= 0 && p <= 65535) return p;
    }
  }
  return 25565;
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
        const s = t.indexOf('"');
        if (s !== -1) {
          const e = t.indexOf('"', s + 1);
          if (e !== -1) {
            const fname = t.slice(s + 1, e);
            try {
              const secret = fs.readFileSync(path.join(velocityDir, fname), 'utf8').trim();
              if (secret) return secret;
            } catch { /* keep looking */ }
          }
        }
      }
    }
    for (const line of rustLines(contents)) {
      const t = line.trim();
      if (t.startsWith('forwarding-secret') && !t.startsWith('forwarding-secret-file') && t.includes('=')) {
        const s = t.indexOf('"');
        if (s !== -1) {
          const e = t.indexOf('"', s + 1);
          if (e !== -1) {
            const secret = t.slice(s + 1, e);
            if (secret) return secret;
          }
        }
      }
    }
  }

  try {
    const secret = fs.readFileSync(path.join(velocityDir, 'forwarding.secret'), 'utf8').trim();
    if (secret) return secret;
  } catch { /* not present */ }

  return null;
}

function updateVelocityToml(contents, serverName, address, priority) {
  const lines = rustLines(contents);
  const found = findVelocityTryArray(lines);

  if (found) {
    const { tryStart, tryEnd } = found;
    const entries = found.entries;

    const serverEntryExists = lines.some(l => {
      const t = l.trim();
      return t.startsWith(`${serverName} =`) || t.startsWith(`${serverName}=`);
    });

    if (!entries.includes(serverName)) {
      const pri = Math.max(0, Math.floor(Number(priority) || 0));
      entries.splice(Math.min(pri, entries.length), 0, serverName);
    }

    const tryLine = `try = [${entries.map(e => `"${e}"`).join(', ')}]`;

    let result = '';
    let i = 0;
    while (i < lines.length) {
      if (i === tryStart) {
        if (!serverEntryExists) result += `${serverName} = "${address}"\n`;
        result += `${tryLine}\n`;
        i = tryEnd + 1;
        continue;
      }
      result += `${lines[i]}\n`;
      i += 1;
    }
    return result;
  }

  // No [servers]/try = [...] found. This is expected (not an error) when Velocity
  // has never been started: velocity.toml only gets its full default template -
  // including the [servers] section - merged in by Velocity's own config loader
  // on first run. mcpanel-cli's initial velocity.toml (written at server-creation
  // time, before the jar has ever executed) only contains a `bind = "..."` line.
  // Rather than failing the link, create the section ourselves.
  const entryLine = `${serverName} = "${address}"`;
  const tryLine = `try = ["${serverName}"]`;

  const idx = lines.findIndex(l => l.trim() === '[servers]');
  if (idx !== -1) {
    let result = '';
    for (let i = 0; i < lines.length; i++) {
      result += `${lines[i]}\n`;
      if (i === idx) {
        result += `${entryLine}\n`;
        result += `${tryLine}\n`;
      }
    }
    return result;
  }

  let result = trimEnd(contents);
  if (result) result += '\n\n';
  result += `[servers]\n${entryLine}\n${tryLine}\n`;
  return result;
}

/**
 * Modern forwarding is what carries the player's real identity through the
 * proxy - leaving the mode at NONE would let anyone connect to the backend
 * directly and pick any username. Any value other than NONE is left alone, so
 * a user who deliberately chose LEGACY/BUNGEEGUARD keeps it.
 */
function ensureVelocityForwardingModern(contents) {
  let result = '';
  for (const line of rustLines(contents)) {
    const t = line.trim();
    if (t.startsWith('player-info-forwarding-mode') && t.includes('=')) {
      const eq = t.indexOf('=');
      const val = trimMatches(t.slice(eq + 1).trim(), '"').toUpperCase();
      if (val === 'NONE') {
        result += 'player-info-forwarding-mode = "MODERN"\n';
        continue;
      }
    }
    result += `${line}\n`;
  }
  return result;
}

/**
 * Sets proxies.velocity.{enabled,online-mode,secret} without disturbing the
 * rest of the document. Tracks indentation rather than using a YAML parser so
 * Paper's inline documentation comments survive; each rewritten key is emitted
 * at the indentation it already had.
 */
function updatePaperGlobalYml(contents, secret) {
  let result = '';
  let inProxies = false;
  let inVelocity = false;
  let proxiesIndent = 0;
  let velocityIndent = 0;

  for (const line of rustLines(contents)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      result += `${line}\n`;
      continue;
    }
    const indent = line.length - line.trimStart().length;

    if (inVelocity && indent <= velocityIndent) {
      inVelocity = false;
    }
    if (inProxies && indent <= proxiesIndent && trimmed !== 'proxies:') {
      inProxies = false;
      inVelocity = false;
    }

    if (!inProxies && trimmed === 'proxies:') {
      inProxies = true;
      proxiesIndent = indent;
      result += `${line}\n`;
      continue;
    }
    if (inProxies && !inVelocity && trimmed === 'velocity:') {
      inVelocity = true;
      velocityIndent = indent;
      result += `${line}\n`;
      continue;
    }

    if (inVelocity) {
      const spaces = ' '.repeat(indent);
      if (trimmed.startsWith('enabled:')) {
        result += `${spaces}enabled: true\n`;
        continue;
      }
      if (trimmed.startsWith('online-mode:')) {
        result += `${spaces}online-mode: true\n`;
        continue;
      }
      if (trimmed.startsWith('secret:')) {
        result += `${spaces}secret: '${secret}'\n`;
        continue;
      }
    }

    result += `${line}\n`;
  }
  return result;
}

async function proxy_info({ velocityId }) {
  let dir;
  try {
    dir = util.getServerDir(velocityId);
  } catch (e) {
    return { error: e.message };
  }
  let contents;
  try {
    contents = fs.readFileSync(path.join(dir, 'velocity.toml'), 'utf8');
  } catch (e) {
    return { error: `Failed to read velocity.toml: ${e.message}` };
  }
  return { tryList: parseVelocityTryList(contents) };
}

async function link_to_proxy({ paperId, velocityId, serverName, priority, customIp }) {
  let paperDir;
  try {
    paperDir = util.getServerDir(paperId);
  } catch (e) {
    return { error: e.message };
  }
  let velocityDir;
  try {
    velocityDir = util.getServerDir(velocityId);
  } catch (e) {
    return { error: e.message };
  }

  const port = getServerPortFromConfig(paperId);
  const address = customIp ? `${customIp}:${port}` : `127.0.0.1:${port}`;

  // The forwarding secret (and the [servers]/try = [...] section handled below)
  // only exist once Velocity has generated its full config, which happens on its
  // own first run - not at server-creation time. Check this up front: without a
  // real secret, linking would "succeed" but leave modern forwarding silently
  // broken (empty secret in paper-global.yml).
  const secret = readVelocitySecretStr(velocityDir) || '';
  if (!secret) {
    return { error: "This Velocity proxy hasn't been started yet, so it hasn't generated its forwarding secret. Start it once, then try linking again." };
  }

  const tomlPath = path.join(velocityDir, 'velocity.toml');
  let tomlContents;
  try {
    tomlContents = fs.readFileSync(tomlPath, 'utf8');
  } catch (e) {
    return { error: `Failed to read velocity.toml: ${e.message}` };
  }
  let updatedToml = updateVelocityToml(tomlContents, serverName, address, priority);
  updatedToml = ensureVelocityForwardingModern(updatedToml);
  try {
    fs.writeFileSync(tomlPath, updatedToml);
  } catch (e) {
    return { error: `Failed to write velocity.toml: ${e.message}` };
  }

  // Set online-mode=false in server.properties - the proxy authenticates
  // players now, so the backend must not try to as well.
  const propsPath = path.join(paperDir, 'server.properties');
  try {
    const props = fs.readFileSync(propsPath, 'utf8');
    let updated;
    if (props.includes('online-mode=')) {
      updated = '';
      for (const line of rustLines(props)) {
        updated += line.startsWith('online-mode=') ? 'online-mode=false\n' : `${line}\n`;
      }
    } else {
      updated = `${trimEnd(props)}\nonline-mode=false\n`;
    }
    fs.writeFileSync(propsPath, updated);
  } catch { /* best-effort, exactly as the Rust ignores both errors here */ }

  const paperGlobalPath = path.join(paperDir, 'config', 'paper-global.yml');
  try {
    const paperGlobal = fs.readFileSync(paperGlobalPath, 'utf8');
    fs.writeFileSync(paperGlobalPath, updatePaperGlobalYml(paperGlobal, secret));
  } catch { /* best-effort */ }

  applog.info(`Linked server "${serverName}" (${address}) to Velocity proxy -id ${velocityId}`);
  return { success: true };
}

async function get_velocity_secret({ id }) {
  let dir;
  try {
    dir = util.getServerDir(id);
  } catch (e) {
    return { error: e.message };
  }

  let contents = null;
  try {
    contents = fs.readFileSync(path.join(dir, 'velocity.toml'), 'utf8');
  } catch { /* fall through to the legacy file */ }

  if (contents !== null) {
    for (const line of rustLines(contents)) {
      const t = line.trim();
      if (t.startsWith('forwarding-secret-file') && t.includes('=')) {
        const s = t.indexOf('"');
        if (s !== -1) {
          const e = t.indexOf('"', s + 1);
          if (e !== -1) {
            const fname = t.slice(s + 1, e);
            try {
              const secret = fs.readFileSync(path.join(dir, fname), 'utf8').trim();
              if (secret) return { secret };
            } catch { /* keep looking */ }
          }
        }
      }
    }
    for (const line of rustLines(contents)) {
      const t = line.trim();
      if (t.startsWith('forwarding-secret') && !t.startsWith('forwarding-secret-file') && t.includes('=')) {
        const s = t.indexOf('"');
        if (s !== -1) {
          const e = t.indexOf('"', s + 1);
          if (e !== -1) {
            const secret = t.slice(s + 1, e);
            if (secret) return { secret };
          }
        }
      }
    }
  }

  try {
    const secret = fs.readFileSync(path.join(dir, 'forwarding.secret'), 'utf8').trim();
    if (secret) return { secret };
  } catch { /* not present */ }

  return { error: 'Forwarding secret not found. Check velocity.toml or forwarding.secret.' };
}

module.exports = {
  proxy_info,
  link_to_proxy,
  get_velocity_secret,

  // Exported for the port's own tests; not dispatchable commands (the RPC
  // registry only ever looks up the snake_case Tauri command names above).
  _internals: {
    rustLines,
    trimMatches,
    findVelocityTryArray,
    parseVelocityTryList,
    updateVelocityToml,
    ensureVelocityForwardingModern,
    updatePaperGlobalYml,
    readVelocitySecretStr,
    getServerPortFromConfig,
  },
};

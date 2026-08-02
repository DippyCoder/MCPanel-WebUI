/* ═══════════════════════════════════════════════════════════════════════════
   Server lifecycle commands - port of the server half of
   src-tauri/src/commands.rs.

   Anything that changes what a Minecraft server *is* (create, import,
   duplicate, update, EULA) or what it's *doing* (start, stop, console I/O,
   ping, log tailing) lives here. Most of it delegates to mcpanel-cli; the
   exceptions are the ones the Tauri app also did natively because a CLI
   round-trip would have been too slow or too coarse: update_server,
   accept_eula, duplicate_server, get_log_since and the log tailer itself.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');

const paths = require('../paths');
const applog = require('../applog');
const cli = require('../cli');
const util = require('../util');
const events = require('../events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runFile = (id, ext) => path.join(paths.runDir(), `${id}${ext}`);

/**
 * The port also has to land in the server's own config file, or the next
 * launch would still bind the old one - Velocity keeps it in velocity.toml's
 * `bind`, everything else in server.properties' `server-port`.
 */
function applyPortToServerConfig(dir, software, port) {
  if (software === 'velocity') {
    const tomlFile = path.join(dir, 'velocity.toml');
    const newBind = `bind = "0.0.0.0:${port}"`;
    let contents = '';
    try { contents = fs.readFileSync(tomlFile, 'utf8'); } catch { /* treated as empty */ }

    const isBindLine = (l) => {
      const t = l.trim();
      return t.startsWith('bind') && t.includes('=') && t.includes('"');
    };
    const lines = contents.split('\n');
    // A trailing newline yields a final empty element that Rust's .lines()
    // would not produce - drop it so round-tripping doesn't grow the file.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    const updated = lines.some(isBindLine)
      ? lines.map(l => (isBindLine(l) ? newBind : l)).join('\n') + '\n'
      : `${newBind}\n${contents.replace(/\s+$/, '')}\n`;
    try { fs.writeFileSync(tomlFile, updated); } catch { /* best-effort */ }
    return;
  }

  const propsFile = path.join(dir, 'server.properties');
  let contents;
  try { contents = fs.readFileSync(propsFile, 'utf8'); } catch { return; }

  const entry = `server-port=${port}`;
  let updated;
  if (contents.includes('server-port=')) {
    const lines = contents.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    updated = lines.map(l => (l.startsWith('server-port=') ? entry : l)).join('\n') + '\n';
  } else {
    updated = `${contents.replace(/\s+$/, '')}\n${entry}\n`;
  }
  try { fs.writeFileSync(propsFile, updated); } catch { /* best-effort */ }
}

async function update_server({ id, updates }) {
  const cfg = util.readConfig();
  if (!Array.isArray(cfg.servers)) throw new Error('No servers array');
  const srv = cfg.servers.find(s => s && s.id === id);
  if (!srv) throw new Error('Server not found');

  if (updates && typeof updates === 'object' && !Array.isArray(updates)) {
    const fields = Object.keys(updates);
    if (fields.length) {
      applog.info(`Updated server "${srv.name || id}" (${fields.join(', ')}) -id ${id}`);
    }
    for (const [k, v] of Object.entries(updates)) srv[k] = v;
  }

  // Only an actual integer counts as a port change - the settings form sends
  // `port: null` when the field is blank, which must not rewrite anything.
  const port = updates && updates.port;
  if (Number.isInteger(port) && srv.dir) {
    applyPortToServerConfig(srv.dir, srv.software || '', port);
  }

  const server = { ...srv };
  util.writeConfig(cfg);
  util.writeServerManifest(server);
  return JSON.stringify({ success: true, server });
}

async function accept_eula({ id }) {
  const dir = util.getServerDir(id);
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  return JSON.stringify({ success: true });
}

async function duplicate_server({ id, newName }, ctx) {
  const emit = (ctx && ctx.emit) || events.emit;
  emit('download-progress', { id: '__dup__', progress: 0, status: 'Copying server files…' });

  const cfg = util.readConfig();
  const src = (Array.isArray(cfg.servers) ? cfg.servers : []).find(s => s && s.id === id);
  if (!src) throw new Error('Server not found');
  if (!src.dir) throw new Error('No dir');

  const nowMs = Date.now();
  const newId = `srv_${nowMs}`;
  const newDir = path.join(paths.serversDir(), newId);

  fs.mkdirSync(newDir, { recursive: true });
  util.copyDirAll(src.dir, newDir);

  const newSrv = { ...src, id: newId, name: newName, dir: newDir, created: nowMs };

  if (!Array.isArray(cfg.servers)) throw new Error('No servers array');
  cfg.servers.push(newSrv);
  util.writeConfig(cfg);
  util.writeServerManifest(newSrv);

  emit('download-progress', { id: newId, progress: 100, status: 'Done!' });
  return JSON.stringify({ success: true, server: newSrv });
}

/**
 * Tails run/<id>.log.jsonl and republishes each record as a `server-log`
 * event. The server's liveness is inferred from run/<id>.json, which the CLI's
 * supervisor removes on exit - three consecutive misses (rather than one) so a
 * momentary rewrite of that file isn't read as a shutdown.
 */
function startLogStreamer(id, emit) {
  const logPath = runFile(id, '.log.jsonl');
  const statePath = runFile(id, '.json');

  let stopped = false;
  let pos = 0; // byte offset into the log file, matching the Rust `pos`

  const emitNewLines = (buf) => {
    if (buf.length <= pos) return;
    const chunk = buf.subarray(pos).toString('utf8');
    pos = buf.length;
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      emit('server-log', {
        id,
        line: typeof rec.text === 'string' ? rec.text : '',
        type: typeof rec.type === 'string' ? rec.type : 'out',
      });
    }
  };

  const readLog = async () => {
    try { return await fsp.readFile(logPath); } catch { return null; }
  };

  (async () => {
    // Wait for the log file (up to 10 s) - the CLI creates it a moment after
    // `start server` returns.
    for (let i = 0; i < 40 && !stopped; i++) {
      if (fs.existsSync(logPath)) break;
      await sleep(250);
    }

    let noStateCount = 0;
    while (!stopped) {
      const buf = await readLog();
      if (buf) emitNewLines(buf);

      let stateExists = false;
      try { await fsp.access(statePath); stateExists = true; } catch { stateExists = false; }

      if (!stateExists) {
        noStateCount += 1;
        if (noStateCount >= 3) {
          // Drain whatever the server wrote on its way out.
          await sleep(400);
          const finalBuf = await readLog();
          if (finalBuf) emitNewLines(finalBuf);
          emit('server-stopped', { id, code: null });
          break;
        }
      } else {
        noStateCount = 0;
      }

      await sleep(250);
    }
  })().catch(e => applog.error(`log streamer for ${id} died: ${e.message}`));

  return { stop() { stopped = true; } };
}

async function start_server({ id }, ctx) {
  const emit = (ctx && ctx.emit) || events.emit;
  const streamers = ctx && ctx.state && ctx.state.logStreamers;

  const result = await cli.runCli(['start', 'server', '-id', id]);

  let success = false;
  try { success = JSON.parse(result).success === true; } catch { success = false; }

  if (success && streamers) {
    // A previous tailer for this id normally exits on its own when the server
    // stops, but a failed start/stop cycle can leave one alive - dropping it
    // here keeps every console line from being emitted twice.
    const existing = streamers.get(id);
    if (existing) { try { existing.stop(); } catch { /* ignore */ } }
    streamers.set(id, startLogStreamer(id, emit));
  }

  return result;
}

async function stop_log_stream({ id }, ctx) {
  const streamers = ctx && ctx.state && ctx.state.logStreamers;
  if (!streamers) return null;
  const streamer = streamers.get(id);
  if (streamer) { try { streamer.stop(); } catch { /* ignore */ } }
  streamers.delete(id);
  return null;
}

/**
 * The CLI reports nothing until it's finished, so both create and import run a
 * fake progress ticker to keep the bar moving. It's capped below 100 % so the
 * jump to "Done!" always comes from the real result.
 */
function startProgressTicker(emit, { id, status, everyMs, step, cap }) {
  let p = 5;
  const handle = setInterval(() => {
    p = Math.min(p + step, cap);
    emit('download-progress', { id, progress: p, status });
  }, everyMs);
  if (handle.unref) handle.unref();
  return () => clearInterval(handle);
}

function parseCreatedServerId(stdout, fallback) {
  try {
    const v = JSON.parse(stdout);
    const id = v && v.server && v.server.id;
    if (typeof id === 'string' && id) return id;
  } catch { /* fall through */ }
  return fallback;
}

async function runWithProgress(argv, emit, ticker, fallbackId) {
  const stopTicker = startProgressTicker(emit, ticker);
  let out;
  try {
    out = await cli.execMcpanel(argv);
  } finally {
    stopTicker();
  }
  if (out.spawnError) throw new Error(`Failed to run mcpanel: ${out.spawnError.message}`);

  const stdout = out.stdout;
  const serverId = parseCreatedServerId(stdout, fallbackId);
  emit('download-progress', { id: serverId, progress: 100, status: 'Done!' });

  return { stdout, stderr: out.stderr, code: out.code };
}

async function create_server({ args }, ctx) {
  const emit = (ctx && ctx.emit) || events.emit;
  const argsList = Array.isArray(args) ? args.map(String) : [];

  // Spigot has no prebuilt jar - the CLI compiles it locally with BuildTools,
  // which takes minutes rather than the few seconds a normal jar download takes.
  let isSpigot = false;
  for (let i = 0; i + 1 < argsList.length; i++) {
    if ((argsList[i] === '-sw' || argsList[i] === '--software') && argsList[i + 1] === 'spigot') {
      isSpigot = true;
      break;
    }
  }
  const statusMsg = isSpigot
    ? 'Building Spigot with BuildTools… (this can take several minutes)'
    : 'Downloading server jar…';

  emit('download-progress', { id: '__creating__', progress: 5, status: statusMsg });

  const argv = ['api', 'create', 'server', ...argsList];
  applog.info(`create_server: mcpanel ${argv.join(' ')}`);

  const { stdout, stderr, code } = await runWithProgress(argv, emit, {
    id: '__creating__', status: statusMsg, everyMs: 3000, step: 12, cap: 88,
  }, '__creating__');

  if (!stdout && code !== 0) {
    applog.error(`  error: ${stderr}`);
    throw new Error(stderr || `mcpanel exited with code ${code}`);
  }
  applog.info(`  ok (${stdout.length} bytes)`);
  return stdout;
}

async function import_server_cmd({ args }, ctx) {
  const emit = (ctx && ctx.emit) || events.emit;
  const argsList = Array.isArray(args) ? args.map(String) : [];
  const statusMsg = 'Copying server files…';

  emit('download-progress', { id: '__importing__', progress: 5, status: statusMsg });

  const argv = ['api', 'import', 'server', ...argsList];

  const { stdout, stderr, code } = await runWithProgress(argv, emit, {
    id: '__importing__', status: statusMsg, everyMs: 1000, step: 15, cap: 88,
  }, '__importing__');

  if (!stdout && code !== 0) throw new Error(stderr || `mcpanel exited with code ${code}`);
  return stdout;
}

async function send_server_command({ id, cmd }) {
  if (process.platform === 'win32') {
    return { error: 'Unix sockets not supported on this platform' };
  }

  const sockPath = runFile(id, '.sock');

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { socket.destroy(); } catch { /* ignore */ } resolve(v); } };

    const socket = net.createConnection(sockPath);
    let buf = '';

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ op: 'cmd', text: cmd })}\n`, (err) => {
        if (err) done({ error: err.message });
      });
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      try { done(JSON.parse(line)); } catch { done({ ok: true }); }
    });

    // The supervisor may acknowledge by closing rather than replying.
    socket.on('end', () => done({ ok: true }));
    socket.on('close', () => done({ ok: true }));
    socket.on('error', (e) => done({ error: `Not running: ${e.message}` }));
    socket.setTimeout(3000, () => done({ ok: true }));
  });
}

function writeVarint(out, value) {
  let v = value | 0;
  for (;;) {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
    if (v === 0) break;
  }
}

async function ping_server({ host, port }) {
  const OFFLINE = { online: false };
  const portNum = Number(port) & 0xffff;

  const socket = new net.Socket();

  const connected = await new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const timer = setTimeout(() => { socket.destroy(); finish(false); }, 3000);
    socket.once('connect', () => { clearTimeout(timer); finish(true); });
    socket.once('error', () => { clearTimeout(timer); finish(false); });
    socket.connect(portNum, host);
  });
  if (!connected) { socket.destroy(); return OFFLINE; }

  // Handshake (packet 0x00): protocol 762, host, port, next-state 1 (status),
  // immediately followed by the 2-byte status-request packet in the same write.
  const hostBytes = Buffer.from(String(host), 'utf8');
  const body = [];
  writeVarint(body, 0x00);
  writeVarint(body, 762);
  writeVarint(body, hostBytes.length);
  for (const b of hostBytes) body.push(b);
  body.push((portNum >> 8) & 0xff);
  body.push(portNum & 0xff);
  writeVarint(body, 1);

  const packet = [];
  writeVarint(packet, body.length);
  packet.push(...body);
  packet.push(1, 0x00); // status request

  try {
    socket.write(Buffer.from(packet));
  } catch {
    socket.destroy();
    return OFFLINE;
  }

  // Read up to 8 KiB of the status response. The Rust version took a single
  // read; here chunks are joined until the JSON parses so a response split
  // across TCP segments still resolves.
  const text = await new Promise((resolve) => {
    let settled = false;
    const chunks = [];
    let total = 0;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), 3000);

    socket.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      const so_far = Buffer.concat(chunks).toString('utf8');
      const start = so_far.indexOf('{');
      const end = so_far.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try { JSON.parse(so_far.slice(start, end + 1)); finish(so_far); } catch { /* keep reading */ }
      }
      if (total >= 8192) finish(so_far);
    });
    socket.on('error', () => finish(Buffer.concat(chunks).toString('utf8')));
    socket.on('close', () => finish(Buffer.concat(chunks).toString('utf8')));
  });

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return OFFLINE;

  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { return OFFLINE; }

  const desc = data.description;
  let motd = '';
  if (typeof desc === 'string') motd = desc;
  else if (desc && typeof desc === 'object') motd = typeof desc.text === 'string' ? desc.text : '';

  const players = data.players || {};
  const sample = Array.isArray(players.sample) ? players.sample : [];

  return {
    online: true,
    players: Number.isFinite(players.online) ? players.online : 0,
    maxPlayers: Number.isFinite(players.max) ? players.max : 0,
    playerList: sample.map(p => (p && typeof p.name === 'string' ? p.name : null)).filter(n => n !== null),
    version: (data.version && typeof data.version.name === 'string') ? data.version.name : 'Unknown',
    motd,
  };
}

async function get_log_since({ id, offset }) {
  const logPath = runFile(id, '.log.jsonl');
  const from = Number(offset) || 0;

  let handle;
  try {
    handle = await fsp.open(logPath, 'r');
  } catch {
    return { lines: [], offset: 0 };
  }

  try {
    let total;
    try { total = (await handle.stat()).size; } catch { return { lines: [], offset: from }; }

    // File was truncated or rotated - restart from the beginning.
    const seekTo = from > total ? 0 : from;

    let buf;
    try {
      const length = Math.max(0, total - seekTo);
      buf = Buffer.alloc(length);
      if (length > 0) await handle.read(buf, 0, length, seekTo);
    } catch {
      return { lines: [], offset: from };
    }

    const lines = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip partial/garbage records */ }
    }
    return { lines, offset: total };
  } finally {
    try { await handle.close(); } catch { /* ignore */ }
  }
}

async function get_server_start_time({ id }) {
  try {
    const v = JSON.parse(fs.readFileSync(runFile(id, '.json'), 'utf8'));
    return typeof v.started === 'number' ? v.started : null;
  } catch {
    return null;
  }
}

module.exports = {
  update_server,
  accept_eula,
  duplicate_server,
  start_server,
  stop_log_stream,
  create_server,
  import_server_cmd,
  send_server_command,
  ping_server,
  get_log_since,
  get_server_start_time,
};

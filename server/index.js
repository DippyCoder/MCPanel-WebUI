#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   MCPanel WebUI - HTTP/WebSocket host for the MCPanel frontend.

   The browser runs the exact same index.html / style.css / app.js as the
   MCPanel Tauri app. The only swapped file is the bridge: tauri-bridge.js
   becomes web-bridge.js, which turns every `invoke(cmd, args)` into
   `POST /api/invoke {cmd, args}` and every `listen(channel)` into a frame
   arriving over `/ws`.

   Command modules under server/commands/ each export a flat object of
   `{ command_name: async (args, ctx) => value }`, where `command_name`
   matches the Tauri command name one-for-one.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const pkg = require('../package.json');
const paths = require('./paths');
const applog = require('./applog');
const cli = require('./cli');
const events = require('./events');
const util = require('./util');
const auth = require('./auth');

// The permission map lives in its own module. If it is missing or broken the
// panel must not simply run wide open, so every non-admin request is refused
// until it loads - see permissionDenied() below.
let permissions = null;
try {
  permissions = require('./permissions');
} catch (e) {
  applog.error(`Permission map unavailable: ${e && e.message}. Non-admin access will be refused.`);
}

// Fallback layer between the env vars and the hardcoded default: host/port
// saved from the Settings page's Network panel (server/commands/network.js).
// --host/--port and MCPANEL_WEBUI_HOST/_PORT both still win over this.
function readPersistedNetworkConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.networkConfigPath(), 'utf8'));
    const out = {};
    if (parsed && typeof parsed.host === 'string' && parsed.host.trim()) out.host = parsed.host.trim();
    if (parsed && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) out.port = parsed.port;
    return out;
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const persisted = readPersistedNetworkConfig();
  // Reachable from other devices out of the box - sign-in is mandatory
  // regardless of bind address (see the static/API gates below), so this
  // controls whether the login page itself is LAN-reachable, not whether the
  // panel is protected. Pass --host 127.0.0.1 to restrict to this machine.
  const out = { host: process.env.MCPANEL_WEBUI_HOST || persisted.host || '0.0.0.0',
                port: Number(process.env.MCPANEL_WEBUI_PORT) || persisted.port || 8730,
                token: process.env.MCPANEL_WEBUI_TOKEN || null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const ARGS = parseArgs(process.argv);

if (ARGS.help) {
  process.stdout.write(`MCPanel WebUI v${pkg.version}

  mcpanel-webui [--host <addr>] [--port <n>] [--token <secret>]

  --host    interface to bind (default 0.0.0.0, reachable on the LAN; use
            127.0.0.1 to restrict to this machine)
  --port    port to listen on (default 8730; also changeable from
            Settings -> Network once signed in as an admin)
  --token   an EXTRA shared secret required on top of signing in. Sign-in is
            always required; this is a second outer gate for panels exposed
            to an untrusted network.

  Every request is authenticated against the MCPanel-CLI accounts addon.
  A fresh install is seeded with admin / admin - change that password from
  the panel before exposing it to anything.

  Environment: MCPANEL_HOME, MCPANEL_WEBUI_HOST, MCPANEL_WEBUI_PORT,
               MCPANEL_WEBUI_TOKEN
`);
  process.exit(0);
}

// ─── Shared runtime state (the WebUI's equivalent of Tauri's AppState) ───────

const state = {
  /** id → { stop() } for the per-server log tailers started by start_server. */
  logStreamers: new Map(),
  /** { child, zipPath } while a backup is running, so quit_app can cancel it. */
  activeBackup: null,
  /** ws → pty session, for the embedded terminal. */
  ptySessions: new Map(),
  /** Set by index.js so shutdown paths can reach the http server. */
  httpServer: null,
};

const commands = Object.create(null);

function loadCommandModules() {
  const dir = path.join(__dirname, 'commands');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.js')) continue;
    let mod;
    try {
      mod = require(path.join(dir, file));
    } catch (e) {
      applog.error(`Failed to load command module ${file}: ${e && e.stack ? e.stack : e}`);
      process.stderr.write(`[mcpanel-webui] failed to load ${file}: ${e && e.message}\n`);
      continue;
    }
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      if (commands[name]) applog.warn(`Duplicate command "${name}" - ${file} overrode an earlier module`);
      commands[name] = fn;
    }
  }
}

/** Passed as the second argument to every command handler. */
const ctx = {
  emit: events.emit,
  emitTo: events.emitTo,
  applog,
  cli,
  paths,
  util,
  state,
  appVersion: pkg.version,
};

/**
 * Returns null when `user` may run `cmd`, or a human-readable reason when they
 * may not. Fails CLOSED: if the permission map could not be loaded, only
 * admins (and internal system work) get through.
 */
function permissionDenied(user, cmd, args) {
  if (user && user.system) return null;              // scheduler / boot tasks
  if (!user) return 'You are not signed in.';

  if (!permissions || typeof permissions.check !== 'function') {
    if (user.isAdmin) return null;
    applog.error(`Refusing "${cmd}" for "${user.username}": permission map unavailable`);
    return 'Permission checks are unavailable on this server, so the action was blocked.';
  }
  try {
    // `args` is not optional in practice: run_cli forwards an arbitrary argv,
    // and permissions.js decides what that particular invocation needs by
    // reading it. Omitting it makes every run_cli fall back to `cli.raw` -
    // which, since the frontend does most of its reads through run_cli, locks
    // every non-admin out of the whole panel.
    return permissions.check(user, cmd, args) || null;
  } catch (e) {
    applog.error(`Permission check for "${cmd}" threw: ${e && e.message}`);
    return 'Permission check failed.';
  }
}

/**
 * Runs a command as `user`. The handler contract stays `(args, ctx)`; the
 * caller's identity rides along on ctx.user, so modules that care (the PTY,
 * anything that logs) can see it without every handler signature changing.
 */
async function dispatch(cmd, args, user = auth.SYSTEM_USER) {
  const fn = commands[cmd];
  if (!fn) throw new Error(`Unknown command: ${cmd}`);

  const denied = permissionDenied(user, cmd, args);
  if (denied) throw Object.assign(new Error(denied), { forbidden: true });

  return await fn(args || {}, { ...ctx, user });
}

/**
 * The error code to report alongside a message. CLI failures carry the code
 * the CLI sent (see server/cli.js CliError); anything else is generic.
 */
function errorCode(e) {
  if (e && typeof e.code === 'string' && e.code) return e.code;
  if (e && e.forbidden) return 'forbidden';
  return 'error';
}

const app = express();
app.disable('x-powered-by');
// The Upload button in the file manager hands write_server_file a plain byte
// ARRAY (app.js: `Array.from(new Uint8Array(buf))`), which inflates roughly 4×
// once JSON-encoded - so the body limit has to be several times the largest
// file anyone would push through that button. Drag-and-drop does not go through
// here; it streams raw into /api/upload-stage, which has its own 4gb ceiling.
app.use(express.json({ limit: '512mb' }));

// Optional shared-secret gate. Off by default (localhost-only bind); when a
// token is configured every API route and the WebSocket require it.
function tokenOk(req) {
  if (!ARGS.token) return true;
  const supplied = req.get('x-mcpanel-token')
    || (req.query && req.query.token)
    || (req.headers.cookie || '').match(/(?:^|;\s*)mcpanel_token=([^;]+)/)?.[1];
  return supplied === ARGS.token;
}

app.use((req, res, next) => {
  // Hand the token to the browser once so subsequent XHRs carry it in a cookie.
  if (ARGS.token && req.query && req.query.token === ARGS.token) {
    res.cookie
      ? res.cookie('mcpanel_token', ARGS.token, { httpOnly: false, sameSite: 'strict' })
      : res.setHeader('Set-Cookie', `mcpanel_token=${ARGS.token}; Path=/; SameSite=Strict`);
  }
  if (req.path.startsWith('/api/') && !tokenOk(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized', code: 'unauthorized' });
  }
  next();
});

// ─── Session resolution ──────────────────────────────────────────────────────
// Runs for every request so both the API gate and the static gate below can
// just read req.user.

app.use(async (req, res, next) => {
  req.cookies = auth.parseCookies(req.headers.cookie);
  req.sessionToken = auth.tokenFromRequest(req);
  try {
    req.user = req.sessionToken ? await auth.verify(req.sessionToken) : null;
  } catch {
    req.user = null;
  }
  next();
});

// ── Sign-in / sign-out (the only routes reachable without a session) ──
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const { token, expiresAt, user } = await auth.login(username, password, req);
    auth.setSessionCookie(res, req, token, expiresAt);
    res.json({ ok: true, user, expiresAt });
  } catch (e) {
    // A CLI/addon outage isn't a wrong password - report it as a server error
    // so the login page doesn't tell the user to retype their credentials.
    const status = e.rateLimited ? 429 : (e.authFailure ? 401 : 503);
    res.status(status).json({ ok: false, error: e.message, code: errorCode(e) });
  }
});

app.post('/api/logout', async (req, res) => {
  await auth.logout(req.sessionToken);
  auth.clearSessionCookie(res, req);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Not signed in', code: 'not_signed_in', authRequired: true });
  // `settings` carries only the install-wide switches a normal user needs to
  // render their own account panel - reading the full set requires
  // accounts.manage, which most users do not have.
  res.json({ ok: true, user: req.user, settings: await auth.publicSettings() });
});

app.post('/api/change-password', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Not signed in', code: 'not_signed_in', authRequired: true });
  const { currentPassword, newPassword } = req.body || {};
  try {
    await auth.changePassword(req.user.username, currentPassword, newPassword, req.sessionToken);
    // The addon revokes sessions on a password change, so the caller has to
    // sign in again - clear the cookie rather than leaving a dead one behind.
    auth.clearSessionCookie(res, req);
    res.json({ ok: true, reauth: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: errorCode(e) });
  }
});

// ─── API gate ────────────────────────────────────────────────────────────────
// Everything else under /api/ needs a session - except the handful of
// read-only theme lookups below.
//
// The sign-in page styles itself with the install's chosen theme, so it has to
// resolve that theme before anyone has signed in. These three commands read
// only a theme id and a stylesheet; they expose no server, file, account or
// system information, and the same CSS is already served as static files under
// /themes/. Gating them would mean every user sees stock Purple Dark at the
// login screen no matter what they picked.
const PREAUTH_COMMANDS = new Set(['get_default_theme', 'get_theme_css', 'get_themes']);

function isPreauthRequest(req) {
  if (req.method === 'GET' && req.path.startsWith('/theme-asset/')) return true;
  if (req.method === 'POST' && req.path === '/invoke') {
    return PREAUTH_COMMANDS.has(req.body && req.body.cmd);
  }
  return false;
}

app.use('/api', (req, res, next) => {
  if (req.user) return next();
  // `req.path` is relative to the '/api' mount point here.
  if (isPreauthRequest(req)) return next();
  res.status(401).json({ ok: false, error: 'Sign in to continue', code: 'not_signed_in', authRequired: true });
});

app.post('/api/invoke', async (req, res) => {
  const { cmd, args } = req.body || {};
  if (typeof cmd !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing cmd', code: 'invalid_arguments' });
  }
  try {
    // An anonymous caller only got past the gate above for a PREAUTH_COMMANDS
    // theme lookup. Hand dispatch a minimal system identity for exactly those,
    // so the permission layer keeps failing closed for everything else rather
    // than having to special-case a null user.
    const actor = req.user
      || (PREAUTH_COMMANDS.has(cmd) ? { username: '(anonymous)', system: true } : null);
    const value = await dispatch(cmd, args, actor);
    res.json({ ok: true, value: value === undefined ? null : value });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (e && e.forbidden) {
      return res.status(403).json({ ok: false, error: msg, code: 'forbidden', forbidden: true });
    }
    res.json({ ok: false, error: msg, code: errorCode(e) });
  }
});

// ── Theme assets ──
// theme.css files may reference their own bundled images/fonts with relative
// url(...). The Tauri build rewrote those to file:// paths; here they become
// this route so the browser can actually load them.
app.get('/api/theme-asset/:id/*', (req, res) => {
  const id = req.params.id;
  const rel = req.params[0] || '';
  if (id.includes('..') || id.includes('/') || rel.includes('..')) {
    return res.status(400).end();
  }
  const file = path.join(paths.themesDir(), id, rel);
  const root = path.join(paths.themesDir(), id) + path.sep;
  if (!path.resolve(file).startsWith(path.resolve(root))) return res.status(400).end();
  res.sendFile(path.resolve(file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ── Binary upload staging ──
// The browser can't hand us OS file paths on drag-drop the way Tauri could, so
// dropped/selected files are streamed here first; the response gives back real
// on-disk paths that upload_files_to_server / _to_profile then consume exactly
// as they consumed Tauri's dropped paths.
app.post('/api/upload-stage', express.raw({ type: '*/*', limit: '4gb' }), (req, res) => {
  try {
    const relRaw = req.get('x-file-path') || req.get('x-file-name') || '';
    const rel = decodeURIComponent(relRaw).replace(/\\/g, '/');
    if (!rel || rel.includes('..') || rel.startsWith('/')) {
      return res.status(400).json({ ok: false, error: 'Invalid file name' });
    }
    const batch = String(req.get('x-batch-id') || Date.now()).replace(/[^A-Za-z0-9_-]/g, '');
    const stageRoot = path.join(paths.uploadStageDir(), batch);
    const dest = path.join(stageRoot, rel);
    if (!path.resolve(dest).startsWith(path.resolve(stageRoot) + path.sep)) {
      return res.status(400).json({ ok: false, error: 'Invalid file name' });
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, req.body || Buffer.alloc(0));
    // The path handed back is the top-level entry of this batch, so a dropped
    // folder is uploaded as one directory rather than N loose files.
    const top = rel.split('/')[0];
    res.json({ ok: true, path: path.join(stageRoot, top), stageRoot });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/upload-stage/clear', (req, res) => {
  const batch = String((req.body && req.body.batch) || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (batch) {
    try { fs.rmSync(path.join(paths.uploadStageDir(), batch), { recursive: true, force: true }); }
    catch { /* ignore */ }
  }
  res.json({ ok: true });
});

// ─── Static gate ─────────────────────────────────────────────────────────────
// Signed out, a client gets the login page and the handful of assets that page
// needs - nothing more. The panel's own code (app.js, web-bridge.js, the
// accounts UI, index.html, lib/) stays unreadable until there is a session, so
// the application surface isn't published to anonymous visitors.

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Prefixes and exact files readable without signing in.
const ANON_PREFIXES = ['/fonts/', '/themes/', '/assets/'];
const ANON_FILES = new Set([
  '/login.html', '/login.js', '/login.css',
  '/style.css',
  '/favicon.ico',
]);

function anonAllowed(p) {
  if (ANON_FILES.has(p)) return true;
  return ANON_PREFIXES.some(prefix => p.startsWith(prefix));
}

// Served only if public/login.html is missing, so a half-deployed install still
// has a working way in rather than a blank 404.
const FALLBACK_LOGIN = `<!doctype html><meta charset="utf-8">
<title>MCPanel-WebUI - Sign in</title>
<style>body{font-family:system-ui,sans-serif;background:#16161c;color:#e8e8ef;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#1f1f28;padding:2rem;border-radius:10px;min-width:18rem}
h1{font-size:1.1rem;margin:0 0 1rem}input,button{width:100%;box-sizing:border-box;
padding:.6rem;margin-bottom:.6rem;border-radius:6px;border:1px solid #33333f;
background:#16161c;color:inherit}button{background:#7B2FBE;border:0;cursor:pointer}
p{color:#ff6b6b;min-height:1.2em;font-size:.85rem;margin:.4rem 0 0}</style>
<form id="f"><h1>MCPanel-WebUI</h1>
<input id="u" placeholder="Username" autocomplete="username" autofocus>
<input id="p" type="password" placeholder="Password" autocomplete="current-password">
<button>Sign in</button><p id="e"></p></form>
<script>f.onsubmit=async ev=>{ev.preventDefault();e.textContent='';
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({username:u.value,password:p.value})});
const d=await r.json().catch(()=>({}));
if(d.ok)location.href='/';else e.textContent=d.error||'Sign-in failed';};</script>`;

let warnedNoLoginPage = false;

function sendLoginPage(res) {
  const file = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  if (!warnedNoLoginPage) {
    warnedNoLoginPage = true;
    applog.warn('public/login.html is missing - serving the built-in fallback sign-in page');
  }
  res.type('html').send(FALLBACK_LOGIN);
}

app.use((req, res, next) => {
  if (req.user) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const p = req.path;
  if (p === '/' || p === '/index.html') return sendLoginPage(res);
  if (anonAllowed(p)) return next();

  res.status(401).type('text/plain').send('Sign in to continue');
});

// ── Static frontend ──
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.woff2')) res.setHeader('Cache-Control', 'public, max-age=604800');
  },
}));

const server = http.createServer(app);
state.httpServer = server;

// Tracked so a network-config rebind (state.applyNetworkConfig below) can
// force-close everything before re-listening. server.close()'s callback only
// fires once every open connection ends on its own, and a keep-alive HTTP
// connection or an open WebSocket would otherwise hang it indefinitely.
const openSockets = new Set();
server.on('connection', (socket) => {
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
});

const wss = new WebSocketServer({ noServer: true });

function rejectUpgrade(socket, status = '401 Unauthorized') {
  try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch {}
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  if (ARGS.token) {
    const supplied = url.searchParams.get('token')
      || (req.headers.cookie || '').match(/(?:^|;\s*)mcpanel_token=([^;]+)/)?.[1];
    if (supplied !== ARGS.token) { rejectUpgrade(socket); return; }
  }

  // An unauthenticated socket would receive every server-log line broadcast on
  // the event bus, so the session is checked before the handshake completes.
  let user = null;
  try {
    user = await auth.verify(auth.tokenFromRequest(req));
  } catch { user = null; }
  if (!user) { rejectUpgrade(socket); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.mcpanelUser = user;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const sink = (frame) => { if (ws.readyState === ws.OPEN) ws.send(frame); };
  const removeSink = events.addSink(sink);
  ws.mcpanelSink = sink;

  ws.on('message', async (raw) => {
    // The only client→server WebSocket traffic is PTY I/O; everything else is
    // a plain HTTP RPC. Keeping the terminal on the socket avoids a round-trip
    // per keystroke.
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.cmd !== 'string') return;
    try {
      // Same permission gate as the HTTP path - terminal.access is checked here.
      await dispatch(msg.cmd, { ...(msg.args || {}), __ws: ws }, ws.mcpanelUser);
    } catch (e) {
      applog.error(`ws ${msg.cmd}: ${e.message}`);
      if (e && e.forbidden) events.emitTo(sink, 'pty-closed', null);
    }
  });

  ws.on('close', () => {
    removeSink();
    const session = state.ptySessions.get(ws);
    if (session) { try { session.kill(); } catch {} state.ptySessions.delete(ws); }
  });
});

applog.init(pkg.version);
loadCommandModules();

// The Tauri app spawned run_scheduler() at startup; same deal here. Boot-time
// work runs as the system identity, which bypasses the permission gate.
const SYSTEM_CTX = { ...ctx, user: auth.SYSTEM_USER };

if (typeof commands.__start_scheduler === 'function') {
  commands.__start_scheduler({}, SYSTEM_CTX);
}

// Builtin themes are written on first launch so the four stock themes exist
// even before the frontend calls ensure_builtin_themes().
if (typeof commands.ensure_builtin_themes === 'function') {
  Promise.resolve(commands.ensure_builtin_themes({}, SYSTEM_CTX)).catch(() => {});
}

// Prints every URL other devices can reach the panel on - just `localhost`
// when bound to a specific address, plus each LAN IPv4 address when bound to
// the wildcard (0.0.0.0/::). Called on initial startup and again after a
// live network-config rebind (state.applyNetworkConfig below).
function printListeningBanner() {
  const tokenPart = ARGS.token ? `?token=${ARGS.token}` : '';
  const wildcard = ARGS.host === '0.0.0.0' || ARGS.host === '::';
  const urls = [`http://${wildcard ? 'localhost' : ARGS.host}:${ARGS.port}/${tokenPart}`];
  if (wildcard) {
    for (const { address } of util.lanAddresses()) {
      urls.push(`http://${address}:${ARGS.port}/${tokenPart}   (LAN)`);
    }
  }
  process.stdout.write(`\n  MCPanel WebUI v${pkg.version}\n` +
    urls.map(u => `  →  ${u}`).join('\n') + '\n\n');
  applog.info(`WebUI listening on ${ARGS.host}:${ARGS.port}`);
}

state.networkInfo = () => ({ host: ARGS.host, port: ARGS.port });

// Rebinds the same http.Server / express app / WebSocketServer to a new
// host/port without restarting the process, so a port change from the
// Settings page takes effect immediately. Drops every open connection
// (including the caller's own) - unavoidable, since the listening socket
// itself is moving. Rejects on listen errors (e.g. port already in use)
// rather than crashing the process.
let rebindInProgress = false;
state.applyNetworkConfig = ({ host, port }) => {
  if (rebindInProgress) {
    return Promise.reject(new Error('A network config change is already in progress.'));
  }
  rebindInProgress = true;

  return new Promise((resolve, reject) => {
    const settle = (err) => {
      rebindInProgress = false;
      if (err) reject(err); else resolve({ host, port });
    };

    for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
    for (const socket of openSockets) { try { socket.destroy(); } catch { /* ignore */ } }
    openSockets.clear();

    server.close((closeErr) => {
      if (closeErr) { settle(closeErr); return; }

      const onError = (err) => {
        server.removeListener('listening', onListening);
        settle(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        ARGS.host = host;
        ARGS.port = port;
        printListeningBanner();
        settle();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  });
};

server.listen(ARGS.port, ARGS.host, async () => {
  printListeningBanner();

  if (!permissions) {
    process.stdout.write('  ⚠  server/permissions.js failed to load - every non-admin request\n' +
                         '     will be refused until it does.\n\n');
  }

  // Seed the account store so a fresh install can actually be signed into.
  const seeded = await auth.ensureSeeded();
  if (seeded && seeded.error) {
    process.stdout.write(`  ⚠  ${seeded.error}\n\n`);
  }

  // Permission descriptions for "you can't do that" messages come from the
  // addon itself; refreshed periodically so an addon upgrade is picked up.
  if (permissions && typeof permissions.loadCatalog === 'function') {
    await permissions.loadCatalog(cli.runCliJson);
    const t = setInterval(() => { permissions.loadCatalog(cli.runCliJson); }, 10 * 60 * 1000);
    if (t.unref) t.unref();
  }

  // The old warning was about --token. Now that sign-in is mandatory, the real
  // exposure is an install still sitting on the seeded admin/admin password.
  const stillDefault = await auth.defaultAdminPasswordInUse();
  if (stillDefault) {
    process.stdout.write('  ⚠  The "admin" account is still using the default password (admin).\n' +
                         '     Sign in and change it before exposing this panel.\n\n');
    applog.warn('Default admin password is still in use');
  }
});

function shutdown() {
  applog.info('WebUI shutting down');
  for (const [, s] of state.logStreamers) { try { s.stop(); } catch {} }
  if (state.activeBackup) {
    try { state.activeBackup.child.kill('SIGKILL'); } catch {}
    if (state.activeBackup.zipPath) {
      try { fs.rmSync(state.activeBackup.zipPath, { force: true }); } catch {}
    }
  }
  try { fs.rmSync(paths.uploadStageDir(), { recursive: true, force: true }); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, dispatch, commands, ctx, state, ARGS };

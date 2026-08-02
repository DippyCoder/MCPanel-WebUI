/* ═══════════════════════════════════════════════════════════════════════════
   Embedded PTY terminal - port of src-tauri/src/commands.rs lines 1907-1981.

   The Tauri build owned exactly one shell and emitted `pty-data` / `pty-closed`
   app-wide, because there was only ever one window. A WebUI can have several
   browsers attached at once, so here a session is keyed by the WebSocket that
   opened it and its output goes back over that socket alone - broadcasting a
   shell to every open tab would hand one viewer another viewer's keystrokes.

   `server/index.js` routes these four commands off the socket (it injects the
   originating ws as `args.__ws`) rather than over HTTP, so a keystroke costs a
   frame instead of a request.

   ── PTY backends, in preference order ──────────────────────────────────────
   node-pty is a native module that needs a compiler at install time, so it is
   an optionalDependency and may simply not be there. Each fallback below still
   allocates a REAL pty - colours, line editing, and full-screen programs all
   keep working; only the ability to resize degrades.

     1. node-pty            real pty, real resize
     2. script(1)           real pty, no resize   (util-linux / BSD)
     3. python3 pty helper  real pty, real resize (stdlib only)
     4. piped child         no pty                (last resort)

   Tier 3 exists because current Fedora releases split `script` out into the
   `util-linux-script` subpackage, which is not installed by default - without
   it a stock Fedora host with no node-pty would drop all the way to tier 4.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const paths = require('../paths');
const applog = require('../applog');

let nodePty = null;
try {
  nodePty = require('node-pty');
} catch {
  nodePty = null; // optionalDependency; the tiers below cover its absence
}

function hasBinary(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}

const IS_WINDOWS = process.platform === 'win32';

const BACKEND = nodePty ? 'node-pty'
  : IS_WINDOWS ? 'pipe'
  : hasBinary('script') ? 'script'
  : hasBinary('python3') ? 'python'
  : 'pipe';

applog.info(`pty: using the ${BACKEND} backend`
  + (BACKEND === 'pipe' ? ' (no pty available - terminal will be degraded)' : ''));

/** Matches the Rust's bare `bash`, but degrades rather than failing outright. */
function resolveShell() {
  if (IS_WINDOWS) {
    return hasBinary('powershell.exe') ? 'powershell.exe' : 'cmd.exe';
  }
  if (hasBinary('bash')) return 'bash';
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  return 'sh';
}

function ptyEnv() {
  const env = { ...process.env };
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (!IS_WINDOWS) {
    const home = os.homedir();
    const extra = `${home}/.local/bin:${home}/.local/pipx/bin:/usr/local/bin`;
    env.PATH = `${extra}:${env.PATH || ''}`;
  }
  // A bundled Python exports these pointing inside its own tree, which breaks
  // the system-installed mcpanel CLI when it is run from this shell.
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return env;
}

function ptyCwd() {
  const dir = paths.home();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return dir;
}

// Runs the shell under a stdlib pty and relays it over our pipes. Window-size
// changes arrive as `R <rows> <cols>` lines on fd 3, which is why this needs a
// fourth stdio pipe - there is no other out-of-band channel once fd 0/1 are
// carrying terminal bytes.
const PY_RELAY = `
import os, pty, sys, select, fcntl, termios, struct

shell = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(shell, [shell])
    except Exception:
        os._exit(127)

def resize(rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except Exception:
        pass

resize(24, 80)
ctl, buf = 3, b''
while True:
    try:
        r, _, _ = select.select([0, fd, ctl], [], [])
    except Exception:
        break
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(fd, data)
    if ctl in r:
        try:
            chunk = os.read(ctl, 4096)
        except OSError:
            chunk = b''
        if chunk:
            buf += chunk
            while b'\\n' in buf:
                line, buf = buf.split(b'\\n', 1)
                parts = line.split()
                if len(parts) == 3 and parts[0] == b'R':
                    try:
                        resize(int(parts[1]), int(parts[2]))
                    except Exception:
                        pass
try:
    os.close(fd)
except Exception:
    pass
`;

/**
 * Every backend is wrapped in the same shape so the command handlers - and
 * index.js's disconnect cleanup, which calls session.kill() - stay uniform:
 *   { backend, write(data), resize(rows, cols), kill() }
 */
function createSession(onData, onExit) {
  const shell = resolveShell();
  const env = ptyEnv();
  const cwd = ptyCwd();

  if (BACKEND === 'node-pty') {
    const term = nodePty.spawn(shell, [], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd, env,
    });
    term.onData(onData);
    term.onExit(() => onExit());
    return {
      backend: 'node-pty',
      write: (d) => term.write(d),
      resize: (rows, cols) => { try { term.resize(cols, rows); } catch { /* torn down */ } },
      kill: () => { try { term.kill(); } catch { /* already gone */ } },
    };
  }

  let child;
  let controlPipe = null;

  if (BACKEND === 'script') {
    // -q silences the transcript banner, -f flushes after every write so output
    // is not held back by a block buffer, -e propagates the shell's exit code.
    const args = process.platform === 'darwin'
      ? ['-q', '/dev/null', shell]
      : ['-qfec', shell, '/dev/null'];
    child = spawn('script', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } else if (BACKEND === 'python') {
    child = spawn('python3', ['-c', PY_RELAY, shell], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    controlPipe = child.stdio[3] || null;
  } else {
    child = spawn(shell, [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  // A pty hands back raw bytes, and a multi-byte character can straddle two
  // chunks - decoding per-chunk would emit replacement characters mid-glyph.
  const decoder = new StringDecoder('utf8');
  const forward = (buf) => { const s = decoder.write(buf); if (s) onData(s); };
  child.stdout.on('data', forward);
  if (child.stderr) child.stderr.on('data', forward);

  let exited = false;
  const finish = () => { if (!exited) { exited = true; onExit(); } };
  child.on('exit', finish);
  child.on('error', (e) => { onData(`\r\n\x1b[31m[${e.message}]\x1b[0m\r\n`); finish(); });

  return {
    backend: BACKEND,
    write: (d) => { try { child.stdin.write(d); } catch { /* closed */ } },
    resize: (rows, cols) => {
      if (!controlPipe) return; // script(1) and raw pipes have no resize channel
      try { controlPipe.write(`R ${rows} ${cols}\n`); } catch { /* closed */ }
    },
    kill: () => { try { child.kill('SIGHUP'); } catch { /* already gone */ } },
  };
}

function socketOf(args) {
  const ws = args && args.__ws;
  if (!ws || typeof ws.mcpanelSink !== 'function') {
    throw new Error('The embedded terminal is only available over the WebSocket connection');
  }
  return ws;
}

function closeFor(ctx, ws) {
  const existing = ctx.state.ptySessions.get(ws);
  if (!existing) return;
  ctx.state.ptySessions.delete(ws);
  try { existing.kill(); } catch { /* already gone */ }
}

module.exports = {
  pty_open: async (args, ctx) => {
    const ws = socketOf(args);
    closeFor(ctx, ws);

    const sink = ws.mcpanelSink;
    let session;
    session = createSession(
      (data) => ctx.emitTo(sink, 'pty-data', data),
      () => {
        // Only retract the map entry if it is still ours - a fast reopen may
        // already have replaced it.
        if (ctx.state.ptySessions.get(ws) === session) ctx.state.ptySessions.delete(ws);
        ctx.emitTo(sink, 'pty-closed', null);
      },
    );
    ctx.state.ptySessions.set(ws, session);
    return null;
  },

  pty_write: async (args, ctx) => {
    const session = ctx.state.ptySessions.get(args && args.__ws);
    if (session) session.write(String(args.data ?? ''));
    return null;
  },

  pty_resize: async (args, ctx) => {
    const session = ctx.state.ptySessions.get(args && args.__ws);
    if (session) session.resize(Number(args.rows) || 24, Number(args.cols) || 80);
    return null;
  },

  pty_close: async (args, ctx) => {
    const ws = args && args.__ws;
    if (ws) closeFor(ctx, ws);
    return null;
  },
};

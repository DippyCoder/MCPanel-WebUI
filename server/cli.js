/* ═══════════════════════════════════════════════════════════════════════════
   MCPanel-CLI runner - port of the CLI-resolution + `run_cli` / `check_cli`
   half of src-tauri/src/commands.rs.

   Every stateful operation in MCPanel goes through the `mcpanel` Python CLI
   (`mcpanel api <...>`), which prints a single JSON document on stdout. This
   module owns finding that executable and shelling out to it.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const applog = require('./applog');

const EXE = process.platform === 'win32' ? 'mcpanel.exe' : 'mcpanel';

// On Windows, pip --user installs to %APPDATA%\Python\Python3XX\Scripts\ which
// is not on PATH by default. Enumerate the common locations so mcpanel is
// always found regardless of whether the user updated their PATH.
function windowsPythonScriptsPaths() {
  const appdata = process.env.APPDATA || '';
  const localappdata = process.env.LOCALAPPDATA || '';
  const out = [];
  for (let minor = 14; minor >= 8; minor--) {
    const candidates = [
      appdata && path.join(appdata, 'Python', `Python3${minor}`, 'Scripts'),
      localappdata && path.join(localappdata, 'Programs', 'Python', `Python3${minor}`, 'Scripts'),
    ].filter(Boolean);
    for (const p of candidates) if (fs.existsSync(p)) out.push(p);
  }
  return out.join(';');
}

// True only if `p` is a Python console-script: a small text file whose first
// line is a `#!` shebang invoking python. Compiled binaries (the MCPanel Tauri
// GUI ships an ELF/Mach-O also named `mcpanel`) are rejected, which is what
// stops us ever launching the GUI as if it were the CLI.
function looksLikePythonCli(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(128);
    const n = fs.readSync(fd, buf, 0, 128, 0);
    const head = buf.subarray(0, n);
    if (!(head[0] === 0x23 && head[1] === 0x21)) return false; // "#!"
    const firstLine = head.toString('utf8').split('\n')[0];
    return firstLine.toLowerCase().includes('python');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Locate the mcpanel-cli executable by checking the filesystem locations where
// `pip --user` / `pipx` install it on each OS - WITHOUT executing anything.
// User-install locations are checked first so a pip/pipx install always wins
// over anything in /usr/bin (which on Linux may be the MCPanel GUI binary).
function findCliPath() {
  const candidates = [];

  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || '';
    const localappdata = process.env.LOCALAPPDATA || '';
    const userprofile = process.env.USERPROFILE || '';
    for (let minor = 14; minor >= 8; minor--) {
      if (appdata) candidates.push(path.join(appdata, 'Python', `Python3${minor}`, 'Scripts', EXE));
      if (localappdata) candidates.push(path.join(localappdata, 'Programs', 'Python', `Python3${minor}`, 'Scripts', EXE));
    }
    if (userprofile) candidates.push(path.join(userprofile, '.local', 'bin', EXE)); // pipx
  } else {
    const home = os.homedir();
    if (home) {
      candidates.push(path.join(home, '.local', 'bin', EXE));       // pip --user (Linux)
      candidates.push(path.join(home, '.local', 'pipx', 'bin', EXE)); // pipx
      if (process.platform === 'darwin') {
        for (let minor = 14; minor >= 8; minor--) {
          candidates.push(path.join(home, 'Library', 'Python', `3.${minor}`, 'bin', EXE));
        }
      }
    }
    candidates.push(`/usr/local/bin/${EXE}`);
    if (process.platform === 'darwin') candidates.push(`/opt/homebrew/bin/${EXE}`);
    candidates.push(`/usr/bin/${EXE}`);
  }

  for (const cand of candidates) {
    let st;
    try { st = fs.statSync(cand); } catch { continue; }
    if (!st.isFile()) continue;
    // A system .deb/.rpm install puts the *GUI* binary in /usr/bin, so a
    // matching path is NOT proof we found the CLI. On Unix, positively confirm
    // the candidate is the Python console script.
    if (process.platform !== 'win32' && !looksLikePythonCli(cand)) continue;
    return cand;
  }
  return null;
}

function cliProgram() {
  return findCliPath() || 'mcpanel';
}

// AppImage launchers and some desktop environments strip ~/.local/bin from
// PATH. Prepend the common user-install locations so `mcpanel` is always found.
function cliEnv() {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    const extra = windowsPythonScriptsPaths();
    if (extra) env.PATH = `${extra};${env.PATH || ''}`;
  } else {
    const home = os.homedir();
    const extra = `${home}/.local/bin:${home}/.local/pipx/bin:/usr/local/bin`;
    env.PATH = `${extra}:${env.PATH || ''}`;
  }
  // A bundled Python (AppImage etc.) exports PYTHONHOME/PYTHONPATH pointing
  // inside its own tree, which breaks the system-installed mcpanel CLI.
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return env;
}

/**
 * Runs `mcpanel <argv...>` and resolves { code, stdout, stderr }.
 * Never rejects on a non-zero exit - callers decide what that means.
 */
function execMcpanel(argv, opts = {}) {
  return new Promise((resolve) => {
    execFile(cliProgram(), argv, {
      env: cliEnv(),
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeout || 0,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        spawnError: err && err.code === 'ENOENT' ? err : null,
      });
    });
  });
}

/**
 * Runs `mcpanel <argv...>` with `input` written to its stdin, resolving
 * { code, stdout, stderr }.
 *
 * Exists so secrets never travel as command-line arguments: argv is visible in
 * `ps` to every other user on the host for as long as the process lives, and
 * the panel shells out to `accounts login` on every sign-in. The accounts
 * addon's `--password-stdin` reads the pipe this fills.
 */
function execMcpanelWithInput(argv, input) {
  return new Promise((resolve) => {
    const child = spawn(cliProgram(), argv, {
      env: cliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message, spawnError: err });
    });
    child.on('close', (code) => {
      resolve({ code: code === null ? 1 : code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    // EPIPE here just means the child exited before reading; the close handler
    // still reports the real failure, so swallowing it avoids a bogus crash.
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? '' : String(input));
  });
}

async function runCliJsonWithInput(args, input) {
  const argv = ['api', ...args];
  const { stdout, stderr, code } = await execMcpanelWithInput(argv, input);
  if (!stdout && code !== 0) throw new Error(stderr || `mcpanel exited with code ${code}`);
  return JSON.parse(stdout);
}

/** Spawns `mcpanel <argv...>` with piped stdout - for streaming subcommands. */
function spawnMcpanel(argv) {
  return spawn(cliProgram(), argv, {
    env: cliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * `run_cli` - prefixes `api`, runs, and returns the raw stdout string.
 * Throws the CLI's stderr when it fails with no stdout, matching the Rust
 * command's Result<String, String> contract.
 */
async function runCli(args) {
  const argv = ['api', ...args];
  // Status/file-tree polling happens every few seconds per server and is noise
  // when it's succeeding - only worth a log line when it fails.
  const isFetch = argv[1] === 'fetch';
  if (!isFetch) applog.info(`run_cli: mcpanel ${argv.join(' ')}`);

  const { stdout, stderr, code } = await execMcpanel(argv);
  if (!stdout && code !== 0) {
    if (isFetch) applog.error(`run_cli: mcpanel ${argv.join(' ')} failed: ${stderr}`);
    else applog.error(`  error: ${stderr}`);
    throw new Error(stderr || `mcpanel exited with code ${code}`);
  }
  if (!isFetch) applog.info(`  ok (${stdout.length} bytes)`);
  return stdout;
}

/** `run_cli` + JSON.parse, the shape most callers actually want. */
async function runCliJson(args) {
  return JSON.parse(await runCli(args));
}

/**
 * `check_cli` - existence check first (no process spawned), then a best-effort
 * `api version` read to enrich the result for the UI.
 */
async function checkCli() {
  const cliPath = findCliPath();
  if (!cliPath) {
    applog.warn('check_cli: MCPanel-CLI not found on this system');
    return {
      ok: false,
      error: 'mcpanel CLI not found. Install it from https://github.com/DippyCoder/mcpanel-cli',
    };
  }
  applog.info(`check_cli: found CLI at ${cliPath}`);

  const result = { ok: true };
  const { stdout, code } = await execMcpanel(['api', 'version'], { timeout: 3000 });
  if (code === 0 && stdout) {
    try {
      const v = JSON.parse(stdout).version;
      if (v) {
        applog.noteCliVersion(v);
        result.version = v;
      }
    } catch { /* best-effort */ }
  }
  return result;
}

module.exports = {
  findCliPath,
  cliProgram,
  cliEnv,
  execMcpanel,
  execMcpanelWithInput,
  spawnMcpanel,
  runCli,
  runCliJson,
  runCliJsonWithInput,
  checkCli,
};

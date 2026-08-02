/* ═══════════════════════════════════════════════════════════════════════════
   MCPanel's own diagnostic log - a port of src-tauri/src/app_log.rs.

   Distinct from per-server console logs (those live under run/<id>.log.jsonl
   and are shown in the Console tab). This is MCPanel-the-app's own record of
   what it did - CLI invocations, install steps, errors - kept in its own
   `logs/` folder so it never gets confused with a Minecraft server's output.

   Rotation:
     - a fresh `latest.log` starts on every app launch
     - `latest.log` rotates to a timestamped file when it crosses 10,000 lines
       or when the local calendar day changes
     - oldest rotated files are deleted once the configured file count (see
       `app-settings.json`'s `maxLogFiles`, default 10) is exceeded

   Near-duplicate lines that repeat within a short window (e.g. the same
   "fetch status" line for many server ids in a row) are bundled into one
   summarized line instead of flooding the file.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const paths = require('./paths');

const MAX_LINES_PER_FILE = 10000;
const BUNDLE_WINDOW_MS = 5000;
const DEFAULT_MAX_FILES = 10;

let fileState = null;   // { date, lineCount }
let pending = null;     // { level, template, tokens, count, firstSeen }

const logsDir = () => paths.logsDir();
const latestPath = () => path.join(logsDir(), 'latest.log');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timestamp() {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function tzOffset() {
  const mins = -new Date().getTimezoneOffset();
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function osLabel() {
  if (process.platform === 'linux') {
    try {
      const content = fs.readFileSync('/etc/os-release', 'utf8');
      let id = null, versionId = null;
      for (const line of content.split('\n')) {
        if (line.startsWith('ID=')) id = line.slice(3).replace(/^"|"$/g, '');
        else if (line.startsWith('VERSION_ID=')) versionId = line.slice(11).replace(/^"|"$/g, '');
      }
      if (id) return versionId ? `${id} ${versionId} / linux` : `${id} / linux`;
    } catch {}
    return 'linux';
  }
  return process.platform;
}

/** Call once at startup, before anything else logs. */
function init(appVersion) {
  try { fs.mkdirSync(logsDir(), { recursive: true }); } catch {}

  // A previous run's latest.log (if the process crashed or was killed without
  // a clean rotation) becomes an archived file so this run starts fresh.
  rotateIfNonEmpty();
  pruneOldFiles();
  fileState = { date: today(), lineCount: 0 };

  writeLine('INFO', '== MCPanel WebUI starting ==');
  writeLine('INFO', `Version: ${appVersion}`);
  writeLine('INFO', `OS: ${osLabel()} (${os.arch()})`);
  writeLine('INFO', `Node: ${process.version}`);
  writeLine('INFO', `Timezone: UTC${tzOffset()}`);
  writeLine('INFO', `Started: ${timestamp()}`);

  // Background tick: flushes a bundled group once it's been open 5s even if
  // nothing new arrives to trigger that flush, and rotates the file at
  // midnight even if the app is otherwise idle.
  const t = setInterval(() => {
    flushPendingIfStale();
    rotateIfNewDay();
  }, 2000);
  if (t.unref) t.unref();
}

const info  = (msg) => submit('INFO', String(msg));
const warn  = (msg) => submit('WARN', String(msg));
const error = (msg) => submit('ERROR', String(msg));

function noteCliVersion(version) {
  writeLine('INFO', `MCPanel-CLI version: ${version}`);
}

// Splits "run_cli: mcpanel fetch status -id abc123" into
// ("run_cli: mcpanel fetch status -id {}", "abc123") so repeats that only
// differ by that trailing token can be bundled into one line.
function normalize(msg) {
  const idx = msg.indexOf('-id ');
  if (idx !== -1) {
    const after = idx + 4;
    const rest = msg.slice(after);
    const sp = rest.indexOf(' ');
    const tokenLen = sp === -1 ? rest.length : sp;
    const token = rest.slice(0, tokenLen);
    if (token) {
      return [msg.slice(0, after) + '{}' + rest.slice(tokenLen), token];
    }
  }
  return [msg, null];
}

function submit(level, msg) {
  const [template, token] = normalize(msg);

  if (pending) {
    if (pending.level === level && pending.template === template &&
        Date.now() - pending.firstSeen < BUNDLE_WINDOW_MS) {
      pending.count += 1;
      if (token && !pending.tokens.includes(token)) pending.tokens.push(token);
      return;
    }
    const finished = pending;
    pending = null;
    flush(finished);
  }

  pending = {
    level,
    template,
    tokens: token ? [token] : [],
    count: 1,
    firstSeen: Date.now(),
  };
}

function flushPendingIfStale() {
  if (!pending) return;
  if (Date.now() - pending.firstSeen < BUNDLE_WINDOW_MS) return;
  const finished = pending;
  pending = null;
  flush(finished);
}

function flush(p) {
  let line;
  if (p.count <= 1) {
    line = p.template.replace('{}', p.tokens[0] || '');
  } else {
    const MAX_SHOWN = 8;
    const shown = p.tokens.slice(0, MAX_SHOWN);
    let ids = shown.join(', ');
    if (p.tokens.length > MAX_SHOWN) ids += `, …+${p.tokens.length - MAX_SHOWN} more`;
    line = `${p.template.replace('{}', `[${ids}]`)} (×${p.count})`;
  }
  writeLine(p.level, line);
}

function writeLine(level, msg) {
  if (!fileState) {
    // init() hasn't run - best-effort direct write.
    try {
      fs.mkdirSync(logsDir(), { recursive: true });
      fs.appendFileSync(latestPath(), `[${timestamp()}] [${level}] ${msg}\n`);
    } catch {}
    return;
  }

  if (fileState.date !== today()) rotate();
  if (fileState.lineCount >= MAX_LINES_PER_FILE) rotate();

  try {
    fs.appendFileSync(latestPath(), `[${timestamp()}] [${level}] ${msg}\n`);
    fileState.lineCount += 1;
  } catch {}
}

function rotateIfNewDay() {
  if (fileState && fileState.date !== today()) rotate();
}

// Renames the current latest.log to a timestamped archive name and starts a
// fresh, empty latest.log. Safe to call when latest.log doesn't exist yet.
function rotate() {
  rotateIfNonEmpty();
  pruneOldFiles();
  fileState = { date: today(), lineCount: 0 };
}

function rotateIfNonEmpty() {
  const p = latestPath();
  let meta;
  try { meta = fs.statSync(p); } catch { return; }
  if (meta.size === 0) return;

  const d = new Date();
  const base = `${today()}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  let archive = path.join(logsDir(), `${base}.log`);
  let n = 1;
  while (fs.existsSync(archive)) {
    archive = path.join(logsDir(), `${base}-${n}.log`);
    n += 1;
  }
  try { fs.renameSync(p, archive); } catch {}
}

function maxFilesSetting() {
  try {
    const v = JSON.parse(fs.readFileSync(paths.appSettingsPath(), 'utf8'));
    const n = v && v.maxLogFiles;
    if (typeof n === 'number' && n >= 1) return Math.floor(n);
  } catch {}
  return DEFAULT_MAX_FILES;
}

function pruneOldFiles() {
  const dir = logsDir();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }

  // timestamp-prefixed names sort chronologically
  const archived = entries.filter(n => n !== 'latest.log' && n.endsWith('.log')).sort();

  const maxTotal = Math.max(1, maxFilesSetting());
  const archiveLimit = Math.max(0, maxTotal - 1); // latest.log takes one slot
  if (archived.length > archiveLimit) {
    for (const name of archived.slice(0, archived.length - archiveLimit)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
    }
  }
}

module.exports = { init, info, warn, error, noteCliVersion, logsDir };

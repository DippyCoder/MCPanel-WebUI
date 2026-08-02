/* ═══════════════════════════════════════════════════════════════════════════
   System stats, fonts, app settings and host-side "open this" actions -
   a port of the corresponding commands in src-tauri/src/commands.rs.

   The WebUI's backend runs on the same machine the Tauri app would have, so
   open_external / open_path / open_terminal stay host-side actions rather
   than browser ones: they act on the box that actually hosts the servers.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const paths = require('../paths');
const applog = require('../applog');
const cli = require('../cli');

/** Runs a command and resolves its trimmed stdout, or null on any failure. */
function runOut(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: opts.timeout || 5000,
      maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      resolve(String(stdout || '').trim());
    });
  });
}

/**
 * Spawns a detached child and resolves true once the OS confirms the exec.
 * Node reports a missing binary asynchronously via the 'error' event, so the
 * Rust's synchronous `cmd.spawn().is_ok()` becomes a promise here.
 */
function trySpawn(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      return resolve(false);
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      // Detach so the opened window/terminal outlives this server process.
      try { child.unref(); } catch { /* ignore */ }
      resolve(true);
    });
  });
}

// Hardware identity (name, core counts, max clock) never changes while the
// process is alive, but the stats panel polls every couple of seconds. The
// Rust re-ran sysctl/wmic on every call; caching the static half keeps the
// poll from spawning subprocesses forever. The dynamic half - RAM in use,
// load average - is still read fresh each time.
let staticCpuCache = null;

// Cache previous CPU times between polls so we can compute a delta without
// sleeping. First call returns 0% (no previous sample); subsequent ones are
// accurate. Windows only, matching the Rust.
let cpuPrev = null;

function statsLinux() {
  let totalRam = 0;
  let availRam = 0;

  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    for (const line of meminfo.split('\n')) {
      if (line.startsWith('MemTotal:')) {
        const kb = parseInt(line.split(/\s+/)[1], 10);
        if (Number.isFinite(kb)) totalRam = kb * 1024;
      } else if (line.startsWith('MemAvailable:')) {
        const kb = parseInt(line.split(/\s+/)[1], 10);
        if (Number.isFinite(kb)) availRam = kb * 1024;
      }
    }
  } catch { /* leave at 0 */ }

  let load1m = 0;
  try {
    const v = parseFloat(fs.readFileSync('/proc/loadavg', 'utf8').split(/\s+/)[0]);
    if (Number.isFinite(v)) load1m = v;
  } catch { /* leave at 0 */ }

  let cpuinfo = '';
  try { cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8'); } catch { /* empty */ }
  const lines = cpuinfo.split('\n');

  const modelLine = lines.find(l => l.startsWith('model name'));
  const cpuName = modelLine ? modelLine.split(':').slice(1).join(':').trim() : 'Unknown CPU';

  const cpuThreads = Math.max(1, lines.filter(l => l.startsWith('processor')).length);

  const coresLine = lines.find(l => l.startsWith('cpu cores'));
  const parsedCores = coresLine ? parseInt(coresLine.split(':')[1], 10) : NaN;
  const coresPerSocket = Number.isFinite(parsedCores) ? parsedCores : cpuThreads;

  const physIds = new Set(
    lines.filter(l => l.startsWith('physical id'))
         .map(l => l.split(':')[1].trim())
  );
  const cpuCores = coresPerSocket * Math.max(1, physIds.size);

  const cpuPct = Math.min(100, Math.round((load1m / cpuThreads) * 1000) / 10);

  let cpuFreqMhz = 0;
  try {
    const khz = parseInt(
      fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', 'utf8').trim(), 10);
    if (Number.isFinite(khz)) cpuFreqMhz = khz / 1000;
  } catch { /* leave at 0 */ }

  return {
    totalRam,
    availRam,
    usedRam: Math.max(0, totalRam - availRam),
    cpuPct,
    loadAvg: load1m,
    cpuName,
    cpuCores,
    cpuThreads,
    cpuFreqMhz,
  };
}

async function statsMacos() {
  if (!staticCpuCache) {
    const [memsize, pagesize, logical, brand, physical, freqHz] = await Promise.all([
      runOut('sysctl', ['-n', 'hw.memsize']),
      runOut('sysctl', ['-n', 'hw.pagesize']),
      runOut('sysctl', ['-n', 'hw.logicalcpu']),
      runOut('sysctl', ['-n', 'machdep.cpu.brand_string']),
      runOut('sysctl', ['-n', 'hw.physicalcpu']),
      runOut('sysctl', ['-n', 'hw.cpufrequency_max']),
    ]);
    const num = (s, fallback) => {
      const n = Number(s);
      return Number.isFinite(n) && s !== null ? n : fallback;
    };
    staticCpuCache = {
      totalRam: num(memsize, 0),
      pageSize: num(pagesize, 4096),
      cpuThreads: num(logical, 1),
      cpuName: brand || 'Unknown CPU',
      cpuCores: num(physical, 1),
      cpuFreqMhz: num(freqHz, 0) / 1000000,
    };
  }
  const c = staticCpuCache;

  // Available RAM = (free + inactive + speculative) pages × page size
  let availRam = 0;
  const vm = await runOut('vm_stat', []);
  if (vm) {
    let free = 0, inactive = 0, speculative = 0;
    for (const line of vm.split('\n')) {
      const val = () => {
        const part = line.split(':')[1];
        if (part === undefined) return 0;
        const n = parseInt(part.trim().replace(/\.$/, ''), 10);
        return Number.isFinite(n) ? n : 0;
      };
      if (line.startsWith('Pages free:')) free = val();
      if (line.startsWith('Pages inactive:')) inactive = val();
      if (line.startsWith('Pages speculative:')) speculative = val();
    }
    availRam = (free + inactive + speculative) * c.pageSize;
  }

  // Output looks like "{ 0.42 0.38 0.31 }" - the 1-minute figure is token 1.
  let load1m = 0;
  const la = await runOut('sysctl', ['-n', 'vm.loadavg']);
  if (la) {
    const v = parseFloat(la.split(/\s+/)[1]);
    if (Number.isFinite(v)) load1m = v;
  }

  const cpuPct = Math.round(Math.min(100, (load1m / (c.cpuThreads || 1)) * 100));

  return {
    totalRam: c.totalRam,
    availRam,
    usedRam: Math.max(0, c.totalRam - availRam),
    cpuPct,
    loadAvg: load1m,
    cpuName: c.cpuName,
    cpuCores: c.cpuCores,
    cpuThreads: c.cpuThreads,
    cpuFreqMhz: c.cpuFreqMhz,
  };
}

async function statsWindows() {
  const totalRam = os.totalmem();
  const availRam = os.freemem();

  // CPU delta across successive calls, summed over all logical processors.
  const cpus = os.cpus() || [];
  let idleNow = 0;
  let totalNow = 0;
  for (const c of cpus) {
    const t = c.times;
    idleNow += t.idle;
    totalNow += t.user + t.nice + t.sys + t.idle + t.irq;
  }

  let cpuPct = 0;
  if (cpuPrev) {
    const dIdle = Math.max(0, idleNow - cpuPrev.idle);
    const dTotal = Math.max(0, totalNow - cpuPrev.total);
    if (dTotal > 0) {
      cpuPct = Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100));
    }
  }
  cpuPrev = { idle: idleNow, total: totalNow };

  if (!staticCpuCache) {
    // os.cpus() has no physical-core count, so that one figure still needs wmic.
    let cpuCores = 1;
    const out = await runOut('wmic', ['cpu', 'get', 'NumberOfCores', '/value']);
    if (out) {
      const line = out.split('\n').find(l => l.startsWith('NumberOfCores='));
      if (line) {
        const n = parseInt(line.slice('NumberOfCores='.length).trim(), 10);
        if (Number.isFinite(n) && n > 0) cpuCores = n;
      }
    }
    staticCpuCache = {
      cpuName: (cpus[0] && cpus[0].model ? String(cpus[0].model).trim() : '') || 'Unknown CPU',
      cpuCores,
      cpuThreads: Math.max(1, cpus.length),
      cpuFreqMhz: cpus[0] && cpus[0].speed ? cpus[0].speed : 0,
    };
  }
  const c = staticCpuCache;

  return {
    totalRam,
    availRam,
    usedRam: Math.max(0, totalRam - availRam),
    cpuPct,
    loadAvg: cpuPct,
    cpuName: c.cpuName,
    cpuCores: c.cpuCores,
    cpuThreads: c.cpuThreads,
    cpuFreqMhz: c.cpuFreqMhz,
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// Names only, not values - some settings (fonts, etc.) are nested objects that
// would be noisy to log in full.
function changedSettingKeys(oldVal, newVal) {
  if (!newVal || typeof newVal !== 'object' || Array.isArray(newVal)) return [];
  const oldObj = (oldVal && typeof oldVal === 'object' && !Array.isArray(oldVal)) ? oldVal : null;
  return Object.keys(newVal).filter(k => !oldObj || !deepEqual(oldObj[k], newVal[k]));
}

module.exports = {

  get_system_stats: async () => {
    if (process.platform === 'win32') return statsWindows();
    if (process.platform === 'darwin') return statsMacos();
    return statsLinux();
  },

  list_system_fonts: async () => {
    if (process.platform === 'win32') {
      const out = await runOut('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[System.Drawing.FontFamily]::Families | Select-Object -ExpandProperty Name',
      ], { timeout: 15000 });
      if (out === null) return [];
      const fonts = [...new Set(out.split('\n').map(l => l.trim()).filter(Boolean))];
      fonts.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      return fonts;
    }

    const out = await runOut('fc-list', ['--format', '%{family}\n'], { timeout: 15000 });
    if (out === null) return [];
    // fontconfig may give comma-separated names for multi-script families; take
    // the first, and dedupe on first-seen so the original order decides.
    const seen = new Set();
    const fonts = [];
    for (const line of out.split('\n')) {
      const name = (line.split(',')[0] || '').trim();
      if (name && !seen.has(name)) { seen.add(name); fonts.push(name); }
    }
    fonts.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return fonts;
  },

  get_app_settings: async () => {
    let v = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.appSettingsPath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed;
    } catch { /* defaults below */ }

    if (v.runInBackground === undefined) v.runInBackground = true;
    if (v.fonts === undefined) {
      v.fonts = {
        display: 'Poppins',
        displayWeight: '400',
        mono: 'JetBrains Mono',
        monoWeight: '400',
      };
    }
    return v;
  },

  save_app_settings: async ({ settings }) => {
    try {
      fs.mkdirSync(paths.home(), { recursive: true });
    } catch (e) {
      return { error: e.message };
    }

    let old = null;
    try { old = JSON.parse(fs.readFileSync(paths.appSettingsPath(), 'utf8')); } catch { /* none yet */ }

    const changed = changedSettingKeys(old, settings);
    if (changed.length) applog.info(`Settings updated: ${changed.join(', ')}`);

    try {
      fs.writeFileSync(paths.appSettingsPath(), JSON.stringify(settings, null, 2));
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  },

  shutdown_all_servers: async () => {
    const { stdout, spawnError } = await cli.execMcpanel(['api', 'shutdown']);
    if (spawnError) return { error: spawnError.message };
    try { return JSON.parse(stdout); } catch { return { success: true }; }
  },

  open_external: async ({ url }) => {
    if (!url) throw new Error('No URL given');
    const ok = process.platform === 'win32'
      ? await trySpawn('cmd', ['/c', 'start', '', url])
      : await trySpawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
    if (!ok) throw new Error(`Failed to open ${url}`);
  },

  open_path: async (args) => {
    const target = args.path;
    if (!target) throw new Error('No path given');
    const ok = process.platform === 'win32'
      ? await trySpawn('cmd', ['/c', 'start', '', target])
      : await trySpawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target]);
    if (!ok) throw new Error(`Failed to open ${target}`);
  },

  open_terminal: async () => {
    const dir = paths.home();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

    if (process.platform === 'darwin') {
      if (await trySpawn('open', ['-a', 'Terminal', dir])) return;
      throw new Error('No terminal emulator found. Install gnome-terminal, konsole, or xterm.');
    }
    if (process.platform === 'win32') {
      if (await trySpawn('cmd', ['/c', 'start', 'cmd'], { cwd: dir })) return;
      throw new Error('No terminal emulator found. Install gnome-terminal, konsole, or xterm.');
    }

    const home = os.homedir();
    const extra = `${home}/.local/bin:${home}/.local/pipx/bin:/usr/local/bin`;
    const env = { ...process.env, PATH: `${extra}:${process.env.PATH || ''}` };

    // (terminal, dir-flag) - an empty flag list means use cwd only.
    const candidates = [
      ['gnome-terminal', ['--working-directory']],
      ['konsole', ['--workdir']],
      ['xfce4-terminal', ['--working-directory']],
      ['alacritty', ['--working-directory']],
      ['kitty', []],
      ['wezterm', ['start', '--cwd']],
      ['xterm', []],
      ['x-terminal-emulator', []],
    ];

    for (const [term, flags] of candidates) {
      const args = [...flags];
      // Flags that take the dir as the next arg need the dir appended.
      if (flags.length && flags[flags.length - 1] !== 'start') args.push(dir);
      if (await trySpawn(term, args, { cwd: dir, env })) return;
    }

    throw new Error('No terminal emulator found. Install gnome-terminal, konsole, or xterm.');
  },
};

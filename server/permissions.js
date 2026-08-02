/* ═══════════════════════════════════════════════════════════════════════════
   RPC authorisation - which permission each backend command demands.

   Every /api/invoke call passes through check() before it runs. The panel is
   now reachable from other devices, so this module is a real security
   boundary, not a UI convenience: a signed-in viewer can open devtools and
   POST any command with any arguments they like. Nothing here may assume the
   frontend only sends what its buttons produce.

   Three rules the whole file follows:

     1. Fail CLOSED. No user, a disabled user, an unknown command, or an
        unclassifiable CLI argv all deny. A command added later without a MAP
        entry is denied, not allowed (and warns at boot - see verifyCoverage).
     2. The permission STRINGS are not defined here. They come from
        mcpanel-cli's accounts addon
        (mcpanel/bundled_addons/accounts/permissions.py), which is the single
        source of truth; this file only maps commands onto them.
     3. Admin (isAdmin, or a "*" grant) bypasses everything except the handful
        of commands marked DENY, which are restricted to admins by definition.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// Restricted to administrators no matter what permissions a role was granted.
const DENY = 'DENY';

// ─── Direct command → permission ─────────────────────────────────────────────
// `null` means "always allowed to any signed-in user". An array means ALL of
// the listed permissions are required.

const MAP = {
  // ── Bootstrap / always-allowed ──────────────────────────────────────────
  // web-bridge.js gates the entire app on check_cli before anything else runs,
  // and app.js applies a theme before it knows who you are - so these four
  // have to work for every signed-in user regardless of role, or the panel
  // never finishes loading.
  check_cli: null,
  log_event: null,
  check_first_start_flag: null,
  ensure_builtin_themes: null,      // writes only from server-side sources

  get_themes: null,                 // needed to render the picker for anyone
  get_theme_css: null,              // needed to style the page at all
  get_default_theme: null,
  theme_exists: null,
  fetch_github_themes: 'themes.view',
  // Takes id/css/json straight from the client, so it is a (themes-dir-scoped)
  // file write. Every builtin role holds themes.view, so the normal boot path
  // where app.js re-seeds a missing builtin still works for everyone.
  install_builtin_theme: 'themes.view',
  set_default_theme: 'themes.manage',
  install_theme_from_url: 'themes.manage',
  install_theme_from_file: 'themes.manage',
  delete_theme: 'themes.manage',

  create_server: 'servers.create',
  import_server_cmd: 'servers.create',
  duplicate_server: 'servers.duplicate',
  update_server: 'servers.edit',
  accept_eula: 'servers.edit',
  start_server: 'servers.start',
  send_server_command: 'servers.command',
  ping_server: 'servers.view',
  get_server_start_time: 'servers.view',
  get_log_since: 'servers.console',   // the 15ms console poll
  stop_log_stream: 'servers.console', // only tears down your own tail

  read_server_file: 'files.read',
  write_server_file: 'files.write',
  create_server_file: 'files.write',
  create_server_dir: 'files.write',
  // Rename refuses to overwrite an existing target ("A file with that name
  // already exists"), so it cannot destroy data - it is an editing action,
  // not a destructive one. files.write keeps it available to operators.
  rename_server_file: 'files.write',
  delete_server_file: 'files.delete',
  upload_files_to_server: 'files.upload',
  export_server_files: 'files.download',

  update_profile: 'profiles.manage',
  get_profile_file_tree: 'files.read',
  read_profile_file: 'files.read',
  write_profile_file: 'files.write',
  create_profile_file: 'files.write',
  create_profile_dir: 'files.write',
  rename_profile_file: 'files.write',
  delete_profile_file: 'files.delete',
  upload_files_to_profile: 'files.upload',
  export_profile_files: 'files.download',

  list_backups: 'backups.view',
  create_backup: 'backups.create',
  restore_backup: 'backups.restore',
  delete_backup: 'backups.delete',

  get_schedules: 'schedules.view',
  save_schedule: 'schedules.manage',
  delete_schedule: 'schedules.manage',
  run_schedule_now: 'schedules.manage',

  proxy_info: 'proxy.manage',
  link_to_proxy: 'proxy.manage',
  get_velocity_secret: 'proxy.manage',   // reveals the forwarding secret

  get_system_stats: 'system.view',
  get_app_version: 'system.view',
  check_app_update: 'system.view',
  check_cli_update: 'system.view',
  list_system_fonts: 'system.view',
  get_app_settings: 'settings.view',
  get_app_log_path: 'settings.view',
  save_app_settings: 'settings.manage',
  // save_config rewrites the WHOLE config.json - including every server's
  // `dir` - so it is a path-rewrite primitive, not a preferences save. But
  // app.js also persists the active theme through it, so demanding
  // settings.manage here would stop every non-admin from changing their theme.
  //
  // Resolved one level down instead: the gate lets any signed-in user through,
  // and commands/core.js diffs the submitted config against the one on disk,
  // allowing a caller without settings.manage to change ONLY the harmless
  // preference keys. See SAFE_CONFIG_KEYS there.
  save_config: null,
  // Act on the HOST machine. On a remote install the user cannot even see the
  // window that opens, so these are administrative.
  open_path: 'settings.manage',
  open_external: 'settings.manage',

  // ── Filesystem picker ───────────────────────────────────────────────────
  // Browses the backend host's filesystem outside any server directory.
  list_dir: 'files.read',

  // ── Embedded terminal ───────────────────────────────────────────────────
  // A shell on the host as the user running the backend.
  pty_open: 'terminal.access',
  pty_write: 'terminal.access',
  pty_resize: 'terminal.access',
  pty_close: 'terminal.access',
  open_terminal: 'terminal.access',

  // ── Admin-only ──────────────────────────────────────────────────────────
  // Stops the panel for everyone / mutates the host's Python environment.
  // Restricted by identity rather than by permission so that granting a broad
  // role can never hand these out by accident.
  quit_app: DENY,
  shutdown_all_servers: DENY,
  install_cli: DENY,
  __start_scheduler: DENY,          // internal boot hook, never client-reachable

  // ── CLI passthrough ─────────────────────────────────────────────────────
  // Classified per-argv by cliPermission() below.
  run_cli: '__RUN_CLI__',
};

// ─── CLI passthrough classification ──────────────────────────────────────────
// run_cli forwards an arbitrary argv to `mcpanel api ...`, so it is the widest
// hole in the API. The frontend uses it for most of its reads, which means a
// blanket cli.raw would lock every non-admin out of the panel entirely - but
// accepting whatever argv arrives would let a viewer run `delete server` or,
// worse, `accounts create -r admin`.
//
// So: recognise the argv shapes the CLI actually implements and map each to the
// permission that the equivalent native command needs. Anything unrecognised
// falls through to cli.raw, which only admins hold.
//
// Keys are matched longest-first: "fetch log" wins over "fetch".
const CLI_MAP = {
  'config show': 'servers.view',
  'config path': 'settings.view',
  'fetch config': 'servers.view',
  'fetch server': 'servers.view',
  'fetch status': 'servers.view',
  'fetch stats': 'servers.view',
  'fetch files': 'files.read',
  'fetch log': 'servers.console',
  'fetch profile': 'profiles.view',
  'fetch system': 'system.view',
  'fetch update': 'system.view',
  'fetch jdk': 'system.view',
  'fetch jdk-compat': 'system.view',
  'fetch versions': 'servers.view',
  'fetch buildtools': 'system.view',
  'list servers': 'servers.view',
  'list profiles': 'profiles.view',
  'info server': 'servers.view',
  'info profile': 'profiles.view',
  'info plugin': 'plugins.view',
  'logs': 'servers.console',
  'console': 'servers.console',
  'sessions': 'servers.console',
  'stats': 'servers.view',
  'files': 'files.read',
  'ping': 'servers.view',
  'versions': 'servers.view',
  'detect-jdk': 'system.view',
  'system': 'system.view',
  'version': 'system.view',
  'check-update': 'system.view',
  'discover': 'servers.view',

  'start': 'servers.start',
  'stop': 'servers.stop',
  'restart': 'servers.stop',
  'kill': 'servers.stop',
  'cmd': 'servers.command',

  'create server': 'servers.create',
  'import server': 'servers.create',
  'duplicate': 'servers.duplicate',
  'update': 'servers.edit',
  'accept-eula': 'servers.edit',
  'delete server': 'servers.delete',
  'scan server': 'servers.create',

  'create profile': 'profiles.manage',
  'create profile-from-server': 'profiles.manage',
  'import profile': 'profiles.manage',
  'delete profile': 'profiles.manage',
  'scan profile': 'profiles.manage',
  'open profile': 'settings.manage',   // opens a folder on the HOST
  'open server': 'settings.manage',

  'search plugins': 'plugins.view',
  'search mods': 'plugins.view',
  'install plugin': 'plugins.install',
  'install mod': 'plugins.install',

  'backup list': 'backups.view',
  'backup create': 'backups.create',
  'backup restore': 'backups.restore',
  'backup delete': 'backups.delete',

  'proxy info': 'proxy.manage',
  'proxy link': 'proxy.manage',

  // buildtools installs a toolchain on the host
  'buildtools version': 'system.view',
  'buildtools update': 'settings.manage',

  // ── Privilege-escalation surface ────────────────────────────────────────
  // Without these two entries, any signed-in user could POST
  // run_cli(['accounts','create','-u','me','-r','admin']) and promote
  // themselves, or install an addon (arbitrary code) into the backend.
  'accounts': 'accounts.manage',
  'addons': DENY,

  // stops every server on the host
  'shutdown': DENY,
  'debug': DENY,
  'cli': DENY,              // would try to open the interactive TUI
  'completion': null,       // harmless static text
};

/** Longest-prefix classification of a `mcpanel api <argv>` invocation. */
function cliPermission(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return 'cli.raw';

  // Only the leading verbs are ever significant; flags never are. Reject
  // anything that isn't a plain string so a crafted object can't slip through
  // the lookup.
  const parts = argv.filter(a => typeof a === 'string' && !a.startsWith('-'));
  if (!parts.length) return 'cli.raw';

  const two = `${parts[0]} ${parts[1] || ''}`.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CLI_MAP, two)) return CLI_MAP[two];

  const one = String(parts[0]).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CLI_MAP, one)) return CLI_MAP[one];

  // Unrecognised: admins only.
  return 'cli.raw';
}

// ─── Grant matching ──────────────────────────────────────────────────────────
// Mirrors permissions.granted() in the accounts addon: "*" covers everything,
// "area.*" covers one area, otherwise an exact string match.

function heldBy(user) {
  if (!user) return [];
  const a = Array.isArray(user.effectivePermissions) ? user.effectivePermissions : [];
  const b = Array.isArray(user.permissions) ? user.permissions : [];
  return a.concat(b);
}

function granted(held, permission) {
  if (!held || !held.length) return false;
  if (held.includes('*')) return true;
  if (held.includes(permission)) return true;
  const area = String(permission).split('.', 1)[0];
  return held.includes(`${area}.*`);
}

function isAdmin(user) {
  if (!user) return false;
  return user.isAdmin === true || heldBy(user).includes('*');
}

/**
 * The permission(s) `cmd` demands. `args` is only consulted for run_cli, whose
 * requirement depends on the argv it is asked to forward.
 * Returns a string, an array of strings, null (always allowed), or DENY.
 * An unmapped command returns DENY - new commands are closed by default.
 */
function requiredPermission(cmd, args) {
  if (!Object.prototype.hasOwnProperty.call(MAP, cmd)) return DENY;
  const req = MAP[cmd];
  if (req === '__RUN_CLI__') return cliPermission(args && args.args);
  return req;
}

// Display-only phrasing for denial messages. The authoritative catalogue lives
// in the accounts addon; this table exists so a refusal reads like a sentence
// instead of a permission string, and falls back gracefully when it doesn't
// know a name (e.g. one added to the addon after this file was written).
const PHRASING = {
  'accounts.view': 'view user accounts',
  'accounts.manage': 'manage user accounts',
  'self.password': 'change your own password',
  'servers.view': 'view servers',
  'servers.create': 'create servers',
  'servers.duplicate': 'duplicate servers',
  'servers.edit': "change a server's settings",
  'servers.delete': 'delete servers',
  'servers.start': 'start servers',
  'servers.stop': 'stop servers',
  'servers.console': 'read server consoles',
  'servers.command': 'send console commands',
  'files.read': 'read server files',
  'files.write': 'edit server files',
  'files.delete': 'delete or rename server files',
  'files.upload': 'upload files',
  'files.download': 'download files',
  'profiles.view': 'view profiles',
  'profiles.manage': 'manage profiles',
  'plugins.view': 'browse plugins and mods',
  'plugins.install': 'install plugins and mods',
  'backups.view': 'view backups',
  'backups.create': 'create backups',
  'backups.restore': 'restore backups',
  'backups.delete': 'delete backups',
  'schedules.view': 'view scheduled tasks',
  'schedules.manage': 'manage scheduled tasks',
  'proxy.manage': 'manage proxy links',
  'themes.view': 'use themes',
  'themes.manage': 'install and delete themes',
  'system.view': 'view system information',
  'settings.view': 'view application settings',
  'settings.manage': 'change application settings',
  'terminal.access': 'open a terminal on the host',
  'cli.raw': 'run arbitrary MCPanel-CLI commands',
};

function explain(permission) {
  const phrase = PHRASING[permission];
  return phrase
    ? `Your account does not have permission to ${phrase} (${permission}).`
    : `Your account is missing the "${permission}" permission.`;
}

/**
 * Returns null when `user` may run `cmd`, otherwise a human-readable reason.
 * Fails closed on every unexpected input.
 */
function check(user, cmd, args) {
  if (!user) return 'You are not signed in.';
  if (user.enabled === false) return 'This account has been disabled.';
  if (typeof cmd !== 'string' || !cmd) return 'Unknown command.';

  const req = requiredPermission(cmd, args);

  if (req === null) return null;
  if (isAdmin(user)) return null;
  if (req === DENY) {
    return `"${cmd}" is restricted to administrators.`;
  }

  const held = heldBy(user);
  const needed = Array.isArray(req) ? req : [req];
  const missing = needed.filter(p => !granted(held, p));
  if (!missing.length) return null;

  return explain(missing[0]);
}

/**
 * Boot-time safety net: warns about any command the backend registers that
 * this map does not mention. Such a command is already DENIED by
 * requiredPermission - this exists so the omission is noticed rather than
 * silently locking a feature out.
 * Returns the list of uncovered command names.
 */
function verifyCoverage(logger) {
  let uncovered = [];
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'commands');
    const names = new Set();
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const mod = require(path.join(dir, file));
      for (const [k, v] of Object.entries(mod)) {
        if (typeof v === 'function') names.add(k);
      }
    }
    uncovered = [...names].filter(n => !Object.prototype.hasOwnProperty.call(MAP, n));
  } catch {
    return uncovered; // never let a coverage check break startup
  }
  if (uncovered.length && logger && typeof logger.warn === 'function') {
    logger.warn(`permissions: ${uncovered.length} command(s) have no permission mapping ` +
                `and are denied to non-admins: ${uncovered.join(', ')}`);
  }
  return uncovered;
}

module.exports = {
  MAP,
  CLI_MAP,
  DENY,
  requiredPermission,
  check,
  explain,
  granted,
  isAdmin,
  cliPermission,
  verifyCoverage,
};

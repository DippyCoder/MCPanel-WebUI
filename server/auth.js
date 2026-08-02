/* ═══════════════════════════════════════════════════════════════════════════
   Authentication - sessions, cookies and login rate limiting.

   The panel is reachable from other devices, so every request has to carry a
   session. Accounts themselves live in MCPanel-CLI's `accounts` addon (SQLite
   under the shared mcpanel data dir), reached the same way as everything else
   in this backend: by shelling out to `mcpanel api accounts …`.

   Keeping the account store in the CLI rather than here means the desktop app,
   the CLI and the WebUI all agree on who exists and what they may do, and the
   WebUI never touches a password hash itself.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const cli = require('./cli');
const applog = require('./applog');

const COOKIE_NAME = 'mcpanel_session';

/**
 * argparse reads `-p <value>` as a missing argument when <value> itself starts
 * with a dash, which would make any password beginning with "-" unusable. The
 * attached form (`-p-secret`) is unambiguous, so use it whenever the value
 * could be mistaken for a flag.
 */
function flag(name, value) {
  const s = String(value);
  return s.startsWith('-') ? [`${name}${s}`] : [name, s];
}

/**
 * Runs an `accounts` subcommand. Note the deliberate `cli.runCliJson(...)`
 * property lookup rather than a destructured import: it keeps the call
 * interceptable, which is what the test harness relies on to exercise this
 * module without a live addon.
 */
async function accounts(args, secrets) {
  try {
    // When `secrets` is present the values go down the child's stdin instead of
    // its argv - argv is world-readable through `ps`, and the panel runs this
    // on every sign-in. The addon's `--password-stdin` accepts either one bare
    // line or this JSON object, which is what lets `passwd` carry both the new
    // and the current password over a single pipe.
    if (secrets) {
      return await cli.runCliJsonWithInput(['accounts', ...args], JSON.stringify(secrets));
    }
    return await cli.runCliJson(['accounts', ...args]);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // argparse's "invalid choice: 'accounts'" is what a CLI without the addon
    // installed looks like. Say so plainly - "unexpected token < in JSON" would
    // send someone hunting in entirely the wrong place.
    if (/invalid choice: 'accounts'/.test(msg) || /unrecognized arguments/.test(msg)) {
      throw new Error(
        'The MCPanel-CLI accounts addon is not installed, so the panel cannot ' +
        'authenticate anyone. Install/upgrade mcpanel-cli, then run: mcpanel addons list'
      );
    }
    if (/mcpanel CLI not found/i.test(msg) || /ENOENT/.test(msg)) {
      throw new Error('MCPanel-CLI is not installed - the panel cannot authenticate anyone.');
    }
    throw new Error(msg);
  }
}

/**
 * Normalises whatever the addon returns into the shape the rest of the WebUI
 * relies on. `effectivePermissions` (role grants ∪ per-user grants, wildcards
 * resolved) is the list permission checks read; `permissions` stays as the
 * addon reported it so the accounts UI can still show the raw per-user grants.
 */
function normaliseUser(u) {
  if (!u || typeof u !== 'object') return null;
  const effective = Array.isArray(u.effectivePermissions) ? u.effectivePermissions
    : Array.isArray(u.permissions) ? u.permissions
    : [];
  return {
    ...u,
    username: u.username,
    role: u.role || null,
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    effectivePermissions: effective,
    isAdmin: !!u.isAdmin || effective.includes('*'),
    enabled: u.enabled !== false,
    mustChangePassword: !!u.mustChangePassword,
  };
}

/** The identity boot-time and scheduler-driven work runs as. Never a real login. */
const SYSTEM_USER = Object.freeze({
  username: '__system__',
  role: 'admin',
  permissions: ['*'],
  effectivePermissions: ['*'],
  isAdmin: true,
  enabled: true,
  mustChangePassword: false,
  system: true,
});

// ─── Session cache ───────────────────────────────────────────────────────────
//
// app.js polls the console every 15 ms. Verifying each of those against the
// addon would fork a Python interpreter per poll, so results are cached
// briefly. The cost is that a disabled or deleted account keeps its access for
// up to POSITIVE_TTL_MS; logout and password changes purge their entries
// immediately, so the window only applies to admin-side revocation.
//
// Failures are cached too (for less time), because otherwise anyone who can
// reach the port could spawn unbounded Python processes just by replaying a
// junk cookie.

const POSITIVE_TTL_MS = 15 * 1000;
const NEGATIVE_TTL_MS = 5 * 1000;
const MAX_CACHE_ENTRIES = 2000;

const cache = new Map(); // token → { user|null, expires }

function cacheGet(token) {
  const hit = cache.get(token);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) { cache.delete(token); return undefined; }
  return hit;
}

function cacheSet(token, user) {
  // Map preserves insertion order, so the oldest key is the first one out.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(token, {
    user,
    expires: Date.now() + (user ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

/** Drops one token from the cache - call after logout. */
function invalidate(token) {
  if (token) cache.delete(token);
}

/** Drops every cached session for a username - call after a password change. */
function invalidateUser(username) {
  if (!username) return;
  const target = String(username).toLowerCase();
  for (const [token, hit] of cache) {
    if (hit.user && String(hit.user.username).toLowerCase() === target) cache.delete(token);
  }
}

// ─── Login rate limiting ─────────────────────────────────────────────────────
//
// Per-IP, in memory: a restart clears it, and it is per-process rather than
// shared. That is the right trade for a single-process panel - the point is to
// blunt online password guessing, not to be an audited security control.

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // ip → { count, first, blockedUntil }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimitCheck(ip) {
  const rec = failures.get(ip);
  if (!rec) return null;
  if (rec.blockedUntil && Date.now() < rec.blockedUntil) {
    const mins = Math.ceil((rec.blockedUntil - Date.now()) / 60000);
    return `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
  }
  if (rec.blockedUntil && Date.now() >= rec.blockedUntil) failures.delete(ip);
  return null;
}

function recordFailure(ip) {
  const now = Date.now();
  let rec = failures.get(ip);
  if (!rec || now - rec.first > FAILURE_WINDOW_MS) rec = { count: 0, first: now, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    rec.blockedUntil = now + FAILURE_WINDOW_MS;
    applog.warn(`Auth: rate-limit block for ${ip} after ${rec.count} failed sign-ins`);
  }
  failures.set(ip, rec);
}

function recordSuccess(ip) {
  failures.delete(ip);
}

// Housekeeping so neither map grows without bound on a long-lived process.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [token, hit] of cache) if (now > hit.expires) cache.delete(token);
  for (const [ip, rec] of failures) {
    const dead = (!rec.blockedUntil && now - rec.first > FAILURE_WINDOW_MS)
      || (rec.blockedUntil && now > rec.blockedUntil);
    if (dead) failures.delete(ip);
  }
}, 60 * 1000);
if (sweeper.unref) sweeper.unref();

/** Seeds the account store on first boot so a fresh install has admin/admin. */
async function ensureSeeded() {
  try {
    const r = await accounts(['init']);
    if (r && r.created) applog.info('Auth: account store initialised with the default admin account');
    return r;
  } catch (e) {
    applog.warn(`Auth: could not initialise the account store - ${e.message}`);
    return { error: e.message };
  }
}

/**
 * Authenticates a username/password pair. Throws with a user-facing message on
 * failure; the caller decides the HTTP status.
 */
async function login(username, password, req) {
  const ip = clientIp(req);
  const blocked = rateLimitCheck(ip);
  if (blocked) throw Object.assign(new Error(blocked), { rateLimited: true });

  if (!username || !password) {
    recordFailure(ip);
    throw new Error('Username and password are required');
  }

  const args = [
    'login',
    ...flag('-u', username),
    '--password-stdin',
    ...flag('--ua', String(req.headers['user-agent'] || '').slice(0, 200)),
    ...flag('--ip', ip),
  ];

  let r;
  try {
    r = await accounts(args, { password });
  } catch (e) {
    // A CLI/addon problem is not a credential problem - do not count it
    // against the user's rate-limit budget.
    applog.error(`Auth: sign-in for "${username}" failed to reach the account store - ${e.message}`);
    throw e;
  }

  if (!r || !r.success || !r.token) {
    recordFailure(ip);
    applog.warn(`Auth: failed sign-in for "${username}" from ${ip}`);
    throw new Error((r && r.error) || 'Incorrect username or password');
  }

  recordSuccess(ip);
  const user = normaliseUser(r.user) || normaliseUser({ username });
  cacheSet(r.token, user);
  applog.info(`Auth: "${user.username}" signed in from ${ip}`);
  return { token: r.token, expiresAt: r.expiresAt || null, user };
}

/** Resolves a session token to a user, or null. Cached - see the note above. */
async function verify(token) {
  if (!token || typeof token !== 'string') return null;

  const hit = cacheGet(token);
  if (hit !== undefined) return hit.user;

  let r;
  try {
    r = await accounts(['verify', ...flag('-t', token)]);
  } catch (e) {
    // Do not cache infrastructure failures as "invalid session" - that would
    // silently sign everyone out for 5s every time the CLI hiccups.
    applog.error(`Auth: session check failed - ${e.message}`);
    return null;
  }

  const user = (r && r.valid) ? normaliseUser(r.user) : null;
  // A disabled account is authenticated but must not be let in.
  const allowed = user && user.enabled !== false ? user : null;
  cacheSet(token, allowed);
  return allowed;
}

/** Ends a session. Best-effort: the local cache entry is always cleared. */
async function logout(token) {
  invalidate(token);
  if (!token) return { success: true };
  try {
    const r = await accounts(['logout', ...flag('-t', token)]);
    applog.info('Auth: session ended');
    return r || { success: true };
  } catch (e) {
    applog.warn(`Auth: logout could not reach the account store - ${e.message}`);
    return { success: true, warning: e.message };
  }
}

/**
 * Self-service password change. The addon owns the policy (the `self.password`
 * permission and the install-wide `allow_self_password_change` switch), so its
 * refusal is passed straight through rather than second-guessed here.
 */
async function changePassword(username, currentPassword, newPassword, token) {
  if (!newPassword) throw new Error('A new password is required');
  const r = await accounts([
    'passwd',
    ...flag('-u', username),
    '--password-stdin',
  ], { password: newPassword, current: currentPassword || '' });
  if (!r || r.error || r.success === false) {
    throw new Error((r && r.error) || 'Password change failed');
  }
  // The addon revokes sessions on a password change; drop our cached copies so
  // the change takes effect now rather than after the cache TTL.
  invalidateUser(username);
  invalidate(token);
  applog.info(`Auth: password changed for "${username}"`);
  return r;
}

/**
 * The install-wide account settings, cached briefly.
 *
 * Needed by every signed-in user, not just admins: the "change my password"
 * form has to know whether `allow_self_password_change` is on before it can
 * decide whether to render. Reading it through the `accounts settings` command
 * would require `accounts.manage`, so /api/me surfaces the couple of fields a
 * normal user legitimately needs instead of widening that permission.
 */
let _settingsCache = { at: 0, value: null };

async function globalSettings() {
  const now = Date.now();
  if (_settingsCache.value && now - _settingsCache.at < 30000) return _settingsCache.value;
  try {
    const r = await accounts(['settings']);
    const s = (r && r.settings) || {};
    _settingsCache = { at: now, value: s };
    return s;
  } catch {
    // Falling back to permissive here only affects whether a form is drawn -
    // the addon still enforces the real policy when the change is submitted.
    return _settingsCache.value || {};
  }
}

/** The subset of the global settings safe to hand any signed-in user. */
async function publicSettings() {
  const s = await globalSettings();
  return {
    allowSelfPasswordChange: s.allow_self_password_change !== false,
    minPasswordLength: Number(s.min_password_length) || 1,
  };
}

/**
 * Best-effort check for "the seeded admin account is still on its default
 * password", used for the startup warning. Returns true/false, or null when
 * the answer cannot be determined (addon missing, unexpected output).
 */
async function defaultAdminPasswordInUse() {
  try {
    const r = await accounts(['list']);
    const users = (r && (r.users || r.accounts)) || [];
    if (!Array.isArray(users)) return null;
    const admin = users.find(u => String(u.username).toLowerCase() === 'admin');
    if (!admin) return false;
    return !!admin.mustChangePassword;
  } catch {
    return null;
  }
}

/** Minimal Cookie: header parser - avoids pulling in cookie-parser for one job. */
function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

/** Reads the session token off a request (works for HTTP and WS upgrades). */
function tokenFromRequest(req) {
  const cookies = req.cookies || parseCookies(req.headers && req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

/**
 * True when the request reached us over TLS - directly or via a proxy that
 * says so. Only then may the cookie be marked Secure; setting it
 * unconditionally would make sign-in silently fail over plain http.
 */
function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  return !!proto && String(proto).split(',')[0].trim() === 'https';
}

function setSessionCookie(res, req, token, expiresAt) {
  const opts = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req),
  };
  const ms = expiresAt ? new Date(expiresAt).getTime() - Date.now() : NaN;
  if (Number.isFinite(ms) && ms > 0) opts.maxAge = ms;
  res.cookie(COOKIE_NAME, token, opts);
}

function clearSessionCookie(res, req) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req),
  });
}

module.exports = {
  COOKIE_NAME,
  SYSTEM_USER,
  ensureSeeded,
  login,
  verify,
  logout,
  changePassword,
  globalSettings,
  publicSettings,
  defaultAdminPasswordInUse,
  invalidate,
  invalidateUser,
  parseCookies,
  tokenFromRequest,
  setSessionCookie,
  clearSessionCookie,
  clientIp,
  normaliseUser,
};

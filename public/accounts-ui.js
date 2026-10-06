/* ═══════════════════════════════════════════════════════
   MCPanel WebUI - accounts & permissions UI

   The desktop app has no account screen: it runs as one desktop user with
   full control. The WebUI is reachable from other devices, so it grows one -
   an "Accounts" modal covering the four things the backend supports:

     My Account   change your own password, see what you're allowed to do
     Users        create / edit / disable / delete accounts   (accounts.manage)
     Roles        reusable permission bundles                  (accounts.manage)
     Global       install-wide switches                        (accounts.manage)

   Everything here is injected at runtime out of the app's own markup and CSS
   custom properties - the same trick web-bridge.js uses for its path picker -
   so index.html, style.css and app.js stay the files the desktop app ships and
   all four themes restyle this for free.

   Account state lives in MCPanel-CLI's `accounts` addon (SQLite); this file
   only ever talks to it through the panel's normal RPC endpoint.
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  async function _post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  }

  // Every account command is a CLI passthrough. run_cli hands back the raw
  // stdout string, so the JSON has to be parsed on this side.
  async function acct(args) {
    const r = await _post('/api/invoke', { cmd: 'run_cli', args: { args: ['accounts', ...args] } });
    if (!r.ok) {
      const err = new Error(r.error || 'Request failed');
      err.forbidden = !!r.forbidden;
      err.code = r.code || 'error';
      throw err;
    }
    let parsed;
    try {
      parsed = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
    } catch {
      throw Object.assign(new Error('The CLI returned output this panel could not read.'),
                          { code: 'cli_bad_output' });
    }
    // Refusals arrive in-band as {"error": "...", "code": "..."}. The message
    // is shown verbatim - the addon owns the wording - and the code rides
    // along for any logic that wants it.
    if (parsed && parsed.error) {
      throw Object.assign(new Error(parsed.error), { code: parsed.code || 'error' });
    }
    return parsed;
  }

  function fail(e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (typeof window.toast === 'function') window.toast(msg, 'error');
    else console.error('[MCPanel accounts]', msg);
  }

  function done(msg) {
    if (typeof window.toast === 'function') window.toast(msg, 'success');
  }

  let _me = null;            // GET /api/me
  let _users = [];
  let _roles = [];
  let _catalog = [];         // [{name, description}]
  let _areas = [];
  let _settings = {};
  let _tab = 'me';
  let _els = null;
  let _editing = null;       // username being edited in the Users tab, or null

  // Convenience only. The backend re-checks every permission on every call -
  // hiding a tab here is a nicety for the user, never the security boundary.
  const canManage = () => !!(_me && (_me.isAdmin ||
    (_me.effectivePermissions || []).includes('accounts.manage')));

  const canChangeOwnPassword = () => {
    if (!_me) return false;
    if (_me.isAdmin) return true;
    if (_settings.allow_self_password_change === false) return false;
    return (_me.effectivePermissions || []).includes('self.password');
  };

  const CSS = `
.acct-body { padding: 0; }
.acct-tabs { padding: 0 24px; margin-bottom: 0; }
.acct-pane { padding: 18px 24px 22px; }
.acct-pane.hidden { display: none; }
.acct-section { display: flex; flex-direction: column; gap: 12px; }
.acct-section + .acct-section { margin-top: 22px; }
.acct-section h3 { font-size: 14px; font-weight: 700; color: var(--text-primary); }
.acct-ident {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px; border-radius: var(--radius);
  background: var(--bg-elevated); border: 1px solid var(--border);
}
.acct-avatar {
  width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-dim); border: 1px solid var(--accent);
  color: var(--accent); font-weight: 700; font-size: 15px;
  font-family: var(--font-display); text-transform: uppercase;
}
.acct-ident-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.acct-ident-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.acct-ident-sub { font-size: 11.5px; color: var(--text-muted); }
.acct-perm-wrap {
  max-height: 230px; overflow-y: auto; padding: 10px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}
.acct-perm-area + .acct-perm-area { margin-top: 12px; }
.acct-perm-area-title {
  font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--text-muted); margin-bottom: 6px;
}
.acct-perm-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.acct-perm-grid .checkbox-item { font-family: var(--font-mono); font-size: 11px; }
.acct-perm-grid .checkbox-item.is-inherited { opacity: 0.65; }
.acct-chip {
  display: inline-block; padding: 3px 8px; border-radius: 20px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-secondary);
}
.acct-chip.is-all { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
.acct-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.acct-list {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-elevated); overflow: hidden;
}
.acct-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}
.acct-row:last-child { border-bottom: none; }
.acct-row.is-disabled .acct-row-name { color: var(--text-muted); text-decoration: line-through; }
.acct-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.acct-row-name { color: var(--text-primary); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acct-row-meta { font-size: 11px; color: var(--text-muted); }
.acct-row-actions { display: flex; gap: 5px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.acct-you { font-size: 10px; color: var(--accent); font-weight: 700; letter-spacing: 0.05em; }
.acct-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.acct-toolbar-spacer { flex: 1; }
.acct-empty { padding: 22px; text-align: center; font-size: 12px; color: var(--text-muted); }
.acct-banner { margin-bottom: 16px; }
.acct-editor {
  margin-top: 12px; padding: 14px;
  border: 1px solid var(--accent); border-radius: var(--radius);
  background: var(--accent-dim);
}
.acct-editor-title { font-size: 12.5px; font-weight: 700; color: var(--text-primary); margin-bottom: 12px; }
.acct-readonly-note { font-size: 11px; color: var(--text-muted); margin-top: 6px; }

/* The panel exists to be usable from a phone; the desktop app never needed
   a breakpoint, so this is the only one and it is scoped to this modal. */
@media (max-width: 560px) {
  .acct-pane { padding: 14px 16px 18px; }
  .acct-tabs { padding: 0 12px; overflow-x: auto; }
  .acct-row { flex-wrap: wrap; }
  .acct-row-actions { width: 100%; justify-content: flex-start; }
  .acct-form-grid { grid-template-columns: 1fr; }
}
.acct-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.acct-form-grid .full { grid-column: 1 / -1; }
`;

  const ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  const ICON_USER = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

  const TABS = [
    { id: 'me',       label: 'My Account', admin: false },
    { id: 'users',    label: 'Users',      admin: true  },
    { id: 'roles',    label: 'Roles',      admin: true  },
    { id: 'global',   label: 'Global',     admin: true  },
  ];

  function build() {
    if (_els) return _els;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay hidden';
    overlay.id = 'modal-accounts';
    overlay.innerHTML = `
  <div class="modal large" role="dialog" aria-modal="true" aria-label="Accounts">
    <div class="modal-header">
      <h2>Accounts</h2>
      <button class="modal-close" type="button" data-ac="close" aria-label="Close">${ICON_CLOSE}</button>
    </div>
    <div class="modal-body acct-body">
      <div class="detail-tab-bar acct-tabs"></div>
      <div class="acct-pane" data-pane="me"></div>
      <div class="acct-pane hidden" data-pane="users"></div>
      <div class="acct-pane hidden" data-pane="roles"></div>
      <div class="acct-pane hidden" data-pane="global"></div>
    </div>
  </div>`;
    document.body.appendChild(overlay);

    _els = {
      overlay,
      tabs: overlay.querySelector('.acct-tabs'),
      panes: {
        me: overlay.querySelector('[data-pane="me"]'),
        users: overlay.querySelector('[data-pane="users"]'),
        roles: overlay.querySelector('[data-pane="roles"]'),
        global: overlay.querySelector('[data-pane="global"]'),
      },
    };

    // app.js bound its overlay-click and Escape handlers before this node
    // existed, so both have to be wired up here.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-ac="close"]')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('submit', onSubmit);
    overlay.addEventListener('change', onChangeSetting);

    return _els;
  }

  async function open(tab) {
    build();
    _tab = tab || 'me';
    _els.overlay.classList.remove('hidden');
    renderTabs();
    render();
    await refresh();
    render();
  }

  function close() {
    if (_els) _els.overlay.classList.add('hidden');
    _editing = null;
  }

  async function refresh() {
    try {
      const meRes = await fetch('/api/me', { credentials: 'same-origin' });
      const meBody = await meRes.json().catch(() => null);
      _me = (meBody && (meBody.user || meBody.value || meBody)) || null;
      if (_me && !_me.username) _me = null;
    } catch { /* rendered as "not signed in" below */ }

    // Settings gate the self-service password form for everyone, so they are
    // fetched even for users who cannot see the Global tab. A user without
    // accounts.manage may be refused here - that is fine, defaults apply.
    try {
      const s = await acct(['settings']);
      _settings = (s && s.settings) || {};
    } catch { _settings = {}; }

    if (!canManage()) return;

    try {
      const [u, r, p] = await Promise.all([
        acct(['list']),
        acct(['roles', 'list']),
        acct(['perms']),
      ]);
      _users = (u && u.users) || [];
      _roles = (r && r.roles) || [];
      _catalog = (p && p.permissions) || [];
      _areas = (p && p.areas) || [];
    } catch (e) {
      fail(e);
    }
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function fmtDate(v) {
    if (!v) return 'never';
    const ms = Number(v);
    if (!Number.isFinite(ms) || ms <= 0) return 'never';
    // The addon stores seconds; anything below ~year 2286 in ms terms is a
    // second-precision stamp that needs scaling.
    const d = new Date(ms < 1e12 ? ms * 1000 : ms);
    if (isNaN(d.getTime())) return 'never';
    return d.toLocaleString();
  }

  function renderTabs() {
    const visible = TABS.filter(t => !t.admin || canManage());
    if (!visible.some(t => t.id === _tab)) _tab = 'me';
    _els.tabs.innerHTML = visible.map(t =>
      `<button class="detail-tab${t.id === _tab ? ' active' : ''}" type="button" data-ac="tab" data-tab="${t.id}">${esc(t.label)}</button>`
    ).join('');
  }

  function render() {
    if (!_els) return;
    renderTabs();
    for (const id of Object.keys(_els.panes)) {
      _els.panes[id].classList.toggle('hidden', id !== _tab);
    }
    if (_tab === 'me') renderMe();
    else if (_tab === 'users') renderUsers();
    else if (_tab === 'roles') renderRoles();
    else if (_tab === 'global') renderGlobal();
  }

  function renderMe() {
    const pane = _els.panes.me;
    if (!_me) {
      pane.innerHTML = `<div class="acct-empty">Not signed in.</div>`;
      return;
    }

    const nudge = sessionStorage.getItem('mcpanel_must_change_password') === '1' || _me.mustChangePassword;
    const perms = _me.effectivePermissions || [];
    const chips = _me.isAdmin
      ? `<span class="acct-chip is-all">* - everything</span>`
      : (perms.length
          ? perms.map(p => `<span class="acct-chip">${esc(p)}</span>`).join('')
          : `<span class="acct-row-meta">No permissions assigned.</span>`);

    const pwForm = canChangeOwnPassword() ? `
      <form class="acct-form-grid" data-ac="self-password">
        <div class="form-group full">
          <label for="ac-cur">Current password</label>
          <input class="input" type="password" id="ac-cur" name="current" autocomplete="current-password" required>
        </div>
        <div class="form-group">
          <label for="ac-new">New password</label>
          <input class="input" type="password" id="ac-new" name="next" autocomplete="new-password" required>
        </div>
        <div class="form-group">
          <label for="ac-new2">Confirm new password</label>
          <input class="input" type="password" id="ac-new2" name="confirm" autocomplete="new-password" required>
        </div>
        <div class="form-group full">
          <button class="btn-primary" type="submit">Change Password</button>
        </div>
      </form>`
      : `<div class="info-box">Password changes are handled by an administrator on this
         install. Ask an admin to set a new password for you.</div>`;

    pane.innerHTML = `
      ${nudge ? `<div class="warning-box acct-banner" style="margin-top:0">
        <div>This account still uses the default password that ships with MCPanel-WebUI
        (<strong>admin</strong> / <strong>admin</strong>). Anyone who can reach this
        panel can sign in as you until it is changed.</div>
      </div>` : ''}

      <div class="acct-section">
        <div class="acct-ident">
          <div class="acct-avatar">${esc((_me.username || '?').slice(0, 1))}</div>
          <div class="acct-ident-text">
            <div class="acct-ident-name">${esc(_me.username)}</div>
            <div class="acct-ident-sub">
              ${_me.role ? `Role: ${esc(_me.role)}` : 'No role assigned'}
              ${_me.isAdmin ? ' · Administrator' : ''}
            </div>
          </div>
          <div class="acct-toolbar-spacer"></div>
          <button class="btn-ghost-sm" type="button" data-ac="signout">Sign out</button>
        </div>
      </div>

      <div class="acct-section">
        <h3>Change password</h3>
        ${pwForm}
      </div>

      <div class="acct-section">
        <h3>What you can do</h3>
        <div class="acct-chips">${chips}</div>
      </div>`;
  }

  function renderUsers() {
    const pane = _els.panes.users;
    const rows = _users.length ? _users.map(u => {
      const isMe = _me && u.username === _me.username;
      return `
      <div class="acct-row${u.enabled ? '' : ' is-disabled'}">
        <div class="acct-row-main">
          <div class="acct-row-name">${esc(u.username)}${isMe ? ' <span class="acct-you">YOU</span>' : ''}</div>
          <div class="acct-row-meta">
            ${u.role ? esc(u.role) : 'no role'}
            · ${u.enabled ? 'enabled' : 'disabled'}
            · last login ${esc(fmtDate(u.lastLogin))}
            ${(u.permissions || []).length ? ` · +${u.permissions.length} extra` : ''}
          </div>
        </div>
        <div class="acct-row-actions">
          <button class="btn-ghost-sm" type="button" data-ac="edit" data-user="${esc(u.username)}">Edit</button>
          <button class="btn-ghost-sm" type="button" data-ac="setpw" data-user="${esc(u.username)}">Password</button>
          <button class="btn-ghost-sm" type="button" data-ac="toggle" data-user="${esc(u.username)}" data-on="${u.enabled ? '1' : '0'}">${u.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn-danger-sm" type="button" data-ac="delete" data-user="${esc(u.username)}">Delete</button>
        </div>
      </div>`;
    }).join('') : `<div class="acct-empty">No accounts yet.</div>`;

    pane.innerHTML = `
      <div class="acct-section">
        <div class="acct-toolbar">
          <h3>User accounts</h3>
          <div class="acct-toolbar-spacer"></div>
          <button class="btn-primary" type="button" data-ac="new">New Account</button>
        </div>
        <div class="acct-list">${rows}</div>
      </div>
      <div data-ac="editor-slot">${_editing ? userEditor(_editing) : ''}</div>`;
  }

  function userEditor(state) {
    const isNew = state.mode === 'new';
    const u = state.user || {};
    const roleOpts = ['<option value="">- no role -</option>']
      .concat(_roles.map(r =>
        `<option value="${esc(r.name)}"${r.name === u.role ? ' selected' : ''}>${esc(r.name)}</option>`))
      .join('');

    const roleGrants = (_roles.find(r => r.name === u.role) || {}).permissions || [];
    const extra = u.permissions || [];

    return `
    <form class="acct-editor" data-ac="save-user" data-mode="${esc(state.mode)}" data-user="${esc(u.username || '')}">
      <div class="acct-editor-title">${isNew ? 'New account' : `Editing ${esc(u.username)}`}</div>
      <div class="acct-form-grid">
        <div class="form-group${isNew ? '' : ' full'}">
          <label for="ac-u">Username</label>
          <input class="input" id="ac-u" name="username" value="${esc(u.username || '')}"
                 ${isNew ? 'required autocomplete="off"' : 'readonly'}>
        </div>
        ${isNew ? `
        <div class="form-group">
          <label for="ac-p">Password</label>
          <input class="input" type="password" id="ac-p" name="password" autocomplete="new-password" required>
        </div>` : ''}
        <div class="form-group full">
          <label for="ac-r">Role</label>
          <select class="input" id="ac-r" name="role">${roleOpts}</select>
        </div>
        <div class="form-group full">
          <label>Extra permissions <span class="label-hint">- granted on top of the role</span></label>
          ${permChecklist(extra, roleGrants)}
        </div>
      </div>
      <div class="acct-toolbar" style="margin-top:12px">
        <button class="btn-primary" type="submit">${isNew ? 'Create Account' : 'Save Changes'}</button>
        <button class="btn-ghost" type="button" data-ac="cancel-edit">Cancel</button>
      </div>
    </form>`;
  }

  // `inherited` renders as a ticked, disabled box: the user already has that
  // permission via their role, and unticking it here would not take it away.
  function permChecklist(selected, inherited, namePrefix) {
    const sel = new Set(selected || []);
    const inh = new Set();
    for (const g of (inherited || [])) {
      if (g === '*') { for (const p of _catalog) inh.add(p.name); }
      else if (g.endsWith('.*')) {
        const area = g.slice(0, -2);
        for (const p of _catalog) if (p.name.split('.')[0] === area) inh.add(p.name);
      } else inh.add(g);
    }

    const areas = _areas.length ? _areas
      : Array.from(new Set(_catalog.map(p => p.name.split('.')[0])));

    const blocks = areas.map(area => {
      const items = _catalog.filter(p => p.name.split('.')[0] === area);
      if (!items.length) return '';
      return `
      <div class="acct-perm-area">
        <div class="acct-perm-area-title">${esc(area)}</div>
        <div class="acct-perm-grid">
          ${items.map(p => {
            const isInh = inh.has(p.name) && !sel.has(p.name);
            return `<label class="checkbox-item${isInh ? ' is-inherited' : ''}" title="${esc(p.description)}${isInh ? ' (already granted by the role)' : ''}">
              <input type="checkbox" name="${esc(namePrefix || 'perm')}" value="${esc(p.name)}"
                     ${sel.has(p.name) ? 'checked' : ''} ${isInh ? 'checked disabled' : ''}>
              ${esc(p.name)}
            </label>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

    return `<div class="acct-perm-wrap">${blocks || '<div class="acct-empty">No permissions available.</div>'}</div>`;
  }

  function renderRoles() {
    const pane = _els.panes.roles;
    const rows = _roles.length ? _roles.map(r => {
      const locked = r.name === 'admin';
      const chips = (r.permissions || []).includes('*')
        ? `<span class="acct-chip is-all">* - everything</span>`
        : (r.permissions || []).map(p => `<span class="acct-chip">${esc(p)}</span>`).join('')
          || '<span class="acct-row-meta">none</span>';
      return `
      <div class="acct-row">
        <div class="acct-row-main">
          <div class="acct-row-name">${esc(r.name)}${r.builtin ? ' <span class="acct-you">BUILTIN</span>' : ''}</div>
          <div class="acct-row-meta">${esc(r.description || '')}</div>
          <div class="acct-chips" style="margin-top:5px">${chips}</div>
        </div>
        <div class="acct-row-actions">
          ${locked
            ? '<span class="acct-row-meta">read-only</span>'
            : `<button class="btn-ghost-sm" type="button" data-ac="edit-role" data-role="${esc(r.name)}">Edit</button>
               ${r.builtin ? '' : `<button class="btn-danger-sm" type="button" data-ac="del-role" data-role="${esc(r.name)}">Delete</button>`}`}
        </div>
      </div>`;
    }).join('') : `<div class="acct-empty">No roles defined.</div>`;

    pane.innerHTML = `
      <div class="acct-section">
        <div class="acct-toolbar">
          <h3>Roles</h3>
          <div class="acct-toolbar-spacer"></div>
          <button class="btn-primary" type="button" data-ac="new-role">New Role</button>
        </div>
        <div class="acct-list">${rows}</div>
        <div class="info-box">A role is a reusable bundle of permissions. Assign one to an
        account, then grant anything extra on that account directly. The
        <code style="font-family:var(--font-mono)">admin</code> role always holds every
        permission and cannot be edited.</div>
      </div>
      <div data-ac="role-editor-slot">${_editing && _editing.kind === 'role' ? roleEditor(_editing) : ''}</div>`;
  }

  function roleEditor(state) {
    const isNew = state.mode === 'new';
    const r = state.role || {};
    return `
    <form class="acct-editor" data-ac="save-role" data-mode="${esc(state.mode)}" data-role="${esc(r.name || '')}">
      <div class="acct-editor-title">${isNew ? 'New role' : `Editing ${esc(r.name)}`}</div>
      <div class="acct-form-grid">
        <div class="form-group">
          <label for="ac-rn">Name</label>
          <input class="input" id="ac-rn" name="name" value="${esc(r.name || '')}" ${isNew ? 'required autocomplete="off"' : 'readonly'}>
        </div>
        <div class="form-group">
          <label for="ac-rd">Description</label>
          <input class="input" id="ac-rd" name="description" value="${esc(r.description || '')}">
        </div>
        <div class="form-group full">
          <label>Permissions</label>
          ${permChecklist(r.permissions || [], [])}
        </div>
      </div>
      <div class="acct-toolbar" style="margin-top:12px">
        <button class="btn-primary" type="submit">${isNew ? 'Create Role' : 'Save Role'}</button>
        <button class="btn-ghost" type="button" data-ac="cancel-edit">Cancel</button>
      </div>
    </form>`;
  }

  const SETTING_HELP = {
    allow_self_password_change: ['Users can change their own password',
      'When off, only an administrator can set any password - including a user\'s own.'],
    session_ttl_hours: ['Session lifetime',
      'How long a sign-in stays valid before the user has to log in again, in hours.'],
    min_password_length: ['Minimum password length',
      'Enforced on every password change. Existing passwords are not re-checked.'],
    revoke_sessions_on_disable: ['Sign out disabled accounts immediately',
      'When off, a disabled account keeps working until its session expires on its own.'],
  };

  function renderGlobal() {
    const pane = _els.panes.global;
    const keys = Object.keys(SETTING_HELP).filter(k => k in _settings);
    const list = (keys.length ? keys : Object.keys(SETTING_HELP)).map(key => {
      const [label, desc] = SETTING_HELP[key] || [key, ''];
      const val = _settings[key];
      const control = typeof val === 'boolean' || val === undefined
        ? `<label class="toggle-switch">
             <input type="checkbox" data-ac="setting" data-key="${esc(key)}" data-type="bool" ${val ? 'checked' : ''}>
             <span class="toggle-slider"></span>
           </label>`
        : `<input class="input-sm" style="width:90px" type="number" min="1"
                  value="${esc(val)}" data-ac="setting" data-key="${esc(key)}" data-type="number">`;
      return `
      <div class="setting-row">
        <div class="setting-row-text">
          <div class="setting-label">${esc(label)}</div>
          <div class="setting-desc">${esc(desc)}</div>
        </div>
        <div class="setting-controls">${control}</div>
      </div>`;
    }).join('');

    pane.innerHTML = `
      <div class="acct-section">
        <h3>Global permissions</h3>
        <div class="section-desc">Install-wide switches. These apply on top of each
        account's own permissions, so a capability can be withdrawn everywhere without
        editing every account.</div>
        ${list}
      </div>`;
  }

  function onClick(e) {
    const btn = e.target.closest('[data-ac]');
    if (!btn) return;
    const act = btn.getAttribute('data-ac');

    if (act === 'tab') {
      _tab = btn.getAttribute('data-tab');
      _editing = null;
      render();
      return;
    }
    if (act === 'signout') { signOut(); return; }
    if (act === 'new')  { _editing = { kind: 'user', mode: 'new', user: {} }; render(); return; }
    if (act === 'edit') {
      const u = _users.find(x => x.username === btn.getAttribute('data-user'));
      if (u) { _editing = { kind: 'user', mode: 'edit', user: u }; render(); }
      return;
    }
    if (act === 'cancel-edit') { _editing = null; render(); return; }
    if (act === 'setpw')  { setUserPassword(btn.getAttribute('data-user')); return; }
    if (act === 'toggle') { toggleUser(btn.getAttribute('data-user'), btn.getAttribute('data-on') === '1'); return; }
    if (act === 'delete') { deleteUser(btn.getAttribute('data-user')); return; }
    if (act === 'new-role') { _editing = { kind: 'role', mode: 'new', role: {} }; render(); return; }
    if (act === 'edit-role') {
      const r = _roles.find(x => x.name === btn.getAttribute('data-role'));
      if (r) { _editing = { kind: 'role', mode: 'edit', role: r }; render(); }
      return;
    }
    if (act === 'del-role') { deleteRole(btn.getAttribute('data-role')); return; }
  }

  // Change events for the Global toggles/numbers ride the same delegated path.
  function onChangeSetting(e) {
    const el = e.target.closest('[data-ac="setting"]');
    if (!el) return;
    const key = el.getAttribute('data-key');
    const value = el.getAttribute('data-type') === 'bool' ? el.checked : Number(el.value);
    acct(['settings', '--set', `${key}=${JSON.stringify(value)}`])
      .then(r => { _settings = (r && r.settings) || _settings; done('Setting saved'); })
      .catch(err => { fail(err); refresh().then(render); });
  }

  function onSubmit(e) {
    const form = e.target.closest('form[data-ac]');
    if (!form) return;
    e.preventDefault();
    const act = form.getAttribute('data-ac');
    if (act === 'self-password') selfPassword(form);
    else if (act === 'save-user') saveUser(form);
    else if (act === 'save-role') saveRole(form);
  }

  async function selfPassword(form) {
    const current = form.current.value;
    const next = form.next.value;
    const confirm = form.confirm.value;
    if (next !== confirm) { fail(new Error('The new passwords do not match.')); return; }

    const r = await _post('/api/change-password', { currentPassword: current, newPassword: next });
    // Never leave a password sitting in the DOM.
    form.reset();
    if (!r.ok) { fail(new Error(r.error || 'Could not change the password')); return; }

    sessionStorage.removeItem('mcpanel_must_change_password');
    if (_me) _me.mustChangePassword = false;

    // The accounts addon revokes every session belonging to an account whose
    // password changed - including this one - and the server clears the cookie
    // to match. Staying on the page would leave every later request 401ing for
    // no visible reason, so send the user back to sign in.
    if (r.reauth) {
      done('Password changed - please sign in again');
      setTimeout(() => location.reload(), 1200);
      return;
    }
    done('Password changed');
    render();
  }

  async function saveUser(form) {
    const mode = form.getAttribute('data-mode');
    const username = form.username.value.trim();
    const role = form.role.value;
    const perms = Array.from(form.querySelectorAll('input[name="perm"]:not(:disabled)'))
      .filter(i => i.checked).map(i => i.value);

    try {
      if (mode === 'new') {
        const args = ['create', '-u', username, '-p', form.password.value];
        if (role) args.push('-r', role);
        if (perms.length) args.push('--perms', perms.join(','));
        await acct(args);
        done(`Account "${username}" created`);
      } else {
        const args = ['update', '-u', username];
        if (role) args.push('-r', role); else args.push('--clear-role');
        args.push('--perms', perms.join(','));
        await acct(args);
        done(`Account "${username}" updated`);
      }
      form.reset();
      _editing = null;
      await refresh();
      render();
    } catch (e) { fail(e); }
  }

  async function setUserPassword(username) {
    const pw = window.prompt(`New password for "${username}":`);
    if (pw === null) return;
    if (!pw) { fail(new Error('Password cannot be empty.')); return; }
    try {
      await acct(['passwd', '-u', username, '-p', pw]);
      done(`Password updated for "${username}"`);
    } catch (e) { fail(e); }
  }

  async function toggleUser(username, enabled) {
    const turningOff = enabled;
    if (turningOff && _me && username === _me.username) {
      const ok = await confirmish('Disable your own account?',
        `You are about to disable "${username}", which is the account you are signed in as. You will be signed out and will not be able to sign back in.`,
        'Disable');
      if (!ok) return;
    }
    try {
      await acct(['update', '-u', username, turningOff ? '--disable' : '--enable']);
      done(`"${username}" ${turningOff ? 'disabled' : 'enabled'}`);
      await refresh();
      render();
    } catch (e) { fail(e); }
  }

  async function deleteUser(username) {
    const isMe = _me && username === _me.username;
    const ok = await confirmish(
      'Delete account?',
      isMe
        ? `"${username}" is the account you are signed in as. Deleting it will sign you out immediately and cannot be undone.`
        : `The account "${username}" will be permanently deleted. This cannot be undone.`,
      'Delete');
    if (!ok) return;
    try {
      await acct(['delete', '-u', username]);
      done(`Account "${username}" deleted`);
      await refresh();
      render();
    } catch (e) { fail(e); }
  }

  async function saveRole(form) {
    const mode = form.getAttribute('data-mode');
    const name = form.name.value.trim();
    const description = form.description.value;
    const perms = Array.from(form.querySelectorAll('input[name="perm"]:not(:disabled)'))
      .filter(i => i.checked).map(i => i.value);
    try {
      const args = [mode === 'new' ? 'create' : 'update', '-n', name,
                    '--desc', description, '--perms', perms.join(',')];
      await acct(['roles', ...args]);
      done(`Role "${name}" ${mode === 'new' ? 'created' : 'saved'}`);
      _editing = null;
      await refresh();
      render();
    } catch (e) { fail(e); }
  }

  async function deleteRole(name) {
    const ok = await confirmish('Delete role?',
      `The role "${name}" will be deleted. Accounts using it will be left with no role.`, 'Delete');
    if (!ok) return;
    try {
      await acct(['roles', 'delete', '-n', name]);
      done(`Role "${name}" deleted`);
      await refresh();
      render();
    } catch (e) { fail(e); }
  }

  async function signOut() {
    try { await _post('/api/logout', {}); } catch { /* leaving anyway */ }
    sessionStorage.removeItem('mcpanel_must_change_password');
    location.reload();
  }

  // app.js's confirmDialog is the app's own styled confirm; fall back to the
  // browser's when this file loads into a page that somehow lacks it.
  function confirmish(title, message, confirmLabel) {
    if (typeof window.confirmDialog === 'function') {
      return window.confirmDialog({ title, message, confirmLabel });
    }
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  function injectSidebarButton() {
    const icons = document.querySelector('.sidebar-footer-icons');
    if (!icons || icons.querySelector('[data-ac="open-accounts"]')) return;

    const btn = document.createElement('button');
    btn.className = 'sidebar-icon-btn';
    btn.type = 'button';
    btn.setAttribute('data-ac', 'open-accounts');
    btn.innerHTML = ICON_USER;
    btn.title = _me ? `Signed in as ${_me.username} - accounts & permissions`
                    : 'Accounts & permissions';
    btn.addEventListener('click', () => open('me'));
    icons.appendChild(btn);
  }

  async function boot() {
    build();
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      _me = (body && (body.user || body.value || body)) || null;
      if (_me && !_me.username) _me = null;
    } catch { _me = null; }

    injectSidebarButton();

    // The login page flags an account still using the seeded password; surface
    // it once the panel is up rather than blocking the way in.
    if (sessionStorage.getItem('mcpanel_must_change_password') === '1' ||
        (_me && _me.mustChangePassword)) {
      setTimeout(() => open('me'), 900);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Exposed so other panel code (and the console) can reach it by name, mirroring
  // how app.js exposes its own modal openers.
  window.openAccounts = open;
  window.closeAccounts = close;
})();

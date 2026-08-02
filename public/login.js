/* ═══════════════════════════════════════════════════════
   MCPanel WebUI - sign-in

   The panel itself (index.html / app.js / web-bridge.js) is never served to
   an unauthenticated client, so this page is the whole of the pre-login
   surface. It talks to three endpoints:

     POST /api/login   { username, password }  → sets the session cookie
     GET  /api/me                              → who am I (used to skip the
                                                 form when already signed in)
     POST /api/invoke                          → get_default_theme /
                                                 get_theme_css, the two
                                                 commands reachable logged out

   No framework, no build step - same as the rest of public/.
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const form        = document.getElementById('login-form');
  const usernameEl  = document.getElementById('login-username');
  const passwordEl  = document.getElementById('login-password');
  const submitEl    = document.getElementById('login-submit');
  const labelEl     = document.getElementById('login-submit-label');
  const spinnerEl   = document.getElementById('login-spinner');
  const errorEl     = document.getElementById('login-error');
  const capsEl      = document.getElementById('login-caps');

  let busy = false;
  let leaving = false;   // set once we start navigating into the panel

  // ─── Theme ───────────────────────────────────────────────────────────────
  // Mirrors app.js's loadAndApplyTheme(): read the CSS, drop it into
  // #theme-override. Doing it here means the sign-in screen already matches
  // whatever theme the panel is set to, rather than always showing stock
  // Purple Dark and then flipping after login.

  async function invoke(cmd, args) {
    const res = await fetch('/api/invoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, args: args || {} }),
    });
    const body = await res.json();
    if (!body || body.ok !== true) throw new Error((body && body.error) || 'Request failed');
    return body.value;
  }

  async function applyDefaultTheme() {
    try {
      const id = await invoke('get_default_theme');
      if (!id) return;
      const css = await invoke('get_theme_css', { id: id });
      document.getElementById('theme-override').textContent = css || '';
    } catch (e) {
      // style.css alone is a complete, correct theme - a failure here costs
      // nothing but the user's colour preference.
    }
  }

  // ─── Already signed in? ──────────────────────────────────────────────────
  // Only when the page was reached at an explicit path. At "/" the server
  // decides what to serve, so asking again there could ping-pong forever if
  // the two ever disagreed.

  async function skipIfAuthenticated() {
    if (location.pathname === '/') return;
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = await res.json();
      if (body && body.ok && body.user) {
        leaving = true;
        location.replace('/');
      }
    } catch (e) { /* offline or not signed in - show the form */ }
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  function setBusy(state) {
    busy = state;
    submitEl.disabled = state;
    spinnerEl.classList.toggle('hidden', !state);
    labelEl.textContent = state ? 'Signing in…' : 'Sign in';
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;

    const username = usernameEl.value.trim();
    const password = passwordEl.value;

    if (!username || !password) {
      showError('Enter your username and password.');
      (username ? passwordEl : usernameEl).focus();
      return;
    }

    clearError();
    setBusy(true);

    let res, body;
    try {
      res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password }),
      });
      body = await res.json().catch(function () { return null; });
    } catch (err) {
      setBusy(false);
      showError('Could not reach the panel. Check that the MCPanel WebUI server is still running.');
      return;
    }

    if (res.ok && body && body.ok) {
      // The seeded admin account still has the default password. Hand that
      // fact to the panel rather than blocking entry on it - public/accounts-ui.js
      // reads exactly this sessionStorage key and prompts for a change.
      if (body.user && body.user.mustChangePassword) {
        try { sessionStorage.setItem('mcpanel_must_change_password', '1'); } catch (e) { /* private mode */ }
      }
      leaving = true;
      labelEl.textContent = 'Signed in';
      location.replace('/');
      return;
    }

    setBusy(false);

    // The backend deliberately answers with one message for both an unknown
    // user and a wrong password, and its own wording for a rate-limit block.
    // Pass it through untouched - narrowing it here would hand an attacker
    // the account-enumeration oracle the backend just refused to give them.
    showError((body && body.error) || 'Sign in failed. Please try again.');

    passwordEl.value = '';
    passwordEl.focus();
  }

  // ─── Caps Lock hint ──────────────────────────────────────────────────────
  // A silent wrong-password loop is the single most common way people lock
  // themselves out of a panel like this.

  function onKeyEvent(e) {
    if (typeof e.getModifierState !== 'function') return;
    capsEl.classList.toggle('hidden', !e.getModifierState('CapsLock'));
  }

  form.addEventListener('submit', onSubmit);
  passwordEl.addEventListener('keydown', onKeyEvent);
  passwordEl.addEventListener('keyup', onKeyEvent);
  passwordEl.addEventListener('blur', function () { capsEl.classList.add('hidden'); });
  usernameEl.addEventListener('input', clearError);
  passwordEl.addEventListener('input', clearError);

  // A restored bfcache page would otherwise still show "Signing in…".
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && !leaving) setBusy(false);
  });

  applyDefaultTheme();
  skipIfAuthenticated();

  // autofocus is declared in the markup, but Safari drops it when the page is
  // restored from history.
  if (!usernameEl.value) usernameEl.focus();
})();

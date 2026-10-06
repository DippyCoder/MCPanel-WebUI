/* ═══════════════════════════════════════════════════════
   MCPanel Web Bridge - exposes window.mcpanel with the
   same API surface as the Tauri preload, but backed by
   HTTP RPC + a WebSocket to the Node backend / mcpanel CLI.

   This file is tauri-bridge.js with the transport swapped:
   invoke() becomes POST /api/invoke, and Tauri's event
   channels become frames on /ws. Everything above it -
   index.html, style.css, app.js - is byte-identical to the
   desktop app, so the UI is unchanged.
   ═══════════════════════════════════════════════════════ */

(function () {
  // NOTE: the Tauri bridge adds a `linux` class here so CSS can skip
  // backdrop-filter: blur(), which crashes WebKit2GTK when compositing is
  // disabled. Real browsers have no such bug, and adding the class would
  // visibly flatten the modal blur, so it is deliberately omitted.

  // ─── Transport ───────────────────────────────────────────────────────────────
  // A token is only in play when the server was started with --token; it is
  // handed to us as a query param on first load and then lives in a cookie, so
  // fetch() only needs same-origin credentials. The WebSocket URL can't carry
  // cookies reliably across every browser, so it repeats the token explicitly.
  const _token = new URLSearchParams(location.search).get('token');

  // Errors keep the backend's machine-readable `code` next to its message.
  // The message is always shown as-is (the CLI owns the wording); `code` is
  // only for logic, so a code this build has never heard of still displays.
  function _coded(message, code) {
    return Object.assign(new Error(message), { code: code || 'error' });
  }

  async function _invoke(cmd, args) {
    // PTY sessions are keyed to the socket that opened them on the backend, so
    // terminal traffic has to travel over the WebSocket rather than HTTP.
    if (cmd === 'pty_open' || cmd === 'pty_write' || cmd === 'pty_resize' || cmd === 'pty_close') {
      return _wsInvoke(cmd, args);
    }
    let res;
    try {
      res = await fetch('/api/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ cmd, args: args || {} }),
      });
    } catch (e) {
      throw _coded(`MCPanel WebUI server unreachable: ${e.message}`, 'webui_unreachable');
    }
    let body;
    try { body = await res.json(); }
    catch {
      if (res.status === 401) throw _coded('Unauthorized - check the WebUI token', 'unauthorized');
      throw _coded(`Malformed response from ${cmd}`, 'bad_response');
    }
    // app.js relies on rejections for its try/catch and .catch() paths, so an
    // error result must become a real rejected promise, never a value.
    if (!body || body.ok !== true) {
      throw _coded((body && body.error) || `${cmd} failed`, body && body.code);
    }
    return body.value;
  }

  // ─── WebSocket (events + PTY) ────────────────────────────────────────────────
  // Handlers live here on the client, so a reconnect silently resumes delivery
  // to whatever callbacks were already registered - no re-subscription needed.
  const _channelHandlers = {};   // channel → Set<fn>
  let _ws = null;
  let _wsBackoff = 500;

  function _wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws${_token ? `?token=${encodeURIComponent(_token)}` : ''}`;
  }

  function _connect() {
    let sock;
    try { sock = new WebSocket(_wsUrl()); }
    catch { setTimeout(_connect, _wsBackoff); return; }
    _ws = sock;

    sock.onopen = () => {
      if (_wsBackoff !== 500) console.log('[MCPanel] event socket reconnected');
      _wsBackoff = 500;
    };
    sock.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      const set = _channelHandlers[frame.channel];
      if (!set) return;
      // Tauri handed listeners an event object, not the bare payload.
      for (const fn of Array.from(set)) {
        try { fn({ payload: frame.payload }); } catch (e) { console.error(e); }
      }
    };
    sock.onclose = () => {
      if (_ws === sock) _ws = null;
      console.log(`[MCPanel] event socket closed - retrying in ${_wsBackoff}ms`);
      setTimeout(_connect, _wsBackoff);
      _wsBackoff = Math.min(_wsBackoff * 2, 5000);
    };
    sock.onerror = () => { try { sock.close(); } catch { /* onclose handles retry */ } };
  }
  _connect();

  // PTY commands are fire-and-forget: the backend answers with pty-data /
  // pty-closed events rather than a per-call reply.
  function _wsInvoke(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Terminal connection is not open'));
        return;
      }
      _ws.send(JSON.stringify({ cmd, args: args || {} }));
      resolve(null);
    });
  }

  function _listen(channel, cb) {
    if (!_channelHandlers[channel]) _channelHandlers[channel] = new Set();
    _channelHandlers[channel].add(cb);
    return Promise.resolve(() => { _channelHandlers[channel].delete(cb); });
  }

  // Resolves true/false after the startup CLI check completes.
  // app.js waits on this before calling init() so no CLI subprocess is ever
  // spawned until we confirm the real CLI tool is present.
  let _cliReadyResolve;
  window._cliReady = new Promise(resolve => { _cliReadyResolve = resolve; });

  async function cli(args) {
    // Block until check is done AND it passed. This prevents run_cli from
    // spawning subprocesses before we know mcpanel resolves to the CLI tool.
    if (window._cliOk !== true) throw _coded('MCPanel-CLI is not available', 'cli_unavailable');
    const raw = await _invoke('run_cli', { args });
    // CLI failures arrive as {error, code} documents and are returned as
    // values, exactly like successes - callers check `.error`.
    try { return JSON.parse(raw); }
    catch { throw _coded(`MCPanel-CLI returned unreadable output: ${String(raw).slice(0, 300)}`, 'cli_bad_output'); }
  }

  // cli(), but a failure to run the CLI at all also becomes an {error, code}
  // value - for calls whose callers only ever check `.error`.
  async function _cliSafe(args) {
    try { return await cli(args); }
    catch (e) { return { error: e.message, code: e.code || 'error' }; }
  }

  // mcpanel.json is the server's own manifest (id, dir, etc.) - not something
  // a user should see or touch from the file browser.
  function _stripMcpanelJson(nodes) {
    if (!Array.isArray(nodes)) return nodes;
    return nodes
      .filter(n => n.name !== 'mcpanel.json')
      .map(n => n.children ? { ...n, children: _stripMcpanelJson(n.children) } : n);
  }

  const _listeners = {};   // channel → [{original, wrapped, unlisten}]

  function on(channel, cb) {
    const allowed = ['server-log', 'server-stopped', 'download-progress', 'backup-progress', 'schedule-fired'];
    if (!allowed.includes(channel)) return;
    if (!_listeners[channel]) _listeners[channel] = [];
    const wrapped = (e) => cb(e.payload);
    const entry = { original: cb, wrapped, unlisten: null };
    _listeners[channel].push(entry);
    _listen(channel, wrapped).then(unlisten => { entry.unlisten = unlisten; });
  }

  function off(channel, cb) {
    if (!_listeners[channel]) return;
    const idx = _listeners[channel].findIndex(e => e.original === cb);
    if (idx !== -1) {
      const e = _listeners[channel].splice(idx, 1)[0];
      if (e.unlisten) e.unlisten();
    }
  }

  // ─── Tauri shims ─────────────────────────────────────────────────────────────
  // app.js reaches for these globals directly (for the PTY and for drag-drop),
  // and app.js must stay byte-identical to the desktop build - so the globals
  // are provided here rather than editing the caller.
  const _winListeners = {};   // channel → Set<fn>, for the window-scoped shim

  function _winListen(channel, cb) {
    if (!_winListeners[channel]) _winListeners[channel] = new Set();
    _winListeners[channel].add(cb);
    return Promise.resolve(() => { _winListeners[channel].delete(cb); });
  }

  window.__TAURI_INTERNALS__ = { invoke: (cmd, args) => _invoke(cmd, args) };
  window.__TAURI__ = {
    event: { listen: (channel, cb) => _listen(channel, cb) },
    window: {
      getCurrentWindow: () => ({
        listen: (channel, cb) => _winListen(channel, cb),
        minimize,
        toggleMaximize: maximize,
        startResizeDragging,
      }),
    },
  };

  // ─── Drag-drop ───────────────────────────────────────────────────────────────
  // Tauri intercepted OS drops at the window level and handed app.js real
  // filesystem paths via `tauri://drag-drop`. A browser instead fires ordinary
  // DOM drop events, which app.js ALREADY handles on its own drop zones
  // (_handleDrop → uploadFiles). Synthesising `tauri://drag-drop` for every
  // drop would therefore upload each file twice.
  //
  // The one case the browser path cannot cover is a dropped FOLDER:
  // dataTransfer.files has no usable entry for it. So this handler runs in the
  // capture phase, and only when a directory is present does it take over -
  // stopping the event before app.js's own handlers see it, streaming the tree
  // to /api/upload-stage, and then firing `tauri://drag-drop` with the staged
  // paths so app.js's existing Tauri handler runs completely unchanged.
  function _dropHasDirectory(dt) {
    if (!dt || !dt.items) return false;
    for (const item of dt.items) {
      if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
      const entry = item.webkitGetAsEntry();
      if (entry && entry.isDirectory) return true;
    }
    return false;
  }

  // Walks a webkit FileSystemEntry into a flat [{file, rel}] list, where `rel`
  // keeps the folder structure ("myplugin/config.yml").
  function _readEntry(entry, prefix, out) {
    return new Promise(resolve => {
      if (entry.isFile) {
        entry.file(
          file => { out.push({ file, rel: prefix + entry.name }); resolve(); },
          () => resolve()
        );
        return;
      }
      if (!entry.isDirectory) { resolve(); return; }

      const reader = entry.createReader();
      const collected = [];
      // readEntries() returns at most ~100 entries per call, so it has to be
      // drained until it yields an empty batch.
      const readBatch = () => reader.readEntries(
        batch => {
          if (!batch.length) {
            Promise.all(collected.map(e => _readEntry(e, `${prefix}${entry.name}/`, out)))
              .then(resolve);
            return;
          }
          collected.push(...batch);
          readBatch();
        },
        () => resolve()
      );
      readBatch();
    });
  }

  async function _stageDrop(entries) {
    const batch = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const files = [];
    for (const entry of entries) await _readEntry(entry, '', files);

    const paths = new Set();
    for (const { file, rel } of files) {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/upload-stage', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-file-path': encodeURIComponent(rel),
          'x-file-name': encodeURIComponent(file.name),
          'x-batch-id': batch,
        },
        body: buf,
      });
      const body = await res.json().catch(() => null);
      if (body && body.ok && body.path) paths.add(body.path);
    }
    return { batch, paths: Array.from(paths) };
  }

  // app.js's `getDroppedPaths` reads `text/uri-list` first and, when it finds
  // one, decodes `file:///…` into an absolute path and sends THAT to the
  // backend as a source path to copy - the WebKit2GTK workaround, where
  // dataTransfer.files came back empty. Some browsers (Firefox in particular)
  // do populate uri-list for OS file drops, which would send the *viewer's*
  // local path to the backend: fine when both are the same machine, broken
  // when the panel is open from another device.
  //
  // Blanking those two types for OS file drops makes `_handleDrop` fall
  // through to its `uploadFiles(e.dataTransfer.files)` branch, which ships the
  // actual bytes and works from anywhere - while still going through app.js's
  // own drop zones, so dropping onto a specific folder row keeps targeting
  // that row. Internal drags are untouched: app.js never calls setData, and
  // the guard only fires when the payload really is OS files.
  const _origGetData = DataTransfer.prototype.getData;
  DataTransfer.prototype.getData = function (format) {
    const f = String(format || '').toLowerCase();
    if ((f === 'text/uri-list' || f === 'text/plain') &&
        Array.from(this.types || []).includes('Files')) {
      return '';
    }
    return _origGetData.call(this, format);
  };

  window.addEventListener('dragover', e => {
    // Without this the browser navigates away to the dropped file.
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
  }, true);

  window.addEventListener('drop', e => {
    if (!_dropHasDirectory(e.dataTransfer)) return;   // plain files: app.js has it
    e.preventDefault();
    e.stopPropagation();

    // dataTransfer is neutered once this handler returns, so the entries must
    // be captured synchronously - and so must the cursor position, which
    // app.js uses to drop into the folder row under it.
    const position = { x: e.clientX, y: e.clientY };
    const entries = [];
    for (const item of e.dataTransfer.items) {
      if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
      const entry = item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }

    (async () => {
      const { batch, paths } = await _stageDrop(entries);
      if (!paths.length) return;
      const handlers = Array.from(_winListeners['tauri://drag-drop'] || []);
      // app.js's handler is async and awaits the upload, so awaiting it here
      // means the staging area is only cleared once the copy has finished.
      await Promise.all(handlers.map(fn => {
        try { return Promise.resolve(fn({ payload: { paths, position, logical: true } })); }
        catch (err) { console.error(err); return Promise.resolve(); }
      }));
      fetch('/api/upload-stage/clear', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch }),
      }).catch(() => {});
    })().catch(err => {
      console.error('[MCPanel] drop staging failed', err);
      if (typeof window.toast === 'function') window.toast(`Upload failed: ${err.message}`, 'error');
    });
  }, true);

  // ─── Path picker ─────────────────────────────────────────────────────────────
  // browse_folder / browse_file were native OS dialogs. A page can't open one
  // that returns a server-side path, so this is an in-app picker over the
  // backend's list_dir command. It is built out of the app's own modal markup
  // and CSS classes, so all four themes restyle it for free.
  let _pickerEls = null;
  let _pickerResolve = null;

  const _PICKER_CSS = `
.pathpick-bar {
  display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
}
.pathpick-bar .pathpick-cwd {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-input, var(--bg-elevated)); padding: 7px 9px;
}
.pathpick-roots { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.pathpick-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.pathpick-foot .pathpick-sel {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);
}
.pathpick-empty { padding: 14px; text-align: center; font-size: 12px; color: var(--text-muted); }
`;

  const _ICON_DIR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const _ICON_FILE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

  function _buildPicker() {
    if (_pickerEls) return _pickerEls;

    const style = document.createElement('style');
    style.textContent = _PICKER_CSS;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay hidden';
    overlay.id = 'modal-path-picker';
    overlay.innerHTML = `
  <div class="modal small">
    <div class="modal-header">
      <h2 class="pathpick-title">Select Folder</h2>
      <button class="modal-close" type="button" data-pp="cancel">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="pathpick-bar">
        <button class="btn-ghost-sm" type="button" data-pp="up">Up</button>
        <div class="pathpick-cwd"></div>
      </div>
      <div class="pathpick-roots"></div>
      <div class="file-move-tree pathpick-list"></div>
      <div class="pathpick-foot">
        <label class="checkbox-item">
          <input type="checkbox" data-pp="hidden"> Show hidden
        </label>
        <span class="pathpick-sel"></span>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" type="button" data-pp="cancel">Cancel</button>
      <button class="btn-primary" type="button" data-pp="ok">Select Folder</button>
    </div>
  </div>`;
    document.body.appendChild(overlay);

    _pickerEls = {
      overlay,
      title: overlay.querySelector('.pathpick-title'),
      cwd: overlay.querySelector('.pathpick-cwd'),
      roots: overlay.querySelector('.pathpick-roots'),
      list: overlay.querySelector('.pathpick-list'),
      sel: overlay.querySelector('.pathpick-sel'),
      hidden: overlay.querySelector('[data-pp="hidden"]'),
      ok: overlay.querySelector('[data-pp="ok"]'),
      up: overlay.querySelector('[data-pp="up"]'),
    };
    // The modal is injected after app.js parsed, so app.js's overlay-click
    // handler never bound to it - closing has to be wired up here, and it must
    // settle the promise rather than just hiding the node.
    overlay.addEventListener('click', e => {
      if (e.target === overlay) _finishPick(null);
      if (e.target.closest('[data-pp="cancel"]')) _finishPick(null);
    });
    document.addEventListener('keydown', e => {
      if (_pickerResolve && e.key === 'Escape') _finishPick(null);
    });
    return _pickerEls;
  }

  function _finishPick(value) {
    if (!_pickerResolve) return;
    _pickerEls.overlay.classList.add('hidden');
    const resolve = _pickerResolve;
    _pickerResolve = null;
    resolve(value);
  }

  function _extAllowed(name, extensions) {
    if (!extensions || !extensions.length || extensions.includes('*')) return true;
    const lower = name.toLowerCase();
    return extensions.some(ext => lower.endsWith(`.${String(ext).toLowerCase()}`));
  }

  function _pickPath({ mode, title, extensions }) {
    const els = _buildPicker();
    // A second picker while one is open would orphan the first promise.
    if (_pickerResolve) _finishPick(null);

    els.title.textContent = title || (mode === 'folder' ? 'Select Folder' : 'Select File');
    els.ok.textContent = mode === 'folder' ? 'Select Folder' : 'Open';
    els.overlay.classList.remove('hidden');

    let cwd = null;          // null = let the backend start at $HOME
    let parent = null;
    let chosenFile = null;   // file mode only

    async function render(target) {
      let info;
      try {
        info = await _invoke('list_dir', { path: target });
      } catch (e) {
        els.list.innerHTML = `<div class="pathpick-empty">${e.message}</div>`;
        return;
      }
      cwd = info.path;
      parent = info.parent;
      chosenFile = null;
      els.cwd.textContent = cwd;
      els.sel.textContent = '';
      els.up.disabled = !parent;
      els.ok.disabled = mode === 'file';

      els.roots.innerHTML = '';
      for (const root of info.roots || []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-ghost-sm';
        b.textContent = root.name || root.path;
        b.onclick = () => render(root.path);
        els.roots.appendChild(b);
      }

      const entries = (info.entries || [])
        .filter(en => els.hidden.checked || !en.hidden)
        .filter(en => en.type === 'dir' || (mode === 'file' && _extAllowed(en.name, extensions)));

      els.list.innerHTML = '';
      if (!entries.length) {
        els.list.innerHTML = '<div class="pathpick-empty">Nothing here</div>';
        return;
      }
      for (const en of entries) {
        const row = document.createElement('div');
        row.className = 'file-move-row';
        row.innerHTML = `${en.type === 'dir' ? _ICON_DIR : _ICON_FILE}<span class="file-move-name"></span>`;
        row.querySelector('.file-move-name').textContent = en.name;
        if (en.type === 'dir') {
          row.ondblclick = () => render(en.path);
        } else {
          row.onclick = () => {
            els.list.querySelectorAll('.file-move-row.selected').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
            chosenFile = en.path;
            els.sel.textContent = en.name;
            els.ok.disabled = false;
          };
          row.ondblclick = () => _finishPick(en.path);
        }
        els.list.appendChild(row);
      }
    }

    els.up.onclick = () => { if (parent) render(parent); };
    els.hidden.onchange = () => render(cwd);
    els.ok.onclick = () => _finishPick(mode === 'folder' ? cwd : chosenFile);

    render(null);
    return new Promise(resolve => { _pickerResolve = resolve; });
  }

  function minimize() {
    // A page cannot minimize its own browser window.
    console.log('[MCPanel] minimize is not available in the WebUI');
  }
  function maximize() {
    // Fullscreen is the closest browser equivalent to the desktop maximize.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  async function close() {
    const ask = typeof window.confirmDialog === 'function'
      ? window.confirmDialog({
          title: 'Quit MCPanel-WebUI',
          message: 'This stops the MCPanel WebUI server. Running Minecraft servers keep running.',
          confirmLabel: 'Quit',
        })
      : Promise.resolve(window.confirm('Stop the MCPanel WebUI server?'));
    if (!await ask) return;
    try { await _invoke('quit_app'); } catch { /* the server exiting mid-request is expected */ }
    _showStoppedOverlay();
  }
  function startResizeDragging() {
    // The browser owns window resizing.
  }

  function _showStoppedOverlay() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;'
      + 'justify-content:center;background:var(--bg-base,#111);color:var(--text-primary,#eee);'
      + 'font-family:var(--font-display,sans-serif);font-size:14px';
    el.textContent = 'MCPanel WebUI stopped - you can close this tab.';
    document.body.appendChild(el);
  }

  window.mcpanel = {
    // Which frontend this is - addon UI scripts (addons-ui.js) read it.
    product: 'webui',
    // Raw `mcpanel api <args…>` for addon UI scripts and the addon browser.
    // CLI failures resolve as {error, code} documents; failing to reach the
    // CLI at all rejects with an Error carrying `.code`.
    cli: (args) => cli(Array.isArray(args) ? args.map(String) : []),
    getConfig: async () => {
      try { return await cli(['config', 'show']); }
      catch { return { servers: [], jdkPaths: [], activeTheme: null }; }
    },
    saveConfig: (cfg) => _invoke('save_config', { config: cfg }),

    fetchVersions: async (software, preRelease = false, unstable = false) => {
      const args = ['versions', '-sw', software];
      if (unstable)   args.push('--unstable');
      if (preRelease) args.push('--prerelease');
      return cli(args);
    },

    // Servers (list comes from getConfig().servers - refreshed there)
    createServer: async (data) => {
      const args = [
        '-t',    data.name,
        '-sw',   data.software,
        '-v',    data.version,
        '-p',    String(data.port),
        '-ram',  data.ram,
      ];
      if (data.javaPath && data.javaPath !== 'java') {
        args.push('-java', data.javaPath);
      }
      if (data.javaArgs) args.push('-jargs', data.javaArgs);
      if (data.profileId) args.push('-profile', data.profileId);
      if (data.storageLimit) args.push('-storage', data.storageLimit);
      if (data.unstableBuilds) args.push('--unstable');
      const raw = await _invoke('create_server', { args });
      return JSON.parse(raw);
    },

    // keepFiles: only remove it from MCPanel's list ("Remove"); otherwise the
    // server's files are deleted too - a linked server's original folder included.
    deleteServer: async (id, { keepFiles = false } = {}) => {
      const args = ['delete', 'server', '-id', id];
      if (keepFiles) args.push('--keep-files');
      return cli(args);
    },

    updateServer: async (id, updates) => {
      const raw = await _invoke('update_server', { id, updates });
      return JSON.parse(raw);
    },

    startServer: async (id) => {
      const raw = await _invoke('start_server', { id });
      return JSON.parse(raw);
    },

    stopServer: (id) => cli(['stop', 'server', '-id', id]),

    killServer: (id) => cli(['kill', 'server', '-id', id]),

    restartServer: (id) => cli(['restart', 'server', '-id', id]),

    sendCommand: (id, cmd) => {
      return _invoke('send_server_command', { id, cmd });
    },

    getServerLog: async (id) => {
      const result = await cli(['fetch', 'log', '-id', id]);
      return Array.isArray(result) ? result : [];
    },

    // The server's own logs/ folder (Logs tab). All three resolve to the CLI's
    // document - an {error, code} one included - and never throw.
    listLogFiles: (id) => _cliSafe(['fetch', 'logfiles', '-id', id]),
    readLogFile: (id, file) => _cliSafe(['fetch', 'logfile', '-id', id, '-file', file]),
    // Uploads (at most the newest 10k lines / 25 MB of) a log file to mclo.gs.
    uploadLog: (id, file) => _cliSafe(['upload-log', '-id', id, '-file', file]),

    // Reads log entries written after `offset` bytes. Returns { lines, offset }.
    // Used by the 15 ms console poll; bypasses the CLI for low-latency file reads.
    getLogSince: (id, offset) => _invoke('get_log_since', { id, offset }),

    isServerRunning: async (id) => {
      const result = await cli(['fetch', 'status', '-id', id]);
      if (typeof result === 'boolean') return result;
      if (result && typeof result.running === 'boolean') return result.running;
      return false;
    },

    pingServer: (host, port) => _invoke('ping_server', { host, port }),

    acceptEula: async (id) => {
      const raw = await _invoke('accept_eula', { id });
      return JSON.parse(raw);
    },

    getServerDirStats: async (id) => {
      const result = await cli(['fetch', 'stats', '-id', id]);
      return result && typeof result.size === 'number' ? result : { size: 0 };
    },

    getProfiles: async () => {
      try {
        const result = await cli(['list', 'profiles']);
        return Array.isArray(result) ? result : (result.profiles || []);
      } catch { return []; }
    },

    createProfile: (data) => {
      const args = ['-t', data.name];
      if (data.description) args.push('-desc', data.description);
      if (data.software && data.software.length)
        args.push('-sw', data.software.join(','));
      if (data.versions && data.versions.length)
        args.push('-versions', data.versions.join(','));
      return cli(['create', 'profile', ...args]);
    },

    deleteProfile: (id) => cli(['delete', 'profile', '-id', id]),

    openProfileFolder: (id) => cli(['open', 'profile', '-id', id]),

    detectJdk: async () => {
      const result = await cli(['detect-jdk']);
      return Array.isArray(result) ? result : (result.jdks || []);
    },

    // Which detected JDKs can actually build/run a given software+version -
    // drives the Spigot JDK picker (BuildTools enforces an exact compile-time
    // Java range, so silent auto-detection isn't enough there).
    getJdkCompatibility: (software, version) =>
      cli(['fetch', 'jdk-compat', '-sw', software, '-v', version]),

    browseJava: () => _pickPath({
      mode: 'file',
      title: 'Select Java Executable',
      extensions: ['*'],
    }),

    browseFolder: () => _pickPath({ mode: 'folder', title: 'Select Folder' }),

    scanServerFolder: (path) =>
      cli(['scan', 'server', '-path', path]),

    scanProfileFolder: (path) =>
      cli(['scan', 'profile', '-path', path]),

    importProfile: (data) => {
      const args = ['-path', data.folderPath, '-t', data.name];
      if (data.description) args.push('-desc', data.description);
      if (data.software && data.software.length)
        args.push('-sw', data.software.join(','));
      if (data.versions && data.versions.length)
        args.push('-versions', data.versions.join(','));
      return cli(['import', 'profile', ...args]);
    },

    importServer: async (data) => {
      const args = ['-path', data.folderPath, '-t', data.name];
      if (data.port) args.push('-p', String(data.port));
      if (data.ram) args.push('-ram', data.ram);
      if (data.software) args.push('-sw', data.software);
      if (data.version) args.push('-v', data.version);
      if (data.javaPath) args.push('-java', data.javaPath);
      if (data.javaArgs) args.push('-jargs', data.javaArgs);
      // Use the folder in place instead of copying it into MCPanel's dir.
      if (data.link) args.push('--link');
      const raw = await _invoke('import_server_cmd', { args });
      return JSON.parse(raw);
    },

    getServerFileTree: async (id) => {
      const r = await cli(['fetch', 'files', '-id', id]);
      if (r && Array.isArray(r.tree)) r.tree = _stripMcpanelJson(r.tree);
      return r;
    },

    openTerminal: () => _invoke('open_terminal'),
    ptyOpen: () => _invoke('pty_open'),
    ptyWrite: (data) => _invoke('pty_write', { data }),
    ptyResize: (rows, cols) => _invoke('pty_resize', { rows, cols }),
    ptyClose: () => _invoke('pty_close'),

    getServerStartTime: (id) => _invoke('get_server_start_time', { id }),
    checkFirstStartFlag: () => _invoke('check_first_start_flag'),

    writeServerFile: (id, relPath, data) =>
      _invoke('write_server_file', { id, relPath, data }),

    uploadFilesFromPaths: (id, srcPaths, destDir) =>
      _invoke('upload_files_to_server', { id, srcPaths, destDir }),

    deleteServerFile: (id, relPath) =>
      _invoke('delete_server_file', { id, relPath }),

    createServerDir: (id, relPath) =>
      _invoke('create_server_dir', { id, relPath }),

    createServerFile: (id, relPath) =>
      _invoke('create_server_file', { id, relPath }),

    renameServerFile: (id, oldPath, newPath) =>
      _invoke('rename_server_file', { id, oldPath, newPath }),

    readServerFile: (id, relPath) =>
      _invoke('read_server_file', { id, relPath }),

    exportServerFiles: (id, relPaths, destDir) =>
      _invoke('export_server_files', { id, relPaths, destDir }),

    updateProfile: (id, data) =>
      _invoke('update_profile', { id, ...data }),
    getProfileFileTree: (id) =>
      _invoke('get_profile_file_tree', { id }),
    readProfileFile: (id, relPath) =>
      _invoke('read_profile_file', { id, relPath }),
    writeProfileFile: (id, relPath, data) =>
      _invoke('write_profile_file', { id, relPath, data }),
    deleteProfileFile: (id, relPath) =>
      _invoke('delete_profile_file', { id, relPath }),
    createProfileDir: (id, relPath) =>
      _invoke('create_profile_dir', { id, relPath }),
    createProfileFile: (id, relPath) =>
      _invoke('create_profile_file', { id, relPath }),
    renameProfileFile: (id, oldPath, newPath) =>
      _invoke('rename_profile_file', { id, oldPath, newPath }),
    uploadFilesToProfile: (id, srcPaths, destDir) =>
      _invoke('upload_files_to_profile', { id, srcPaths, destDir }),
    exportProfileFiles: (id, relPaths, destDir) =>
      _invoke('export_profile_files', { id, relPaths, destDir }),

    createProfileFromServer: async (id, profileData, selectedPaths) => {
      const args = [
        '-id', id,
        '-t', profileData.name,
        '-paths', selectedPaths.join(','),
      ];
      if (profileData.description) args.push('-desc', profileData.description);
      if (profileData.software && profileData.software.length)
        args.push('-sw', profileData.software.join(','));
      if (profileData.versions && profileData.versions.length)
        args.push('-versions', profileData.versions.join(','));
      return cli(['create', 'profile-from-server', ...args]);
    },

    duplicateServer: async (id, newName) => {
      const raw = await _invoke('duplicate_server', { id, newName });
      return JSON.parse(raw);
    },

    // Velocity proxy link (handled natively in the backend - bypasses CLI)
    proxyInfo: (velocityId) =>
      _invoke('proxy_info', { velocityId }),

    linkToProxy: (paperId, velocityId, serverName, priority, customIp) =>
      _invoke('link_to_proxy', {
        paperId, velocityId, serverName,
        priority,
        customIp: customIp || null,
      }),

    getVelocitySecret: (id) => _invoke('get_velocity_secret', { id }),

    // System stats (RAM + CPU - for sidebar stats panel)
    getSystemStats: () => _invoke('get_system_stats'),

    getVersion: () => _invoke('get_app_version'),

    getSystemInfo: async () => {
      try {
        const result = await cli(['system']);
        return result || { totalRam: null, availableStorage: null, totalStorage: null };
      } catch { return { totalRam: null, availableStorage: null, totalStorage: null }; }
    },

    checkUpdate: async () => {
      try {
        const current = await _invoke('get_app_version');
        const data = await _invoke('check_app_update');
        if (!data) return { current, latest: null, hasUpdate: false };
        const latest = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
        const hasUpdate = !!(current && latest && semverGt(latest, current));
        return { current, latest, hasUpdate, url: data.html_url || '' };
      } catch {
        return { current: null, latest: null, hasUpdate: false };
      }
    },

    checkCliUpdate: async () => {
      try {
        const cliInfo = await _invoke('check_cli');
        const current = (cliInfo && cliInfo.ok && cliInfo.version) ? cliInfo.version : null;
        const data = await _invoke('check_cli_update');
        if (!data) return { current, latest: null, hasUpdate: false };
        const latest = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
        const hasUpdate = !!(current && latest && semverGt(latest, current));
        const url = data.html_url || 'https://github.com/dippycoder/mcpanel-cli/releases/latest';
        return { current, latest, hasUpdate, url };
      } catch {
        return { current: null, latest: null, hasUpdate: false };
      }
    },

    // BuildTools (SpigotMC) - installed/latest build + manual update trigger
    getBuildToolsVersion: () => cli(['buildtools', 'version']),
    updateBuildTools: () => cli(['buildtools', 'update']),

    // A page can open a URL itself; no reason to round-trip through the host.
    openExternal: (url) => { window.open(url, '_blank', 'noopener'); },

    // Open server/profile folders on the host, exactly as the desktop app did -
    // the backend runs on the machine that owns those directories.
    openServerFolder: async (id) => {
      const cfg = await cli(['config', 'show']);
      const srv = (cfg.servers || []).find(s => s.id === id);
      if (srv && srv.dir) await _invoke('open_path', { path: srv.dir });
      return { success: true };
    },

    // Themes - all handled natively in the backend, no CLI involvement
    ensureBuiltinThemes: () => _invoke('ensure_builtin_themes'),
    getThemes: () => _invoke('get_themes'),
    getThemeCss: (id) => _invoke('get_theme_css', { id }),
    deleteTheme: (id) => _invoke('delete_theme', { id }),
    installThemeUrl: (url) => _invoke('install_theme_from_url', { url }),
    installThemeFile: (filePath) => _invoke('install_theme_from_file', { path: filePath }),
    fetchGithubThemes: () => _invoke('fetch_github_themes'),
    themeExists: (id) => _invoke('theme_exists', { id }),
    installBuiltinTheme: (id, css, json) => _invoke('install_builtin_theme', { id, css, json }),
    getDefaultTheme: () => _invoke('get_default_theme'),
    setDefaultTheme: (id) => _invoke('set_default_theme', { id }),

    browseThemeFile: () => _pickPath({
      mode: 'file',
      title: 'Theme Archive',
      extensions: ['zip'],
    }),

    openAppLogs: async () => {
      const path = await _invoke('get_app_log_path');
      await _invoke('open_path', { path });
    },
    logEvent: (message, level = 'info') => _invoke('log_event', { level, message }),

    createBackup: (id) => _invoke('create_backup', { id }),
    listBackups: (id) => _invoke('list_backups', { id }),
    deleteBackup: (id, backupName) => _invoke('delete_backup', { id, backupName }),
    restoreBackup: (id, backupName) => _invoke('restore_backup', { id, backupName }),

    getSchedules: (serverId) => _invoke('get_schedules', { serverId }),
    saveSchedule: (schedule) => _invoke('save_schedule', { schedule }),
    deleteSchedule: (scheduleId) => _invoke('delete_schedule', { scheduleId }),
    runScheduleNow: (serverId, action, command) => _invoke('run_schedule_now', { serverId, action, command: command || null }),

    getAppSettings: () => _invoke('get_app_settings'),
    saveAppSettings: (settings) => _invoke('save_app_settings', { settings }),
    getNetworkConfig: () => _invoke('get_network_config'),
    saveNetworkConfig: (host, port) => _invoke('save_network_config', { host, port }),
    listSystemFonts: () => _invoke('list_system_fonts'),
    shutdownAllServers: () => _invoke('shutdown_all_servers'),

    on,
    off,

    // Plugin / Mod search + install - routed through mcpanel-cli's own
    // urllib-backed API so it isn't subject to browser CORS at all (Spiget's
    // policy blocks the standard User-Agent header on a plain fetch).
    searchPlugins: (platform, query, opts = {}) => {
      const args = ['search', 'plugins', platform, query || ''];
      if (opts.software) args.push('-sw', opts.software);
      if (opts.mcVersion) args.push('-v', opts.mcVersion);
      if (opts.limit) args.push('-n', String(opts.limit));
      if (opts.offset) args.push('-o', String(opts.offset));
      return cli(args);
    },
    installPlugin: (platform, slug, opts = {}) => {
      const args = ['install', 'plugin', platform, slug];
      if (opts.serverId) args.push('-id', opts.serverId);
      if (opts.profileId) args.push('--profile-id', opts.profileId);
      if (opts.mcVersion) args.push('-v', opts.mcVersion);
      if (opts.owner) args.push('--owner', opts.owner);
      if (opts.versionId) args.push('--version', String(opts.versionId));
      return cli(args);
    },
    pluginInfo: (platform, slug, opts = {}) => {
      const args = ['info', 'plugin', platform, slug];
      if (opts.owner) args.push('--owner', opts.owner);
      if (opts.limit) args.push('-n', String(opts.limit));
      if (opts.offset) args.push('-o', String(opts.offset));
      return cli(args);
    },

    minimize,
    maximize,
    close,
    startResizeDragging,
  };

  function semverGt(a, b) {
    const parse = v => String(v).replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n, 10) || 0);
    const [aM, am, ap] = parse(a);
    const [bM, bm, bp] = parse(b);
    if (aM !== bM) return aM > bM;
    if (am !== bm) return am > bm;
    return ap > bp;
  }

  window.addEventListener('DOMContentLoaded', () => {
    _invoke('check_cli').then(result => {
      if (result && result.ok) {
        window._cliOk = true;
        _cliReadyResolve(true);
        setTimeout(() => {
          if (typeof window.toast === 'function')
            window.toast(`MCPanel-CLI v${result.version || '?'} ready`, 'success');
        }, 600);
      } else {
        window._cliOk = false;
        _cliReadyResolve(false);
        showCliMissingModal();
      }
    }).catch(() => {
      window._cliOk = false;
      _cliReadyResolve(false);
      showCliMissingModal();
    });
  });

  function showCliMissingBanner(message) {
    function tryShow() {
      const banner = document.getElementById('cli-missing-banner');
      const msgEl  = document.getElementById('cli-missing-msg');
      if (banner && msgEl) {
        msgEl.textContent = message;
        banner.classList.remove('hidden');
      }
    }
    if (document.readyState !== 'loading') {
      tryShow();
    } else {
      window.addEventListener('DOMContentLoaded', tryShow);
    }
  }

  function showCliMissingModal() {
    function tryShow() {
      const modal = document.getElementById('modal-cli-missing');
      if (modal) modal.classList.remove('hidden');
    }
    if (document.readyState !== 'loading') tryShow();
    else window.addEventListener('DOMContentLoaded', tryShow);
  }

  function getCliDownloadUrl() {
    const p = (navigator.platform || '').toLowerCase();
    if (p.includes('linux')) return 'https://mcpanel.dippycoder.xyz/download#cli-linux-bash';
    if (p.includes('win')) return 'https://mcpanel.dippycoder.xyz/download#cli-windows';
    return 'https://mcpanel.dippycoder.xyz/download#cli-macos';
  }
  window._cliDownloadUrl = getCliDownloadUrl;

  window._installCli = async function () {
    const btn    = document.getElementById('cli-install-btn');
    const msgEl  = document.getElementById('cli-missing-msg');
    const banner = document.getElementById('cli-missing-banner');
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = 'Installing…';
    if (msgEl) msgEl.textContent = 'Installing mcpanel-cli from GitHub…';

    try {
      const result = await _invoke('install_cli');
      if (msgEl) msgEl.textContent = result;
      btn.textContent = 'Installed!';
      btn.style.background = '#226622';
      setTimeout(async () => {
        const check = await _invoke('check_cli');
        if (check && check.ok) {
          banner.classList.add('hidden');
          window._cliOk = true;
          if (typeof window.toast === 'function')
            window.toast('MCPanel-CLI installed & ready!', 'success');
          if (typeof window.init === 'function') window.init();
        }
      }, 1000);
    } catch (e) {
      if (msgEl) msgEl.textContent = String(e);
      btn.textContent = 'Install CLI';
      btn.disabled = false;
    }
  };
})();

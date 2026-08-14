/* ═══════════════════════════════════════════════════════════════════════════
   Network config - lets an admin change the host/port the WebUI listens on
   from the Settings page instead of editing --host/--port or an env var.

   Persisted to network.json (server/paths.js networkConfigPath) and applied
   live via ctx.state.applyNetworkConfig, wired up in server/index.js. That
   function rebinds the existing http.Server in place - no process restart.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');

const paths = require('../paths');
const applog = require('../applog');

function readPersisted() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.networkConfigPath(), 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {

  get_network_config: async (_args, ctx) => {
    const persisted = readPersisted();
    const live = typeof ctx.state.networkInfo === 'function' ? ctx.state.networkInfo() : {};
    return {
      host: live.host || null,
      port: live.port || null,
      persistedHost: typeof persisted.host === 'string' ? persisted.host : null,
      persistedPort: Number.isInteger(persisted.port) ? persisted.port : null,
      lanAddresses: ctx.util.lanAddresses(),
    };
  },

  save_network_config: async ({ host, port }, ctx) => {
    const trimmedHost = typeof host === 'string' ? host.trim() : '';
    const numPort = Number(port);

    if (!trimmedHost) throw new Error('Host is required.');
    if (!Number.isInteger(numPort) || numPort < 1 || numPort > 65535) {
      throw new Error('Port must be a whole number between 1 and 65535.');
    }

    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(
      paths.networkConfigPath(),
      JSON.stringify({ host: trimmedHost, port: numPort }, null, 2),
    );
    applog.info(`Network config changed by "${ctx.user.username}": ${trimmedHost}:${numPort}`);

    if (typeof ctx.state.applyNetworkConfig === 'function') {
      // Deferred so this call's own HTTP response reaches the browser before
      // the connection it arrived on is torn down by the rebind.
      setTimeout(() => {
        ctx.state.applyNetworkConfig({ host: trimmedHost, port: numPort }).catch((e) => {
          applog.error(`Failed to rebind WebUI to ${trimmedHost}:${numPort}: ${e && e.message}`);
        });
      }, 300);
    }

    return { success: true, host: trimmedHost, port: numPort };
  },

};

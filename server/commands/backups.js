/* ═══════════════════════════════════════════════════════════════════════════
   Backups - port of the backup half of src-tauri/src/commands.rs (2820-2923).

   All four commands are thin wrappers around `mcpanel api backup <...>`.
   Create and restore stream one JSON progress object per line on stdout, so
   those two are spawned and read line-by-line rather than buffered, with each
   line re-emitted to the frontend as a `backup-progress` event.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const paths = require('../paths');
const applog = require('../applog');
const cli = require('../cli');

function serverBackupsDir(serverId) {
  return path.join(paths.home(), 'backups', serverId);
}

/**
 * Runs a streaming backup subcommand, forwarding every progress line to the
 * frontend and resolving with the last line that carried a success/error key.
 *
 * `track` records the child on ctx.state.activeBackup so a shutdown can cancel
 * it mid-flight.
 */
function streamBackupCommand(argv, id, ctx, emptyResult, { track = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = cli.spawnMcpanel(argv);
    } catch (e) {
      resolve({ error: `MCPanel-CLI could not be started: ${e.message}`, code: 'cli_unavailable' });
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (track) ctx.state.activeBackup = null;
      resolve(value);
    };

    child.on('error', (e) => finish({ error: `MCPanel-CLI could not be started: ${e.message}`,
                                      code: 'cli_unavailable' }));

    // Kept only to explain a run that ends without a result line (a crash
    // before the CLI could report anything) - otherwise the CLI's own error
    // document is what the user sees.
    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d; });
    }

    if (track) {
      // zipPath stays empty: mcpanel-cli only reports the archive's name on its
      // final line (see backup.py's create_backup), so there is nothing to
      // clean up by name until the backup has already finished. The field
      // exists so a cancel path can delete a partial archive if the CLI ever
      // starts naming it earlier.
      ctx.state.activeBackup = { child, zipPath: '' };
    }

    let finalResult = emptyResult;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let val;
      try { val = JSON.parse(text); } catch { return; }

      const progress = typeof val.progress === 'number' ? val.progress : 0;
      const status = typeof val.status === 'string' ? val.status : '';
      ctx.emit('backup-progress', { id, progress, status });

      if (val.success !== undefined || val.error !== undefined) {
        finalResult = val;
        if (track && val.backup && typeof val.backup.name === 'string' && ctx.state.activeBackup) {
          ctx.state.activeBackup.zipPath = path.join(serverBackupsDir(id), val.backup.name);
        }
      }
    });

    // Wait for both the stream to drain and the process to exit, so a fast
    // exit can't drop the final progress line.
    let closed = false;
    let exited = false;
    const maybeDone = () => {
      if (!(closed && exited)) return;
      if (finalResult === emptyResult && stderr.trim()) {
        finish({ error: stderr.trim().slice(-1000), code: 'cli_failed' });
      } else {
        finish(finalResult);
      }
    };
    rl.on('close', () => { closed = true; maybeDone(); });
    child.on('close', () => { exited = true; maybeDone(); });
  });
}

async function jsonBackupCommand(argv, fallback) {
  const { stdout, stderr, spawnError } = await cli.execMcpanel(argv);
  if (spawnError) {
    return { error: `MCPanel-CLI could not be started: ${spawnError.message}`, code: 'cli_unavailable' };
  }
  try {
    return JSON.parse(stdout);
  } catch {
    // Nothing parseable: surface what the CLI said on stderr, if anything.
    return stderr ? { error: stderr.slice(-1000), code: 'cli_failed' } : fallback;
  }
}

module.exports = {
  async create_backup({ id }, ctx) {
    try {
      fs.mkdirSync(serverBackupsDir(id), { recursive: true });
    } catch (e) {
      return { error: e.message };
    }
    applog.info(`create_backup: mcpanel api backup create -id ${id}`);
    return streamBackupCommand(
      ['api', 'backup', 'create', '-id', id],
      id,
      ctx,
      { error: 'Backup produced no output', code: 'cli_bad_output' },
      { track: true },
    );
  },

  async list_backups({ id }) {
    return jsonBackupCommand(['api', 'backup', 'list', '-id', id], { backups: [] });
  },

  async delete_backup({ id, backupName }) {
    applog.info(`delete_backup: ${backupName} -id ${id}`);
    return jsonBackupCommand(
      ['api', 'backup', 'delete', '-id', id, '-name', backupName],
      { error: 'MCPanel-CLI returned an unreadable response', code: 'cli_bad_output' },
    );
  },

  async restore_backup({ id, backupName }, ctx) {
    applog.info(`restore_backup: ${backupName} -id ${id}`);
    return streamBackupCommand(
      ['api', 'backup', 'restore', '-id', id, '-name', backupName],
      id,
      ctx,
      { error: 'Restore produced no output', code: 'cli_bad_output' },
    );
  },
};

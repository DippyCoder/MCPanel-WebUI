/* ═══════════════════════════════════════════════════════════════════════════
   Schedules - port of the schedule half of src-tauri/src/commands.rs
   (2927-3063).

   Schedules live in <mcpanel home>/schedules.json as a flat array. The field
   names inside each entry are snake_case (server_id, next_run, repeat_every…)
   because that is the on-disk format the Tauri app and the frontend already
   share - do not camelCase them.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

const paths = require('../paths');
const applog = require('../applog');
const cli = require('../cli');

const TICK_MS = 30_000;

function readAllSchedules() {
  let raw;
  try { raw = fs.readFileSync(paths.schedulesPath(), 'utf8'); } catch { return []; }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAllSchedules(schedules) {
  fs.mkdirSync(paths.home(), { recursive: true });
  fs.writeFileSync(paths.schedulesPath(), JSON.stringify(schedules, null, 2));
}

/** Fire-and-forget console command over the supervisor's unix socket. */
function sendSocketCommand(serverId, text) {
  if (process.platform === 'win32') return Promise.resolve();
  const sock = path.join(paths.runDir(), `${serverId}.sock`);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const conn = net.createConnection(sock, () => {
      conn.write(`${JSON.stringify({ op: 'cmd', text })}\n`, () => {
        conn.end();
        finish();
      });
    });
    // A stopped server has no socket; the Rust side ignored that too.
    conn.on('error', finish);
    conn.on('close', finish);
  });
}

async function executeScheduledAction(serverId, action, command) {
  switch (action) {
    case 'start':
    case 'stop':
    case 'restart': {
      const { spawnError } = await cli.execMcpanel(['api', action, 'server', '-id', serverId]);
      if (spawnError) throw new Error(spawnError.message);
      break;
    }
    case 'backup': {
      const { spawnError } = await cli.execMcpanel(['api', 'backup', 'create', '-id', serverId]);
      if (spawnError) throw new Error(spawnError.message);
      break;
    }
    case 'command':
      if (command) await sendSocketCommand(serverId, command);
      break;
    default:
      break;
  }
}

const REPEAT_MS = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

let schedulerStarted = false;

async function schedulerTick(ctx) {
  const nowMs = Date.now();
  const schedules = readAllSchedules();
  let changed = false;

  for (const schedule of schedules) {
    if (schedule.enabled !== true) continue;
    const nextRun = typeof schedule.next_run === 'number' ? schedule.next_run : null;
    if (nextRun === null) continue;
    if (nowMs < nextRun) continue;
    const serverId = typeof schedule.server_id === 'string' ? schedule.server_id : null;
    if (!serverId) continue;

    const action = typeof schedule.action === 'string' ? schedule.action : '';
    const command = typeof schedule.command === 'string' ? schedule.command : null;

    try {
      await executeScheduledAction(serverId, action, command);
    } catch (e) {
      applog.error(`scheduler: ${action} for ${serverId} failed: ${e.message}`);
    }

    ctx.emit('schedule-fired', {
      schedule_id: typeof schedule.id === 'string' ? schedule.id : '',
      server_id: serverId,
      action,
    });

    if (schedule.repeat === true) {
      const every = Math.max(1, Number(schedule.repeat_every) || 1);
      const unit = typeof schedule.repeat_unit === 'string' ? schedule.repeat_unit : 'days';
      const ms = (REPEAT_MS[unit] || REPEAT_MS.days) * every;
      // Roll forward past any ticks missed while the app was closed.
      let newNext = nextRun + ms;
      while (newNext <= nowMs) newNext += ms;
      schedule.next_run = newNext;
      schedule.last_run = nowMs;
    } else {
      schedule.enabled = false;
      schedule.last_run = nowMs;
    }
    changed = true;
  }

  if (changed) {
    try { writeAllSchedules(schedules); }
    catch (e) { applog.error(`scheduler: failed to persist schedules: ${e.message}`); }
  }
}

module.exports = {
  async get_schedules({ serverId }) {
    return { schedules: readAllSchedules().filter(s => s.server_id === serverId) };
  },

  async save_schedule({ schedule }) {
    if (!schedule || typeof schedule.id !== 'string' || !schedule.id) {
      return { error: 'Schedule must have an id' };
    }
    const schedules = readAllSchedules();
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx !== -1) schedules[idx] = schedule; else schedules.push(schedule);
    try {
      writeAllSchedules(schedules);
    } catch (e) {
      return { error: e.message };
    }
    applog.info(`Saved schedule "${schedule.action || '?'}" -id ${schedule.server_id || '?'}`);
    return { success: true, schedule };
  },

  async delete_schedule({ scheduleId }) {
    const schedules = readAllSchedules();
    const before = schedules.length;
    const kept = schedules.filter(s => s.id !== scheduleId);
    if (kept.length === before) return { error: 'Schedule not found' };
    try {
      writeAllSchedules(kept);
    } catch (e) {
      return { error: e.message };
    }
    return { success: true };
  },

  async run_schedule_now({ serverId, action, command }) {
    try {
      await executeScheduledAction(serverId, action, command || null);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  },

  /**
   * Not a Tauri command - server/index.js calls this once at boot, standing in
   * for the `tauri::async_runtime::spawn(run_scheduler(handle))` in lib.rs.
   */
  __start_scheduler(_args, ctx) {
    if (schedulerStarted) return;
    schedulerStarted = true;

    // `running` reproduces tokio's MissedTickBehavior::Skip: a tick that is
    // still working through a slow action (a backup, say) swallows the next one
    // instead of stacking a second pass on top of it.
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try { await schedulerTick(ctx); }
      catch (e) { applog.error(`scheduler tick failed: ${e.message}`); }
      finally { running = false; }
    }, TICK_MS);
    if (timer.unref) timer.unref();
  },
};

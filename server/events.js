/* ═══════════════════════════════════════════════════════════════════════════
   Event bus - the WebUI's stand-in for Tauri's `app.emit(channel, payload)`.

   Backend code calls `emit(channel, payload)` exactly like the Rust side did;
   every connected browser receives {channel, payload} over the /ws socket and
   web-bridge.js hands it to the callbacks registered via window.mcpanel.on().

   Channels used by the frontend:
     server-log, server-stopped, download-progress, backup-progress,
     schedule-fired, pty-data, pty-closed
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const sinks = new Set();

function addSink(fn) {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

function emit(channel, payload) {
  if (!sinks.size) return;
  const frame = JSON.stringify({ channel, payload });
  for (const sink of sinks) {
    try { sink(frame); } catch { /* a dead socket is dropped on its own close */ }
  }
}

/**
 * Like emit(), but only to one specific client. Used by the PTY, which is
 * per-session rather than global.
 */
function emitTo(sink, channel, payload) {
  try { sink(JSON.stringify({ channel, payload })); } catch {}
}

module.exports = { addSink, emit, emitTo, sinks };

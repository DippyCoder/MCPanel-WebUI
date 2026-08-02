/* ═══════════════════════════════════════════════════════════════════════════
   Server file-browser commands - port of the server-directory half of
   src-tauri/src/commands.rs (write/upload/export + the file operations).

   Every path that arrives from the frontend is relative to the server's own
   directory; `..` and absolute paths are rejected up front so a crafted
   request can't reach outside it. The profile-side equivalents live in
   commands/profiles.js, and the file *tree* is read through the CLI
   (`mcpanel api fetch files`), not from here.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');

const applog = require('../applog');
const util = require('../util');

const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;
const BINARY_ERROR = 'File is binary or cannot be read as text';

/**
 * Normalises the `data` payload of a write. app.js sends
 * `Array.from(new Uint8Array(buf))` (Tauri's `Vec<u8>` wire shape); a base64
 * string or a real Buffer is accepted too so other callers aren't forced to
 * inflate a byte-per-array-slot blob.
 */
function toBuffer(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // JSON.stringify(Buffer) round-trips as {type:'Buffer', data:[…]}.
  if (typeof data === 'object' && data.type === 'Buffer' && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  throw new Error('Invalid file data');
}

/**
 * Rust's `read_to_string` errors on invalid UTF-8, which is what kept binaries
 * out of the editor. A NUL byte is rejected as well: it is valid UTF-8, so the
 * decoder alone would let UTF-16 text and .dat blobs through to Ace as garbage.
 */
function decodeText(buf) {
  if (buf.includes(0)) throw new Error(BINARY_ERROR);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new Error(BINARY_ERROR);
  }
}

function serverPath(id, rel, label = 'path') {
  util.assertSafeRel(rel, label);
  return path.join(util.getServerDir(id), rel);
}

async function write_server_file({ id, relPath, data }) {
  const dest = serverPath(id, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, toBuffer(data));
}

// Tauri handed us OS paths straight from the drop event; the WebUI stages the
// dropped bytes under webui-uploads/ first and passes those paths instead, so
// this command is unchanged on both sides.

async function upload_files_to_server({ id, srcPaths, destDir }) {
  const dest = destDir || '';
  if (dest) util.assertSafeRel(dest, 'destination path');

  const base = util.getServerDir(id);
  const destBase = dest ? path.join(base, dest) : base;
  fs.mkdirSync(destBase, { recursive: true });

  const sources = srcPaths || [];
  for (const srcPath of sources) {
    const name = path.basename(srcPath);
    if (!name) continue;
    util.copyDroppedPath(srcPath, path.join(destBase, name));
  }

  applog.info(
    `Uploaded ${sources.length} item(s) to server${dest ? ` (/${dest})` : ''} -id ${id}`
  );
}

async function export_server_files({ id, relPaths, destDir }) {
  const serverDir = util.getServerDir(id);
  const rels = relPaths || [];
  util.exportPaths(serverDir, rels, destDir);
  applog.info(`Downloaded ${rels.length} item(s) from server -id ${id} to ${destDir}`);
}

async function delete_server_file({ id, relPath }) {
  const target = serverPath(id, relPath);
  let st;
  try { st = fs.statSync(target); } catch { throw new Error('File not found'); }
  if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}

async function create_server_dir({ id, relPath }) {
  fs.mkdirSync(serverPath(id, relPath), { recursive: true });
}

async function create_server_file({ id, relPath }) {
  const dest = serverPath(id, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) throw new Error('A file with that name already exists');
  fs.writeFileSync(dest, '');
}

async function rename_server_file({ id, oldPath, newPath }) {
  util.assertSafeRel(oldPath);
  util.assertSafeRel(newPath);
  const base = util.getServerDir(id);
  const src = path.join(base, oldPath);
  const dst = path.join(base, newPath);
  if (!fs.existsSync(src)) throw new Error('Source not found');
  if (fs.existsSync(dst)) throw new Error('A file with that name already exists');
  fs.renameSync(src, dst);
}

async function read_server_file({ id, relPath }) {
  const target = serverPath(id, relPath);
  const meta = fs.statSync(target);
  if (meta.size > MAX_EDITABLE_BYTES) {
    throw new Error('File too large to edit in-app (max 5MB)');
  }
  return decodeText(fs.readFileSync(target));
}

module.exports = {
  write_server_file,
  upload_files_to_server,
  export_server_files,
  delete_server_file,
  create_server_dir,
  create_server_file,
  rename_server_file,
  read_server_file,
};

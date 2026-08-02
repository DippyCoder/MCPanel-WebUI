/* ═══════════════════════════════════════════════════════════════════════════
   Profile commands - port of the profile half of src-tauri/src/commands.rs
   (update_profile / *_profile_file / *_profile_dir / upload / export).

   Only the filesystem-level operations live here. Listing, creating, deleting,
   opening, importing and create-from-server all go through mcpanel-cli and are
   issued directly by the bridge, exactly as they were in the Tauri build.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');

const paths = require('../paths');
const applog = require('../applog');
const {
  getProfileDir,
  assertSafeRel,
  copyDroppedPath,
  exportPaths,
  walkDirTree,
} = require('../util');

const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

/**
 * The frontend encodes file contents as a `Vec<u8>` - `Array.from(Uint8Array)`.
 * Accept the byte array plus the shapes a caller might reasonably substitute.
 */
function toBuffer(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  return Buffer.from(data);
}

/**
 * Patches profile.json in place. Keys that arrive as undefined/null are the
 * Rust `Option::None` case and are left untouched, so a partial update never
 * clears fields the caller didn't mention.
 */
async function update_profile({ id, name, description, software, versions }) {
  const profileJson = path.join(paths.profilesDir(), String(id), 'profile.json');
  const profile = JSON.parse(fs.readFileSync(profileJson, 'utf8'));

  if (name != null) profile.name = String(name);
  if (description != null) profile.description = String(description);
  if (software != null) profile.software = Array.from(software, String);
  if (versions != null) profile.versions = Array.from(versions, String);

  fs.writeFileSync(profileJson, JSON.stringify(profile, null, 2));
}

/**
 * Unlike its siblings this reports a missing profile as a value rather than an
 * error - the file browser renders `{ error }` inline instead of toasting.
 */
async function get_profile_file_tree({ id }) {
  let dir;
  try {
    dir = getProfileDir(id);
  } catch (e) {
    return { error: e.message };
  }
  return { tree: walkDirTree(dir, dir) };
}

async function read_profile_file({ id, relPath }) {
  assertSafeRel(relPath);
  const target = path.join(getProfileDir(id), relPath);

  const meta = fs.statSync(target);
  if (meta.size > MAX_EDITABLE_BYTES) {
    throw new Error('File too large to edit in-app (max 5MB)');
  }
  // Rust's read_to_string rejects invalid UTF-8 outright; Node's 'utf8' decode
  // would silently substitute U+FFFD, so decode strictly to keep the same
  // "this is a binary file" behaviour in the editor.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(target));
  } catch {
    throw new Error('File is binary or cannot be read as text');
  }
}

async function write_profile_file({ id, relPath, data }) {
  assertSafeRel(relPath);
  const dest = path.join(getProfileDir(id), relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, toBuffer(data));
}

async function delete_profile_file({ id, relPath }) {
  assertSafeRel(relPath);
  const target = path.join(getProfileDir(id), relPath);
  if (!fs.existsSync(target)) throw new Error('File not found');

  if (fs.statSync(target).isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}

async function create_profile_dir({ id, relPath }) {
  assertSafeRel(relPath);
  fs.mkdirSync(path.join(getProfileDir(id), relPath), { recursive: true });
}

async function create_profile_file({ id, relPath }) {
  assertSafeRel(relPath);
  const dest = path.join(getProfileDir(id), relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) throw new Error('A file with that name already exists');
  fs.writeFileSync(dest, '');
}

async function rename_profile_file({ id, oldPath, newPath }) {
  assertSafeRel(oldPath);
  assertSafeRel(newPath);
  const base = getProfileDir(id);
  const src = path.join(base, oldPath);
  const dst = path.join(base, newPath);

  if (!fs.existsSync(src)) throw new Error('Source not found');
  if (fs.existsSync(dst)) throw new Error('A file with that name already exists');
  fs.renameSync(src, dst);
}

async function upload_files_to_profile({ id, srcPaths, destDir }) {
  const dest = destDir || '';
  if (dest) assertSafeRel(dest, 'destination path');

  const base = getProfileDir(id);
  const destBase = dest ? path.join(base, dest) : base;
  fs.mkdirSync(destBase, { recursive: true });

  const sources = srcPaths || [];
  for (const srcPath of sources) {
    const name = path.basename(srcPath);
    if (name) copyDroppedPath(srcPath, path.join(destBase, name));
  }

  applog.info(
    `Uploaded ${sources.length} item(s) to profile${dest ? ` (/${dest})` : ''} -id ${id}`
  );
}

async function export_profile_files({ id, relPaths, destDir }) {
  const rels = relPaths || [];
  exportPaths(getProfileDir(id), rels, destDir);
  applog.info(`Downloaded ${rels.length} item(s) from profile -id ${id} to ${destDir}`);
}

module.exports = {
  update_profile,
  get_profile_file_tree,
  read_profile_file,
  write_profile_file,
  delete_profile_file,
  create_profile_dir,
  create_profile_file,
  rename_profile_file,
  upload_files_to_profile,
  export_profile_files,
};

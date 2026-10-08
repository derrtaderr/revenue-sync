// Local state on the user's own disk. Billing data is private: new folders are 0700, new files
// 0600, and JSON is written to a temp file and renamed so a crash never leaves half a file.

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

// New folders are created 0700; an existing folder is the user's and keeps its permissions.
// The explicit chmod covers a umask that would loosen the new folder.
export function ensureDir(dir) {
  const created = mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (created) chmodSync(dir, DIR_MODE);
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  renameSync(tmp, file);
}

export function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${basename(file)} is not valid JSON. Move it aside and run again.`);
  }
}

export const SNAPSHOT_SCHEMA = 'revenue-sync.synced';
export const SNAPSHOT_VERSION = 1;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string';

// synced.json is read before anything is fetched and drives the unlink holds and the F3 refusal,
// so a hand-edited or truncated file must stop the run with a plain message, never surface later
// as a TypeError (pre-public review m-f).
export function readSnapshot(file) {
  const where = `${basename(file)} (${file})`;
  const advice = 'Move it aside and run again; the next sync then has no record of past links, so any unlink is held until --allow-unlink.';
  let snap;
  try {
    snap = readJson(file);
  } catch (err) {
    if (err.code) throw err;
    throw new Error(`${where} is not valid JSON. ${advice}`);
  }
  if (snap === null) return null;
  if (isObject(snap) && ((snap.schema !== undefined && snap.schema !== SNAPSHOT_SCHEMA) || (snap.version !== undefined && snap.version !== SNAPSHOT_VERSION))) {
    throw new Error(`${where} was written by another tool or version (schema ${JSON.stringify(snap.schema)}, version ${JSON.stringify(snap.version)}); this build reads schema "${SNAPSHOT_SCHEMA}" version ${SNAPSHOT_VERSION}. ${advice}`);
  }
  const ok = isObject(snap)
    && (snap.synced_at === undefined || isText(snap.synced_at))
    && (snap.values === undefined || (isObject(snap.values) && Object.values(snap.values).every((v) => isObject(v) && Object.values(v).every(isText))))
    && (snap.links === undefined || (isObject(snap.links) && Object.values(snap.links).every((l) => Array.isArray(l) && l.every(isText))))
    && (snap.names === undefined || (isObject(snap.names) && Object.values(snap.names).every(isText)))
    && (snap.stripe_account === undefined || snap.stripe_account === null || isText(snap.stripe_account));
  if (!ok) throw new Error(`${where} is not in the shape sync writes. ${advice}`);
  return snap;
}

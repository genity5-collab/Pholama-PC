'use strict';
// The screenshots the agent took, kept in MEMORY only (never on disk, never sent anywhere) so the Codebase screen can show them.
// Only the last few are kept, each is size-capped, and only a real PNG is accepted.
const crypto = require('crypto');
const MAX_KEEP = 8, MAX_BYTES = 1500000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const store = new Map();   // id -> Buffer, oldest first

function put(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.length > MAX_BYTES || !buf.subarray(0, 8).equals(PNG)) return null;
  const id = crypto.randomBytes(8).toString('hex');
  store.set(id, buf);
  while (store.size > MAX_KEEP) store.delete(store.keys().next().value);
  return id;
}
function get(id) { return /^[a-f0-9]{16}$/.test(String(id)) ? store.get(String(id)) || null : null; }
function clear() { store.clear(); }
module.exports = { put, get, clear, MAX_KEEP, MAX_BYTES };

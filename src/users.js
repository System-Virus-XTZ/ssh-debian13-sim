/**
 * users.js —— 账号表 + 密码哈希（scrypt）
 * ========================================
 * users.json 里存的是 `scrypt$N$r$p$salt$hash`，不存明文。
 * 为了懒人友好：如果发现明文密码，启动时会自动哈希并写回 users.json。
 *
 * 生成哈希：node scripts/hash-password.js <密码>
 * 添加账号：node scripts/add-user.js <用户名> <密码>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, '..', 'users.json');
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 };

function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function isHashed(value) {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 校验密码；兼容历史明文条目（用于迁移期间） */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (!isHashed(stored)) return safeEqual(password, stored);
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function readManifest(file = USERS_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    if (process.env.DEBUG) console.error('[users.json]', err.message);
  }
  return null;
}

/** 读取账号表，顺手把明文密码迁移成 scrypt 哈希 */
function loadUsers(file = USERS_FILE) {
  const manifest = readManifest(file);
  if (!manifest || !manifest.users || typeof manifest.users !== 'object') {
    const fallback = process.env.SSH_PASSWORD || 'anxi-1024';
    return { guest: hashPassword(fallback) };
  }
  const users = {};
  let migrated = 0;
  for (const [name, value] of Object.entries(manifest.users)) {
    if (typeof value !== 'string' || !value) continue;
    if (isHashed(value)) { users[name] = value; continue; }
    users[name] = hashPassword(value);
    migrated++;
  }
  if (migrated > 0) {
    try {
      const next = { ...manifest, users };
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      console.log(`[users] 已把 ${migrated} 个明文密码迁移为 scrypt 哈希`);
    } catch (err) {
      console.error('[users] 迁移哈希失败：', err.message);
    }
  }
  return users;
}

// ── 账号增删改（root 的 useradd / userdel / passwd 用）──
function readManifestRaw(file = USERS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeManifest(manifest, file = USERS_FILE) {
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function validName(name) { return typeof name === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(name); }

function addUser(name, password) {
  if (!validName(name)) return { ok: false, error: 'invalid user name' };
  const m = readManifestRaw() || { users: {} };
  m.users = m.users || {};
  if (m.users[name]) return { ok: false, error: 'user exists' };
  m.users[name] = hashPassword(password);
  writeManifest(m);
  return { ok: true };
}
function removeUser(name) {
  if (!validName(name)) return { ok: false, error: 'invalid user name' };
  const m = readManifestRaw() || { users: {} };
  m.users = m.users || {};
  if (!m.users[name]) return { ok: false, error: 'no such user' };
  delete m.users[name];
  writeManifest(m);
  return { ok: true };
}
function changePassword(name, password) {
  if (!validName(name)) return { ok: false, error: 'invalid user name' };
  const m = readManifestRaw() || { users: {} };
  m.users = m.users || {};
  if (!m.users[name]) return { ok: false, error: 'no such user' };
  m.users[name] = hashPassword(password);
  writeManifest(m);
  return { ok: true };
}
function listNames() { return Object.keys(loadUsers()); }
function storedHash(name) { const m = readManifestRaw() || { users: {} }; return (m.users || {})[name]; }

module.exports = { USERS_FILE, hashPassword, verifyPassword, isHashed, loadUsers, addUser, removeUser, changePassword, listNames, storedHash, validName };

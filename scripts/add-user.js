#!/usr/bin/env node
/** 添加/更新账号：node scripts/add-user.js <用户名> <密码> */
'use strict';
const fs = require('fs');
const { USERS_FILE, hashPassword } = require('../src/users');
const [name, pw] = process.argv.slice(2);
if (!name || !pw) { console.error('用法: node scripts/add-user.js <用户名> <密码>'); process.exit(1); }
let manifest = { comment: 'SSH 登录账号表：用户名 -> scrypt 密码哈希。改完 systemctl restart ssh-game 生效。', users: {} };
try { manifest = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}
manifest.users = manifest.users || {};
manifest.users[name] = hashPassword(pw);
fs.writeFileSync(USERS_FILE, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(USERS_FILE, 0o600);
console.log(`已写入账号 ${name}（哈希），重启服务生效`);

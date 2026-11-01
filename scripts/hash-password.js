#!/usr/bin/env node
/** 生成 scrypt 密码哈希：node scripts/hash-password.js <密码> */
'use strict';
const { hashPassword } = require('../src/users');
const pw = process.argv[2];
if (!pw) { console.error('用法: node scripts/hash-password.js <密码>'); process.exit(1); }
console.log(hashPassword(pw));

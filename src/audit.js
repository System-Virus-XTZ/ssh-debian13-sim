/**
 * audit.js —— 登录审计（内存）
 * ============================
 * 给 last / lastb / fail2ban-client / /var/log/auth.log 提供"像真的"数据：
 *   · 成功的登录 / 断开记录（last）
 *   · 失败的密码尝试（lastb）
 *   · 类 fail2ban 的封禁策略：10 分钟内错 5 次 → 封 10 分钟
 * 全部在内存里，服务重启即清空。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const BAN_FILE = path.join(__dirname, '..', 'data', 'bans.json');

/** 净化用户名/日志字段，防止日志注入（控制字符、换行、ESC 序列） */
function sanitizeField(v) {
  return String(v == null ? '' : v)
    .replace(/[\x00-\x1f\x7f]/g, '?')
    .slice(0, 64);
}

const MAX_LOGIN_RECORDS = 200;
const MAX_FAIL_RECORDS = 200;

const state = {
  logins: [],          // { user, ip, at, outAt }
  failures: [],        // { user, ip, at }
  bans: new Map(),     // ip -> until (ms)
  failWindowMs: 10 * 60 * 1000,
  failThreshold: 5,
  banMs: 10 * 60 * 1000,
  authLines: [],       // /var/log/auth.log 里的行
};

function fmtTs(d = new Date()) {
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const pad = (n) => String(n).padStart(2, '0');
  return `${mon} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pushLine(line) {
  state.authLines.push(line);
  if (state.authLines.length > 300) state.authLines.shift();
}

// fail2ban 的 ignoreip 默认忽略本机（Debian 默认 127.0.0.1/8 ::1）
function isIgnored(ip) {
  return !ip || ip === '::1' || ip.startsWith('127.') || ip === 'localhost';
}

/** 从 data/bans.json 恢复封禁列表（重启不清零） */
function loadBans() {
  try {
    const raw = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
    const nowMs = Date.now();
    for (const [ip, until] of Object.entries(raw || {})) {
      if (Number(until) > nowMs) state.bans.set(ip, Number(until));
    }
  } catch {}
}
function saveBans() {
  try {
    fs.mkdirSync(path.dirname(BAN_FILE), { recursive: true });
    const obj = {};
    for (const [ip, until] of state.bans.entries()) if (until > Date.now()) obj[ip] = until;
    const tmp = BAN_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, BAN_FILE);
  } catch {}
}

function isBlocked(ip) {
  if (isIgnored(ip)) return false;
  const until = state.bans.get(ip);
  if (!until) return false;
  if (Date.now() > until) { state.bans.delete(ip); return false; }
  return true;
}

function recordFailure(user, ip) {
  const now = Date.now();
  const u = sanitizeField(user), a = sanitizeField(ip);
  pushLine(`${fmtTs()} anxi sshd[1024]: Failed password for ${u} from ${a} port 51234 ssh2`);
  state.failures.push({ user: u, ip: a, at: now });
  if (state.failures.length > MAX_FAIL_RECORDS) state.failures.shift();

  // 统计窗口内的失败次数
  const recent = state.failures.filter((f) => f.ip === ip && now - f.at <= state.failWindowMs);
  if (!isIgnored(ip) && recent.length >= state.failThreshold && !state.bans.has(ip)) {
    const until = now + state.banMs;
    state.bans.set(ip, until);
    pushLine(`${fmtTs()} anxi fail2ban.actions[2048]: NOTICE  [sshd] Ban ${sanitizeField(ip)}`);
    pushLine(`${fmtTs()} anxi fail2ban.filter[2048]: INFO    [sshd] Found ${sanitizeField(ip)} - ${fmtTs()}`);
    saveBans();
  }
}

function recordSuccess(user, ip) {
  const now = Date.now();
  const u = sanitizeField(user), a = sanitizeField(ip);
  pushLine(`${fmtTs()} anxi sshd[1024]: Accepted password for ${u} from ${a} port 51234 ssh2`);
  pushLine(`${fmtTs()} anxi sshd[1024]: pam_unix(sshd:session): session opened for user ${u}(uid=0) by ${u}(uid=0)`);
  state.logins.push({ user: u, ip: a, at: now, outAt: null });
  if (state.logins.length > MAX_LOGIN_RECORDS) state.logins.shift();
}

loadBans();

function recordLogout(user) {
  const rec = [...state.logins].reverse().find((r) => r.user === user && r.outAt === null);
  if (rec) {
    rec.outAt = Date.now();
    pushLine(`${fmtTs()} anxi sshd[1024]: pam_unix(sshd:session): session closed for user ${user}`);
  }
}

function authLogContent() {
  const head = [
    `${fmtTs()} anxi systemd[1]: Started OpenBSD Secure Shell server.`,
    `${fmtTs()} anxi sshd[512]: Server listening on 0.0.0.0 port 22.`,
  ];
  return [...head, ...state.authLines].join('\n') + '\n';
}

function statusText() {
  const banned = [...state.bans.entries()].filter(([, until]) => until > Date.now());
  return {
    jailed: banned.length,
    banned,
    failures: state.failures.length,
  };
}

function fmtDuration(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

module.exports = { recordFailure, recordSuccess, recordLogout, isBlocked, isIgnored, sanitizeField, saveBans, authLogContent, statusText, fmtTs, fmtDuration, state };

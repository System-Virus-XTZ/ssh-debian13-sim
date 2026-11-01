/**
 * anxi-ssh-game —— SSH 仿真 Linux 终端服务端
 * ===========================================
 * 玩法：ssh 用户名@主机 -p 8822，连上就是一个假 Linux shell。
 *
 * 设计要点：
 *   · 账号体系：users.json 里的用户名 + 密码，（可选）每账号独立 home
 *   · 每个连接一个独立的 FakeShell，cwd / 环境变量 / history 互不干扰
 *   · 所有命令都是假实现，只读 src/vfs.js 的假数据，不碰真实文件系统
 *   · 没有任何真实 shell 能力 —— 这是个玩具，不是远程终端
 */

'use strict';

const { Server } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { FakeShell } = require('./shell');
const { loadUsers, verifyPassword } = require('./users');
const audit = require('./audit');
const { attachFakeSftp } = require('./sftp');

const PORT = Number(process.env.PORT || 8822);
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 50);   // 最大并发连接
const CONN_RATE_PER_MIN = Number(process.env.CONN_RATE_PER_MIN || 20); // 每 IP 每分钟最多新建连接
// ── 账号表（users.json，密码为 scrypt 哈希；明文会自动迁移）──
const USERS = loadUsers();
const HOST = process.env.HOST || '0.0.0.0';

// ── 主机密钥 ──
// ssh2 只认 OpenSSH 格式（-----BEGIN OPENSSH PRIVATE KEY-----），
// Node 的 crypto.generateKeyPairSync 产出的 PKCS8 它解析不了。
// 所以密钥由 ssh-keygen 预先生成，放在 keys/host_key。
function loadHostKey() {
  const fromEnv = process.env.SSH_HOST_KEY;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.replace(/\\n/g, '\n');
  }
  const keyPath = process.env.SSH_HOST_KEY_PATH
    || path.join(__dirname, '..', 'keys', 'host_key');
  try {
    return fs.readFileSync(keyPath, 'utf8');
  } catch (err) {
    console.error(`[anxi-ssh-game] 读不到主机密钥: ${keyPath}`);
    console.error('[anxi-ssh-game] 先跑一次: ssh-keygen -t ed25519 -f keys/host_key -N \'\'');
    throw err;
  }
}

const hostKey = loadHostKey();

let activeConnections = 0;
const connRates = new Map();   // ip -> { count, resetAt }

const server = new Server(
  {
    hostKeys: [hostKey],
    // 明确关掉一些不需要的能力，减少暴露面
    ident: 'OpenSSH_10.2p1 Debian-2+deb13u1',
  },
  (client) => {
    // ── 并发连接上限（防连接耗尽）──
    const clientIp = (() => {
      try { return (client._sock && client._sock.remoteAddress) || '127.0.0.1'; } catch { return '127.0.0.1'; }
    })();
    if (activeConnections >= MAX_CONNECTIONS) {
      if (process.env.DEBUG) console.error('[limit] too many connections');
      client._connLimited = 'Too many concurrent connections';
    }
    activeConnections++;
    let counted = true;
    const dec = () => { if (counted) { counted = false; activeConnections--; } };
    client.on('close', dec);
    client.on('error', dec);

    // ── 每 IP 新建连接频率限制（防快速重连）──
    const nowConn = Date.now();
    const rate = connRates.get(clientIp) || { count: 0, resetAt: nowConn + 60000 };
    if (nowConn > rate.resetAt) { rate.count = 0; rate.resetAt = nowConn + 60000; }
    rate.count++;
    connRates.set(clientIp, rate);
    if (rate.count > CONN_RATE_PER_MIN) {
      if (process.env.DEBUG) console.error(`[limit] ${clientIp} connection rate exceeded`);
      client._connLimited = 'Too many connections from your address';
    }

    let authFails = 0;
    const remoteIp = () => {
      try {
        return (client._sock && client._sock.remoteAddress) || client.remoteAddress || '127.0.0.1';
      } catch { return '127.0.0.1'; }
    };

    client.on('authentication', (ctx) => {
      const ip = remoteIp();

      // 被限流的连接：握手后干净拒绝（不会让客户端卡到超时）
      if (client._connLimited) {
        // 只拒绝、不断开：客户端会报 "Permission denied (publickey)"，不会卡住
        setTimeout(() => { try { ctx.reject(['publickey']); } catch {} }, 500);
        return;
      }
      const current = loadUsers();      // 每次认证读盘，root 新加的账号立即可用
      const expected = current[ctx.username];

      // 已被 fail2ban 封禁：直接拒，不给试密码
      if (audit.isBlocked(ip)) {
        setTimeout(() => ctx.reject(['publickey']), 800);
        return;
      }

      // 不存在的用户：和真 OpenSSH 一样直接拒绝，不提供可用认证方式，
      // 客户端因此不会弹密码框（只会显示 Permission denied）
      if (expected === undefined) {
        audit.recordFailure(`invalid user ${ctx.username}`, ip);
        setTimeout(() => ctx.reject(['publickey']), 1000 + Math.random() * 500);
        return;
      }

      // 已知用户：只提供 password 方式
      if (ctx.method !== 'password') return ctx.reject(['password']);

      if (verifyPassword(ctx.password, expected)) {
        client._sshUser = ctx.username;   // 给 session 用
        audit.recordSuccess(ctx.username, ip);
        return ctx.accept();
      }

      // 密码错误：指数退避（1s, 2s, 4s…上限 5s），最多 3 次
      audit.recordFailure(ctx.username, ip);
      authFails++;
      const delay = Math.min(1000 * 2 ** (authFails - 1), 5000);
      if (authFails >= 3) {
        setTimeout(() => {
          try { client.end(); } catch {}
        }, delay);
        return;
      }
      setTimeout(() => ctx.reject(['password']), delay);
    });

    client.on('close', () => {
      if (client._sshUser) audit.recordLogout(client._sshUser);
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();

        session.on('pty', (acceptPty) => {
          acceptPty && acceptPty();
        });

        session.on('window-change', (acceptChange) => {
          acceptChange && acceptChange();
        });

        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          const sh = new FakeShell(stream, client, client._sshUser || Object.keys(USERS)[0] || 'guest');
          sh.start();
        });

        // 假 SFTP 子系统：只读虚拟文件树，不碰真实磁盘
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          attachFakeSftp(sftp, client._sshUser || 'guest');
        });
      });
    });

    client.on('error', (err) => {
      // 客户端断连是常态，不刷屏
      if (process.env.DEBUG) console.error('[client error]', err.message);
    });
  }
);

server.listen(PORT, HOST, () => {
  console.log(`[anxi-ssh-game] listening on ${HOST}:${PORT}`);
  console.log(`[anxi-ssh-game] 连接方式: ssh 任意名字@<主机> -p ${PORT}（需要密码）`);
  console.log(`[anxi-ssh-game] 账号: ${Object.keys(USERS).join(', ')}（密码见 users.json）`);
  console.log(`[anxi-ssh-game] 文件系统可写（内存，重启复位）`);
});

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[anxi-ssh-game] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}

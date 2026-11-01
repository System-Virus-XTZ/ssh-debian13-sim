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
const { attachFakeSftp } = require('./sftp');

const PORT = Number(process.env.PORT || 8822);
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

const server = new Server(
  {
    hostKeys: [hostKey],
    // 明确关掉一些不需要的能力，减少暴露面
    ident: 'OpenSSH_10.2p1 Debian-2+deb13u1',
  },
  (client) => {
    let authFails = 0;
    client.on('authentication', (ctx) => {
      const current = loadUsers();      // 每次认证读盘，root 新加的账号立即可用
      const expected = current[ctx.username];

      // 不存在的用户：和真 OpenSSH 一样直接拒绝，不提供可用认证方式，
      // 客户端因此不会弹密码框（只会显示 Permission denied）
      if (expected === undefined) {
        if (process.env.DEBUG) console.error(`[auth] unknown user ${ctx.username}`);
        return ctx.reject(['publickey']);
      }

      // 已知用户：只提供 password 方式
      if (ctx.method !== 'password') return ctx.reject(['password']);

      if (verifyPassword(ctx.password, expected)) {
        client._sshUser = ctx.username;   // 给 session 用
        return ctx.accept();
      }

      // 密码错误：最多 3 次（类似 sshd 的 MaxAuthTries 行为）
      authFails++;
      if (authFails >= 3) {
        client.end();
        return;
      }
      return ctx.reject(['password']);
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

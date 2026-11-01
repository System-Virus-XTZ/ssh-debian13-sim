/**
 * metrics.js —— 随机生成的假负载数据（不读真机）
 * ===============================================
 * CPU / 内存 / 磁盘 / 网络 / 进程 / uptime 全部是随机数：
 *   · 每次采样重新随机，所以连续敲两次 free 数字会变
 *   · 数值范围参考一台 4 核 1GB 的小机器，看起来合理
 *   · 不读 /proc，不调 os.cpus，不碰 statfs —— 纯编
 */

'use strict';

const rnd = (min, max) => min + Math.random() * (max - min);
const ri = (min, max) => Math.floor(rnd(min, max + 1));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f1 = (v) => Number(v.toFixed(1));

// 进程池（编的）
const PROC_POOL = [
  { pid: 1, user: 'root', cmd: 'systemd', rss: [4, 9] },
  { pid: 2, user: 'root', cmd: 'kthreadd', rss: [0, 1] },
  { pid: 411, user: 'root', cmd: 'systemd-journald', rss: [2, 6] },
  { pid: 512, user: 'root', cmd: 'sshd', rss: [2, 5] },
  { pid: 1024, user: 'root', cmd: 'node', rss: [120, 260] },
  { pid: 1025, user: 'root', cmd: 'bash', rss: [3, 8] },
  { pid: 1316, user: 'root', cmd: 'dockerd', rss: [8, 16] },
  { pid: 1276, user: 'root', cmd: 'containerd', rss: [6, 12] },
  { pid: 1354, user: 'www-data', cmd: 'nginx', rss: [2, 5] },
  { pid: 1351, user: 'www-data', cmd: 'nginx', rss: [2, 4] },
  { pid: 2048, user: 'anxi', cmd: 'focusd', rss: [4, 10] },
  { pid: 3072, user: 'anxi', cmd: 'meetingd', rss: [6, 15] },
  { pid: 4096, user: 'root', cmd: 'happinessd', rss: [3, 8] },
  { pid: 5120, user: 'root', cmd: 'cron', rss: [1, 3] },
  { pid: 7168, user: 'root', cmd: 'agetty', rss: [1, 3] },
  { pid: 8192, user: 'anxi', cmd: 'vim', rss: [5, 12] },
  { pid: 9216, user: 'root', cmd: 'redis-server', rss: [8, 18] },
];

// 假 uptime：进程启动时随机一个 1~30 天前
const BOOT_T = Date.now() - rnd(1, 30) * 86400 * 1000;

function sample() {
  // ── CPU ──
  const cores = [rnd(1, 55), rnd(1, 55), rnd(1, 45), rnd(1, 50)];
  const total = f1(cores.reduce((a, b) => a + b, 0) / cores.length);
  const user = f1(total * rnd(0.55, 0.75));
  const sys = f1(total * rnd(0.2, 0.35));
  const idle = f1(clamp(100 - total, 0, 100));
  const wait = f1(rnd(0, 4));
  const load1 = f1(clamp(rnd(0.4, 2.4) * (0.4 + total / 100), 0.1, 3.5));
  const load5 = f1(clamp(load1 * rnd(0.6, 1.1), 0.05, 3));
  const load15 = f1(clamp(load5 * rnd(0.7, 1.05), 0.05, 2.5));

  // ── 内存 ──
  const totalMB = 983;
  const used = f1(rnd(420, 780));
  const buffCache = f1(rnd(120, 260));
  const free = f1(clamp(totalMB - used - buffCache, 80, totalMB));
  const buffers = f1(rnd(8, 24));
  const cached = f1(Math.max(0, buffCache - buffers));
  const shared = f1(rnd(5, 30));
  const available = f1(clamp(free + cached * 0.9, 100, totalMB));
  const swapTotal = 492;
  const swapUsed = f1(rnd(0, 200));

  // ── 磁盘 ──
  const diskTotal = 6.9;
  const diskUsed = f1(rnd(2.8, 4.9));
  const diskAvail = f1(diskTotal - diskUsed);

  // ── 网络（MB/s，累计 MB）──
  const net = [
    { iface: 'eth0', rx: f1(rnd(0, 9)), tx: f1(rnd(0, 4)), rxBytes: ri(200, 900) * 1048576, txBytes: ri(150, 700) * 1048576 },
    { iface: 'docker0', rx: 0, tx: 0, rxBytes: ri(0, 2) * 1048576, txBytes: ri(0, 2) * 1048576 },
    { iface: 'lo', rx: f1(rnd(0.01, 0.6)), tx: f1(rnd(0.01, 0.6)), rxBytes: ri(20, 120) * 1048576, txBytes: ri(20, 120) * 1048576 },
  ];

  // ── 进程 ──
  const picked = PROC_POOL.slice(0, 12).map((p) => {
    const rss = f1(rnd(p.rss[0], p.rss[1]));
    const cpu = f1(rnd(0, p.cmd === 'meetingd' ? 60 : 8));
    return {
      pid: p.pid,
      ppid: 1,
      user: p.user,
      cpu,
      mem: rss,
      vszKb: Math.round(rss * rnd(2.5, 6) * 1024),
      stat: Math.random() < 0.1 ? 'R' : (Math.random() < 0.03 ? 'Z' : 'S'),
      cmd: p.cmd,
      ticks: ri(0, 3600000),
      startedAt: Math.floor((BOOT_T + rnd(1, 3600) * 1000) / 1000),
    };
  });
  picked.sort((a, b) => b.cpu - a.cpu);

  const procTotal = ri(120, 190);
  const procRunning = ri(1, 3);
  const procZombie = ri(0, 2);
  const procSleeping = procTotal - procRunning - procZombie;

  return {
    at: Date.now(),
    uptimeSec: Math.floor((Date.now() - BOOT_T) / 1000),
    load: [load1, load5, load15],
    cpu: total,
    cores: cores.map(f1),
    cpuUser: user,
    cpuSys: sys,
    cpuIdle: idle,
    cpuWait: wait,
    cpuSampled: true,
    cpuModel: 'ARMv7 Processor rev 4 (v7l)',
    cpuCount: 4,
    cpuMHz: f1(rnd(800, 1200)),
    mem: {
      total: totalMB, used, free,
      cached, buffers, shared, buffCache,
      available, swapTotal, swapUsed,
    },
    disk: {
      total: diskTotal, used: diskUsed, avail: diskAvail,
      usePct: f1((diskUsed / diskTotal) * 100),
      inodeTotal: 442368, inodeFree: ri(300000, 380000),
    },
    net,
    procs: picked,
    procTotal, procRunning, procSleeping, procZombie,
  };
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `${d} days, ${h}:${String(m).padStart(2, '0')}`;
}

function bootTime() { return Math.floor(BOOT_T / 1000); }

module.exports = { sample, fmtUptime, bootTime };

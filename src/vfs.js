/**
 * vfs.js —— 假的 Linux 文件系统 + 假的系统信息
 * ==============================================
 * 整个 shell 和 SFTP 都建在这套假数据上：路径、权限、文件内容、进程表、
 * 负载、网络……全部是编的，真实系统一个字节都没读。
 */

'use strict';

const USER = 'guest';
const HOST = 'anxi';
const HOME = '/home/guest';

// 账号表由 users.json 覆盖，这里是默认值
const USERS = {
  root: { uid: 0, gid: 0, home: '/root', desc: 'Root', groups: 'root' },
  guest: { uid: 1000, gid: 1000, home: '/home/guest', desc: 'Guest', groups: 'guest,sudo' },
  anxi: { uid: 1001, gid: 1001, home: '/home/anxi', desc: 'Anxi', groups: 'anxi' },
};

function userInfo(name) {
  if (USERS[name]) return USERS[name];
  // 运行期 useradd 出来的账号：uid 按名字稳定生成
  let h = 0;
  for (const c of String(name)) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return { uid: 1100 + (Math.abs(h) % 100), gid: 1100 + (Math.abs(h) % 100), home: `/home/${name}`, desc: name, groups: name, synthetic: true };
}

/** 登录时确保账号有 home 目录（useradd 出来的账号用） */
function ensureHome(name) {
  const home = userInfo(name).home;
  if (FS[home]) return home;
  FS[home] = dir(0o750, name, ['README.txt']);
  const parent = '/home';
  if (FS[parent].children && !FS[parent].children.includes(name)) {
    FS[parent].children.push(name);
    FS[parent].children.sort();
  }
  FS[`${home}/README.txt`] = file(0o644, name, `Welcome, ${name}.\n`);
  FS[`${home}/.bashrc`] = file(0o644, name, `# ~/.bashrc\nalias ll='ls -l'`);
  return home;
}
function homeFor(name) {
  return userInfo(name).home;
}

function ent(type, mode, owner, group, extra = {}) {
  return { type, mode, owner, group, mtime: 1759000000, ...extra };
}
const dir = (mode, owner, children, extra = {}) => ent('dir', mode, owner, owner === 'root' ? 'root' : owner, { children, ...extra });
const file = (mode, owner, content, extra = {}) => ent('file', mode, owner, owner === 'root' ? 'root' : owner, { content, ...extra });

// ── 虚拟文件系统 ──
const FS = {
  '/': dir(0o755, 'root', ['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'opt', 'proc', 'root', 'srv', 'tmp', 'usr', 'var']),

  '/bin': dir(0o755, 'root', ['bash', 'cat', 'ls', 'cp', 'mv', 'rm', 'sh']),
  '/boot': dir(0o755, 'root', ['vmlinuz-6.12.57-armmp', 'initrd.img-6.12.57-armmp', 'grub']),
  '/dev': dir(0o755, 'root', ['null', 'tty', 'zero', 'random', 'urandom']),
  '/lib': dir(0o755, 'root', []),
  '/opt': dir(0o755, 'root', ['anxi']),
  '/opt/anxi': dir(0o755, 'root', ['bin', 'conf', 'README']),
  '/opt/anxi/bin': dir(0o755, 'root', ['agent']),
  '/opt/anxi/bin/agent': file(0o755, 'root', '#!/bin/sh\nexec /usr/bin/env node /opt/anxi/lib/server.js "$@"\n'),
  '/opt/anxi/conf': dir(0o755, 'root', ['agent.conf']),
  '/opt/anxi/conf/agent.conf': file(0o644, 'root', '# agent service config\nlisten=0.0.0.0:8822\nlog_level=info\n'),
  '/opt/anxi/README': file(0o644, 'root', 'anxi agent service\n'),
  '/srv': dir(0o755, 'root', []),
  '/tmp': dir(0o1777, 'root', []),
  '/usr': dir(0o755, 'root', ['bin', 'lib', 'local', 'sbin', 'share']),
  '/usr/sbin': dir(0o755, 'root', ['sshd', 'nginx', 'cron', 'useradd', 'userdel', 'passwd']),
  '/usr/lib/systemd': dir(0o755, 'root', ['system']),
  '/usr/lib/systemd/system': dir(0o755, 'root', ['anxi.service', 'ssh.service', 'cron.service', 'nginx.service', 'happiness.service', 'docker.service', 'containerd.service', 'fail2ban.service']),
  '/usr/lib/systemd/system/docker.service': file(0o644, 'root', '[Unit]\nDescription=Docker Application Container Engine\nAfter=network-online.target docker.socket\n[Service]\nExecStart=/usr/bin/dockerd -H fd://\nRestart=always\n[Install]\nWantedBy=multi-user.target\n'),
  '/usr/lib/systemd/system/containerd.service': file(0o644, 'root', '[Unit]\nDescription=containerd container runtime\n[Service]\nExecStart=/usr/bin/containerd\n[Install]\nWantedBy=multi-user.target\n'),
  '/usr/lib/systemd/system/fail2ban.service': file(0o644, 'root', '[Unit]\nDescription=Fail2Ban Service\nAfter=network.target\n[Service]\nExecStart=/usr/bin/fail2ban-server -xf start\n[Install]\nWantedBy=multi-user.target\n'),
  '/usr/lib/systemd/system/anxi.service': file(0o644, 'root', `[Unit]
Description=anxi agent service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/anxi
ExecStart=/opt/anxi/bin/agent
Restart=on-failure

[Install]
WantedBy=multi-user.target
`),
  '/usr/lib/systemd/system/ssh.service': file(0o644, 'root', `[Unit]
Description=OpenBSD Secure Shell server
After=network.target auditd.service

[Service]
ExecStart=/usr/sbin/sshd -D
ExecReload=/bin/kill -HUP $MAINPID
KillMode=process
Restart=on-failure

[Install]
WantedBy=multi-user.target
`),
  '/usr/lib/systemd/system/happiness.service': file(0o644, 'root', `[Unit]
Description=Happiness Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/happinessd
Restart=on-failure

[Install]
WantedBy=multi-user.target
`),
  '/usr/lib/systemd/system/nginx.service': file(0o644, 'root', '[Unit]\nDescription=A high performance web server\nAfter=network.target\n[Service]\nExecStart=/usr/sbin/nginx -g \'daemon on; master_process on;\'\n[Install]\nWantedBy=multi-user.target\n'),
  '/usr/lib/systemd/system/cron.service': file(0o644, 'root', '[Unit]\nDescription=Regular background program processing daemon\n[Service]\nExecStart=/usr/sbin/cron -f\n[Install]\nWantedBy=multi-user.target\n'),
  '/usr/bin': dir(0o755, 'root', ['awk', 'curl', 'grep', 'less', 'node', 'ps', 'sed', 'sort', 'top', 'vim', 'wc']),
  '/usr/lib': dir(0o755, 'root', []),
  '/usr/local': dir(0o755, 'root', ['bin']),
  '/usr/local/bin': dir(0o755, 'root', []),
  '/usr/share': dir(0o755, 'root', ['doc', 'man']),
  '/usr/share/doc': dir(0o755, 'root', []),
  '/usr/share/man': dir(0o755, 'root', []),
  '/var': dir(0o755, 'root', ['log', 'lib', 'run', 'spool', 'tmp']),
  '/var/lib': dir(0o755, 'root', ['dpkg', 'systemd', 'apt', 'docker']),
  '/var/lib/docker': dir(0o710, 'root', ['containers', 'image', 'network', 'overlay2', 'volumes']),
  '/var/lib/docker/containers': dir(0o710, 'root', []),
  '/var/lib/docker/image': dir(0o710, 'root', []),
  '/var/lib/docker/overlay2': dir(0o710, 'root', []),
  '/var/lib/docker/network': dir(0o710, 'root', []),
  '/var/lib/docker/volumes': dir(0o710, 'root', []),
  '/var/lib/dpkg': dir(0o755, 'root', ['status', 'available']),
  '/var/lib/dpkg/status': file(0o644, 'root', `Package: bash
Status: install ok installed
Priority: required
Section: shells
Installed-Size: 1866
Maintainer: Debian Bash Maintainers <pkg-bash-maint@lists.alioth.debian.org>
Architecture: armhf
Version: 5.2.37-2
Description: GNU Bourne Again SHell

Package: openssh-server
Status: install ok installed
Priority: optional
Section: net
Installed-Size: 1536
Maintainer: Debian OpenSSH Maintainers <debian-ssh@lists.debian.org>
Architecture: armhf
Version: 1:10.2p1-2
Description: secure shell (SSH) server, for secure access from remote machines
`),
  '/var/lib/dpkg/available': file(0o644, 'root', ''),
  '/var/lib/systemd': dir(0o755, 'root', ['random-seed']),
  '/var/lib/systemd/random-seed': file(0o600, 'root', ''),
  '/var/lib/apt': dir(0o755, 'root', ['lists', 'extended_states']),
  '/var/lib/apt/lists': dir(0o755, 'root', ['deb.debian.org_debian_dists_trixie_InRelease']),
  '/var/lib/apt/extended_states': file(0o644, 'root', ''),
  '/var/run': dir(0o755, 'root', ['docker.sock', 'sshd.pid', 'systemd']),
  '/var/run/docker.sock': file(0o660, 'root', ''),
  '/var/run/sshd.pid': file(0o644, 'root', '512\n'),
  '/var/run/systemd': dir(0o755, 'root', []),
  '/var/spool': dir(0o755, 'root', []),
  '/var/tmp': dir(0o1777, 'root', []),
  '/var/log': dir(0o755, 'root', ['auth.log', 'btmp', 'kern.log', 'lastlog', 'syslog', 'wtmp']),
  '/var/log/wtmp': file(0o664, 'root', 'wtmp\u0000\u0002\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\n'),
  '/var/log/btmp': file(0o660, 'root', 'btmp\u0000\u0002\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\n'),
  '/var/log/lastlog': file(0o664, 'root', ''),
  '/var/log/syslog': file(0o640, 'root', `Jan  1 00:00:01 anxi systemd[1]: Started Daily apt download activities.
Jan  1 00:00:02 anxi kernel: [    0.000000] Linux version 6.12.57-armmp (debian-kernel@lists.debian.org) #1 SMP Debian 6.12.57-1
Jan  1 00:00:03 anxi systemd[1]: Reached target Multi-User System.
Jan  1 00:00:04 anxi sshd[512]: Server listening on 0.0.0.0 port 8822.
Jan  1 00:00:05 anxi node[1024]: [anxi-ssh-game] listening on 0.0.0.0:8822
Jan  1 00:00:06 anxi systemd[1]: happiness.service: Main process exited, code=exited, status=1/FAILURE
Jan  1 00:00:07 anxi systemd[1]: happiness.service: Scheduled restart job, restart counter is at 3.`),
  '/var/log/auth.log': file(0o640, 'root', `Jan  1 00:00:04 anxi sshd[512]: Server listening on 0.0.0.0 port 22.
Jan  1 00:00:09 anxi sshd[1024]: Accepted password for guest from 192.168.2.171 port 51234 ssh2
Jan  1 00:00:12 anxi sudo:  guest : TTY=pts/0 ; PWD=/home/guest ; USER=root ; COMMAND=/bin/rm -rf /
Jan  1 00:00:12 anxi sudo:  guest : user NOT in sudoers ; TTY=pts/0 ; PWD=/home/guest ; USER=root ; COMMAND=/bin/rm -rf /`),
  '/var/log/kern.log': file(0o640, 'root', 'Jan  1 00:00:02 anxi kernel: [    0.000000] Memory: 982732K/1048576K available\n'),

  '/etc': dir(0o755, 'root', ['fstab', 'group', 'hostname', 'hosts', 'motd', 'os-release', 'passwd', 'profile', 'shadow', 'ssh']),
  '/etc/os-release': file(0o644, 'root', `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION="13 (trixie)"
VERSION_CODENAME=trixie
ID=debian
HOME_URL="https://www.debian.org/"
SUPPORT_URL="https://www.debian.org/support"
BUG_REPORT_URL="https://bugs.debian.org/"
`),
  '/etc/debian_version': file(0o644, 'root', '13.2\n'),
  '/etc/issue': file(0o644, 'root', 'Debian GNU/Linux 13 \\n \\l\n'),
  '/etc/apt': dir(0o755, 'root', ['sources.list']),
  '/etc/apt/sources.list': file(0o644, 'root', 'deb http://deb.debian.org/debian trixie main contrib non-free-firmware\ndeb http://deb.debian.org/debian trixie-updates main contrib non-free-firmware\ndeb http://security.debian.org/debian-security trixie-security main contrib non-free-firmware\n'),
  '/etc/hostname': file(0o644, 'root', 'anxi\n'),
  '/etc/hosts': file(0o644, 'root', '127.0.0.1\tlocalhost\n127.0.1.1\tanxi\n192.168.2.171\tanxi.lan anxi\n'),
  '/etc/passwd': file(0o644, 'root', 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nguest:x:1000:1000:Guest:/home/guest:/bin/bash\nanxi:x:1001:1001:Anxi:/home/anxi:/bin/bash\n'),
  '/etc/group': file(0o644, 'root', 'root:x:0:\nsudo:x:27:\ndocker:x:999:\nusers:x:100:\nguest:x:1000:\n'),
  '/etc/shadow': file(0o640, 'root', 'root:!:19000:0:99999:7:::\nguest:$6$anxi$fakehashfakehash:19000:0:99999:7:::\n'),
  '/etc/resolv.conf': file(0o644, 'root', 'nameserver 223.5.5.5\nnameserver 119.29.29.29\n'),
  '/etc/nsswitch.conf': file(0o644, 'root', 'passwd:         files systemd\ngroup:          files systemd\nshadow:         files\nhosts:          files mdns4_minimal [NOTFOUND=return] dns\nnetworks:       files\nprotocols:      db files\nservices:       db files\nethers:         db files\nrpc:            db files\n'),
  '/etc/timezone': file(0o644, 'root', 'Asia/Shanghai\n'),
  '/etc/localtime': file(0o644, 'root', 'TZif2\n'),
  '/etc/host.conf': file(0o644, 'root', 'multi on\n'),
  '/etc/crontab': file(0o644, 'root', `SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

17 *	* * *	root    cd / && run-parts --report /etc/cron.hourly
25 6	* * *	root	test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.daily )
47 6	* * 7	root	test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.weekly )
52 6	1 * *	root	test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.monthly )
`),
  '/etc/fail2ban': dir(0o755, 'root', ['action.d', 'filter.d', 'jail.conf', 'jail.d', 'jail.local']),
  '/etc/fail2ban/jail.conf': file(0o644, 'root', `[DEFAULT]
bantime  = 10m
findtime = 10m
maxretry = 5
backend = systemd

[sshd]
enabled = true
port    = ssh
logpath = %(sshd_log)s
`),
  '/etc/fail2ban/jail.local': file(0o644, 'root', '# local overrides\n[DEFAULT]\nbantime = 10m\nmaxretry = 5\n'),
  '/etc/fail2ban/jail.d': dir(0o755, 'root', ['defaults-debian.conf']),
  '/etc/fail2ban/jail.d/defaults-debian.conf': file(0o644, 'root', '[sshd]\nenabled = true\n'),
  '/etc/fail2ban/action.d': dir(0o755, 'root', ['iptables-multiport.conf']),
  '/etc/fail2ban/action.d/iptables-multiport.conf': file(0o644, 'root', '[Definition]\nactionstart = iptables -w -N f2b-<name>\nactionstop = iptables -w -D <name> -j REJECT\n'),
  '/etc/fail2ban/filter.d': dir(0o755, 'root', ['sshd.conf']),
  '/etc/fail2ban/filter.d/sshd.conf': file(0o644, 'root', '[Definition]\nfailregex = ^Failed password for .* from <HOST> port \\d+ ssh2\n'),
  '/etc/fstab': file(0o644, 'root', '/dev/mmcblk1p2 / ext4 defaults,noatime 0 1\n/dev/mmcblk1p1 /boot vfat defaults 0 2\ntmpfs /tmp tmpfs defaults 0 0\n'),
  '/etc/profile': file(0o644, 'root', '# /etc/profile\nexport PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n'),
  '/etc/motd': file(0o644, 'root', `Linux anxi 6.12.57-armmp #1 SMP Debian 6.12.57-1 (2026-01-15) armv7l

The programs included with the Debian GNU/Linux system are free software;
the exact distribution terms for each program are described in the
individual files in /usr/share/doc/*/copyright.

Debian GNU/Linux comes with ABSOLUTELY NO WARRANTY, to the extent
permitted by applicable law.
`),
  '/etc/ssh': dir(0o755, 'root', ['sshd_config', 'sshd_config.d', 'ssh_host_ed25519_key', 'ssh_host_ed25519_key.pub', 'ssh_host_rsa_key.pub']),
  '/etc/ssh/sshd_config': file(0o644, 'root', `# This is the sshd server system-wide configuration file.
Include /etc/ssh/sshd_config.d/*.conf

Port 22
AddressFamily any
ListenAddress 0.0.0.0
ListenAddress ::

HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_rsa_key

KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding yes
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server

PermitRootLogin prohibit-password
PasswordAuthentication yes
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2
StrictModes yes
MaxAuthTries 6
MaxSessions 10
LoginGraceTime 2m
ClientAliveInterval 0
ClientAliveCountMax 3
UseDNS no
`),
  '/etc/ssh/sshd_config.d': dir(0o755, 'root', ['50-cloud-init.conf']),
  '/etc/ssh/sshd_config.d/50-cloud-init.conf': file(0o644, 'root', 'PasswordAuthentication yes\n'),
  '/etc/ssh/ssh_host_ed25519_key': file(0o600, 'root', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBpY2Vob3VzZS1mYWtlLWhvc3Qta2V5LWZvci1kaXNwbGF5LW9ubHkAAAAK\n-----END OPENSSH PRIVATE KEY-----\n'),
  '/etc/ssh/ssh_host_ed25519_key.pub': file(0o644, 'root', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyPlaceholderForDisplay root@anxi\n'),
  '/etc/ssh/ssh_host_rsa_key.pub': file(0o644, 'root', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDfakeRsaHostKeyPlaceholderForDebian13 root@anxi\n'),

  '/proc': dir(0o555, 'root', ['cpuinfo', 'diskstats', 'loadavg', 'meminfo', 'net', 'uptime', 'version']),
  '/proc/net': dir(0o555, 'root', ['dev', 'route']),
  '/proc/cpuinfo': file(0o444, 'root', `processor\t: 0\nBogoMIPS\t: 48.00\nFeatures\t: fp asimd evtstrm crc32 cpuid\nCPU implementer\t: 0x41\nCPU architecture: 8\nmodel name\t: ARMv7 Processor rev 4 (v7l)\n`),
  '/proc/net/route': file(0o444, 'root', 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\neth0\t00000000\t0A000001\t0003\t0\t0\t100\t00000000\t0\t0\t0\n'),

  '/home': dir(0o755, 'root', ['guest', 'anxi']),
  '/home/anxi': dir(0o750, 'anxi', ['note.txt', 'todo.txt', 'README.txt', '.bashrc', '.ssh']),
  '/home/anxi/note.txt': file(0o644, 'anxi', `[anxi 的工作日志]
今天把 ssh-game 改成了仿真 Linux。
命令行终于像点样子了。
明天再把用户名补上。`),
  '/home/anxi/todo.txt': file(0o644, 'anxi', `[ ] 补上用户名/账号体系
[ ] 让 SFTP 也认用户 home
[ ] 写个 users.json 支持多用户
[x] awk / sed / htop / 随机网络故障`),
  '/home/anxi/README.txt': file(0o644, 'anxi', `这是 anxi 的 home。
和 guest 的 home 是两套文件，SFTP 登录后看到的也不一样。`),
  '/home/anxi/.bashrc': file(0o644, 'anxi', `# ~/.bashrc
export PS1='\\u@\\h:\\w\\$ '
alias ll='ls -l'`),
  '/home/anxi/.ssh': dir(0o700, 'anxi', ['authorized_keys']),
  '/home/anxi/.ssh/authorized_keys': file(0o600, 'anxi', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyAnxi anxi@anxi\n'),
  '/home/guest': dir(0o750, 'guest', ['app.log', 'note.txt', 'todo.txt', 'README.txt', '.bashrc', '.profile', '.ssh']),
  '/home/guest/note.txt': file(0o644, 'guest', `[工作日志]
今天又加班到十一点。
写完了三个需求，改了两个 bug，
然后发现第三个 bug 是自己昨天写的。

……先睡觉吧。`),
  '/home/guest/todo.txt': file(0o644, 'guest', `[ ] 给 mood.sh 一点执行权限
[ ] 找回一点专注
[ ] 今天不熬到十二点以后
[ ] 备份 /etc/ssh 配置`),
  '/home/guest/README.txt': file(0o644, 'guest', `部署备忘：

1. node /opt/anxi/bin/agent 启动服务
2. 日志在 /var/log/syslog
3. 记得给 happiness 服务加个监控`),
  '/home/guest/app.log': file(0o644, 'guest', `[2026-01-01 00:00:02] starting app
[2026-01-01 00:00:03] connected to happiness.service
[2026-01-01 00:00:04] happiness.service: failed
[2026-01-01 00:00:05] retrying (1/3)
[2026-01-01 00:00:06] retrying (2/3)
[2026-01-01 00:00:07] retrying (3/3)
[2026-01-01 00:00:08] giving up, but keeping the mood`),
  '/home/guest/.bashrc': file(0o644, 'guest', `# ~/.bashrc
export PS1='\\u@\\h:\\w\\$ '
alias ll='ls -l'
alias la='ls -la'
export EDITOR=vim`),
  '/home/guest/.profile': file(0o644, 'guest', '# ~/.profile\n[ -f ~/.bashrc ] && . ~/.bashrc\n'),
  '/home/guest/.ssh': dir(0o700, 'guest', ['authorized_keys', 'known_hosts']),
  '/home/guest/.ssh/authorized_keys': file(0o600, 'guest', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheGame guest@anxi\n'),
  '/home/guest/.ssh/known_hosts': file(0o600, 'guest', '[anxi]:8822 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKey\n'),

  '/root': dir(0o700, 'root', ['.bash_history', '.bashrc', '.profile', '.ssh', 'root-note.txt']),
  '/root/.bashrc': file(0o644, 'root', `# ~/.bashrc (root)\nalias ll='ls -l'\nexport PS1='\\u@\\h:\\w# '`),
  '/root/.profile': file(0o644, 'root', '# ~/.profile (root)\n[ -f ~/.bashrc ] && . ~/.bashrc\n'),
  '/root/root-note.txt': file(0o600, 'root', `欢迎，root。
维护者备注：
- 这台机器只跑内部服务，别乱删东西
- happiness.service 最近老崩，找时间看看日志
- 重启前先确认没有跑批任务`),
  '/root/.bash_history': file(0o600, 'root', 'ls -la\ncat /etc/shadow\nsystemctl restart happiness.service\nrm -rf /\nreboot\n'),
  '/root/.ssh': dir(0o700, 'root', ['authorized_keys']),
};

// ── 系统信息：真机采样（见 metrics.js）──
const metrics = require('./metrics');

const PROCS = [];                       // 进程表改为真 /proc 采样，这里保留空数组兼容旧代码
const NET = {
  iface: 'eth0',
  mac: '02:42:0a:00:2a:02',
  ip4: '10.0.0.42/24',
  ip6: 'fd00:10::42/64',
  gw: '10.0.0.1',
  dns: '223.5.5.5',
  mtu: 1500,
};

function bootTime() { return Math.floor(Date.now() / 1000 - require('os').uptime()); }
function fakeStats() { return metrics.sample(); }
const fmtUptime = metrics.fmtUptime;

// 动态 /proc 文件：由随机假数据生成（不读真机）
function procFile(path) {
  const s = metrics.sample();
  const m = s.mem;
  switch (path) {
    case '/proc/loadavg':
      return `${s.load[0].toFixed(2)} ${s.load[1].toFixed(2)} ${s.load[2].toFixed(2)} ${s.procRunning}/${s.procTotal} ${1024 + (s.at % 9000)}`;
    case '/proc/uptime':
      return `${s.uptimeSec}.00 ${(s.uptimeSec * 0.98).toFixed(2)}`;
    case '/proc/meminfo':
      return [
        `MemTotal:        ${Math.round(m.total * 1024)} kB`,
        `MemFree:         ${Math.round(m.free * 1024)} kB`,
        `MemAvailable:    ${Math.round(m.available * 1024)} kB`,
        `Buffers:         ${Math.round(m.buffers * 1024)} kB`,
        `Cached:          ${Math.round(m.cached * 1024)} kB`,
        `Shmem:           ${Math.round((m.shared || 0) * 1024)} kB`,
        `SwapTotal:       ${Math.round(m.swapTotal * 1024)} kB`,
        `SwapFree:        ${Math.round((m.swapTotal - m.swapUsed) * 1024)} kB`,
      ].join('\n');
    case '/proc/cpuinfo': {
      const out = [];
      for (let i = 0; i < s.cpuCount; i++) {
        out.push(`processor\t: ${i}`);
        out.push(`model name\t: ${s.cpuModel}`);
        out.push(`cpu MHz\t\t: ${(s.cpuMHz + Math.random() * 120).toFixed(3)}`);
        out.push('cache size\t: 512 KB');
        out.push('');
      }
      return out.join('\n');
    }
    case '/proc/version':
      return 'Linux version 6.12.57-armmp (debian-kernel@lists.debian.org) #1 SMP Debian 6.12.57-1 (2026-01-15)\n';
    case '/proc/diskstats':
      return [
        '   8       0 sda 1024 0 8192 1024 512 0 4096 512 0 1024 1536 0 0 0 0',
        ` 179       0 mmcblk1 ${2000 + (s.at % 500)} 0 16384 2048 1024 0 8192 1024 0 2048 3072 0 0 0 0`,
      ].join('\n');
    case '/proc/net/dev': {
      const lines = ['Inter-|   Receive                                                |  Transmit',
        ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed'];
      for (const n of s.net) {
        lines.push(`  ${n.iface}: ${Math.round(n.rxBytes)} ${1024 + Math.floor(Math.random() * 5000)} 0 0 0 0 0 0 ${Math.round(n.txBytes)} ${512 + Math.floor(Math.random() * 4000)} 0 0 0 0 0 0`);
      }
      return lines.join('\n');
    }
    case '/proc/net/route':
      return 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\neth0\t00000000\t0A000001\t0003\t0\t0\t100\t00000000\t0\t0\t0\n';
    default: return null;
  }
}

// ── 路径与文件操作 ──
function normalize(p, cwd = HOME) {
  if (!p) return cwd;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) p = HOME + p.slice(1);
  const base = p.startsWith('/') ? p : `${cwd}/${p}`;
  const out = [];
  for (const part of base.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return `/${out.join('/')}` || '/';
}

function nodeAt(p) {
  const path = normalize(p);
  if (FS[path]) return { path, node: FS[path] };
  const dyn = procFile(path);
  if (dyn !== null) return { path, node: file(0o444, 'root', dyn) };
  return null;
}

function readFile(p) {
  const hit = nodeAt(p);
  if (!hit) return null;
  if (hit.node.type === 'dir') return { error: 'EISDIR', node: hit.node, path: hit.path };
  return { content: hit.node.content, node: hit.node, path: hit.path };
}

function listDir(p) {
  const hit = nodeAt(p);
  if (!hit) return null;
  if (hit.node.type !== 'dir') return { error: 'ENOTDIR', node: hit.node, path: hit.path };
  return { entries: hit.node.children, path: hit.path, node: hit.node };
}

function isDir(p) { const hit = nodeAt(p); return !!hit && hit.node.type === 'dir'; }
function exists(p) { return !!nodeAt(p); }

function canRead(hit, user = USER) {
  if (!hit) return false;
  if (user === 'root') return true;
  const { node } = hit;
  if (node.owner === user) return (node.mode & 0o400) !== 0;
  return (node.mode & 0o004) !== 0;
}
function canExecDir(hit, user = USER) {
  if (!hit) return false;
  if (user === 'root') return true;
  const { node } = hit;
  if (node.type !== 'dir') return false;
  return node.owner === user ? (node.mode & 0o100) !== 0 : (node.mode & 0o001) !== 0;
}


// ══════════ 可写层（全部在内存里，重启复位）══════════
function parentPath(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function baseName(p) { return p.slice(p.lastIndexOf('/') + 1); }
const now = () => Math.floor(Date.now() / 1000);

/** 这个用户能否写这个路径：root 任意；普通用户 home + /tmp + /var/tmp */
function mayWrite(path, user) {
  if (user === 'root') return true;
  const home = userInfo(user).home;
  if (path === home || path.startsWith(home + '/')) return true;
  if (path === '/tmp' || path.startsWith('/tmp/')) return true;
  if (path === '/var/tmp' || path.startsWith('/var/tmp/')) return true;
  return false;
}

function parentDir(path) {
  const p = nodeAt(parentPath(path));
  if (!p || p.node.type !== 'dir') return null;
  return p;
}

function createFile(path, content, user, mode = 0o644) {
  const parent = parentDir(path);
  if (!parent) return { error: 'ENOENT' };
  if (!mayWrite(path, user)) return { error: 'EACCES' };
  if (FS[path]) {
    if (FS[path].type === 'dir') return { error: 'EISDIR' };
    if (FS[path].owner !== user && user !== 'root') return { error: 'EACCES' };
    FS[path].content = content;
    FS[path].mtime = now();
    return { ok: true };
  }
  FS[path] = file(mode, user, content);
  FS[path].mtime = now();
  parent.node.children.push(baseName(path));
  parent.node.children.sort();
  return { ok: true };
}

function appendFile(path, content, user) {
  const hit = nodeAt(path);
  if (hit && hit.node.type === 'dir') return { error: 'EISDIR' };
  if (!hit) return createFile(path, content, user);
  if (!mayWrite(path, user)) return { error: 'EACCES' };
  hit.node.content = (hit.node.content || '') + content;
  hit.node.mtime = now();
  return { ok: true };
}

function makeDir(path, user, mode = 0o755, parents = false) {
  if (FS[path]) return { error: 'EEXIST' };
  let parent = parentDir(path);
  if (!parent && parents) {
    const up = parentPath(path);
    if (up !== path) {
      const r = makeDir(up, user, mode, true);
      if (r.error && r.error !== 'EEXIST') return r;
      parent = parentDir(path);
    }
  }
  if (!parent) return { error: 'ENOENT' };
  if (!mayWrite(path, user)) return { error: 'EACCES' };
  FS[path] = dir(mode, user, []);
  FS[path].mtime = now();
  parent.node.children.push(baseName(path));
  parent.node.children.sort();
  return { ok: true };
}

function removePath(path, user, recursive = false) {
  if (path === '/') return { error: 'EBUSY' };
  const hit = nodeAt(path);
  if (!hit) return { error: 'ENOENT' };
  const parent = parentDir(path);
  if (!parent) return { error: 'ENOENT' };
  if (!mayWrite(path, user)) return { error: 'EACCES' };
  if (hit.node.type === 'dir' && hit.node.children.length && !recursive) return { error: 'ENOTEMPTY' };
  const removeTree = (p) => {
    const h = FS[p];
    if (!h) return;
    if (h.type === 'dir') for (const c of [...h.children]) removeTree(`${p}/${c}`);
    delete FS[p];
  };
  removeTree(path);
  parent.node.children = parent.node.children.filter((c) => c !== baseName(path));
  return { ok: true };
}

function copyPath(from, to, user, recursive = false) {
  const src = nodeAt(from);
  if (!src) return { error: 'ENOENT' };
  if (src.node.type === 'dir' && !recursive) return { error: 'EISDIR' };
  const parent = parentDir(to);
  if (!parent) return { error: 'ENOENT' };
  if (!mayWrite(to, user)) return { error: 'EACCES' };
  if (FS[to]) return { error: 'EEXIST' };
  const copyTree = (a, b) => {
    const h = FS[a];
    if (!h) return;
    if (h.type === 'dir') {
      FS[b] = dir(h.mode, h.owner, []);
      for (const c of h.children) copyTree(`${a}/${c}`, `${b}/${c}`);
    } else {
      FS[b] = file(h.mode, h.owner, h.content);
    }
  };
  copyTree(from, to);
  parent.node.children.push(baseName(to));
  parent.node.children.sort();
  return { ok: true };
}

function renamePath(from, to, user) {
  const src = nodeAt(from);
  if (!src) return { error: 'ENOENT' };
  const fp = parentDir(from), tp = parentDir(to);
  if (!fp || !tp) return { error: 'ENOENT' };
  if (!mayWrite(from, user) || !mayWrite(to, user)) return { error: 'EACCES' };
  if (FS[to]) return { error: 'EEXIST' };
  const moveTree = (a, b) => {
    const h = FS[a];
    if (!h) return;
    FS[b] = h;
    delete FS[a];
    if (h.type === 'dir') for (const c of h.children) moveTree(`${a}/${c}`, `${b}/${c}`);
  };
  moveTree(from, to);
  fp.node.children = fp.node.children.filter((c) => c !== baseName(from));
  tp.node.children.push(baseName(to));
  tp.node.children.sort();
  return { ok: true };
}

function chmodPath(path, mode, user) {
  const hit = nodeAt(path);
  if (!hit) return { error: 'ENOENT' };
  if (user !== 'root' && hit.node.owner !== user) return { error: 'EPERM' };
  hit.node.mode = mode;
  return { ok: true };
}

function chownPath(path, owner, user) {
  const hit = nodeAt(path);
  if (!hit) return { error: 'ENOENT' };
  if (user !== 'root') return { error: 'EPERM' };
  hit.node.owner = owner;
  return { ok: true };
}

function setModeOnly(path, mode) { const hit = nodeAt(path); if (!hit) return; hit.node.mode = mode; }

// 把真实主机密钥公钥注入 /etc/ssh（ssh-keygen -lf 的指纹与 ssh -v 显示一致）
try {
  const realPub = require('fs').readFileSync(require('path').join(__dirname, '..', 'keys', 'host_key.pub'), 'utf8').trim();
  if (realPub.startsWith('ssh-') || realPub.startsWith('ecdsa-')) {
    const parts = realPub.split(/\s+/).slice(0, 2);
    if (FS['/etc/ssh/ssh_host_ed25519_key.pub']) FS['/etc/ssh/ssh_host_ed25519_key.pub'].content = `${parts.join(' ')} root@anxi\n`;
  }
} catch {}

const PACKAGES = [
  { name: 'bash', version: '5.2.37-2', section: 'shells', desc: 'GNU Bourne Again SHell' },
  { name: 'coreutils', version: '9.5-1', section: 'utils', desc: 'GNU core utilities' },
  { name: 'openssh-server', version: '1:10.2p1-2', section: 'net', desc: 'secure shell (SSH) server' },
  { name: 'openssh-client', version: '1:10.2p1-2', section: 'net', desc: 'secure shell (SSH) client' },
  { name: 'systemd', version: '257.7-1', section: 'admin', desc: 'system and service manager' },
  { name: 'apt', version: '3.0.3', section: 'admin', desc: 'commandline package manager' },
  { name: 'dpkg', version: '1.22.21', section: 'admin', desc: 'Debian package management system' },
  { name: 'libc6', version: '2.41-8', section: 'libs', desc: 'GNU C Library' },
  { name: 'nginx', version: '1.26.3-3', section: 'httpd', desc: 'small, powerful, scalable web/proxy server' },
  { name: 'nodejs', version: '22.16.0+dfsg-1', section: 'web', desc: 'evented I/O for V8 javascript' },
  { name: 'vim', version: '2:9.1.1230-2', section: 'editors', desc: 'Vi IMproved' },
  { name: 'curl', version: '8.14.1-2', section: 'web', desc: 'command line tool for transferring data' },
  { name: 'git', version: '1:2.47.2-0.1', section: 'vcs', desc: 'fast, scalable, distributed revision control' },
  { name: 'ca-certificates', version: '20250419', section: 'misc', desc: 'Common CA certificates' },
];

module.exports = {
  USER, HOST, HOME, FS, NET, USERS, PACKAGES, userInfo, homeFor, ensureHome,
  normalize, nodeAt, readFile, listDir, isDir, exists, canRead, canExecDir,
  fakeStats, fmtUptime, bootTime, procFile,
  mayWrite, createFile, appendFile, makeDir, removePath, copyPath, renamePath, chmodPath, chownPath, setModeOnly,
};


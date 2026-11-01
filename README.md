# anxi-ssh-game

一个跑在 SSH 上的**仿真 Linux 终端**。`ssh 用户@主机 -p 8822` 连进去就是一台
**Debian GNU/Linux 13 (trixie)** —— 终端里的 `uname -a`、`/etc/os-release`、
登录 motd、SSH 版本串全部按 Debian 13 伪装，输出里没有任何"这是假系统"的字样。

> **v1.2**：去掉原来的游戏命令，改成仿真的 Linux 命令集；新增密码认证、只读假 SFTP、假负载查询。

## 特点

- **Debian 13 伪装**：motd / `uname -a` / `/etc/os-release` / `/etc/debian_version`（13.2）/
  SSH 版本串（OpenSSH_10.2p1 Debian）/ sshd_config（Debian 默认值 + `sshd_config.d/`）/
  dpkg 数据库 / systemd 单元文件都是真 Debian 的样子；root 提示符是 `#`
- **主机密钥指纹对得上**：`ssh -v` 里看到的 `SHA256:...` 和登录后
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 完全一致
- **像真 Linux**：`ls -la`、`ps aux`、`top`、`free -h`、`df -h`、`ip a`、`ss -tlnp`、
  `systemctl status`、`journalctl`、`grep`、管道 `|`、Tab 补全、vim 的 `:q`……输出、报错、
  权限提示都尽量和真机一致
- **文件系统可写**：`touch/mkdir/rm/mv/cp/chmod/tee`、`echo > file`、SFTP 上传下载都能用，
  写进的是**内存文件系统**（重启复位），不会真的动磁盘
- **负载数据是随机生成的假数据**：CPU/内存/磁盘/网络每次调用都变（不读真机）
- **不会弄坏真机**：所有操作只发生在内存里
- **有权限概念**：`/root`、`/etc/shadow`、`/var/log/*` 对普通用户不可读；`sudo` 会提示不在 sudoers
- **内置 root 账号**：root 登录后能读 `/etc/shadow`、`sudo` 直接执行、`systemctl restart happiness.service` 真的会把它拉起、`reboot` 会（假装）重启并断开 SSH
- **账号体系**：用户名 + 密码都要对（`users.json` 里配置），每个账号有自己的 home、uid、SFTP 目录
- **每个连接独立**：cwd、环境变量、history 互不干扰

## 快速开始

```bash
npm install
./start.sh            # 或 systemctl start ssh-game（已配好 systemd）
```

连接（账号见 `users.json`）：

```bash
ssh root@你的主机 -p 8822   # 密码 happy1024（uid 0，能读 /etc/shadow、能 restart 服务）
```

> 当前 users.json 里只有 `root` 一个账号。叫 root 的账号自动拥有 root 权限。
> 要加账号：`node scripts/add-user.js 用户名 '密码'` 然后重启服务。

> 所有负载数据（CPU / 内存 / 磁盘 / 网络 / 进程 / uptime）都是**随机生成的假数据**：
> 每次调用重新随机，范围参考一台 4 核 1GB 小机器，看起来合理但和真机无关。
> 文件系统、账号体系同样都是假的。

## 命令一览

| 类别 | 命令 |
|---|---|
| 文件 | `ls` `cd` `pwd` `cat` `head` `tail` `grep` `wc` `sort` `uniq` `find` `stat` `file` `du` `less` `more` |
| 文本处理 | `awk`（-F、print $n、NR/NF）、`sed`（s///、-n、p、d 范围）、`cut`/`tr` 部分 |
| 系统 | `uname -a` `hostname` `uptime` `date` `whoami` `id` `groups` `who` `w` `last` `ps aux` `top` `free -h` `kill` `pgrep` |
| 资源 | `df -h` `free` `top` `htop`（彩色）`nproc` `lscpu` `vmstat` `mpstat` `iostat` `net`（随机假数据） |
| 硬件/主机 | `hostnamectl` `lsblk` `mount` `ssh-keygen -lf` |
| 网络 | `ip a` `ifconfig` `ss -tlnp` `netstat` `ping`（随机丢包）`curl`（随机状态码/连接失败）`wget` |
| 服务 | `systemctl status/cat/list-unit-files` `service` `journalctl` `dmesg` `crontab` `dpkg -l/-s` `apt update/install/list` |
| 内置 | `history` `alias` `unalias` `export` `env` `printenv` `echo` `sleep` `true` `false` `clear` `exit` |
| 假编辑器 | `vim`（`:q` 退出）、`nano`（Ctrl+X 退出） |
| 只读拒绝 | `mkdir` `rm` `mv` `cp` `touch` `chmod` `chown` `tee`（返回 `Read-only file system`） |

## 假 SFTP

密码登录后可以用 `sftp -P 8822 任意名字@主机` 连上来，看到的是**只读虚拟文件系统**：

```
/            标准目录树（bin boot dev etc home lib opt proc root srv tmp usr var）
/home/guest  note.txt todo.txt README.txt app.log .bashrc .profile .ssh/
/etc         os-release hostname hosts passwd shadow ssh/sshd_config ...
/proc        cpuinfo loadavg meminfo diskstats net/dev uptime version
```

- 大部分为假数据、只读；写入 / 删除 / 改名 / 建目录一律 `Permission denied`
- 权限同样生效：`/etc/shadow`、`/root` 等不可读

## 账号（密码哈希）

`users.json`（项目根目录，权限 0600），密码以 **scrypt** 哈希存储，不存明文：

```json
{
  "users": {
    "guest": "scrypt$16384$8$1$<salt-hex>$<hash-hex>",
    "anxi":  "scrypt$16384$8$1$<salt-hex>$<hash-hex>"
  }
}
```

- 参数：scrypt N=16384, r=8, p=1, keylen=64，每个密码独立随机 salt
- 校验用 `crypto.timingSafeEqual`，防时序侧信道
- **懒人模式**：如果往 users.json 里直接写明文密码，启动时会自动哈希并写回（日志会提示迁移了几个）
- **不存在的用户名**：和真 OpenSSH 一样直接拒绝、不弹密码框（客户端只显示
  `Permission denied (publickey).`）
- 已知用户密码错：最多让试 3 次，超过后连接被断开（类似 `MaxAuthTries`）
- 每个账号有独立的 home（`/home/guest`、`/home/anxi`）、uid、提示符、SFTP 根目录

### root 账号的"特权"

登录 root 之后：

| 操作 | 结果 |
|---|---|
| `cat /etc/shadow` / `ls /root` | 可读（普通用户是 Permission denied） |
| `id` | `uid=0(root) gid=0(root) groups=0(root)` |
| `sudo <命令>` | 直接执行（不再报 not in sudoers） |
| `systemctl status happiness.service` | 初始 `failed` |
| `systemctl restart happiness.service` | 真的变成 `active (running)` |
| `systemctl stop happiness.service` | 变回 `inactive (dead)` |
| `reboot` / `shutdown` | 打印 "Connection to anxi closed by remote host." 并断开 SSH |

### root 的账号管理（运行时真改 users.json）

```bash
root@anxi:~$ useradd alice              # 新建账号，初始密码 changeme-1024
root@anxi:~$ cat /etc/passwd            # alice 立刻出现在里面
root@anxi:~$ passwd alice               # root 改别人的密码（不用旧密码）
root@anxi:~$ userdel alice              # 删除账号 + 虚拟 home
root@anxi:~$ passwd                     # 普通用户改自己密码：要先输当前密码
```

- 新账号**无需重启**即可登录（认证时重新读 users.json）
- 密码依旧存 scrypt 哈希；`/etc/shadow` 里只显示截断的哈希
- 普通用户 `useradd/userdel` → `Permission denied`，改别人密码 → 拒绝
- `passwd` 是交互式的：不回显、要二次确认；当前密码错误 → `Authentication token manipulation error`

### 当前账号

| 账号 | 密码 | home | uid |
|---|---|---|---|
| `root` | `happy1024` | `/root` | 0 |

只有 root 一个账号。首次登录后建议用 `passwd` 改掉演示密码。

### 添加 / 修改账号

```bash
# 生成一个哈希（自己贴进 users.json）
node scripts/hash-password.js '你的密码'

# 或者直接加/改账号（自动写哈希，权限 600）
node scripts/add-user.js newuser '你的密码'
systemctl restart ssh-game
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8822` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `SSH_PASSWORD` | `anxi-1024` | 没有 `users.json` 时的兜底密码（只有 guest 账号） |
| `SSH_HOST_KEY_PATH` | `keys/host_key` | 主机私钥路径 |
| `SSH_HOST_KEY` | — | 直接给私钥内容（优先于路径） |
| `DEBUG` | — | 设为任意值打印客户端错误 |

## 主机密钥

`ssh2` 只认 OpenSSH 格式。首次启动会自动跑 `ssh-keygen -t ed25519` 生成到 `keys/host_key`。

**注意**：换密钥后客户端会报 host key 变了，需要 `ssh-keygen -R "[主机]:8822"` 清掉旧记录。

## 说明

这是仿真环境（不是真的远程终端）：

- 没有真实 shell，没有任何命令会碰真实系统
- 不读写任何真实文件，不执行任何系统命令
- 账号/密码是存在的，但只用来区分 home 和提示符，没有真实的权限体系
- 知道账号密码就能连，**不要把它当成生产环境的 SSH 服务**

## 端口

默认 `8822`，避开标准 22 端口。要公网开放记得在防火墙/安全组放行。


## 致谢与来源

- 起点是 [anxi78/ssh-game](https://github.com/anxi78/ssh-game)（一个跑在 SSH 上的终端小游戏）
- 本项目在其基础上做了大幅重写：仿真 Linux 命令集、Debian 13 伪装、可写内存文件系统、
  假 SFTP、scrypt 账号体系、随机负载数据、root 特权等
- 原作者仓库未声明 License；如涉及版权问题，请先联系原作者

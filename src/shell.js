/**
 * shell.js —— 假的 Linux shell
 * =============================
 * 命令、输出、报错、权限提示都尽量仿真，但底层全是 src/vfs.js 里的假数据：
 * 不读真实文件、不跑真实命令、不会弄坏任何东西。
 */

'use strict';

const vfs = require('./vfs');
const users = require('./users');
const crypto = require('crypto');
const audit = require('./audit');

const { USER, HOST, HOME } = vfs;

const COMMANDS = [
  'help', 'ls', 'cd', 'pwd', 'cat', 'head', 'tail', 'grep', 'wc', 'sort', 'uniq',
  'find', 'stat', 'file', 'du', 'df', 'free', 'ps', 'top', 'kill', 'pgrep',
  'uname', 'hostname', 'uptime', 'date', 'whoami', 'id', 'groups', 'who', 'w', 'last',
  'ss', 'netstat', 'ip', 'ifconfig', 'ping', 'curl', 'wget',
  'systemctl', 'journalctl', 'service', 'dmesg', 'crontab',
  'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'touch', 'ln', 'chmod', 'chown', 'tee',
  'sudo', 'su', 'apt', 'apt-get', 'dpkg', 'hostnamectl', 'lsblk', 'mount', 'ssh-keygen', 'docker', 'fail2ban-client', 'lastb', 'reboot', 'shutdown', 'poweroff', 'passwd', 'useradd', 'userdel', 'usermod', 'su',
  'history', 'alias', 'unalias', 'export', 'env', 'printenv', 'echo', 'sleep', 'true', 'false', 'awk', 'sed', 'htop', 'nproc', 'lscpu', 'vmstat', 'iostat', 'mpstat', 'net',
  'clear', 'exit', 'logout', 'vim', 'vi', 'nano', 'less', 'more', 'man', 'git', 'tty', 'which', 'type',
];

const T = () => {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return {
    clock: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    date: `${days[d.getDay()]} ${mon[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${d.getHours()}:${pad(d.getMinutes())}:${pad(d.getSeconds())} CST ${d.getFullYear()}`,
    year: d.getFullYear(),
    ymd: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
};

function modeStr(mode, type) {
  const t = type === 'dir' ? 'd' : '-';
  const rwx = (bits) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
  return `${t}${rwx((mode >> 6) & 7)}${rwx((mode >> 3) & 7)}${rwx(mode & 7)}`;
}
function humanSize(bytes) {
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${u[i]}`;
}
const pad2 = (n) => String(n).padStart(2, ' ');

// 把路径翻译成相对 HOME 的显示形式
function tilde(p) { return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p; }

// 解析命令行（支持引号）
function tokenize(line) {
  const out = [];
  let cur = '', q = null, started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; started = true; continue; }
    if (c === ' ' || c === '\t') {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; started = true; continue; }
    cur += c;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

// 拆管道与重定向
function parsePipeline(line) {
  const stages = [];
  let cur = '', q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '|') { stages.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) stages.push(cur.trim());
  return stages;
}

class FakeShell {
  constructor(stream, client, user = USER) {
    this.stream = stream;
    this.client = client;
    this.buffer = '';
    this.closed = false;
    this.user = user;
    this.info = vfs.userInfo(user);
    this.home = vfs.ensureHome(user);
    this.cwd = this.home;
    this.editor = null;              // { name } 虚拟编辑器
    this.history = [];
    this.env = {
      USER: user, LOGNAME: user, HOME: this.home, SHELL: '/bin/bash', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      PWD: this.home, HOSTNAME: HOST, TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8',
    };
    this.aliases = { ll: 'ls -l', la: 'ls -la', l: 'ls -CF' };
    this.pwd = null;   // passwd 交互状态

    stream.on('data', (c) => this.onData(c));
    stream.on('close', () => this.close());
    stream.on('error', () => this.close());
  }

  // 统一行尾
  write(text) {
    if (this.closed) return;
    try {
      const s = String(text).replace(/\r?\n/g, '\r\n');
      this.stream.write(s);
    } catch { this.close(); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.stream.end(); } catch {}
    try { this.client.end(); } catch {}
  }

  prompt() {
    const mark = this.user === 'root' ? '#' : '$';
    this.write(`${this.user}@${HOST}:${this.tilde(this.cwd)}${mark} `);
  }

  tilde(p) {
    const h = this.home;
    return p === h ? '~' : p.startsWith(h + '/') ? '~' + p.slice(h.length) : p;
  }

  start() {
    const t = T();
    const motd = (vfs.readFile('/etc/motd') || {}).content || '';
    if (motd) this.write(motd + '\r\n');
    this.write(`Last login: ${t.date} from 10.0.0.2\r\n`);
    this.prompt();
  }

  onData(chunk) {
    if (this.closed) return;
    const text = chunk.toString('utf8');
    for (const ch of text) {
      if (this.closed) return;

      // passwd 交互模式（不回显）
      if (this.pwd) {
        this.handlePasswdKey(ch);
        continue;
      }

      // 虚拟编辑器模式：逐行读，不显示普通提示符
      if (this.editor) {
        this.handleEditorKey(ch);
        continue;
      }

      if (ch === '\x03') { this.write('^C\r\n'); this.buffer = ''; this.prompt(); continue; }
      if (ch === '\x04') { this.write('logout\r\n'); this.close(); return; }
      if (ch === '\x0c') { this.write('\x1b[2J\x1b[H'); this.buffer = ''; this.prompt(); continue; }
      if (ch === '\x7f' || ch === '\b') {
        if (this.buffer.length) {
          // 中文等多字节字符：按码点退格
          const chars = [...this.buffer];
          const last = chars.pop();
          this.buffer = chars.join('');
          this.write('\b'.repeat(1) + ' '.repeat([...last].length || 1) + '\b'.repeat([...last].length || 1));
        }
        continue;
      }
      if (ch === '\t') { this.complete(); continue; }
      if (ch === '\r' || ch === '\n') {
        this.write('\r\n');
        const line = this.buffer;
        this.buffer = '';
        this.runLine(line);
        return;
      }
      if (ch === '\x1b') { continue; } // 忽略方向键等
      if (ch >= ' ') { this.buffer += ch; this.write(ch); }
    }
  }

  resolve(p, base = this.cwd) {
    const h = this.home;
    let q = p;
    if (p === '~') q = h;
    else if (p.startsWith('~/')) q = h + p.slice(1);
    return vfs.normalize(q, base);
  }

  // ── Tab 补全 ──
  complete() {
    const m = this.buffer.match(/([^\s]*)$/);
    const word = m ? m[1] : '';
    const slash = word.lastIndexOf('/');
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
    const prefix = slash >= 0 ? word.slice(slash + 1) : word;
    const dirPath = this.resolve(dirPart || '.', this.cwd);
    const listing = vfs.listDir(dirPath);
    if (!listing || !listing.entries) return;
    const hits = listing.entries.filter((e) => e.startsWith(prefix)).sort();
    if (!hits.length) return;
    if (hits.length === 1) {
      const full = dirPart + hits[0] + (vfs.isDir(this.resolve(dirPart + hits[0], this.cwd)) ? '/' : ' ');
      this.buffer += full.slice(prefix.length + (slash >= 0 ? word.length - slash - 1 : 0));
      this.write(full.slice(prefix.length + (slash >= 0 ? word.length - slash - 1 : 0)));
    } else {
      this.write('\r\n' + hits.join('  ') + '\r\n');
      this.write(`${this.user}@${HOST}:${this.tilde(this.cwd)}${this.user === 'root' ? '#' : '$'} ` + this.buffer);
    }
  }

  // ── 虚拟编辑器 ──
  // ── passwd 交互（不回显）──
  handlePasswdKey(ch) {
    const st = this.pwd;
    if (ch === '\x03') { this.pwd = null; this.write('^C\r\n'); this.prompt(); return; }
    if (ch === '\x7f' || ch === '\b') { st.buf = st.buf.slice(0, -1); return; }
    if (ch === '\r' || ch === '\n') {
      this.write('\r\n');
      const val = st.buf;
      st.buf = '';
      if (st.step === 'current') {
        if (!users.verifyPassword(val, users.storedHash(st.target))) {
          this.write('passwd: Authentication token manipulation error\r\npasswd: password unchanged\r\n');
          this.pwd = null;
          this.prompt();
          return;
        }
        st.step = 'new';
        this.write('New password: ');
        return;
      }
      if (st.step === 'new') {
        if (!val) { this.write('passwd: 密码不能为空\r\npasswd: password unchanged\r\n'); this.pwd = null; this.prompt(); return; }
        st.newPw = val;
        st.step = 'confirm';
        this.write('Retype new password: ');
        return;
      }
      if (st.step === 'confirm') {
        if (val !== st.newPw) {
          this.write('Sorry, passwords do not match.\r\npasswd: password unchanged\r\n');
        } else {
          const r = users.changePassword(st.target, st.newPw);
          if (r.ok) this.write('passwd: password updated successfully\r\n');
          else this.write('passwd: Authentication token manipulation error\r\n');
        }
        this.pwd = null;
        this.prompt();
      }
      return;
    }
    if (ch >= ' ') { st.buf += ch; }   // 不回显
  }

  // ── 动态 /etc 文件（让 useradd 出来的人立刻出现在 /etc/passwd）──
  renderPasswd() {
    const names = users.listNames().sort((a, b) => (a === 'root' ? -1 : b === 'root' ? 1 : a.localeCompare(b)));
    return names.map((name) => {
      const i = vfs.userInfo(name);
      return `${name}:x:${i.uid}:${i.gid}:${i.desc || name}:${i.home}:/bin/bash`;
    }).join('\n') + '\n';
  }

  renderShadow() {
    const names = users.listNames().sort((a, b) => (a === 'root' ? -1 : b === 'root' ? 1 : a.localeCompare(b)));
    return names.map((name) => {
      const h = users.storedHash(name) || '';
      const shown = h.startsWith('scrypt$') ? '$scrypt$' + h.split('$')[5].slice(0, 16) + '…' : '!';
      return `${name}:${shown}:19000:0:99999:7:::`;
    }).join('\n') + '\n';
  }

  renderGroup() {
    const names = users.listNames().sort();
    const lines = ['root:x:0:', 'sudo:x:27:guest', 'guest:x:1000:'];
    for (const n of names) if (!['root', 'guest'].includes(n)) lines.push(`${n}:x:${vfs.userInfo(n).gid}:`);
    return lines.join('\n') + '\n';
  }

  handleEditorKey(ch) {
    if (ch === '\x03' || ch === '\x18') { // Ctrl-C / Ctrl-X
      this.editor = null;
      this.write('^X\r\n');
      this.prompt();
      return;
    }
    if (ch === '\r' || ch === '\n') {
      this.write('\r\n');
      const line = this.buffer.trim();
      this.buffer = '';
      if (this.editor.name === 'vim') {
        if (line === ':q' || line === ':q!' || line === ':wq' || line === ':x') { this.editor = null; this.write('已退出 vim\r\n'); this.prompt(); return; }
        if (line === ':w') { this.write('E45: \'readonly\' option is set (add ! to override)\r\n: '); return; }
        this.write('~\r\n: ');
        return;
      }
      if (this.editor.name === 'nano') { this.write('^X 退出\r\n'); return; }
      return;
    }
    if (ch === '\x7f' || ch === '\b') { this.buffer = this.buffer.slice(0, -1); this.write('\b \b'); return; }
    if (ch >= ' ') { this.buffer += ch; this.write(ch); }
  }

  // ── 执行一行 ──
  runLine(rawLine) {
    const line = rawLine.trim();
    if (line) this.history.push(line);
    if (this.editor) return;

    if (!line) return this.prompt();

    // 先按 ; 和 && 拆成多条命令（忽略引号内的分隔符）
    const segments = this.splitTopLevel(line, ['&&', ';']);
    for (const seg of segments) {
      const stages = parsePipeline(seg);
      let stdin = '';
      let piped = false;
      for (let si = 0; si < stages.length; si++) {
        const tokens = tokenize(stages[si]);
        if (!tokens.length) continue;
        // 别名展开
        const head = tokens[0];
        if (this.aliases[head]) {
          const aliasTokens = tokenize(this.aliases[head]);
          tokens.splice(0, 1, ...aliasTokens);
        }
        const env = this.expandAll(tokens);
        const res = this.exec(env, stdin) || { out: '', code: 0 };
        if (res.close) return;
        if (si === stages.length - 1) {
          if (res.out) this.write(res.out);
        } else {
          stdin = res.out || '';
          piped = true;
        }
        if (res.err) this.write(res.err);
      }
      if (piped) { /* 管道输出已在最后一段写出 */ }
    }
    if (!this.closed) this.prompt();
  }

  // 按分隔符拆分，跳过引号内
  splitTopLevel(line, seps) {
    const out = [];
    let cur = '', q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      const two = line.slice(i, i + 2);
      if (seps.includes(two)) { out.push(cur); cur = ''; i++; continue; }
      if (seps.includes(c)) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  }

  errMsg(code) {
    return {
      ENOENT: 'No such file or directory', EACCES: 'Permission denied',
      EEXIST: 'File exists', EISDIR: 'Is a directory', ENOTDIR: 'Not a directory',
      ENOTEMPTY: 'Directory not empty', EPERM: 'Operation not permitted', EBUSY: 'Device or resource busy',
    }[code] || 'Operation not permitted';
  }

  expandAll(tokens) {
    return tokens.map((t) => t.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => this.env[name] ?? ''));
  }

  // 管道简化版：只支持 一级 | 后面接 grep/wc/sort/uniq/head/tail/less/more
  exec(tokens, stdin) {
    const [cmd0, ...args] = tokens;
    const cmd = cmd0;
    const ctx = { args, stdin, shell: this };

    // 重定向：> >> 真写（内存文件系统），< 读文件
    const ri = args.findIndex((a) => a === '>' || a === '>>');
    if (ri >= 0) {
      const append = args[ri] === '>>';
      const file = args[ri + 1];
      if (!file) return { err: 'bash: syntax error near unexpected token `newline`\r\n', code: 2 };
      const rest = [...args.slice(0, ri), ...args.slice(ri + 2)];
      const res = this.exec([cmd0, ...rest], stdin) || { out: '', code: 0 };
      const target = this.resolve(file);
      if (res.out) {
        const r = append ? vfs.appendFile(target, res.out, this.user) : vfs.createFile(target, res.out, this.user);
        if (r.error) return { out: '', err: `bash: ${file}: ${this.errMsg(r.error)}\r\n`, code: 1 };
      } else if (!append) {
        const r = vfs.createFile(target, '', this.user);
        if (r.error) return { out: '', err: `bash: ${file}: ${this.errMsg(r.error)}\r\n`, code: 1 };
      }
      return { out: '', err: res.err || '', code: res.code || 0 };
    }
    const lt = args.indexOf('<');
    if (lt >= 0) {
      const f = args[lt + 1];
      const hit = this.loadFile(f);
      if (!hit) return { err: `-bash: ${f}: No such file or directory\r\n`, code: 1 };
      tokens = tokens.filter((_, i) => i !== lt && i !== lt + 1);
      args.splice(0, args.length, ...tokens.slice(1));
      return this.exec(tokens, hit.content);
    }

    const fn = this[`cmd_${cmd}`] || this[`cmd_${cmd.replace(/-/g, '_')}`];
    if (!fn) {
      return { err: `${cmd}: command not found\r\n`, code: 127 };
    }
    try {
      return fn.call(this, ctx) || { out: '', code: 0 };
    } catch (e) {
      return { err: `${cmd}: internal error: ${e.message}\r\n`, code: 1 };
    }
  }

  // 读取文件（带权限与目录遍历检查）
  loadFile(path) {
    if (!path) return null;
    const abs = this.resolve(path, this.cwd);
    if (abs === '/proc/loadavg' || abs.startsWith('/proc/')) {
      const hit = vfs.nodeAt(abs);
      if (!hit) return null;
      return { content: hit.node.content, node: hit.node, path: abs };
    }
    // 检查路径上每一级目录是否有 x 权限
    const parts = abs.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      if (i === parts.length - 1) break;
      const d = vfs.nodeAt(cur);
      if (!d) return { denied: `No such file or directory` };
      if (d.node.type !== 'dir') return { denied: 'Not a directory' };
      if (!vfs.canExecDir(d, this.user)) return { denied: 'Permission denied' };
    }
    if (abs === '/var/log/auth.log') {
      if (this.user !== 'root') return { denied: 'Permission denied' };
      return { content: audit.authLogContent(), node: vfs.nodeAt(abs).node, path: abs };
    }
    if (abs === '/etc/passwd') return { content: this.renderPasswd(), node: vfs.nodeAt(abs).node, path: abs };
    if (abs === '/etc/group') return { content: this.renderGroup(), node: vfs.nodeAt(abs).node, path: abs };
    if (abs === '/etc/shadow') {
      if (this.user !== 'root') return { denied: 'Permission denied' };
      return { content: this.renderShadow(), node: vfs.nodeAt(abs).node, path: abs };
    }
    const hit = vfs.nodeAt(abs);
    if (!hit) return null;
    if (hit.node.type === 'dir') return { isDir: true, node: hit.node, path: abs };
    if (!vfs.canRead(hit, this.user)) return { denied: 'Permission denied' };
    return { content: hit.node.content, node: hit.node, path: abs };
  }

  // ── 文件类命令 ──
  cmd_ls({ args }) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const paths = args.filter((a) => !a.startsWith('-'));
    const all = flags.includes('a') || flags.includes('A');
    const long = flags.includes('l');
    const targets = paths.length ? paths : ['.'];
    let out = '';

    targets.forEach((p, idx) => {
      const abs = this.resolve(p, this.cwd);
      const dirHit = vfs.nodeAt(abs);
      if (dirHit && dirHit.node.type === 'dir' && !vfs.canExecDir(dirHit, this.user)) {
        out += `ls: cannot open directory '${p}': Permission denied\r\n`;
        return;
      }
      const listing = vfs.listDir(abs);
      if (!listing || listing.error) {
        const f = this.loadFile(p);
        if (f && f.content !== undefined) {
          if (long) {
            const node = f.node || {};
            const size = Buffer.byteLength(f.content || '', 'utf8');
            out += `${modeStr(node.mode || 0o644, 'file')}  1 ${(node.owner || this.user).padEnd(8)} ${(node.owner || this.user).padEnd(8)} ${String(size).padStart(6)} ${this.fmtLsTime(node.mtime)} ${p}\r\n`;
          } else out += `${p}\r\n`;
          return;
        }
        if (f && f.isDir) { out += `ls: cannot access '${p}': Permission denied\r\n`; return; }
        out += `ls: cannot access '${p}': No such file or directory\r\n`;
        return;
      }
      let entries = listing.entries.slice();
      if (all) entries = ['.', '..', ...entries];
      entries.sort();
      if (targets.length > 1) out += `${p}:\r\n`;
      if (long) {
        const t = T();
        for (const name of entries) {
          const ep = name === '.' ? abs : name === '..' ? this.resolve('..', abs) : this.resolve(name, abs);
          const hit = vfs.nodeAt(ep);
          const node = hit ? hit.node : { type: 'file', mode: 0o644, owner: USER, content: '' };
          const size = node.type === 'dir' ? 4096 : Buffer.byteLength(node.content || '', 'utf8');
          const links = node.type === 'dir' ? 2 : 1;
          const when = this.fmtLsTime(node.mtime);
          out += `${modeStr(node.mode, node.type)} ${String(links).padStart(2)} ${node.owner.padEnd(8)} ${(node.group || node.owner).padEnd(8)} ${String(size).padStart(6)} ${when} ${name}\r\n`;
        }
      } else {
        // 简单多列
        const width = 80;
        const colW = Math.max(...entries.map((e) => e.length)) + 2;
        const cols = Math.max(1, Math.floor(width / colW));
        for (let i = 0; i < entries.length; i += cols) {
          out += entries.slice(i, i + cols).map((e) => e.padEnd(colW)).join('').trimEnd() + '\r\n';
        }
      }
    });
    return { out };
  }

  cmd_cd({ args }) {
    const target = args[0] || '~';
    if (target === '-') return { err: 'cd: OLDPWD not set\r\n', code: 1 };
    const abs = this.resolve(target, this.cwd);
    const listing = vfs.listDir(abs);
    if (!listing) {
      // 权限判断
      const hit = vfs.nodeAt(abs);
      if (hit && !vfs.canExecDir(hit, this.user)) return { err: `bash: cd: ${target}: Permission denied\r\n`, code: 1 };
      return { err: `bash: cd: ${target}: No such file or directory\r\n`, code: 1 };
    }
    // 逐级检查
    const parts = abs.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const d = vfs.nodeAt(cur);
      if (d && !vfs.canExecDir(d, this.user)) return { err: `bash: cd: ${target}: Permission denied\r\n`, code: 1 };
    }
    this.cwd = abs;
    this.env.PWD = abs;
    return { out: '' };
  }

  cmd_pwd() { return { out: `${this.cwd}\r\n` }; }

  cmd_cat({ args, stdin }) {
    if (stdin) return { out: stdin.replace(/\r?\n/g, '\r\n') + (stdin.endsWith('\n') ? '' : '\r\n') };
    if (!args.length) return { err: 'cat: missing operand\r\n', code: 1 };
    let out = '';
    for (const f of args) {
      const hit = this.loadFile(f);
      if (!hit) { out += `cat: ${f}: No such file or directory\r\n`; continue; }
      if (hit.denied) { out += `cat: ${f}: ${hit.denied}\r\n`; continue; }
      if (hit.isDir) { out += `cat: ${f}: Is a directory\r\n`; continue; }
      const body = hit.content.replace(/\r?\n/g, '\r\n');
      out += body.endsWith('\r\n') ? body : body + '\r\n';
    }
    return { out, code: 0 };
  }

  cmd_head({ args, stdin }) {
    const n = this._numFlag(args, 10);
    const text = stdin !== '' ? stdin : this._readFiles(args);
    if (text === null) return { out: '', code: 1 };
    const lines = text.split(/\r?\n/).slice(0, n);
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_tail({ args, stdin }) {
    const n = this._numFlag(args, 10);
    const text = stdin !== '' ? stdin : this._readFiles(args);
    if (text === null) return { out: '', code: 1 };
    const lines = text.split(/\r?\n/).filter((_, i, a) => i >= Math.max(0, a.length - 1 - n));
    return { out: lines.join('\r\n') + '\r\n' };
  }

  _numFlag(args, def) {
    const i = args.findIndex((a) => /^-\d+$/.test(a) || a === '-n');
    if (i < 0) return def;
    if (args[i] === '-n') return Number(args[i + 1]) || def;
    return Number(args[i].slice(1)) || def;
  }

  _readFiles(args) {
    let skipNext = false;
    const files = args.filter((a) => {
      if (skipNext) { skipNext = false; return false; }
      if (a === '-n') { skipNext = true; return false; }
      if (/^-\d+$/.test(a)) return false;
      return !a.startsWith('-');
    });
    if (!files.length) return null;
    let text = '';
    for (const f of files) {
      const hit = this.loadFile(f);
      if (!hit) { text += `: no such file\r\n`; continue; }
      if (hit.denied) { text += `: ${hit.denied}\r\n`; continue; }
      if (hit.isDir) { text += `: Is a directory\r\n`; continue; }
      text += hit.content.endsWith('\n') ? hit.content : hit.content + '\n';
    }
    return text;
  }

  cmd_grep({ args, stdin }) {
    let ignoreCase = false, showNum = false, invert = false;
    const rest = [];
    let pattern = null;
    for (const a of args) {
      if (a.startsWith('-') && a.length > 1) {
        if (a.includes('i')) ignoreCase = true;
        if (a.includes('n')) showNum = true;
        if (a.includes('v')) invert = true;
        continue;
      }
      if (pattern === null) { pattern = a; continue; }
      rest.push(a);
    }
    if (pattern === null) return { err: 'Usage: grep [OPTION]... PATTERNS [FILE]...\r\n', code: 2 };
    let text = '';
    if (rest.length) {
      for (const f of rest) {
        const hit = this.loadFile(f);
        if (!hit) { text += `grep: ${f}: No such file or directory\r\n`; continue; }
        if (hit.denied) { text += `grep: ${f}: ${hit.denied}\r\n`; continue; }
        text += hit.content.endsWith('\n') ? hit.content : hit.content + '\n';
      }
    } else text = stdin;

    let re;
    try { re = new RegExp(pattern, ignoreCase ? 'i' : ''); } catch { return { err: 'grep: Invalid regular expression\r\n', code: 2 }; }
    const lines = text.split(/\r?\n/);
    const out = [];
    lines.forEach((line, i) => {
      const m = re.test(line);
      if (m !== invert) out.push((showNum ? `${rest.length > 1 ? '' : ''}${i + 1}:` : '') + line);
    });
    return { out: out.join('\r\n') + (out.length ? '\r\n' : ''), code: out.length ? 0 : 1 };
  }

  cmd_wc({ args, stdin }) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const files = args.filter((a) => !a.startsWith('-'));
    const text = stdin !== '' ? stdin : (files.length ? this._readFiles(files) : null);
    if (text === null) return { out: '', code: 1 };
    const lines = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const chars = Buffer.byteLength(text, 'utf8');
    const only = { l: flags.includes('l'), w: flags.includes('w'), c: flags.includes('c') };
    const want = only.l || only.w || only.c ? only : { l: true, w: true, c: true };
    let out = '';
    if (want.l) out += String(lines).padStart(8);
    if (want.w) out += String(words).padStart(8);
    if (want.c) out += String(chars).padStart(8);
    if (files.length) out += ' ' + files.join(' ');
    return { out: out + '\r\n' };
  }

  cmd_sort({ args, stdin }) {
    const text = stdin !== '' ? stdin : this._readFiles(args);
    if (text === null) return { out: '', code: 1 };
    const lines = text.split(/\r?\n/).filter((x, i, a) => !(i === a.length - 1 && x === ''));
    lines.sort();
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_uniq({ args, stdin }) {
    const text = stdin !== '' ? stdin : this._readFiles(args);
    if (text === null) return { out: '', code: 1 };
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length; i++) if (i === 0 || lines[i] !== lines[i - 1]) out.push(lines[i]);
    return { out: out.join('\r\n') + '\r\n' };
  }

  cmd_find({ args }) {
    const path = args[0] && !args[0].startsWith('-') ? args[0] : '.';
    const nameIdx = args.indexOf('-name');
    const typeIdx = args.indexOf('-type');
    const pattern = nameIdx >= 0 ? args[nameIdx + 1] : null;
    const type = typeIdx >= 0 ? args[typeIdx + 1] : null;
    const base = this.resolve(path, this.cwd);
    if (!vfs.exists(base)) return { err: `find: '${path}': No such file or directory\r\n`, code: 1 };
    const out = [];
    const walk = (p) => {
      if (!vfs.exists(p)) return;
      const hit = vfs.nodeAt(p);
      const name = p.split('/').pop() || '/';
      const isDir = hit.node.type === 'dir';
      const nameOk = !pattern || new RegExp('^' + pattern.replace(/[*.]/g, (m) => (m === '*' ? '.*' : '\\.')) + '$').test(name);
      const typeOk = !type || (type === 'd' ? isDir : !isDir);
      if (nameOk && typeOk) out.push(p);
      if (isDir && p !== '/proc' && hit.node.children) {
        for (const c of hit.node.children) walk(p === '/' ? `/${c}` : `${p}/${c}`);
      }
    };
    walk(base);
    return { out: out.join('\r\n') + (out.length ? '\r\n' : '') };
  }

  cmd_stat({ args }) {
    if (!args.length) return { err: 'stat: missing operand\r\n', code: 1 };
    const out = [];
    for (const f of args) {
      const abs = this.resolve(f, this.cwd);
      const hit = vfs.nodeAt(abs);
      if (!hit) { out.push(`stat: cannot statx '${f}': No such file or directory`); continue; }
      const n = hit.node;
      const size = n.type === 'dir' ? 4096 : Buffer.byteLength(n.content || '', 'utf8');
      out.push(`  File: ${f}`);
      out.push(`  Size: ${String(size).padEnd(12)}Blocks: 8          IO Block: 4096   ${n.type === 'dir' ? 'directory' : 'regular file'}`);
      out.push(`Device: 0,2\tInode: ${Math.floor(hashCode(abs) % 900000) + 100000}   Links: 1`);
      out.push(`Access: (${n.mode.toString(8).padStart(4, '0')}/${modeStr(n.mode, n.type)})  Uid: ( 1000/${n.owner})   Gid: ( 1000/${n.group})`);
      out.push(`Modify: 2026-01-01 00:00:00.000000000 +0800`);
    }
    return { out: out.join('\r\n') + '\r\n' };
  }

  cmd_file({ args }) {
    if (!args.length) return { err: 'Usage: file [-bchiklLNnprsvz] [-f namefile] [--separator=separator] files...\r\n', code: 1 };
    const out = [];
    for (const f of args) {
      const hit = this.loadFile(f);
      if (!hit) { out.push(`${f}: cannot open \`${f}' (No such file or directory)`); continue; }
      if (hit.isDir) { out.push(`${f}: directory`); continue; }
      if (hit.denied) { out.push(`${f}: cannot open \`${f}' (${hit.denied})`); continue; }
      const c = hit.content || '';
      let kind = 'ASCII text';
      if (f.endsWith('.json')) kind = 'ASCII text, with very long lines';
      if (c.startsWith('#!/')) kind = 'Bourne-Again shell script, ASCII text executable';
      if (c.startsWith('PRETTY_NAME')) kind = 'ASCII text';
      if (f.endsWith('.js')) kind = 'JavaScript source, ASCII text';
      out.push(`${f}: ${kind}`);
    }
    return { out: out.join('\r\n') + '\r\n' };
  }

  cmd_du({ args }) {
    const human = args.some((a) => /[hH]/.test(a) && a.startsWith('-'));
    const summary = args.some((a) => a.startsWith('-') && a.includes('s'));
    const target = args.find((a) => !a.startsWith('-')) || '.';
    const abs = this.resolve(target, this.cwd);
    if (!vfs.exists(abs)) return { err: `du: cannot access '${target}': No such file or directory\r\n`, code: 1 };
    let size = 0;
    const walk = (p) => {
      const hit = vfs.nodeAt(p);
      if (!hit) return;
      if (hit.node.type === 'dir') { size += 4096; for (const c of hit.node.children) walk(`${p}/${c}`); }
      else size += Buffer.byteLength(hit.node.content || '', 'utf8');
    };
    walk(abs);
    const val = human ? humanSize(size) : Math.ceil(size / 1024).toString();
    return { out: `${val}\t${target}\r\n` };
  }

  cmd_df({ args }) {
    const human = args.some((a) => a.includes('h'));
    const s = vfs.fakeStats().disk;
    const fmt = (v) => (human ? `${v.toFixed(1)}G` : `${Math.round(v * 1048576)}`);
    return {
      out: [
        'Filesystem      Size  Used Avail Use% Mounted on',
        `/dev/mmcblk1p2  ${fmt(s.total).padStart(5)} ${fmt(s.used).padStart(5)} ${fmt(s.avail).padStart(5)}  ${Math.round(s.usePct)}% /`,
        'tmpfs           492M   95M  398M  20% /tmp',
        'tmpfs           492M     0  492M   0% /dev/shm',
        'tmpfs            99M   11M   88M  11% /run',
        '/dev/mmcblk1p1  256M   49M  208M  19% /boot',
      ].join('\r\n') + '\r\n',
    };
  }

  cmd_free({ args }) {
    const m = vfs.fakeStats().mem;
    return {
      out: [
        '               total        used        free      shared  buff/cache   available',
        `Mem:           ${m.total.toFixed(1).padStart(9)}M ${m.used.toFixed(1).padStart(9)}M ${m.free.toFixed(1).padStart(9)}M ${(m.shared || 0).toFixed(1).padStart(9)}M ${(m.buffCache ?? (m.cached + m.buffers)).toFixed(1).padStart(9)}M ${m.available.toFixed(1).padStart(9)}M`,
        `Swap:          ${m.swapTotal.toFixed(1).padStart(9)}M ${m.swapUsed.toFixed(1).padStart(9)}M ${(m.swapTotal - m.swapUsed).toFixed(1).padStart(9)}M`,
      ].join('\r\n') + '\r\n',
    };
  }

  cmd_ps({ args }) {
    const s = vfs.fakeStats();
    const t = T();
    const aux = args.some((a) => a.replace('-', '').includes('aux')) || args.some((a) => a.includes('aux'));
    if (aux) {
      const head = 'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND';
      const rows = s.procs.map((p) => {
        const rssKb = Math.round(p.mem * 1024);
        const memPct = (p.mem / s.mem.total) * 100;
        const start = this.fmtPsStart(p.startedAt);
        const time = this.fmtPsTime(p.ticks);
        return `${p.user.padEnd(8)} ${String(p.pid).padStart(5)} ${p.cpu.toFixed(1).padStart(4)} ${memPct.toFixed(1).padStart(4)} ${String(p.vszKb || rssKb * 3).padStart(7)} ${String(rssKb).padStart(5)} pts/0    ${p.stat.padEnd(4)} ${start}   ${time} ${p.cmd}`;
      });
      return { out: [head, ...rows].join('\r\n') + '\r\n' };
    }
    const head = '    PID TTY          TIME CMD';
    const rows = s.procs.map((p) => `${String(p.pid).padStart(7)} pts/0    ${String(Math.floor(p.pid / 60)).padStart(5)}:${String(p.pid % 60).padStart(2, '0')} ${p.cmd.split(' ')[0].split('/').pop()}`);
    return { out: [head, ...rows].join('\r\n') + '\r\n' };
  }

  // ls -l 的时间列（半年内显示 HH:MM，否则显示年份）
  fmtLsTime(mtime) {
    const d = new Date((mtime || Math.floor(Date.now() / 1000)) * 1000);
    const now = new Date();
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    const day = String(d.getDate()).padStart(2, ' ');
    const sixMonths = 15552000000;
    if (Math.abs(now - d) < sixMonths) {
      return `${mon} ${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${mon} ${day}  ${d.getFullYear()}`;
  }

  // ── 进程时间格式（真 ps 风格）──
  fmtPsStart(epoch) {
    if (!epoch) return '00:00';
    const d = new Date(epoch * 1000);
    const now = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    return `${mon}${String(d.getDate()).padStart(2, '0')}`;
  }

  fmtPsTime(ticks) {
    const sec = Math.floor((ticks || 0) / 100);
    const m = Math.floor(sec / 60);
    return `${m}:${String(sec % 60).padStart(2, '0')}`;
  }

  fmtTopTime(ticks) {
    const sec = (ticks || 0) / 100;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}.${String(Math.floor((sec % 1) * 100)).padStart(2, '0')}`;
  }

  // ── 真机硬件信息 ──
  // ── 系统信息类 ──
  cmd_hostnamectl() {
    const s = vfs.fakeStats();
    const mid = (s.at.toString(16) + 'deadbeefcafe').slice(0, 32);
    return { out: [
      ' Static hostname: anxi',
      '       Icon name: computer-vm',
      '         Chassis: vm 🖴',
      '      Machine ID: ' + mid,
      '         Boot ID: ' + s.at.toString(16).padEnd(32, '0').slice(0, 32),
      '  Virtualization: none',
      'Operating System: Debian GNU/Linux 13 (trixie)',
      '          Kernel: Linux 6.12.57-armmp',
      '    Architecture: arm',
    ].join('\r\n') + '\r\n' };
  }

  cmd_lsblk() {
    return { out: [
      'NAME         MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS',
      'mmcblk1      179:0    0  7.3G  0 disk ',
      '├─mmcblk1p1  179:1    0  256M  0 part /boot',
      '└─mmcblk1p2  179:2    0  6.9G  0 part /',
      'zram0        254:0    0   47M  0 disk [SWAP]',
    ].join('\r\n') + '\r\n' };
  }

  cmd_mount() {
    return { out: [
      'sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)',
      'proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)',
      'devtmpfs on /dev type devtmpfs (rw,nosuid,size=4096k,nr_inodes=245760,mode=755)',
      'tmpfs on /run type tmpfs (rw,nosuid,nodev,noexec,relatime,size=101376k,mode=755)',
      '/dev/mmcblk1p2 on / type ext4 (rw,noatime)',
      '/dev/mmcblk1p1 on /boot type vfat (rw,relatime,fmask=0022,dmask=0022)',
      'tmpfs on /dev/shm type tmpfs (rw,nosuid,nodev)',
      'tmpfs on /tmp type tmpfs (rw,nosuid,nodev)',
      'cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)',
    ].join('\r\n') + '\r\n' };
  }

  cmd_dpkg({ args }) {
    const sub = args[0] || '';
    if (sub === '-l' || sub === '--list') {
      const filter = args[1];
      const pkgs = (vfs.PACKAGES || []).filter((p) => !filter || p.name.startsWith(filter) || p.name === filter);
      const lines = ['Desired=Unknown/Install/Remove/Purge/Hold',
        '| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend',
        '|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)',
        '||/ Name                Version              Architecture Description',
        '+++-===================-====================-============-================================='];
      for (const p of pkgs) {
        lines.push(`ii  ${p.name.padEnd(19)} ${p.version.padEnd(20)} armhf        ${p.desc}`);
      }
      return { out: lines.join('\r\n') + '\r\n' };
    }
    if (sub === '-s' || sub === '--status') {
      const p = (vfs.PACKAGES || []).find((x) => x.name === args[1]);
      if (!p) return { err: `dpkg-query: package '${args[1]}' is not installed and no information is available\r\n`, code: 1 };
      return { out: [`Package: ${p.name}`, 'Status: install ok installed', `Version: ${p.version}`, `Section: ${p.section}`, 'Architecture: armhf', `Description: ${p.desc}`, ''].join('\r\n') };
    }
    if (sub === '-L' || sub === '--listfiles') {
      return { out: ['/usr/bin/' + (args[1] || ''), '/usr/share/doc/' + (args[1] || '') + '/', ''].join('\r\n') };
    }
    return { err: 'dpkg: error: need an action option\r\n', code: 2 };
  }

  // ── 登录审计 / fail2ban ──
  _fmtLastTime(at) {
    const d = new Date(at);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    const pad = (n) => String(n).padStart(2, '0');
    return `${wd} ${mon} ${String(d.getDate()).padStart(2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  cmd_last({ args }) {
    const recs = [...audit.state.logins].reverse().slice(0, args[0] ? Number(args[0]) || 10 : 10);
    const lines = [];
    for (const r of recs) {
      const start = this._fmtLastTime(r.at);
      if (r.outAt === null) {
        lines.push(`${r.user.padEnd(8)} pts/0        ${(r.ip || '10.0.0.2').padEnd(15)} ${start}   still logged in`);
      } else {
        const d = new Date(r.outAt);
        const end = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        lines.push(`${r.user.padEnd(8)} pts/0        ${(r.ip || '10.0.0.2').padEnd(15)} ${start} - ${end}  (${audit.fmtDuration(r.outAt - r.at)})`);
      }
    }
    lines.push('');
    lines.push('wtmp begins Sat Oct 31 22:41:03 2026');
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_lastb({ args }) {
    const recs = [...audit.state.failures].reverse().slice(0, args[0] ? Number(args[0]) || 10 : 10);
    if (!recs.length) {
      return { out: '\r\nbtmp begins Sat Oct 31 22:41:03 2026\r\n' };
    }
    const lines = recs.map((r) => `${(r.user.startsWith('invalid') ? r.user.split(' ').pop() : r.user).padEnd(8)} ssh:notty    ${(r.ip || '10.0.0.2').padEnd(15)} ${this._fmtLastTime(r.at)} - ${String(new Date(r.at).getHours()).padStart(2, '0')}:${String(new Date(r.at).getMinutes()).padStart(2, '0')}  (00:00)`);
    lines.push('');
    lines.push('btmp begins Sat Oct 31 22:41:03 2026');
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_fail2ban_client({ args }) {
    if (this.user !== 'root') {
      return { err: `ERROR  Failed to access socket path: /var/run/fail2ban/fail2ban.sock. Is fail2ban running?\r\n`, code: 255 };
    }
    const sub = args[0] || 'status';
    const st = audit.statusText();
    if (sub === 'status' && !args[1]) {
      return { out: [
        'Status',
        `|- Number of jail:      ${st.jailed ? 1 : 0}`,
        `\`- Jail list:           ${st.jailed ? 'sshd' : ''}`,
      ].join('\r\n') + '\r\n' };
    }
    if (sub === 'status' && args[1] === 'sshd') {
      const banned = st.banned.map(([ip]) => ip);
      return { out: [
        'Status for the jail: sshd',
        '|- Filter',
        '|  |- Currently failed: ' + st.failures,
        '|  |- Total failed:     ' + st.failures,
        '|  `- Journal matches:  _SYSTEMD_UNIT=ssh.service + _COMM=sshd',
        '`- Actions',
        '   |- Currently banned: ' + banned.length,
        '   |- Total banned:     ' + banned.length,
        '   `- Banned IP list:    ' + (banned.length ? banned.join(' ') : ''),
      ].join('\r\n') + '\r\n' };
    }
    return { err: 'Usage: fail2ban-client [OPTIONS] <COMMAND>\r\n', code: 255 };
  }

  // ── docker（假实现，输出像真的）──
  cmd_docker({ args }) {
    const sub = args[0] || '';
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const DB = {
      containers: [
        { id: 'a1b2c3d4e5f6', image: 'nginx:1.26', name: 'anxi-web', status: 'Exited (0) 2 days ago', state: 'exited' },
        { id: '0f1e2d3c4b5a', image: 'debian:trixie', name: 'anxi-task', status: 'Exited (137) 25 hours ago', state: 'exited' },
      ],
      images: [
        { repo: 'debian', tag: 'trixie', id: 'sha256:9f2c1d', size: '124MB' },
        { repo: 'nginx', tag: '1.26', id: 'sha256:7a3b2c', size: '192MB' },
        { repo: 'node', tag: '22-alpine', id: 'sha256:5d4e3f', size: '135MB' },
      ],
    };
    if (sub === 'ps' || (sub === 'container' && args[1] === 'ls')) {
      const all = flags.includes('a');
      const lines = ['CONTAINER ID   IMAGE           COMMAND                  CREATED        STATUS                     PORTS     NAMES'];
      for (const c of DB.containers) {
        if (!all && c.state !== 'running') continue;
        lines.push(`${c.id}   ${c.image.padEnd(15)} "nginx -g 'daemon of…"   2 days ago     ${c.status.padEnd(26)}           ${c.name}`);
      }
      return { out: lines.join('\r\n') + '\r\n' };
    }
    if (sub === 'images') {
      const lines = ['REPOSITORY   TAG        IMAGE ID       CREATED       SIZE'];
      for (const i of DB.images) lines.push(`${i.repo.padEnd(12)} ${i.tag.padEnd(10)} ${i.id}   13 days ago   ${i.size}`);
      return { out: lines.join('\r\n') + '\r\n' };
    }
    if (sub === 'version') {
      return { out: [
        'Client: Docker Engine - Community',
        ' Version:           28.4.0',
        ' API version:       1.51',
        ' Go version:        go1.24.6',
        ' OS/Arch:           linux/arm',
        '',
        'Server: Docker Engine - Community',
        ' Engine:',
        '  Version:          28.4.0',
        '  API version:      1.51 (minimum version 1.24)',
        '  Go version:       go1.24.6',
        '  OS/Arch:          linux/arm',
        '  Experimental:     false',
        ' containerd:',
        '  Version:          v2.1.3',
        ' runc:',
        '  Version:          1.3.0',
      ].join('\r\n') + '\r\n' };
    }
    if (sub === 'info') {
      return { out: [
        'Client: Docker Engine - Community',
        ' Version:    28.4.0',
        ' Context:    default',
        ' Debug Mode: false',
        '',
        'Server:',
        ' Containers: 2',
        '  Running: 0',
        '  Paused: 0',
        '  Stopped: 2',
        ' Images: 3',
        ' Server Version: 28.4.0',
        ' Storage Driver: overlay2',
        ' Cgroup Driver: systemd',
        ' Cgroup Version: 2',
        ' Kernel Version: 6.12.57-armmp',
        ' Operating System: Debian GNU/Linux 13 (trixie)',
        ' OSType: linux',
        ' Architecture: armv7l',
        ' CPUs: 4',
        ' Total Memory: 983.4MiB',
        ' Name: anxi',
      ].join('\r\n') + '\r\n' };
    }
    if (sub === 'run') {
      const image = args.find((a, i) => i > 0 && !a.startsWith('-')) || 'debian:trixie';
      return { err: `Unable to find image '${image}' locally\r\ndocker: Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers).\r\n\r\nRun 'docker run --help' for more information\r\n`, code: 125 };
    }
    if (sub === 'stop' || sub === 'rm' || sub === 'kill') {
      const target = args[1] || '';
      return { err: `Error response from daemon: No such container: ${target}\r\n`, code: 1 };
    }
    if (sub === 'logs') {
      return { err: `Error response from daemon: No such container: ${args[1] || ''}\r\n`, code: 1 };
    }
    return { out: 'Usage:  docker [OPTIONS] COMMAND\r\n\r\nManagement Commands:\r\n  container   Manage containers\r\n  image       Manage images\r\n  network     Manage networks\r\n  volume      Manage volumes\r\n\r\nCommands:\r\n  ps          List containers\r\n  images      List images\r\n  run         Create and run a new container from an image\r\n  info        Display system-wide information\r\n  version     Show the Docker version information\r\n' };
  }

  cmd_ssh_keygen({ args }) {
    let file = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-[a-zA-Z]*f$/.test(a)) { file = args[i + 1]; i++; continue; }
      if (/^-f/.test(a)) { file = a.slice(2); continue; }
    }
    const wantFp = args.some((a) => a.startsWith('-') && a.includes('l'));
    if (!file) return { err: 'Too few arguments.\r\n', code: 1 };
    const hit = this.loadFile(file);
    if (!hit || hit.denied) return { err: `ssh-keygen: ${file}: No such file or directory\r\n`, code: 1 };
    const content = (hit.content || '').trim();
    if (content.startsWith('ssh-') || content.startsWith('ecdsa-')) {
      const parts = content.split(/\s+/);
      let blob;
      try { blob = Buffer.from(parts[1], 'base64'); } catch { return { err: 'ssh-keygen: invalid key\r\n', code: 1 }; }
      const fp = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
      const bits = parts[0].startsWith('ssh-rsa') ? 3072 : 256;
      const type = parts[0].startsWith('ssh-rsa') ? 'RSA' : 'ED25519';
      if (wantFp) return { out: `${bits} SHA256:${fp} ${parts[2] || 'root@anxi'} (${type})\r\n` };
      return { out: content + '\r\n' };
    }
    if (content.startsWith('-----BEGIN')) {
      return { err: `ssh-keygen: ${file}: invalid format\r\n`, code: 1 };
    }
    return { out: '' };
  }

  cmd_nproc() { return { out: `${vfs.fakeStats().cpuCount}\n` }; }

  cmd_lscpu() {
    const s = vfs.fakeStats();
    return { out: [
      'Architecture:            armv7l',
      ` CPU op-mode(s):        32-bit, 64-bit`,
      ` CPU(s):                ${s.cpuCount}`,
      ' On-line CPU(s) list:   0-' + (s.cpuCount - 1),
      ' Thread(s) per core:    1',
      ` Core(s) per socket:    ${s.cpuCount}`,
      ' Socket(s):             1',
      ` Model name:            ${s.cpuModel}`,
      ' CPU(s) scaling MHz:    20%',
      ' Vulnerability Itlb multihit: Not affected',
    ].join('\r\n') + '\r\n' };
  }

  cmd_vmstat() {
    const s = vfs.fakeStats();
    const running = s.procRunning || s.procs.filter((p) => p.stat === 'R').length;
    return { out: [
      'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----',
      ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st',
      ` ${String(running).padStart(2)}  0 ${Math.round(s.mem.swapUsed).toString().padStart(6)} ${Math.round(s.mem.free).toString().padStart(6)} ${Math.round(s.mem.buffers).toString().padStart(5)} ${Math.round(s.mem.cached).toString().padStart(5)}    0    0    12    34  220  410 ${s.cpuUser.toFixed(0).padStart(3)} ${s.cpuSys.toFixed(0).padStart(2)} ${s.cpuIdle.toFixed(0).padStart(3)}  0  0`,
    ].join('\r\n') + '\r\n' };
  }

  cmd_mpstat() {
    const s = vfs.fakeStats();
    const cores = s.cores && s.cores.length ? s.cores : [s.cpu];
    const lines = ['Linux 6.12.57-armmp (anxi) \t' + new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' \t_armv7l_\t(4 CPU)', '', 'CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle'];
    cores.forEach((c, i) => {
      lines.push(`${String(i).padStart(2)}    ${(c * 0.7).toFixed(2).padStart(6)}    0.00  ${(c * 0.3).toFixed(2).padStart(6)}    0.00    0.00    0.00    0.00    0.00    0.00   ${Math.max(0, 100 - c).toFixed(2).padStart(6)}`);
    });
    lines.push(`all    ${s.cpuUser.toFixed(2).padStart(6)}    0.00  ${s.cpuSys.toFixed(2).padStart(6)} ${s.cpuWait.toFixed(2).padStart(7)}    0.00    0.00    0.00    0.00    0.00   ${s.cpuIdle.toFixed(2).padStart(6)}`);
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_iostat() {
    const s = vfs.fakeStats();
    return { out: [
      'Linux 6.12.57-armmp \t' + new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' \t_armv7l_\t(4 CPU)',
      '',
      'Device            tps    kB_read/s    kB_wrtn/s    kB_dscd/s    kB_read    kB_wrtn    kB_dscd',
      `mmcblk1          ${(2.3 + Math.random()).toFixed(2)}         ${(12 + Math.random() * 8).toFixed(2)}          ${(4 + Math.random() * 4).toFixed(2)}          0.00      ${Math.round(s.disk.used * 1024 * 1024)}       ${Math.round(s.disk.used * 64 * 1024)}          0`,
      'sda               0.00          0.00          0.00          0.00          0          0          0',
      '',
      '',
    ].join('\r\n') + '\r\n' };
  }

  cmd_net() {
    const s = vfs.fakeStats();
    const lines = ['Interface        RX速率(MB/s)   TX速率(MB/s)      RX累计          TX累计'];
    for (const n of s.net) {
      lines.push(`${n.iface.padEnd(16)} ${n.rx.toFixed(3).padStart(11)} ${n.tx.toFixed(3).padStart(13)} ${(n.rxBytes / 1024 / 1024).toFixed(1).padStart(13)}MB ${(n.txBytes / 1024 / 1024).toFixed(1).padStart(12)}MB`);
    }
    lines.push('', '（随机生成的假数据，不是真机流量）');
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_top({ args }) {
    const s = vfs.fakeStats();
    const t = T();
    const lines = [
      `top - ${t.clock} up ${vfs.fmtUptime(s.uptimeSec)},  1 user,  load average: ${s.load.map((x) => x.toFixed(2)).join(', ')}`,
      `Tasks: ${s.procTotal} total, ${String(s.procRunning).padStart(3)} running, ${String(s.procSleeping).padStart(3)} sleeping,   0 stopped, ${String(s.procZombie).padStart(3)} zombie`,
      `%Cpu(s): ${s.cpuUser.toFixed(1)} us, ${s.cpuSys.toFixed(1)} sy,  0.0 ni, ${s.cpuIdle.toFixed(1)} id, ${s.cpuWait.toFixed(1)} wa,  0.0 hi,  0.0 si,  0.0 st`,
      `MiB Mem :  ${s.mem.total.toFixed(1)} total, ${s.mem.free.toFixed(1)} free, ${s.mem.used.toFixed(1)} used, ${s.mem.cached.toFixed(1)} buff/cache`,
      `MiB Swap:  ${s.mem.swapTotal.toFixed(1)} total, ${(s.mem.swapTotal - s.mem.swapUsed).toFixed(1)} free, ${s.mem.swapUsed.toFixed(1)} used. ${(s.mem.free + s.mem.cached).toFixed(1)} avail Mem`,
      '',
      '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ];
    for (const p of [...s.procs].sort((a, b) => b.cpu - a.cpu)) {
      const rssKb = Math.round(p.mem * 1024);
      lines.push(`${String(p.pid).padStart(7)} ${p.user.padEnd(8)}  20   0 ${String(p.vszKb || rssKb * 3).padStart(7)} ${String(rssKb).padStart(6)} ${String(Math.round(rssKb * 0.3)).padStart(6)} ${p.stat} ${p.cpu.toFixed(1).padStart(5)} ${((p.mem / s.mem.total) * 100).toFixed(1).padStart(5)} ${this.fmtTopTime(p.ticks)} ${p.cmd}`);
    }
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_kill({ args }) {
    const target = args.find((a) => !a.startsWith('-'));
    if (!target) return { err: 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ...\r\n', code: 1 };
    if (!/^\d+$/.test(target)) return { err: `bash: kill: ${target}: arguments must be process or job IDs\r\n`, code: 1 };
    const pid = Number(target);
    if (pid === 1024) return { err: 'bash: kill: (1024) - Operation not permitted\r\n', code: 1 };
    if (pid === 1) return { err: 'bash: kill: (1) - Operation not permitted\r\n', code: 1 };
    if (pid === 3072) return { out: '' };
    return { err: `bash: kill: (${pid}) - No such process\r\n`, code: 1 };
  }

  cmd_pgrep({ args }) {
    const pat = args.find((a) => !a.startsWith('-'));
    if (!pat) return { err: 'Usage: pgrep [options] <pattern>\r\n', code: 2 };
    const hits = vfs.fakeStats().procs.filter((p) => p.cmd.includes(pat));
    return hits.length ? { out: hits.map((p) => p.pid).join('\r\n') + '\r\n' } : { out: '', code: 1 };
  }

  cmd_uname({ args }) {
    const a = args.join('');
    if (a.includes('a')) return { out: `Linux ${HOST} 6.12.57-armmp #1 SMP Debian 6.12.57-1 (2026-01-15) armv7l GNU/Linux\r\n` };
    if (a.includes('r')) return { out: '6.12.57-armmp\r\n' };
    if (a.includes('m')) return { out: 'armv7l\r\n' };
    if (a.includes('n')) return { out: `${HOST}\r\n` };
    return { out: 'Linux\r\n' };
  }

  cmd_hostname() { return { out: `${HOST}\r\n` }; }

  cmd_uptime() {
    const s = vfs.fakeStats();
    const t = T();
    return { out: ` ${t.clock} up ${vfs.fmtUptime(s.uptimeSec)},  1 user,  load average: ${s.load.map((x) => x.toFixed(2)).join(', ')}\r\n` };
  }

  cmd_date() { const t = T(); return { out: `${t.date}\r\n` }; }

  cmd_whoami() { return { out: `${this.user}\r\n` }; }

  cmd_id({ args }) {
    const i = this.info;
    const uid = args.includes('-u'), gid = args.includes('-g'), groups = args.includes('-G');
    if (uid) return { out: `${i.uid}\r\n` };
    if (gid) return { out: `${i.gid}\r\n` };
    if (groups) return { out: `${i.uid} ${i.gid}\r\n` };
    const grp = i.groups.split(',').map((g) => `${g === 'sudo' ? 27 : i.gid}(${g})`).join(',');
    return { out: `uid=${i.uid}(${this.user}) gid=${i.gid}(${this.user}) groups=${grp}\r\n` };
  }

  cmd_groups() { return { out: `${this.user} ${this.info.groups.replace(/,/g, ' ')}\r\n` }; }

  cmd_w() {
    const t = T();
    return { out: ` ${t.clock} up ${vfs.fmtUptime(vfs.fakeStats().uptimeSec)},  1 user,  load average: 0.72, 0.55, 0.41\r\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\r\n${this.user}    pts/0    10.0.0.2       19:00    0.00s  0.12s  0.00s sshd: ${this.user} [priv]\r\n` };
  }

  cmd_who() { return { out: `${this.user}    pts/0        2026-11-01 19:00 (10.0.0.2)\r\n` }; }

  cmd_ss({ args }) {
    const t = args.join('');
    if (t.includes('-s')) {
      return { out: [
        'Total: 34',
        'TCP:   12 (estab 3, closed 5, orphaned 0, timewait 1)',
        '',
        'Transport Total     IP        IPv6',
        'RAW       1         0         1',
        'UDP       4         3         1',
        'TCP       12        9         3',
        'INET      17        12        5',
        'FRAG      0         0         0',
      ].join('\r\n') + '\r\n' };
    }
    if (t.includes('l')) {
      return { out: [
        'State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess',
        'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=512,fd=3))',
        'LISTEN 0      511        127.0.0.1:3080       0.0.0.0:*    users:(("node",pid=1024,fd=27))',
        'LISTEN 0      511          0.0.0.0:8822       0.0.0.0:*    users:(("node",pid=1024,fd=28))',
      ].join('\r\n') + '\r\n' };
    }
    return { out: 'Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port\r\n' };
  }

  cmd_netstat({ args }) {
    return this.cmd_ss({ args });
  }

  cmd_ip({ args }) {
    const sub = args[0] || 'a';
    if (args.includes('-br') || args.includes('brief')) {
      return { out: [
        'lo               UNKNOWN        127.0.0.1/8 ::1/128',
        `eth0             UP             ${vfs.NET.ip4.split('/')[0]}/24 fe80::42:aff:fe00:2a02/64`,
        `docker0          DOWN           172.17.0.1/16`,
      ].join('\r\n') + '\r\n' };
    }
    if (sub === 'a' || sub === 'addr' || sub === 'address') {
      return { out: [
        '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000',
        '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00',
        '    inet 127.0.0.1/8 scope host lo',
        '    inet6 ::1/128 scope host',
        '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP group default qlen 1000',
        `    link/ether ${vfs.NET.mac} brd ff:ff:ff:ff:ff:ff`,
        `    inet ${vfs.NET.ip4} brd ${vfs.NET.ip4.split('/')[0].replace(/\d+$/, '255')} scope global dynamic eth0`,
        `    inet6 ${vfs.NET.ip6} scope global dynamic`,
      ].join('\r\n') + '\r\n' };
    }
    if (sub === 'r' || sub === 'route') {
      return { out: `default via ${vfs.NET.gw} dev eth0 proto dhcp metric 100\r\n192.168.2.0/24 dev eth0 proto kernel scope link src 192.168.2.171\r\n` };
    }
    return { err: `Object "${sub}" is unknown, try "ip help".\r\n`, code: 1 };
  }

  cmd_ifconfig() {
    return { out: [
      'eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500',
      `        inet ${vfs.NET.ip4.split('/')[0]}  netmask 255.255.255.0  broadcast ${vfs.NET.ip4.split('/')[0].replace(/\d+$/, '255')}`,
      `        inet6 ${vfs.NET.ip6.split('/')[0]}  prefixlen 64  scopeid 0x0<global>`,
      `        ether ${vfs.NET.mac}  txqueuelen 1000  (Ethernet)`,
      '        RX packets 1024  bytes 524288 (512.0 KiB)',
      '        TX packets 512  bytes 262144 (256.0 KiB)',
      '',
      'lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536',
      '        inet 127.0.0.1  netmask 255.0.0.0',
      '        inet6 ::1  prefixlen 128  scopeid 0x10<host>',
      '        loop  txqueuelen 1000  (Local Loopback)',
    ].join('\r\n') + '\r\n' };
  }

  cmd_ping({ args }) {
    const host = args.find((a) => !a.startsWith('-')) || 'localhost';
    const ip = host === 'localhost' ? '127.0.0.1' : host === 'baidu.com' ? '110.242.68.66' : '1.1.1.1';
    const lines = [`PING ${host} (${ip}) 56(84) bytes of data.`];
    const roll = Math.random();
    let sent = 3, recv = 3, min = 999, max = 0, sum = 0;
    if (roll < 0.05) {
      lines.push(`ping: ${host}: Temporary failure in name resolution`);
      return { out: lines.join('\r\n') + '\r\n', code: 2 };
    }
    const lost = roll < 0.25 ? 1 : 0;
    recv = sent - lost;
    const lostIdx = lost ? 1 + Math.floor(Math.random() * 3) : -1;
    for (let i = 1; i <= sent; i++) {
      if (i === lostIdx) { lines.push(`Request timeout for icmp_seq ${i}`); continue; }
      const rtt = 10 + Math.random() * 40;
      min = Math.min(min, rtt); max = Math.max(max, rtt); sum += rtt;
      lines.push(`64 bytes from ${ip}: icmp_seq=${i} ttl=${50 + Math.floor(Math.random() * 10)} time=${rtt.toFixed(1)} ms`);
    }
    lines.push('', `--- ${host} ping statistics ---`);
    lines.push(`${sent} packets transmitted, ${recv} received, ${Math.round(((sent - recv) / sent) * 100)}% packet loss, time 2003ms`);
    if (recv > 0) lines.push(`rtt min/avg/max/mdev = ${min.toFixed(1)}/${(sum / recv).toFixed(1)}/${max.toFixed(1)}/${(max - min).toFixed(1)} ms`);
    return { out: lines.join('\r\n') + '\r\n', code: recv === sent ? 0 : 1 };
  }

  cmd_curl({ args }) {
    const url = args.find((a) => !a.startsWith('-')) || 'https://example.com';
    const host = (url.replace(/^https?:\/\//, '').split('/')[0]) || 'example.com';
    const headers = args.includes('-I');
    const roll = Math.random();
    if (roll < 0.04) {
      return { err: `curl: (6) Could not resolve host: ${host}\r\n`, code: 6 };
    }
    if (roll < 0.09) {
      return { err: `curl: (7) Failed to connect to ${host} port 443 after 3114 ms: Connection refused\r\n`, code: 7 };
    }
    const status = roll < 0.75 ? 200 : roll < 0.85 ? 301 : roll < 0.95 ? 404 : 500;
    const reason = { 200: 'OK', 301: 'Moved Permanently', 404: 'Not Found', 500: 'Internal Server Error' }[status];
    if (headers || args.includes('--head')) {
      const extra = status === 301 ? `location: https://${host}/new-home\r\n` : '';
      return { out: `HTTP/2 ${status} ${reason} \r\ndate: ${new Date().toUTCString()}\r\ncontent-type: text/html; charset=UTF-8\r\nserver: anxi-fake/1.0\r\n${extra}\r\n`, code: status >= 400 ? 0 : 0 };
    }
    if (status === 301) return { out: `<html><head><title>301 Moved Permanently</title></head><body><h1>301 Moved Permanently</h1><p>The resource has moved to <a href="https://${host}/new-home">https://${host}/new-home</a>.</p></body></html>\r\n` };
    if (status === 404) return { out: `<html><head><title>404 Not Found</title></head><body><h1>Not Found</h1><p>The requested URL ${url} was not found on this server.</p></body></html>\r\n` };
    if (status === 500) return { out: `<html><head><title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1><p>The server encountered an internal error and was unable to complete your request.</p></body></html>\r\n` };
    return { out: `<!doctype html><html><head><title>${url}</title></head><body><h1>It works!</h1><p>这是假网络请求，没有真的联网。</p></body></html>\r\n` };
  }

  cmd_wget({ args }) {
    const url = args.find((a) => !a.startsWith('-')) || 'https://example.com';
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const out = [`--${new Date().toISOString()}--  ${url}`, 'Resolving host...', 'Connecting to host|1.1.1.1|:443... connected.', 'HTTP request sent, awaiting response... 200 OK', 'Length: 1024 (1.0K) [text/html]', `Saving to: 'index.html'`, ''];
    if (flags.includes('O') || url.endsWith('/')) out.push("index.html: Read-only file system");
    else out.push("index.html: Read-only file system");
    out.push('Cannot write to \'index.html\' (Read-only file system).');
    return { out: out.join('\r\n') + '\r\n', code: 1 };
  }

  cmd_systemctl({ args }) {
    const sub = args[0];
    const unit = args.slice(1).find((a) => a.includes('.')) || args[1] || '';
    if (sub === 'status') {
      const failed = unit.includes('happiness') && (this.happinessState || 'failed') === 'failed';
      return { out: [
        failed ? `● happiness.service - Happiness Service` : `● ${unit || 'anxi.service'}`,
        `     Loaded: loaded (/lib/systemd/system/${unit || 'anxi.service'}; enabled; preset: enabled)`,
        failed ? `     Active: failed (Result: exit-code) since Thu 2026-01-01 00:00:06 CST; 2 days ago` : `     Active: active (running) since Thu 2026-01-01 00:00:01 CST; 2 days ago`,
        `       Docs: man:systemd-system.conf(5)`,
        failed ? `    Process: 1024 ExecStart=/usr/bin/happinessd (code=exited, status=1/FAILURE)` : `   Main PID: 1024 (anxi)`,
        failed ? `   Main PID: 1024 (code=exited, status=1/FAILURE)` : '',
        failed ? `\r\nJan 01 00:00:06 anxi systemd[1]: happiness.service: Failed with result 'exit-code'.` : '',
        '',
      ].filter(Boolean).join('\r\n') + '\r\n' };
    }
    if (sub === 'cat') {
      const unit = args[1] || '';
      const hit = this.loadFile(`/usr/lib/systemd/system/${unit}`);
      if (!hit || hit.denied) return { err: `No files found for ${unit}.\r\n`, code: 1 };
      return { out: hit.content + '\r\n' };
    }
    if (sub === 'list-unit-files') {
      return { out: [
        'UNIT FILE                 STATE    PRESET',
        'anxi.service              enabled  enabled',
        'containerd.service        enabled  enabled',
        'cron.service              enabled  enabled',
        'docker.service            enabled  enabled',
        'fail2ban.service          enabled  enabled',
        'happiness.service         enabled  enabled',
        'nginx.service             enabled  enabled',
        'ssh.service               enabled  enabled',
        '',
        '8 unit files listed.',
      ].join('\r\n') + '\r\n' };
    }
    if (sub === 'is-active') {
      const unit = args[1] || '';
      const failed = unit.includes('happiness') && (this.happinessState || 'failed') === 'failed';
      if (failed) return { out: 'failed\r\n', code: 3 };
      return { out: 'active\r\n' };
    }
    if (sub === 'list-units' || !sub) {
      return { out: [
        '  UNIT                     LOAD   ACTIVE SUB     DESCRIPTION',
        '  happiness.service        loaded failed failed  Happiness Service',
        '  ssh.service              loaded active running OpenBSD Secure Shell server',
          '  anxi.service             loaded active running anxi agent service',
        '  cron.service             loaded active running Regular background program processing daemon',
        '',
        'LOAD   = Reflects whether the unit definition was properly loaded.',
        'ACTIVE = The high-level unit activation state, i.e. generalization of SUB.',
      ].join('\r\n') + '\r\n' };
    }
    if (['start', 'stop', 'restart', 'enable', 'disable'].includes(sub)) {
      if (this.user !== 'root') {
        return { err: 'Failed to ' + sub + ' ' + unit + ': Interactive authentication required.\r\n', code: 1 };
      }
      if (unit.includes('happiness') && (sub === 'start' || sub === 'restart')) {
        this.happinessState = 'active (running)';
        return { out: '' };
      }
      if (unit.includes('happiness') && sub === 'stop') {
        this.happinessState = 'inactive (dead)';
        return { out: '' };
      }
      return { out: '' };
    }
    return { err: `Unknown operation '${sub}'.`, code: 1 };
  }

  cmd_service({ args }) {
    return this.cmd_systemctl({ args: ['status', ...args.filter((a) => a.includes('.'))] });
  }

  cmd_journalctl({ args }) {
    const unit = args.find((a) => a.includes('.')) || 'happiness.service';
    const t = T();
    return { out: [
      `-- Logs begin at Thu 2026-01-01 00:00:01 CST, end at ${t.date} --`,
      'Jan 01 00:00:02 anxi systemd[1]: Starting Happiness Service...',
      'Jan 01 00:00:04 anxi happinessd[1024]: connecting to mood.sh ... failed',
      'Jan 01 00:00:05 anxi happinessd[1024]: retry 1/3',
      'Jan 01 00:00:06 anxi systemd[1]: happiness.service: Failed with result \'exit-code\'.',
      'Jan 01 00:00:07 anxi systemd[1]: happiness.service: Scheduled restart job, restart counter is at 3.',
      'Jan 01 00:00:08 anxi systemd[1]: happiness.service: Start request repeated too quickly.',
      'Jan 01 00:00:09 anxi systemd[1]: happiness.service: Failed with result \'exit-code\'.',
    ].join('\r\n') + '\r\n' };
  }

  cmd_dmesg() {
    return { out: [
      '[    0.000000] Booting Linux on physical CPU 0x0',
      '[    0.000000] Linux version 6.12.57-armmp (debian-kernel@lists.debian.org) #1 SMP Debian 6.12.57-1',
      '[    0.000000] Memory: 982732K/1048576K available',
      '[    0.128423] mmc0: new high speed SDHC card at address 0001',
      '[    1.204210] EXT4-fs (mmcblk1p2): mounted filesystem with ordered data mode',
      '[    2.401822] systemd[1]: systemd 255.4-1 running in system mode.',
      '[    3.102311] anxi kernel: happiness driver: mood not found, continuing anyway',
    ].join('\r\n') + '\r\n' };
  }

  cmd_crontab({ args }) {
    const sub = args[0] || '-l';
    if (sub === '-l') return {
      out: [
        '# m h  dom mon dow   command',
        '0 3 * * * /usr/local/bin/happiness-check.sh >> /var/log/happiness.log 2>&1',
        '*/15 * * * * /usr/bin/meetingd --send-invite > /dev/null 2>&1',
        '0 9 * * 1 /usr/local/bin/weekly-report.sh --mood high',
        '30 22 * * * /usr/bin/remind-me-to-sleep.sh',
        '# 祝你 cron 跑的时候机器还活着。',
      ].join('\r\n') + '\r\n',
    };
    if (sub === '-e') {
      this.editor = { name: 'nano' };
      return { out: 'no crontab for guest - using an empty one\r\n(virtual nano: Ctrl+X 退出)\r\n' };
    }
    if (sub === '-r') return { err: 'crontab: Read-only file system\r\n', code: 1 };
    return { err: `crontab: usage error: unrecognized option\r\n`, code: 1 };
  }

  // ── 写操作：真写（内存，重启复位）──
  cmd_touch({ args }) {
    const files = args.filter((a) => !a.startsWith('-'));
    let out = '';
    for (const f of files) {
      const p = this.resolve(f);
      const hit = vfs.nodeAt(p);
      if (hit) { hit.node.mtime = Math.floor(Date.now() / 1000); continue; }
      const r = vfs.createFile(p, '', this.user);
      if (r.error) out += `touch: cannot touch '${f}': ${this.errMsg(r.error)}\r\n`;
    }
    return { out, code: out ? 1 : 0 };
  }

  cmd_mkdir({ args }) {
    const parents = args.some((a) => a.startsWith('-') && a.includes('p'));
    const dirs = args.filter((a) => !a.startsWith('-'));
    if (!dirs.length) return { err: 'mkdir: missing operand\r\n', code: 1 };
    let out = '';
    for (const d of dirs) {
      const r = vfs.makeDir(this.resolve(d), this.user, 0o755, parents);
      if (r.error === 'EEXIST') out += `mkdir: cannot create directory '${d}': File exists\r\n`;
      else if (r.error) out += `mkdir: cannot create directory '${d}': ${this.errMsg(r.error)}\r\n`;
    }
    return { out, code: out ? 1 : 0 };
  }

  cmd_rmdir({ args }) {
    const dirs = args.filter((a) => !a.startsWith('-'));
    let out = '';
    for (const d of dirs) {
      const r = vfs.removePath(this.resolve(d), this.user, false);
      if (r.error === 'ENOTEMPTY') out += `rmdir: failed to remove '${d}': Directory not empty\r\n`;
      else if (r.error) out += `rmdir: failed to remove '${d}': ${this.errMsg(r.error)}\r\n`;
    }
    return { out, code: out ? 1 : 0 };
  }

  cmd_rm({ args }) {
    const recursive = args.some((a) => a.startsWith('-') && /[rR]/.test(a));
    const force = args.some((a) => a.startsWith('-') && a.includes('f'));
    const files = args.filter((a) => !a.startsWith('-'));
    if (!files.length) return { err: 'rm: missing operand\r\n', code: 1 };
    let out = '';
    for (const f of files) {
      const r = vfs.removePath(this.resolve(f), this.user, recursive);
      if (r.error === 'ENOENT' && force) continue;
      if (r.error === 'ENOTEMPTY') out += `rm: cannot remove '${f}': Is a directory\r\n`;
      else if (r.error === 'EBUSY') out += `rm: it is dangerous to operate recursively on '/'\r\n`;
      else if (r.error) out += `rm: cannot remove '${f}': ${this.errMsg(r.error)}\r\n`;
    }
    return { out, code: out ? 1 : 0 };
  }

  cmd_mv({ args }) {
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length < 2) return { err: 'mv: missing destination file operand\r\n', code: 1 };
    const [from, to] = files;
    const r = vfs.renamePath(this.resolve(from), this.resolve(to), this.user);
    if (r.error) return { err: `mv: cannot move '${from}' to '${to}': ${this.errMsg(r.error)}\r\n`, code: 1 };
    return { out: '' };
  }

  cmd_cp({ args }) {
    const recursive = args.some((a) => a.startsWith('-') && /[rR]/.test(a));
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length < 2) return { err: 'cp: missing destination file operand\r\n', code: 1 };
    const [from, to] = files;
    const r = vfs.copyPath(this.resolve(from), this.resolve(to), this.user, recursive);
    if (r.error === 'EISDIR') return { err: `cp: -r not specified; omitting directory '${from}'\r\n`, code: 1 };
    if (r.error) return { err: `cp: cannot create regular file '${to}': ${this.errMsg(r.error)}\r\n`, code: 1 };
    return { out: '' };
  }

  cmd_ln({ args }) {
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length < 2) return { err: 'ln: missing file operand\r\n', code: 1 };
    const [target, link] = files;
    const r = vfs.copyPath(this.resolve(target), this.resolve(link), this.user, true);
    if (r.error) return { err: `ln: failed to create link '${link}': ${this.errMsg(r.error)}\r\n`, code: 1 };
    return { out: '' };
  }

  cmd_chmod({ args }) {
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length < 2) return { err: 'chmod: missing operand\r\n', code: 1 };
    const mode = parseInt(files[0], 8);
    if (Number.isNaN(mode)) return { err: `chmod: invalid mode: '${files[0]}'\r\n`, code: 1 };
    let out = '';
    for (const f of files.slice(1)) {
      const r = vfs.chmodPath(this.resolve(f), mode, this.user);
      if (r.error) out += `chmod: changing permissions of '${f}': ${this.errMsg(r.error)}\r\n`;
    }
    return { out, code: out ? 1 : 0 };
  }

  cmd_chown({ args }) {
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length < 2) return { err: 'chown: missing operand\r\n', code: 1 };
    const owner = files[0].split(':')[0];
    let out = '';
    for (const f of files.slice(1)) {
      const r = vfs.chownPath(this.resolve(f), owner, this.user);
      if (r.error) out += `chown: changing ownership of '${f}': ${this.errMsg(r.error)}\r\n`;
    }
    return { out, code: out ? 1 : 0 };
  }

  cmd_tee({ args, stdin }) {
    const append = args.some((a) => a.startsWith('-') && a.includes('a'));
    const files = args.filter((a) => !a.startsWith('-'));
    let out = stdin || '';
    for (const f of files) {
      const p = this.resolve(f);
      const r = append ? vfs.appendFile(p, out, this.user) : vfs.createFile(p, out, this.user);
      if (r.error) return { out, err: `tee: ${f}: ${this.errMsg(r.error)}\r\n`, code: 1 };
    }
    return { out };
  }

  cmd_sudo({ args }) {
    if (this.user === 'root') {
      if (!args.length) return { err: 'usage: sudo [-u user] command [args]\r\n', code: 1 };
      return this.exec(this.expandAll(args), '') || { out: '' };
    }
    return { err: `${this.user} is not in the sudoers file.  This incident will be reported.\r\n`, code: 1 };
  }

  cmd_su() { return { err: 'Password: su: Authentication failure\r\n', code: 1 }; }

  cmd_apt({ args }) {
    const sub = (args[0] || '').toLowerCase();
    if (this.user !== 'root') {
      return { err: `E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\r\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\r\n`, code: 100 };
    }
    if (sub === 'update') {
      return { out: [
        'Hit:1 http://deb.debian.org/debian trixie InRelease',
        'Get:2 http://deb.debian.org/debian trixie-updates InRelease [47.6 kB]',
        'Get:3 http://security.debian.org/debian-security trixie-security InRelease [43.9 kB]',
        'Fetched 91.5 kB in 2s (45.7 kB/s)',
        'Reading package lists... Done',
        'Building dependency tree... Done',
        'Reading state information... Done',
        'All packages are up to date.',
      ].join('\r\n') + '\r\n' };
    }
    if (sub === 'upgrade' || sub === 'full-upgrade' || sub === 'dist-upgrade') {
      return { out: 'Reading package lists... Done\r\nBuilding dependency tree... Done\r\nReading state information... Done\r\nCalculating upgrade... Done\r\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\r\n' };
    }
    if (sub === 'install' || sub === 'reinstall') {
      const name = args.find((a, i) => i > 0 && !a.startsWith('-')) || '';
      const pkg = (vfs.PACKAGES || []).find((p) => p.name === name);
      if (!pkg) return { err: `Reading package lists... Done\r\nBuilding dependency tree... Done\r\nReading state information... Done\r\nE: Unable to locate package ${name}\r\n`, code: 100 };
      return { out: `Reading package lists... Done\r\nBuilding dependency tree... Done\r\nReading state information... Done\r\n${pkg.name} is already the newest version (${pkg.version}).\r\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\r\n` };
    }
    if (sub === 'list') {
      const lines = ['Listing... Done'];
      for (const p of vfs.PACKAGES) lines.push(`${p.name}/trixie,now ${p.version} armhf [installed]`);
      return { out: lines.join('\r\n') + '\r\n' };
    }
    return { out: 'apt 3.0.3 (armhf)\r\nUsage: apt [options] command\r\n' };
  }

  cmd_reboot() {
    if (this.user !== 'root') {
      return { err: 'Failed to set wall message, ignoring: Interactive authentication required.\r\nFailed to reboot system via logind: Interactive authentication required.\r\nFailed to talk to init daemon.\r\n', code: 1 };
    }
    this.write('Connection to anxi closed by remote host.\r\n');
    setTimeout(() => this.close(), 700);
    return { close: true };
  }
  cmd_shutdown() { return this.cmd_reboot(); }
  cmd_poweroff() { return this.cmd_reboot(); }

  cmd_useradd({ args }) {
    if (this.user !== 'root') {
      return { err: 'useradd: Permission denied.\r\nuseradd: cannot lock /etc/passwd; try again later.\r\n', code: 1 };
    }
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) return { err: 'Usage: useradd [options] LOGIN\r\n', code: 2 };
    if (!users.validName(name)) return { err: `useradd: invalid user name '${name}'\r\n`, code: 3 };
    if (users.listNames().includes(name)) return { err: `useradd: user '${name}' already exists\r\n`, code: 9 };
    const init = 'changeme-1024';
    const r = users.addUser(name, init);
    if (!r.ok) return { err: `useradd: ${r.error}\r\n`, code: 9 };
    vfs.ensureHome(name);
    return { out: `useradd: 已创建账号 ${name}（初始密码 ${init}，用 passwd ${name} 修改）\r\n` };
  }

  cmd_userdel({ args }) {
    if (this.user !== 'root') {
      return { err: 'userdel: Permission denied.\r\nuserdel: cannot lock /etc/passwd; try again later.\r\n', code: 1 };
    }
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) return { err: 'Usage: userdel [options] LOGIN\r\n', code: 2 };
    if (!users.listNames().includes(name)) return { err: `userdel: user '${name}' does not exist\r\n`, code: 6 };
    if (name === 'root') return { err: 'userdel: 不能删除 root\r\n', code: 8 };
    const r = users.removeUser(name);
    if (!r.ok) return { err: `userdel: ${r.error}\r\n`, code: 6 };
    // 同时移除虚拟 home
    const home = `/home/${name}`;
    if (vfs.FS[home]) {
      delete vfs.FS[home];
      for (const k of Object.keys(vfs.FS)) if (k.startsWith(home + '/')) delete vfs.FS[k];
      const parent = vfs.FS['/home'];
      parent.children = parent.children.filter((c) => c !== name);
    }
    return { out: `userdel: 已删除账号 ${name}\r\n` };
  }

  cmd_usermod({ args }) {
    if (this.user !== 'root') return { err: 'usermod: Permission denied.\r\n', code: 1 };
    return { out: 'usermod: 请使用 passwd 修改密码\r\n' };
  }

  cmd_passwd({ args }) {
    const target = args.find((a) => !a.startsWith('-')) || this.user;
    if (this.user !== 'root' && target !== this.user) {
      return { err: `passwd: You may not view or modify password information for ${target}.\r\n`, code: 1 };
    }
    if (!users.listNames().includes(target)) {
      return { err: `passwd: user '${target}' does not exist\r\n`, code: 1 };
    }
    const otherUser = target !== this.user;
    this.pwd = { target, step: otherUser ? 'new' : 'current', buf: '', newPw: null };
    if (otherUser) return { out: `New password: ` };
    return { out: `Changing password for ${this.user}.\r\nCurrent password: ` };
  }

  cmd_echo({ args }) {
    let noNewline = false;
    let list = args.slice();
    if (list[0] === '-n') { noNewline = true; list = list.slice(1); }
    const text = list.join(' ')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
    return { out: text + (noNewline ? '' : '\r\n') };
  }

  cmd_help() {
    return { out: [
      'GNU bash，版本 5.2.21(1)-release (arm-unknown-linux-gnueabihf)',
      '这些 shell 内置命令可用。输入命令名或 help 名称了解更多。',
      '',
      '  文件：  ls  cd  pwd  cat  head  tail  grep  wc  sort  uniq  find  stat  file  du  df  less  more',
      '  系统：  uname  hostname  uptime  date  whoami  id  groups  who  w  last  ps  top  free  kill  pgrep',
      '  网络：  ip  ifconfig  ss  netstat  ping  curl  wget',
      '  服务：  systemctl  service  journalctl  dmesg  crontab  dpkg  apt',
  '  硬件：  lsblk  mount  hostnamectl  ssh-keygen -l -f',
  '  审计：  last  lastb  fail2ban-client status sshd（/var/log/auth.log 也有记录）',
  '  容器：  docker ps/images/version/info（假实现）',
  '  账号：  passwd  useradd  userdel（需要 root；真改 users.json，密码仍哈希）',
      '  文本：  awk  sed  sort  uniq  cut  tr（部分实现）  htop 彩色版',
  '  其他：  history  alias  unalias  export  env  printenv  echo  sleep  true  false  clear  exit',
        '  写操作：mkdir rm mv cp touch chmod chown tee（可写 /tmp、home；/etc 需要 root）',
      '',
      '提示：支持 | 管道（grep/wc/sort/head/tail）、Tab 补全、ls -la、ps aux、vim / :q。',
    ].join('\r\n') + '\r\n' };
  }

  cmd_history() {
    return { out: this.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\r\n') + (this.history.length ? '\r\n' : '') };
  }

  cmd_alias() { return { out: Object.entries(this.aliases).map(([k, v]) => `alias ${k}='${v}'`).join('\r\n') + '\r\n' }; }
  cmd_unalias({ args }) { if (args[0]) delete this.aliases[args[0]]; return { out: '' }; }

  cmd_export({ args }) {
    if (!args.length) return { out: '' };
    for (const a of args) { const [k, ...v] = a.split('='); if (v.length) this.env[k] = v.join('='); }
    return { out: '' };
  }
  cmd_env() { return { out: Object.entries(this.env).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n' }; }
  cmd_printenv({ args }) {
    if (args[0]) return { out: (this.env[args[0]] ?? '') + '\r\n' };
    return this.cmd_env();
  }

  // ── awk（基础实现）──
  cmd_awk({ args, stdin }) {
    let sep = null;
    let prog = null;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-F') { sep = args[++i]; continue; }
      if (a.startsWith('-F')) { sep = a.slice(2); continue; }
      if (a.startsWith('-')) continue;
      if (prog === null) { prog = a; continue; }
      files.push(a);
    }
    if (prog === null) return { err: 'usage: awk [-F fs] program [file ...]\r\n', code: 2 };
    const text = stdin !== '' ? stdin : (files.length ? this._readFiles(files) : '');
    if (!text) return { out: '' };
    const m = prog.match(/^\s*(\/[^/]*\/)?\s*\{(.*)\}\s*$/s);
    const pattern = m ? (m[1] || '').trim() : '';
    const body = m ? m[2] : '';
    if (!m) return { err: "awk: syntax error at source line 1\r\n", code: 2 };

    const fieldSep = sep === null ? /\s+/ : (sep === '\\t' ? '\t' : sep);
    const out = [];
    const lines = text.split(/\r?\n/).filter((x, i, a) => !(i === a.length - 1 && x === ''));
    lines.forEach((line, idx) => {
      if (pattern) {
        const pm = pattern.startsWith('/') ? pattern.slice(1, -1) : null;
        if (pm !== null && !new RegExp(pm).test(line)) return;
      }
      const fields = fieldSep instanceof RegExp ? line.trim().split(fieldSep) : line.split(fieldSep);
      const stmts = body.split(';').map((x) => x.trim()).filter(Boolean);
      for (const st of stmts) {
        if (!st.startsWith('print')) continue;
        const expr = st.slice(5).trim();
        if (!expr) { out.push(line); continue; }
        const parts = this._splitTop(expr, ',').map((e) => e.trim());
        const vals = parts.map((e) => {
          if (e === '$0') return line;
          let mm = e.match(/^\$(\d+)$/);
          if (mm) return fields[Number(mm[1]) - 1] ?? '';
          if (e === 'NR') return String(idx + 1);
          if (e === 'NF') return String(fields.length);
          if (/^".*"$/.test(e)) return e.slice(1, -1);
          if (/^-?\d+(\.\d+)?$/.test(e)) return e;
          return '';
        });
        out.push(vals.join(' '));
      }
    });
    return { out: out.length ? out.join('\r\n') + '\r\n' : '' };
  }

  // 按分隔符拆分（忽略引号内）
  _splitTop(str, sep) {
    const out = []; let cur = ''; let q = null;
    for (const c of str) {
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === sep) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  // ── sed（基础实现）──
  cmd_sed({ args, stdin }) {
    let quiet = false;
    let script = null;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n') { quiet = true; continue; }
      if (a === '-e') { script = args[++i]; continue; }
      if (a.startsWith('-')) continue;
      if (script === null) { script = a; continue; }
      files.push(a);
    }
    if (script === null) return { err: 'sed: no script specified\r\n', code: 2 };
    const text = stdin !== '' ? stdin : (files.length ? this._readFiles(files) : null);
    if (text === null) return { err: 'sed: no input files\r\n', code: 2 };
    const lines = text.split(/\r?\n/).filter((x, i, a) => !(i === a.length - 1 && x === ''));
    const out = [];
    const sub = script.match(/^s(.)(.*?)\1(.*?)\1([gi]*)$/s);
    if (sub) {
      const [, , pat, rep, flags] = sub;
      const re = new RegExp(pat, flags.includes('g') ? 'gi' + (flags.includes('i') ? '' : '') : (flags.includes('i') ? 'i' : ''));
      const g = flags.includes('g');
      lines.forEach((line, i) => {
        const replaced = g ? line.replace(re, (m) => rep.replace(/&/g, m).replace(/\\(\d)/g, (x, n) => m)) : line.replace(re, (m) => rep.replace(/&/g, m));
        if (!quiet) out.push(replaced);
      });
      return { out: out.join('\r\n') + (out.length ? '\r\n' : '') };
    }
    const del = script.match(/^\/(.*)\/d$/);
    if (del) {
      const re = new RegExp(del[1]);
      lines.forEach((line) => { if (!re.test(line)) out.push(line); });
      return { out: out.join('\r\n') + (out.length ? '\r\n' : '') };
    }
    const range = script.match(/^(\d+)(?:,(\d+))?p$/);
    if (range) {
      const a0 = Number(range[1]), a1 = Number(range[2] || range[1]);
      lines.forEach((line, i) => { if (i + 1 >= a0 && i + 1 <= a1) out.push(line); });
      return { out: out.join('\r\n') + (out.length ? '\r\n' : '') };
    }
    return { err: `sed: -e expression #1, char ${script.length}: unknown command\r\n`, code: 1 };
  }

  // ── 彩色 htop ──
  cmd_htop() {
    const s = vfs.fakeStats();
    const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
    const bar = (pct, w = 20, color = C.g) => {
      const n = Math.round((Math.min(pct, 100) / 100) * w);
      return color + '|'.repeat(n) + C.d + ' '.repeat(w - n) + C.x;
    };
    const cores = (s.cores && s.cores.length ? s.cores : [s.cpu]).map((v) => Math.min(100, Math.max(0, v)));
    const lines = [];
    lines.push(`${C.d}${new Date().toLocaleString('zh-CN')}${C.x}`);
    cores.forEach((c, i) => lines.push(`${C.c}${String(i).padStart(2)}${C.x}[${bar(c)}] ${c.toFixed(1)}%`));
    const memPct = (s.mem.used / s.mem.total) * 100;
    lines.push(`${C.c}Mem${C.x}[${bar(memPct, 20, C.y)}] ${s.mem.used}M/${s.mem.total}M`);
    lines.push(`Swp[${bar((s.mem.swapUsed / s.mem.swapTotal) * 100, 20, C.r)}] ${s.mem.swapUsed}M/${s.mem.swapTotal}M`);
    lines.push('');
    lines.push(`${C.b}  PID USER      PRI  NI  VIRT   RES S CPU% MEM%   TIME+  Command${C.x}`);
    for (const p of [...s.procs].sort((a, b) => b.cpu - a.cpu)) {
      const cc = p.cpu > 50 ? C.r : p.cpu > 10 ? C.y : C.g;
      const memPct = (p.mem / s.mem.total) * 100;
      const virt = Math.round(p.vszKb || p.mem * 1024 * 3);
      lines.push(` ${String(p.pid).padStart(5)} ${p.user.padEnd(8)}  20   0 ${String(virt).padStart(5)} ${String(Math.round(p.mem * 1024)).padStart(5)} ${p.stat} ${cc}${p.cpu.toFixed(1).padStart(4)}${C.x} ${memPct.toFixed(1).padStart(4)} ${this.fmtTopTime(p.ticks)} ${p.cmd}`);
    }
    lines.push('');
    lines.push(`${C.d}F1 Help  F2 Setup  F3 Search  F4 Filter  F5 Tree  F9 Kill  F10 Quit${C.x}`);
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_sleep({ args }) {
    const n = Math.min(Number(args[0]) || 0, 10);
    if (n <= 0) return { out: '' };
    return new Promise((resolve) => setTimeout(() => resolve({ out: '' }), n * 1000));
  }

  cmd_true() { return { out: '' }; }
  cmd_false() { return { out: '', code: 1 }; }
  cmd_clear() { return { out: '\x1b[2J\x1b[H' }; }

  cmd_vim({ args }) {
    this.editor = { name: 'vim', file: args.find((a) => !a.startsWith('-')) || '' };
    const f = this.editor.file;
    return { out: `"${f || '[No Name]'}" ${f ? '10L, 120B' : '0L, 0B'}\r\n~\r\n~\r\n~\r\n（输入 :q 退出）\r\n` };
  }
  cmd_vi({ args }) { return this.cmd_vim({ args }); }

  cmd_nano({ args }) {
    this.editor = { name: 'nano' };
    return { out: '  GNU nano 7.2                                 退出：Ctrl+X\r\n' };
  }

  cmd_less({ args, stdin }) {
    const text = stdin !== '' ? stdin : this._readFiles(args);
    if (text === null) return { out: '', code: 1 };
    return { out: text.replace(/\r?\n/g, '\r\n') + '\r\n(END)\r\n' };
  }
  cmd_more({ args, stdin }) { return this.cmd_less({ args, stdin }); }

  cmd_man({ args }) {
    const page = args[0] || 'ls';
    const pages = {
      ls: ['LS(1)                    User Commands                   LS(1)', '', 'NAME', '       ls - list directory contents', '', 'SYNOPSIS', '       ls [OPTION]... [FILE]...', '', 'DESCRIPTION', '       List information about the FILEs (the current directory by default).', '       -a, --all          do not ignore entries starting with .', '       -l                 use a long listing format', '', 'Debian GNU/Linux 13                 January 2026                     LS(1)'],
      grep: ['GREP(1)', '', 'NAME', '       grep - print lines that match patterns', '', 'SYNOPSIS', '       grep [OPTION]... PATTERNS [FILE]...', '', 'DESCRIPTION', '       -i, --ignore-case', '       -n, --line-number', '       -v, --invert-match'],
    };
    const lines = pages[page] || ['No manual entry for ' + page];
    return { out: lines.join('\r\n') + '\r\n' };
  }

  cmd_git({ args }) {
    const sub = args[0] || '';
    if (sub === 'status') return { out: 'On branch main\r\nYour branch is up to date with \'origin/main\'.\r\n\r\nnothing to commit, working tree clean\r\n' };
    if (sub === 'log') return { out: 'commit 3ee9636 (HEAD -> main, origin/main)\r\nAuthor: agent <agent@anxi>\r\nDate:   Sat Oct 31 21:23:43 2026 +0800\r\n\r\n    initial service runtime\r\n' };
    if (sub === 'branch') return { out: '* main\r\n' };
    if (sub === 'remote') return { out: 'origin\thttps://github.com/anxi78/ssh-game.git (fetch)\r\norigin\thttps://github.com/anxi78/ssh-game.git (push)\r\n' };
    if (sub === 'diff') return { out: '' };
    return { err: `git: '${sub}' is not a git command. See 'git --help'.\r\n`, code: 1 };
  }

  cmd_tty() { return { out: '/dev/pts/0\r\n' }; }

  cmd_which({ args }) {
    const c = args[0];
    if (!c) return { err: 'which: missing argument\r\n', code: 2 };
    if (!COMMANDS.includes(c)) return { out: '', code: 1 };
    return { out: `/usr/bin/${c}\r\n` };
  }

  cmd_type({ args }) {
    const c = args[0];
    if (!c) return { err: 'type: missing argument\r\n', code: 2 };
    if (this.aliases[c]) return { out: `${c} is aliased to \`${this.aliases[c]}'\r\n` };
    if (['cd', 'pwd', 'echo', 'export', 'alias', 'history', 'exit', 'help'].includes(c)) return { out: `${c} is a shell builtin\r\n` };
    if (COMMANDS.includes(c)) return { out: `${c} is /usr/bin/${c}\r\n` };
    return { err: `type: ${c}: not found\r\n`, code: 1 };
  }

  cmd_exit() { this.write('logout\r\n'); this.close(); return { close: true }; }
  cmd_logout() { return this.cmd_exit(); }
}

function hashCode(s) { let h = 0; for (const c of s) h = ((h << 5) - h + c.charCodeAt(0)) | 0; return Math.abs(h); }

module.exports = { FakeShell };

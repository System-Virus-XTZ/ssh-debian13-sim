/**
 * sftp.js —— 假 SFTP 子系统
 * ==========================
 * 只读、虚拟、假数据：给客户端一个可以 `sftp` / `ls` / `get` 的文件树，
 * 但底层不碰真实磁盘，也不允许写/删/改。
 */

'use strict';

const { utils } = require('ssh2');
const vfs = require('./vfs');

const CODE = (utils && utils.sftp && utils.sftp.STATUS_CODE) || {
  OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4,
  BAD_MESSAGE: 5, NO_CONNECTION: 6, CONNECTION_LOST: 7, OP_UNSUPPORTED: 8,
};

const ATTR = {
  dir: { mode: 0o040755, uid: 0, gid: 0, size: 4096 },
  file: { mode: 0o100644, uid: 0, gid: 0, size: 4096 },
};

function attrsFor(path, content, hint) {
  const hit = vfs.nodeAt(path);
  const node = hit ? hit.node : null;
  const isDir = node ? node.type === 'dir' : (hint ? hint === 'dir' : vfs.isDir(path));
  const size = isDir ? 4096 : Buffer.byteLength(node ? (node.content || '') : (typeof content === 'string' ? content : ''), 'utf8');
  const info = vfs.userInfo(node ? node.owner : 'root');
  return {
    mode: (isDir ? 0o040000 : 0o100000) | (node ? node.mode : (isDir ? 0o755 : 0o644)),
    uid: info.uid, gid: info.gid,
    size,
    atime: node && node.mtime ? node.mtime : Math.floor(Date.now() / 1000),
    mtime: node && node.mtime ? node.mtime : Math.floor(Date.now() / 1000),
  };
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 */
function attachFakeSftp(sftp, user = 'guest') {
  vfs.ensureHome(user);
  const HOME = vfs.homeFor(user);
  const handles = new Map();
  let seq = 0;
  const newHandle = (info) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(++seq, 0);
    handles.set(buf.toString('hex'), info);
    return buf;
  };
  const getHandle = (buf) => handles.get(buf.toString('hex'));

  const readText = (p) => {
    const hit = vfs.readFile(p);
    if (!hit || hit.error) return null;
    if (!vfs.canRead(hit, user)) return { denied: true };
    return hit.content;
  };
  const respondStat = (reqid, path) => {
    const p = vfs.normalize(path, HOME);
    const hit = vfs.nodeAt(p);
    if (!hit) return sftp.status(reqid, CODE.NO_SUCH_FILE);
    if (hit.node.type !== 'dir' && !vfs.canRead(hit, user)) return sftp.status(reqid, CODE.PERMISSION_DENIED);
    return sftp.attrs(reqid, attrsFor(p, hit.node.type === 'dir' ? null : hit.node.content, hit.node.type));
  };

  sftp.on('REALPATH', (reqid, path) => {
    const p = vfs.normalize(path, HOME);
    sftp.name(reqid, [{ filename: p, longname: p, attrs: attrsFor(p, null) }]);
  });

  sftp.on('STAT', (reqid, path) => respondStat(reqid, path));
  sftp.on('LSTAT', (reqid, path) => respondStat(reqid, path));

  sftp.on('OPENDIR', (reqid, path) => {
    const p = vfs.normalize(path, HOME);
    const listing = vfs.listDir(p);
    if (!listing || listing.error) return sftp.status(reqid, CODE.NO_SUCH_FILE);
    // 目录本身不可读/不可进入 → 拒绝
    const hit = vfs.nodeAt(p);
    if (hit && !vfs.canExecDir(hit, user)) return sftp.status(reqid, CODE.PERMISSION_DENIED);
    sftp.handle(reqid, newHandle({ kind: 'dir', path: p, entries: listing.entries, index: 0 }));
  });

  sftp.on('READDIR', (reqid, handleBuf) => {
    const h = getHandle(handleBuf);
    if (!h || h.kind !== 'dir') return sftp.status(reqid, CODE.FAILURE);
    if (h.index >= h.entries.length) return sftp.status(reqid, CODE.EOF);
    // 返回一批，客户端会继续请求直到 EOF
    const batch = h.entries.slice(h.index, h.index + 50);
    h.index += batch.length;
    sftp.name(reqid, batch.map((name) => {
      const full = h.path === '/' ? `/${name}` : `${h.path}/${name}`;
      const hit = vfs.nodeAt(full);
      const node = hit ? hit.node : { type: 'file', content: '' };
      const isDir = node.type === 'dir';
      const size = isDir ? 4096 : Buffer.byteLength(node.content || '', 'utf8');
      const longname = `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 root root ${String(size).padStart(6)} Jan  1 00:00 ${name}`;
      return { filename: name, longname, attrs: attrsFor(full, isDir ? null : (node.content || ''), node.type) };
    }));
  });

  sftp.on('OPEN', (reqid, filename, flags) => {
    const p = vfs.normalize(filename, HOME);
    const write = (flags & 0x2) !== 0;      // SSH_FXF_WRITE
    const create = (flags & 0x8) !== 0;     // SSH_FXF_CREAT
    const trunc = (flags & 0x10) !== 0;     // SSH_FXF_TRUNC
    const append = (flags & 0x4) !== 0;     // SSH_FXF_APPEND
    const hit = vfs.nodeAt(p);
    if (hit && vfs.isDir(p)) return sftp.status(reqid, CODE.FAILURE);

    if (write) {
      if (!vfs.mayWrite(p, user)) return sftp.status(reqid, CODE.PERMISSION_DENIED);
      if (!hit && !create) return sftp.status(reqid, CODE.NO_SUCH_FILE);
      if (!hit && create) {
        const r = vfs.createFile(p, '', user);
        if (r.error) return sftp.status(reqid, r.error === 'EACCES' ? CODE.PERMISSION_DENIED : CODE.NO_SUCH_FILE);
      }
      const node = vfs.nodeAt(p);
      const cur = trunc ? '' : (node ? (node.node.content || '') : '');
      return sftp.handle(reqid, newHandle({ kind: 'file', path: p, data: Buffer.from(cur, 'utf8'), write: true, append, offset: 0 }));
    }

    const readHit = vfs.readFile(p);
    if (!readHit || readHit.error) return sftp.status(reqid, CODE.NO_SUCH_FILE);
    if (!vfs.canRead(readHit, user)) return sftp.status(reqid, CODE.PERMISSION_DENIED);
    sftp.handle(reqid, newHandle({ kind: 'file', path: p, data: Buffer.from(readHit.content || '', 'utf8'), offset: 0 }));
  });

  sftp.on('READ', (reqid, handleBuf, offset, length) => {
    const h = getHandle(handleBuf);
    if (!h || h.kind !== 'file') return sftp.status(reqid, CODE.FAILURE);
    const chunk = h.data.slice(offset, offset + length);
    if (chunk.length === 0) return sftp.status(reqid, CODE.EOF);
    sftp.data(reqid, chunk);
  });

  sftp.on('FSTAT', (reqid, handleBuf) => {
    const h = getHandle(handleBuf);
    if (!h) return sftp.status(reqid, CODE.FAILURE);
    if (h.kind === 'dir') return sftp.attrs(reqid, attrsFor(h.path, null, 'dir'));
    return sftp.attrs(reqid, attrsFor(h.path, h.data.toString('utf8'), 'file'));
  });

  sftp.on('CLOSE', (reqid, handleBuf) => {
    const h = getHandle(handleBuf);
    handles.delete(handleBuf.toString('hex'));
    if (h && h.write) {
      if (h.aborted) return sftp.status(reqid, CODE.FAILURE, 'File too large');
      const r = vfs.createFile(h.path, h.data.toString('utf8'), user);
      if (!r.ok) return sftp.status(reqid, CODE.FAILURE, r.error === 'ENOSPC' ? 'No space left on device' : r.error === 'EFBIG' ? 'File too large' : 'Write failed');
      return sftp.status(reqid, CODE.OK);
    }
    sftp.status(reqid, CODE.OK);
  });

  sftp.on('WRITE', (reqid, handleBuf, offset, data) => {
    const h = getHandle(handleBuf);
    if (!h || !h.write) return sftp.status(reqid, CODE.PERMISSION_DENIED);
    const projected = h.append ? h.data.length + data.length : Math.max(h.data.length, offset + data.length);
    // 单文件大小上限
    if (projected > vfs.MAX_FILE_BYTES) {
      h.aborted = true;
      return sftp.status(reqid, CODE.FAILURE, 'File too large');
    }
    if (h.append) {
      h.data = Buffer.concat([h.data, data]);
    } else {
      const need = offset + data.length;
      if (h.data.length < need) h.data = Buffer.concat([h.data, Buffer.alloc(need - h.data.length)]);
      data.copy(h.data, offset);
    }
    sftp.status(reqid, CODE.OK);
  });

  sftp.on('REMOVE', (reqid, path) => {
    const r = vfs.removePath(vfs.normalize(path, HOME), user, false);
    sftp.status(reqid, r.ok ? CODE.OK : (r.error === 'EACCES' ? CODE.PERMISSION_DENIED : CODE.NO_SUCH_FILE));
  });

  sftp.on('RMDIR', (reqid, path) => {
    const r = vfs.removePath(vfs.normalize(path, HOME), user, false);
    sftp.status(reqid, r.ok ? CODE.OK : (r.error === 'ENOTEMPTY' ? CODE.FAILURE : CODE.NO_SUCH_FILE));
  });

  sftp.on('MKDIR', (reqid, path) => {
    const r = vfs.makeDir(vfs.normalize(path, HOME), user);
    sftp.status(reqid, r.ok ? CODE.OK : (r.error === 'EACCES' ? CODE.PERMISSION_DENIED : r.error === 'EEXIST' ? CODE.FAILURE : CODE.NO_SUCH_FILE));
  });

  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const r = vfs.renamePath(vfs.normalize(oldPath, HOME), vfs.normalize(newPath, HOME), user);
    sftp.status(reqid, r.ok ? CODE.OK : (r.error === 'EACCES' ? CODE.PERMISSION_DENIED : CODE.FAILURE));
  });

  sftp.on('SETSTAT', (reqid, path, attrs) => {
    if (attrs && typeof attrs.mode === 'number') {
      const r = vfs.chmodPath(vfs.normalize(path, HOME), attrs.mode & 0o777, user);
      return sftp.status(reqid, r.ok ? CODE.OK : CODE.PERMISSION_DENIED);
    }
    sftp.status(reqid, CODE.OK);
  });

  sftp.on('FSETSTAT', (reqid, handleBuf, attrs) => {
    const h = getHandle(handleBuf);
    if (!h || !attrs || typeof attrs.mode !== 'number') return sftp.status(reqid, CODE.OK);
    const r = vfs.chmodPath(h.path, attrs.mode & 0o777, user);
    sftp.status(reqid, r.ok ? CODE.OK : CODE.PERMISSION_DENIED);
  });

  sftp.on('SYMLINK', (reqid, target, linkPath) => {
    const r = vfs.createFile(vfs.normalize(linkPath, HOME), target, user);
    sftp.status(reqid, r.ok ? CODE.OK : CODE.PERMISSION_DENIED);
  });

  sftp.on('READLINK', (reqid) => sftp.status(reqid, CODE.NO_SUCH_FILE));
  sftp.on('EXTENDED', (reqid) => sftp.status(reqid, CODE.OP_UNSUPPORTED));

  sftp.on('error', () => {});
  sftp.on('end', () => handles.clear());
}

module.exports = { attachFakeSftp };

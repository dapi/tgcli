import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

function lockPayload(options = {}) {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...options,
  };
}

export function readStoreLock(storeDir) {
  const lockPath = path.join(storeDir, 'LOCK');
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return {
      exists: true,
      path: lockPath,
      info: raw.trim(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false, path: lockPath, info: null };
    }
    throw error;
  }
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

export function parseStoreLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function parseLockPid(raw) {
  return parseStoreLock(raw)?.pid ?? null;
}

function removeStaleLockFile(lockPath, pid, label) {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    const details = error?.message ? `: ${error.message}` : '';
    throw new Error(`Found stale ${label} for dead pid ${pid}, but could not remove ${lockPath}${details}`);
  }
}

function getAliveReadLocks(storeDir) {
  let entries;
  try {
    entries = fs.readdirSync(storeDir);
  } catch {
    return [];
  }
  const alive = [];
  for (const name of entries) {
    if (!name.startsWith('LOCK.read.')) continue;
    const filePath = path.join(storeDir, name);
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8').trim(); } catch { continue; }
    const pid = parseLockPid(raw);
    if (!pid) continue;
    if (isPidAlive(pid)) {
      alive.push({ name, pid });
    } else {
      removeStaleLockFile(filePath, pid, 'read lock');
    }
  }
  return alive;
}

export function acquireOwnerLock(storeDir, options = {}) {
  const lockPath = path.join(storeDir, 'LOCK');
  fs.mkdirSync(storeDir, { recursive: true });

  // Check for alive read locks before acquiring write lock
  const aliveReaders = getAliveReadLocks(storeDir);
  if (aliveReaders.length > 0) {
    const pids = aliveReaders.map(r => r.pid).join(', ');
    throw new Error(`Store has active readers (pids: ${pids}), cannot acquire write lock`);
  }

  const ownerId = randomUUID();
  const details = lockPayload({
    ownerId,
    kind: options.kind ?? 'transient',
    state: options.state ?? 'transient',
    protocolVersion: options.protocolVersion ?? 1,
    socketPath: options.socketPath ?? null,
  });

  const claim = () => {
    if (fs.existsSync(`${lockPath}.reclaim`)) {
      throw new Error('Store lock recovery is already in progress');
    }
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(details));
      if (fs.existsSync(`${lockPath}.reclaim`)) {
        throw new Error('Store lock recovery is already in progress');
      }
    } catch (error) {
      fs.unlinkSync(lockPath);
      throw error;
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    claim();
  } catch (error) {
    if (error.code === 'EEXIST') {
      const info = readStoreLock(storeDir);
      const pid = parseLockPid(info.info);
      if (pid && !isPidAlive(pid)) {
        const reclaimPath = `${lockPath}.reclaim`;
        let reclaimFd;
        try {
          reclaimFd = fs.openSync(reclaimPath, 'wx', 0o600);
        } catch (reclaimError) {
          if (reclaimError?.code === 'EEXIST') {
            throw new Error('Store lock recovery is already in progress');
          }
          throw reclaimError;
        }
        try {
          fs.writeFileSync(reclaimFd, JSON.stringify(lockPayload()));
          const current = readStoreLock(storeDir);
          if (current.info !== info.info) {
            throw new Error('Store lock changed during recovery');
          }
          removeStaleLockFile(lockPath, pid, 'store lock');
          const fd = fs.openSync(lockPath, 'wx', 0o600);
          try {
            fs.writeFileSync(fd, JSON.stringify(details));
          } finally {
            fs.closeSync(fd);
          }
        } finally {
          fs.closeSync(reclaimFd);
          fs.unlinkSync(reclaimPath);
        }
      } else {
        const extra = info.info ? ` (${info.info})` : '';
        throw new Error(`Store is locked by another process${extra}`);
      }
    } else {
      throw error;
    }
  }

  let released = false;
  const update = (patch) => {
    if (released) throw new Error('Cannot update a released store lock');
    const current = parseStoreLock(readStoreLock(storeDir).info);
    if (current?.ownerId !== ownerId) throw new Error('Store lock ownership changed');
    Object.assign(details, patch);
    const tempPath = `${lockPath}.${ownerId}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(details), { mode: 0o600 });
      fs.renameSync(tempPath, lockPath);
    } finally {
      try { fs.unlinkSync(tempPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  };
  const release = () => {
    if (released) {
      return;
    }
    const current = parseStoreLock(readStoreLock(storeDir).info);
    if (current?.ownerId !== ownerId) throw new Error('Store lock ownership changed');
    try {
      fs.unlinkSync(lockPath);
      released = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      released = true;
    }
  };
  return { info: details, update, release };
}

export function acquireStoreLock(storeDir) {
  return acquireOwnerLock(storeDir).release;
}

export function acquireReadLock(storeDir) {
  // Legacy callers open writable services and a Telegram session even for reads.
  // Until they use the read-only archive or owner IPC, they need exclusive ownership.
  return acquireStoreLock(storeDir);
}

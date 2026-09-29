import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

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
  // This independent SQLite transaction is the lifetime ownership guard. The OS
  // releases it after an abrupt exit, so stale metadata cannot strand the store.
  const guardPath = path.join(storeDir, 'LOCK.guard.db');
  const guard = new Database(guardPath, { timeout: 0 });
  fs.chmodSync(guardPath, 0o600);
  let guardHeld = false;
  try {
    try {
      guard.exec('BEGIN IMMEDIATE');
      guardHeld = true;
    } catch (error) {
      if (error.code === 'SQLITE_BUSY') {
        throw new Error('Store is locked by another process');
      }
      throw error;
    }

    const reclaimPath = `${lockPath}.reclaim`;
    if (fs.existsSync(reclaimPath)) {
      const reclaimPid = parseLockPid(fs.readFileSync(reclaimPath, 'utf8'));
      if (!reclaimPid || isPidAlive(reclaimPid)) {
        throw new Error('Store lock recovery is already in progress');
      }
      removeStaleLockFile(reclaimPath, reclaimPid, 'recovery lock');
    }

    const current = readStoreLock(storeDir);
    if (current.exists) {
      const pid = parseLockPid(current.info);
      if (!pid || isPidAlive(pid)) {
        const extra = current.info ? ` (${current.info})` : '';
        throw new Error(`Store is locked by another process${extra}`);
      }
      removeStaleLockFile(lockPath, pid, 'store lock');
    }
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(details));
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (guardHeld) guard.exec('ROLLBACK');
    guard.close();
    throw error;
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
    try {
      const current = parseStoreLock(readStoreLock(storeDir).info);
      if (current?.ownerId !== ownerId) throw new Error('Store lock ownership changed');
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      released = true;
      guard.exec('ROLLBACK');
      guard.close();
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

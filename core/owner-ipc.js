import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

import { parseStoreLock, readStoreLock } from '../store-lock.js';

export const OWNER_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

function storeIdentity(storeDir) {
  return fs.realpathSync(storeDir);
}

export function ownerSocketPath(storeDir) {
  const identity = storeIdentity(storeDir);
  const runtimeDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'tgcli', 'run')
    : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'tgcli', 'run');
  const name = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return path.join(runtimeDir, `${name}.sock`);
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function writeFrame(socket, frame) {
  const body = Buffer.from(JSON.stringify(frame));
  if (body.length > MAX_FRAME_BYTES) throw protocolError('FRAME_TOO_LARGE', 'Owner IPC frame exceeds 1 MiB');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  socket.write(Buffer.concat([header, body]));
}

function frameReader(socket) {
  let buffered = Buffer.alloc(0);
  let pending = null;
  const queue = [];
  let ended = false;
  let failure = null;
  const deliver = () => {
    if (!pending) return;
    if (queue.length) {
      const { resolve } = pending;
      pending = null;
      resolve(queue.shift());
    } else if (ended) {
      const { reject } = pending;
      pending = null;
      reject(failure || protocolError('OWNER_UNAVAILABLE', 'Owner IPC connection closed'));
    }
  };
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE(0);
      if (size > MAX_FRAME_BYTES || size === 0) {
        failure = protocolError('FRAME_TOO_LARGE', 'Invalid owner IPC frame size');
        socket.destroy(failure);
        return;
      }
      if (buffered.length < size + 4) break;
      const body = buffered.subarray(4, size + 4);
      buffered = buffered.subarray(size + 4);
      try {
        queue.push(JSON.parse(body.toString('utf8')));
      } catch {
        failure = protocolError('INVALID_FRAME', 'Invalid owner IPC JSON frame');
        socket.destroy(failure);
        return;
      }
      deliver();
    }
  });
  socket.on('error', (error) => { failure = error; ended = true; deliver(); });
  socket.on('close', () => { ended = true; deliver(); });
  return () => {
    if (pending) throw new Error('Concurrent frame reads are unsupported');
    return new Promise((resolve, reject) => { pending = { resolve, reject }; deliver(); });
  };
}

export async function startOwnerIpc({ storeDir, ownerLock, operations }) {
  const identity = storeIdentity(storeDir);
  const socketPath = ownerSocketPath(storeDir);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(socketPath), 0o700);
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  const sockets = new Set();
  const tasks = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(30000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    const readFrame = frameReader(socket);
    const task = (async () => {
      const hello = await readFrame();
      if (hello.type !== 'hello' || hello.protocolVersion !== OWNER_PROTOCOL_VERSION ||
          hello.ownerId !== ownerLock.info.ownerId || hello.store !== identity) {
        throw protocolError('PROTOCOL_MISMATCH', 'Owner IPC handshake mismatch');
      }
      writeFrame(socket, { type: 'hello', protocolVersion: OWNER_PROTOCOL_VERSION,
        ownerId: ownerLock.info.ownerId, store: identity });
      const request = await readFrame();
      if (request.type !== 'request' || typeof request.id !== 'string' ||
          typeof request.operation !== 'string' || !Number.isFinite(request.deadline)) {
        throw protocolError('INVALID_REQUEST', 'Invalid owner IPC request');
      }
      const operation = operations[request.operation];
      if (typeof operation !== 'function') throw protocolError('INVALID_OPERATION', 'Unknown owner operation');
      if (Date.now() >= request.deadline) throw protocolError('OWNER_BUSY', 'Owner request deadline expired');
      socket.setTimeout(Math.max(1000, request.deadline - Date.now() + 1000), () => socket.destroy());
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, request.deadline - Date.now()));
      try {
        const result = await operation(request.args, { signal: controller.signal, requestId: request.id });
        if (controller.signal.aborted) throw protocolError('UNKNOWN_RESULT', 'Owner request deadline expired during execution');
        const bytes = Buffer.from(JSON.stringify(result ?? null));
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          writeFrame(socket, { type: 'chunk', id: request.id,
            data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
        }
        writeFrame(socket, { type: 'complete', id: request.id });
      } finally {
        clearTimeout(timeout);
      }
    })().catch((error) => {
      if (!socket.destroyed) writeFrame(socket, { type: 'error', code: error.code || 'OPERATION_FAILED',
        message: error.message });
    }).finally(() => socket.end());
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    fs.chmodSync(socketPath, 0o600);
    ownerLock.update({ state: 'ready', socketPath, protocolVersion: OWNER_PROTOCOL_VERSION });
  } catch (error) {
    server.close();
    try { fs.unlinkSync(socketPath); } catch { /* no endpoint was created */ }
    throw error;
  }
  return async () => {
    ownerLock.update({ state: 'stopping' });
    const closed = new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...tasks]);
    for (const socket of sockets) socket.destroy();
    await closed;
    try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

export async function callOwner({ storeDir, operation, args, timeoutMs = 30000 }) {
  const identity = storeIdentity(storeDir);
  const lock = parseStoreLock(readStoreLock(storeDir).info);
  if (!lock) throw protocolError('OWNER_UNAVAILABLE', 'No owner is available');
  if (lock.state !== 'ready' || !lock.socketPath) {
    throw protocolError('OWNER_STARTING', 'Owner is not ready for CLI requests');
  }
  if (lock.protocolVersion !== OWNER_PROTOCOL_VERSION) {
    throw protocolError('PROTOCOL_MISMATCH', 'Owner IPC protocol version differs');
  }
  const socket = net.createConnection(lock.socketPath);
  const readFrame = frameReader(socket);
  const deadline = Date.now() + timeoutMs;
  let requestSent = false;
  const timer = setTimeout(() => socket.destroy(protocolError(
    requestSent ? 'UNKNOWN_RESULT' : 'OWNER_UNAVAILABLE',
    requestSent ? 'Owner request timed out; its result is unknown' : 'Owner IPC timed out',
  )), timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    writeFrame(socket, { type: 'hello', protocolVersion: OWNER_PROTOCOL_VERSION,
      ownerId: lock.ownerId, store: identity });
    const hello = await readFrame();
    if (hello.type !== 'hello' || hello.ownerId !== lock.ownerId ||
        hello.store !== identity || hello.protocolVersion !== OWNER_PROTOCOL_VERSION) {
      throw protocolError('PROTOCOL_MISMATCH', 'Owner IPC identity mismatch');
    }
    if (parseStoreLock(readStoreLock(storeDir).info)?.ownerId !== lock.ownerId) {
      throw protocolError('OWNER_UNAVAILABLE', 'Owner changed during connection');
    }
    const id = randomUUID();
    writeFrame(socket, { type: 'request', id, operation, args, deadline });
    requestSent = true;
    const chunks = [];
    while (true) {
      const frame = await readFrame();
      if (frame.type === 'error') throw protocolError(frame.code, frame.message);
      if (frame.id !== id) throw protocolError('INVALID_FRAME', 'Owner IPC request ID mismatch');
      if (frame.type === 'chunk') chunks.push(Buffer.from(frame.data, 'base64'));
      else if (frame.type === 'complete') return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      else throw protocolError('INVALID_FRAME', 'Unexpected owner IPC response');
    }
  } catch (error) {
    if (requestSent && ['OWNER_UNAVAILABLE', 'ECONNRESET', 'EPIPE'].includes(error.code)) {
      throw protocolError('UNKNOWN_RESULT', 'Owner connection closed after request; its result is unknown');
    }
    if (!requestSent && ['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) {
      throw protocolError('OWNER_UNAVAILABLE', 'Owner IPC is unavailable');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

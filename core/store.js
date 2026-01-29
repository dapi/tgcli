import os from 'os';
import path from 'path';

export const STORE_ENV_VAR = 'FROGIVERSE_STORE';
export const DEFAULT_STORE_DIR = path.join(os.homedir(), '.frogiverse');

export function resolveStoreDir(storeOverride, options = {}) {
  const envVar = options.envVar ?? STORE_ENV_VAR;
  const defaultDir = options.defaultDir ?? DEFAULT_STORE_DIR;
  const envValue = envVar ? process.env[envVar] : null;
  const resolved = storeOverride || envValue || defaultDir;
  return path.resolve(resolved);
}

export function resolveStorePaths(storeDir, options = {}) {
  const sessionFile = options.sessionFile ?? 'session.json';
  const dbFile = options.dbFile ?? 'messages.db';
  return {
    sessionPath: path.join(storeDir, sessionFile),
    dbPath: path.join(storeDir, dbFile),
  };
}

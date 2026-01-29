import os from 'os';
import path from 'path';

export const STORE_ENV_VAR = 'TGCLI_STORE';

function resolveDefaultStoreDir() {
  const homeDir = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'tgcli');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'tgcli');
  }
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  return path.join(xdgDataHome, 'tgcli');
}

export const DEFAULT_STORE_DIR = resolveDefaultStoreDir();

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

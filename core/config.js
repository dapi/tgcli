import fs from 'fs';
import path from 'path';

import { resolveStoreDir } from './store.js';

const CONFIG_FILE = 'config.json';

function normalizeValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return String(value).trim();
}

export function normalizeConfig(raw = {}) {
  const apiId = normalizeValue(raw.apiId ?? raw.api_id ?? raw.apiID);
  const apiHash = normalizeValue(raw.apiHash ?? raw.api_hash);
  const phoneNumber = normalizeValue(raw.phoneNumber ?? raw.phone ?? raw.phone_number);
  return {
    apiId,
    apiHash,
    phoneNumber,
  };
}

export function validateConfig(config) {
  const missing = [];
  if (!config?.apiId) missing.push('apiId');
  if (!config?.apiHash) missing.push('apiHash');
  if (!config?.phoneNumber) missing.push('phoneNumber');
  return missing;
}

export function resolveConfigPath(storeDir = resolveStoreDir()) {
  return path.join(storeDir, CONFIG_FILE);
}

export function loadConfig(storeDir = resolveStoreDir()) {
  const configPath = resolveConfigPath(storeDir);
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      config: normalizeConfig(parsed ?? {}),
      path: configPath,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { config: null, path: configPath };
    }
    throw error;
  }
}

export function saveConfig(storeDir = resolveStoreDir(), config) {
  const configPath = resolveConfigPath(storeDir);
  const payload = normalizeConfig(config ?? {});
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { config: payload, path: configPath };
}

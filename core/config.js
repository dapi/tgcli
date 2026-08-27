import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveStoreDir } from './store.js';

const CONFIG_FILE = 'config.json';
const GLOBAL_CONFIG_FILE = '.tgclirc';

function normalizeValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return String(value).trim();
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

export function normalizeConfig(raw = {}, options = {}) {
  const apiId = normalizeValue(raw.apiId ?? raw.api_id ?? raw.apiID);
  const apiHash = normalizeValue(raw.apiHash ?? raw.api_hash);
  const phoneNumber = normalizeValue(raw.phoneNumber ?? raw.phone ?? raw.phone_number);
  const envProxy = options.includeEnv === false ? '' : normalizeValue(process.env.TELEGRAM_PROXY);
  const proxy = envProxy
    || normalizeValue(raw.proxy ?? raw.proxyUrl ?? raw.proxy_url);
  const mcpRaw = raw.mcp && typeof raw.mcp === 'object' ? raw.mcp : {};
  const mcpEnabled = normalizeBoolean(raw.mcpEnabled ?? raw.mcp_enabled ?? mcpRaw.enabled, false);
  const mcp = {
    enabled: mcpEnabled,
  };
  const mcpHost = normalizeValue(mcpRaw.host ?? raw.mcpHost ?? raw.mcp_host);
  if (mcpHost) {
    mcp.host = mcpHost;
  }
  const mcpPortRaw = mcpRaw.port ?? raw.mcpPort ?? raw.mcp_port;
  const mcpPort = Number(mcpPortRaw);
  if (Number.isFinite(mcpPort) && mcpPort > 0) {
    mcp.port = mcpPort;
  }
  return {
    apiId,
    apiHash,
    phoneNumber,
    proxy,
    mcp,
  };
}

export function validateConfig(config) {
  const missing = [];
  if (!config?.apiId) missing.push('apiId');
  if (!config?.apiHash) missing.push('apiHash');
  if (!config?.phoneNumber) missing.push('phoneNumber');
  return missing;
}

export function resolveGlobalConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, GLOBAL_CONFIG_FILE);
}

function unquoteRcValue(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function loadRcConfig(rcPath = resolveGlobalConfigPath()) {
  let raw;
  try {
    raw = fs.readFileSync(rcPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  const config = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      throw new Error(`${rcPath}: invalid entry on line ${index + 1}`);
    }
    const rawKey = trimmed.slice(0, separator).trim();
    if (rawKey !== 'proxy') {
      throw new Error(`${rcPath}: unsupported key ${rawKey} on line ${index + 1}`);
    }
    const value = unquoteRcValue(trimmed.slice(separator + 1).trim());
    config.proxy = value;
  }
  return config;
}

export function resolveConfigPath(storeDir = resolveStoreDir()) {
  return path.join(storeDir, CONFIG_FILE);
}

function resolveEffectiveConfig(rawConfig, rcConfig) {
  const normalized = normalizeConfig(rawConfig ?? {}, { includeEnv: false });
  const profileProxy = normalizeValue(
    rawConfig?.proxy ?? rawConfig?.proxyUrl ?? rawConfig?.proxy_url,
  );
  normalized.proxy = normalizeValue(process.env.TELEGRAM_PROXY)
    || profileProxy
    || normalizeValue(rcConfig.proxy);
  return normalized;
}

export function loadConfig(storeDir = resolveStoreDir(), options = {}) {
  const configPath = resolveConfigPath(storeDir);
  const rcPath = options.rcPath ?? resolveGlobalConfigPath();
  const rcConfig = loadRcConfig(rcPath);
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) ?? {};
    return {
      config: resolveEffectiveConfig(parsed, rcConfig),
      rawConfig: parsed,
      path: configPath,
      rcPath,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const hasFallbackProxy = Boolean(
        normalizeValue(process.env.TELEGRAM_PROXY) || normalizeValue(rcConfig.proxy),
      );
      return {
        config: hasFallbackProxy ? resolveEffectiveConfig({}, rcConfig) : null,
        rawConfig: null,
        path: configPath,
        rcPath,
      };
    }
    throw error;
  }
}

export function saveConfig(storeDir = resolveStoreDir(), config) {
  const configPath = resolveConfigPath(storeDir);
  const payload = normalizeConfig(config ?? {}, { includeEnv: false });
  fs.mkdirSync(storeDir, { recursive: true });
  if (fs.existsSync(configPath) && process.platform !== 'win32') {
    fs.chmodSync(configPath, 0o600);
  }
  fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(configPath, 0o600);
  }
  return { config: payload, path: configPath };
}

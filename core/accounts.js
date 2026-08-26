import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REGISTRY_FILE = 'accounts.json';
const ACCOUNT_METADATA_FILE = 'account.json';
const REGISTRY_LOCK_FILE = '.accounts.lock';
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeAccountId(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalized) || normalized === 'default') {
    throw new Error('Account ID must use 1-64 lowercase letters, numbers, underscores, or hyphens and cannot be "default".');
  }
  return normalized;
}

function normalizeAlias(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'default' || normalized.startsWith('+')) {
    throw new Error('Account alias must not be empty, reserved, or phone-shaped.');
  }
  return normalized;
}

export function normalizePhoneNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw.startsWith('+')) {
    throw new Error('Phone number must start with + and include country code.');
  }
  const digits = raw.slice(1).replace(/[\s().-]/g, '');
  if (!/^\d{7,15}$/.test(digits)) {
    throw new Error('Phone number must contain 7-15 digits after the country code.');
  }
  return `+${digits}`;
}

export function resolveAccountsRegistryPath(baseStoreDir) {
  return path.join(path.resolve(baseStoreDir), REGISTRY_FILE);
}

function readRegistry(baseStoreDir) {
  const registryPath = resolveAccountsRegistryPath(baseStoreDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      throw new Error(`Invalid tgcli accounts registry: ${registryPath}`);
    }
    const accounts = parsed.accounts.map((account) => {
      if (!account || !Array.isArray(account.aliases)) {
        throw new Error(`Invalid tgcli accounts registry: ${registryPath}`);
      }
      return {
        id: normalizeAccountId(account.id),
        phoneNumber: normalizePhoneNumber(account.phoneNumber),
        aliases: account.aliases.map(normalizeAlias),
      };
    });
    return { version: 1, accounts };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, accounts: [] };
    }
    throw error;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireRegistryLock(baseStoreDir, timeoutMs = 5000) {
  const resolvedBaseStoreDir = path.resolve(baseStoreDir);
  fs.mkdirSync(resolvedBaseStoreDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(resolvedBaseStoreDir, REGISTRY_LOCK_FILE);
  const token = randomUUID();
  const payload = { pid: process.pid, token };
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(payload));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!isPidAlive(existing?.pid)) {
          throw new Error(`Stale tgcli accounts registry lock references dead pid ${existing?.pid ?? 'unknown'}: ${lockPath}. Remove it explicitly after verifying no account command is running.`);
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') continue;
        if (lockError instanceof SyntaxError) {
          const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (ageMs < 1000 && Date.now() < deadline) {
            Atomics.wait(sleeper, 0, 0, 5);
            continue;
          }
          throw new Error(`Invalid or stale tgcli accounts registry lock: ${lockPath}. Remove it explicitly after verifying no account command is running.`);
        }
        throw lockError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for tgcli accounts registry lock: ${lockPath}`);
      }
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }

  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (current?.token === token) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
}

function writeRegistry(baseStoreDir, registry) {
  const registryPath = resolveAccountsRegistryPath(baseStoreDir);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, registryPath);
  try {
    fs.chmodSync(registryPath, 0o600);
  } catch {
    // Some filesystems do not support POSIX permissions.
  }
}

function writeJsonPrivate(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some filesystems do not support POSIX permissions.
  }
}

function resolveAccountMetadataPath(storeDir) {
  return path.join(path.resolve(storeDir), ACCOUNT_METADATA_FILE);
}

export function loadAccountMetadata(storeDir) {
  const metadataPath = resolveAccountMetadataPath(storeDir);
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!metadata || !Array.isArray(metadata.aliases)) {
      throw new Error(`Invalid tgcli account metadata: ${metadataPath}`);
    }
    const normalized = {
      id: normalizeAccountId(metadata.id),
      phoneNumber: normalizePhoneNumber(metadata.phoneNumber),
      aliases: metadata.aliases.map(normalizeAlias),
    };
    if (metadata.telegramUserId !== undefined) {
      const telegramUserId = String(metadata.telegramUserId);
      if (!/^\d+$/.test(telegramUserId)) {
        throw new Error(`Invalid Telegram user ID in account metadata: ${metadataPath}`);
      }
      normalized.telegramUserId = telegramUserId;
    }
    return normalized;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeAuthenticatedPhone(value) {
  const raw = String(value ?? '').trim();
  return normalizePhoneNumber(raw.startsWith('+') ? raw : `+${raw}`);
}

export function assertAccountIdentity(storeDir, user) {
  const metadata = loadAccountMetadata(storeDir);
  if (!metadata) return null;
  if (!user?.id) {
    throw new Error(`Cannot verify identity for account ${metadata.id}: Telegram user ID is missing.`);
  }
  const actualPhone = normalizeAuthenticatedPhone(user.phoneNumber ?? user.phone);
  if (actualPhone !== metadata.phoneNumber) {
    throw new Error(`Account phone mismatch for ${metadata.id}: expected ${metadata.phoneNumber}, authenticated as ${actualPhone}.`);
  }
  const actualUserId = String(user.id);
  if (metadata.telegramUserId && metadata.telegramUserId !== actualUserId) {
    throw new Error(`Account identity mismatch for ${metadata.id}: expected Telegram user ID ${metadata.telegramUserId}, session belongs to ${actualUserId}. No files were modified.`);
  }
  return metadata;
}

export function bindAccountIdentity(storeDir, user) {
  const metadata = assertAccountIdentity(storeDir, user);
  if (!metadata) return null;
  const telegramUserId = String(user.id);
  if (metadata.telegramUserId === telegramUserId) return metadata;
  const bound = { ...metadata, telegramUserId };
  writeJsonPrivate(resolveAccountMetadataPath(storeDir), bound);
  return bound;
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertDirectoryIsNotSymlink(filePath, label) {
  const stat = lstatOrNull(filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe account store: ${label} must be a real directory, not a symlink.`);
  }
  return true;
}

function resolveAccountStorePath(baseStoreDir, accountId) {
  return path.join(path.resolve(baseStoreDir), 'accounts', accountId);
}

function ensureAccountStoreDir(baseStoreDir, accountId) {
  const accountsDir = path.join(path.resolve(baseStoreDir), 'accounts');
  if (!assertDirectoryIsNotSymlink(accountsDir, 'accounts directory')) {
    fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  }
  assertDirectoryIsNotSymlink(accountsDir, 'accounts directory');

  const storeDir = resolveAccountStorePath(baseStoreDir, accountId);
  const existingStore = lstatOrNull(storeDir);
  if (existingStore) {
    if (existingStore.isSymbolicLink() || !existingStore.isDirectory()) {
      throw new Error(`Unsafe account store: account ${accountId} must be a real directory, not a symlink.`);
    }
    throw new Error(`Account store already exists for ${accountId}; refusing to adopt existing files.`);
  }
  fs.mkdirSync(storeDir, { recursive: false, mode: 0o700 });
  assertDirectoryIsNotSymlink(storeDir, `account ${accountId}`);

  const realAccountsDir = fs.realpathSync(accountsDir);
  const realStoreDir = fs.realpathSync(storeDir);
  if (path.dirname(realStoreDir) !== realAccountsDir) {
    throw new Error(`Unsafe account store for ${accountId}: path escapes the accounts directory.`);
  }
  return storeDir;
}

export function isNamedAccountStore(storeDir) {
  const resolved = path.resolve(storeDir);
  const accountId = path.basename(resolved);
  return path.basename(path.dirname(resolved)) === 'accounts'
    && ACCOUNT_ID_PATTERN.test(accountId)
    && accountId !== 'default';
}

export function assertSafeNamedAccountStore(storeDir) {
  if (!isNamedAccountStore(storeDir)) return false;
  const resolved = path.resolve(storeDir);
  const accountsDir = path.dirname(resolved);
  assertDirectoryIsNotSymlink(accountsDir, 'accounts directory');
  assertDirectoryIsNotSymlink(resolved, `account ${path.basename(resolved)}`);
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Unsafe account store: symlinked entry ${entry.name} is not allowed.`);
    }
    if (entry.isFile() && fs.lstatSync(path.join(resolved, entry.name)).nlink > 1) {
      throw new Error(`Unsafe account store: hard-linked entry ${entry.name} is not allowed.`);
    }
  }
  if (path.dirname(fs.realpathSync(resolved)) !== fs.realpathSync(accountsDir)) {
    throw new Error('Unsafe account store: path escapes the accounts directory.');
  }
  return true;
}

export function assertVerifiedAccountMetadata(storeDir, expectedAccount = null) {
  assertSafeNamedAccountStore(storeDir);
  const metadata = loadAccountMetadata(storeDir);
  if (!metadata) {
    throw new Error(`Account metadata is missing from named account store: ${storeDir}`);
  }
  const pathAccountId = path.basename(path.resolve(storeDir));
  const expected = expectedAccount ?? readRegistry(path.dirname(path.dirname(path.resolve(storeDir))))
    .accounts.find((account) => account.id === pathAccountId);
  if (!expected
      || metadata.id !== pathAccountId
      || metadata.id !== expected.id
      || metadata.phoneNumber !== expected.phoneNumber
      || JSON.stringify([...metadata.aliases].sort()) !== JSON.stringify([...(expected.aliases ?? [])].sort())) {
    throw new Error(`Account metadata mismatch for ${pathAccountId}.`);
  }
  return metadata;
}

function withStoreDir(baseStoreDir, account) {
  const storeDir = resolveAccountStorePath(baseStoreDir, account.id);
  assertVerifiedAccountMetadata(storeDir, account);
  return {
    ...account,
    storeDir,
  };
}

export function listAccounts(baseStoreDir) {
  return readRegistry(baseStoreDir).accounts.map((account) => withStoreDir(baseStoreDir, account));
}

function accountSelectors(account) {
  return [account.id, account.phoneNumber, ...(account.aliases ?? [])];
}

function addAccountUnlocked(baseStoreDir, input = {}) {
  const id = normalizeAccountId(input.id);
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  const aliases = [...new Set((input.aliases ?? []).map(normalizeAlias))];
  const registry = readRegistry(baseStoreDir);
  const requestedSelectors = new Set([id, phoneNumber, ...aliases]);

  for (const existing of registry.accounts) {
    for (const selector of accountSelectors(existing)) {
      if (!requestedSelectors.has(selector)) continue;
      if (selector === phoneNumber) {
        throw new Error(`Phone number ${phoneNumber} already belongs to account ${existing.id}.`);
      }
      if (aliases.includes(selector)) {
        throw new Error(`Alias ${selector} already belongs to account ${existing.id}.`);
      }
      throw new Error(`Account selector ${selector} already belongs to account ${existing.id}.`);
    }
  }

  const account = { id, phoneNumber, aliases };
  const storeDir = ensureAccountStoreDir(baseStoreDir, id);
  const result = { ...account, storeDir };
  writeJsonPrivate(resolveAccountMetadataPath(result.storeDir), account);
  registry.accounts.push(account);
  writeRegistry(baseStoreDir, registry);
  return result;
}

export function addAccount(baseStoreDir, input = {}) {
  const release = acquireRegistryLock(baseStoreDir);
  try {
    return addAccountUnlocked(baseStoreDir, input);
  } finally {
    release();
  }
}

function normalizeSelector(value) {
  const raw = String(value ?? 'default').trim();
  if (!raw || raw.toLowerCase() === 'default') return 'default';
  if (raw.startsWith('+')) return normalizePhoneNumber(raw);
  return raw.toLowerCase();
}

export function resolveAccountContext({ baseStoreDir, selector = 'default' } = {}) {
  if (!baseStoreDir) {
    throw new Error('baseStoreDir is required.');
  }
  const resolvedBaseStoreDir = path.resolve(baseStoreDir);
  const normalizedSelector = normalizeSelector(selector);
  if (normalizedSelector === 'default') {
    return {
      id: 'default',
      selector: 'default',
      storeDir: resolvedBaseStoreDir,
      account: null,
    };
  }

  const matches = listAccounts(resolvedBaseStoreDir).filter((account) =>
    accountSelectors(account).includes(normalizedSelector));
  if (matches.length === 0) {
    throw new Error(`Unknown tgcli account "${selector}". Run "tgcli accounts list".`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous tgcli account selector "${selector}".`);
  }
  const account = matches[0];
  return {
    id: account.id,
    selector: normalizedSelector,
    storeDir: account.storeDir,
    account,
  };
}

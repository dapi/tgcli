import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addAccount,
  listAccounts,
  normalizePhoneNumber,
  resolveAccountContext,
} from '../core/accounts.js';

describe('multi-account store isolation', () => {
  let baseStoreDir;

  beforeEach(() => {
    baseStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-accounts-test-'));
  });

  afterEach(() => {
    fs.rmSync(baseStoreDir, { recursive: true, force: true });
  });

  it('keeps the default account in the legacy store', () => {
    expect(resolveAccountContext({ baseStoreDir })).toEqual({
      id: 'default',
      selector: 'default',
      storeDir: baseStoreDir,
      account: null,
    });
  });

  it('creates a named account in its own store without touching legacy session files', () => {
    const legacySession = path.join(baseStoreDir, 'session.json');
    fs.writeFileSync(legacySession, 'primary-session');

    const account = addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+7 (707) 111-22-33',
      aliases: ['office'],
    });

    expect(account.phoneNumber).toBe('+77071112233');
    expect(account.storeDir).toBe(path.join(baseStoreDir, 'accounts', 'work'));
    expect(fs.readFileSync(legacySession, 'utf8')).toBe('primary-session');
    expect(fs.existsSync(path.join(account.storeDir, 'session.json'))).toBe(false);
    expect(listAccounts(baseStoreDir)).toEqual([account]);
  });

  it.each(['work', 'office', '+7 707 111 22 33'])(
    'resolves %s to the same isolated account store',
    (selector) => {
      const account = addAccount(baseStoreDir, {
        id: 'work',
        phoneNumber: '+77071112233',
        aliases: ['office'],
      });

      const context = resolveAccountContext({ baseStoreDir, selector });

      expect(context.id).toBe('work');
      expect(context.storeDir).toBe(account.storeDir);
      expect(context.account).toEqual(account);
    },
  );

  it('rejects duplicate aliases and phone numbers instead of choosing ambiguously', () => {
    addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
      aliases: ['office'],
    });

    expect(() => addAccount(baseStoreDir, {
      id: 'family',
      phoneNumber: '+77071112233',
    })).toThrow(/phone number.*already belongs to.*work/i);

    expect(() => addAccount(baseStoreDir, {
      id: 'family',
      phoneNumber: '+77072223344',
      aliases: ['office'],
    })).toThrow(/alias.*already belongs to.*work/i);
  });

  it('rejects unsafe account ids that could escape the accounts directory', () => {
    expect(() => addAccount(baseStoreDir, {
      id: '../primary',
      phoneNumber: '+77071112233',
    })).toThrow(/account id/i);
  });

  it('rejects a tampered registry entry before resolving its store path', () => {
    fs.writeFileSync(path.join(baseStoreDir, 'accounts.json'), JSON.stringify({
      version: 1,
      accounts: [{
        id: '../../primary',
        phoneNumber: '+77071112233',
        aliases: ['work'],
      }],
    }));

    expect(() => resolveAccountContext({
      baseStoreDir,
      selector: 'work',
    })).toThrow(/invalid.*registry|account id/i);
  });

  it('rejects a symlinked account directory without writing into its target', () => {
    const legacyConfig = path.join(baseStoreDir, 'config.json');
    fs.writeFileSync(legacyConfig, '{"phoneNumber":"+77079990000"}\n');
    const accountsDir = path.join(baseStoreDir, 'accounts');
    fs.mkdirSync(accountsDir);
    fs.symlinkSync(baseStoreDir, path.join(accountsDir, 'work'));

    expect(() => addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    })).toThrow(/symlink|unsafe account store/i);

    expect(fs.readFileSync(legacyConfig, 'utf8')).toBe('{"phoneNumber":"+77079990000"}\n');
    expect(fs.existsSync(path.join(baseStoreDir, 'account.json'))).toBe(false);
    expect(fs.existsSync(path.join(baseStoreDir, 'accounts.json'))).toBe(false);
  });

  it('refuses to adopt a pre-existing directory or session for a new account id', () => {
    const accountDir = path.join(baseStoreDir, 'accounts', 'work');
    fs.mkdirSync(accountDir, { recursive: true });
    const foreignSession = path.join(accountDir, 'session.json');
    fs.writeFileSync(foreignSession, 'foreign-session');

    expect(() => addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    })).toThrow(/already exists|refus.*adopt/i);

    expect(fs.readFileSync(foreignSession, 'utf8')).toBe('foreign-session');
    expect(fs.existsSync(path.join(baseStoreDir, 'accounts.json'))).toBe(false);
  });

  it('rejects symlinked files introduced into an existing named store', () => {
    const account = addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    });
    const legacyConfig = path.join(baseStoreDir, 'config.json');
    fs.writeFileSync(legacyConfig, 'legacy-config');
    fs.symlinkSync(legacyConfig, path.join(account.storeDir, 'config.json'));

    expect(() => resolveAccountContext({
      baseStoreDir,
      selector: 'work',
    })).toThrow(/symlink|unsafe account store/i);
    expect(fs.readFileSync(legacyConfig, 'utf8')).toBe('legacy-config');
  });

  it('rejects hard-linked files introduced into an existing named store', () => {
    const account = addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    });
    const legacyConfig = path.join(baseStoreDir, 'config.json');
    fs.writeFileSync(legacyConfig, 'legacy-config');
    fs.linkSync(legacyConfig, path.join(account.storeDir, 'config.json'));

    expect(() => resolveAccountContext({
      baseStoreDir,
      selector: 'work',
    })).toThrow(/hard.?link|multiple links|unsafe account store/i);
    expect(fs.readFileSync(legacyConfig, 'utf8')).toBe('legacy-config');
  });

  it('rejects account metadata that disagrees with the registry', () => {
    const account = addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    });
    fs.writeFileSync(path.join(account.storeDir, 'account.json'), JSON.stringify({
      id: 'work',
      phoneNumber: '+77079990000',
      aliases: [],
    }));

    expect(() => resolveAccountContext({
      baseStoreDir,
      selector: 'work',
    })).toThrow(/metadata.*mismatch|mismatch.*metadata/i);
  });

  it('normalizes phone selectors without guessing malformed values', () => {
    expect(normalizePhoneNumber('+7 (707) 111-22-33')).toBe('+77071112233');
    expect(() => normalizePhoneNumber('work')).toThrow(/phone number/i);
  });

  it('binds a named store to one Telegram user and rejects crossed sessions', async () => {
    const { assertAccountIdentity, bindAccountIdentity, loadAccountMetadata } = await import('../core/accounts.js');
    const account = addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    });

    expect(bindAccountIdentity(account.storeDir, {
      id: 123456789n,
      phoneNumber: '77071112233',
    })).toMatchObject({ telegramUserId: '123456789' });
    expect(loadAccountMetadata(account.storeDir)).toMatchObject({
      id: 'work',
      phoneNumber: '+77071112233',
      telegramUserId: '123456789',
    });
    expect(() => assertAccountIdentity(account.storeDir, {
      id: 123456789n,
      phoneNumber: '77071112233',
    })).not.toThrow();
    expect(() => assertAccountIdentity(account.storeDir, {
      id: 987654321n,
      phoneNumber: '77071112233',
    })).toThrow(/identity mismatch.*work/i);
  });

  it('refuses first identity binding when the authenticated phone differs', async () => {
    const { bindAccountIdentity } = await import('../core/accounts.js');
    const account = addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    });

    expect(() => bindAccountIdentity(account.storeDir, {
      id: 123456789n,
      phoneNumber: '77079990000',
    })).toThrow(/phone mismatch/i);
  });

  it('fails closed on a stale registry lock instead of racing to delete it', () => {
    const lockPath = path.join(baseStoreDir, '.accounts.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, token: 'stale' }));

    expect(() => addAccount(baseStoreDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    })).toThrow(/stale.*registry lock|registry lock.*dead/i);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(path.join(baseStoreDir, 'accounts.json'))).toBe(false);
  });
});

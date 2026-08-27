import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadConfig,
  loadRcConfig,
  resolveGlobalConfigPath,
  saveConfig,
} from '../core/config.js';

describe('global tgclirc configuration', () => {
  let tempDir;
  let storeDir;
  let rcPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-rc-test-'));
    storeDir = path.join(tempDir, 'store');
    rcPath = path.join(tempDir, '.tgclirc');
    fs.mkdirSync(storeDir, { recursive: true });
    delete process.env.TELEGRAM_PROXY;
  });

  afterEach(() => {
    delete process.env.TELEGRAM_PROXY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves ~/.tgclirc from a supplied home directory', () => {
    expect(resolveGlobalConfigPath('/home/alice')).toBe('/home/alice/.tgclirc');
  });

  it('parses key-value syntax with comments and optional quotes', () => {
    fs.writeFileSync(rcPath, [
      '# Global tgcli defaults',
      'proxy = "socks5://192.168.88.10:1080"',
      '',
    ].join('\n'));

    expect(loadRcConfig(rcPath)).toEqual({
      proxy: 'socks5://192.168.88.10:1080',
    });
  });

  it('uses the global proxy when a profile config has no proxy', () => {
    fs.writeFileSync(rcPath, 'proxy=socks5://192.168.88.10:1080\n');
    fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+123****7890',
    }));

    const loaded = loadConfig(storeDir, { rcPath });

    expect(loaded.config.proxy).toBe('socks5://192.168.88.10:1080');
    expect(loaded.rawConfig).toEqual({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+123****7890',
    });
    expect(loaded.rcPath).toBe(rcPath);
  });

  it('uses the global proxy when an existing profile stores an empty proxy', () => {
    fs.writeFileSync(rcPath, 'proxy=socks5://192.168.88.10:1080\n');
    fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+123****7890',
      proxy: '',
    }));

    expect(loadConfig(storeDir, { rcPath }).config.proxy).toBe('socks5://192.168.88.10:1080');
  });

  it('lets profile config override the global proxy', () => {
    fs.writeFileSync(rcPath, 'proxy=socks5://192.168.88.10:1080\n');
    fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+123****7890',
      proxy: 'socks5://127.0.0.1:9050',
    }));

    expect(loadConfig(storeDir, { rcPath }).config.proxy).toBe('socks5://127.0.0.1:9050');
  });

  it('lets TELEGRAM_PROXY override both profile and global config', () => {
    fs.writeFileSync(rcPath, 'proxy=socks5://192.168.88.10:1080\n');
    fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+123****7890',
      proxy: 'socks5://127.0.0.1:9050',
    }));
    process.env.TELEGRAM_PROXY = 'mtproto://proxy.example.com:443?secret=aabbcc';

    expect(loadConfig(storeDir, { rcPath }).config.proxy).toBe(
      'mtproto://proxy.example.com:443?secret=aabbcc',
    );
  });

  it('uses TELEGRAM_PROXY when both profile config and rc file are absent', () => {
    process.env.TELEGRAM_PROXY = 'socks5://127.0.0.1:9050';

    const loaded = loadConfig(storeDir, { rcPath });

    expect(loaded.config.proxy).toBe('socks5://127.0.0.1:9050');
    expect(loaded.rawConfig).toBeNull();
  });

  it('fails with the line number for malformed rc entries', () => {
    fs.writeFileSync(rcPath, '# comment\nproxy socks5://127.0.0.1:9050\n');

    expect(() => loadRcConfig(rcPath)).toThrow(/\.tgclirc.*line 2/i);
  });

  it('rejects global keys other than proxy', () => {
    fs.writeFileSync(rcPath, 'apiHash=must-not-be-global\n');

    expect(() => loadRcConfig(rcPath)).toThrow(/unsupported key.*apiHash/i);
  });

  it('rejects TELEGRAM_PROXY as an rc key because it is environment-only', () => {
    fs.writeFileSync(rcPath, 'TELEGRAM_PROXY=socks5://127.0.0.1:9050\n');

    expect(() => loadRcConfig(rcPath)).toThrow(/unsupported key.*TELEGRAM_PROXY/i);
  });

  it('does not persist TELEGRAM_PROXY and protects profile config permissions', () => {
    process.env.TELEGRAM_PROXY = 'http://user:password@proxy.example:8080';

    saveConfig(storeDir, {
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+123****7890',
    });

    const configPath = path.join(storeDir, 'config.json');
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted.proxy).toBe('');
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});

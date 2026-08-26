import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_PATH = path.resolve('cli.js');

function runCli(baseStoreDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: path.dirname(CLI_PATH),
    encoding: 'utf8',
    env: {
      ...process.env,
      TELEGRAM_PROXY: '',
      TGCLI_ACCOUNT: '',
      TGCLI_STORE: baseStoreDir,
      ...extraEnv,
    },
  });
}

describe('multi-account CLI', { timeout: 20_000 }, () => {
  let baseStoreDir;

  beforeEach(() => {
    baseStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-accounts-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(baseStoreDir, { recursive: true, force: true });
  });

  it('adds and lists isolated account profiles', () => {
    const add = runCli(baseStoreDir, [
      'accounts', 'add', 'work',
      '--phone', '+7 (707) 111-22-33',
      '--alias', 'office',
      '--json',
    ]);
    expect(add.status, add.stderr).toBe(0);
    expect(JSON.parse(add.stdout)).toMatchObject({
      id: 'work',
      phoneNumber: '+77071112233',
      aliases: ['office'],
    });

    const list = runCli(baseStoreDir, ['accounts', 'list', '--json']);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(1);
  });

  it('seeds a named profile with reusable API settings and its own phone', () => {
    expect(runCli(baseStoreDir, ['config', 'set', 'apiId', '12345']).status).toBe(0);
    expect(runCli(baseStoreDir, ['config', 'set', 'apiHash', 'shared-api-hash']).status).toBe(0);

    const add = runCli(baseStoreDir, [
      'accounts', 'add', 'work', '--phone', '+77071112233',
    ]);
    expect(add.status, add.stderr).toBe(0);

    const namedConfig = JSON.parse(fs.readFileSync(
      path.join(baseStoreDir, 'accounts', 'work', 'config.json'),
      'utf8',
    ));
    expect(namedConfig).toMatchObject({
      apiId: '12345',
      apiHash: 'shared-api-hash',
      phoneNumber: '+77071112233',
    });
    expect(fs.existsSync(path.join(baseStoreDir, 'session.json'))).toBe(false);
  });

  it('rejects registering the default account phone as a named profile', () => {
    expect(runCli(baseStoreDir, [
      'config', 'set', 'phoneNumber', '+77071112233',
    ]).status).toBe(0);

    const add = runCli(baseStoreDir, [
      'accounts', 'add', 'work', '--phone', '+77071112233',
    ]);

    expect(add.status).toBe(1);
    expect(add.stderr).toMatch(/default account.*phone|phone.*default account/i);
    expect(fs.existsSync(path.join(baseStoreDir, 'accounts.json'))).toBe(false);
    expect(fs.existsSync(path.join(baseStoreDir, 'accounts', 'work'))).toBe(false);
  });

  it('routes --account and TGCLI_ACCOUNT commands to the selected store', () => {
    expect(runCli(baseStoreDir, [
      'accounts', 'add', 'work', '--phone', '+77071112233', '--alias', 'office',
    ]).status).toBe(0);

    const setNamed = runCli(baseStoreDir, [
      '--account', 'work', 'config', 'set', 'phoneNumber', '+77071112233',
    ]);
    expect(setNamed.status, setNamed.stderr).toBe(0);

    const setDefault = runCli(baseStoreDir, [
      'config', 'set', 'phoneNumber', '+77079990000',
    ]);
    expect(setDefault.status, setDefault.stderr).toBe(0);

    const getByEnv = runCli(
      baseStoreDir,
      ['config', 'get', 'phoneNumber', '--json'],
      { TGCLI_ACCOUNT: 'office' },
    );
    expect(getByEnv.status, getByEnv.stderr).toBe(0);
    expect(JSON.parse(getByEnv.stdout).value).toBe('+77071112233');

    const namedConfig = JSON.parse(fs.readFileSync(
      path.join(baseStoreDir, 'accounts', 'work', 'config.json'),
      'utf8',
    ));
    const defaultConfig = JSON.parse(fs.readFileSync(path.join(baseStoreDir, 'config.json'), 'utf8'));
    expect(namedConfig.phoneNumber).toBe('+77071112233');
    expect(defaultConfig.phoneNumber).toBe('+77079990000');
    expect(fs.existsSync(path.join(baseStoreDir, 'session.json'))).toBe(false);
  });

  it('fails closed for an unknown account without creating a store', () => {
    const result = runCli(baseStoreDir, [
      '--account', 'missing', 'config', 'list', '--json',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unknown tgcli account/i);
    expect(fs.existsSync(path.join(baseStoreDir, 'accounts', 'missing'))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('installs a launchd service isolated to the named account', () => {
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-service-home-test-'));
    try {
      expect(runCli(baseStoreDir, [
        'accounts', 'add', 'work', '--phone', '+77071112233',
      ]).status).toBe(0);

      const install = runCli(
        baseStoreDir,
        ['--account', 'work', 'service', 'install', '--json'],
        { HOME: isolatedHome },
      );
      expect(install.status, install.stderr).toBe(0);
      const payload = JSON.parse(install.stdout);
      expect(payload.manager).toBe('launchd');
      expect(payload.path).toBe(path.join(
        isolatedHome,
        'Library',
        'LaunchAgents',
        'com.dapi.tgcli.work.plist',
      ));
      const plist = fs.readFileSync(payload.path, 'utf8');
      expect(plist).toContain('<string>com.dapi.tgcli.work</string>');
      expect(plist).toContain(path.join(baseStoreDir, 'accounts', 'work'));
      expect(plist).toContain(path.join(isolatedHome, 'Library', 'Logs', 'tgcli.work.log'));
      expect(plist).not.toContain('<string>com.dapi.tgcli</string>');
    } finally {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

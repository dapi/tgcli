import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ACCOUNTS_MODULE_URL = pathToFileURL(path.resolve('core/accounts.js')).href;

function spawnAdd(baseStoreDir, startFile, index) {
  const script = `
    import fs from 'node:fs';
    import { addAccount } from ${JSON.stringify(ACCOUNTS_MODULE_URL)};
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(${JSON.stringify(startFile)})) Atomics.wait(sleeper, 0, 0, 5);
    addAccount(${JSON.stringify(baseStoreDir)}, {
      id: ${JSON.stringify(`account-${index}`)},
      phoneNumber: ${JSON.stringify(`+1707000${String(index).padStart(4, '0')}`)},
    });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

describe('account registry concurrency', () => {
  it('does not lose successful concurrent account registrations', async () => {
    const baseStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-accounts-race-test-'));
    const startFile = path.join(baseStoreDir, 'start');
    try {
      const children = Array.from({ length: 12 }, (_, index) =>
        spawnAdd(baseStoreDir, startFile, index));
      fs.writeFileSync(startFile, 'go');
      const results = await Promise.all(children);

      expect(results, results.map((result) => result.stderr).join('\n')).toEqual(
        Array.from({ length: 12 }, () => ({ code: 0, stderr: '' })),
      );
      const registry = JSON.parse(fs.readFileSync(path.join(baseStoreDir, 'accounts.json'), 'utf8'));
      expect(registry.accounts).toHaveLength(12);
      expect(new Set(registry.accounts.map((account) => account.id)).size).toBe(12);
    } finally {
      fs.rmSync(baseStoreDir, { recursive: true, force: true });
    }
  }, 20_000);
});

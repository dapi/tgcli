import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import MessageSyncService from '../message-sync-service.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

describe('archive CLI reads', () => {
  let storeDir;
  let writer;

  afterEach(() => {
    if (writer?.db?.open) {
      writer.db.close();
    }
    if (storeDir) {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('reads all message views during an active WAL write without Telegram configuration or job changes', () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-archive-reader-'));
    writer = new MessageSyncService({}, { dbPath: path.join(storeDir, 'messages.db') });
    writer.db.prepare('INSERT INTO channels (channel_id, peer_title) VALUES (?, ?)').run('42', 'Test chat');
    writer.db.prepare('INSERT INTO messages (channel_id, message_id, date, text) VALUES (?, ?, ?, ?)')
      .run('42', 7, 1_700_000_000, 'needle in archive');
    writer.db.prepare('INSERT INTO jobs (channel_id, status) VALUES (?, ?)').run('42', 'in_progress');

    writer.db.exec('BEGIN IMMEDIATE');
    writer.db.prepare('INSERT INTO messages (channel_id, message_id, date, text) VALUES (?, ?, ?, ?)')
      .run('42', 8, 1_700_000_001, 'uncommitted');

    const commands = [
      ['messages', 'list', '--chat', '42', '--source', 'archive'],
      ['messages', 'search', 'needle', '--chat', '42', '--source', 'archive'],
      ['messages', 'show', '--chat', '42', '--id', '7', '--source', 'archive'],
      ['messages', 'context', '--chat', '42', '--id', '7', '--source', 'archive'],
    ];

    for (const args of commands) {
      const result = spawnSync(process.execPath, [cliPath, '--json', ...args], {
        env: { ...process.env, TGCLI_STORE: storeDir },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('needle in archive');
      expect(result.stdout).not.toContain('uncommitted');
    }

    const missing = spawnSync(process.execPath, [cliPath, '--json', 'messages', 'list',
      '--chat', '999', '--source', 'archive'], {
      env: { ...process.env, TGCLI_STORE: storeDir },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(missing.status, missing.stderr).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ source: 'archive', returned: 0 });

    expect(writer.db.prepare('SELECT status FROM jobs WHERE channel_id = ?').get('42').status)
      .toBe('in_progress');
    writer.db.exec('ROLLBACK');
  });
});

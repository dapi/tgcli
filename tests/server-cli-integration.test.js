import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { readStoreLock } from '../store-lock.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverPath = path.join(root, 'mcp-server.js');
const cliPath = path.join(root, 'cli.js');
const loaderPath = fileURLToPath(new URL('./fixtures/mock-telegram-loader.mjs', import.meta.url));
const selectorAvailable = !spawnSync('port-selector', ['--list'], { cwd: root }).error;

let storeDir;
let server;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--json', ...args], {
      cwd: root,
      env: { ...process.env, TGCLI_STORE: storeDir, TELEGRAM_PROXY: 'socks5://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  server = null;
  if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
  storeDir = null;
});

it('serves concurrent CLI requests from a real server process with MCP disabled', async () => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-cli-'));
  fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
    apiId: 12345,
    apiHash: 'fixture-only',
    phoneNumber: '+1234567890',
    mcp: { enabled: false },
  }));
  const marker = path.join(storeDir, 'mock-constructed');
  server = spawn(process.execPath, ['--experimental-loader', loaderPath, serverPath], {
    cwd: root,
    env: { ...process.env, TGCLI_STORE: storeDir, TGCLI_MOCK_CONSTRUCTED_FILE: marker,
      TELEGRAM_PROXY: 'socks5://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${serverOutput}`)), 8000);
    server.stdout.on('data', (chunk) => {
      serverOutput += chunk;
      if (serverOutput.includes('MCP disabled; running sync and local CLI service.')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    server.stderr.on('data', (chunk) => { serverOutput += chunk; });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before ready (${code}): ${serverOutput}`));
    });
  });
  expect(ready).toBe(true);
  expect(fs.readFileSync(marker, 'utf8')).toBe(String(server.pid));

  const [status, channels, groups, archive] = await Promise.all([
    runCli(['sync', 'status']),
    runCli(['channels', 'list']),
    runCli(['groups', 'list']),
    runCli(['channels', 'show', '--chat', '42']),
  ]);
  for (const result of [status, channels, groups, archive]) {
    expect(result.code, result.stderr).toBe(0);
  }
  expect(JSON.parse(status.stdout).queue.processing).toBe(false);
  expect(JSON.parse(channels.stdout)[0].id).toBe(42);
  expect(JSON.parse(groups.stdout)[0].id).toBe(7);
  expect(JSON.parse(archive.stdout).channelId).toBe('42');
  expect(fs.existsSync(path.join(storeDir, 'session.json'))).toBe(false);

  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  expect(readStoreLock(storeDir).exists).toBe(false);
});

it('keeps archive and IPC available when Telegram defers dialog refresh', async () => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-flood-'));
  fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
    apiId: 12345, apiHash: 'fixture-only', phoneNumber: '+1234567890',
    mcp: { enabled: false },
  }));
  server = spawn(process.execPath, ['--experimental-loader', loaderPath, serverPath], {
    cwd: root,
    env: { ...process.env, TGCLI_STORE: storeDir, TGCLI_MOCK_DIALOG_FLOOD_ONCE: '1',
      TELEGRAM_PROXY: 'socks5://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Degraded startup timed out: ${output}`)), 8000);
    server.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('MCP disabled; running sync and local CLI service.')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => { output += chunk; });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before degraded readiness (${code}): ${output}`));
    });
  });
  expect(output).toContain('Dialog refresh deferred after Telegram rate limit');
  expect(JSON.parse(fs.readFileSync(path.join(storeDir, 'service-state.json'), 'utf8'))
    .dialogRefreshDeferred).toBe(true);

  const [status, archive] = await Promise.all([
    runCli(['sync', 'status']),
    runCli(['messages', 'list', '--source', 'archive', '--limit', '1']),
  ]);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout).dialogRefreshDeferred).toBe(true);
  expect(archive.code, archive.stderr).toBe(0);
  expect(readStoreLock(storeDir).exists).toBe(true);

  const resumed = await runCli(['sync', '--once', '--idle-exit', '1s']);
  expect(resumed.code, resumed.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(storeDir, 'service-state.json'), 'utf8'))
    .dialogRefreshDeferred).toBe(false);
  const resumedStatus = await runCli(['sync', 'status']);
  expect(JSON.parse(resumedStatus.stdout).dialogRefreshDeferred).toBe(false);

  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  expect(readStoreLock(storeDir).exists).toBe(false);
});

it.skipIf(!selectorAvailable)('serves two MCP clients and a CLI client from the same owner', async () => {
  const allocation = spawnSync('port-selector', ['--name', 'tgcli-mcp-integration'], {
    cwd: root, encoding: 'utf8',
  });
  if (allocation.status !== 0) throw new Error(`port-selector failed: ${allocation.stderr}`);
  const port = Number(allocation.stdout.trim());
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-mcp-'));
  fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
    apiId: 12345, apiHash: 'fixture-only', phoneNumber: '+1234567890',
    mcp: { enabled: true, host: '127.0.0.1', port },
  }));
  const marker = path.join(storeDir, 'mock-constructed');
  server = spawn(process.execPath, ['--experimental-loader', loaderPath, serverPath], {
    cwd: root,
    env: { ...process.env, TGCLI_STORE: storeDir, TGCLI_MOCK_CONSTRUCTED_FILE: marker,
      TELEGRAM_PROXY: 'socks5://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP startup timed out: ${serverOutput}`)), 8000);
    server.stdout.on('data', (chunk) => {
      serverOutput += chunk;
      if (serverOutput.includes('MCP HTTP server listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => { serverOutput += chunk; });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`MCP server exited before ready (${code}): ${serverOutput}`));
    });
  });
  expect(fs.readFileSync(marker, 'utf8')).toBe(String(server.pid));

  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const clients = [0, 1].map((index) => new Client({ name: `test-client-${index}`, version: '1.0.0' }));
  try {
    await Promise.all(clients.map((client) =>
      client.connect(new StreamableHTTPClientTransport(url))));
    const [channels, search, cli] = await Promise.all([
      clients[0].callTool({ name: 'listChannels', arguments: { limit: 1 } }),
      clients[1].callTool({ name: 'searchChannels', arguments: { keywords: 'Fixture' } }),
      runCli(['channels', 'list']),
    ]);
    expect(channels.content[0].text).toContain('Fixture channel');
    expect(search.content[0].text).toContain('Fixture channel');
    expect(cli.code, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)[0].id).toBe(42);

    const [mcpWrite, cliWrite] = await Promise.all([
      clients[0].callTool({ name: 'setChannelTags',
        arguments: { channelId: 42, tags: ['mcp-tag'], source: 'mcp' } }),
      runCli(['tags', 'set', '--chat', '42', '--tag', 'cli-tag', '--source', 'manual']),
    ]);
    expect(mcpWrite.isError).not.toBe(true);
    expect(cliWrite.code, cliWrite.stderr).toBe(0);
    const tags = await runCli(['tags', 'list', '--chat', '42']);
    expect(tags.code, tags.stderr).toBe(0);
    expect(tags.stdout).toContain('mcp-tag');
    expect(tags.stdout).toContain('cli-tag');
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
  }
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  expect(readStoreLock(storeDir).exists).toBe(false);
});

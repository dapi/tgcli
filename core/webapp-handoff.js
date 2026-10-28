import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export async function startWebAppHandoff(targetUrl, { ttlMs = 90000 } = {}) {
  const target = new URL(targetUrl);
  if (target.protocol !== 'https:') {
    throw new Error('Telegram returned a non-HTTPS Mini App URL.');
  }

  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let used = false;
  const path = `/${randomBytes(24).toString('base64url')}`;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== path || used) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    used = true;
    response.writeHead(302, {
      Location: target.href,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    response.end();
    server.close(() => finish('opened'));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const timer = setTimeout(() => server.close(() => finish('expired')), ttlMs);
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    wait: async () => {
      try { return await done; } finally { clearTimeout(timer); }
    },
    close: () => server.close(),
  };
}

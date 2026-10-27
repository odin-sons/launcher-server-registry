'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFetcher, isBlockedAddress, parseHttpsUrl, mapLimit, FetchError } = require('../tools/lib/net');

const loopback = (host, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]);

async function withServer(handler, run) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://files.example.test:${server.address().port}`, server);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

const local = () => createFetcher({ request: http.request, lookup: loopback, isBlocked: () => false, requireHttps: false });
const fails = (promise, code) => assert.rejects(promise, (error) => error instanceof FetchError && error.code === code, code);

test('downloads, hashes and reports the final URL', async () => {
  await withServer((req, res) => res.end('hello'), async (base) => {
    const result = await local().download(`${base}/a.txt`, { maxBytes: 100 });
    assert.equal(result.size, 5);
    assert.equal(result.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    assert.equal(result.bytes.toString(), 'hello');
    assert.equal((await local().download(`${base}/a.txt`, { maxBytes: 100, keep: false })).bytes, null);
  });
});

test('a declared size over the limit is refused before any body is read', async () => {
  let wrote = false;
  await withServer((req, res) => {
    res.setHeader('content-length', '1000000');
    res.flushHeaders();
    wrote = true;
  }, async (base) => {
    await fails(local().download(`${base}/big`, { maxBytes: 1000 }), 'TOO_LARGE');
    assert.ok(wrote);
  });
});

test('a body without a length stops as soon as it passes the limit', async () => {
  let sent = 0;
  let closed = false;
  await withServer((req, res) => {
    res.on('close', () => { closed = true; });
    const chunk = Buffer.alloc(16 * 1024, 1);
    const pump = () => {
      while (!closed && sent < 512 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      return undefined;
    };
    pump();
  }, async (base) => {
    await fails(local().download(`${base}/endless`, { maxBytes: 64 * 1024 }), 'TOO_LARGE');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(closed, 'the connection was dropped');
    assert.ok(sent < 64 * 1024 * 1024, `the server only got to send ${sent} bytes`);
  });
});

test('follows redirects up to the limit', async () => {
  await withServer((req, res) => {
    if (req.url === '/final') return res.end('done');
    const hop = Number(req.url.slice(1));
    res.statusCode = 302;
    res.setHeader('location', hop >= 3 ? '/final' : `/${hop + 1}`);
    return res.end();
  }, async (base) => {
    assert.equal((await local().download(`${base}/1`, { maxBytes: 10, maxRedirects: 3 })).bytes.toString(), 'done');
    assert.equal((await local().download(`${base}/1`, { maxBytes: 10, maxRedirects: 3 })).redirects, 3);
    await fails(local().download(`${base}/0`, { maxBytes: 10, maxRedirects: 3 }), 'TOO_MANY_REDIRECTS');
  });
});

test('a redirect to a URL with credentials or another scheme is refused', async () => {
  const strict = createFetcher({ request: http.request, lookup: loopback, isBlocked: () => false });
  await fails(strict.download('http://files.example.test/', { maxBytes: 1 }), 'BAD_URL');
  await withServer((req, res) => {
    res.statusCode = 302;
    res.setHeader('location', 'https://user:pass@elsewhere.example.test/x');
    res.end();
  }, async (base) => {
    await fails(local().download(`${base}/`, { maxBytes: 10 }), 'BAD_URL');
  });
});

test('error statuses, encodings and timeouts are reported', async () => {
  await withServer((req, res) => {
    if (req.url === '/gzip') {
      res.setHeader('content-encoding', 'gzip');
      return res.end('x');
    }
    if (req.url === '/hang') return undefined;
    res.statusCode = 404;
    return res.end();
  }, async (base) => {
    await assert.rejects(local().download(`${base}/missing`, { maxBytes: 10, retries: 0 }), (error) => error.code === 'HTTP_STATUS' && error.status === 404);
    await fails(local().download(`${base}/gzip`, { maxBytes: 10 }), 'ENCODED');
    await fails(local().download(`${base}/hang`, { maxBytes: 10, timeoutMs: 300, retries: 0 }), 'TIMEOUT');
  });
});

test('a server error is retried once', async () => {
  let calls = 0;
  await withServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.statusCode = 503;
      return res.end();
    }
    return res.end('ok');
  }, async (base) => {
    assert.equal((await local().download(`${base}/`, { maxBytes: 10, timeoutMs: 10000 })).bytes.toString(), 'ok');
    assert.equal(calls, 2);
  });
});

test('hosts that resolve to private addresses are never contacted', async () => {
  let contacted = false;
  await withServer((req, res) => {
    contacted = true;
    res.end('secret');
  }, async (base) => {
    const resolvesPrivate = createFetcher({
      request: http.request,
      lookup: (host, options, callback) => callback(null, [{ address: '10.0.0.5', family: 4 }]),
      requireHttps: false
    });
    await fails(resolvesPrivate.download(`${base}/`, { maxBytes: 10, retries: 0 }), 'BLOCKED_ADDRESS');
    assert.equal(contacted, false);
  });
});

test('literal private addresses are refused without a lookup', async () => {
  const fetcher = createFetcher({ requireHttps: true });
  for (const host of ['127.0.0.1', '[::1]', '169.254.169.254', '10.1.2.3', '2130706433', '[::ffff:127.0.0.1]', '0.0.0.0']) {
    await fails(fetcher.download(`https://${host}/x`, { maxBytes: 10, retries: 0 }), 'BLOCKED_ADDRESS');
  }
});

test('address classification', () => {
  const blocked = ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', 'not an ip'];
  const open = ['1.1.1.1', '8.8.8.8', '140.82.112.3', '172.15.255.255', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8'];
  for (const address of blocked) assert.equal(isBlockedAddress(address), true, address);
  for (const address of open) assert.equal(isBlockedAddress(address), false, address);
});

test('URL parsing refuses what the registry never accepts', () => {
  assert.equal(parseHttpsUrl('https://files.example.test/a b').pathname, '/a%20b');
  for (const bad of ['http://x.test/', 'ftp://x.test/', 'https://u:p@x.test/', 'https://u@x.test/', 'file:///etc/passwd', 'not a url', '']) {
    assert.throws(() => parseHttpsUrl(bad), (error) => error.code === 'BAD_URL', bad);
  }
});

test('mapLimit never runs more than the limit at once', async () => {
  let running = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    return item * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

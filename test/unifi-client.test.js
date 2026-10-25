import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const client = fileURLToPath(new URL('../clients/aigate-unifi.mjs', import.meta.url));
const token = 'test-proxy-only-token';
const upstreamKey = 'synthetic-upstream-secret-never-on-client';

function run(args = [], config = {}, body = '') {
  return new Promise((resolve, reject) => {
    // An allowlisted environment proves the client needs no admin/login files.
    const child = spawn(process.execPath, [client, ...args], {
      env: { PATH: process.env.PATH, ...config }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

async function fakeAigate(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function unfinishedUpload(t, url) {
  const child = spawn(process.execPath, [client, '--method', 'POST', '--data-stdin'], {
    env: { PATH: process.env.PATH, AIGATE_URL: url, AIGATE_PROXY_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  // Keep producing input without ever ending stdin. The client owns cancellation.
  const producer = setInterval(() => { if (!child.stdin.destroyed) child.stdin.write('still-uploading\n'); }, 10);
  t.after(() => clearInterval(producer));
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Client retained an active upload or response after failure.'));
    }, 2000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(deadline);
      clearInterval(producer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('help is offline and does not require any credentials', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Default: GET \/proxy\/network\/api\/s\/default\/rest\/user/);
  assert.equal(result.stderr, '');
});

test('default read-only call uses proxy auth and never retrieves a key', async (t) => {
  const requests = [];
  const url = await fakeAigate(t, (req, res) => {
    requests.push({ path: req.url, method: req.method, headers: req.headers });
    res.end('{"devices":[]}');
  });
  const result = await run([], { AIGATE_URL: url, AIGATE_PROXY_TOKEN: token });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"devices":[]}');
  assert.equal(result.stderr, '');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/proxy/unifi/proxy/network/api/s/default/rest/user');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(requests[0].headers['x-api-key'], undefined);
  assert.ok(!JSON.stringify(requests).includes(upstreamKey));
});

test('method, raw path/query encoding, content type, and stdin bytes reach Aigate', async (t) => {
  let received;
  const body = Buffer.from('binary\u0000body\r\nwith text');
  const url = await fakeAigate(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
      res.end('accepted');
    });
  });
  const target = '/proxy/network/api/s/default/../default/rest/user%2fid?literal=%2f&x=a+b&x=%2B';
  const result = await run(['--method', 'PATCH', '--data-stdin', '--content-type', 'application/octet-stream', target], {
    AIGATE_URL: url, AIGATE_PROXY_TOKEN: token,
  }, body);
  assert.equal(result.code, 0);
  assert.equal(received.path, `/proxy/unifi${target}`);
  assert.equal(received.method, 'PATCH');
  assert.equal(received.headers['content-type'], 'application/octet-stream');
  assert.equal(received.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(received.body, body);
});

test('missing proxy configuration never falls back to the administrator token', async () => {
  const missingUrl = await run();
  assert.equal(missingUrl.code, 1);
  assert.match(missingUrl.stderr, /Missing AIGATE_URL/);
  const missingToken = await run([], { AIGATE_URL: 'http://127.0.0.1:1', AIGATE_TOKEN: upstreamKey });
  assert.equal(missingToken.code, 1);
  assert.match(missingToken.stderr, /Missing AIGATE_PROXY_TOKEN/);
  assert.ok(!missingToken.stderr.includes(upstreamKey));
});

test('invalid base URLs and raw targets fail before any request and do not echo arguments', async (t) => {
  let count = 0;
  const url = await fakeAigate(t, (_req, res) => { count++; res.end(); });
  for (const base of ['file:///tmp/key', `https://${upstreamKey}@example.com`, `${url}/path`, `${url}/../`, `${url}/?token=${token}`, `${url}/#fragment`, `${url}\\anything`]) {
    const result = await run([], { AIGATE_URL: base, AIGATE_PROXY_TOKEN: token });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid AIGATE_URL/);
    assert.ok(!result.stderr.includes(token) && !result.stderr.includes(upstreamKey));
  }
  for (const target of ['https://example.com/path', '//example.com/path', '/path#fragment', '/path\\x', '/bad%xx', '/bad%', '/bad\nheader', '/a b', 'relative/path']) {
    const result = await run([target], { AIGATE_URL: url, AIGATE_PROXY_TOKEN: token });
    assert.equal(result.code, 1, target);
    assert.match(result.stderr, /Invalid target/);
  }
  assert.equal(count, 0);
});

test('HTTP failures suppress malicious bodies/status text and do not follow redirects', async (t) => {
  let count = 0;
  const url = await fakeAigate(t, (_req, res) => {
    count++;
    res.writeHead(count === 1 ? 401 : 302, `${token} ${upstreamKey}`, {
      Location: '/do-not-follow', 'X-Secret': upstreamKey,
    });
    res.end(`${token}\n${upstreamKey}`);
  });
  for (const status of [401, 302]) {
    const result = await run([], { AIGATE_URL: url, AIGATE_PROXY_TOKEN: token });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
    assert.ok(!result.stderr.includes(token) && !result.stderr.includes(upstreamKey));
  }
  assert.equal(count, 2);
});

test('early HTTP rejection cancels unfinished stdin and a nonterminating response', async (t) => {
  for (const status of [401, 413]) {
    let uploadClosed = false;
    let responseClosed = false;
    let requestComplete;
    const url = await fakeAigate(t, (req, res) => {
      req.on('error', () => {});
      req.resume();
      req.on('close', () => { uploadClosed = true; requestComplete = req.complete; });
      res.writeHead(status, `${token} ${upstreamKey}`);
      res.write(`${token} ${upstreamKey}`);
      // This response would keep an error-body drainer alive indefinitely.
      const endlessResponse = setInterval(() => res.write(`${token} ${upstreamKey}`), 10);
      res.on('close', () => { clearInterval(endlessResponse); responseClosed = true; });
    });
    const result = await unfinishedUpload(t, url);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `aigate-unifi: Aigate request failed with HTTP ${status}. Response body suppressed.\n`);
    assert.ok(uploadClosed, 'upload connection must close before the helper exits');
    assert.ok(responseClosed, 'unfinished error response must be closed');
    assert.equal(requestComplete, false, 'the unfinished upload must be cancelled');
  }
});

test('connection failure cancels an unfinished stdin producer', async (t) => {
  let socketClosed = false;
  const url = await fakeAigate(t, (req) => {
    req.socket.on('close', () => { socketClosed = true; });
    req.socket.destroy();
  });
  const result = await unfinishedUpload(t, url);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'aigate-unifi: Cannot reach Aigate or verify its TLS connection.\n');
  assert.ok(socketClosed);
});

test('network failures are clear and reveal no supplied credentials', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  const result = await run([], { AIGATE_URL: url, AIGATE_PROXY_TOKEN: token });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Cannot reach Aigate or verify its TLS connection/);
  assert.ok(!result.stderr.includes(token));
});

test('body/method/header misuse fails clearly without reflecting input', async () => {
  const config = { AIGATE_URL: 'http://127.0.0.1:1', AIGATE_PROXY_TOKEN: token };
  for (const args of [
    ['--data-stdin'], ['--method', 'CONNECT'], ['--method', 'GET', '--data-stdin'],
    ['--content-type', 'text/plain'], ['--method', 'POST', '--data-stdin', '--content-type', `text/plain\r\nX-Secret: ${upstreamKey}`],
    ['--header', `Authorization: ${upstreamKey}`], ['--method'],
  ]) {
    const result = await run(args, config);
    assert.equal(result.code, 1);
    assert.ok(!result.stderr.includes(token) && !result.stderr.includes(upstreamKey));
    assert.doesNotMatch(result.stderr, /Cannot reach/);
  }
});

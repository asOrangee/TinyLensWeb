import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createAiNetworkProxy, AI_CONNECT_HOSTS } from './ai-network-proxy.mjs';

async function fakeUpstream(t, handler) {
  const connections = new Set(), received = [];
  const server = http.createServer();
  server.on('connection', socket => { connections.add(socket); socket.on('error', () => {}); socket.on('close', () => connections.delete(socket)); });
  server.on('connect', (request, socket, head) => {
    received.push({ target: request.url, authorization: request.headers['proxy-authorization'] });
    if (handler) return handler(request, socket, head);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', data => socket.write(data));
    if (head.length) socket.write(head);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, received, connections };
}
async function proxyFixture(t, upstream) {
  const proxy = await createAiNetworkProxy({ upstreamPort: upstream.port });
  t.after(() => proxy.close()); return proxy;
}
function authorization(proxy) {
  const url = new URL(proxy.proxyUrlForRemote(49000));
  return `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
}
function connectRequest(target, auth, suffix = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`), suffix]);
}
async function exchange(port, wire, expected = Buffer.from('\r\n\r\n'), keepOpen = false) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const data = await new Promise((resolve, reject) => {
    let result = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Local proxy test timed out')); }, 1500);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.on('data', chunk => {
      result = Buffer.concat([result, chunk]);
      if (result.includes(expected)) { clearTimeout(timer); resolve(result); }
    });
    socket.once('end', () => { clearTimeout(timer); resolve(result); });
    socket.once('connect', () => socket.write(wire));
  });
  if (!keepOpen) socket.destroy();
  return { data, socket };
}

test('requires a fresh in-memory Basic credential and loopback endpoints', async t => {
  const upstream = await fakeUpstream(t), first = await proxyFixture(t, upstream), second = await proxyFixture(t, upstream);
  assert.notEqual(authorization(first), authorization(second));
  const url = new URL(first.proxyUrlForRemote(45001));
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '45001'); assert.ok(url.password.length >= 40);
  for (const auth of [undefined, 'Basic d3Jvbmc6d3Jvbmc=', authorization(second)]) {
    const { data } = await exchange(first.port, connectRequest('chatgpt.com:443', auth));
    assert.match(data.toString(), /^HTTP\/1\.1 407 /);
  }
  assert.equal(upstream.received.length, 0);
  assert.throws(() => first.proxyUrlForRemote(0));
  await assert.rejects(createAiNetworkProxy({ upstreamHost: '0.0.0.0' }), /loopback/);
});

test('rejects non-allowlisted authorities, ports, and every non-CONNECT request', async t => {
  const upstream = await fakeUpstream(t), proxy = await proxyFixture(t, upstream), auth = authorization(proxy);
  for (const target of ['example.com:443', 'chatgpt.com.evil.test:443', 'chatgpt.com:80', 'chatgpt.com:0443', 'chatgpt.com.:443', 'user@chatgpt.com:443', '127.0.0.1:443']) {
    const { data } = await exchange(proxy.port, connectRequest(target, auth));
    assert.match(data.toString(), /^HTTP\/1\.1 403 /);
  }
  const { data } = await exchange(proxy.port, Buffer.from(`GET http://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com\r\nProxy-Authorization: ${auth}\r\n\r\n`));
  assert.match(data.toString(), /^HTTP\/1\.1 405 /); assert.equal(upstream.received.length, 0);
});

test('CONNECT passes opaque bytes for each allowed host without forwarding proxy credentials', async t => {
  const upstream = await fakeUpstream(t), proxy = await proxyFixture(t, upstream), auth = authorization(proxy);
  const opaque = Buffer.from([0x16, 0x03, 0x01, 0x00, 0xff, 0x41, 0x00, 0x42]);
  for (const host of AI_CONNECT_HOSTS) {
    const { data } = await exchange(proxy.port, connectRequest(`${host}:443`, auth, opaque), opaque);
    const boundary = data.indexOf('\r\n\r\n');
    assert.match(data.subarray(0, boundary).toString(), /^HTTP\/1\.1 200 /);
    assert.deepEqual(data.subarray(boundary + 4), opaque);
  }
  assert.deepEqual(upstream.received.map(item => item.target), AI_CONNECT_HOSTS.map(host => `${host}:443`));
  assert.ok(upstream.received.every(item => item.authorization === undefined));
});

test('forwards bytes accompanying upstream CONNECT headers and closes all open tunnels', async t => {
  const marker = Buffer.from('opaque-upstream-bytes');
  const upstream = await fakeUpstream(t, (_request, socket) => socket.write(Buffer.concat([Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'), marker])));
  const proxy = await proxyFixture(t, upstream);
  const { data, socket } = await exchange(proxy.port, connectRequest('chatgpt.com:443', authorization(proxy)), marker, true);
  assert.ok(data.includes(marker));
  const closed = once(socket, 'close'); await proxy.close(); await closed;
  await proxy.close(); assert.throws(() => proxy.proxyUrlForRemote(49000), /closed/);
});

test('upstream refusal and abrupt failure return 502 instead of target data or authentication challenges', async t => {
  for (const handler of [(_request, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'), (_request, socket) => socket.destroy()]) {
    const upstream = await fakeUpstream(t, handler), proxy = await proxyFixture(t, upstream);
    const { data } = await exchange(proxy.port, connectRequest('api.openai.com:443', authorization(proxy)));
    assert.match(data.toString(), /^HTTP\/1\.1 502 /);
  }
});

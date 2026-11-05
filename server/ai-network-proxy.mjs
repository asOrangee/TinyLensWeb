import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const AI_CONNECT_HOSTS = Object.freeze([
  'chatgpt.com', 'api.openai.com', 'auth.openai.com', 'chat.openai.com',
]);
const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535;

/** Temporary, authenticated CONNECT tunnel. It never terminates the target TLS connection. */
export async function createAiNetworkProxy({ upstreamHost = '127.0.0.1', upstreamPort = 7897 } = {}) {
  if (upstreamHost !== '127.0.0.1' || !validPort(upstreamPort)) throw new Error('The upstream proxy must be a valid IPv4 loopback endpoint');
  const password = randomBytes(32).toString('base64url');
  const expectedAuthorization = Buffer.from(`Basic ${Buffer.from(`tinylens:${password}`).toString('base64')}`);
  const sockets = new Set(), requests = new Set();
  let closing = false, closePromise;
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };
  function reject(socket, code, reason, extra = '') {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
  }
  function authorized(request) {
    const supplied = request.headers['proxy-authorization'];
    const count = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'proxy-authorization').length;
    if (count !== 1 || typeof supplied !== 'string') return false;
    const value = Buffer.from(supplied);
    return value.length === expectedAuthorization.length && timingSafeEqual(value, expectedAuthorization);
  }
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000 }, (_request, response) => {
    response.writeHead(405, { Allow: 'CONNECT', Connection: 'close', 'Content-Length': '0' }); response.end();
  });
  server.on('connection', track);
  server.on('clientError', (_error, socket) => reject(socket, 400, 'Bad Request'));
  server.on('upgrade', (_request, socket) => reject(socket, 405, 'Method Not Allowed', 'Allow: CONNECT\r\n'));
  server.on('connect', (request, client, clientHead) => {
    if (closing) { client.destroy(); return; }
    if (!authorized(request)) { reject(client, 407, 'Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="TinyLens AI"\r\n'); return; }
    const authority = /^([a-zA-Z0-9.-]+):443$/.exec(request.url || '');
    if (!authority || !AI_CONNECT_HOSTS.includes(authority[1].toLowerCase())) { reject(client, 403, 'Forbidden'); return; }
    const target = `${authority[1].toLowerCase()}:443`;
    let settled = false;
    const upstream = http.request({ host: upstreamHost, port: upstreamPort, method: 'CONNECT', path: target,
      headers: { Host: target }, agent: false });
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    upstream.on('socket', track);
    const timeout = setTimeout(() => upstream.destroy(new Error('Upstream connection timeout')), 10000);
    const cleanup = () => { clearTimeout(timeout); requests.delete(upstream); };
    function fail() {
      if (settled) return;
      settled = true; cleanup(); reject(client, 502, 'Bad Gateway'); upstream.destroy();
    }
    client.once('close', () => { cleanup(); upstream.destroy(); });
    upstream.once('error', fail);
    upstream.once('response', response => { response.destroy(); fail(); });
    upstream.once('connect', (response, remote, upstreamHead) => {
      cleanup();
      if (settled || closing || client.destroyed) { remote.destroy(); return; }
      if (response.statusCode !== 200) { remote.destroy(); fail(); return; }
      settled = true;
      client.once('close', () => remote.destroy());
      remote.once('close', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (upstreamHead.length) client.write(upstreamHead);
      if (clientHead.length) remote.write(clientHead);
      // Only opaque bytes pass through. Incoming CONNECT headers and proxy credentials are not forwarded.
      client.pipe(remote); remote.pipe(client);
    });
    upstream.end();
  });
  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => { server.off('error', rejectListen); resolve(); });
  });
  return {
    port: server.address().port,
    proxyUrlForRemote(remotePort) {
      if (closing) throw new Error('The temporary AI proxy is closed');
      if (!validPort(remotePort)) throw new Error('Invalid remote loopback port');
      return `http://tinylens:${password}@127.0.0.1:${remotePort}`;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise((resolve, rejectClose) => server.close(error => error ? rejectClose(error) : resolve()));
      return closePromise;
    },
  };
}

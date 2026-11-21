import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createAgentServer } from './agent-server.mjs';

const threadId = 'fixture-thread';
const submit = (text, expectedTurnId = null) => ({ clientMessageId: randomUUID(), text, expectedThreadId: threadId, expectedTurnId });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { rpcTimeoutMs = 1000 } = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'tinylens-delivery-test-'));
  const packets = [];
  const runtime = { turn: null, items: [], holdStart: false, receiveStart: undefined };
  let bridge, proc;
  function spawnProcess() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.emitMessage = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.kill = () => { child.killed = true; child.emit('exit', 0); child.stdout.end(); child.stderr.end(); };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const packet = JSON.parse(chunk.toString());
      packets.push(packet); done();
      const respond = result => child.emitMessage({ id: packet.id, result });
      if (packet.method === 'initialize') respond({});
      if (packet.method === 'thread/start' || packet.method === 'thread/resume') respond({
        thread: { id: threadId, status: { type: runtime.turn?.status === 'inProgress' ? 'active' : 'idle' },
          turns: runtime.turn ? [{ ...runtime.turn, items: runtime.items }] : [] },
      });
      if (packet.method === 'turn/start') {
        runtime.receiveStart?.(respond);
        if (!runtime.holdStart) {
          runtime.turn = { id: `turn-${packets.filter(item => item.method === 'turn/start').length}`, status: 'inProgress' };
          respond({ turn: runtime.turn });
        }
      }
      if (packet.method === 'turn/steer') respond({ turnId: runtime.turn.id });
      if (packet.method === 'turn/interrupt') respond({});
    } });
    proc = child;
    return child;
  }
  async function open() {
    bridge = await createAgentServer({ stateDirectory, spawnProcess, rpcTimeoutMs, logger: { error() {} } });
    await bridge.connect();
  }
  await open();
  t.after(async () => { await bridge.close(); await rm(stateDirectory, { recursive: true, force: true }); });
  async function post(endpoint, data) {
    const request = Readable.from([JSON.stringify(data)]);
    Object.assign(request, { method: 'POST', url: `/api/agent/${endpoint}`, headers: { 'content-type': 'application/json' } });
    let status, value;
    await bridge.routeRequest(request, { writeHead(code) { status = code; }, end(body) { value = JSON.parse(body); } });
    return { status, value };
  }
  return {
    packets, post, runtime,
    async restart() { await bridge.close(); await open(); },
    connect: () => bridge.connect(),
    async finish() {
      runtime.turn.status = 'completed';
      proc.emitMessage({ method: 'turn/completed', params: { threadId, turn: runtime.turn } });
      await tick();
    },
  };
}

test('the same HTTP submission survives a lost receipt and bridge restart without a second turn', async t => {
  const f = await fixture(t);
  const message = submit('A simulated initial request');
  // The first HTTP response is deliberately discarded as if the client disconnected.
  assert.equal((await f.post('message', message)).status, 200);
  await f.finish();
  await f.restart();
  const receipt = await f.post('message', message);
  assert.equal(receipt.status, 200);
  assert.deepEqual(receipt.value.messageReceipt, { id: message.clientMessageId, delivery: 'delivered' });
  assert.equal(receipt.value.messages.length, 1);
  assert.equal((await f.post('message', { ...message, text: 'A different payload' })).status, 400);
  assert.deepEqual(f.packets.filter(packet => packet.method === 'turn/start').map(packet => packet.params.clientUserMessageId), [message.clientMessageId]);
});

test('a concurrent duplicate reports pending delivery without sending another RPC', async t => {
  const f = await fixture(t);
  const message = submit('Run the simulation once');
  f.runtime.holdStart = true;
  const received = new Promise(resolve => { f.runtime.receiveStart = resolve; });
  const first = f.post('message', message);
  const respond = await received;
  const duplicate = await f.post('message', message);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.value.messageReceipt, { id: message.clientMessageId, delivery: 'pending' });
  assert.equal(f.packets.filter(packet => packet.method === 'turn/start').length, 1);
  // Complete from the app-server's mock response so the original HTTP request settles.
  f.runtime.turn = { id: 'turn-1', status: 'inProgress' };
  respond({ turn: f.runtime.turn });
  assert.equal((await first).value.messageReceipt.delivery, 'delivered');
});

test('idle sends and stops from an older page are never routed to a new turn', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('message', { text: 'Missing all request scope' })).status, 400);
  assert.equal((await f.post('message', submit('First turn'))).status, 200);
  assert.equal((await f.post('message', submit('From an idle tab'))).status, 400);
  assert.equal((await f.post('message', { ...submit('From another thread', 'turn-1'), expectedThreadId: 'other-thread' })).status, 400);
  assert.equal(f.packets.filter(packet => packet.method === 'turn/steer').length, 0);
  assert.equal((await f.post('message', submit('Intentional steering', 'turn-1'))).status, 200);
  await f.finish();
  assert.equal((await f.post('message', submit('Second turn'))).status, 200);
  assert.equal((await f.post('interrupt', { expectedThreadId: threadId, expectedTurnId: 'turn-1' })).status, 400);
  assert.equal((await f.post('interrupt', {})).status, 400);
  assert.equal((await f.post('interrupt', { expectedThreadId: threadId, expectedTurnId: 'turn-2' })).status, 200);
  assert.deepEqual(f.packets.filter(packet => packet.method === 'turn/interrupt').map(packet => packet.params.turnId), ['turn-2']);
});

test('unknown delivery is retained through a restart and reconciled only by the remote client ID', async t => {
  const f = await fixture(t, { rpcTimeoutMs: 45 });
  const message = submit('Uncertain submission');
  f.runtime.holdStart = true;
  assert.equal((await f.post('message', message)).value.messageReceipt.delivery, 'unknown');
  f.runtime.turn = { id: 'old-remote-turn', status: 'completed' };
  const item = { id: message.clientMessageId, type: 'userMessage', content: [{ type: 'text', text: message.text }] };
  f.runtime.items = [{ ...item, clientId: 'a-different-client-id' }];
  await f.restart();
  assert.equal((await f.post('message', message)).value.messageReceipt.delivery, 'unknown');
  f.runtime.items = [{ ...item, id: 'remote-item-id', clientId: message.clientMessageId }];
  await f.restart();
  assert.equal((await f.post('message', message)).value.messageReceipt.delivery, 'delivered');
  assert.equal(f.packets.filter(packet => packet.method === 'turn/start').length, 1);
});

'use strict';
/**
 * Team over an MQTT broker (src/main/teamMqtt.ts): two installs pair and talk
 * through an in-process broker (aedes) exactly as through ntfy — sealed,
 * post-quantum, the broker seeing only opaque bytes — and a teammate who was
 * offline gets what arrived meanwhile (QoS 1, persistent session).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const loadTs = require('./load-ts.cjs');

const { TeamNode } = loadTs('src/main/teamNode.ts');
const { generateIdentity } = loadTs('src/main/teamCrypto.ts');

async function broker(t, opts = {}) {
  // aedes 1.x is ESM with a named `Aedes` class and an async createBroker().
  const { Aedes } = require('aedes');
  const aedes = await Aedes.createBroker();
  const seen = [];
  aedes.on('publish', (p) => { if (p.topic.startsWith('md-team/')) seen.push(p.payload.toString()); });
  if (opts.password) {
    aedes.authenticate = (_c, user, pass, cb) => cb(null, user === 'office' && String(pass) === opts.password);
  }
  const server = net.createServer(aedes.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { aedes.close(() => server.close(() => r())); }));
  return { url: `mqtt://127.0.0.1:${server.address().port}`, seen };
}

function node(name, b, t, token) {
  const relay = 'mqtts://broker.test:8883';
  let state = { identity: generateIdentity(name), relay, teams: [{ id: `t-${name}`, name, relay, level: 'message', mode: 'strict' }], peers: [], invites: [] };
  const inbox = [];
  const n = new TeamNode({
    load: () => state, save: (s) => { state = s; }, onMessage: (m) => inbox.push(m),
    relayToken: () => token, mqttConnectUrl: () => b.url
  });
  n.start();
  t.after(() => n.stop());
  return { n, inbox, get state() { return state; } };
}

const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

test('pair and talk over MQTT, post-quantum, the broker never sees plaintext', async (t) => {
  const b = await broker(t);
  const alice = node('Alice', b, t);
  const bob = node('Bob', b, t);
  await new Promise((r) => setTimeout(r, 300)); // connected + subscribed
  const joined = await bob.n.join(alice.n.createInvite('t-Alice').code);
  assert.equal(joined.ok, true, joined.error);
  assert.ok(await until(() => alice.state.peers[0]?.pq === 'on' && bob.state.peers[0]?.pq === 'on'), 'paired, post-quantum');
  assert.equal((await alice.n.send('Bob', 'MQTT', 'por el broker publico')).ok, true);
  assert.ok(await until(() => bob.inbox.length === 1));
  assert.equal(bob.inbox[0].body, 'por el broker publico');
  const long = 'x'.repeat(9000);
  assert.equal((await bob.n.send(bob.state.peers[0].id, 'Big', long)).ok, true);
  assert.ok(await until(() => alice.inbox.some((m) => m.body === long)));
  for (const s of b.seen) assert.ok(!/por el broker|MQTT/.test(s), 'the broker saw only sealed bytes');
});

test('a teammate who was offline gets what arrived meanwhile', async (t) => {
  const b = await broker(t);
  const alice = node('Alice', b, t);
  const bob = node('Bob', b, t);
  await new Promise((r) => setTimeout(r, 300));
  await bob.n.join(alice.n.createInvite('t-Alice').code);
  assert.ok(await until(() => alice.state.peers[0]?.pq === 'on' && bob.state.peers[0]?.pq === 'on'));
  bob.n.stop();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await alice.n.send('Bob', 'while away', 'kept by the broker')).ok, true);
  bob.n.start();
  assert.ok(await until(() => bob.inbox.some((m) => m.body === 'kept by the broker')), 'delivered after reconnect');
});

test('a broker that wants credentials gets them from the relay token', async (t) => {
  const b = await broker(t, { password: 's3cret' });
  const alice = node('Alice', b, t, 'office:s3cret');
  const bob = node('Bob', b, t, 'office:s3cret');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await bob.n.join(alice.n.createInvite('t-Alice').code)).ok, true);
  assert.ok(await until(() => alice.state.peers.length === 1));
});

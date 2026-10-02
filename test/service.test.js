'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PaymentAuthService } = require('../src/service');
const { MemoryStore } = require('../src/db/memory');
const {
  randomAddress, randomTxid, makeConfig, trxTransfer, trc20Transfer, FakeChain, CollectEvents, silentLogger,
} = require('./helpers');

let clock = Date.now();
const now = () => clock;

function setup(overrides = {}, store = new MemoryStore({ now })) {
  const chain = new FakeChain();
  const events = new CollectEvents();
  const config = makeConfig(overrides);
  const svc = new PaymentAuthService({ config, store, chain, events, logger: silentLogger, now });
  return { svc, chain, events, store, config, advance: (ms) => { clock += ms; } };
}

test('happy path: confirmed TRX payment -> grant -> AUTHORIZED', async () => {
  const { svc, chain, events, store } = setup();
  const payer = randomAddress();
  const txid = chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, blockNumber: chain.head - 21 }));
  await store.createPayment({ txid, orderId: 'order-1' });

  await svc.tick();
  assert.strictEqual(chain.grants.length, 1);
  assert.strictEqual(chain.grants[0].user, payer.base58);
  assert.deepStrictEqual(events.statuses(), []); // 授权交易尚未固化

  chain.confirmAll();
  await svc.tick();
  assert.deepStrictEqual(events.statuses(), ['AUTHORIZED']);
  const e = events.list[0];
  assert.strictEqual(e.txid, txid);
  assert.strictEqual(e.order_id, 'order-1');
  assert.strictEqual(e.from, payer.base58);
  assert.strictEqual(e.amount, '100000000');
  assert.strictEqual(e.amount_display, '100 TRX');
  assert.strictEqual(e.auth_tx_hash, chain.grants[0].hash);
  assert.strictEqual(e.confirmations, 21);
  assert.strictEqual(e.event_id, `${txid}:AUTHORIZED`);
  assert.strictEqual((await store.getPayment(txid)).result, 'AUTHORIZED');

  await svc.tick();
  assert.strictEqual(chain.grants.length, 1);
  assert.strictEqual(events.list.length, 1);
});

test('not enough confirmations: nothing happens until threshold', async () => {
  const { svc, chain, events, store } = setup();
  const payer = randomAddress();
  const txid = chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, blockNumber: chain.head - 20 }));
  await store.createPayment({ txid });

  await svc.tick();
  assert.strictEqual(chain.grants.length, 0);
  assert.strictEqual((await store.getPayment(txid)).status, 'pending');

  chain.head += 1;
  await svc.tick();
  assert.strictEqual(chain.grants.length, 1);
  void events;
});

test('unsolidified tx stays pending, then TX_NOT_FOUND after TTL', async () => {
  const { svc, events, store, advance, config } = setup();
  const txid = randomTxid();
  await store.createPayment({ txid });
  await svc.tick();
  assert.strictEqual((await store.getPayment(txid)).status, 'pending');
  advance(config.pendingTtlMs + 1);
  await svc.tick();
  assert.deepStrictEqual(events.statuses(), ['TX_NOT_FOUND']);
});

test('rejections emit events and never grant', async () => {
  const { svc, chain, events, store } = setup();
  const payer = randomAddress();
  const low = chain.add(trxTransfer({ from: payer.hex, amount: 1, blockNumber: 1 }));
  const wrong = chain.add(trxTransfer({ from: payer.hex, to: randomAddress().hex, amount: 100_000_000, blockNumber: 1 }));
  const failed = chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, ret: 'OUT_OF_ENERGY', blockNumber: 1 }));
  const fake = chain.add(trc20Transfer({ from: payer.hex, amount: 500_000_000, token: randomAddress().hex, blockNumber: 1 }));
  for (const txid of [low, wrong, failed, fake]) await store.createPayment({ txid });

  await svc.tick();
  assert.strictEqual(chain.grants.length, 0);
  assert.deepStrictEqual(
    events.statuses().sort(),
    ['AMOUNT_TOO_LOW', 'TRANSACTION_FAILED', 'UNSUPPORTED_ASSET', 'WRONG_RECEIVER'],
  );
});

test('same address paying twice -> second is ALREADY_AUTHORIZED', async () => {
  const { svc, chain, events, store } = setup();
  const payer = randomAddress();
  const a = chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, blockNumber: 1 }));
  const b = chain.add(trc20Transfer({ from: payer.hex, amount: 100_000_000, blockNumber: 1 }));
  await store.createPayment({ txid: a });
  await store.createPayment({ txid: b });

  await svc.tick();
  chain.confirmAll();
  await svc.tick();
  assert.strictEqual(chain.grants.length, 1);
  assert.deepStrictEqual(events.statuses().sort(), ['ALREADY_AUTHORIZED', 'AUTHORIZED']);
});

test('two instances processing concurrently grant only once', async () => {
  const store = new MemoryStore({ now });
  const s1 = setup({}, store);
  const s2 = setup({}, store);
  s2.chain = s1.chain;
  s2.svc.chain = s1.chain;
  const payer = randomAddress();
  const txid = s1.chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, blockNumber: 1 }));
  await store.createPayment({ txid });

  await Promise.all([s1.svc.tick(), s2.svc.tick()]);
  assert.strictEqual(s1.chain.grants.length, 1);
});

test('send failure retries with backoff, then succeeds', async () => {
  const { svc, chain, events, store, advance } = setup();
  const payer = randomAddress();
  const txid = chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, blockNumber: 1 }));
  await store.createPayment({ txid });

  chain.sendError = new Error('bandwidth');
  await svc.tick();
  let auth = await store.findAuthorizationByTxId(txid);
  assert.strictEqual(auth.status, 'processing');
  assert.strictEqual(auth.attempts, 1);

  await svc.tick(); // 退避期内不重试
  assert.strictEqual((await store.findAuthorizationByTxId(txid)).attempts, 1);

  chain.sendError = null;
  advance(30_000);
  await svc.tick();
  auth = await store.findAuthorizationByTxId(txid);
  assert.strictEqual(auth.status, 'authorizing');
  assert.strictEqual(auth.attempts, 2);

  chain.confirmAll();
  await svc.tick();
  assert.deepStrictEqual(events.statuses(), ['AUTHORIZED']);
});

test('reverted grant exhausts retries -> AUTHORIZATION_FAILED, address freed', async () => {
  const { svc, chain, events, store, advance } = setup({ maxAuthAttempts: 2 });
  const payer = randomAddress();
  const txid = chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, blockNumber: 1 }));
  await store.createPayment({ txid });

  await svc.tick();
  chain.confirmAll(false);
  await svc.tick(); // attempt 1 reverted -> processing
  advance(30_000);
  await svc.tick(); // attempt 2 sent
  chain.confirmAll(false);
  await svc.tick(); // attempt 2 reverted -> failed
  assert.strictEqual(chain.grants.length, 2);
  assert.deepStrictEqual(events.statuses(), ['AUTHORIZATION_FAILED']);
  assert.strictEqual((await store.findAuthorizationByTxId(txid)).status, 'failed');
  assert.strictEqual(await store.findActiveAuthorizationByAddress(payer.base58), null);
});

test('grant tx that never solidifies is re-sent after timeout', async () => {
  const { svc, chain, events, store, advance, config } = setup();
  const payer = randomAddress();
  const txid = chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, blockNumber: 1 }));
  await store.createPayment({ txid });

  await svc.tick();
  advance(config.authTxTimeoutMs + 1);
  await svc.tick(); // timeout -> processing
  advance(30_000);
  await svc.tick(); // resend
  assert.strictEqual(chain.grants.length, 2);
  chain.grantResults.set(chain.grants[1].hash, { success: true, blockNumber: 1 });
  await svc.tick();
  assert.deepStrictEqual(events.statuses(), ['AUTHORIZED']);
  assert.strictEqual(events.list[0].auth_tx_hash, chain.grants[1].hash);
});

test('crash after claim: stale processing record is reclaimed and completed', async () => {
  const { svc, chain, store, advance, config } = setup();
  const payer = randomAddress();
  const txid = chain.add(trxTransfer({ from: payer.hex, amount: 100_000_000, blockNumber: 1 }));
  await store.createPayment({ txid });
  await store.claimPayment(txid, { claimTimeoutMs: config.claimTimeoutMs }); // 模拟其他实例认领后崩溃

  await svc.tick();
  assert.strictEqual(chain.grants.length, 0);
  advance(config.claimTimeoutMs + 1);
  await svc.tick();
  assert.strictEqual(chain.grants.length, 1);
});

test('node error leaves record pending for retry', async () => {
  const { svc, chain, store } = setup();
  const txid = randomTxid();
  await store.createPayment({ txid });
  chain.getSolidifiedTransaction = async () => { throw new Error('ECONNRESET'); };
  await svc.tick();
  assert.strictEqual((await store.getPayment(txid)).status, 'pending');
});

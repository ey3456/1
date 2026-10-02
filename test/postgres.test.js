'use strict';

// 需要真实 PostgreSQL：TEST_DATABASE_URL=postgres://... node --test test/postgres.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { randomTxid, randomAddress } = require('./helpers');

const url = process.env.TEST_DATABASE_URL;

test('PostgresStore', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
  const { PostgresStore } = require('../src/db/postgres');
  const store = new PostgresStore({ connectionString: url });
  await store.pool.query('DROP TABLE IF EXISTS authorizations, payment_records');
  await store.pool.query(fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8'));
  t.after(() => store.close());

  await t.test('payment claim is exclusive', async () => {
    const txid = randomTxid();
    assert.strictEqual(await store.createPayment({ txid, orderId: 'o1' }), true);
    assert.strictEqual(await store.createPayment({ txid, orderId: 'o1' }), false);
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.claimPayment(txid, { claimTimeoutMs: 60_000 })),
    );
    assert.strictEqual(claims.filter(Boolean).length, 1);
    assert.strictEqual((await store.listPendingPayments({ claimTimeoutMs: 60_000 })).length, 0);
    // 超时后可被重新认领
    assert.ok(await store.claimPayment(txid, { claimTimeoutMs: 0 }));
    await store.finishPayment(txid, 'AMOUNT_TOO_LOW', 'x');
    const p = await store.getPayment(txid);
    assert.strictEqual(p.status, 'done');
    assert.strictEqual(p.result, 'AMOUNT_TOO_LOW');
  });

  await t.test('rejects invalid txid', async () => {
    await assert.rejects(store.createPayment({ txid: 'not-a-txid' }));
  });

  await t.test('authorization uniqueness', async () => {
    const addr = randomAddress().base58;
    const row = (txid) => ({
      txid, fromAddress: addr, asset: 'USDT', amount: 2n ** 200n, blockNumber: 123, confirmations: 21, paidAt: new Date(),
    });
    const a = randomTxid();
    assert.strictEqual(await store.insertAuthorization(row(a)), 'inserted');
    assert.strictEqual(await store.insertAuthorization(row(a)), 'duplicate_txid');
    assert.strictEqual(await store.insertAuthorization(row(randomTxid())), 'duplicate_address');

    const got = await store.findAuthorizationByTxId(a);
    assert.strictEqual(got.amount, 2n ** 200n);
    assert.strictEqual(got.blockNumber, 123);

    // 乐观锁
    assert.strictEqual(await store.updateAuthorization(a, { status: 'processing', attempts: 0 }, { status: 'authorizing', attempts: 1 }), true);
    assert.strictEqual(await store.updateAuthorization(a, { status: 'processing', attempts: 0 }, { status: 'authorizing', attempts: 1 }), false);
    assert.strictEqual((await store.listOpenAuthorizations()).length, 1);

    // failed 不占地址位
    assert.strictEqual(await store.updateAuthorization(a, { status: 'authorizing', attempts: 1 }, { status: 'failed' }), true);
    assert.strictEqual(await store.findActiveAuthorizationByAddress(addr), null);
    assert.strictEqual(await store.insertAuthorization(row(randomTxid())), 'inserted');
  });
});

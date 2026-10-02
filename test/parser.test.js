'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parsePayment, formatAmount } = require('../src/parser');
const { randomAddress, PAY, USDT, makeConfig, trxTransfer, trc20Transfer } = require('./helpers');

const cfg = makeConfig();
const payer = randomAddress();

test('TRX transfer to payment address with enough amount', () => {
  const { tx, info } = trxTransfer({ from: payer.hex, amount: 100_000_000 });
  const r = parsePayment(tx, info, cfg);
  assert.deepStrictEqual(
    { ok: r.ok, asset: r.asset, from: r.from, to: r.to, amount: r.amount },
    { ok: true, asset: 'TRX', from: payer.base58, to: PAY.base58, amount: 100_000_000n },
  );
});

test('TRX transfer without receipt.result is still accepted (contractRet is authoritative)', () => {
  const { tx, info } = trxTransfer({ from: payer.hex, amount: 200_000_000 });
  delete info.receipt;
  assert.strictEqual(parsePayment(tx, info, cfg).ok, true);
});

test('TRX amount too low', () => {
  const { tx, info } = trxTransfer({ from: payer.hex, amount: 99_999_999 });
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'AMOUNT_TOO_LOW');
});

test('TRX wrong receiver', () => {
  const { tx, info } = trxTransfer({ from: payer.hex, to: randomAddress().hex, amount: 100_000_000 });
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'WRONG_RECEIVER');
});

test('failed transaction', () => {
  const { tx, info } = trxTransfer({ from: payer.hex, amount: 100_000_000, ret: 'REVERT' });
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'TRANSACTION_FAILED');
});

test('TRX disabled', () => {
  const { tx, info } = trxTransfer({ from: payer.hex, amount: 100_000_000 });
  assert.strictEqual(parsePayment(tx, info, { ...cfg, acceptTrx: false }).status, 'UNSUPPORTED_ASSET');
});

test('TRC20 USDT transfer', () => {
  const { tx, info } = trc20Transfer({ from: payer.hex, amount: 150_000_000 });
  const r = parsePayment(tx, info, cfg);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.asset, 'USDT');
  assert.strictEqual(r.from, payer.base58);
  assert.strictEqual(r.amount, 150_000_000n);
});

test('TRC20 from a non-whitelisted (fake) token contract is rejected', () => {
  const fake = randomAddress();
  const { tx, info } = trc20Transfer({ from: payer.hex, amount: 150_000_000, token: fake.hex });
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'UNSUPPORTED_ASSET');
});

test('Transfer log emitted by another contract inside a USDT call is ignored', () => {
  const fake = randomAddress();
  const { tx, info } = trc20Transfer({ from: payer.hex, amount: 150_000_000, logToken: fake.hex });
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'PARSE_FAILED');
});

test('TRC20 reverted receipt', () => {
  const { tx, info } = trc20Transfer({ from: payer.hex, amount: 150_000_000, receipt: 'OUT_OF_ENERGY' });
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'TRANSACTION_FAILED');
});

test('TRC20 transfer to someone else', () => {
  const { tx, info } = trc20Transfer({ from: payer.hex, to: randomAddress().hex, amount: 150_000_000 });
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'WRONG_RECEIVER');
});

test('TRC20 amount too low', () => {
  const { tx, info } = trc20Transfer({ from: payer.hex, amount: 1 });
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'AMOUNT_TOO_LOW');
});

test('TRC10 / other contract types are unsupported', () => {
  const { tx, info } = trxTransfer({ from: payer.hex, amount: 100_000_000 });
  tx.raw_data.contract[0].type = 'TransferAssetContract';
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'UNSUPPORTED_ASSET');
});

test('multi-contract transaction is rejected', () => {
  const { tx, info } = trxTransfer({ from: payer.hex, amount: 100_000_000 });
  tx.raw_data.contract.push(tx.raw_data.contract[0]);
  assert.strictEqual(parsePayment(tx, info, cfg).status, 'PARSE_FAILED');
});

test('formatAmount', () => {
  assert.strictEqual(formatAmount(100_000_000n, 6, 'TRX'), '100 TRX');
  assert.strictEqual(formatAmount(12_500_000n, 6, 'USDT'), '12.5 USDT');
  assert.strictEqual(formatAmount(1n, 6, 'TRX'), '0.000001 TRX');
});

void USDT;

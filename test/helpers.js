'use strict';

const crypto = require('crypto');
const { TronWeb } = require('tronweb');
const { TRANSFER_TOPIC } = require('../src/parser');

function randomAddress() {
  const hex = '41' + crypto.randomBytes(20).toString('hex');
  return { hex, base58: TronWeb.address.fromHex(hex) };
}

function randomTxid() {
  return crypto.randomBytes(32).toString('hex');
}

const PAY = randomAddress();
const AUTH = randomAddress();
const USDT = { symbol: 'USDT', ...randomAddress(), decimals: 6, minAmount: 100_000_000n };

function makeConfig(overrides = {}) {
  return {
    paymentAddress: PAY.base58,
    authContract: AUTH.base58,
    permissionLevel: 1,
    authFeeLimitSun: 100_000_000,
    acceptTrx: true,
    minTrxSun: 100_000_000n,
    tokens: [{ symbol: USDT.symbol, address: USDT.base58, decimals: 6, minAmount: USDT.minAmount }],
    confirmationsRequired: 21,
    pollIntervalMs: 15_000,
    pendingTtlMs: 24 * 3600_000,
    claimTimeoutMs: 5 * 60_000,
    authTxTimeoutMs: 3 * 60_000,
    maxAuthAttempts: 3,
    ...overrides,
  };
}

function trxTransfer({ txid = randomTxid(), from, to = PAY.hex, amount, ret = 'SUCCESS', blockNumber = 1000 }) {
  return {
    tx: {
      txID: txid,
      ret: [{ contractRet: ret }],
      raw_data: {
        contract: [{ type: 'TransferContract', parameter: { value: { owner_address: from, to_address: to, amount } } }],
      },
    },
    // TRX 转账回执通常没有 receipt.result
    info: { id: txid, blockNumber, blockTimeStamp: 1790000000000, receipt: { net_usage: 268 } },
  };
}

function pad32(hex) {
  return hex.padStart(64, '0');
}

function trc20Transfer({
  txid = randomTxid(), from, to = PAY.hex, amount, token = USDT.hex, logToken = token,
  receipt = 'SUCCESS', ret = 'SUCCESS', blockNumber = 1000, logs,
}) {
  return {
    tx: {
      txID: txid,
      ret: [{ contractRet: ret }],
      raw_data: {
        contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: from, contract_address: token, data: 'a9059cbb' } } }],
      },
    },
    info: {
      id: txid,
      blockNumber,
      blockTimeStamp: 1790000000000,
      receipt: { result: receipt },
      log: logs || [
        {
          address: logToken.slice(2),
          topics: [TRANSFER_TOPIC, pad32(from.slice(2)), pad32(to.slice(2))],
          data: pad32(BigInt(amount).toString(16)),
        },
      ],
    },
  };
}

class FakeChain {
  constructor() {
    this.head = 2000;
    this.txs = new Map();
    this.grants = [];
    this.grantResults = new Map(); // hash -> {success, blockNumber, reason} | null
    this.sendError = null;
  }
  add(solid) {
    this.txs.set(solid.tx.txID, solid);
    return solid.tx.txID;
  }
  async getSolidBlockNumber() {
    return this.head;
  }
  async getSolidifiedTransaction(txid) {
    return this.txs.get(txid) || null;
  }
  async sendGrant(user) {
    if (this.sendError) throw this.sendError;
    const hash = randomTxid();
    this.grants.push({ user, hash });
    this.grantResults.set(hash, null);
    return hash;
  }
  async getSolidifiedContractResult(hash) {
    return this.grantResults.get(hash) ?? null;
  }
  confirmAll(success = true) {
    for (const [hash, v] of this.grantResults) {
      if (v === null) this.grantResults.set(hash, { success, blockNumber: this.head, reason: success ? undefined : 'REVERT' });
    }
  }
}

class CollectEvents {
  constructor() {
    this.list = [];
  }
  async emit(e) {
    this.list.push(e);
  }
  statuses() {
    return this.list.map((e) => e.status);
  }
}

const silentLogger = { info() {}, error() {} };

module.exports = {
  randomAddress, randomTxid, PAY, AUTH, USDT, makeConfig, trxTransfer, trc20Transfer,
  FakeChain, CollectEvents, silentLogger,
};

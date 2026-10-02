'use strict';

const { TronWeb } = require('tronweb');

const GRANT_ABI = [
  {
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'level', type: 'uint256' },
    ],
    name: 'grantPermission',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

/**
 * TRON 链访问封装。所有"读"操作都走 Solidity Node（walletsolidity/*），
 * 只会看到已被 2/3+ SR 确认的固化数据。
 */
class ChainClient {
  constructor(config, { privateKey } = {}) {
    this.config = config;
    this.tronWeb = new TronWeb({
      fullHost: config.fullHost,
      solidityNode: config.solidityNode,
      headers: config.apiKey ? { 'TRON-PRO-API-KEY': config.apiKey } : undefined,
      privateKey,
    });
    this._contract = null;
  }

  /** 当前固化区块高度 */
  async getSolidBlockNumber() {
    const block = await this.tronWeb.trx.getConfirmedCurrentBlock();
    const n = block?.block_header?.raw_data?.number;
    if (!Number.isInteger(n)) throw new Error('Unable to read solidified block height');
    return n;
  }

  /**
   * 读取固化交易及回执。未固化 / 不存在 / 已被丢弃时返回 null；网络错误向上抛出。
   * 注意 getConfirmedTransaction 本身不含 blockNumber / receipt / log，必须再查 info。
   */
  async getSolidifiedTransaction(txid) {
    let tx;
    try {
      tx = await this.tronWeb.trx.getConfirmedTransaction(txid);
    } catch (e) {
      if (/not found/i.test(String(e?.message || e))) return null;
      throw e;
    }
    const info = await this.tronWeb.trx.getTransactionInfo(txid);
    if (!tx?.txID || !info || !Number.isInteger(info.blockNumber)) return null;
    if (tx.txID !== txid) return null;
    return { tx, info };
  }

  /**
   * 调用鱼塘合约 grantPermission(user, level)，仅广播、不等待。
   * 返回授权交易 txid（注意：shouldPollResponse=true 时 send() 返回的是函数返回值而不是 txid）。
   */
  async sendGrant(userAddress) {
    if (!this._contract) {
      this._contract = this.tronWeb.contract(GRANT_ABI, this.config.authContract);
    }
    const txid = await this._contract
      .grantPermission(userAddress, this.config.permissionLevel)
      .send({ feeLimit: this.config.authFeeLimitSun });
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
      throw new Error(`Unexpected send() result: ${JSON.stringify(txid)}`);
    }
    return txid.toLowerCase();
  }

  /**
   * 查询授权交易是否已固化及其执行结果。
   * @returns {null | {success: boolean, blockNumber: number, reason?: string}}
   */
  async getSolidifiedContractResult(txid) {
    const info = await this.tronWeb.trx.getTransactionInfo(txid);
    if (!info || !Number.isInteger(info.blockNumber)) return null;
    const success = info.receipt?.result === 'SUCCESS' && info.result !== 'FAILED';
    let reason;
    if (!success) {
      reason = info.receipt?.result || 'FAILED';
      if (info.resMessage) {
        try {
          reason += ': ' + Buffer.from(info.resMessage, 'hex').toString('utf8');
        } catch (_) {
          /* ignore */
        }
      }
    }
    return { success, blockNumber: info.blockNumber, reason };
  }
}

module.exports = { ChainClient, GRANT_ABI };

'use strict';

/**
 * 内存实现，语义与 PostgresStore 一致，用于测试和本地调试。
 * 字段统一使用 camelCase：
 *   payment: { txid, orderId, status, result, reason, claimedAt, createdAt, updatedAt }
 *   auth:    { txid, fromAddress, asset, amount, status, attempts, authTxHash, blockNumber,
 *              confirmations, paidAt, errorMessage, sentAt, createdAt, updatedAt }
 */
const ACTIVE = new Set(['processing', 'authorizing', 'authorized']);

class MemoryStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.payments = new Map();
    this.auths = new Map();
  }

  async createPayment({ txid, orderId = null }) {
    if (this.payments.has(txid)) return false;
    const now = new Date(this.now());
    this.payments.set(txid, {
      txid, orderId, status: 'pending', result: null, reason: null,
      claimedAt: null, createdAt: now, updatedAt: now,
    });
    return true;
  }

  async getPayment(txid) {
    const p = this.payments.get(txid);
    return p ? { ...p } : null;
  }

  async listPendingPayments({ limit = 100, claimTimeoutMs }) {
    const cutoff = this.now() - claimTimeoutMs;
    return [...this.payments.values()]
      .filter((p) => isClaimable(p, cutoff))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }

  async claimPayment(txid, { claimTimeoutMs }) {
    const p = this.payments.get(txid);
    if (!p || !isClaimable(p, this.now() - claimTimeoutMs)) return null;
    p.status = 'processing';
    p.claimedAt = new Date(this.now());
    p.updatedAt = new Date(this.now());
    return { ...p };
  }

  async releasePayment(txid) {
    const p = this.payments.get(txid);
    if (p && p.status === 'processing') {
      p.status = 'pending';
      p.claimedAt = null;
      p.updatedAt = new Date(this.now());
    }
  }

  async finishPayment(txid, result, reason = null) {
    const p = this.payments.get(txid);
    if (!p) return;
    Object.assign(p, { status: 'done', result, reason, updatedAt: new Date(this.now()) });
  }

  async findAuthorizationByTxId(txid) {
    const a = this.auths.get(txid);
    return a ? { ...a } : null;
  }

  async findActiveAuthorizationByAddress(address) {
    const a = [...this.auths.values()].find((x) => x.fromAddress === address && ACTIVE.has(x.status));
    return a ? { ...a } : null;
  }

  /** @returns {'inserted'|'duplicate_txid'|'duplicate_address'} */
  async insertAuthorization(row) {
    if (this.auths.has(row.txid)) return 'duplicate_txid';
    if (await this.findActiveAuthorizationByAddress(row.fromAddress)) return 'duplicate_address';
    const now = new Date(this.now());
    this.auths.set(row.txid, {
      status: 'processing', attempts: 0, authTxHash: null, errorMessage: null, sentAt: null,
      blockNumber: null, confirmations: null, paidAt: null, ...row, createdAt: now, updatedAt: now,
    });
    return 'inserted';
  }

  async listOpenAuthorizations({ limit = 100 } = {}) {
    return [...this.auths.values()]
      .filter((a) => a.status === 'processing' || a.status === 'authorizing')
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit)
      .map((a) => ({ ...a }));
  }

  /** 乐观锁更新：仅当 status/attempts 与 expect 一致时才写入 */
  async updateAuthorization(txid, expect, patch) {
    const a = this.auths.get(txid);
    if (!a || a.status !== expect.status || a.attempts !== expect.attempts) return false;
    Object.assign(a, patch, { updatedAt: new Date(this.now()) });
    return true;
  }

  async close() {}
}

function isClaimable(p, cutoff) {
  return p.status === 'pending' || (p.status === 'processing' && p.claimedAt && p.claimedAt.getTime() < cutoff);
}

module.exports = { MemoryStore };

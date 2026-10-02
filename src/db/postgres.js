'use strict';

const { Pool } = require('pg');

const UNIQUE_VIOLATION = '23505';
const AUTH_COLUMNS = {
  status: 'status',
  attempts: 'attempts',
  authTxHash: 'auth_tx_hash',
  blockNumber: 'block_number',
  confirmations: 'confirmations',
  errorMessage: 'error_message',
  sentAt: 'sent_at',
};

class PostgresStore {
  constructor({ connectionString, pool } = {}) {
    this.pool = pool || new Pool({ connectionString });
  }

  async createPayment({ txid, orderId = null }) {
    const r = await this.pool.query(
      `INSERT INTO payment_records (txid, order_id) VALUES ($1, $2) ON CONFLICT (txid) DO NOTHING`,
      [txid, orderId],
    );
    return r.rowCount === 1;
  }

  async getPayment(txid) {
    const r = await this.pool.query(`SELECT * FROM payment_records WHERE txid = $1`, [txid]);
    return r.rows[0] ? mapPayment(r.rows[0]) : null;
  }

  async listPendingPayments({ limit = 100, claimTimeoutMs }) {
    const r = await this.pool.query(
      `SELECT * FROM payment_records
        WHERE status = 'pending'
           OR (status = 'processing' AND claimed_at < NOW() - make_interval(secs => $1::double precision / 1000))
        ORDER BY created_at
        LIMIT $2`,
      [claimTimeoutMs, limit],
    );
    return r.rows.map(mapPayment);
  }

  /** 原子认领：多实例部署时只有一个实例能拿到 */
  async claimPayment(txid, { claimTimeoutMs }) {
    const r = await this.pool.query(
      `UPDATE payment_records
          SET status = 'processing', claimed_at = NOW(), updated_at = NOW()
        WHERE txid = $1
          AND (status = 'pending'
               OR (status = 'processing' AND claimed_at < NOW() - make_interval(secs => $2::double precision / 1000)))
        RETURNING *`,
      [txid, claimTimeoutMs],
    );
    return r.rows[0] ? mapPayment(r.rows[0]) : null;
  }

  async releasePayment(txid) {
    await this.pool.query(
      `UPDATE payment_records SET status = 'pending', claimed_at = NULL, updated_at = NOW()
        WHERE txid = $1 AND status = 'processing'`,
      [txid],
    );
  }

  async finishPayment(txid, result, reason = null) {
    await this.pool.query(
      `UPDATE payment_records SET status = 'done', result = $2, reason = $3, updated_at = NOW() WHERE txid = $1`,
      [txid, result, reason],
    );
  }

  async findAuthorizationByTxId(txid) {
    const r = await this.pool.query(`SELECT * FROM authorizations WHERE txid = $1`, [txid]);
    return r.rows[0] ? mapAuth(r.rows[0]) : null;
  }

  async findActiveAuthorizationByAddress(address) {
    const r = await this.pool.query(
      `SELECT * FROM authorizations
        WHERE from_address = $1 AND status IN ('processing', 'authorizing', 'authorized') LIMIT 1`,
      [address],
    );
    return r.rows[0] ? mapAuth(r.rows[0]) : null;
  }

  /** @returns {'inserted'|'duplicate_txid'|'duplicate_address'} */
  async insertAuthorization(row) {
    try {
      await this.pool.query(
        `INSERT INTO authorizations (txid, from_address, asset, amount, block_number, confirmations, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.txid, row.fromAddress, row.asset, row.amount.toString(), row.blockNumber, row.confirmations, row.paidAt],
      );
      return 'inserted';
    } catch (e) {
      if (e.code !== UNIQUE_VIOLATION) throw e;
      return e.constraint === 'idx_authorizations_from_active' ? 'duplicate_address' : 'duplicate_txid';
    }
  }

  async listOpenAuthorizations({ limit = 100 } = {}) {
    const r = await this.pool.query(
      `SELECT * FROM authorizations WHERE status IN ('processing', 'authorizing') ORDER BY updated_at LIMIT $1`,
      [limit],
    );
    return r.rows.map(mapAuth);
  }

  /** 乐观锁更新：仅当 status/attempts 与 expect 一致时才写入 */
  async updateAuthorization(txid, expect, patch) {
    const sets = [];
    const values = [txid, expect.status, expect.attempts];
    for (const [key, value] of Object.entries(patch)) {
      const col = AUTH_COLUMNS[key];
      if (!col) throw new Error(`Unknown authorization field ${key}`);
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    }
    const r = await this.pool.query(
      `UPDATE authorizations SET ${sets.join(', ')}, updated_at = NOW()
        WHERE txid = $1 AND status = $2 AND attempts = $3`,
      values,
    );
    return r.rowCount === 1;
  }

  async close() {
    await this.pool.end();
  }
}

function mapPayment(r) {
  return {
    txid: r.txid,
    orderId: r.order_id,
    status: r.status,
    result: r.result,
    reason: r.reason,
    claimedAt: r.claimed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapAuth(r) {
  return {
    txid: r.txid,
    fromAddress: r.from_address,
    asset: r.asset,
    amount: BigInt(r.amount),
    status: r.status,
    attempts: r.attempts,
    authTxHash: r.auth_tx_hash,
    blockNumber: r.block_number === null ? null : Number(r.block_number),
    confirmations: r.confirmations,
    paidAt: r.paid_at,
    errorMessage: r.error_message,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = { PostgresStore };

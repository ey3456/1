'use strict';

const { formatAmount } = require('./parser');

const STATUS = Object.freeze({
  AUTHORIZED: 'AUTHORIZED',
  ALREADY_AUTHORIZED: 'ALREADY_AUTHORIZED',
  DUPLICATE_TXID: 'DUPLICATE_TXID',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  AMOUNT_TOO_LOW: 'AMOUNT_TOO_LOW',
  WRONG_RECEIVER: 'WRONG_RECEIVER',
  UNSUPPORTED_ASSET: 'UNSUPPORTED_ASSET',
  PARSE_FAILED: 'PARSE_FAILED',
  TX_NOT_FOUND: 'TX_NOT_FOUND',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
});

/**
 * 构造标准化 JSON 事件。
 * event_id = `${txid}:${status}`，下游应以 event_id 去重（同一 txid 可能先后产生多个不同状态的事件）。
 */
function buildEvent(fields) {
  const {
    txid, orderId, from, to, asset, decimals, amount, status, reason,
    authTxHash, blockNumber, confirmations, confirmedAt,
  } = fields;
  const event = {
    event: 'payment_authorization',
    event_id: `${txid}:${status}`,
    txid,
    order_id: orderId ?? null,
    from: from ?? null,
    to: to ?? null,
    asset: asset ?? null,
    amount: amount === undefined || amount === null ? null : amount.toString(),
    amount_display: asset && amount != null && decimals != null ? formatAmount(amount, decimals, asset) : null,
    status,
    reason: reason ?? null,
    auth_tx_hash: authTxHash ?? null,
    block_number: blockNumber ?? null,
    confirmations: confirmations ?? null,
    confirmed_at: confirmedAt ? new Date(confirmedAt).toISOString() : null,
    processed_at: new Date().toISOString(),
  };
  return event;
}

/**
 * 事件输出：始终写一行 JSON 到 stdout；配置 WEBHOOK_URL 时额外 POST（指数退避重试）。
 */
class EventSink {
  constructor({ webhookUrl, out = process.stdout, fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.webhookUrl = webhookUrl;
    this.out = out;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async emit(event) {
    this.out.write(JSON.stringify(event) + '\n');
    if (!this.webhookUrl) return;
    let delay = 1000;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await this.fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': event.event_id },
          body: JSON.stringify(event),
        });
        if (res.ok) return;
        throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        if (attempt === 5) {
          this.logger.error(`[events] webhook delivery failed for ${event.event_id}: ${e.message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }
}

module.exports = { STATUS, buildEvent, EventSink };

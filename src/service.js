'use strict';

const { parsePayment } = require('./parser');
const { STATUS, buildEvent } = require('./events');

/**
 * 支付监听 + 授权执行服务。
 *
 * 每个 tick：
 *   1. syncPendingPayments：轮询 pending 付款记录 → 查固化交易 → 确认数达标 → 认领 → 校验 → 写授权记录
 *   2. reconcileAuthorizations：发送待发授权 / 确认已广播授权是否固化 / 失败重试
 */
class PaymentAuthService {
  constructor({ config, store, chain, events, logger = console, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.chain = chain;
    this.events = events;
    this.logger = logger;
    this.now = now;
    this._timer = null;
    this._running = false;
  }

  // ───────────────────────── 调度 ─────────────────────────

  start() {
    const loop = async () => {
      await this.tick();
      if (this._timer !== null) this._timer = setTimeout(loop, this.config.pollIntervalMs);
    };
    this._timer = setTimeout(loop, 0);
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  async tick() {
    if (this._running) return; // 防止单实例内重入
    this._running = true;
    try {
      await this.syncPendingPayments();
      await this.reconcileAuthorizations();
    } catch (e) {
      this.logger.error(`[tick] ${e.stack || e.message}`);
    } finally {
      this._running = false;
    }
  }

  // ───────────────────────── 付款处理 ─────────────────────────

  async syncPendingPayments() {
    const pending = await this.store.listPendingPayments({ claimTimeoutMs: this.config.claimTimeoutMs });
    if (pending.length === 0) return;
    const solidHead = await this.chain.getSolidBlockNumber();

    for (const record of pending) {
      try {
        await this.checkPayment(record, solidHead);
      } catch (e) {
        // 网络 / 节点错误：不改变状态，下一轮重试
        this.logger.error(`[payment ${record.txid}] ${e.message}`);
      }
    }
  }

  async checkPayment(record, solidHead) {
    const solid = await this.chain.getSolidifiedTransaction(record.txid);

    if (!solid) {
      const age = this.now() - new Date(record.createdAt).getTime();
      if (age > this.config.pendingTtlMs && (await this.claim(record.txid))) {
        await this.reject(record, STATUS.TX_NOT_FOUND, 'transaction not solidified within TTL');
      }
      return;
    }

    const confirmations = solidHead - solid.info.blockNumber;
    if (confirmations < this.config.confirmationsRequired) return;

    const claimed = await this.claim(record.txid);
    if (!claimed) return; // 已被其他实例认领

    try {
      await this.processConfirmedPayment(claimed, solid, confirmations);
    } catch (e) {
      await this.store.releasePayment(record.txid);
      throw e;
    }
  }

  claim(txid) {
    return this.store.claimPayment(txid, { claimTimeoutMs: this.config.claimTimeoutMs });
  }

  /**
   * 处理一笔已固化且确认数达标、并已被本实例认领的付款。
   */
  async processConfirmedPayment(record, { tx, info }, confirmations) {
    const txid = record.txid;
    const chainCtx = {
      blockNumber: info.blockNumber,
      confirmations,
      confirmedAt: info.blockTimeStamp,
    };

    // 步骤 1：幂等 —— 该 txid 已经生成过授权记录（例如上次处理到一半实例崩溃）
    const existing = await this.store.findAuthorizationByTxId(txid);
    if (existing) {
      await this.store.finishPayment(txid, resultForAuth(existing));
      return;
    }

    // 步骤 2~5：交易结果 / 链上解析 / 收款地址 / 金额（全部基于固化数据）
    const parsed = parsePayment(tx, info, this.config);
    if (!parsed.ok) {
      await this.reject(record, parsed.status, parsed.reason, { ...parsed, ...chainCtx });
      return;
    }

    // 步骤 6：地址是否已有有效授权
    const active = await this.store.findActiveAuthorizationByAddress(parsed.from);
    if (active) {
      await this.reject(record, STATUS.ALREADY_AUTHORIZED, `authorized by ${active.txid}`, { ...parsed, ...chainCtx });
      return;
    }

    // 步骤 7：写授权记录（txid 唯一 + 地址部分唯一索引兜底并发）
    const inserted = await this.store.insertAuthorization({
      txid,
      fromAddress: parsed.from,
      asset: parsed.asset,
      amount: parsed.amount,
      blockNumber: info.blockNumber,
      confirmations,
      paidAt: info.blockTimeStamp ? new Date(info.blockTimeStamp) : null,
    });
    if (inserted === 'duplicate_address') {
      await this.reject(record, STATUS.ALREADY_AUTHORIZED, 'concurrent authorization for address', { ...parsed, ...chainCtx });
      return;
    }
    if (inserted === 'duplicate_txid') {
      await this.reject(record, STATUS.DUPLICATE_TXID, 'txid already processed', { ...parsed, ...chainCtx });
      return;
    }
    await this.store.finishPayment(txid, 'AUTHORIZATION_PENDING');

    // 步骤 8：立即发送授权交易（失败由 reconcile 重试）
    const auth = await this.store.findAuthorizationByTxId(txid);
    await this.sendAuthorization(auth);
  }

  async reject(record, status, reason, ctx = {}) {
    await this.store.finishPayment(record.txid, status, reason);
    await this.events.emit(
      buildEvent({ ...ctx, txid: record.txid, orderId: record.orderId, status, reason }),
    );
  }

  // ───────────────────────── 授权执行 ─────────────────────────

  /**
   * 发送授权交易。先用乐观锁把记录从 processing 切到 authorizing（attempts+1），
   * 保证多实例下同一次尝试只有一个实例广播。
   */
  async sendAuthorization(auth) {
    const attempt = auth.attempts + 1;
    const claimed = await this.store.updateAuthorization(
      auth.txid,
      { status: 'processing', attempts: auth.attempts },
      { status: 'authorizing', attempts: attempt, authTxHash: null, sentAt: new Date(this.now()), errorMessage: null },
    );
    if (!claimed) return;
    const current = { ...auth, status: 'authorizing', attempts: attempt };

    let hash;
    try {
      hash = await this.chain.sendGrant(auth.fromAddress);
    } catch (e) {
      await this.handleAuthFailure(current, `send failed: ${e.message}`);
      return;
    }
    await this.store.updateAuthorization(auth.txid, { status: 'authorizing', attempts: attempt }, { authTxHash: hash });
    this.logger.info?.(`[auth ${auth.txid}] grant sent for ${auth.fromAddress}: ${hash} (attempt ${attempt})`);
  }

  async reconcileAuthorizations() {
    const open = await this.store.listOpenAuthorizations();
    for (const auth of open) {
      try {
        if (auth.status === 'processing') {
          // 新插入的记录由 processConfirmedPayment 立即发送；这里处理重试与崩溃遗留，留出退避时间
          if (this.now() - new Date(auth.updatedAt).getTime() >= this.retryDelayMs(auth)) {
            await this.sendAuthorization(auth);
          }
        } else if (auth.status === 'authorizing') {
          await this.checkAuthorization(auth);
        }
      } catch (e) {
        this.logger.error(`[auth ${auth.txid}] ${e.message}`);
      }
    }
  }

  retryDelayMs(auth) {
    return auth.attempts === 0 ? 0 : Math.min(30_000 * 2 ** (auth.attempts - 1), 10 * 60_000);
  }

  async checkAuthorization(auth) {
    const sentAge = this.now() - new Date(auth.sentAt).getTime();

    if (!auth.authTxHash) {
      // 已切到 authorizing 但没记下 hash：实例在广播前后崩溃
      if (sentAge > this.config.authTxTimeoutMs) await this.handleAuthFailure(auth, 'send interrupted');
      return;
    }

    const result = await this.chain.getSolidifiedContractResult(auth.authTxHash);
    if (!result) {
      if (sentAge > this.config.authTxTimeoutMs) {
        await this.handleAuthFailure(auth, `auth tx ${auth.authTxHash} not solidified in time`);
      }
      return;
    }
    if (!result.success) {
      await this.handleAuthFailure(auth, `auth tx ${auth.authTxHash} reverted: ${result.reason}`);
      return;
    }

    const ok = await this.store.updateAuthorization(
      auth.txid,
      { status: 'authorizing', attempts: auth.attempts },
      { status: 'authorized' },
    );
    if (!ok) return;
    await this.store.finishPayment(auth.txid, STATUS.AUTHORIZED);
    await this.emitForAuth(auth, STATUS.AUTHORIZED, null);
  }

  /** 失败：未达最大次数则回到 processing 等待重试，否则标记 failed 并输出事件 */
  async handleAuthFailure(auth, message) {
    const exhausted = auth.attempts >= this.config.maxAuthAttempts;
    const ok = await this.store.updateAuthorization(
      auth.txid,
      { status: auth.status, attempts: auth.attempts },
      { status: exhausted ? 'failed' : 'processing', errorMessage: message },
    );
    this.logger.error(`[auth ${auth.txid}] attempt ${auth.attempts} failed: ${message}`);
    if (!ok || !exhausted) return;
    await this.store.finishPayment(auth.txid, STATUS.AUTHORIZATION_FAILED, message);
    await this.emitForAuth(auth, STATUS.AUTHORIZATION_FAILED, message);
  }

  async emitForAuth(auth, status, reason) {
    const payment = await this.store.getPayment(auth.txid);
    const token = this.config.tokens.find((t) => t.symbol === auth.asset);
    await this.events.emit(
      buildEvent({
        txid: auth.txid,
        orderId: payment?.orderId,
        from: auth.fromAddress,
        to: this.config.paymentAddress,
        asset: auth.asset,
        decimals: auth.asset === 'TRX' ? 6 : token?.decimals,
        amount: auth.amount,
        status,
        reason,
        authTxHash: status === STATUS.AUTHORIZED ? auth.authTxHash : null,
        blockNumber: auth.blockNumber,
        confirmations: auth.confirmations,
        confirmedAt: auth.paidAt,
      }),
    );
  }
}

function resultForAuth(auth) {
  if (auth.status === 'authorized') return STATUS.AUTHORIZED;
  if (auth.status === 'failed') return STATUS.AUTHORIZATION_FAILED;
  return 'AUTHORIZATION_PENDING';
}

module.exports = { PaymentAuthService };

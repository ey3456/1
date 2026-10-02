'use strict';

const fs = require('fs');
const { TronWeb } = require('tronweb');

/**
 * 从环境变量加载配置。所有金额均为链上最小单位（TRX: sun；TRC20: 代币最小单位）。
 *
 * TOKENS_JSON 示例（USDT-TRC20，最低 100 USDT）：
 *   [{"symbol":"USDT","address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","decimals":6,"minAmount":"100000000"}]
 */
function loadConfig(env = process.env) {
  const tokens = env.TOKENS_JSON ? JSON.parse(env.TOKENS_JSON) : [];

  const config = {
    fullHost: env.TRON_FULL_HOST || 'https://api.trongrid.io',
    solidityNode: env.TRON_SOLIDITY_NODE || env.TRON_FULL_HOST || 'https://api.trongrid.io',
    apiKey: env.TRONGRID_API_KEY || undefined,

    paymentAddress: required(env, 'PAYMENT_ADDRESS'),
    authContract: required(env, 'AUTH_CONTRACT'),
    permissionLevel: Number(env.PERMISSION_LEVEL || 1),
    authFeeLimitSun: Number(env.AUTH_FEE_LIMIT_SUN || 100_000_000),

    // 是否接受 TRX 原生转账，以及 TRX 最低金额（默认 100 TRX）
    acceptTrx: env.ACCEPT_TRX !== 'false',
    minTrxSun: BigInt(env.MIN_TRX_SUN || 100_000_000),
    tokens: tokens.map((t) => ({
      symbol: String(t.symbol),
      address: String(t.address),
      decimals: Number(t.decimals),
      minAmount: BigInt(t.minAmount),
    })),

    confirmationsRequired: Number(env.CONFIRMATIONS_REQUIRED || 21),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 15_000),
    // 超过该时长仍查不到固化交易的 pending 记录判定为 TX_NOT_FOUND
    pendingTtlMs: Number(env.PENDING_TTL_MS || 24 * 3600_000),
    // 实例崩溃后，processing 状态的付款记录在此时长后可被其他实例重新认领
    claimTimeoutMs: Number(env.CLAIM_TIMEOUT_MS || 5 * 60_000),
    // 授权交易广播后超过该时长仍未固化（TRON 交易默认 60s 过期），视为丢失并重发
    authTxTimeoutMs: Number(env.AUTH_TX_TIMEOUT_MS || 3 * 60_000),
    maxAuthAttempts: Number(env.MAX_AUTH_ATTEMPTS || 3),

    databaseUrl: env.DATABASE_URL,
    webhookUrl: env.WEBHOOK_URL || undefined,
    // 授权钱包私钥文件路径（由 KMS / Secret Manager 挂载），不接受明文环境变量
    authPrivateKeyFile: env.AUTH_PRIVATE_KEY_FILE,
  };

  for (const [name, addr] of [
    ['PAYMENT_ADDRESS', config.paymentAddress],
    ['AUTH_CONTRACT', config.authContract],
    ...config.tokens.map((t) => [`token ${t.symbol}`, t.address]),
  ]) {
    if (!/^T/.test(addr) || !TronWeb.isAddress(addr)) throw new Error(`${name} must be a base58 TRON address`);
  }
  if (config.confirmationsRequired < 19) {
    throw new Error('CONFIRMATIONS_REQUIRED must be >= 19');
  }
  if (!config.acceptTrx && config.tokens.length === 0) {
    throw new Error('No accepted asset: enable ACCEPT_TRX or configure TOKENS_JSON');
  }
  return config;
}

function required(env, name) {
  const v = env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function readPrivateKey(path) {
  if (!path) throw new Error('AUTH_PRIVATE_KEY_FILE is required to send authorizations');
  return fs.readFileSync(path, 'utf8').trim();
}

module.exports = { loadConfig, readPrivateKey };

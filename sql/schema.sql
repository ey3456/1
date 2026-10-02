-- TRX 支付自动授权鱼塘权限：数据库结构（PostgreSQL）

-- 付款记录：由前端在用户扫码/手动转账并提交 txid 时创建（status = 'pending'）。
-- 监听服务只读取 txid，from/to/amount 一律以链上固化数据为准。
CREATE TABLE IF NOT EXISTS payment_records (
  txid          VARCHAR(64) PRIMARY KEY,
  order_id      VARCHAR(128),
  -- pending -> processing -> done
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',
  -- 处理结论，对应事件 status（AUTHORIZED 以外的终态，或 AUTHORIZATION_PENDING）
  result        VARCHAR(32),
  reason        TEXT,
  claimed_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_records_txid_hex CHECK (txid ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_payment_records_pending
  ON payment_records (created_at) WHERE status IN ('pending', 'processing');

-- 授权记录
CREATE TABLE IF NOT EXISTS authorizations (
  id             BIGSERIAL PRIMARY KEY,
  txid           VARCHAR(64) NOT NULL UNIQUE,  -- 同一 txid 只允许一条
  from_address   VARCHAR(34) NOT NULL,         -- base58 地址（T 开头 34 位）
  asset          VARCHAR(16) NOT NULL,
  amount         NUMERIC(78, 0) NOT NULL,      -- 最小单位（sun / token 最小单位），uint256 安全
  -- processing（待发送授权）-> authorizing（授权交易已广播，等待固化）-> authorized
  --                                                                  \-> failed（重试耗尽）
  status         VARCHAR(16) NOT NULL DEFAULT 'processing',
  attempts       INTEGER NOT NULL DEFAULT 0,
  auth_tx_hash   VARCHAR(64),
  block_number   BIGINT,                       -- 付款交易所在区块
  paid_at        TIMESTAMPTZ,                  -- 付款交易区块时间
  confirmations  INTEGER,
  error_message  TEXT,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 同一地址同时只允许一条有效授权（failed 的不占位，允许之后重新付款授权）
CREATE UNIQUE INDEX IF NOT EXISTS idx_authorizations_from_active
  ON authorizations (from_address)
  WHERE status IN ('processing', 'authorizing', 'authorized');

CREATE INDEX IF NOT EXISTS idx_authorizations_open
  ON authorizations (updated_at) WHERE status IN ('processing', 'authorizing');

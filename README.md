# TRX 链支付自动授权鱼塘权限系统

付款方向收款地址转账（扫码或手动，TRX 或白名单 TRC20），服务只依据 **Solidity Node 上已固化的交易数据** 判断是否到账，确认数达标后调用鱼塘合约 `grantPermission(user, level)` 授权，并输出标准化 JSON 事件。

```
[前端] POST /payments {txid, orderId}         ──> payment_records (pending)
                                                    │  每 15s 轮询
[链上监听] walletsolidity/gettransactionbyid ──> 固化交易 + 回执
           walletsolidity/getnowblock         ──> 确认数 = 固化高度 − 交易区块 ≥ 21
                                                    │  原子认领（多实例安全）
[校验] 交易结果 → 资产白名单 → 收款地址 → 金额 → 地址是否已授权
                                                    │
[授权] authorizations(processing) ─广播 grantPermission─> authorizing ─授权交易固化─> authorized
                                     失败/回滚/超时 → 退避重试，耗尽后 failed
                                                    │
[事件] stdout 一行 JSON（+ 可选 Webhook）
```

## 运行

```bash
npm install
psql "$DATABASE_URL" -f sql/schema.sql
cp .env.example .env   # 填写收款地址、合约地址等，用你的方式注入环境变量
npm start
npm test               # 单元测试（内存存储 + 模拟链）
TEST_DATABASE_URL=postgres://... npm test   # 额外运行 PostgreSQL 集成测试
```

stdout 只输出 JSON 事件（每行一个），日志都写到 stderr，可直接 `npm start | your-consumer`。

### 前端接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/payments` | `{"txid":"<64位hex>","orderId":"可选"}`，只登记 txid，**不接受** from/to/amount |
| GET | `/payments/:txid` | 查询处理状态（`status`: pending/processing/done，`result`: 事件状态） |
| GET | `/healthz` | 健康检查 |

## 代码结构

| 文件 | 职责 |
|---|---|
| `src/chain.js` | TronWeb 封装：固化交易/回执/固化高度读取，授权交易广播与结果查询 |
| `src/parser.js` | 纯函数：从固化交易解析 from/to/amount 并做全部校验 |
| `src/service.js` | 轮询、确认数判断、认领、处理流程、授权发送/确认/重试 |
| `src/events.js` | 事件结构与状态枚举，stdout + Webhook 输出 |
| `src/db/postgres.js` / `src/db/memory.js` | 存储层（语义一致，内存版用于测试） |
| `src/http.js` | 前端登记 txid 的 HTTP 接口 |
| `sql/schema.sql` | 表结构与唯一约束 |

## JSON 事件

```json
{
  "event": "payment_authorization",
  "event_id": "a1b2…:AUTHORIZED",
  "txid": "a1b2…",
  "order_id": "order-1",
  "from": "T付款地址",
  "to": "T收款地址",
  "asset": "TRX",
  "amount": "100000000",
  "amount_display": "100 TRX",
  "status": "AUTHORIZED",
  "reason": null,
  "auth_tx_hash": "f6e5…",
  "block_number": 65432100,
  "confirmations": 21,
  "confirmed_at": "2026-10-02T12:00:00.000Z",
  "processed_at": "2026-10-02T12:01:30.000Z"
}
```

| status | 含义 |
|---|---|
| AUTHORIZED | 授权交易已固化且执行成功 |
| ALREADY_AUTHORIZED | 该地址已有有效授权，跳过 |
| DUPLICATE_TXID | 该 txid 已处理过 |
| TRANSACTION_FAILED | 付款交易执行失败（contractRet / receipt 非 SUCCESS） |
| AMOUNT_TOO_LOW | 金额不足 |
| WRONG_RECEIVER | 收款地址不符 |
| UNSUPPORTED_ASSET | 非 TRX、非白名单代币合约、或不支持的合约类型 |
| PARSE_FAILED | 链上数据无法解析（多合约交易、无有效 Transfer 事件等） |
| TX_NOT_FOUND | 登记后超过 `PENDING_TTL_MS` 仍未查到固化交易 |
| AUTHORIZATION_FAILED | 授权交易重试 `MAX_AUTH_ATTEMPTS` 次仍失败（地址释放，可重新付款或人工处理） |

`amount` 为字符串（TRC20 金额是 uint256，超出 JS 安全整数）。**下游请以 `event_id` 去重**，而不是 `txid`：同一个 txid 不会产生两个相同状态的事件，但理论上可能产生不同状态的事件。Webhook 请求头带 `idempotency-key: <event_id>`。

## 相对原设计的修正

实现时对照 TronWeb 6 源码与主网真实交易验证过，原设计中以下几处会导致错误授权、漏授权或卡死，已修正：

1. **TRC20 未校验代币合约地址（严重）**。原 `extractFrom` 只看 Transfer 事件的 topic，任何人都能部署一个假代币、向收款地址"转账" 1 亿枚并触发授权。现在只接受 `TOKENS_JSON` 白名单内的合约，且只认该合约自身发出的 Transfer 日志。
2. **TRX 转账会被全部拒绝**。`getConfirmedTransaction` 返回的交易里没有 `receipt` / `log` / `blockNumber`，这些在 `gettransactioninfobyid` 里；而 TRX 原生转账的回执通常也没有 `receipt.result`。按原代码每笔 TRX 付款都会被判为 `TRANSACTION_FAILED`。现改为：交易成功以 `tx.ret[0].contractRet === 'SUCCESS'` 为准，TRC20 额外要求 `receipt.result === 'SUCCESS'`；区块号与日志从固化回执（`getTransactionInfo` → `walletsolidity/gettransactioninfobyid`）读取。
3. **确认数用的是最新区块而非固化区块**。`getCurrentBlock` 走 FullNode。现用 `getConfirmedCurrentBlock`（`walletsolidity/getnowblock`）。
4. **`shouldPollResponse: true` 时 `send()` 返回的不是 txid**，而是合约函数的返回值（`grantPermission` 无返回值），`auth_tx_hash` 会是空的。现在只广播并拿 txid，再单独确认。
5. **授权交易未确认就标记 authorized**（原 4.2）。现在先进入 `authorizing`，确认授权交易已固化且 `SUCCESS` 后才置为 `authorized` 并发出 `AUTHORIZED`；回滚、超时未上链（TRON 交易默认 60s 过期）会自动重试。
6. **崩溃遗留**。原流程在写入 `processing` 授权记录后若进程退出，该记录永远停在 processing，且部分唯一索引会让该地址永远无法再授权。现在：付款记录认领超过 `CLAIM_TIMEOUT_MS` 可被重新认领；授权记录由 reconcile 循环补发，发送前以 `status + attempts` 乐观锁确保多实例不会重复广播同一次尝试。
7. **金额单位**。原设计用 `MIN_AMOUNT_SUN` 同时比较 TRX 和 TRC20（USDT 6 位小数与 sun 恰好同精度，但其他代币不是）。现每种资产单独配置最低金额，并用 BigInt 比较。
8. **付款记录状态从未更新**，pending 记录会被无限轮询。现处理完即置为 `done` 并写入结果；从未上链的 txid 在 TTL 后以 `TX_NOT_FOUND` 结束。
9. **其他**：只接受单合约交易；多个 Transfer 汇入收款地址时金额求和且要求同一发送方；`DUPLICATE_TXID` 仅在写入授权记录发生 txid 冲突时发出（正常流程中付款记录按 txid 唯一，重复登记会被直接忽略）；地址统一规范为 base58 后比较。

关于确认数：TRON 的固化区块本身已不可逆，`walletsolidity` 接口只会返回固化数据，额外等待 19~21 个确认是冗余保护。原文"安全性要求极高设为 19"写反了，数字越大越保守；配置下限为 19，默认 21。

## 已知取舍

- `grantPermission(user, 1)` 需是幂等的（重复授予同一等级无副作用）。在"已广播但未记录 hash 即崩溃"或"授权交易超时后又上链"的极端情况下可能会广播两次授权。
- Webhook 为尽力投递（5 次指数退避），失败只记日志；stdout 事件流始终完整。需要强保证时可在此基础上加 outbox 表。
- 私钥只从文件读取（`AUTH_PRIVATE_KEY_FILE`，由 KMS / Secret Manager 挂载），不支持明文环境变量。如需 HSM 远程签名，替换 `ChainClient.sendGrant` 中的签名环节即可。
- 授权钱包需保有足够 TRX/能量支付 `feeLimit`，否则授权会以 `OUT_OF_ENERGY` 回滚并进入重试。

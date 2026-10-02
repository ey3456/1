'use strict';

const { TronWeb } = require('tronweb');

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function hexToBase58(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.toLowerCase().replace(/^0x/, '');
  if (h.length === 40) h = '41' + h;
  if (!/^41[0-9a-f]{40}$/.test(h)) return null;
  return TronWeb.address.fromHex(h);
}

function topicToBase58(topic) {
  if (typeof topic !== 'string' || topic.length < 40) return null;
  return hexToBase58(topic.slice(-40));
}

function strip0x(s) {
  return typeof s === 'string' ? s.toLowerCase().replace(/^0x/, '') : '';
}

/**
 * 从固化交易（walletsolidity/gettransactionbyid）及其回执（walletsolidity/gettransactioninfobyid）
 * 中解析出一笔付给收款地址的转账。只读链上数据，不使用前端提交的任何字段。
 *
 * @param {object} tx      固化交易
 * @param {object} txInfo  固化交易回执
 * @param {object} opts    { paymentAddress, acceptTrx, minTrxSun, tokens: [{symbol,address,decimals,minAmount}] }
 * @returns {{ok:true, asset, decimals, minAmount, from, to, amount: bigint} | {ok:false, status, reason, from?, to?, amount?, asset?}}
 */
function parsePayment(tx, txInfo, opts) {
  const contracts = tx?.raw_data?.contract;
  if (!Array.isArray(contracts) || contracts.length !== 1) {
    return fail('PARSE_FAILED', 'transaction must contain exactly one contract');
  }
  const contract = contracts[0];
  const value = contract?.parameter?.value || {};

  // 交易执行结果：TRX 转账的回执里没有 receipt.result，只能看 tx.ret[0].contractRet
  const contractRet = tx.ret?.[0]?.contractRet;
  if (contractRet !== 'SUCCESS') {
    return fail('TRANSACTION_FAILED', `contractRet=${contractRet || 'UNKNOWN'}`);
  }

  if (contract.type === 'TransferContract') {
    if (!opts.acceptTrx) return fail('UNSUPPORTED_ASSET', 'TRX payments are disabled');
    const from = hexToBase58(value.owner_address);
    const to = hexToBase58(value.to_address);
    if (!from || !to || value.amount === undefined) {
      return fail('PARSE_FAILED', 'malformed TransferContract');
    }
    const amount = BigInt(value.amount);
    const base = { asset: 'TRX', decimals: 6, minAmount: opts.minTrxSun, from, to, amount };
    if (to !== opts.paymentAddress) return fail('WRONG_RECEIVER', `to=${to}`, base);
    if (amount < opts.minTrxSun) return fail('AMOUNT_TOO_LOW', `${amount} < ${opts.minTrxSun}`, base);
    return { ok: true, ...base };
  }

  if (contract.type === 'TriggerSmartContract') {
    const contractAddress = hexToBase58(value.contract_address);
    // 必须是白名单内的代币合约，否则任何人都能部署假币并伪造 Transfer 事件
    const token = opts.tokens.find((t) => t.address === contractAddress);
    if (!token) return fail('UNSUPPORTED_ASSET', `contract=${contractAddress}`);

    if (txInfo?.receipt?.result !== 'SUCCESS' || txInfo?.result === 'FAILED') {
      return fail('TRANSACTION_FAILED', `receipt=${txInfo?.receipt?.result || 'UNKNOWN'}`);
    }

    const tokenHex = strip0x(TronWeb.address.toHex(token.address)).slice(2); // 回执 log.address 不带 41 前缀
    const transfers = (txInfo.log || [])
      .filter((l) => strip0x(l.address).slice(-40) === tokenHex)
      .filter((l) => Array.isArray(l.topics) && l.topics.length === 3 && strip0x(l.topics[0]) === TRANSFER_TOPIC)
      .map((l) => ({
        from: topicToBase58(l.topics[1]),
        to: topicToBase58(l.topics[2]),
        amount: /^[0-9a-f]{1,64}$/.test(strip0x(l.data)) ? BigInt('0x' + strip0x(l.data)) : null,
      }));

    if (transfers.length === 0 || transfers.some((t) => !t.from || !t.to || t.amount === null)) {
      return fail('PARSE_FAILED', 'no valid Transfer event from token contract');
    }

    const toUs = transfers.filter((t) => t.to === opts.paymentAddress);
    if (toUs.length === 0) {
      const t = transfers[0];
      return fail('WRONG_RECEIVER', `to=${t.to}`, { asset: token.symbol, from: t.from, to: t.to, amount: t.amount });
    }
    const senders = new Set(toUs.map((t) => t.from));
    if (senders.size !== 1) return fail('PARSE_FAILED', 'multiple senders in one transaction');

    const amount = toUs.reduce((sum, t) => sum + t.amount, 0n);
    const base = {
      asset: token.symbol,
      decimals: token.decimals,
      minAmount: token.minAmount,
      from: toUs[0].from,
      to: opts.paymentAddress,
      amount,
    };
    if (amount < token.minAmount) return fail('AMOUNT_TOO_LOW', `${amount} < ${token.minAmount}`, base);
    return { ok: true, ...base };
  }

  return fail('UNSUPPORTED_ASSET', `contract type ${contract.type}`);
}

function fail(status, reason, extra = {}) {
  return { ok: false, status, reason, ...extra };
}

/** 将最小单位金额格式化为 "100 TRX" / "12.5 USDT" */
function formatAmount(amount, decimals, symbol) {
  if (amount === undefined || amount === null) return undefined;
  const a = BigInt(amount);
  const unit = 10n ** BigInt(decimals);
  const whole = a / unit;
  const frac = (a % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} ${symbol}`;
}

module.exports = { parsePayment, formatAmount, hexToBase58, TRANSFER_TOPIC };

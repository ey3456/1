'use strict';

const http = require('http');

const TXID_RE = /^[0-9a-fA-F]{64}$/;
const MAX_BODY = 4096;

/**
 * 前端接口（只负责登记 txid，不接受 from/to/amount）：
 *   POST /payments        {"txid":"...", "orderId":"..."}  -> 201 / 200（已存在）
 *   GET  /payments/:txid  -> 处理状态，供前端轮询
 */
function createHttpServer({ store }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/payments') {
        const body = await readJson(req);
        const txid = String(body.txid || '');
        if (!TXID_RE.test(txid)) return send(res, 400, { error: 'invalid txid' });
        const orderId = body.orderId === undefined || body.orderId === null ? null : String(body.orderId).slice(0, 128);
        const created = await store.createPayment({ txid: txid.toLowerCase(), orderId });
        return send(res, created ? 201 : 200, { txid: txid.toLowerCase(), created });
      }
      const m = url.pathname.match(/^\/payments\/([0-9a-fA-F]{64})$/);
      if (req.method === 'GET' && m) {
        const p = await store.getPayment(m[1].toLowerCase());
        if (!p) return send(res, 404, { error: 'not found' });
        return send(res, 200, { txid: p.txid, orderId: p.orderId, status: p.status, result: p.result, reason: p.reason });
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, e.statusCode || 500, { error: e.statusCode ? e.message : 'internal error' });
    }
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        reject(Object.assign(new Error('invalid json'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

module.exports = { createHttpServer };

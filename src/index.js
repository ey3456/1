'use strict';

const { loadConfig, readPrivateKey } = require('./config');
const { ChainClient } = require('./chain');
const { EventSink } = require('./events');
const { PostgresStore } = require('./db/postgres');
const { PaymentAuthService } = require('./service');
const { createHttpServer } = require('./http');

// stdout 只输出 JSON 事件，日志一律走 stderr
const logger = { info: (...a) => console.error(...a), error: (...a) => console.error(...a) };

async function main() {
  const config = loadConfig();
  const store = new PostgresStore({ connectionString: config.databaseUrl });
  const chain = new ChainClient(config, { privateKey: readPrivateKey(config.authPrivateKeyFile) });
  const events = new EventSink({ webhookUrl: config.webhookUrl, logger });
  const service = new PaymentAuthService({ config, store, chain, events, logger });

  service.start();
  const server = createHttpServer({ store });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.error(`[http] listening on :${port}`));

  const shutdown = async () => {
    service.stop();
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { serve } from "@hono/node-server";
import { createApp, type AppConfig } from "./app.js";
import { openDb } from "./db.js";

export interface StartServerOptions extends AppConfig {
  port?: number;
  hostname?: string;
  dbFile?: string;
}

export function startServer(options: StartServerOptions = {}) {
  const db = openDb(options.dbFile ?? "aicoo-local-agent.db");
  const app = createApp(db, options);
  const server = serve({
    fetch: app.fetch,
    port: options.port ?? 7790,
    hostname: options.hostname ?? "127.0.0.1",
  });
  return { server, db };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.CCD_PORT ?? "7790", 10);
  const hostname = process.env.CCD_HOST ?? "127.0.0.1";
  const dbFile = process.env.CCD_DB ?? "aicoo-local-agent.db";
  startServer({
    port,
    hostname,
    dbFile,
    log: (line) => console.log(line),
  });
  console.log(`aicoo-local-agent mock control plane listening on http://${hostname}:${port}`);
}

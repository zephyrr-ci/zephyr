/**
 * Start the Zephyr CI server
 */

import { ZephyrServer } from "@zephyrr-ci/server";

export interface ServerCommandOptions {
  /** Port to listen on */
  port?: number;
  /** Host to bind to */
  host?: string;
  /** Path to SQLite database */
  db?: string;
  /** GitHub webhook secret */
  githubSecret?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Maximum concurrent jobs */
  maxJobs?: number;
}

export async function server(options: ServerCommandOptions = {}): Promise<void> {
  const srv = new ZephyrServer({
    port: options.port ?? 3000,
    host: options.host ?? "0.0.0.0",
    dbPath: options.db ?? "./zephyr.db",
    githubWebhookSecret: options.githubSecret,
    apiKey: options.apiKey,
    maxConcurrentJobs: options.maxJobs ?? 4,
  });

  // Handle shutdown signals
  const shutdown = async () => {
    console.log("\nShutting down...");
    await srv.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  srv.start();

  const baseUrl = `http://${options.host ?? "0.0.0.0"}:${options.port ?? 3000}`;

  console.log(`
\x1b[36mZephyr CI Server\x1b[0m

Server running at ${baseUrl}

Endpoints:
  \x1b[33mAPI\x1b[0m
  GET  /health              - Health check
  GET  /api/v1/projects     - List projects
  POST /api/v1/projects     - Create project
  GET  /api/v1/runs         - List pipeline runs
  POST /api/v1/trigger      - Trigger a pipeline
  GET  /api/v1/jobs/:id     - Get job details
  GET  /api/v1/jobs/:id/logs - Get job logs

  \x1b[33mWebhooks\x1b[0m
  POST /webhooks/github     - GitHub webhook endpoint

  \x1b[33mMonitoring\x1b[0m
  GET  /metrics             - Prometheus metrics
  GET  /metrics/json        - Metrics as JSON (debug)
  GET  /api/v1/scheduler/stats - Scheduler statistics

  \x1b[33mRealtime\x1b[0m
  WS   /ws                  - WebSocket for log streaming

Press Ctrl+C to stop
`);

  // Keep the process running
  await new Promise(() => {});
}

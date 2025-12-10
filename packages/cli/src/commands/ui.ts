/**
 * Start the Web UI
 */

import { WebUI } from "@zephyrr-ci/web";

export interface UICommandOptions {
  /** Port to listen on */
  port?: number;
  /** API server URL */
  apiUrl?: string;
  /** API key for authentication */
  apiKey?: string;
}

export async function ui(options: UICommandOptions): Promise<void> {
  const apiUrl = options.apiUrl ?? "http://localhost:3000";
  const port = options.port ?? 8080;

  console.log(`Starting Zephyr CI Web UI...`);
  console.log(`  API Server: ${apiUrl}`);
  console.log(`  Web UI: http://localhost:${port}`);

  const webUI = new WebUI({
    port,
    apiUrl,
    apiKey: options.apiKey,
  });

  webUI.start();

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    webUI.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    webUI.stop();
    process.exit(0);
  });

  // Keep running
  await new Promise(() => {});
}

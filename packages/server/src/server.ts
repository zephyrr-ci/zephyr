/**
 * Zephyr CI HTTP Server
 *
 * Main server that handles:
 * - REST API for jobs, pipelines, projects
 * - Webhook endpoints for GitHub/GitLab
 * - WebSocket for log streaming
 */

import { ZephyrDatabase } from "@zephyr-ci/storage";
import { createLogger, type Logger } from "@zephyr-ci/core";
import { JobScheduler } from "./scheduler/index.ts";
import {
  verifyGitHubSignature,
  parseGitHubWebhook,
  extractBranchFromRef,
  extractTagFromRef,
  shouldTriggerPipeline,
  type GitHubWebhookPayload,
} from "./webhooks/github.ts";
import { metrics, ZephyrMetrics } from "./metrics/index.ts";

export interface ServerOptions {
  /** Port to listen on */
  port?: number;
  /** Host to bind to */
  host?: string;
  /** Path to SQLite database */
  dbPath?: string;
  /** GitHub webhook secret */
  githubWebhookSecret?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Maximum concurrent jobs */
  maxConcurrentJobs?: number;
  /** Logger instance */
  logger?: Logger;
}

interface WebSocketClient {
  ws: { send(message: string): void };
  subscriptions: Set<string>;
}

interface WebSocketData {
  clientId: string;
}

export class ZephyrServer {
  private options: ServerOptions;
  private db: ZephyrDatabase;
  private scheduler: JobScheduler;
  private logger: Logger;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private wsClients = new Map<string, WebSocketClient>();
  private metrics: ZephyrMetrics;

  constructor(options: ServerOptions = {}) {
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? "0.0.0.0",
      dbPath: options.dbPath ?? "./zephyr.db",
      ...options,
    };

    this.logger = options.logger ?? createLogger({ prefix: "server" });
    this.db = new ZephyrDatabase({ path: this.options.dbPath! });
    this.metrics = metrics;
    this.scheduler = new JobScheduler({
      db: this.db,
      maxConcurrent: options.maxConcurrentJobs ?? 4,
      logger: this.logger,
      metrics: this.metrics,
    });

    // Set up job update callback for WebSocket broadcasting
    this.scheduler.setJobUpdateCallback((jobId, status, logs) => {
      this.broadcastJobUpdate(jobId, status, logs);
    });

    // Initialize server info metrics
    this.metrics.setServerInfo("0.1.0", options.maxConcurrentJobs ?? 4);
  }

  /**
   * Start the server
   */
  start(): void {
    const self = this;

    this.server = Bun.serve<WebSocketData>({
      port: this.options.port,
      hostname: this.options.host,

      async fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (url.pathname === "/ws") {
          const clientId = crypto.randomUUID();
          const success = server.upgrade(req, {
            data: { clientId },
          });
          if (success) {
            return undefined;
          }
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // Route the request
        return self.handleRequest(req);
      },

      websocket: {
        open(ws) {
          self.wsClients.set(ws.data.clientId, {
            ws,
            subscriptions: new Set(),
          });
          self.metrics.websocketConnected();
          self.logger.debug(`WebSocket client connected: ${ws.data.clientId}`);
        },

        message(ws, message) {
          self.handleWebSocketMessage(ws, message);
        },

        close(ws) {
          self.wsClients.delete(ws.data.clientId);
          self.metrics.websocketDisconnected();
          self.logger.debug(`WebSocket client disconnected: ${ws.data.clientId}`);
        },
      },
    });

    // Start the scheduler
    this.scheduler.start();

    this.logger.info(`Server listening on http://${this.options.host}:${this.options.port}`);
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    await this.scheduler.stop();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    this.db.close();
    this.logger.info("Server stopped");
  }

  /**
   * Handle HTTP requests
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const startTime = Date.now();

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    };

    // Handle preflight
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health check (no auth required)
      if (url.pathname === "/health" && method === "GET") {
        const response = this.json({ status: "ok", ...this.scheduler.getStats() }, corsHeaders);
        this.metrics.httpRequest(method, url.pathname, 200, Date.now() - startTime);
        return response;
      }

      // Prometheus metrics endpoint (no auth required)
      if (url.pathname === "/metrics" && method === "GET") {
        const response = new Response(this.metrics.export(), {
          headers: {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            ...corsHeaders,
          },
        });
        this.metrics.httpRequest(method, url.pathname, 200, Date.now() - startTime);
        return response;
      }

      // JSON metrics endpoint for debugging
      if (url.pathname === "/metrics/json" && method === "GET") {
        const response = this.json(this.metrics.toJSON(), corsHeaders);
        this.metrics.httpRequest(method, url.pathname, 200, Date.now() - startTime);
        return response;
      }

      // Webhook endpoints (use webhook secret for auth)
      if (url.pathname === "/webhooks/github" && method === "POST") {
        const response = await this.handleGitHubWebhook(req, corsHeaders);
        this.metrics.httpRequest(method, url.pathname, response.status, Date.now() - startTime);
        return response;
      }

      // API routes (require API key)
      if (url.pathname.startsWith("/api/")) {
        if (!this.checkApiAuth(req)) {
          return this.json({ error: "Unauthorized" }, corsHeaders, 401);
        }

        // Projects
        if (url.pathname === "/api/v1/projects" && method === "GET") {
          return this.json(this.db.listProjects(), corsHeaders);
        }

        if (url.pathname === "/api/v1/projects" && method === "POST") {
          const body = (await req.json()) as {
            name: string;
            description?: string;
            configPath?: string;
          };
          const project = this.db.createProject({
            id: crypto.randomUUID(),
            name: body.name,
            description: body.description,
            configPath: body.configPath,
          });
          return this.json(project, corsHeaders, 201);
        }

        // Pipeline runs
        if (url.pathname === "/api/v1/runs" && method === "GET") {
          const projectId = url.searchParams.get("project");
          const status = url.searchParams.get("status");
          const limit = url.searchParams.get("limit");
          return this.json(
            this.db.listPipelineRuns({
              projectId: projectId ?? undefined,
              status: status as "pending" | undefined,
              limit: limit ? parseInt(limit) : undefined,
            }),
            corsHeaders
          );
        }

        // Trigger a pipeline
        if (url.pathname === "/api/v1/trigger" && method === "POST") {
          const body = (await req.json()) as {
            projectId: string;
            pipeline: string;
            branch?: string;
            sha?: string;
          };
          return this.handleTrigger(body, corsHeaders);
        }

        // Get job details
        const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
        if (jobMatch && method === "GET") {
          const job = this.db.getJob(jobMatch[1]!);
          if (!job) {
            return this.json({ error: "Job not found" }, corsHeaders, 404);
          }
          return this.json(job, corsHeaders);
        }

        // Get job logs
        const logsMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/logs$/);
        if (logsMatch && method === "GET") {
          const since = url.searchParams.get("since");
          const logs = this.db.getLogsForJob(logsMatch[1]!, {
            since: since ? parseInt(since) : undefined,
          });
          return this.json(logs, corsHeaders);
        }

        // Scheduler stats
        if (url.pathname === "/api/v1/scheduler/stats" && method === "GET") {
          const response = this.json(this.scheduler.getStats(), corsHeaders);
          this.metrics.httpRequest(method, url.pathname, 200, Date.now() - startTime);
          return response;
        }

        // Track other API routes
        const response = this.json({ error: "Not found" }, corsHeaders, 404);
        this.metrics.httpRequest(method, url.pathname, 404, Date.now() - startTime);
        return response;
      }

      const response = this.json({ error: "Not found" }, corsHeaders, 404);
      this.metrics.httpRequest(method, url.pathname, 404, Date.now() - startTime);
      return response;
    } catch (err) {
      this.logger.error("Request error:", err);
      const response = this.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        corsHeaders,
        500
      );
      this.metrics.httpRequest(method, url.pathname, 500, Date.now() - startTime);
      return response;
    }
  }

  /**
   * Handle GitHub webhook
   */
  private async handleGitHubWebhook(
    req: Request,
    corsHeaders: Record<string, string>
  ): Promise<Response> {
    const signature = req.headers.get("X-Hub-Signature-256");
    const eventType = req.headers.get("X-GitHub-Event");
    const deliveryId = req.headers.get("X-GitHub-Delivery");

    if (!eventType) {
      this.metrics.webhookReceived("github", "unknown", false);
      return this.json({ error: "Missing X-GitHub-Event header" }, corsHeaders, 400);
    }

    const body = await req.text();

    // Verify signature if secret is configured
    if (this.options.githubWebhookSecret) {
      if (!verifyGitHubSignature(body, signature, this.options.githubWebhookSecret)) {
        this.metrics.webhookReceived("github", eventType, false);
        return this.json({ error: "Invalid signature" }, corsHeaders, 401);
      }
    }

    const payload = JSON.parse(body);

    // Save webhook delivery
    this.db.saveWebhookDelivery({
      id: deliveryId ?? crypto.randomUUID(),
      provider: "github",
      eventType,
      payload,
      signature: signature ?? undefined,
    });

    // Parse the webhook
    const parsed = parseGitHubWebhook(eventType, payload);
    if (!parsed) {
      this.metrics.webhookReceived("github", eventType, true);
      return this.json({ message: "Event ignored" }, corsHeaders);
    }

    // Find matching project by repository
    const projects = this.db.listProjects();
    // TODO: Match project by repository URL or name

    this.logger.info(
      `Received GitHub ${eventType} webhook for ${parsed.repository.fullName}`
    );

    this.metrics.webhookReceived("github", eventType, true);

    // For now, just acknowledge the webhook
    return this.json({
      message: "Webhook received",
      event: eventType,
      repository: parsed.repository.fullName,
    }, corsHeaders);
  }

  /**
   * Handle manual pipeline trigger
   */
  private async handleTrigger(
    body: { projectId: string; pipeline: string; branch?: string; sha?: string },
    corsHeaders: Record<string, string>
  ): Promise<Response> {
    const project = this.db.getProject(body.projectId);
    if (!project) {
      return this.json({ error: "Project not found" }, corsHeaders, 404);
    }

    if (!project.config_path) {
      return this.json({ error: "Project has no config path" }, corsHeaders, 400);
    }

    const runId = crypto.randomUUID();

    await this.scheduler.queuePipelineRun({
      id: runId,
      projectId: body.projectId,
      pipelineName: body.pipeline,
      configPath: project.config_path,
      context: {
        branch: body.branch ?? "main",
        sha: body.sha ?? "manual",
        env: {},
        isPullRequest: false,
        repo: {
          owner: "local",
          name: project.name,
          url: "",
        },
        event: { type: "api", triggeredBy: "api" },
      },
    });

    return this.json({ id: runId, status: "queued" }, corsHeaders, 201);
  }

  /**
   * Check API authentication
   */
  private checkApiAuth(req: Request): boolean {
    if (!this.options.apiKey) {
      return true; // No auth configured
    }

    const apiKey = req.headers.get("X-API-Key") ??
      req.headers.get("Authorization")?.replace("Bearer ", "");

    return apiKey === this.options.apiKey;
  }

  /**
   * Handle WebSocket messages
   */
  private handleWebSocketMessage(
    ws: { data: WebSocketData; send(message: string): void },
    message: string | Buffer
  ): void {
    try {
      const data = JSON.parse(message.toString());
      const client = this.wsClients.get(ws.data.clientId);

      if (!client) return;

      if (data.type === "subscribe" && data.jobId) {
        client.subscriptions.add(data.jobId);
        ws.send(JSON.stringify({ type: "subscribed", jobId: data.jobId }));
      }

      if (data.type === "unsubscribe" && data.jobId) {
        client.subscriptions.delete(data.jobId);
        ws.send(JSON.stringify({ type: "unsubscribed", jobId: data.jobId }));
      }
    } catch {
      // Ignore invalid messages
    }
  }

  /**
   * Broadcast job update to subscribed WebSocket clients
   */
  private broadcastJobUpdate(jobId: string, status: string, logs: string): void {
    const message = JSON.stringify({
      type: "job_update",
      jobId,
      status,
      logs,
      timestamp: Date.now(),
    });

    for (const client of this.wsClients.values()) {
      if (client.subscriptions.has(jobId)) {
        client.ws.send(message);
      }
    }
  }

  /**
   * Helper to send JSON response
   */
  private json(
    data: unknown,
    headers: Record<string, string>,
    status = 200
  ): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
  }
}

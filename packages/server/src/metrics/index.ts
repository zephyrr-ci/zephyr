/**
 * Prometheus-style Metrics
 *
 * Provides metrics collection and Prometheus exposition format output.
 */

/**
 * Counter metric - monotonically increasing value
 */
interface Counter {
  type: "counter";
  name: string;
  help: string;
  values: Map<string, number>;
}

/**
 * Gauge metric - value that can go up and down
 */
interface Gauge {
  type: "gauge";
  name: string;
  help: string;
  values: Map<string, number>;
}

/**
 * Histogram metric - samples observations into buckets
 */
interface Histogram {
  type: "histogram";
  name: string;
  help: string;
  buckets: number[];
  observations: Map<string, { sum: number; count: number; buckets: Map<number, number> }>;
}

type Metric = Counter | Gauge | Histogram;

/**
 * Metrics Registry
 */
export class MetricsRegistry {
  private metrics = new Map<string, Metric>();

  /**
   * Register a counter metric
   */
  registerCounter(name: string, help: string): void {
    this.metrics.set(name, {
      type: "counter",
      name,
      help,
      values: new Map(),
    });
  }

  /**
   * Register a gauge metric
   */
  registerGauge(name: string, help: string): void {
    this.metrics.set(name, {
      type: "gauge",
      name,
      help,
      values: new Map(),
    });
  }

  /**
   * Register a histogram metric
   */
  registerHistogram(
    name: string,
    help: string,
    buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ): void {
    this.metrics.set(name, {
      type: "histogram",
      name,
      help,
      buckets: buckets.sort((a, b) => a - b),
      observations: new Map(),
    });
  }

  /**
   * Increment a counter
   */
  incCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "counter") return;

    const key = this.labelKey(labels);
    const current = metric.values.get(key) ?? 0;
    metric.values.set(key, current + value);
  }

  /**
   * Set a gauge value
   */
  setGauge(name: string, labels: Record<string, string> = {}, value: number): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "gauge") return;

    const key = this.labelKey(labels);
    metric.values.set(key, value);
  }

  /**
   * Increment a gauge
   */
  incGauge(name: string, labels: Record<string, string> = {}, value = 1): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "gauge") return;

    const key = this.labelKey(labels);
    const current = metric.values.get(key) ?? 0;
    metric.values.set(key, current + value);
  }

  /**
   * Decrement a gauge
   */
  decGauge(name: string, labels: Record<string, string> = {}, value = 1): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "gauge") return;

    const key = this.labelKey(labels);
    const current = metric.values.get(key) ?? 0;
    metric.values.set(key, current - value);
  }

  /**
   * Observe a histogram value
   */
  observeHistogram(name: string, labels: Record<string, string> = {}, value: number): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "histogram") return;

    const key = this.labelKey(labels);
    let obs = metric.observations.get(key);

    if (!obs) {
      obs = {
        sum: 0,
        count: 0,
        buckets: new Map(metric.buckets.map((b) => [b, 0])),
      };
      metric.observations.set(key, obs);
    }

    obs.sum += value;
    obs.count += 1;

    for (const bucket of metric.buckets) {
      if (value <= bucket) {
        obs.buckets.set(bucket, (obs.buckets.get(bucket) ?? 0) + 1);
      }
    }
  }

  /**
   * Generate label key from labels object
   */
  private labelKey(labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "";
    return entries.map(([k, v]) => `${k}="${v}"`).join(",");
  }

  /**
   * Format labels for Prometheus output
   */
  private formatLabels(labelKey: string): string {
    if (!labelKey) return "";
    return `{${labelKey}}`;
  }

  /**
   * Export metrics in Prometheus exposition format
   */
  export(): string {
    const lines: string[] = [];

    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      if (metric.type === "counter" || metric.type === "gauge") {
        for (const [labels, value] of metric.values) {
          lines.push(`${metric.name}${this.formatLabels(labels)} ${value}`);
        }
      } else if (metric.type === "histogram") {
        for (const [labels, obs] of metric.observations) {
          const baseLabels = labels ? `${labels},` : "";

          // Bucket values (cumulative)
          let cumulative = 0;
          for (const bucket of metric.buckets) {
            cumulative += obs.buckets.get(bucket) ?? 0;
            lines.push(`${metric.name}_bucket{${baseLabels}le="${bucket}"} ${cumulative}`);
          }
          lines.push(`${metric.name}_bucket{${baseLabels}le="+Inf"} ${obs.count}`);

          // Sum and count
          const suffix = labels ? `{${labels}}` : "";
          lines.push(`${metric.name}_sum${suffix} ${obs.sum}`);
          lines.push(`${metric.name}_count${suffix} ${obs.count}`);
        }
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Get metrics as JSON for debugging
   */
  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const metric of this.metrics.values()) {
      if (metric.type === "counter" || metric.type === "gauge") {
        result[metric.name] = Object.fromEntries(metric.values);
      } else if (metric.type === "histogram") {
        result[metric.name] = Object.fromEntries(
          Array.from(metric.observations.entries()).map(([k, v]) => [
            k || "_default",
            {
              sum: v.sum,
              count: v.count,
              buckets: Object.fromEntries(v.buckets),
            },
          ])
        );
      }
    }

    return result;
  }
}

/**
 * Default Zephyr metrics
 */
export class ZephyrMetrics {
  private registry: MetricsRegistry;

  constructor() {
    this.registry = new MetricsRegistry();
    this.registerMetrics();
  }

  private registerMetrics(): void {
    // Job metrics
    this.registry.registerCounter("zephyr_jobs_total", "Total number of jobs processed");
    this.registry.registerGauge("zephyr_jobs_active", "Number of currently running jobs");
    this.registry.registerHistogram(
      "zephyr_job_duration_seconds",
      "Job execution duration in seconds",
      [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]
    );

    // Pipeline metrics
    this.registry.registerCounter("zephyr_pipeline_runs_total", "Total number of pipeline runs");
    this.registry.registerHistogram(
      "zephyr_pipeline_duration_seconds",
      "Pipeline execution duration in seconds",
      [10, 30, 60, 120, 300, 600, 1800, 3600]
    );

    // Step metrics
    this.registry.registerCounter("zephyr_steps_total", "Total number of steps executed");
    this.registry.registerHistogram(
      "zephyr_step_duration_seconds",
      "Step execution duration in seconds",
      [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300]
    );

    // Queue metrics
    this.registry.registerGauge("zephyr_queue_depth", "Number of jobs waiting in queue");
    this.registry.registerHistogram(
      "zephyr_queue_wait_seconds",
      "Time jobs spend waiting in queue",
      [1, 5, 10, 30, 60, 120, 300, 600]
    );

    // VM pool metrics
    this.registry.registerGauge("zephyr_vm_pool_idle", "Number of idle VMs in warm pool");
    this.registry.registerGauge("zephyr_vm_pool_active", "Number of active VMs running jobs");
    this.registry.registerCounter("zephyr_vm_boots_total", "Total number of VM boots");
    this.registry.registerHistogram(
      "zephyr_vm_boot_seconds",
      "VM boot time in seconds",
      [0.1, 0.25, 0.5, 1, 2, 5, 10]
    );

    // Webhook metrics
    this.registry.registerCounter("zephyr_webhooks_total", "Total webhooks received");
    this.registry.registerCounter("zephyr_webhook_errors_total", "Total webhook processing errors");

    // HTTP metrics
    this.registry.registerCounter("zephyr_http_requests_total", "Total HTTP requests");
    this.registry.registerHistogram(
      "zephyr_http_request_duration_seconds",
      "HTTP request duration in seconds",
      [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
    );

    // WebSocket metrics
    this.registry.registerGauge("zephyr_websocket_connections", "Active WebSocket connections");

    // System info (gauges that rarely change)
    this.registry.registerGauge("zephyr_info", "Zephyr server info");
    this.registry.registerGauge("zephyr_max_concurrent_jobs", "Maximum concurrent jobs setting");
  }

  // Job tracking
  jobStarted(jobName: string, pipelineName: string): void {
    this.registry.incCounter("zephyr_jobs_total", { job: jobName, pipeline: pipelineName, status: "started" });
    this.registry.incGauge("zephyr_jobs_active", { pipeline: pipelineName });
  }

  jobCompleted(jobName: string, pipelineName: string, status: "success" | "failure" | "cancelled", durationMs: number): void {
    this.registry.incCounter("zephyr_jobs_total", { job: jobName, pipeline: pipelineName, status });
    this.registry.decGauge("zephyr_jobs_active", { pipeline: pipelineName });
    this.registry.observeHistogram("zephyr_job_duration_seconds", { job: jobName, pipeline: pipelineName, status }, durationMs / 1000);
  }

  // Pipeline tracking
  pipelineStarted(pipelineName: string, triggerType: string): void {
    this.registry.incCounter("zephyr_pipeline_runs_total", { pipeline: pipelineName, trigger: triggerType, status: "started" });
  }

  pipelineCompleted(pipelineName: string, status: "success" | "failure" | "cancelled", durationMs: number): void {
    this.registry.incCounter("zephyr_pipeline_runs_total", { pipeline: pipelineName, status });
    this.registry.observeHistogram("zephyr_pipeline_duration_seconds", { pipeline: pipelineName, status }, durationMs / 1000);
  }

  // Step tracking
  stepCompleted(stepName: string, jobName: string, status: "success" | "failure" | "skipped", durationMs: number): void {
    this.registry.incCounter("zephyr_steps_total", { step: stepName, job: jobName, status });
    if (status !== "skipped") {
      this.registry.observeHistogram("zephyr_step_duration_seconds", { step: stepName, job: jobName }, durationMs / 1000);
    }
  }

  // Queue tracking
  setQueueDepth(depth: number): void {
    this.registry.setGauge("zephyr_queue_depth", {}, depth);
  }

  jobQueueWait(waitMs: number): void {
    this.registry.observeHistogram("zephyr_queue_wait_seconds", {}, waitMs / 1000);
  }

  // VM pool tracking
  setVMPoolStats(idle: number, active: number): void {
    this.registry.setGauge("zephyr_vm_pool_idle", {}, idle);
    this.registry.setGauge("zephyr_vm_pool_active", {}, active);
  }

  vmBooted(durationMs: number): void {
    this.registry.incCounter("zephyr_vm_boots_total", {});
    this.registry.observeHistogram("zephyr_vm_boot_seconds", {}, durationMs / 1000);
  }

  // Webhook tracking
  webhookReceived(provider: string, eventType: string, success: boolean): void {
    this.registry.incCounter("zephyr_webhooks_total", { provider, event: eventType });
    if (!success) {
      this.registry.incCounter("zephyr_webhook_errors_total", { provider, event: eventType });
    }
  }

  // HTTP tracking
  httpRequest(method: string, path: string, status: number, durationMs: number): void {
    const statusGroup = `${Math.floor(status / 100)}xx`;
    this.registry.incCounter("zephyr_http_requests_total", { method, path: this.normalizePath(path), status: statusGroup });
    this.registry.observeHistogram("zephyr_http_request_duration_seconds", { method, path: this.normalizePath(path) }, durationMs / 1000);
  }

  // WebSocket tracking
  websocketConnected(): void {
    this.registry.incGauge("zephyr_websocket_connections", {});
  }

  websocketDisconnected(): void {
    this.registry.decGauge("zephyr_websocket_connections", {});
  }

  // System info
  setServerInfo(version: string, maxConcurrent: number): void {
    this.registry.setGauge("zephyr_info", { version }, 1);
    this.registry.setGauge("zephyr_max_concurrent_jobs", {}, maxConcurrent);
  }

  /**
   * Normalize path to avoid high cardinality
   */
  private normalizePath(path: string): string {
    // Replace UUIDs and IDs with placeholders
    return path
      .replace(/\/[a-f0-9-]{36}/gi, "/:id")
      .replace(/\/\d+/g, "/:id");
  }

  /**
   * Export metrics in Prometheus format
   */
  export(): string {
    return this.registry.export();
  }

  /**
   * Get metrics as JSON
   */
  toJSON(): Record<string, unknown> {
    return this.registry.toJSON();
  }
}

/**
 * Global metrics instance
 */
export const metrics = new ZephyrMetrics();

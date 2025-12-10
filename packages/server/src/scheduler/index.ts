/**
 * Job Scheduler
 *
 * Manages the job queue and dispatches jobs to executors.
 */

import { ZephyrDatabase, type JobRecord, type JobStatus } from "@zephyr-ci/storage";
import {
  loadConfig,
  resolvePipelines,
  createDefaultContext,
  runJob,
  createLogger,
  type Logger,
} from "@zephyr-ci/core";
import type { JobDefinition, ConfigContext, TriggerEvent } from "@zephyr-ci/types";
import type { ZephyrMetrics } from "../metrics/index.ts";

export interface SchedulerOptions {
  /** Database instance */
  db: ZephyrDatabase;
  /** Maximum concurrent jobs */
  maxConcurrent?: number;
  /** Poll interval in milliseconds */
  pollInterval?: number;
  /** Logger instance */
  logger?: Logger;
  /** Metrics instance */
  metrics?: ZephyrMetrics;
}

export interface QueuedPipelineRun {
  id: string;
  projectId: string;
  pipelineName: string;
  configPath: string;
  context: ConfigContext;
}

type JobExecutionCallback = (
  jobId: string,
  status: JobStatus,
  logs: string
) => void;

export class JobScheduler {
  private db: ZephyrDatabase;
  private maxConcurrent: number;
  private pollInterval: number;
  private logger: Logger;
  private metrics?: ZephyrMetrics;
  private running = false;
  private activeJobs = new Map<string, Promise<void>>();
  private jobStartTimes = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onJobUpdate?: JobExecutionCallback;

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.pollInterval = options.pollInterval ?? 1000;
    this.logger = options.logger ?? createLogger({ prefix: "scheduler" });
    this.metrics = options.metrics;
  }

  /**
   * Set callback for job status updates
   */
  setJobUpdateCallback(callback: JobExecutionCallback): void {
    this.onJobUpdate = callback;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info("Scheduler started");

    // Start polling for jobs
    this.pollTimer = setInterval(() => {
      this.processQueue().catch((err) => {
        this.logger.error("Error processing queue:", err);
      });
    }, this.pollInterval);

    // Process immediately
    this.processQueue().catch((err) => {
      this.logger.error("Error processing queue:", err);
    });
  }

  /**
   * Stop the scheduler
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for active jobs to complete
    if (this.activeJobs.size > 0) {
      this.logger.info(`Waiting for ${this.activeJobs.size} active jobs to complete...`);
      await Promise.all(this.activeJobs.values());
    }

    this.logger.info("Scheduler stopped");
  }

  /**
   * Queue a new pipeline run
   */
  async queuePipelineRun(run: QueuedPipelineRun): Promise<string> {
    // Create pipeline run record
    const pipelineRun = this.db.createPipelineRun({
      id: run.id,
      projectId: run.projectId,
      pipelineName: run.pipelineName,
      triggerType: run.context.event.type,
      triggerData: run.context.event,
      branch: run.context.branch,
      commitSha: run.context.sha,
    });

    // Load and resolve config
    const { config } = await loadConfig(run.configPath);
    const pipelines = resolvePipelines(config, run.context);
    const pipeline = pipelines.find((p) => p.name === run.pipelineName);

    if (!pipeline) {
      throw new Error(`Pipeline '${run.pipelineName}' not found`);
    }

    // Create job records for each job in the pipeline
    for (const jobDef of pipeline.jobs) {
      this.db.createJob({
        id: `${run.id}-${jobDef.name}`,
        pipelineRunId: run.id,
        name: jobDef.name,
        runnerImage: jobDef.runner.image,
      });
    }

    this.logger.info(`Queued pipeline run: ${run.id} (${pipeline.jobs.length} jobs)`);

    return pipelineRun.id;
  }

  /**
   * Process the job queue
   */
  private async processQueue(): Promise<void> {
    if (!this.running) return;

    // Update queue depth metric
    const queueStats = this.db.countJobsByStatus();
    this.metrics?.setQueueDepth(queueStats.pending);

    // Check if we have capacity
    if (this.activeJobs.size >= this.maxConcurrent) {
      return;
    }

    // Get pending jobs
    const availableSlots = this.maxConcurrent - this.activeJobs.size;
    const pendingJobs = this.db.getPendingJobs(availableSlots);

    for (const job of pendingJobs) {
      if (this.activeJobs.has(job.id)) {
        continue;
      }

      // Check if dependencies are met
      const canRun = await this.canJobRun(job);
      if (!canRun) {
        continue;
      }

      // Track queue wait time (time from creation to start)
      if (job.created_at) {
        const queueWaitMs = Date.now() - job.created_at * 1000;
        this.metrics?.jobQueueWait(queueWaitMs);
      }

      // Start the job
      const promise = this.executeJob(job).catch((err) => {
        this.logger.error(`Job ${job.id} failed:`, err);
      });

      this.activeJobs.set(job.id, promise);

      // Clean up when done
      promise.finally(() => {
        this.activeJobs.delete(job.id);
      });
    }
  }

  /**
   * Check if a job's dependencies are satisfied
   */
  private async canJobRun(job: JobRecord): Promise<boolean> {
    // Get the pipeline run
    const pipelineRun = this.db.getPipelineRun(job.pipeline_run_id);
    if (!pipelineRun) {
      return false;
    }

    // Get all jobs in this pipeline run
    const allJobs = this.db.getJobsForPipelineRun(job.pipeline_run_id);

    // For now, run jobs in order (first pending job runs first)
    // TODO: Implement proper dependency checking based on job.dependsOn
    const pendingJobs = allJobs.filter((j) => j.status === "pending");
    return pendingJobs[0]?.id === job.id;
  }

  /**
   * Execute a job
   */
  private async executeJob(job: JobRecord): Promise<void> {
    this.logger.info(`Starting job: ${job.name} (${job.id})`);
    const jobStartTime = Date.now();
    this.jobStartTimes.set(job.id, jobStartTime);

    // Update status to running
    const startedAt = Math.floor(Date.now() / 1000);
    this.db.updateJobStatus(job.id, "running", { startedAt });

    // Get the pipeline run for context
    const pipelineRun = this.db.getPipelineRun(job.pipeline_run_id);
    if (!pipelineRun) {
      this.db.updateJobStatus(job.id, "failure", {
        finishedAt: Math.floor(Date.now() / 1000),
      });
      this.metrics?.jobCompleted(job.name, "unknown", "failure", Date.now() - jobStartTime);
      this.jobStartTimes.delete(job.id);
      return;
    }

    // Track job start
    this.metrics?.jobStarted(job.name, pipelineRun.pipeline_name);

    // Get the project
    const project = this.db.getProject(pipelineRun.project_id);
    if (!project || !project.config_path) {
      this.db.updateJobStatus(job.id, "failure", {
        finishedAt: Math.floor(Date.now() / 1000),
      });
      this.metrics?.jobCompleted(job.name, pipelineRun.pipeline_name, "failure", Date.now() - jobStartTime);
      this.jobStartTimes.delete(job.id);
      return;
    }

    try {
      // Load config
      const { config } = await loadConfig(project.config_path);

      // Create context
      const triggerEvent: TriggerEvent = pipelineRun.trigger_data
        ? JSON.parse(pipelineRun.trigger_data)
        : { type: "manual", inputs: {} };

      const context = createDefaultContext({
        branch: pipelineRun.branch ?? "main",
        sha: pipelineRun.commit_sha ?? "unknown",
        event: triggerEvent,
      });

      // Resolve pipelines and find the job
      const pipelines = resolvePipelines(config, context);
      const pipeline = pipelines.find((p) => p.name === pipelineRun.pipeline_name);
      const jobDef = pipeline?.jobs.find((j) => j.name === job.name);

      if (!jobDef) {
        throw new Error(`Job definition not found: ${job.name}`);
      }

      // Get config directory
      const configDir = project.config_path.split("/").slice(0, -1).join("/");

      // Create a logger that saves to the database
      const jobLogger = this.createJobLogger(job.id);

      // Run the job
      const result = await runJob(jobDef, {
        cwd: configDir,
        context,
        logger: jobLogger,
        env: {
          ...config.project.env,
          ...pipeline?.env,
        },
      });

      // Update status
      const status: JobStatus = result.status === "success" ? "success" : "failure";
      this.db.updateJobStatus(job.id, status, {
        finishedAt: Math.floor(Date.now() / 1000),
      });

      this.logger.info(`Job ${job.name} completed: ${status}`);

      // Track job completion metrics
      const jobDuration = Date.now() - jobStartTime;
      this.metrics?.jobCompleted(job.name, pipelineRun.pipeline_name, status, jobDuration);

      // Track step metrics
      for (const stepTiming of result.stepTimings) {
        this.metrics?.stepCompleted(
          stepTiming.name,
          job.name,
          stepTiming.status as "success" | "failure" | "skipped",
          stepTiming.duration
        );
      }

      this.jobStartTimes.delete(job.id);

      // Notify callback
      if (this.onJobUpdate) {
        this.onJobUpdate(job.id, status, "");
      }
    } catch (err) {
      this.logger.error(`Job ${job.name} error:`, err);
      this.db.updateJobStatus(job.id, "failure", {
        finishedAt: Math.floor(Date.now() / 1000),
      });

      // Track job failure
      const jobDuration = Date.now() - jobStartTime;
      this.metrics?.jobCompleted(job.name, pipelineRun.pipeline_name, "failure", jobDuration);
      this.jobStartTimes.delete(job.id);

      if (this.onJobUpdate) {
        this.onJobUpdate(job.id, "failure", err instanceof Error ? err.message : "Unknown error");
      }
    }
  }

  /**
   * Create a logger that saves output to the database
   */
  private createJobLogger(jobId: string): Logger {
    const baseLogger = createLogger({ prefix: "job" });

    return {
      debug: (message: string, ...args: unknown[]) => {
        baseLogger.debug(message, ...args);
        this.db.appendLog({
          jobId,
          stream: "stdout",
          content: `[DEBUG] ${message} ${args.map(String).join(" ")}`,
        });
      },
      info: (message: string, ...args: unknown[]) => {
        baseLogger.info(message, ...args);
        this.db.appendLog({
          jobId,
          stream: "stdout",
          content: message + (args.length ? " " + args.map(String).join(" ") : ""),
        });
      },
      warn: (message: string, ...args: unknown[]) => {
        baseLogger.warn(message, ...args);
        this.db.appendLog({
          jobId,
          stream: "stderr",
          content: `[WARN] ${message} ${args.map(String).join(" ")}`,
        });
      },
      error: (message: string, ...args: unknown[]) => {
        baseLogger.error(message, ...args);
        this.db.appendLog({
          jobId,
          stream: "stderr",
          content: `[ERROR] ${message} ${args.map(String).join(" ")}`,
        });
      },
      group: (label: string) => {
        baseLogger.group(label);
        this.db.appendLog({
          jobId,
          stream: "stdout",
          content: `\n=== ${label} ===`,
        });
      },
      groupEnd: () => {
        baseLogger.groupEnd();
      },
    };
  }

  /**
   * Get scheduler statistics
   */
  getStats(): {
    running: boolean;
    activeJobs: number;
    maxConcurrent: number;
    queueStats: Record<JobStatus, number>;
  } {
    return {
      running: this.running,
      activeJobs: this.activeJobs.size,
      maxConcurrent: this.maxConcurrent,
      queueStats: this.db.countJobsByStatus(),
    };
  }
}

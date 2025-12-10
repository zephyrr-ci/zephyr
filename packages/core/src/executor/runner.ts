import type {
  JobDefinition,
  StepDefinition,
  RunStep,
  SetupStep,
  StepResult,
  JobResult,
  ConfigContext,
} from "@zephyr-ci/types";
import { createLogger, type Logger } from "../utils/logger.ts";

/**
 * Options for running a job
 */
export interface RunJobOptions {
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Logger instance */
  logger?: Logger;
  /** Config context */
  context: ConfigContext;
  /** Results of dependent jobs */
  needs?: Record<string, JobResult>;
}

/**
 * Result of running a job
 */
export interface JobRunResult {
  job: string;
  status: "success" | "failure" | "cancelled";
  steps: Record<string, StepResult>;
  outputs: Record<string, string>;
  duration: number;
  stepTimings: Array<{ name: string; duration: number; status: string }>;
}

/**
 * Run a shell command using Bun's native APIs
 */
async function runCommand(
  command: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: string;
    timeout?: number;
    logger: Logger;
  }
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([options.shell, "-c", command], {
    cwd: options.cwd,
    env: { ...Bun.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";

  // Stream stdout
  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();
  const decoder = new TextDecoder();

  // Read stdout and stderr concurrently
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readStream = async (reader: any, isError: boolean) => {
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      output += text;
      buffer += text;

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line) {
          if (isError) {
            options.logger.warn(`  ${line}`);
          } else {
            options.logger.info(`  ${line}`);
          }
        }
      }
    }

    // Handle remaining buffer
    if (buffer) {
      if (isError) {
        options.logger.warn(`  ${buffer}`);
      } else {
        options.logger.info(`  ${buffer}`);
      }
    }
  };

  // Handle timeout
  let killed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  if (options.timeout) {
    timeoutId = setTimeout(() => {
      killed = true;
      proc.kill();
      output += "\n[TIMEOUT] Step exceeded timeout limit";
    }, options.timeout * 1000);
  }

  // Read both streams
  await Promise.all([
    readStream(stdoutReader, false),
    readStream(stderrReader, true),
  ]);

  const exitCode = await proc.exited;

  if (timeoutId) clearTimeout(timeoutId);

  return { exitCode: killed ? 124 : exitCode, output };
}

/**
 * Run a single step
 */
async function runStep(
  step: StepDefinition,
  options: {
    cwd: string;
    env: Record<string, string>;
    logger: Logger;
    stepResults: Record<string, StepResult>;
  }
): Promise<StepResult> {
  const { logger } = options;

  // Merge step env with job env
  const env = { ...options.env, ...step.env };
  // Simple path resolution - if workdir is relative, join with cwd
  const workdir = step.workdir
    ? step.workdir.startsWith("/")
      ? step.workdir
      : `${options.cwd}/${step.workdir}`
    : options.cwd;

  if (step.type === "run") {
    const runStep = step as RunStep;
    const shell = runStep.shell ?? "bash";

    logger.info(`\x1b[36m▶ ${step.name}\x1b[0m`);

    const { exitCode, output } = await runCommand(runStep.run, {
      cwd: workdir,
      env,
      shell,
      timeout: step.timeout,
      logger,
    });

    const success = exitCode === 0;
    const status = success ? "success" : "failure";

    if (!success) {
      logger.error(`  Step failed with exit code ${exitCode}`);
    }

    // Parse outputs from the command output (GitHub Actions style)
    const outputs: Record<string, string> = {};
    const outputRegex = /::set-output name=([^:]+)::(.+)/g;
    let match;
    while ((match = outputRegex.exec(output)) !== null) {
      const name = match[1];
      const value = match[2];
      if (name && value) {
        outputs[name] = value;
      }
    }

    return {
      status: step.continueOnError && !success ? "success" : status,
      outcome: status,
      outputs,
    };
  }

  if (step.type === "setup") {
    const setupStep = step as SetupStep;
    logger.info(`\x1b[36m▶ ${step.name}\x1b[0m (setup ${setupStep.runtime} ${setupStep.version})`);

    // For now, just log that we would set up the runtime
    // In VM mode, this would install the runtime
    logger.info(`  [local mode] Assuming ${setupStep.runtime} ${setupStep.version} is available`);

    return {
      status: "success",
      outcome: "success",
      outputs: {},
    };
  }

  throw new Error(`Unknown step type: ${(step as { type: string }).type}`);
}

/**
 * Run a job locally (without VM isolation)
 */
export async function runJob(
  job: JobDefinition,
  options: RunJobOptions
): Promise<JobRunResult> {
  const logger = options.logger ?? createLogger();
  const startTime = Date.now();

  logger.group(`Job: ${job.name}`);

  // Merge environment variables
  const env: Record<string, string> = {
    ...options.env,
    ...job.env,
    CI: "true",
    ZEPHYR: "true",
  };

  const stepResults: Record<string, StepResult> = {};
  const stepTimings: Array<{ name: string; duration: number; status: string }> = [];
  let jobFailed = false;

  for (const step of job.steps) {
    // Check step condition
    if (step.if) {
      if (typeof step.if === "function") {
        const shouldRun = await step.if({
          ...options.context,
          needs: options.needs ?? {},
          steps: stepResults,
        });
        if (!shouldRun) {
          logger.info(`\x1b[33m⊘ ${step.name}\x1b[0m (skipped by condition)`);
          if (step.id) {
            stepResults[step.id] = {
              status: "skipped",
              outcome: "skipped",
              outputs: {},
            };
          }
          continue;
        }
      }
      // String conditions would be evaluated here in a real implementation
    }

    // Skip remaining steps if job has failed (unless continueOnError)
    if (jobFailed && !step.continueOnError) {
      logger.info(`\x1b[33m⊘ ${step.name}\x1b[0m (skipped due to previous failure)`);
      if (step.id) {
        stepResults[step.id] = {
          status: "skipped",
          outcome: "skipped",
          outputs: {},
        };
      }
      stepTimings.push({ name: step.name, duration: 0, status: "skipped" });
      continue;
    }

    const stepStart = Date.now();
    const result = await runStep(step, {
      cwd: options.cwd,
      env,
      logger,
      stepResults,
    });
    const stepDuration = Date.now() - stepStart;

    stepTimings.push({ name: step.name, duration: stepDuration, status: result.status });

    if (step.id) {
      stepResults[step.id] = result;
    }

    if (result.outcome === "failure" && !step.continueOnError) {
      jobFailed = true;
    }
  }

  const duration = Date.now() - startTime;
  const status = jobFailed ? "failure" : "success";

  logger.groupEnd();

  if (status === "success") {
    logger.info(`\x1b[32m✓ Job '${job.name}' completed successfully\x1b[0m (${duration}ms)`);
  } else {
    logger.error(`\x1b[31m✗ Job '${job.name}' failed\x1b[0m (${duration}ms)`);
  }

  return {
    job: job.name,
    status,
    steps: stepResults,
    outputs: {}, // Job outputs would be collected here
    duration,
    stepTimings,
  };
}

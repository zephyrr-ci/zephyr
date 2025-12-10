import type {
  ZephyrConfig,
  JobDefinition,
  StepDefinition,
  PipelineDefinition,
} from "@zephyrr-ci/types";

/**
 * Define a Zephyr CI configuration with full type safety.
 *
 * @example
 * ```ts
 * // zephyr.config.ts
 * import { defineConfig } from '@zephyrr-ci/config';
 *
 * export default defineConfig({
 *   project: {
 *     name: 'my-app',
 *   },
 *   pipelines: [
 *     {
 *       name: 'ci',
 *       triggers: [{ type: 'push', branches: ['main'] }],
 *       jobs: [
 *         {
 *           name: 'test',
 *           runner: { image: 'ubuntu-22.04' },
 *           steps: [
 *             { type: 'run', name: 'Test', run: 'bun test' },
 *           ],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export function defineConfig(config: ZephyrConfig): ZephyrConfig {
  return config;
}

/**
 * Create a reusable job definition.
 *
 * @example
 * ```ts
 * const testJob = defineJob({
 *   name: 'test',
 *   runner: { image: 'ubuntu-22.04' },
 *   steps: [
 *     { type: 'run', name: 'Test', run: 'bun test' },
 *   ],
 * });
 * ```
 */
export function defineJob(job: JobDefinition): JobDefinition {
  return job;
}

/**
 * Create a reusable step definition.
 *
 * @example
 * ```ts
 * const installStep = defineStep({
 *   type: 'run',
 *   name: 'Install dependencies',
 *   run: 'bun install',
 * });
 * ```
 */
export function defineStep(step: StepDefinition): StepDefinition {
  return step;
}

/**
 * Create a reusable pipeline definition.
 *
 * @example
 * ```ts
 * const ciPipeline = definePipeline({
 *   name: 'ci',
 *   triggers: [{ type: 'push', branches: ['main'] }],
 *   jobs: [...],
 * });
 * ```
 */
export function definePipeline(pipeline: PipelineDefinition): PipelineDefinition {
  return pipeline;
}

/**
 * Reference a secret in configuration.
 * Returns a placeholder string that will be replaced at runtime.
 *
 * @example
 * ```ts
 * env: {
 *   API_KEY: secret('production/api-key'),
 * }
 * ```
 */
export function secret(name: string): string {
  return `\${{ secrets.${name} }}`;
}

/**
 * Reference a step output.
 * Returns a placeholder string that will be replaced at runtime.
 *
 * @example
 * ```ts
 * env: {
 *   VERSION: output('build', 'version'),
 * }
 * ```
 */
export function output(stepId: string, outputName: string): string {
  return `\${{ steps.${stepId}.outputs.${outputName} }}`;
}

/**
 * Reference a matrix value.
 * Returns a placeholder string that will be replaced at runtime.
 *
 * @example
 * ```ts
 * name: `Test Node ${matrix('node-version')}`,
 * ```
 */
export function matrix(key: string): string {
  return `\${{ matrix.${key} }}`;
}

/**
 * Reference a job output from a dependency.
 * Returns a placeholder string that will be replaced at runtime.
 *
 * @example
 * ```ts
 * env: {
 *   ARTIFACT_URL: needs('build', 'artifact-url'),
 * }
 * ```
 */
export function needs(jobName: string, outputName: string): string {
  return `\${{ needs.${jobName}.outputs.${outputName} }}`;
}

// Re-export types for convenience
export type {
  ZephyrConfig,
  ProjectConfig,
  ConfigContext,
  PipelineDefinition,
  TriggerConfig,
  InputDefinition,
  JobDefinition,
  JobCondition,
  JobContext,
  JobResult,
  RunnerConfig,
  RunnerImage,
  StepDefinition,
  BaseStep,
  RunStep,
  SetupStep,
  StepContext,
  StepResult,
  ServiceDefinition,
  ArtifactDefinition,
  CacheConfig,
  SecretRef,
  MatrixConfig,
  ConcurrencyConfig,
  RetryConfig,
  TriggerEvent,
} from "@zephyrr-ci/types";

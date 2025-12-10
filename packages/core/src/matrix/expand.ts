/**
 * Matrix Build Expansion
 *
 * Handles expanding matrix configurations into individual job instances.
 * Supports exclusions, inclusions, and parallel limiting.
 */

import type { MatrixConfig, JobDefinition } from "@zephyrr-ci/types";

export interface MatrixCombination {
  /** Index of this combination */
  index: number;
  /** Matrix values for this instance */
  values: Record<string, string | number | boolean>;
  /** Generated name suffix */
  nameSuffix: string;
}

export interface ExpandedJob {
  /** Original job definition */
  job: JobDefinition;
  /** Matrix combination (null if no matrix) */
  matrix: MatrixCombination | null;
  /** Unique job instance ID */
  instanceId: string;
  /** Display name including matrix values */
  displayName: string;
}

/**
 * Expand a job with a matrix configuration into multiple job instances
 */
export function expandMatrix(job: JobDefinition): ExpandedJob[] {
  if (!job.matrix) {
    // No matrix, return single job instance
    return [
      {
        job,
        matrix: null,
        instanceId: job.name,
        displayName: job.name,
      },
    ];
  }

  const combinations = generateCombinations(job.matrix);
  return combinations.map((combo, index) => ({
    job,
    matrix: { ...combo, index },
    instanceId: `${job.name}-${combo.nameSuffix}`,
    displayName: `${job.name} (${combo.nameSuffix})`,
  }));
}

/**
 * Expand all jobs in a pipeline, handling matrix configurations
 */
export function expandPipelineJobs(jobs: JobDefinition[]): ExpandedJob[] {
  const expanded: ExpandedJob[] = [];

  for (const job of jobs) {
    expanded.push(...expandMatrix(job));
  }

  return expanded;
}

/**
 * Generate all matrix combinations
 */
function generateCombinations(matrix: MatrixConfig): MatrixCombination[] {
  const { values, exclude = [], include = [], maxParallel } = matrix;

  // Get all dimension names
  const dimensions = Object.keys(values);
  if (dimensions.length === 0) {
    return [];
  }

  // Generate base combinations using cartesian product
  let combinations = cartesianProduct(values);

  // Apply exclusions
  combinations = combinations.filter((combo) => !shouldExclude(combo, exclude));

  // Apply inclusions
  for (const inclusion of include) {
    // Check if this inclusion already exists
    const exists = combinations.some((combo) =>
      Object.keys(inclusion).every((key) => combo[key] === inclusion[key])
    );

    if (!exists) {
      // Fill in missing dimensions with first value
      const fullCombo: Record<string, string | number | boolean> = {};
      for (const dim of dimensions) {
        fullCombo[dim] = inclusion[dim] ?? values[dim]![0]!;
      }
      // Override with inclusion values
      Object.assign(fullCombo, inclusion);
      combinations.push(fullCombo);
    }
  }

  // Apply max parallel limit if specified
  if (maxParallel && combinations.length > maxParallel) {
    // Note: This just limits the total count, not the actual parallelism
    // Actual parallel limiting is handled by the scheduler
  }

  // Generate name suffixes
  return combinations.map((combo, index) => ({
    index,
    values: combo,
    nameSuffix: generateNameSuffix(combo),
  }));
}

/**
 * Generate cartesian product of matrix dimensions
 */
function cartesianProduct(
  values: Record<string, (string | number | boolean)[]>
): Record<string, string | number | boolean>[] {
  const dimensions = Object.keys(values);
  if (dimensions.length === 0) {
    return [{}];
  }

  const [first, ...rest] = dimensions;
  const firstValues = values[first!]!;

  if (rest.length === 0) {
    return firstValues.map((v) => ({ [first!]: v }));
  }

  const restProduct = cartesianProduct(
    Object.fromEntries(rest.map((d) => [d, values[d]!]))
  );

  const result: Record<string, string | number | boolean>[] = [];
  for (const v of firstValues) {
    for (const restCombo of restProduct) {
      result.push({ [first!]: v, ...restCombo });
    }
  }

  return result;
}

/**
 * Check if a combination should be excluded
 */
function shouldExclude(
  combo: Record<string, string | number | boolean>,
  exclusions: Record<string, string | number | boolean>[]
): boolean {
  for (const exclusion of exclusions) {
    const matches = Object.keys(exclusion).every((key) => combo[key] === exclusion[key]);
    if (matches) {
      return true;
    }
  }
  return false;
}

/**
 * Generate a name suffix from matrix values
 */
function generateNameSuffix(combo: Record<string, string | number | boolean>): string {
  return Object.entries(combo)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

/**
 * Interpolate matrix values into strings
 */
export function interpolateMatrix(
  text: string,
  matrix: Record<string, string | number | boolean>
): string {
  return text.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key) => {
    const value = matrix[key];
    return value !== undefined ? String(value) : "";
  });
}

/**
 * Apply matrix values to job environment variables
 */
export function applyMatrixToEnv(
  env: Record<string, string>,
  matrix: Record<string, string | number | boolean>
): Record<string, string> {
  const result: Record<string, string> = {};

  // Copy existing env vars with matrix interpolation
  for (const [key, value] of Object.entries(env)) {
    result[key] = interpolateMatrix(value, matrix);
  }

  // Add matrix values as MATRIX_ prefixed vars
  for (const [key, value] of Object.entries(matrix)) {
    result[`MATRIX_${key.toUpperCase()}`] = String(value);
  }

  return result;
}

/**
 * Get the maximum parallelism for a matrix
 */
export function getMatrixParallelism(matrix: MatrixConfig): number {
  if (matrix.maxParallel) {
    return matrix.maxParallel;
  }

  // Calculate total combinations
  const combinations = generateCombinations(matrix);
  return combinations.length;
}

/**
 * Check if a job has a matrix configuration
 */
export function hasMatrix(job: JobDefinition): boolean {
  return !!job.matrix && Object.keys(job.matrix.values).length > 0;
}

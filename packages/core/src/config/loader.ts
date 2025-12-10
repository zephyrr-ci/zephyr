import type {
  ZephyrConfig,
  PipelineDefinition,
  ConfigContext,
} from "@zephyrr-ci/types";

const CONFIG_FILE_NAMES = ["zephyr.config.ts", "zephyr.config.js"];

/**
 * Result of loading a config file
 */
export interface LoadedConfig {
  config: ZephyrConfig;
  configPath: string;
}

/**
 * Find the config file in the given directory or its parents
 */
export function findConfigFile(startDir: string): string | null {
  const file = Bun.file(startDir);
  let currentDir = file.name ? startDir : startDir;

  // Normalize to absolute path
  if (!currentDir.startsWith("/")) {
    currentDir = `${process.cwd()}/${currentDir}`;
  }

  // Walk up the directory tree
  while (currentDir !== "/") {
    for (const fileName of CONFIG_FILE_NAMES) {
      const configPath = `${currentDir}/${fileName}`;
      if (Bun.file(configPath).size > 0) {
        return configPath;
      }
    }

    // Move to parent directory
    const parts = currentDir.split("/");
    parts.pop();
    currentDir = parts.join("/") || "/";
  }

  // Check root
  for (const fileName of CONFIG_FILE_NAMES) {
    const configPath = `/${fileName}`;
    const file = Bun.file(configPath);
    try {
      if (file.size > 0) {
        return configPath;
      }
    } catch {
      // File doesn't exist
    }
  }

  return null;
}

/**
 * Load and validate a Zephyr config file
 */
export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  // Normalize to absolute path
  let absolutePath = configPath;
  if (!absolutePath.startsWith("/")) {
    absolutePath = `${process.cwd()}/${configPath}`;
  }

  const file = Bun.file(absolutePath);
  const exists = await file.exists();

  if (!exists) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  // Bun can import .ts files directly
  const module = await import(absolutePath);
  const config = module.default as ZephyrConfig;

  if (!config) {
    throw new Error(`Config file must have a default export: ${absolutePath}`);
  }

  validateConfig(config);

  return {
    config,
    configPath: absolutePath,
  };
}

/**
 * Resolve dynamic pipelines using the given context
 */
export function resolvePipelines(
  config: ZephyrConfig,
  context: ConfigContext
): PipelineDefinition[] {
  if (typeof config.pipelines === "function") {
    return config.pipelines(context);
  }
  return config.pipelines;
}

/**
 * Validate a config object
 */
function validateConfig(config: ZephyrConfig): void {
  if (!config.project) {
    throw new Error("Config must have a 'project' property");
  }

  if (!config.project.name) {
    throw new Error("Project must have a 'name' property");
  }

  if (!config.pipelines) {
    throw new Error("Config must have a 'pipelines' property");
  }

  // If pipelines is an array, validate each pipeline
  if (Array.isArray(config.pipelines)) {
    for (const pipeline of config.pipelines) {
      validatePipeline(pipeline);
    }
  }
}

/**
 * Validate a pipeline definition
 */
function validatePipeline(pipeline: PipelineDefinition): void {
  if (!pipeline.name) {
    throw new Error("Pipeline must have a 'name' property");
  }

  if (!pipeline.triggers || pipeline.triggers.length === 0) {
    throw new Error(`Pipeline '${pipeline.name}' must have at least one trigger`);
  }

  if (!pipeline.jobs || pipeline.jobs.length === 0) {
    throw new Error(`Pipeline '${pipeline.name}' must have at least one job`);
  }

  const jobNames = new Set<string>();
  for (const job of pipeline.jobs) {
    if (!job.name) {
      throw new Error(`Job in pipeline '${pipeline.name}' must have a 'name' property`);
    }

    if (jobNames.has(job.name)) {
      throw new Error(`Duplicate job name '${job.name}' in pipeline '${pipeline.name}'`);
    }
    jobNames.add(job.name);

    if (!job.runner) {
      throw new Error(`Job '${job.name}' must have a 'runner' property`);
    }

    if (!job.runner.image) {
      throw new Error(`Job '${job.name}' runner must have an 'image' property`);
    }

    if (!job.steps || job.steps.length === 0) {
      throw new Error(`Job '${job.name}' must have at least one step`);
    }

    // Validate dependsOn references
    if (job.dependsOn) {
      for (const dep of job.dependsOn) {
        if (!jobNames.has(dep) && !pipeline.jobs.some((j) => j.name === dep)) {
          throw new Error(`Job '${job.name}' depends on unknown job '${dep}'`);
        }
      }
    }
  }
}

/**
 * Create a default config context for local runs
 */
export function createDefaultContext(
  overrides: Partial<ConfigContext> = {}
): ConfigContext {
  return {
    branch: "main",
    sha: "local",
    env: Bun.env as Record<string, string>,
    isPullRequest: false,
    repo: {
      owner: "local",
      name: "local",
      url: "",
    },
    event: { type: "manual", inputs: {} },
    ...overrides,
  };
}

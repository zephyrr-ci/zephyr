import { describe, test, expect } from "bun:test";
import {
  defineConfig,
  defineJob,
  defineStep,
  definePipeline,
  secret,
  output,
  matrix,
  needs,
} from "./index";
import type { ZephyrConfig, JobDefinition, StepDefinition, PipelineDefinition } from "@zephyr-ci/types";

describe("defineConfig", () => {
  test("returns config unchanged", () => {
    const config: ZephyrConfig = {
      project: {
        name: "test-project",
      },
      pipelines: [],
    };

    const result = defineConfig(config);

    expect(result).toBe(config);
  });

  test("provides type safety for config", () => {
    const config = defineConfig({
      project: {
        name: "test-project",
        description: "A test project",
        env: {
          NODE_ENV: "test",
        },
      },
      pipelines: [
        {
          name: "ci",
          triggers: [{ type: "push", branches: ["main"] }],
          jobs: [],
        },
      ],
    });

    expect(config.project.name).toBe("test-project");
    expect(config.pipelines).toHaveLength(1);
  });
});

describe("defineJob", () => {
  test("returns job unchanged", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [],
    };

    const result = defineJob(job);

    expect(result).toBe(job);
  });

  test("provides type safety for job", () => {
    const job = defineJob({
      name: "test",
      description: "Run tests",
      runner: { image: "ubuntu-22.04", cpu: 2, memory: 2048 },
      steps: [
        { type: "run", name: "Test", run: "bun test" },
      ],
      timeout: 3600,
      env: {
        CI: "true",
      },
    });

    expect(job.name).toBe("test");
    expect(job.runner.cpu).toBe(2);
  });
});

describe("defineStep", () => {
  test("returns step unchanged", () => {
    const step: StepDefinition = {
      type: "run",
      name: "Test",
      run: "bun test",
    };

    const result = defineStep(step);

    expect(result).toBe(step);
  });

  test("provides type safety for run step", () => {
    const step = defineStep({
      type: "run",
      name: "Test",
      id: "test-step",
      run: "bun test",
      env: {
        CI: "true",
      },
      continueOnError: true,
    });

    expect(step.type).toBe("run");
    expect(step.id).toBe("test-step");
  });

  test("provides type safety for setup step", () => {
    const step = defineStep({
      type: "setup",
      name: "Setup Node",
      runtime: "node",
      version: "20",
    });

    expect(step.type).toBe("setup");
    if (step.type === "setup") {
      expect(step.runtime).toBe("node");
    }
  });
});

describe("definePipeline", () => {
  test("returns pipeline unchanged", () => {
    const pipeline: PipelineDefinition = {
      name: "ci",
      triggers: [{ type: "push" }],
      jobs: [],
    };

    const result = definePipeline(pipeline);

    expect(result).toBe(pipeline);
  });

  test("provides type safety for pipeline", () => {
    const pipeline = definePipeline({
      name: "ci",
      triggers: [
        { type: "push", branches: ["main", "develop"] },
        { type: "pull_request", prEvents: ["opened", "synchronize"] },
      ],
      jobs: [
        {
          name: "test",
          runner: { image: "ubuntu-22.04" },
          steps: [],
        },
      ],
      env: {
        CI: "true",
      },
    });

    expect(pipeline.name).toBe("ci");
    expect(pipeline.triggers).toHaveLength(2);
  });
});

describe("secret", () => {
  test("returns secret reference placeholder", () => {
    const result = secret("production/api-key");

    expect(result).toBe("${{ secrets.production/api-key }}");
  });

  test("works in env configuration", () => {
    const env = {
      API_KEY: secret("api-key"),
      DATABASE_URL: secret("db-url"),
    };

    expect(env.API_KEY).toBe("${{ secrets.api-key }}");
    expect(env.DATABASE_URL).toBe("${{ secrets.db-url }}");
  });
});

describe("output", () => {
  test("returns step output reference placeholder", () => {
    const result = output("build", "version");

    expect(result).toBe("${{ steps.build.outputs.version }}");
  });

  test("works in env configuration", () => {
    const env = {
      VERSION: output("build", "version"),
      ARTIFACT_URL: output("upload", "url"),
    };

    expect(env.VERSION).toBe("${{ steps.build.outputs.version }}");
    expect(env.ARTIFACT_URL).toBe("${{ steps.upload.outputs.url }}");
  });
});

describe("matrix", () => {
  test("returns matrix value reference placeholder", () => {
    const result = matrix("node-version");

    expect(result).toBe("${{ matrix.node-version }}");
  });

  test("works in step configuration", () => {
    const step = defineStep({
      type: "run",
      name: `Test Node ${matrix("node")}`,
      run: `node --version && bun test`,
    });

    expect(step.name).toBe("Test Node ${{ matrix.node }}");
  });
});

describe("needs", () => {
  test("returns job output reference placeholder", () => {
    const result = needs("build", "artifact-url");

    expect(result).toBe("${{ needs.build.outputs.artifact-url }}");
  });

  test("works in env configuration", () => {
    const env = {
      BUILD_URL: needs("build", "url"),
      BUILD_VERSION: needs("build", "version"),
    };

    expect(env.BUILD_URL).toBe("${{ needs.build.outputs.url }}");
    expect(env.BUILD_VERSION).toBe("${{ needs.build.outputs.version }}");
  });
});

describe("integration - full config example", () => {
  test("creates complete config with all helpers", () => {
    const config = defineConfig({
      project: {
        name: "my-app",
        env: {
          CI: "true",
        },
      },
      pipelines: [
        definePipeline({
          name: "ci",
          triggers: [{ type: "push", branches: ["main"] }],
          jobs: [
            defineJob({
              name: "test",
              runner: { image: "ubuntu-22.04" },
              matrix: {
                values: {
                  node: ["18", "20"],
                },
              },
              env: {
                NODE_VERSION: matrix("node"),
                API_KEY: secret("api-key"),
              },
              steps: [
                defineStep({
                  type: "setup",
                  name: "Setup Node",
                  runtime: "node",
                  version: matrix("node"),
                }),
                defineStep({
                  type: "run",
                  name: "Test",
                  id: "test",
                  run: "bun test",
                }),
              ],
            }),
            defineJob({
              name: "deploy",
              dependsOn: ["test"],
              runner: { image: "ubuntu-22.04" },
              env: {
                TEST_OUTPUT: needs("test", "result"),
              },
              steps: [
                defineStep({
                  type: "run",
                  name: "Deploy",
                  run: "echo Deploying...",
                }),
              ],
            }),
          ],
        }),
      ],
    });

    expect(config.project.name).toBe("my-app");
    
    if (Array.isArray(config.pipelines)) {
      expect(config.pipelines).toHaveLength(1);
      const pipeline = config.pipelines[0];
      expect(pipeline?.jobs).toHaveLength(2);
      expect(pipeline?.jobs[0]?.matrix).toBeDefined();
      expect(pipeline?.jobs[1]?.dependsOn).toEqual(["test"]);
    }
  });
});

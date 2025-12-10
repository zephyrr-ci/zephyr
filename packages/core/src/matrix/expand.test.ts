import { describe, test, expect } from "bun:test";
import {
  expandMatrix,
  expandPipelineJobs,
  interpolateMatrix,
  applyMatrixToEnv,
  getMatrixParallelism,
  hasMatrix,
} from "./expand";
import type { JobDefinition } from "@zephyr-ci/types";

describe("expandMatrix", () => {
  test("returns single job instance when no matrix", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [{ type: "run", name: "Test", run: "bun test" }],
    };

    const result = expandMatrix(job);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      job,
      matrix: null,
      instanceId: "test",
      displayName: "test",
    });
  });

  test("expands simple matrix with one dimension", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [{ type: "run", name: "Test", run: "bun test" }],
      matrix: {
        values: {
          node: ["18", "20", "22"],
        },
      },
    };

    const result = expandMatrix(job);

    expect(result).toHaveLength(3);
    expect(result[0]?.displayName).toBe("test (node=18)");
    expect(result[1]?.displayName).toBe("test (node=20)");
    expect(result[2]?.displayName).toBe("test (node=22)");
    expect(result[0]?.matrix?.values).toEqual({ node: "18" });
  });

  test("expands matrix with multiple dimensions", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [{ type: "run", name: "Test", run: "bun test" }],
      matrix: {
        values: {
          os: ["ubuntu", "alpine"],
          node: ["18", "20"],
        },
      },
    };

    const result = expandMatrix(job);

    expect(result).toHaveLength(4);
    expect(result.map((r) => r.matrix?.values)).toEqual([
      { os: "ubuntu", node: "18" },
      { os: "ubuntu", node: "20" },
      { os: "alpine", node: "18" },
      { os: "alpine", node: "20" },
    ]);
  });

  test("applies exclusions correctly", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [{ type: "run", name: "Test", run: "bun test" }],
      matrix: {
        values: {
          os: ["ubuntu", "alpine"],
          node: ["18", "20"],
        },
        exclude: [{ os: "alpine", node: "18" }],
      },
    };

    const result = expandMatrix(job);

    expect(result).toHaveLength(3);
    expect(result.find((r) => r.matrix?.values.os === "alpine" && r.matrix?.values.node === "18")).toBeUndefined();
  });

  test("applies inclusions correctly", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [{ type: "run", name: "Test", run: "bun test" }],
      matrix: {
        values: {
          os: ["ubuntu"],
          node: ["18"],
        },
        include: [{ os: "alpine", node: "20" }],
      },
    };

    const result = expandMatrix(job);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.matrix?.values.os === "alpine" && r.matrix?.values.node === "20")).toBeDefined();
  });

  test("handles mixed types in matrix values", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [{ type: "run", name: "Test", run: "bun test" }],
      matrix: {
        values: {
          version: [18, 20],
          experimental: [true, false],
        },
      },
    };

    const result = expandMatrix(job);

    expect(result).toHaveLength(4);
    expect(result[0]?.matrix?.values).toEqual({ version: 18, experimental: true });
  });
});

describe("expandPipelineJobs", () => {
  test("expands multiple jobs with and without matrices", () => {
    const jobs: JobDefinition[] = [
      {
        name: "lint",
        runner: { image: "ubuntu-22.04" },
        steps: [{ type: "run", name: "Lint", run: "bun lint" }],
      },
      {
        name: "test",
        runner: { image: "ubuntu-22.04" },
        steps: [{ type: "run", name: "Test", run: "bun test" }],
        matrix: {
          values: {
            node: ["18", "20"],
          },
        },
      },
    ];

    const result = expandPipelineJobs(jobs);

    expect(result).toHaveLength(3);
    expect(result[0]?.displayName).toBe("lint");
    expect(result[1]?.displayName).toBe("test (node=18)");
    expect(result[2]?.displayName).toBe("test (node=20)");
  });
});

describe("interpolateMatrix", () => {
  test("replaces matrix variables in text", () => {
    const matrix = { node: "18", os: "ubuntu" };
    const text = "Node version: ${{ matrix.node }}, OS: ${{ matrix.os }}";

    const result = interpolateMatrix(text, matrix);

    expect(result).toBe("Node version: 18, OS: ubuntu");
  });

  test("handles missing matrix values", () => {
    const matrix = { node: "18" };
    const text = "Node: ${{ matrix.node }}, Missing: ${{ matrix.missing }}";

    const result = interpolateMatrix(text, matrix);

    expect(result).toBe("Node: 18, Missing: ");
  });

  test("handles numbers and booleans", () => {
    const matrix = { port: 8080, debug: true };
    const text = "Port: ${{ matrix.port }}, Debug: ${{ matrix.debug }}";

    const result = interpolateMatrix(text, matrix);

    expect(result).toBe("Port: 8080, Debug: true");
  });
});

describe("applyMatrixToEnv", () => {
  test("interpolates matrix values in env vars", () => {
    const env = {
      NODE_VERSION: "${{ matrix.node }}",
      OS: "${{ matrix.os }}",
    };
    const matrix = { node: "18", os: "ubuntu" };

    const result = applyMatrixToEnv(env, matrix);

    expect(result.NODE_VERSION).toBe("18");
    expect(result.OS).toBe("ubuntu");
  });

  test("adds MATRIX_ prefixed environment variables", () => {
    const env = {};
    const matrix = { node: "18", experimental: true };

    const result = applyMatrixToEnv(env, matrix);

    expect(result.MATRIX_NODE).toBe("18");
    expect(result.MATRIX_EXPERIMENTAL).toBe("true");
  });

  test("combines interpolation and MATRIX_ vars", () => {
    const env = {
      CUSTOM: "Node ${{ matrix.node }}",
    };
    const matrix = { node: "20" };

    const result = applyMatrixToEnv(env, matrix);

    expect(result.CUSTOM).toBe("Node 20");
    expect(result.MATRIX_NODE).toBe("20");
  });
});

describe("getMatrixParallelism", () => {
  test("returns maxParallel if specified", () => {
    const matrix = {
      values: {
        node: ["18", "20", "22"],
      },
      maxParallel: 2,
    };

    const result = getMatrixParallelism(matrix);

    expect(result).toBe(2);
  });

  test("returns total combinations if maxParallel not specified", () => {
    const matrix = {
      values: {
        os: ["ubuntu", "alpine"],
        node: ["18", "20"],
      },
    };

    const result = getMatrixParallelism(matrix);

    expect(result).toBe(4);
  });
});

describe("hasMatrix", () => {
  test("returns true when job has matrix", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [],
      matrix: {
        values: {
          node: ["18", "20"],
        },
      },
    };

    expect(hasMatrix(job)).toBe(true);
  });

  test("returns false when job has no matrix", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [],
    };

    expect(hasMatrix(job)).toBe(false);
  });

  test("returns false when matrix has no values", () => {
    const job: JobDefinition = {
      name: "test",
      runner: { image: "ubuntu-22.04" },
      steps: [],
      matrix: {
        values: {},
      },
    };

    expect(hasMatrix(job)).toBe(false);
  });
});

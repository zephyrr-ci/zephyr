import { describe, test, expect } from "bun:test";
import {
  buildDag,
  getDagState,
  markJobRunning,
  markJobCompleted,
  cancelAllJobs,
  isDagComplete,
  hasDagFailures,
  getTopologicalOrder,
  getParallelLayers,
  type DagNode,
} from "./dag";

describe("buildDag", () => {
  test("builds DAG from job definitions", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
    ];

    const dag = buildDag(jobs);

    expect(dag.size).toBe(2);
    expect(dag.get("job1")?.status).toBe("ready");
    expect(dag.get("job2")?.status).toBe("pending");
  });

  test("marks jobs with no dependencies as ready", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: [] },
      { id: "job3", name: "Job 3", dependsOn: ["job1"] },
    ];

    const dag = buildDag(jobs);

    expect(dag.get("job1")?.status).toBe("ready");
    expect(dag.get("job2")?.status).toBe("ready");
    expect(dag.get("job3")?.status).toBe("pending");
  });
});

describe("validateDag", () => {
  test("throws on missing dependency", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: ["nonexistent"] },
    ];

    expect(() => {
      buildDag(jobs);
    }).toThrow("depends on unknown job");
  });

  test("throws on circular dependency", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: ["job2"] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
    ];

    expect(() => {
      buildDag(jobs);
    }).toThrow("Circular dependency detected");
  });

  test("throws on self-dependency", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: ["job1"] },
    ];

    expect(() => {
      buildDag(jobs);
    }).toThrow("Circular dependency detected");
  });

  test("accepts valid DAG", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
      { id: "job3", name: "Job 3", dependsOn: ["job1"] },
      { id: "job4", name: "Job 4", dependsOn: ["job2", "job3"] },
    ];

    expect(() => {
      buildDag(jobs);
    }).not.toThrow();
  });
});

describe("getDagState", () => {
  test("returns correct state categorization", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
      { id: "job3", name: "Job 3", dependsOn: [] },
    ];

    const dag = buildDag(jobs);
    const state = getDagState(dag);

    expect(state.ready).toContain("job1");
    expect(state.ready).toContain("job3");
    expect(state.pending).toContain("job2");
    expect(state.running).toHaveLength(0);
    expect(state.completed).toHaveLength(0);
    expect(state.failed).toHaveLength(0);
  });
});

describe("markJobRunning", () => {
  test("marks ready job as running", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");

    expect(dag.get("job1")?.status).toBe("running");
  });

  test("throws when marking non-ready job as running", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
    ];

    const dag = buildDag(jobs);

    expect(() => {
      markJobRunning(dag, "job2");
    }).toThrow("is not ready to run");
  });

  test("throws when job not found", () => {
    const jobs: DagNode[] = [];
    const dag = buildDag(jobs);

    expect(() => {
      markJobRunning(dag, "nonexistent");
    }).toThrow("Job not found");
  });
});

describe("markJobCompleted", () => {
  test("marks job as success and unblocks dependents", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
      { id: "job3", name: "Job 3", dependsOn: ["job1"] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");
    const newlyReady = markJobCompleted(dag, "job1", true);

    expect(dag.get("job1")?.status).toBe("success");
    expect(dag.get("job2")?.status).toBe("ready");
    expect(dag.get("job3")?.status).toBe("ready");
    expect(newlyReady).toContain("job2");
    expect(newlyReady).toContain("job3");
  });

  test("marks job as failure and skips dependents", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
      { id: "job3", name: "Job 3", dependsOn: ["job2"] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");
    markJobCompleted(dag, "job1", false);

    expect(dag.get("job1")?.status).toBe("failure");
    expect(dag.get("job2")?.status).toBe("skipped");
    expect(dag.get("job3")?.status).toBe("skipped");
  });

  test("only marks ready when all dependencies complete", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: [] },
      { id: "job3", name: "Job 3", dependsOn: ["job1", "job2"] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");
    markJobCompleted(dag, "job1", true);

    expect(dag.get("job3")?.status).toBe("pending");

    markJobRunning(dag, "job2");
    markJobCompleted(dag, "job2", true);

    expect(dag.get("job3")?.status).toBe("ready");
  });
});

describe("cancelAllJobs", () => {
  test("cancels all pending and ready jobs", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: [] },
      { id: "job3", name: "Job 3", dependsOn: ["job1"] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");
    cancelAllJobs(dag);

    expect(dag.get("job1")?.status).toBe("running"); // Still running
    expect(dag.get("job2")?.status).toBe("cancelled");
    expect(dag.get("job3")?.status).toBe("cancelled");
  });
});

describe("isDagComplete", () => {
  test("returns false when jobs are pending", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
    ];

    const dag = buildDag(jobs);

    expect(isDagComplete(dag)).toBe(false);
  });

  test("returns false when jobs are running", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");

    expect(isDagComplete(dag)).toBe(false);
  });

  test("returns true when all jobs are complete", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");
    markJobCompleted(dag, "job1", true);
    markJobRunning(dag, "job2");
    markJobCompleted(dag, "job2", true);

    expect(isDagComplete(dag)).toBe(true);
  });
});

describe("hasDagFailures", () => {
  test("returns false when no failures", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");
    markJobCompleted(dag, "job1", true);

    expect(hasDagFailures(dag)).toBe(false);
  });

  test("returns true when job fails", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
    ];

    const dag = buildDag(jobs);
    markJobRunning(dag, "job1");
    markJobCompleted(dag, "job1", false);

    expect(hasDagFailures(dag)).toBe(true);
  });
});

describe("getTopologicalOrder", () => {
  test("returns jobs in topological order", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
      { id: "job3", name: "Job 3", dependsOn: ["job2"] },
    ];

    const dag = buildDag(jobs);
    const order = getTopologicalOrder(dag);

    expect(order).toEqual(["job1", "job2", "job3"]);
  });

  test("handles diamond dependency", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: ["job1"] },
      { id: "job3", name: "Job 3", dependsOn: ["job1"] },
      { id: "job4", name: "Job 4", dependsOn: ["job2", "job3"] },
    ];

    const dag = buildDag(jobs);
    const order = getTopologicalOrder(dag);

    expect(order[0]).toBe("job1");
    expect(order[3]).toBe("job4");
    expect(order.indexOf("job2")).toBeLessThan(order.indexOf("job4"));
    expect(order.indexOf("job3")).toBeLessThan(order.indexOf("job4"));
  });
});

describe("getParallelLayers", () => {
  test("groups independent jobs in same layer", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: [] },
      { id: "job3", name: "Job 3", dependsOn: ["job1", "job2"] },
    ];

    const dag = buildDag(jobs);
    const layers = getParallelLayers(dag);

    expect(layers).toHaveLength(2);
    expect(layers[0]).toContain("job1");
    expect(layers[0]).toContain("job2");
    expect(layers[1]).toEqual(["job3"]);
  });

  test("handles complex dependency graph", () => {
    const jobs: DagNode[] = [
      { id: "job1", name: "Job 1", dependsOn: [] },
      { id: "job2", name: "Job 2", dependsOn: [] },
      { id: "job3", name: "Job 3", dependsOn: ["job1"] },
      { id: "job4", name: "Job 4", dependsOn: ["job2"] },
      { id: "job5", name: "Job 5", dependsOn: ["job3", "job4"] },
    ];

    const dag = buildDag(jobs);
    const layers = getParallelLayers(dag);

    expect(layers).toHaveLength(3);
    expect(layers[0]).toHaveLength(2);
    expect(layers[1]).toHaveLength(2);
    expect(layers[2]).toEqual(["job5"]);
  });
});

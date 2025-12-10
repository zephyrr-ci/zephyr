import { describe, test, expect } from "bun:test";
import { resolvePipelines, createDefaultContext } from "./loader";
import type { ZephyrConfig, ConfigContext } from "@zephyrr-ci/types";

describe("resolvePipelines", () => {
  test("returns static pipeline array", () => {
    const config: ZephyrConfig = {
      project: { name: "test" },
      pipelines: [
        {
          name: "ci",
          triggers: [{ type: "push" }],
          jobs: [
            {
              name: "test",
              runner: { image: "ubuntu-22.04" },
              steps: [{ type: "run", name: "Test", run: "bun test" }],
            },
          ],
        },
      ],
    };

    const context: ConfigContext = createDefaultContext();
    const pipelines = resolvePipelines(config, context);

    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.name).toBe("ci");
  });

  test("resolves dynamic pipelines function", () => {
    const config: ZephyrConfig = {
      project: { name: "test" },
      pipelines: (ctx) => {
        if (ctx.branch === "main") {
          return [
            {
              name: "production",
              triggers: [{ type: "push" }],
              jobs: [
                {
                  name: "deploy",
                  runner: { image: "ubuntu-22.04" },
                  steps: [{ type: "run", name: "Deploy", run: "echo deploying" }],
                },
              ],
            },
          ];
        }
        return [
          {
            name: "development",
            triggers: [{ type: "push" }],
            jobs: [
              {
                name: "test",
                runner: { image: "ubuntu-22.04" },
                steps: [{ type: "run", name: "Test", run: "bun test" }],
              },
            ],
          },
        ];
      },
    };

    const mainContext: ConfigContext = createDefaultContext({ branch: "main" });
    const mainPipelines = resolvePipelines(config, mainContext);

    expect(mainPipelines).toHaveLength(1);
    expect(mainPipelines[0]?.name).toBe("production");

    const devContext: ConfigContext = createDefaultContext({ branch: "develop" });
    const devPipelines = resolvePipelines(config, devContext);

    expect(devPipelines).toHaveLength(1);
    expect(devPipelines[0]?.name).toBe("development");
  });

  test("handles context-based pipeline selection", () => {
    const config: ZephyrConfig = {
      project: { name: "test" },
      pipelines: (ctx) => {
        const pipelines: any[] = [];

        // Always include CI pipeline
        pipelines.push({
          name: "ci",
          triggers: [{ type: "push" as const }],
          jobs: [
            {
              name: "test",
              runner: { image: "ubuntu-22.04" as const },
              steps: [{ type: "run" as const, name: "Test", run: "bun test" }],
            },
          ],
        });

        // Add deploy pipeline for PRs
        if (ctx.isPullRequest) {
          pipelines.push({
            name: "preview",
            triggers: [{ type: "pull_request" as const }],
            jobs: [
              {
                name: "preview-deploy",
                runner: { image: "ubuntu-22.04" as const },
                steps: [{ type: "run" as const, name: "Deploy Preview", run: "echo preview" }],
              },
            ],
          });
        }

        return pipelines;
      },
    };

    const prContext: ConfigContext = createDefaultContext({ isPullRequest: true, prNumber: 123 });
    const prPipelines = resolvePipelines(config, prContext);

    expect(prPipelines).toHaveLength(2);
    expect(prPipelines.map((p) => p.name)).toEqual(["ci", "preview"]);

    const nonPrContext: ConfigContext = createDefaultContext({ isPullRequest: false });
    const nonPrPipelines = resolvePipelines(config, nonPrContext);

    expect(nonPrPipelines).toHaveLength(1);
    expect(nonPrPipelines[0]?.name).toBe("ci");
  });
});

describe("createDefaultContext", () => {
  test("creates default context with sensible defaults", () => {
    const context = createDefaultContext();

    expect(context.branch).toBe("main");
    expect(context.sha).toBe("local");
    expect(context.isPullRequest).toBe(false);
    expect(context.repo.owner).toBe("local");
    expect(context.repo.name).toBe("local");
    expect(context.event.type).toBe("manual");
  });

  test("allows overriding defaults", () => {
    const context = createDefaultContext({
      branch: "develop",
      sha: "abc123",
      isPullRequest: true,
      prNumber: 42,
    });

    expect(context.branch).toBe("develop");
    expect(context.sha).toBe("abc123");
    expect(context.isPullRequest).toBe(true);
    expect(context.prNumber).toBe(42);
  });

  test("includes environment variables", () => {
    const context = createDefaultContext();

    expect(context.env).toBeDefined();
    expect(typeof context.env).toBe("object");
  });

  test("merges repo information correctly", () => {
    const context = createDefaultContext({
      repo: {
        owner: "myorg",
        name: "myrepo",
        url: "https://github.com/myorg/myrepo",
      },
    });

    expect(context.repo.owner).toBe("myorg");
    expect(context.repo.name).toBe("myrepo");
    expect(context.repo.url).toBe("https://github.com/myorg/myrepo");
  });

  test("handles custom event types", () => {
    const context = createDefaultContext({
      event: { type: "push", branch: "main", sha: "abc123" },
    });

    expect(context.event.type).toBe("push");
    if (context.event.type === "push") {
      expect(context.event.branch).toBe("main");
      expect(context.event.sha).toBe("abc123");
    }
  });
});

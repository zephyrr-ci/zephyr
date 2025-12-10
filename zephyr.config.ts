import type { ZephyrConfig } from "./packages/types/src/config.ts";

export default {
  project: {
    name: "zephyr",
  },

  pipelines: [
    {
      name: "ci",
      triggers: [
        { type: "push", branches: ["main"] },
        { type: "pull_request" },
      ],
      jobs: [
        {
          name: "build-and-test",
          runner: { image: "ubuntu-22.04" },
          steps: [
            {
              type: "run",
              name: "Install dependencies",
              run: "bun install",
            },
            {
              type: "run",
              name: "Typecheck",
              run: "bun run typecheck",
            },
            {
              type: "run",
              name: "Build",
              run: "bun run build",
            },
            {
              type: "run",
              name: "Run tests",
              run: "bun test",
            },
          ],
        },
      ],
    },
  ],
} satisfies ZephyrConfig;

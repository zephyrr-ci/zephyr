/**
 * Initialize a new Zephyr config file in the current directory
 */

const TEMPLATE = `import { defineConfig } from "@zephyrr-ci/config";

export default defineConfig({
  project: {
    name: "{{PROJECT_NAME}}",
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
              name: "Run tests",
              run: "bun test",
            },
          ],
        },
      ],
    },
  ],
});
`;

export interface InitOptions {
  cwd?: string;
  force?: boolean;
}

export async function init(options: InitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = `${cwd}/zephyr.config.ts`;

  // Check if config already exists
  const existingFile = Bun.file(configPath);
  if ((await existingFile.exists()) && !options.force) {
    console.error(
      "\x1b[31mError:\x1b[0m zephyr.config.ts already exists. Use --force to overwrite."
    );
    process.exit(1);
  }

  // Get project name from directory
  const projectName = cwd.split("/").pop() ?? "my-project";

  // Generate config
  const config = TEMPLATE.replace("{{PROJECT_NAME}}", projectName);

  // Write config file
  await Bun.write(configPath, config);

  console.log("\x1b[32m✓\x1b[0m Created zephyr.config.ts");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit zephyr.config.ts to customize your pipeline");
  console.log("  2. Run \x1b[36mzephyr run\x1b[0m to execute your pipeline locally");
}

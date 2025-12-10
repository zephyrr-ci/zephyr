# Zephyr CI

A TypeScript-first CI runner built on Bun that uses Firecracker microVMs for secure, isolated job execution.

## Features

- **TypeScript Config** - Fully typed `zephyr.config.ts`, no YAML
- **Firecracker microVMs** - Hardware-level isolation with ~125ms boot time
- **Standalone System** - Custom workflow format, not tied to GitHub Actions
- **Fast** - Built on Bun for maximum performance
- **Self-hosted** - Run on your own infrastructure

## Quick Start

### Installation

```bash
# Configure npm to use GitHub Packages for @zephyr-ci scope
echo "@zephyr-ci:registry=https://npm.pkg.github.com" >> ~/.npmrc

# Install the CLI globally
bun add -g @zephyrr-ci/cli

# Or add to your project
bun add -D @zephyrr-ci/cli @zephyrr-ci/config
```

For server deployment, see [docs/deployment.md](docs/deployment.md).

### Initialize a Project

```bash
# Create a zephyr.config.ts in your project
bun run zephyr init
```

This creates a `zephyr.config.ts`:

```typescript
import { defineConfig } from '@zephyrr-ci/config';

export default defineConfig({
  project: {
    name: 'my-project',
  },

  pipelines: [
    {
      name: 'ci',
      triggers: [
        { type: 'push', branches: ['main'] },
        { type: 'pull_request' },
      ],
      jobs: [
        {
          name: 'build-and-test',
          runner: { image: 'ubuntu-22.04', cpu: 2, memory: 4096 },
          steps: [
            { type: 'run', name: 'Install', run: 'bun install' },
            { type: 'run', name: 'Test', run: 'bun test' },
          ],
        },
      ],
    },
  ],
});
```

### Run Locally

```bash
# Run the default pipeline locally (shell execution)
bun run zephyr run

# Run a specific pipeline
bun run zephyr run --pipeline ci

# Run a specific job
bun run zephyr run --job build-and-test
```

### Start the Server

For webhook triggers, REST API, and the web UI:

```bash
# Start the API server (default port 3000)
bun run zephyr server

# Start the web UI (default port 8080)
bun run zephyr ui
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ZEPHYR SERVER                            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ Webhook API  │  │  REST API    │  │ WebSocket (logs)   │    │
│  └──────┬───────┘  └──────┬───────┘  └─────────┬──────────┘    │
│         └─────────────────┼────────────────────┘               │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    JOB SCHEDULER                         │   │
│  │              (SQLite queue + dispatcher)                 │   │
│  └───────────────────────┬─────────────────────────────────┘   │
└──────────────────────────┼──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       VM MANAGER                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐     │
│  │  Warm Pool  │  │  Network    │  │  Image Manager      │     │
│  │  (idle VMs) │  │  (TAP/bridge)│  │  (rootfs/kernels)  │     │
│  └─────────────┘  └─────────────┘  └─────────────────────┘     │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ microVM  │  │ microVM  │  │ microVM  │  │ microVM  │        │
│  │ (job 1)  │  │ (job 2)  │  │ (idle)   │  │ (idle)   │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@zephyrr-ci/cli` | Command-line interface |
| `@zephyrr-ci/core` | Config loader, executor, scheduler |
| `@zephyrr-ci/server` | HTTP API, webhooks, job queue |
| `@zephyrr-ci/vm` | Firecracker VM management |
| `@zephyrr-ci/storage` | SQLite database, caching, secrets |
| `@zephyrr-ci/web` | Web dashboard UI |
| `@zephyrr-ci/types` | TypeScript type definitions |
| `@zephyrr-ci/config` | Config helpers (`defineConfig`) |

## CLI Commands

```bash
zephyr init              # Initialize a new project
zephyr run               # Run pipeline locally
zephyr server            # Start the API server
zephyr ui                # Start the web UI
zephyr trigger           # Trigger a pipeline via API
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/metrics` | GET | Prometheus metrics |
| `/webhooks/github` | POST | GitHub webhook |
| `/api/v1/projects` | GET, POST | List/create projects |
| `/api/v1/runs` | GET | List pipeline runs |
| `/api/v1/trigger` | POST | Trigger a pipeline |
| `/api/v1/jobs/:id` | GET | Get job details |
| `/api/v1/jobs/:id/logs` | GET | Get job logs |
| `/ws` | WebSocket | Real-time log streaming |

## VM Execution (Linux only)

For isolated VM execution, you need:

1. Linux with KVM support (`/dev/kvm`)
2. Firecracker installed
3. VM images built

```bash
# Build VM images (requires Docker and sudo)
bun run build:images

# This creates:
# - images/kernels/vmlinux (Linux kernel)
# - images/rootfs/alpine-rootfs.ext4 (Alpine rootfs with agent)
```

See [docs/deployment.md](docs/deployment.md) for full deployment instructions.

## Configuration Reference

See [docs/configuration.md](docs/configuration.md) for the full configuration reference.

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Build
bun run build
```

## Requirements

- **Runtime**: [Bun](https://bun.sh) v1.0+
- **VM Execution**: Linux with KVM, Firecracker v1.0+
- **Local Execution**: Any OS (macOS, Linux, Windows via WSL)

## License

MIT

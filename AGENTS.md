# Zephyr CI - Agent Guidelines

## Build & Test Commands
- `bun test` - Run all tests across workspaces
- `bun test <file>` - Run a single test file (e.g., `bun test packages/core/src/config/loader.test.ts`)
- `bun test -t "test name"` - Run tests matching a pattern
- `bun run typecheck` - Type check all packages
- `bun run build` - Build CLI
- `bun run zephyr` - Run CLI locally

## Architecture
- Monorepo with Bun workspaces: `packages/*` and `agent/`
- TypeScript ESM-only with `.ts` extensions in imports
- Core packages: `@zephyr-ci/{types,config,core,storage,server,cli,web,vm}`

## Code Style
- **Imports**: Always use `.ts` extension (e.g., `from "./loader.ts"`). Group by: external, workspace (`@zephyr-ci/*`), relative
- **Types**: Import types with `type` keyword (e.g., `import type { ZephyrConfig } from "@zephyr-ci/types"`)
- **Exports**: Re-export from package `index.ts` with explicit named exports and type exports
- **Naming**: Use camelCase for functions/variables, PascalCase for types/interfaces, SCREAMING_SNAKE_CASE for constants
- **Error Handling**: Use try-catch for async, return result objects `{ success: boolean, error?: string }` for functions
- **Comments**: Use JSDoc for public APIs, inline comments for complex logic
- **Strict Mode**: All tsconfig strict flags enabled (`noUncheckedIndexedAccess`, `noImplicitOverride`, etc.)

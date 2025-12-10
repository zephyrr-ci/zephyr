import { describe, test, expect } from "bun:test";
import { interpolateCacheKey } from "./cache";

describe("interpolateCacheKey", () => {
  test("interpolates context variables", () => {
    const key = "node-${os}-${sha}";
    const context = {
      os: "ubuntu",
      sha: "abc123",
    };

    const result = interpolateCacheKey(key, context);

    expect(result).toBe("node-ubuntu-abc123");
  });

  test("handles missing variables with empty string", () => {
    const key = "cache-${branch}-${missing}";
    const context = {
      branch: "main",
    };

    const result = interpolateCacheKey(key, context);

    expect(result).toBe("cache-main-");
  });

  test("handles multiple occurrences of same variable", () => {
    const key = "${os}-${os}-test";
    const context = {
      os: "linux",
    };

    const result = interpolateCacheKey(key, context);

    expect(result).toBe("linux-linux-test");
  });

  test("handles key with no variables", () => {
    const key = "static-cache-key";
    const context = { sha: "abc123" };

    const result = interpolateCacheKey(key, context);

    expect(result).toBe("static-cache-key");
  });

  test("works with common cache key patterns", () => {
    const key = "node-modules-${runner}-${branch}-${sha}";
    const context = {
      runner: "ubuntu-22.04",
      branch: "main",
      sha: "a1b2c3d4",
    };

    const result = interpolateCacheKey(key, context);

    expect(result).toBe("node-modules-ubuntu-22.04-main-a1b2c3d4");
  });
});

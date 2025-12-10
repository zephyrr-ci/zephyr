import { describe, test, expect } from "bun:test";
import { maskSecrets, secretsToEnv, type SecretValue } from "./secrets";

describe("maskSecrets", () => {
  test("masks secret values in text", () => {
    const text = "API_KEY=secret123 DATABASE_URL=postgres://user:password@host";
    const secrets: SecretValue[] = [
      { name: "api-key", value: "secret123" },
      { name: "db-password", value: "password" },
    ];

    const result = maskSecrets(text, secrets);

    expect(result).toBe("API_KEY=*** DATABASE_URL=postgres://user:***@host");
  });

  test("does not mask short secrets (3 chars or less)", () => {
    const text = "KEY=abc VALUE=defgh";
    const secrets: SecretValue[] = [
      { name: "short", value: "abc" },
      { name: "long", value: "defgh" },
    ];

    const result = maskSecrets(text, secrets);

    expect(result).toBe("KEY=abc VALUE=***");
  });

  test("handles multiple occurrences of same secret", () => {
    const text = "token1: secret123, token2: secret123";
    const secrets: SecretValue[] = [{ name: "token", value: "secret123" }];

    const result = maskSecrets(text, secrets);

    expect(result).toBe("token1: ***, token2: ***");
  });

  test("handles empty secrets array", () => {
    const text = "some text with no secrets";
    const secrets: SecretValue[] = [];

    const result = maskSecrets(text, secrets);

    expect(result).toBe("some text with no secrets");
  });

  test("handles text with no matching secrets", () => {
    const text = "some public text";
    const secrets: SecretValue[] = [{ name: "secret", value: "hidden" }];

    const result = maskSecrets(text, secrets);

    expect(result).toBe("some public text");
  });
});

describe("secretsToEnv", () => {
  test("maps secrets to environment variables", () => {
    const secrets: SecretValue[] = [
      { name: "production/api-key", value: "key123" },
      { name: "production/db-url", value: "postgres://..." },
    ];

    const mapping = [
      { from: "production/api-key", as: "API_KEY" },
      { from: "production/db-url", as: "DATABASE_URL" },
    ];

    const result = secretsToEnv(secrets, mapping);

    expect(result).toEqual({
      API_KEY: "key123",
      DATABASE_URL: "postgres://...",
    });
  });

  test("ignores unmapped secrets", () => {
    const secrets: SecretValue[] = [
      { name: "secret1", value: "value1" },
      { name: "secret2", value: "value2" },
    ];

    const mapping = [{ from: "secret1", as: "SECRET_1" }];

    const result = secretsToEnv(secrets, mapping);

    expect(result).toEqual({
      SECRET_1: "value1",
    });
  });

  test("handles missing secrets in mapping", () => {
    const secrets: SecretValue[] = [{ name: "existing", value: "value" }];

    const mapping = [
      { from: "existing", as: "EXISTING" },
      { from: "missing", as: "MISSING" },
    ];

    const result = secretsToEnv(secrets, mapping);

    expect(result).toEqual({
      EXISTING: "value",
    });
  });

  test("handles empty mapping", () => {
    const secrets: SecretValue[] = [{ name: "secret", value: "value" }];
    const mapping: Array<{ from: string; as: string }> = [];

    const result = secretsToEnv(secrets, mapping);

    expect(result).toEqual({});
  });

  test("handles empty secrets array", () => {
    const secrets: SecretValue[] = [];
    const mapping = [{ from: "secret", as: "SECRET" }];

    const result = secretsToEnv(secrets, mapping);

    expect(result).toEqual({});
  });

  test("allows same secret mapped to multiple env vars", () => {
    const secrets: SecretValue[] = [{ name: "token", value: "abc123" }];

    const mapping = [
      { from: "token", as: "AUTH_TOKEN" },
      { from: "token", as: "API_TOKEN" },
    ];

    const result = secretsToEnv(secrets, mapping);

    expect(result).toEqual({
      AUTH_TOKEN: "abc123",
      API_TOKEN: "abc123",
    });
  });
});

import { z } from "zod";

const bool = (value: unknown) => String(value).toLowerCase() === "true";
const insecureValues = new Set([
  "change-this-immediately",
  "development-only-session-secret-change-me",
  "change-me-now",
  "replace-with-a-strong-random-password",
]);

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    DATABASE_URL: z
      .string()
      .default("postgres://gateway:gateway@localhost:5432/gateway"),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
    MASTER_ENCRYPTION_KEY: z.string().optional(),
    BOOTSTRAP_ADMIN_EMAIL: z.string().email().default("admin@example.local"),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().default("change-this-immediately"),
    SESSION_SECRET: z
      .string()
      .default("development-only-session-secret-change-me"),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:8080,http://localhost:5173"),
    SESSION_COOKIE_SECURE: z.preprocess(bool, z.boolean()).default(false),
    TRUST_PROXY: z.preprocess(bool, z.boolean()).default(false),
    MAX_BODY_BYTES: z.coerce.number().int().positive().default(10_485_760),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    DEFAULT_RATE_LIMIT_RPM: z.coerce.number().int().positive().default(120),
    DEFAULT_MONTHLY_SPEND_USD: z.coerce.number().nonnegative().default(100),
    OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    XAI_API_KEY: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;

    const requiredSecrets: Array<[string, string | undefined, number]> = [
      ["BOOTSTRAP_ADMIN_PASSWORD", value.BOOTSTRAP_ADMIN_PASSWORD, 16],
      ["SESSION_SECRET", value.SESSION_SECRET, 32],
      ["MASTER_ENCRYPTION_KEY", value.MASTER_ENCRYPTION_KEY, 32],
    ];
    for (const [name, secret, minimumLength] of requiredSecrets) {
      if (
        !secret ||
        secret.length < minimumLength ||
        insecureValues.has(secret)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} must be set to a strong, non-default value in production`,
        });
      }
    }
    if (
      /:(gateway|change-me-now|replace-with-a-strong-random-password)@/i.test(
        value.DATABASE_URL,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message:
          "DATABASE_URL must not use a known default password in production",
      });
    }
  });

export type AppConfig = z.infer<typeof schema> & { corsOrigins: string[] };

export function loadConfig(): AppConfig {
  const value = schema.parse(process.env);
  return {
    ...value,
    corsOrigins: value.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

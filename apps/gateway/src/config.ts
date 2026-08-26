import { z } from 'zod';
const bool=(v:unknown)=>String(v).toLowerCase()==='true';
const schema=z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'), HOST:z.string().default('0.0.0.0'), PORT:z.coerce.number().int().default(8080),
  DATABASE_URL:z.string().default('postgres://gateway:gateway@localhost:5432/gateway'), DATABASE_POOL_MAX:z.coerce.number().int().default(20),
  MASTER_ENCRYPTION_KEY:z.string().optional(), BOOTSTRAP_ADMIN_EMAIL:z.string().email().default('admin@example.local'), BOOTSTRAP_ADMIN_PASSWORD:z.string().default('change-this-immediately'),
  SESSION_SECRET:z.string().default('development-only-session-secret-change-me'), CORS_ORIGINS:z.string().default('http://localhost:8080,http://localhost:5173'), SESSION_COOKIE_SECURE:z.preprocess(bool,z.boolean()).default(false), TRUST_PROXY:z.preprocess(bool,z.boolean()).default(false),
  MAX_BODY_BYTES:z.coerce.number().int().default(10485760), REQUEST_TIMEOUT_MS:z.coerce.number().int().default(120000), STREAM_IDLE_TIMEOUT_MS:z.coerce.number().int().default(30000),
  DEFAULT_RATE_LIMIT_RPM:z.coerce.number().int().default(120), DEFAULT_MONTHLY_SPEND_USD:z.coerce.number().default(100), OLLAMA_BASE_URL:z.string().default('http://localhost:11434'),
  OPENAI_API_KEY:z.string().optional(), ANTHROPIC_API_KEY:z.string().optional(), GEMINI_API_KEY:z.string().optional(), XAI_API_KEY:z.string().optional(), DEEPSEEK_API_KEY:z.string().optional()
});
export type AppConfig=z.infer<typeof schema>&{corsOrigins:string[]};
export function loadConfig():AppConfig{const v=schema.parse(process.env);return {...v,corsOrigins:v.CORS_ORIGINS.split(',').map(x=>x.trim()).filter(Boolean)};}

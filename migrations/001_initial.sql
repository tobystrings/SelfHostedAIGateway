CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS user_roles (user_id uuid REFERENCES users(id) ON DELETE CASCADE, role_id uuid REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(user_id,role_id));
CREATE TABLE IF NOT EXISTS client_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL, key_prefix text NOT NULL, key_hash bytea NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['gateway:invoke']::text[], allowed_providers text[], allowed_models text[],
  expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, last_used_ip inet
);
CREATE INDEX IF NOT EXISTS client_api_keys_active_idx ON client_api_keys(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, kind text NOT NULL,
  display_name text NOT NULL, base_url text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  encrypted_credentials text, config jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_id text NOT NULL, alias text UNIQUE, display_name text, enabled boolean NOT NULL DEFAULT true,
  routing_priority integer NOT NULL DEFAULT 100, capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_window integer, max_output_tokens integer, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(provider_id,upstream_id)
);
CREATE INDEX IF NOT EXISTS models_enabled_priority_idx ON models(enabled,routing_priority);
CREATE TABLE IF NOT EXISTS pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  input_per_million_usd numeric(16,8), output_per_million_usd numeric(16,8), cached_input_per_million_usd numeric(16,8),
  effective_from timestamptz NOT NULL DEFAULT now(), effective_to timestamptz, source text
);
CREATE INDEX IF NOT EXISTS pricing_model_effective_idx ON pricing(model_id,effective_from DESC);
CREATE TABLE IF NOT EXISTS routing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL, enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100, match jsonb NOT NULL DEFAULT '{}'::jsonb, action jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL, subject_type text NOT NULL,
  subject_id uuid, daily_token_limit bigint, monthly_token_limit bigint, daily_spend_limit_usd numeric(16,8), monthly_spend_limit_usd numeric(16,8), enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), budget_id uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  api_key_id uuid, user_id uuid, estimated_tokens bigint NOT NULL DEFAULT 0, estimated_cost_usd numeric(16,8) NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'reserved', created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS budget_reservations_budget_state_idx ON budget_reservations(budget_id,state);
CREATE TABLE IF NOT EXISTS rate_limit_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL, subject_type text NOT NULL,
  subject_value text, requests_per_minute integer, tokens_per_minute bigint, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_start timestamptz NOT NULL, policy_id uuid NOT NULL REFERENCES rate_limit_policies(id) ON DELETE CASCADE,
  subject_value text NOT NULL, request_count integer NOT NULL DEFAULT 0, token_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(bucket_start,policy_id,subject_value)
);
CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE SET NULL, api_key_id uuid REFERENCES client_api_keys(id) ON DELETE SET NULL,
  requested_provider text, requested_model text, selected_provider text, selected_model text, routing_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL, streamed boolean NOT NULL DEFAULT false, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  latency_ms integer, error_code text
);
CREATE INDEX IF NOT EXISTS requests_started_idx ON requests(started_at DESC);
CREATE TABLE IF NOT EXISTS provider_attempts (
  id bigserial PRIMARY KEY, request_id uuid REFERENCES requests(id) ON DELETE CASCADE, attempt_number integer NOT NULL,
  provider text NOT NULL, model text NOT NULL, outcome text NOT NULL, failure_code text, retry_decision text, fallback_decision text,
  latency_ms integer, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_records (
  id bigserial PRIMARY KEY, request_id uuid REFERENCES requests(id) ON DELETE SET NULL, user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  api_key_id uuid REFERENCES client_api_keys(id) ON DELETE SET NULL, provider text NOT NULL, model text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0, cached_input_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0, estimated_cost_usd numeric(16,8) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_time_idx ON usage_records(created_at DESC);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY, actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL,
  resource_type text NOT NULL, resource_id text, result text NOT NULL, safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet, created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles(name) VALUES ('admin'),('operator'),('viewer') ON CONFLICT DO NOTHING;

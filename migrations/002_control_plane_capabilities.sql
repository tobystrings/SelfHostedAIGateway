ALTER TABLE models
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_error_category text,
  ADD COLUMN IF NOT EXISTS callable boolean,
  ADD COLUMN IF NOT EXISTS cost_classification text NOT NULL DEFAULT 'unknown';

DO $$ BEGIN
  ALTER TABLE models ADD CONSTRAINT models_verification_status_check
    CHECK (verification_status IN ('verified','unavailable','unauthorized','rate_limited','unsupported_verification','unverified'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE models ADD CONSTRAINT models_cost_classification_check
    CHECK (cost_classification IN ('free','paid','local','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS models_routable_idx
  ON models(enabled, callable, cost_classification, routing_priority);

CREATE TABLE IF NOT EXISTS gateway_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  default_routing_mode text NOT NULL DEFAULT 'NORMAL'
    CHECK (default_routing_mode IN ('NORMAL','FREE_ONLY','LOCAL_ONLY','CHEAPEST')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO gateway_settings(singleton, default_routing_mode)
VALUES (true, 'NORMAL') ON CONFLICT(singleton) DO NOTHING;

UPDATE models m SET cost_classification='local'
FROM providers p
WHERE m.provider_id=p.id AND p.kind='ollama' AND m.cost_classification='unknown';

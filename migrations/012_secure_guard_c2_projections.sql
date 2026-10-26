-- Secure Guard Phase 2: verified C2 metadata and customer-safe projections.
-- Raw C2 plans, DNSFilter responses, hostnames and agent UUIDs are never persisted here.

CREATE TABLE secure_guard_c2_receipt_projections (
  receipt_id                 UUID PRIMARY KEY REFERENCES secure_guard_receipts(id) ON DELETE RESTRICT,
  dnsfilter_organization_id  VARCHAR(64) NOT NULL,
  source_sha                 VARCHAR(64) NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  plan_hash                  VARCHAR(128) NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  object_generation          VARCHAR(64) NOT NULL CHECK (object_generation ~ '^[1-9][0-9]*$'),
  observed_at                TIMESTAMPTZ NOT NULL,
  completed_at               TIMESTAMPTZ NOT NULL,
  mode                       TEXT NOT NULL CHECK (mode = 'DryRun'),
  mutations                  INTEGER NOT NULL CHECK (mutations = 0),
  site_count                 INTEGER NOT NULL CHECK (site_count >= 0),
  agent_count                INTEGER NOT NULL CHECK (agent_count >= 0),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_secure_guard_c2_receipt_projections_observed
  ON secure_guard_c2_receipt_projections (observed_at DESC);

-- These rows contain only opaque display ordinals and safe state labels. They deliberately do
-- not contain the C2 plan's site ID, agent UUID, hostname, API response, or GCS object content.
CREATE TABLE secure_guard_c2_site_projections (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id                  UUID NOT NULL REFERENCES secure_guard_c2_receipt_projections(receipt_id) ON DELETE RESTRICT,
  display_order               INTEGER NOT NULL CHECK (display_order > 0),
  agent_count                 INTEGER NOT NULL CHECK (agent_count >= 0),
  UNIQUE (receipt_id, display_order)
);

CREATE TABLE secure_guard_c2_agent_projections (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id                  UUID NOT NULL REFERENCES secure_guard_c2_receipt_projections(receipt_id) ON DELETE RESTRICT,
  site_projection_id          UUID NOT NULL REFERENCES secure_guard_c2_site_projections(id) ON DELETE RESTRICT,
  display_order               INTEGER NOT NULL CHECK (display_order > 0),
  status                      VARCHAR(64) NOT NULL CHECK (status ~ '^[A-Za-z0-9._-]+$'),
  agent_state                 VARCHAR(64) NOT NULL CHECK (agent_state ~ '^[A-Za-z0-9._-]+$'),
  UNIQUE (receipt_id, display_order)
);

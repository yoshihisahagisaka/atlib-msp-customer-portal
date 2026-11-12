-- Secure Guard dedicated database Phase 3 extension.
-- Apply only through the dedicated migrations/secure_guard_runner.ts from SG DB PR #5.
-- Never run the legacy Portal migrations/runner.ts against secure_guard_staging.
-- A committed claim is NEVER automatically expired or released, including on timeout/UNKNOWN.
-- Manual investigation (not another API DELETE) is required after an ambiguous outcome.
CREATE TABLE secure_guard_agent_uninstall_claims (
  id UUID PRIMARY KEY,
  customer_organization_id UUID NOT NULL REFERENCES customer_organizations(id) ON DELETE RESTRICT,
  dnsfilter_organization_id VARCHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL REFERENCES customer_memberships(id) ON DELETE RESTRICT,
  agent_uuid UUID NOT NULL UNIQUE,
  site_id VARCHAR(128) NOT NULL,
  hostname VARCHAR(255) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_unknown' CHECK (status IN ('pending_unknown', 'accepted', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_at TIMESTAMPTZ,
  CHECK ((status = 'pending_unknown' AND result_at IS NULL) OR (status <> 'pending_unknown' AND result_at IS NOT NULL))
);
CREATE INDEX idx_sg_agent_uninstall_customer ON secure_guard_agent_uninstall_claims (customer_organization_id, created_at DESC);

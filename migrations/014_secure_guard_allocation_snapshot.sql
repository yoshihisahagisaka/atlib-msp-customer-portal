-- Secure Guard: manually transcribed DNSFilter Allocated RC Licenses.
-- DNSFilter remains authoritative; these columns are a dated reference snapshot only.
-- No assumptions or backfill for existing organizations.
-- Number 013 is reserved for the parallel MFA lane.
ALTER TABLE customer_organizations
  ADD COLUMN dnsfilter_allocated_rc_licenses_snapshot INTEGER
    CHECK (dnsfilter_allocated_rc_licenses_snapshot >= 0),
  ADD COLUMN license_snapshot_updated_at TIMESTAMPTZ,
  ADD COLUMN license_snapshot_updated_by UUID REFERENCES portal_users(id) ON DELETE RESTRICT;

ALTER TABLE customer_organizations
  ADD CONSTRAINT customer_organizations_allocation_snapshot_consistency
  CHECK (
    (dnsfilter_allocated_rc_licenses_snapshot IS NULL
      AND license_snapshot_updated_at IS NULL
      AND license_snapshot_updated_by IS NULL)
    OR
    (dnsfilter_allocated_rc_licenses_snapshot IS NOT NULL
      AND license_snapshot_updated_at IS NOT NULL
      AND license_snapshot_updated_by IS NOT NULL)
  );

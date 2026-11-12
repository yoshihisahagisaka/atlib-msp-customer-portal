-- Secure Guard dedicated database extension of the customer license snapshot state.
-- Mirrors legacy Portal migration 013 without invoking the legacy Portal runner.
-- Must follow the SG baseline 001 / overage 002; apply via the SG-only checksum runner.
ALTER TABLE customer_organizations
  ADD COLUMN dnsfilter_allocated_rc_licenses_snapshot INTEGER,
  ADD COLUMN license_snapshot_updated_at TIMESTAMPTZ,
  ADD COLUMN license_snapshot_updated_by UUID REFERENCES portal_users(id) ON DELETE RESTRICT,
  ADD COLUMN license_alert_last_sent_overage INTEGER,
  ADD COLUMN license_alert_last_sent_at TIMESTAMPTZ,
  ADD COLUMN license_alert_pending_overage INTEGER,
  ADD COLUMN license_alert_pending_token UUID,
  ADD COLUMN license_alert_pending_at TIMESTAMPTZ;

ALTER TABLE customer_organizations
  ADD CONSTRAINT customer_organizations_license_snapshot_nonnegative
    CHECK (dnsfilter_allocated_rc_licenses_snapshot IS NULL OR dnsfilter_allocated_rc_licenses_snapshot >= 0),
  ADD CONSTRAINT customer_organizations_license_alert_nonnegative
    CHECK (license_alert_last_sent_overage IS NULL OR license_alert_last_sent_overage > 0),
  ADD CONSTRAINT customer_organizations_license_alert_pending_complete
    CHECK ((license_alert_pending_overage IS NULL AND license_alert_pending_token IS NULL AND license_alert_pending_at IS NULL)
      OR (license_alert_pending_overage > 0 AND license_alert_pending_token IS NOT NULL AND license_alert_pending_at IS NOT NULL));

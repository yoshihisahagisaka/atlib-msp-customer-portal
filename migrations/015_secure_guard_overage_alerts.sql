-- Secure Guard only: minimum durable overage episode and human follow-up state.
-- No prices, invoices, billing periods, DNSFilter mutations or backfill.
-- Migration 014 is the separate draft manual snapshot; verify concurrent migrations before application.
CREATE TABLE secure_guard_overage_alerts (
  id BIGSERIAL PRIMARY KEY,
  customer_organization_id UUID NOT NULL
    REFERENCES customer_organizations(id) ON DELETE RESTRICT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL,
  allocated_rc_licenses INTEGER NOT NULL CHECK (allocated_rc_licenses >= 0),
  roaming_clients_in_use INTEGER NOT NULL CHECK (roaming_clients_in_use >= 0),
  over_by INTEGER NOT NULL CHECK (over_by > 0),
  handling_status TEXT NOT NULL DEFAULT 'open'
    CHECK (handling_status IN ('open', 'in_progress', 'resolved')),
  response_choice TEXT
    CHECK (response_choice IS NULL OR response_choice IN ('reduce_clients', 'increase_allocation')),
  response_note TEXT,
  response_updated_at TIMESTAMPTZ,
  response_updated_by UUID REFERENCES portal_users(id) ON DELETE RESTRICT,
  notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending', 'attempting', 'sent', 'needs_review')),
  notification_attempted_at TIMESTAMPTZ,
  notification_sent_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((resolved_at IS NULL AND handling_status <> 'resolved')
    OR (resolved_at IS NOT NULL AND handling_status = 'resolved'))
);
CREATE UNIQUE INDEX secure_guard_overage_one_open_per_organization
  ON secure_guard_overage_alerts(customer_organization_id)
  WHERE resolved_at IS NULL;
CREATE INDEX secure_guard_overage_recent
  ON secure_guard_overage_alerts(opened_at DESC, customer_organization_id);

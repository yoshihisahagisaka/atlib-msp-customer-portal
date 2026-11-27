-- Secure Guard dedicated database baseline, equivalent to legacy 011 followed by 012.
-- No legacy Portal customers table or cross-database foreign key is required.
-- Apply only through migrations/secure_guard_runner.ts with the SG migration role.

CREATE TABLE portal_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) NOT NULL,
  password_hash   VARCHAR(255),
  status          TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE UNIQUE INDEX idx_portal_users_email_lower ON portal_users (lower(email));

CREATE TABLE customer_organizations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID UNIQUE,
  organization_name VARCHAR(255) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_memberships (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES portal_users(id) ON DELETE RESTRICT,
  customer_organization_id UUID NOT NULL REFERENCES customer_organizations(id) ON DELETE RESTRICT,
  role                     TEXT NOT NULL CHECK (role IN ('org_admin', 'operator', 'viewer')),
  is_initial_admin         BOOLEAN NOT NULL DEFAULT false,
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  invited_by_user_id       UUID REFERENCES portal_users(id) ON DELETE RESTRICT,
  invite_token_hash        VARCHAR(255),
  invite_expires_at        TIMESTAMPTZ,
  accepted_at              TIMESTAMPTZ,
  revoked_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_organization_id),
  CHECK ((NOT is_initial_admin) OR role = 'org_admin'),
  CHECK (
    (status = 'pending' AND invite_token_hash IS NOT NULL AND invite_expires_at IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL)
    OR (status = 'active' AND invite_token_hash IS NULL AND invite_expires_at IS NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX idx_customer_memberships_scope
  ON customer_memberships (customer_organization_id, status, role);
CREATE UNIQUE INDEX idx_customer_memberships_pending_initial_admin
  ON customer_memberships (customer_organization_id)
  WHERE is_initial_admin AND status = 'pending';

CREATE TABLE msp_role_grants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES portal_users(id) ON DELETE RESTRICT,
  role               TEXT NOT NULL CHECK (role IN ('msp_admin')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by_user_id UUID REFERENCES portal_users(id) ON DELETE RESTRICT,
  granted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ,
  UNIQUE (user_id, role),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE TABLE dnsfilter_organization_mappings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_organization_id  UUID NOT NULL UNIQUE REFERENCES customer_organizations(id) ON DELETE RESTRICT,
  dnsfilter_organization_id VARCHAR(64) NOT NULL UNIQUE,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE secure_guard_receipts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_organization_id UUID NOT NULL REFERENCES customer_organizations(id) ON DELETE RESTRICT,
  status                   TEXT NOT NULL CHECK (status IN ('verified', 'unavailable')),
  observed_at              TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  plan_hash                VARCHAR(128),
  object_generation        VARCHAR(64),
  source_sha               VARCHAR(64),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_secure_guard_receipts_org_completed
  ON secure_guard_receipts (customer_organization_id, completed_at DESC);

CREATE TABLE secure_guard_audit_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id            UUID REFERENCES portal_users(id) ON DELETE RESTRICT,
  customer_organization_id UUID REFERENCES customer_organizations(id) ON DELETE RESTRICT,
  membership_id            UUID REFERENCES customer_memberships(id) ON DELETE RESTRICT,
  action                   TEXT NOT NULL,
  result                   TEXT NOT NULL CHECK (result IN ('success', 'denied', 'failed')),
  receipt_id               UUID REFERENCES secure_guard_receipts(id) ON DELETE RESTRICT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_secure_guard_audit_events_org_created
  ON secure_guard_audit_events (customer_organization_id, created_at DESC);

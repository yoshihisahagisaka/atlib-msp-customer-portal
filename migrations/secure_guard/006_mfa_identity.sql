-- Secure Guard V1 MFA identity data. Offline M1 only; NOT approved for Cloud SQL.
-- These tables are per-identity in the one shared Secure Guard database.
CREATE TABLE secure_guard_mfa_settings (
  user_id UUID PRIMARY KEY REFERENCES portal_users(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('totp','email')),
  state TEXT NOT NULL CHECK (state IN ('enrolling','active','reset_required')),
  totp_ciphertext BYTEA,
  totp_nonce BYTEA,
  totp_tag BYTEA,
  key_version SMALLINT,
  last_totp_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (state='reset_required' AND totp_ciphertext IS NULL AND totp_nonce IS NULL AND totp_tag IS NULL AND key_version IS NULL)
    OR (state<>'reset_required' AND method='totp' AND totp_ciphertext IS NOT NULL AND totp_nonce IS NOT NULL AND totp_tag IS NOT NULL AND key_version IS NOT NULL)
    OR (state<>'reset_required' AND method='email' AND totp_ciphertext IS NULL AND totp_nonce IS NULL AND totp_tag IS NULL AND key_version IS NULL)
  )
);

CREATE TABLE secure_guard_mfa_challenges (
  token_hash CHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','enroll','recovery','admin_reauth')),
  method TEXT CHECK (method IN ('totp','email')),
  otp_hmac CHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count BETWEEN 0 AND 3),
  last_sent_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sg_mfa_challenges_user_expiry
  ON secure_guard_mfa_challenges (user_id, expires_at);

CREATE TABLE secure_guard_mfa_recovery_codes (
  user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE RESTRICT,
  code_hmac CHAR(64) NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hmac)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  secure_guard_mfa_settings, secure_guard_mfa_challenges, secure_guard_mfa_recovery_codes
TO secure_guard_runtime_staging;

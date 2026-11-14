# Secure Guard Staging Bootstrap Execution Evidence — 2026-11-14

This evidence belongs to Draft PR #6 and supplements `DECISION_SECURE_GUARD_EMPTY_START_20261113.md`.

## Verified implementation

- PowerShell 5.1 compatibility: PASS.
- Explicit Secret IAM member expansion: PASS.
- Offline test suite: 105 PASS / 0 FAIL.
- Secure Guard migration typecheck: PASS.
- Cloud Build logging: `CLOUD_LOGGING_ONLY`.

## Build

- Source commit: `b0966dc82a709574bd2975f3d78c39b5b529745c`.
- Build ID: `d184824e-63db-4ae5-961d-23b187a0642f`.
- Status: `SUCCESS`.
- Image digest: `sha256:1577ce9e8f2f95b02589e1287b026bb47dda4bce00c2603b47c7f8b15790fc43`.
- Build service account and project IAM were unchanged.

## Job configuration read-back

The one-time Job matched the approved contract: one task, parallelism one, zero retries, 900-second timeout, private IP, fixed Cloud SQL Proxy digest, fixed bootstrap image digest, and four version-1 Secret references.

## Execution result

- Execution ID: `secure-guard-db-bootstrap-staging-once-xntcz`.
- Executions submitted: one.
- Result: `FAILED`; failed tasks one, successful tasks zero.
- Safe diagnostic event: `secure_guard_staging_bootstrap_failed`, stage `CREATE_ROLES`.
- No raw exception, password, connection string, or Secret payload was recorded.

Post-failure read-only verification found no `secure_guard_staging` database and no `secure_guard_*_staging` roles. Migration 001-004 remained unapplied.

Per the no-retry contract, the Job and bootstrap service account's temporary Secret access remain for review. No automatic retry or cleanup was performed. Production services and data were not changed. Staging migration remains No-Go pending review of the `CREATE_ROLES` failure and separate execution approval.

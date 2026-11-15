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

## 2026-11-15 SQL type fix and re-execution preparation

- Root cause was confirmed from the scoped Cloud SQL error log: PostgreSQL could not determine the type of parameter `$1` while building the first `CREATE ROLE` statement.
- Source fix commit: `1b4d5f984c0b51d942449a661b7d5b54eda8039e`; `formatted()` now binds each `format()` argument as explicit `text`.
- A PostgreSQL 16 integration regression executes the parameterized `format()` query, verifies `%I`, `%L`, connection limit and role attributes, and confirms that it creates no role.
- PostgreSQL 16 GitHub Actions: PASS. Local suite: 105 PASS / 0 FAIL. Typecheck and both PowerShell 5.1 syntax checks: PASS.
- Replacement build ID: `fb64f9c1-cedd-4350-9672-07c20b4d2b68`; status `SUCCESS`; logging `CLOUD_LOGGING_ONLY`.
- Replacement image digest: `sha256:c4294e5a2e817a874e72a70aa85d7e3b06089ec8265699845bc235995a065e39`.
- The existing Job's bootstrap container image was updated to that digest. Read-back comparison confirmed no other `spec` difference.
- Job remains Ready with one task, parallelism one, zero retries, 900-second timeout, the same service account, proxy container, network and Secret references.
- Execution count remains exactly one. No second execution was submitted.
- `secure_guard_staging` and all three Secure Guard roles remain absent; Migration 001-004 remains unapplied.
- The bootstrap service account's temporary Secret access remains unchanged. Production changes: zero.

Bootstrap re-execution remains No-Go until separately approved.

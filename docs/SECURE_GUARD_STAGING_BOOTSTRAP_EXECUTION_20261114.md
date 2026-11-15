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

## 2026-11-15 approved bootstrap re-execution

- Pre-execution read-back passed for image digest `sha256:c4294e5a2e817a874e72a70aa85d7e3b06089ec8265699845bc235995a065e39`, one task, parallelism one, zero retries, 900-second timeout, the existing service account, proxy and version-1 Secret references.
- The prior history contained exactly one failed execution before approval.
- One additional execution was submitted: `secure-guard-db-bootstrap-staging-once-266rd`.
- Result: `FAILED`; failed tasks one, successful tasks zero. No retry was submitted.
- Safe application stage: `CREATE_DATABASE`.
- Scoped Cloud SQL error: the `postgres` bootstrap principal must be able to `SET ROLE` to `secure_guard_migration_staging` before creating a database owned by that role.
- The three Secure Guard login roles were created by the committed role transaction. `secure_guard_staging` was not created and Migration 001-004 remains unapplied.
- Per the failure contract, the one-time Job and bootstrap service account's temporary access to the three Secure Guard password Secrets remain unchanged. No cleanup, IAM change or automatic recovery was performed.
- Production changes: zero. Bootstrap and migration remain No-Go pending a separately reviewed recovery design.

## 2026-11-15 PostgreSQL 16 recovery contract

- Governance approved PostgreSQL 16's three automatic role-administration memberships as an explicit exception to the former zero-membership rule.
- The exact allowed final state is one row per Secure Guard role, member equal to the bootstrap executor, grantor equal to PostgreSQL's bootstrap superuser, `ADMIN TRUE`, `SET FALSE`, and `INHERIT FALSE`.
- Recovery is permitted only when the target database is absent, all three roles exist with exact attributes and connection limits, all five Insight roles remain present, and the membership set exactly matches that exception.
- Partial role creation, role drift, or any extra membership remains fail-closed.
- Database creation uses a separate temporary grant with `SET TRUE` only for the migration role. The same grantor revokes that row in a `finally` path, after which the automatic three-row state is reverified.
- Database-internal grants and revocations are executed by the migration login as database owner; no permanent privilege expansion is introduced.
- The new-install and three-role recovery paths are acceptance-tested on a disposable PostgreSQL 16 service. Bootstrap execution and Migration 001-004 remain No-Go until separately approved.

## 2026-11-15 recovery implementation and image update

- Implementation commits: `4c92334`, `9d50abc`, and `2e473cf`.
- Offline regression: 105 PASS / 0 FAIL. TypeScript build, dedicated migration typecheck, and both PowerShell 5.1 syntax checks: PASS.
- Disposable PostgreSQL 16 integration: PASS for a non-superuser `CREATEROLE`/`CREATEDB` executor on both the new-install path and the exact three-role recovery path. Partial-role state stopped before database creation.
- The integration verified the temporary migration `SET TRUE` grant, database ownership, owner-scoped database/schema configuration, removal of the temporary grant, and the exact three automatic `ADMIN TRUE / SET FALSE / INHERIT FALSE` membership rows.
- GitHub Actions runs `43717061152` and `43717066030`: PASS.
- Cloud Build ID: `e8176bcd-1f08-47c9-a342-ceeb492a13aa`; status `SUCCESS`; existing Build service account; `CLOUD_LOGGING_ONLY`.
- New image digest: `sha256:7941dba6bd702fc6c3056f072350dd117a73710c249762d09c952ac3338f6ba5`.
- The existing Job's `bootstrap` container was updated to the new digest. A full before/after `spec` comparison confirmed the image was the only spec change. The proxy, service account, version-1 Secret references, network, task count, parallelism, retry and timeout settings were unchanged.
- Post-update read-back: Job Ready; execution count remains exactly two and both are the prior failed executions; no third execution was submitted.
- `secure_guard_staging` remains absent. The three existing Secure Guard roles remain present. Migration 001-004 remains unapplied.
- Existing Roles, Secrets, Secret versions, IAM and Cloud SQL configuration were not changed. Production changes: zero.

Bootstrap execution remains No-Go until separately approved.

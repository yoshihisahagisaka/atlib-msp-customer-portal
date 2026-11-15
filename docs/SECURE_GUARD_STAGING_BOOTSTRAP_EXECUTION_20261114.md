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

## 2026-11-15 temporary SET cleanup exception fix

- Fix commit: `5584c41`. Cleanup responsibility now begins before the temporary `GRANT` is attempted, so an unknown GRANT result or a verification exception still enters the same narrowly scoped REVOKE path.
- Primary processing failure and cleanup/final-verification failure are retained separately. A cleanup failure takes the fixed `CREATE_DATABASE_TEMPORARY_SET_CLEANUP` STOP stage; neither condition can be reported as success.
- After every successful cleanup query, the bootstrap reloads `pg_auth_members` and requires the exact three approved PostgreSQL 16 automatic rows. It never revokes those automatic grants.
- Disposable PostgreSQL 16 integration covers: failure immediately after the temporary grant, restoration to the exact three automatic rows, no database creation on that path, and connection loss during REVOKE producing a fail-closed cleanup STOP.
- Existing fresh-install, exact three-role recovery, partial-role STOP, database owner and cross-database isolation acceptance remains PASS.
- Local regression: 105 PASS / 0 FAIL. TypeScript build, dedicated migration typecheck, PowerShell 5.1 syntax checks and `git diff --check`: PASS.
- GitHub Actions runs `43723027865` and `43723033424`: PASS.
- Cloud Build ID: `dc61cf3f-1cd1-43d0-afae-c7e4238404ce`; status `SUCCESS`; logging `CLOUD_LOGGING_ONLY`.
- New image digest: `sha256:fa8d6c25e9417c3f7bb60f067baf52d65c2eec003e700fabc4dce0eced2b0290`.
- The existing Job's bootstrap image was updated to the new digest. Full spec comparison confirmed that the image was the only Job spec difference.
- Post-update read-back: Job Ready, exactly two prior failed executions, and no third execution. `secure_guard_staging` remains absent; Migration 001-004 remains unapplied.
- Secret versions, IAM, service accounts, Cloud SQL configuration, existing roles and Production were unchanged.

Bootstrap execution remains No-Go until separately approved.

## 2026-11-15 approved third execution

- Approval: PR #6 comment `6896048052`; approved source/evidence HEAD `5c3c2d1eb1459df20176f5629095f44129dc972e`.
- Pre-execution read-back passed for Job Ready, image digest `sha256:fa8d6c25e9417c3f7bb60f067baf52d65c2eec003e700fabc4dce0eced2b0290`, one task, parallelism one, zero retries, 900-second timeout, the approved service account, fixed Cloud SQL Proxy, default VPC with private-ranges-only egress, and four version-1 Secret references.
- Before execution, `secure_guard_staging` was absent, the three Secure Guard roles and five Insight roles were present, `secumie_insight_staging` was present, and execution history contained exactly the two prior failed executions.
- Exactly one manual execution was submitted: `secure-guard-db-bootstrap-staging-once-x9zvg`.
- Result: `FAILED`; failed tasks one, successful tasks zero; no retry or additional execution was submitted.
- Safe application event: `secure_guard_staging_bootstrap_failed`, fixed stage `PREFLIGHT`.
- The safe log does not classify which preflight comparison failed. No cause is inferred from the aggregate stage.
- Post-failure read-back: `secure_guard_staging` remains absent; the three Secure Guard roles, five Insight roles, and `secumie_insight_staging` remain present; execution count is exactly three.
- Per the failure contract, the Job, Roles, Secrets, version-1 Secret references, service accounts and temporary Secret IAM remain in place. No cleanup, migration, automatic recovery or production change was performed.

Bootstrap and Migration 001-004 remain No-Go pending separate root-cause review and approval.

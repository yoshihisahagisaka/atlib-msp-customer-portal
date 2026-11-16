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

## 2026-11-16 read-only diagnosis and Recovery method 1 implementation

- The approved SELECT-only override used script SHA-256 `3b21990499ae9a50d469e6381f8792f3bbdaca0d14008f61cb0ca56041fa8a78`.
- Diagnostic Execution `secure-guard-db-bootstrap-staging-once-hzbtb` succeeded with one task and zero retries. Its args were exactly `-e` and `eval(atob(process.env.INSPECT_B64))`; the normal Bootstrap module was not started.
- Actual values: PostgreSQL 16.15, database/user `postgres`, max connections 400, reserved 3/0, observed connections 10, `secure_guard_staging` absent, `secumie_insight_staging` present and owned by `postgres`, `createrole_self_grant` empty, and OID 10 equal to `cloudsqladmin`.
- All three Secure Guard role attributes and connection limits matched. Related membership rows were exactly zero.
- Root cause was confirmed: the former preflight required three automatic memberships and raised `ROLE_MEMBERSHIP_VERIFY_FAILED` before database creation.
- No database, role, membership, Secret, IAM, Job definition, network or Production change occurred during diagnosis. The diagnostic increased execution history from three to four entries.

The Bootstrap implementation now follows Insight Recovery method 1. It requires zero memberships, removes the temporary SET flow, creates the database with the bootstrap executor as owner, revokes PUBLIC privileges, grants CONNECT to the three SG roles, and grants database CREATE plus schema USAGE/CREATE only to migration. Existing exact-role recovery is retained; partial roles, role drift, membership drift and an existing target database remain fail-closed. A post-CREATE configuration failure retains the database and a subsequent run refuses to continue.

Disposable PostgreSQL 16 validation covers fresh SQL, the non-superuser three-role recovery state, partial roles, role drift, unexpected membership, owner/ACL, runtime/overage denial, Insight cross-database isolation, absent migration ledger, and retained database after an injected post-CREATE failure. Vanilla PostgreSQL's automatic creator membership differs from measured Cloud SQL behavior; the fixture treatment is documented in the Decision and does not weaken the Cloud SQL zero-membership requirement.

Image build, Artifact push, Job update, Bootstrap execution and Migration 001-004 remain No-Go pending the next consolidated Staging gate approval.

## Next consolidated Staging gate (prepared, not approved or executed)

The next approval package may run the following sequence without intermediate approval only while every preceding gate passes:

1. Build the Bootstrap image once from the reviewed PR #6 commit using the existing Build SA and `CLOUD_LOGGING_ONLY`; fix the resulting digest.
2. Update only the existing Job's bootstrap image digest. Read back the full spec and require zero differences after normalizing that image field.
3. Require Job Ready, task/parallelism one, retry zero, timeout 900 seconds, approved SA, four Secret version-1 references, fixed Proxy, Direct VPC, execution history four, target DB absent, exact three SG roles, exact five Insight roles, and zero SG memberships.
4. Execute Bootstrap exactly once. No automatic retry.
5. Require owner `postgres`, zero SG memberships, exact role attributes/limits, PUBLIC revocation, CONNECT for all three SG roles, CREATE plus schema USAGE/CREATE only for migration, runtime/overage CREATE denial, cross-database denial in both directions, empty public tables and absent SG migration ledger.
6. Only after full Bootstrap acceptance, apply approved Migration 001-004 once with the fixed manifest/digests and dedicated migration identity.
7. Require ledger 001-004 exact match, schema/object ownership and runtime/overage Positive/Negative tests, then run synthetic-data E2E with transaction cleanup and zero retained customer data.
8. Confirm Cloud SQL health/capacity, existing Insight services and existing Production services remain healthy. Production traffic/configuration remains unchanged.

STOP immediately on Build ambiguity, any non-image Job diff, preflight drift, failed/unknown Execution, partial database configuration, unexpected membership/ACL/ledger, migration drift, retained synthetic data, Secret exposure, or existing-service degradation. On STOP, do not retry, delete the database, edit the ledger, expand IAM, rotate Secrets, or proceed to the next stage.

## 2026-11-16 consolidated Staging gate execution — STOP at S2 acceptance

Gate S0 passed against PR #6 commit `d2fd694e70039d73a964c9dbf4e717aa0834bd26`: both isolated PostgreSQL checks were successful, the worktree was clean, the shared Staging instance was `RUNNABLE` on PostgreSQL 16.15, the latest automated backup was successful, PITR remained enabled, no competing Cloud SQL operation was running, the four required Secret versions were enabled, the Job was Ready with four historical Executions, and existing services were Ready.

Gate S1 used the existing Build SA and `CLOUD_LOGGING_ONLY` exactly once:

- Build ID: `9b43b5c0-931e-44e0-bf93-a5768ae400a3`
- Build status: `SUCCESS`
- Image digest: `sha256:fe9f7dacb33331851ed550c732a7039cd0de9b114c9ed0ff2ec4bc49974516fa`
- The existing Job was updated from digest `sha256:fa8d6c25e9417c3f7bb60f067baf52d65c2eec003e700fabc4dce0eced2b0290` to the new digest. Normalized read-back showed no spec difference other than the bootstrap image. Job generation became 5; Ready, task/parallelism one, retry zero, timeout 900 seconds, SA, four Secret version-1 references, Proxy and Direct VPC settings were preserved.

The one approved normal Bootstrap invocation was Execution `secure-guard-db-bootstrap-staging-once-cv5tl` and completed successfully. Its fixed completion event reported database `secure_guard_staging`, all three roles with limits 2/2/1, cross-database isolation true, empty true, and migrations applied zero.

S2 did not receive final acceptance. The first acceptance command was rejected by the CLI before creating an Execution because `--format` was parsed after the container override. The unchanged SELECT-only script (SHA-256 `9b4971cb176f2e27e2da10f7a903049fe1b7e550c39ac7390c61ba12d80192de`) was then submitted once as Execution `secure-guard-db-bootstrap-staging-once-hmlnf`; it failed and emitted only `sg_s2_acceptance_failed`. Static review found that this acceptance script used obsolete/nonexistent Insight role names instead of the five names fixed in the Bootstrap (`secumie_otp_staging`, `secumie_pira_staging`, `secumie_admin_staging`, `secumie_migration_staging`, `secumie_maintenance_staging`). Therefore the metadata privilege query could not complete. This was a verification-script defect, not evidence of an ACL mismatch, but the approved STOP contract prohibits retrying or treating incomplete acceptance as PASS.

Final retained state at STOP: Job Ready, generation 5, Execution count 6, fixed new image digest, Cloud SQL `RUNNABLE`, all existing services Ready. No Migration 001-004, synthetic E2E, database deletion/recreation, ledger edit, role/membership correction, Secret rotation, IAM expansion, Production change, or automatic retry was performed. The created database and existing Job/IAM are retained for separately approved acceptance recovery.

## 2026-11-16 Gate S2 acceptance recovery and Gate S3 STOP

Owner approval retained every prior S2-S5 condition and authorized one corrected SELECT-only acceptance Execution. Only the five Insight role names were corrected to `secumie_otp_staging`, `secumie_pira_staging`, `secumie_admin_staging`, `secumie_migration_staging`, and `secumie_maintenance_staging`. The former script hash was `9b4971cb176f2e27e2da10f7a903049fe1b7e550c39ac7390c61ba12d80192de`; the corrected, statically reviewed SELECT-only script hash was `d43b542683a7850a1e139152dd21a5313733e9cb90320f6bea6ccede1c94ce8c`.

Execution `secure-guard-db-bootstrap-staging-once-7dddm` succeeded with one task, zero retries and no persistent Job change. Its fixed `sg_s2_acceptance_pass` event reported 12 checks passed: owner `postgres`; SG memberships zero; exact role limits 2/2/1 and attributes; PUBLIC database and schema ACL rows zero; CONNECT for all three SG roles; database CREATE only for migration; public schema USAGE/CREATE only for migration; runtime/overage CREATE denied; SG-to-Insight and Insight-to-SG CONNECT denied; public business tables zero; and migration ledger absent. Gate S2 is PASS.

Gate S3 stopped before any database mutation. There is no Secure Guard migration Job or other committed Staging execution path. The existing Bootstrap runtime image copies compiled `dist` only and does not contain `migrations/secure_guard/*.sql`; therefore its compiled runner cannot apply the reviewed SQL files. The existing `secumie-db-migrate-staging` Job is Insight-specific: it targets `secumie_insight_staging`, uses Insight roles, image, manifest and SQL directory, and cannot be reused for Secure Guard. Embedding SQL in an ad-hoc override, changing that Job, creating a new Job, or building another image would introduce an unapproved execution path or infrastructure change.

The reviewed but unapplied migration hashes remain:

- `001_identity_scope_baseline.sql`: `19573cbc9c038b3f04ef72dc65a30dc49f328ff258af9993780a92f67d6f3f1e`
- `002_overage_alerts.sql`: `4e5a2add9325aef108e10f312c80c6e4a03b4ed64bb73cac9bd05c71b410822a`
- `003_license_alert_snapshot.sql`: `7d996cc7cfa9a1c1faa3a8a272c6fa82f279336d85869f640cb389b87810f802`
- `004_agent_uninstall_claims.sql`: `ea58e4196dcf02e2181cb6505e2065b58d17ba433f549dc5ad96019552334ebd`

No Migration, ledger creation, Synthetic E2E, Job definition change, Secret/IAM/VPC change or Production change followed. Cloud SQL remained `RUNNABLE` on PostgreSQL 16.15 and all existing services remained Ready. S3-S5 remain STOP pending a separately reviewed SG migration execution artifact and path.

## 2026-11-16 Gate S3 migration execution path readiness

PR #6 HEAD `e28f0519e856c1d916b5ebcdcbbe8f00b6090f45` was confirmed as the actual GitHub head; the reported evidence SHA was not a transcription error. Gate S2 remains PASS and no environment operation was performed while preparing this path.

The repository now contains a dedicated, non-web Secure Guard migration artifact. `Dockerfile.secure-guard-migration` compiles the existing TypeScript runner to JavaScript, installs production dependencies only, copies only the four approved SQL files, and performs the fixed-manifest check during image build. Runtime does not require `ts-node/register`, expose a port, or start the Portal application.

The fail-closed manifest is `migration-manifests/secure-guard-staging-001-004.json`. Before opening a database pool or creating the ledger, the runner requires explicit approval, exact Staging target confirmation, database `secure_guard_staging`, role `secure_guard_migration_staging`, exactly four filenames in 001-004 order, and exact SHA-256 values. The approved hashes were recorded from the Windows review worktree, so the verifier canonicalizes only LF/CRLF to CRLF before hashing; it does not normalize any other byte or SQL content. Existing advisory locking, independent ledger, checksum drift detection, and per-file transactions remain unchanged. After connection, database, role, and PostgreSQL 16 are revalidated before the first DDL.

The reviewed Job template is `deploy/secure-guard-db-migrate-staging-once.yaml.template`. It uses the existing migration service account, the migration password Secret version 1 only, pool maximum one, one task, parallelism one, zero retries, 900-second timeout, fixed Cloud SQL Proxy/Private IP/Direct VPC configuration, and a digest-pinned migration image placeholder. Job creation and execution are separate actions; no scheduler is defined.

Future separately approved execution must use this sequence:

1. Build once from the reviewed commit with `cloudbuild.secure-guard-migration.yaml`, the existing Build SA, and `CLOUD_LOGGING_ONLY`; record the digest and pass the existing image-security gate.
2. Substitute only that digest into a temporary copy of the reviewed Job template, create the absent Job, and read back every field. Do not execute during creation.
3. Reconfirm the migration SA has Cloud SQL Client and Secret Accessor only on `secure-guard-stg-db-migration-password`; confirm Secret version 1 remains enabled.
4. Execute exactly once only under a separate explicit approval. Stop without retry on any failed, unknown, manifest, identity, checksum, or SQL result.
5. Require ledger 001-004 and manifest checksums to match exactly, verify owners and runtime/overage negative permissions, and preserve cross-database isolation before proceeding to S4.

Local static regression, TypeScript build/typecheck, manifest verification and the existing suite pass. The disposable PostgreSQL 16 integration now also covers a file-level partial failure: 001 commits, 002 rolls back, and the ledger contains only 001. The dedicated image is built and exercised by GitHub Actions because the local Windows Docker engine was unavailable to this worktree. No Cloud Build, Artifact push, Job creation, IAM/Secret/VPC change, migration, or Production change was made.

Gate S3 real execution remains No-Go pending the consolidated Staging execution approval.

## 2026-11-16 Gate S3 migration execution — STOP at acceptance

The approved line-ending-only hash correction was committed as `68aed9311863f0d88317eb1e187bbc4202bbbbdb`. The migration runner and manifest verifier now both canonicalize LF/CRLF to CRLF before SHA-256 calculation; no SQL or approved manifest hash changed. Local regression was 111 PASS / 0 FAIL, and GitHub Actions runs `43816474334` and `43816479870` passed, including the disposable PostgreSQL 16 image execution, exact ledger hashes, safe replay, manifest drift rejection and migration image build.

The dedicated migration image was built once:

- Cloud Build ID: `46d85ca1-ac75-4b3b-98ce-0318aea03fd7`
- Status: `SUCCESS`; existing Build SA; `CLOUD_LOGGING_ONLY`
- Image digest: `sha256:146d26da81fa9125f76ce9ed472f9da10b67c78ef56115381c8f9e72dc55cb45`
- Artifact Analysis: `FINISHED_SUCCESS`; vulnerability counts matched the previously accepted Bootstrap baseline.

Job `secure-guard-db-migrate-staging-once` was created from the reviewed template. Read-back confirmed generation 1, Ready, task/parallelism one, retry zero, timeout 900 seconds, migration SA, migration password Secret version 1 only, pool maximum one, fixed Proxy and Direct VPC settings, and the digest above. No scheduler or execution-at-create was configured.

The read-only S3 preflight used Execution `secure-guard-db-bootstrap-staging-once-q925w` and passed: PostgreSQL 16.15; target owner `postgres`; zero SG memberships; exact role attributes and limits 2/2/1; all three SG roles had CONNECT; database CREATE and public schema USAGE/CREATE were migration-only; runtime/overage CREATE was denied; cross-database CONNECT was denied in both directions; public tables were zero and the migration ledger was absent.

The migration Job was manually executed exactly once as `secure-guard-db-migrate-staging-once-8lr7z`. It completed successfully with one task and zero retries. The fixed safe log recorded manifest count four, database `secure_guard_staging`, role `secure_guard_migration_staging`, and application of 001, 002, 003 and 004 in order. The manifest hashes remain:

- `001_identity_scope_baseline.sql`: `19573cbc9c038b3f04ef72dc65a30dc49f328ff258af9993780a92f67d6f3f1e`
- `002_overage_alerts.sql`: `4e5a2add9325aef108e10f312c80c6e4a03b4ed64bb73cac9bd05c71b410822a`
- `003_license_alert_snapshot.sql`: `7d996cc7cfa9a1c1faa3a8a272c6fa82f279336d85869f640cb389b87810f802`
- `004_agent_uninstall_claims.sql`: `ea58e4196dcf02e2181cb6505e2065b58d17ba433f549dc5ad96019552334ebd`

Gate S3 acceptance is incomplete and therefore STOP. The statically reviewed SELECT-only acceptance script had SHA-256 `f8104f071f38a77354156ffb66eff4d1f445001b45c4848a1e1a5697709c542e`. A first local invocation exceeded the Windows command-length limit and created no Execution. The compressed transfer invocation created Execution `secure-guard-db-bootstrap-staging-once-ch5wq`, but the CLI split the Node expression at its comma into three args. Node stopped with a syntax error before loading the SELECT-only script or opening a database connection. No acceptance value, ledger row, object owner or runtime/overage privilege result was produced. Per the no-retry contract, no further diagnostic Execution was submitted.

At STOP, Cloud SQL remained `RUNNABLE`; the migration Execution remained `SUCCEEDED`; all listed existing Cloud Run services remained Ready. No manual GRANT, schema repair, migration replay, Job deletion, Secret/IAM/VPC change, Production change, synthetic E2E or Gate S4 action was performed. The database and migration Job are retained. Direct ledger-hash verification, object/constraint ownership, runtime/overage Positive/Negative privilege acceptance, empty-data verification and final cross-database acceptance remain unverified and require a separately approved read-only acceptance recovery. Gate S3 is **STOP**, not PASS; Gate S4 remains No-Go.

## 2026-11-16 owner-approved Gate S3 acceptance recovery — STOP on verifier privilege

Owner approval was recorded in PR #6 comment `6918881019` for exactly one SELECT-only acceptance Execution against HEAD `d3e0993757a0ad3117db1115ac3bff66d5fc4c8a`. The replacement script reused the successful uncompressed Base64 method. Static verification found no DDL, DML, GRANT or REVOKE statement, required `BEGIN TRANSACTION READ ONLY`, did not import the Bootstrap module, and fixed SHA-256 `86c69487e25b733431067e3cb480069842b7e4198d35e9993be7cfb62c600dc2`.

Execution `secure-guard-db-bootstrap-staging-once-xn5p6` was submitted once. Read-back confirmed exactly two Node arguments, `-e` and `eval(atob(process.env.INSPECT_B64))`, one task, zero retries, and no persistent Job change. The script connected through the existing Proxy as `postgres` and stopped while selecting the independent migration ledger. Cloud SQL recorded the exact failure as `permission denied for table secure_guard_schema_migrations` for the SELECT `filename, sha256`. The script then emitted only the fixed failure event, stopped the Proxy, and exited nonzero.

This establishes a verifier-path Fit/Gap: the Cloud SQL `postgres` bootstrap principal is not a superuser and does not own the ledger created by `secure_guard_migration_staging`; it cannot directly verify Ledger rows. No privilege was added, no alternate identity was used, and the failed acceptance was not retried. Consequently the four Ledger hashes, object/constraint ownership, runtime/overage Positive/Negative privileges, empty business data, and final cross-database separation remain unverified by this acceptance run. The successful migration Execution `secure-guard-db-migrate-staging-once-8lr7z` was not rerun and remains the sole migration Execution.

At STOP, Cloud SQL remained `RUNNABLE`, every listed existing Cloud Run service remained Ready, and Production changes remained zero. Gate S3 remains **STOP**. Gate S4, Synthetic E2E and Production remain No-Go. Any next step requires a separately reviewed, least-privilege verification route; manual GRANT, Ledger editing, Migration replay and database repair remain prohibited.

## 2026-11-17 migration-identity acceptance preparation (offline only)

The existing migration Job is the least-privilege verification route: its database identity `secure_guard_migration_staging` owns the independent ledger and migrated objects. No new Job, image, role, Secret or IAM grant is required. A SELECT-only payload is committed as `scripts/readiness/secureGuardMigrationAcceptance.cjs`; SHA-256 is `06a6321bd0ea56cea508f1c46336af1735f185344d872e418e69fcf2012d19db` and its Base64 transport is 7,096 characters, within the Windows command-line gate.

Static acceptance requires exactly two Node arguments, `-e` and `eval(atob(process.env.INSPECT_B64))`, one task, zero retries, the existing `migration` container and an Execution-only override `SECURE_GUARD_MIGRATION_APPROVED=false`. The runner checks that flag before pool creation, so accidental fallback to its persistent command stops before a database connection or DDL. The payload itself opens one migration-role connection, starts `BEGIN TRANSACTION READ ONLY`, applies statement/lock timeouts, collects identity, exact Ledger rows, table/index/constraint definitions and owners, exact business-table counts, memberships, PUBLIC ACL state, role attributes, per-privilege runtime/overage matrices and cross-database CONNECT state, then closes the connection and fixed Proxy endpoint. It imports neither the Bootstrap nor migration runner and contains no mutating SQL.

Offline validation is PASS: payload syntax, SELECT-only contract, two-argument contract, Windows transport bound, runner pre-connection approval gate, full regression (113 PASS / 0 FAIL), TypeScript build and dedicated migration typecheck. No GCP Execution or persistent resource change was made. The next operation is exactly one SELECT-only override and remains No-Go until a separate Owner approval; any failed/unknown Execution or data, Ledger, owner, ACL, privilege or isolation mismatch stops without retry or repair.

## 2026-11-17 owner-approved migration-identity acceptance — STOP on missing positive ACLs

Owner approval fixed HEAD `c34f1c77e9fbce219e664b71ff6019623d17a05c` and payload SHA-256 `06a6321bd0ea56cea508f1c46336af1735f185344d872e418e69fcf2012d19db`. Preflight passed: the payload was SELECT-only, imported no Bootstrap or runner, used exactly `-e` plus `eval(atob(process.env.INSPECT_B64))`, and set the Execution-only guard `SECURE_GUARD_MIGRATION_APPROVED=false`. The existing migration Job was Ready at generation 1 with one prior successful migration Execution, fixed image digest `sha256:146d26da81fa9125f76ce9ed472f9da10b67c78ef56115381c8f9e72dc55cb45`, task one, retry zero, the existing migration SA, migration Secret version 1 and Proxy.

Exactly one SELECT-only Execution, `secure-guard-db-migrate-staging-once-7qgfm`, completed successfully. Execution read-back confirmed the two Node arguments, the false approval override, one task, zero retries and no persistent Job change. Complete safe result JSON is preserved in `docs/SECURE_GUARD_GATE_S3_ACCEPTANCE_RESULT_20261117.json` with evidence SHA-256 `3cac012603dead95c4e852039647e08ca11e182203456a5855f4e7ef3e6e50a1`.

Measured PASS facts: database `secure_guard_staging`, role `secure_guard_migration_staging`, PostgreSQL 16.15; Ledger exactly 001-004 with all four approved SHA-256 values; 10 tables including the Ledger, 26 indexes, one sequence and 59 constraints; every object owner `secure_guard_migration_staging`; all nine business tables contained zero rows; SG memberships zero; PUBLIC database/schema ACL rows zero; SG-to-Insight and Insight-to-SG CONNECT both false; role attributes and connection limits remained exact; all three SG roles retained database CONNECT; only migration retained database CREATE and public schema USAGE/CREATE.

Gate S3 is **STOP** because the required runtime/overage positive privileges are absent. Runtime public schema USAGE was false and all 39 tested table/sequence privileges were false. Overage public schema USAGE was false and all 15 tested privileges were false, including the required Organization/Mapping SELECT, overage-alert SELECT/INSERT/UPDATE and sequence USAGE/SELECT. Negative permissions remained denied as intended, but absence of every positive permission violates the accepted contract. No GRANT/REVOKE, migration replay, Ledger edit, database repair, Job/IAM/Secret change or Production action was performed. Gate S4 and Synthetic E2E remain No-Go pending a separately reviewed, version-controlled least-privilege ACL migration; Migration 001-004 must not be rewritten.

## 2026-11-17 Migration 005 runtime/overage ACL implementation (offline only)

The measured Gate S3 positive-ACL gap is addressed by the new, explicit migration `005_runtime_overage_privileges.sql`. It grants only public-schema USAGE, the nine named business-table privileges and required alert-sequence privileges to `secure_guard_runtime_staging`, plus the two named identifier reads, alert-episode SELECT/INSERT/UPDATE and alert-sequence privileges to `secure_guard_overage_staging`. It does not grant Ledger access, use `ON ALL TABLES` or default privileges, add membership, or create/alter/drop an object. Migrations 001-004 and their approved hashes are unchanged.

The fixed allowlist is now `migration-manifests/secure-guard-staging-001-005.json`. Its approved CRLF-canonical SHA-256 for 005 is `cf005a3f148fba9098ccda869303fa77113d072651aed5b7fe286e763c7b0d40`; 001-004 retain `19573cbc9c038b3f04ef72dc65a30dc49f328ff258af9993780a92f67d6f3f1e`, `4e5a2add9325aef108e10f312c80c6e4a03b4ed64bb73cac9bd05c71b410822a`, `7d996cc7cfa9a1c1faa3a8a272c6fa82f279336d85869f640cb389b87810f802`, and `ea58e4196dcf02e2181cb6505e2065b58d17ba433f549dc5ad96019552334ebd` respectively. The verifier, runner default, migration image and one-shot Job template all reference this exact five-file manifest.

The PostgreSQL 16 contract no longer injects test-only GRANTs after migration. It validates fresh 001-005 application, an established 001-004 Ledger applying only 005, replay skipping all five with checksum verification, runtime's 36 named table privileges plus two sequence privileges, Ledger denial, overage's seven positive and eight negative privileges, DDL denial and cross-database isolation. Static regression and TypeScript build/typecheck are recorded with the implementation commit and CI run.

This is an offline implementation only. No Cloud Build, Artifact push, Job update or Execution, Staging database change, IAM/Secret change, or Production change was performed. Gate S3 remains **STOP**; Gate S4, Synthetic E2E and Production remain No-Go until a separate execution approval.

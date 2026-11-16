-- Secure Guard Staging: approved runtime/overage privileges.
-- Apply only through the dedicated checksum migration runner.

GRANT USAGE ON SCHEMA public
TO secure_guard_runtime_staging, secure_guard_overage_staging;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.portal_users,
  public.customer_organizations,
  public.customer_memberships,
  public.msp_role_grants,
  public.dnsfilter_organization_mappings,
  public.secure_guard_receipts,
  public.secure_guard_audit_events,
  public.secure_guard_overage_alerts,
  public.secure_guard_agent_uninstall_claims
TO secure_guard_runtime_staging;

GRANT USAGE, SELECT ON SEQUENCE
  public.secure_guard_overage_alerts_id_seq
TO secure_guard_runtime_staging;

GRANT SELECT ON TABLE
  public.customer_organizations,
  public.dnsfilter_organization_mappings
TO secure_guard_overage_staging;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.secure_guard_overage_alerts
TO secure_guard_overage_staging;

GRANT USAGE, SELECT ON SEQUENCE
  public.secure_guard_overage_alerts_id_seq
TO secure_guard_overage_staging;

import type { ManagedOrganization, SecureGuardRepo } from './secureGuardRepo';

type SyncRepo = Pick<SecureGuardRepo, 'listManagedOrganizations' | 'createManagedOrganization' | 'recordSystemAudit'>;
export type OrganizationSyncIssueCode =
  | 'LOCAL_MAPPING_REQUIRES_REVIEW'
  | 'LOCAL_UNMAPPED_SAME_NAME'
  | 'LOCAL_MAPPING_NOT_IN_DNSFILTER'
  | 'IMPORT_FAILED'
  | 'IMPORT_CONFLICT_REQUIRES_REVIEW';

export interface OrganizationSyncResult {
  organizations: ManagedOrganization[];
  sync: {
    imported: number;
    skipped: number;
    failed: number;
    needsReview: number;
    issues: Array<{ dnsfilterOrganizationId: string | null; code: OrganizationSyncIssueCode }>;
  };
  fetchedAt: string;
}

/** Called only after the DNSFilter MSP Organization list has completed and passed its shape/scope checks. */
export async function synchronizeManagedOrganizations(
  repo: SyncRepo,
  actorUserId: string,
  dnsfilterOrganizations: Array<{ id: string; name: string }>,
): Promise<OrganizationSyncResult> {
  const existing = await repo.listManagedOrganizations();
  const upstreamIds = new Set(dnsfilterOrganizations.map((entry) => entry.id));
  const issues: OrganizationSyncResult['sync']['issues'] = [];
  let imported = 0; let skipped = 0; let failed = 0; let needsReview = 0;

  for (const remote of dnsfilterOrganizations) {
    const matches = existing.filter((local) => local.dnsfilterOrganizationId === remote.id);
    if (matches.length) {
      if (matches.length === 1 && matches[0]!.status === 'active' && matches[0]!.mappingStatus === 'active') skipped++;
      else { needsReview++; issues.push({ dnsfilterOrganizationId: remote.id, code: 'LOCAL_MAPPING_REQUIRES_REVIEW' }); }
      continue;
    }
    // Never co-opt a draft or a manually registered local customer just because its name matches.
    if (existing.some((local) => local.dnsfilterOrganizationId === null && local.organizationName.toLocaleLowerCase('ja') === remote.name.toLocaleLowerCase('ja'))) {
      needsReview++; issues.push({ dnsfilterOrganizationId: remote.id, code: 'LOCAL_UNMAPPED_SAME_NAME' });
      continue;
    }
    try {
      const created = await repo.createManagedOrganization(actorUserId, remote.name, remote.id);
      existing.push(created);
      imported++;
    } catch (error) {
      // The DB has a UNIQUE mapping index. A parallel sync can win the insert;
      // only an exact active mapping is a successful no-op.
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505') {
        try {
          const refreshed = (await repo.listManagedOrganizations()).filter((local) => local.dnsfilterOrganizationId === remote.id);
          if (refreshed.length === 1 && refreshed[0]!.status === 'active' && refreshed[0]!.mappingStatus === 'active') {
            existing.push(refreshed[0]!); skipped++; continue;
          }
        } catch { /* The outcome is not known to be safe; keep it for operator review. */ }
        needsReview++; issues.push({ dnsfilterOrganizationId: remote.id, code: 'IMPORT_CONFLICT_REQUIRES_REVIEW' });
      } else {
        failed++; issues.push({ dnsfilterOrganizationId: remote.id, code: 'IMPORT_FAILED' });
        await repo.recordSystemAudit(actorUserId, 'organization.sync.import.failed', 'failed').catch(() => undefined);
      }
    }
  }

  for (const local of existing) {
    if (local.dnsfilterOrganizationId && !upstreamIds.has(local.dnsfilterOrganizationId)) {
      needsReview++;
      issues.push({ dnsfilterOrganizationId: local.dnsfilterOrganizationId, code: 'LOCAL_MAPPING_NOT_IN_DNSFILTER' });
    }
  }

  const organizations = await repo.listManagedOrganizations();
  return { organizations, sync: { imported, skipped, failed, needsReview, issues }, fetchedAt: new Date().toISOString() };
}

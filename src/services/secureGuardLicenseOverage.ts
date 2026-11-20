/**
 * A comparison of two independently verified DNSFilter subscription values.
 * Do not populate usage from a guessed Agent count or a locally inferred state.
 */
export type LicenseOverageStatus = 'unknown' | 'within_allocation' | 'overage';
export interface LicenseOverageResult {
  status: LicenseOverageStatus;
  usage: number | null;
  allocated: number | null;
  overBy: number | null;
}
export function compareConfirmedLicenseUsage(
  dnsFilterOfficialUsage: number | null,
  transcribedAllocation: number | null,
): LicenseOverageResult {
  const valid = (n: number | null): n is number =>
    n !== null && Number.isSafeInteger(n) && n >= 0;
  if (!valid(dnsFilterOfficialUsage) || !valid(transcribedAllocation)) {
    return { status: 'unknown', usage: null, allocated: null, overBy: null };
  }
  const diff = dnsFilterOfficialUsage - transcribedAllocation;
  return {
    status: diff > 0 ? 'overage' : 'within_allocation',
    usage: dnsFilterOfficialUsage,
    allocated: transcribedAllocation,
    overBy: diff > 0 ? diff : 0,
  };
}

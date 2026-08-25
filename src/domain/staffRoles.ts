export type StaffRole = 'admin' | 'general';

/** 未登録アドレスはnullを返し、ログイン自体を拒否する（呼び出し側の責務）。 */
export function resolveStaffRole(
  email: string,
  adminEmails: string[],
  generalEmails: string[],
): StaffRole | null {
  const e = email.toLowerCase();
  if (adminEmails.includes(e)) return 'admin';
  if (generalEmails.includes(e)) return 'general';
  return null;
}

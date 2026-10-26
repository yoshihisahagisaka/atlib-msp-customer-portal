# Secure Guard MVP Phase 1 implementation record

Base: `54124300f2b246aab5e8d0c355a7c899b11aa19e`.

This phase adds a personal Secure Guard identity, customer membership authorization, explicit MSP role grants, invitations, revocation, and an organization-scoped home page to the existing customer portal. It is additive to the existing Zabbix customer and staff sessions.

## Deliberate boundaries

- `portal_session` and `staff_session` remain unchanged.
- Secure Guard uses `secure_guard_session`, issued only for an active personal identity.
- Every Customer Scope request supplies a membership identifier, which the server resolves again against the authenticated identity and an active organization. The browser never supplies an authoritative customer or DNSFilter organization identifier.
- An MSP grant is stored and verified independently; no customer role implies an MSP grant.
- The phase does not invoke C2, DNSFilter, GCS, Site, Agent, policy, or change APIs.
- The home page displays only the authenticated organization and selected role. C2 receipt and inventory projections are reserved for a later approved phase.

## Provisioning boundary

The migration creates no identities, customer organizations, memberships, mappings, or MSP grants automatically. A separately approved, human-confirmed provisioning step must create the first MSP grant and customer organization mapping before the initial-administrator invitation endpoint can be used.

## Verification

`npm test` runs TypeScript compilation and nine offline tests covering personal login, stale-session rejection, token hashing, membership scope enforcement, MSP escalation rejection, existing session preservation, existing Zabbix route mounting, and additive migration coverage.

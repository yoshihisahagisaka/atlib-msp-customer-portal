# Secure Guard MVP Phase 2 — C2 projection validation

## Scope

This change adds a customer-safe, read-only projection for a previously verified C2 DryRun receipt. It does not call Cloud Run, DNSFilter, GCS, or any Google Cloud API.

## C2 contract used

The C2 canonical contract verifies a DryRun plan by its ordered SHA-256 plan hash, pinned GCS generation, and Organization path. Its plan body contains DNSFilter site IDs and names, Agent UUIDs, and hostnames. Those values are intentionally excluded from the portal database and HTTP responses.

The Phase 2 verifier accepts a candidate only when all of the following agree:

- the server-side Customer Organization → DNSFilter Organization mapping;
- the plan's Organization, ordered hash, and canonical schema;
- the generation format and GCS object path binding that Organization and plan hash;
- DryRun mode and zero mutations; and
- the C2 paging and Site/Agent cardinality contract.

The stored and displayed projection contains only receipt metadata, observation/completion timestamps, counts, opaque display ordinals, and constrained Agent state labels.

## Real-environment status

No GCS object or C2 plan body was read in this Phase 2 task. The documented C2 contract shows that a safe projection can be derived, but real receipt ingestion and its GCS read-only adapter are not configured or validated here. Until a verified projection is present, the home shows it as unavailable and the Site/Agent APIs return `C2_RECEIPT_UNAVAILABLE`; they do not return an empty successful inventory.

## Offline verification

The tests cover hash/generation/Organization binding, omission of sensitive plan fields, cross-Organization rejection, tampered-plan rejection, unavailable-source rejection, and server-side Membership scope rejection.

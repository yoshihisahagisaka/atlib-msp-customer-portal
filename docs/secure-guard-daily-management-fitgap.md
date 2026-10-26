# Secure Guard 日常管理画面 — PoC Fit/Gap

## Adopted PoC contract

The server uses only these GET collection paths, with the DNSFilter Organization resolved from the authenticated Customer Membership on the server:

- `GET /v1/networks?organization_id={organization}`
- `GET /v1/user_agents?organization_ids={organization}`
- `GET /v1/user_agents?organization_ids={organization}&network_ids={site}`

It does not retrieve or interpret OpenAPI before the inventory request. It requires every Network and Agent record to declare the mapped Organization, reconciles Site-scoped Agents with the Organization-wide collection, rejects duplicate IDs and unsafe or scope-changing pagination, and never issues a non-GET request.

Each DNSFilter GET has an explicit eight-second AbortController timeout. Timeout and transport errors return the same safe unavailable result; the client contains no retry loop. The home calls only `GET /api/secure-guard/overview`, whose single Inventory result contains the summary, Sites, and Agents rendered on that screen.

## Display boundary

The authenticated Organization may view its Network name, Agent hostname and identifier, association, and the API-provided `status` / `agent_state`. The response intentionally contains no API key, authorization header, raw JSON, C2 receipt, GCS content, or inferred policy value. The current verified Network response evidence does not establish a safe policy display field, so Site `policy` is `null` and the UI says that no Policy information was provided by the API.

## Offline result

Synthetic fixtures cover multiple Sites and Agents, pagination acceptance and mixed `total_count` rejection, foreign-Organization rejection, upstream failure, collection reconciliation, Membership scope rejection, missing mapping rejection, and the existing Phase 1 and Zabbix route regression suite.

## Required before a real DNSFilter GET

No live DNSFilter request was made by this change. Before approval for a live GET, an operator must separately verify:

1. an active `dnsfilter_organization_mappings` record exists for the intended Customer Organization;
2. the portal runtime receives `DNSFILTER_API_KEY` only through its server-side secret-injection configuration; the browser must never receive it;
3. the deployed portal service is authorized to use that already-approved secret binding; and
4. the PoC collection shape and endpoint/query contract remain valid for the intended Organization.

This branch performs no migration, deployment, GCP, IAM, Secret, DNSFilter, or C2 operation.

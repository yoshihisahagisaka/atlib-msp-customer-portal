-- Secure Guard organizations are usable without a Zabbix customer record.
-- Existing optional customer_id values are preserved for legacy portal customers.

ALTER TABLE customer_organizations
  ADD COLUMN organization_name VARCHAR(255);

UPDATE customer_organizations o
SET organization_name = c.company_name
FROM customers c
WHERE c.id = o.customer_id;

ALTER TABLE customer_organizations
  ALTER COLUMN organization_name SET NOT NULL,
  ALTER COLUMN customer_id DROP NOT NULL,
  DROP CONSTRAINT customer_organizations_customer_id_fkey;

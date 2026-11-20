# Secure Guard Staging DB Secret IAM setup and bootstrap cleanup.
# Windows PowerShell 5.1 compatible. Never reads Secret payloads.

param(
  [ValidateSet('Grant', 'RemoveBootstrap')]
  [string]$Action,
  [string]$ProjectId = 'msp-zabbix'
)

$ErrorActionPreference = 'Stop'
$bootstrapMember = 'serviceAccount:secumie-db-bootstrap-stg@msp-zabbix.iam.gserviceaccount.com'
$bindings = @(
  @{
    Secret = 'secure-guard-stg-db-runtime-password'
    Member = 'serviceAccount:secure-guard-db-runtime-stg@msp-zabbix.iam.gserviceaccount.com'
  },
  @{
    Secret = 'secure-guard-stg-db-overage-password'
    Member = 'serviceAccount:secure-guard-db-overage-stg@msp-zabbix.iam.gserviceaccount.com'
  },
  @{
    Secret = 'secure-guard-stg-db-migration-password'
    Member = 'serviceAccount:secure-guard-db-migration-stg@msp-zabbix.iam.gserviceaccount.com'
  }
)

function Invoke-IamChange {
  param(
    [string]$Verb,
    [string]$Secret,
    [string]$Member
  )

  if ($Secret -notmatch '^secure-guard-stg-db-(runtime|overage|migration)-password$') {
    throw 'SECRET_TARGET_MISMATCH'
  }
  if ($Member -notmatch '^serviceAccount:[a-z0-9-]+@msp-zabbix\.iam\.gserviceaccount\.com$') {
    throw 'IAM_MEMBER_MISMATCH'
  }

  & gcloud.cmd secrets "$Verb-iam-policy-binding" $Secret `
    --project=$ProjectId `
    --member=$Member `
    --role=roles/secretmanager.secretAccessor `
    --condition=None `
    --quiet `
    --format='value(bindings.role)'
  if ($LASTEXITCODE -ne 0) {
    throw "SECRET_IAM_${Verb}_FAILED:$Secret"
  }
}

foreach ($item in $bindings) {
  # Explicit key access and conversion prevent PowerShell from passing the
  # literal text System.Collections.Hashtable.Member to native commands.
  $secret = [string]$item['Secret']
  $member = [string]$item['Member']

  if ($Action -eq 'Grant') {
    Invoke-IamChange -Verb 'add' -Secret $secret -Member $member
    Invoke-IamChange -Verb 'add' -Secret $secret -Member $bootstrapMember
    [Console]::Out.WriteLine("SECRET_IAM_GRANTED:$secret")
  }
  else {
    Invoke-IamChange -Verb 'remove' -Secret $secret -Member $bootstrapMember
    [Console]::Out.WriteLine("BOOTSTRAP_IAM_REMOVED:$secret")
  }
}


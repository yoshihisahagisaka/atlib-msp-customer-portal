# Secure Guard trial Site preflight: DNSFilter GET only, one request per endpoint.
# Windows PowerShell 5.1+; no DNSFilter writes, key output, or raw response output.
# Run in the existing authenticated Windows environment:
# powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\secure-guard-trial-site-readonly-preflight.ps1

param(
  [string]$ProjectId = 'msp-zabbix',
  [string]$SecretName = 'secure-guard-dnsfilter-api-key'
)

$ErrorActionPreference = 'Stop'
$organizationId = '10222523'
$expectedMspId = '11473'
$apiKey = $null
$headers = $null

function Get-ReadOnlyDnsFilter {
  param([string]$Path)
  # Never follow a redirect with the Authorization header, and never retry.
  Invoke-RestMethod -Method GET -Uri "https://api.dnsfilter.com$Path" `
    -Headers $headers -TimeoutSec 8 -MaximumRedirection 0 -ErrorAction Stop
}

function Get-OrganizationReference {
  param($Item)
  if ($null -ne $Item.attributes -and $null -ne $Item.attributes.organization_id) {
    return [string]$Item.attributes.organization_id
  }
  if ($null -ne $Item.relationships -and $null -ne $Item.relationships.organization -and
      $null -ne $Item.relationships.organization.data) {
    return [string]$Item.relationships.organization.data.id
  }
  return 'UNKNOWN'
}

try {
  $rawKey = & gcloud.cmd secrets versions access 1 --secret=$SecretName --project=$ProjectId 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($rawKey -join ''))) {
    throw 'SECRET_ACCESS_FAILED'
  }
  $apiKey = ($rawKey -join '').Trim()
  Remove-Variable rawKey -ErrorAction SilentlyContinue
  $headers = @{ Authorization = "Bearer $apiKey"; Accept = 'application/json' }

  $organization = Get-ReadOnlyDnsFilter -Path "/v1/organizations/$organizationId?include_current_mrr=true"
  if ($null -eq $organization.data -or [string]$organization.data.id -ne $organizationId -or
      [string]$organization.data.attributes.managed_by_msp_id -ne $expectedMspId) {
    throw 'ORGANIZATION_MSP_MISMATCH'
  }
  $subscription = 'UNKNOWN'
  if ($null -ne $organization.data.relationships -and
      $null -ne $organization.data.relationships.subscription) {
    $subscription = if ($null -eq $organization.data.relationships.subscription.data) { 'NULL' } else { 'PRESENT_NOT_VALIDATED' }
  }
  Write-Output ([pscustomobject]@{ Check='Organization'; Id=$organizationId; MspMatch=$true; Subscription=$subscription })

  foreach ($check in @(
    @{ Name='Policy'; Path="/v1/policies?organization_id=$organizationId&include_global_policies=true" },
    @{ Name='BlockPage'; Path="/v1/block_pages?organization_id=$organizationId" },
    @{ Name='Site'; Path="/v1/networks?organization_id=$organizationId" }
  )) {
    $response = Get-ReadOnlyDnsFilter -Path $check.Path
    if ($null -eq $response -or $response.data -isnot [array]) { throw "UNEXPECTED_$($check.Name)_SHAPE" }
    $complete = $null -ne $response.links -and
      $null -ne $response.links.PSObject.Properties['next'] -and $null -eq $response.links.next
    Write-Output ([pscustomobject]@{
      Check=$check.Name
      RecordCount=@($response.data).Count
      Pagination=if ($complete) { 'COMPLETE' } else { 'UNKNOWN_STOP' }
    })
    if (-not $complete) { throw "INCOMPLETE_$($check.Name)_PAGINATION" }

    foreach ($item in $response.data) {
      if ($null -eq $item -or $null -eq $item.id -or $null -eq $item.attributes) {
        throw "UNEXPECTED_$($check.Name)_ITEM"
      }
      $ownerId = Get-OrganizationReference -Item $item
      $global = if ($check.Name -eq 'Policy' -and $item.attributes.is_global_policy -eq $true) { 'GLOBAL_CANDIDATE' } else { 'NO_GLOBAL_EVIDENCE' }
      $applies = if ($ownerId -eq $organizationId) { 'OWNED' } elseif ($global -eq 'GLOBAL_CANDIDATE') { 'GLOBAL_NEEDS_VERIFICATION' } else { 'UNKNOWN_STOP' }
      Write-Output ([pscustomobject]@{
        Check="$($check.Name)Candidate"
        Id=[string]$item.id
        Name=[string]$item.attributes.name
        OwnerOrganizationId=$ownerId
        GlobalStatus=$global
        ApplicableToOrganization=$applies
      })
    }
  }

  Write-Output ([pscustomobject]@{
    Check='Gate'
    Result='INFORMATION_ONLY_SITE_POST_STOP'
    Note='Global Policy/Block Page applicability, Site duplicate name, SKU and billing terms require separate confirmation. POST remains STOP.'
  })
} catch {
  # Deliberately omit exception messages and raw HTTP bodies: they are not evidence for retry.
  Write-Output ([pscustomobject]@{ Check='Gate'; Result='UNKNOWN_STOP'; Note='No POST/DELETE attempted. Inspect current state manually; do not auto-retry.' })
  exit 1
} finally {
  Remove-Variable apiKey,rawKey,headers,organization,response -ErrorAction SilentlyContinue
}

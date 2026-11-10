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
$stopStage = 'SECRET_ACCESS'
$completedGetCount = 0

function Write-SafeRecord {
  param($Record)
  # Write one complete JSON line immediately, even if a later stage exits with code 1.
  [Console]::Out.WriteLine(($Record | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

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

  $stopStage = 'ORGANIZATION_GET'
  $organization = Get-ReadOnlyDnsFilter -Path "/v1/organizations/$organizationId?include_current_mrr=true"
  $completedGetCount++
  $stopStage = 'ORGANIZATION_VALIDATE'
  if ($null -eq $organization.data -or [string]$organization.data.id -ne $organizationId -or
      [string]$organization.data.attributes.managed_by_msp_id -ne $expectedMspId) {
    throw 'ORGANIZATION_MSP_MISMATCH'
  }
  $subscription = 'UNKNOWN'
  if ($null -ne $organization.data.relationships -and
      $null -ne $organization.data.relationships.subscription) {
    $subscription = if ($null -eq $organization.data.relationships.subscription.data) { 'NULL' } else { 'PRESENT_NOT_VALIDATED' }
  }
  Write-SafeRecord ([pscustomobject]@{ Check='Organization'; Id=$organizationId; MspMatch=$true; Subscription=$subscription })

  foreach ($check in @(
    @{ Name='Policy'; Path="/v1/policies?organization_id=$organizationId&include_global_policies=true" },
    @{ Name='BlockPage'; Path="/v1/block_pages?organization_id=$organizationId" },
    @{ Name='Site'; Path="/v1/networks?organization_id=$organizationId" }
  )) {
    $stagePrefix = switch ($check.Name) {
      'Policy' { 'POLICY' }
      'BlockPage' { 'BLOCK_PAGE' }
      'Site' { 'SITE' }
      default { throw 'UNEXPECTED_CHECK' }
    }
    $stopStage = "${stagePrefix}_GET"
    $response = Get-ReadOnlyDnsFilter -Path $check.Path
    $completedGetCount++
    $stopStage = "${stagePrefix}_VALIDATE"
    if ($null -eq $response -or $response.data -isnot [array]) { throw "UNEXPECTED_$($check.Name)_SHAPE" }
    $complete = $null -ne $response.links -and
      $null -ne $response.links.PSObject.Properties['next'] -and $null -eq $response.links.next
    Write-SafeRecord ([pscustomobject]@{
      Check=$check.Name
      RecordCount=@($response.data).Count
      Pagination=$(if ($complete) { 'COMPLETE' } else { 'UNKNOWN_STOP' })
    })
    if (-not $complete) { throw "INCOMPLETE_$($check.Name)_PAGINATION" }

    foreach ($item in $response.data) {
      if ($null -eq $item -or $null -eq $item.id -or $null -eq $item.attributes) {
        throw "UNEXPECTED_$($check.Name)_ITEM"
      }
      $ownerId = Get-OrganizationReference -Item $item
      $global = if ($check.Name -eq 'Policy' -and $item.attributes.is_global_policy -eq $true) { 'GLOBAL_CANDIDATE' } else { 'NO_GLOBAL_EVIDENCE' }
      $applies = if ($ownerId -eq $organizationId) { 'OWNED' } elseif ($global -eq 'GLOBAL_CANDIDATE') { 'GLOBAL_NEEDS_VERIFICATION' } else { 'UNKNOWN_STOP' }
      Write-SafeRecord ([pscustomobject]@{
        Check="$($check.Name)Candidate"
        Id=[string]$item.id
        Name=[string]$item.attributes.name
        OwnerOrganizationId=$ownerId
        GlobalStatus=$global
        ApplicableToOrganization=$applies
      })
    }
  }

  Write-SafeRecord ([pscustomobject]@{
    Check='Gate'
    Result='INFORMATION_ONLY_SITE_POST_STOP'
    Note='Global Policy/Block Page applicability, Site duplicate name, SKU and billing terms require separate confirmation. POST remains STOP.'
  })
} catch {
  # Only fixed stage codes and a GET count are emitted. No exception/HTTP body/secret.
  [Console]::Out.WriteLine('{"Check":"Gate","Result":"UNKNOWN_STOP","Stage":"' + $stopStage + '","CompletedGetCount":' + $completedGetCount + '}')
  [Console]::Out.Flush()
  exit 1
} finally {
  Remove-Variable apiKey,rawKey,headers,organization,response -ErrorAction SilentlyContinue
}

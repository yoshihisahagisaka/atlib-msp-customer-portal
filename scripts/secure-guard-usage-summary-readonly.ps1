# Secure Guard: one-time, READ-ONLY DNSFilter official usage-summary inspection.
# Outputs field names and scalar count values only. Never shows API keys, hostnames, Agent IDs or raw bodies.
# Run in Windows PowerShell 5.1+ from the repository root.
# The API's 'active' count is NOT assumed equivalent to GUI 'Protected'.
# This is not a license counting implementation, scheduled monitor or permission to bill from these values.
[CmdletBinding()]
param(
  [string]$ProjectId = 'msp-zabbix',
  [string]$SecretName = 'secure-guard-dnsfilter-api-key'
)

$ErrorActionPreference = 'Stop'
$key = $null
$headers = $null

function Show-CountFields([object]$Data) {
  if ($null -eq $Data -or $Data -is [array] -or $Data -is [string]) {
    Write-Output 'RESPONSE_SHAPE_UNVERIFIED'
    return
  }
  if ($Data -is [System.Collections.IDictionary]) {
    $props = @($Data.GetEnumerator() | ForEach-Object {
      [pscustomobject]@{ Name = [string]$_.Key; Value = $_.Value }
    })
  } else {
    $props = @($Data.PSObject.Properties | ForEach-Object {
      [pscustomobject]@{ Name = $_.Name; Value = $_.Value }
    })
  }
  $names = @($props | ForEach-Object { $_.Name })
  Write-Host ("ReturnedFields: " + ($names -join ', '))
  foreach ($prop in $props) {
    if ($prop.Name -match '(?i)client|roaming|protected|active|license|usage|total|count' -and
        $null -ne $prop.Value -and
        ($prop.Value -is [byte] -or $prop.Value -is [int] -or
         $prop.Value -is [long] -or $prop.Value -is [decimal] -or
         $prop.Value -is [double])) {
      Write-Host ("{0}: {1}" -f $prop.Name, $prop.Value)
    }
  }
}

try {
  $raw = @(gcloud.cmd secrets versions access 1 --secret=$SecretName --project=$ProjectId)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($raw -join ''))) {
    throw 'SECRET_ACCESS_FAILED'
  }
  $key = ($raw -join '').Trim()
  Remove-Variable raw -ErrorAction SilentlyContinue
  $headers = @{ Authorization = "Bearer $key"; Accept = 'application/json' }

  $organizations = @(
    @{ Name = 'Test02 Core'; Id = '10220954' },
    @{ Name = 'Test03 Plus'; Id = '10222523' }
  )
  # Compare two official GET summaries against the GUI "Roaming Clients in Use".
  # Issue #36 observed roaming_clients_in_use=2 in organization_usage_detailed;
  # the later Fit/Gap checked the different key roaming_client_count (blank).
  # Neither endpoint is approved for automated overage alerts until current
  # responses and UI definitions are reconciled. No raw response is printed.
  $toDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
  $fromDate = (Get-Date).ToUniversalTime().AddDays(-7).ToString('yyyy-MM-dd')

  foreach ($org in $organizations) {
    # The previously exploratory total_client_stats endpoint returned HTTP 400
    # for both test Organizations; do not retry it for this approved check.
    $checks = @(
      @{
        Label = "organization_usage_detailed (from=$fromDate; to=$toDate)"
        Uri = "https://api.dnsfilter.com/v1/metrics/organization_usage_detailed/$($org.Id)?from=$fromDate&to=$toDate"
      }
    )
    foreach ($check in $checks) {
      Write-Host ("=== {0} : {1} ===" -f $org.Name, $check.Label)
      $uri = $check.Uri
      try {
        $response = Invoke-RestMethod -Method GET -Uri $uri -Headers $headers -TimeoutSec 15
        Write-Host 'HTTP: 200'
        # Some endpoints return 'data'; non-standard results stay unverified.
        if ($null -ne $response.PSObject.Properties['data']) {
          Show-CountFields $response.data
        } else {
          Write-Host 'RESPONSE_SHAPE_UNVERIFIED'
          Write-Host ("TopLevelFields: " + ($response.PSObject.Properties.Name -join ', '))
        }
      } catch {
        $status = if ($null -ne $_.Exception.Response) {
          [string][int]$_.Exception.Response.StatusCode
        } else {
          'NO_HTTP_RESPONSE'
        }
        Write-Host "HTTP/Error: $status"
      } finally {
        Remove-Variable response,uri -ErrorAction SilentlyContinue
      }
    }
  }
} finally {
  Remove-Variable key,headers -ErrorAction SilentlyContinue
}

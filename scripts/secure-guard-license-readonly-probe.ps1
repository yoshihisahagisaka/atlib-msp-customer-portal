# DNSFilter Secure Guard license usage read-only probe (Windows PowerShell 5.1+)
# No writes, no license changes, no raw API response or API key output.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\secure-guard-license-readonly-probe.ps1
param(
  [string]$ProjectId = 'msp-zabbix',
  [string]$SecretName = 'secure-guard-dnsfilter-api-key'
)

$ErrorActionPreference = 'Stop'
$key = $null
$headers = $null
try {
  $raw = gcloud.cmd secrets versions access 1 --secret=$SecretName --project=$ProjectId
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($raw -join ''))) {
    throw 'SECRET_ACCESS_FAILED'
  }
  $key = ($raw -join '').Trim()
  Remove-Variable raw -ErrorAction SilentlyContinue
  $headers = @{ Authorization = "Bearer $key"; Accept = 'application/json' }

  foreach ($org in @(
    @{ Label = 'Test02 Core'; Id = '10220954' },
    @{ Label = 'Test03 Plus'; Id = '10222523' }
  )) {
    $id = $org.Id
    $path = "/v1/metrics/organization_usage_detailed/$id"
    try {
      $result = Invoke-RestMethod -Method GET -Uri "https://api.dnsfilter.com$path" -Headers $headers -TimeoutSec 15
      $data = $result.data
      if ($null -eq $data -or $null -eq $data.PSObject) {
        Write-Output ([pscustomobject]@{ Organization=$org.Label; Id=$id; Result='UNEXPECTED_RESPONSE'; ReturnedFields='(none)' })
        continue
      }
      $fieldNames = @($data.PSObject.Properties.Name)
      $fields = @('organization_id','plan','term','roaming_client_count','mobile_roaming_client_count','user_count','wifi_count','from','to','days_in_period')
      $view = [ordered]@{
        Organization = $org.Label
        Id = $id
        Result = 'HTTP_200'
      }
      foreach ($field in $fields) {
        $property = $data.PSObject.Properties[$field]
        $view[$field] = if ($null -eq $property -or $null -eq $property.Value) { '(not returned)' } else { $property.Value }
      }
      $view['ReturnedFields'] = $fieldNames -join ', '
      Write-Output ([pscustomobject]$view)
    } catch {
      $status = if ($null -ne $_.Exception.Response) { [string][int]$_.Exception.Response.StatusCode } else { 'NO_HTTP_RESPONSE' }
      Write-Output ([pscustomobject]@{ Organization=$org.Label; Id=$id; Result="HTTP_OR_ERROR_$status"; ReturnedFields='(not displayed)' })
    } finally {
      Remove-Variable result,data,view,fieldNames -ErrorAction SilentlyContinue
    }
  }
} finally {
  Remove-Variable key,headers -ErrorAction SilentlyContinue
}

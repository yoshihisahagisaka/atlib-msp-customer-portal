# Secure Guard Staging DB password initialization.
# Windows PowerShell 5.1 compatible. Adds exactly one version to each approved,
# empty Secret without writing secret values to stdout, stderr, disk, or arguments.

param(
  [string]$ProjectId = 'msp-zabbix'
)

$ErrorActionPreference = 'Stop'
$secretNames = @(
  'secure-guard-stg-db-runtime-password',
  'secure-guard-stg-db-overage-password',
  'secure-guard-stg-db-migration-password'
)

function Get-VersionCount {
  param([string]$SecretName)

  $versions = @(& gcloud.cmd secrets versions list $SecretName `
    --project=$ProjectId --format='value(name)' 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "SECRET_VERSION_PREFLIGHT_FAILED:$SecretName"
  }
  return @($versions | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
}

function Add-SecretVersionWithoutDisclosure {
  param([string]$SecretName)

  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
    $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

    $gcloud = (Get-Command gcloud.cmd -ErrorAction Stop).Source
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $env:ComSpec
    $startInfo.Arguments = "/d /s /c `"`"$gcloud`" secrets versions add $SecretName --project=$ProjectId --data-file=- --quiet --format=`"value(name,state)`"`""
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::Start($startInfo)
    $process.StandardInput.Write($password)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($process.ExitCode -ne 0) {
      throw "SECRET_VERSION_ADD_FAILED:$SecretName"
    }
  }
  finally {
    if ($null -ne $rng) { $rng.Dispose() }
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    $password = $null
    $stdout = $null
    $stderr = $null
  }
}

foreach ($secretName in $secretNames) {
  if ((Get-VersionCount -SecretName $secretName) -ne 0) {
    throw "SECRET_NOT_EMPTY_STOP:$secretName"
  }
}

foreach ($secretName in $secretNames) {
  Add-SecretVersionWithoutDisclosure -SecretName $secretName
  if ((Get-VersionCount -SecretName $secretName) -ne 1) {
    throw "SECRET_VERSION_VERIFY_FAILED:$secretName"
  }
  [Console]::Out.WriteLine("SECRET_VERSION_ADDED:$secretName")
}


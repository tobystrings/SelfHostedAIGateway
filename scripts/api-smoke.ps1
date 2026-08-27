$ErrorActionPreference = 'Stop'
$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    $probe = Invoke-WebRequest 'http://127.0.0.1:8080/health' -TimeoutSec 2
    if ($probe.StatusCode -eq 200) {
      $healthy = $true
      break
    }
  } catch {}
  Start-Sleep -Seconds 1
}
if (-not $healthy) { throw 'Gateway did not become healthy within 30 seconds' }
$settings = @{}
Get-Content -LiteralPath '.env' | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') {
    $settings[$matches[1].Trim()] = $matches[2].Trim()
  }
}
$health = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 10
$ready = Invoke-RestMethod 'http://127.0.0.1:8080/ready' -TimeoutSec 10
$missing = Invoke-WebRequest 'http://127.0.0.1:8080/v1/models' -SkipHttpErrorCheck -TimeoutSec 10
$invalid = Invoke-WebRequest 'http://127.0.0.1:8080/v1/models' -Headers @{ Authorization = 'Bearer gw_invalid' } -SkipHttpErrorCheck -TimeoutSec 10
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ email = $settings['BOOTSTRAP_ADMIN_EMAIL']; password = $settings['BOOTSTRAP_ADMIN_PASSWORD'] } | ConvertTo-Json
$login = Invoke-RestMethod 'http://127.0.0.1:8080/api/admin/login' -Method Post -ContentType 'application/json' -Body $loginBody -WebSession $session -TimeoutSec 10
$me = Invoke-RestMethod 'http://127.0.0.1:8080/api/admin/me' -WebSession $session -TimeoutSec 10
$providers = Invoke-RestMethod 'http://127.0.0.1:8080/api/admin/providers' -WebSession $session -TimeoutSec 10
$keyBody = @{ name = 'verification-key'; scopes = @('gateway:invoke') } | ConvertTo-Json
$key = Invoke-RestMethod 'http://127.0.0.1:8080/api/admin/keys' -Method Post -ContentType 'application/json' -Body $keyBody -Headers @{ 'x-csrf-token' = $login.csrf } -WebSession $session -TimeoutSec 10
$models = Invoke-RestMethod 'http://127.0.0.1:8080/v1/models' -Headers @{ Authorization = ('Bearer ' + $key.key) } -TimeoutSec 10
$null = Invoke-RestMethod ("http://127.0.0.1:8080/api/admin/keys/{0}" -f $key.id) -Method Delete -Headers @{ 'x-csrf-token' = $login.csrf } -WebSession $session -TimeoutSec 10
$csrfRejected = Invoke-WebRequest 'http://127.0.0.1:8080/api/admin/logout' -Method Post -ContentType 'application/json' -Body '{}' -Headers @{ 'x-csrf-token' = 'intentionally-invalid' } -WebSession $session -SkipHttpErrorCheck -TimeoutSec 10
[pscustomobject]@{
  health = $health.status
  ready = $ready.status
  database = $ready.database
  missingKeyStatus = [int]$missing.StatusCode
  invalidKeyStatus = [int]$invalid.StatusCode
  loginEmailMatches = ($me.email -eq $settings['BOOTSTRAP_ADMIN_EMAIL'])
  roles = ($me.roles -join ',')
  createdKeyPrefixOnly = $key.key.Substring(0, 10)
  modelsObject = $models.object
  modelCount = $models.data.Count
  providerCount = $providers.Count
  csrfRejectedStatus = [int]$csrfRejected.StatusCode
} | ConvertTo-Json -Compress

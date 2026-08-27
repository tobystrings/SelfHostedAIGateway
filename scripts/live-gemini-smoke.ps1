param(
    [string]$Provider = "Gemini",
    [string]$Model = "gemini-3.7-flash"
)

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:8080"
$settings = @{}
Get-Content -LiteralPath ".env" | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') {
        $settings[$matches[1].Trim()] = $matches[2].Trim()
    }
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$login = Invoke-RestMethod "$base/api/admin/login" -Method Post `
    -ContentType "application/json" -WebSession $session `
    -Body (@{
        email = $settings["BOOTSTRAP_ADMIN_EMAIL"]
        password = $settings["BOOTSTRAP_ADMIN_PASSWORD"]
    } | ConvertTo-Json)
$headers = @{ "x-csrf-token" = $login.csrf }

$discovered = Invoke-RestMethod "$base/api/admin/providers/$Provider/discover" `
    -Method Post -ContentType "application/json" -Body '{}' `
    -Headers $headers -WebSession $session
$models = Invoke-RestMethod "$base/api/admin/models" -WebSession $session
$target = $models | Where-Object {
    $_.provider_slug -eq $Provider -and $_.upstream_id -eq $Model
} | Select-Object -First 1
if (-not $target) { throw "Target Gemini model was not discovered" }

$verified = Invoke-RestMethod "$base/api/admin/models/$($target.id)/verify" `
    -Method Post -ContentType "application/json" -Body '{}' `
    -Headers $headers -WebSession $session
$chat = Invoke-RestMethod "$base/api/admin/playground/chat" -Method Post `
    -ContentType "application/json" -Headers $headers -WebSession $session `
    -Body (@{
        provider = $Provider
        model = $Model
        messages = @(@{ role = "user"; content = "Reply with exactly LIVE_OK" })
        maxOutputTokens = 128
    } | ConvertTo-Json -Depth 5)

[pscustomobject]@{
    discoveryContainsTarget = $discovered.id -contains $Model
    verificationStatus = $verified.verification_status
    callable = $verified.callable
    playgroundProvider = $chat.response.provider
    playgroundModel = $chat.response.model
    playgroundAnswered = -not [string]::IsNullOrWhiteSpace([string]$chat.response.message.content)
    playgroundReplyMatches = ([string]$chat.response.message.content) -match "LIVE_OK"
} | ConvertTo-Json -Compress


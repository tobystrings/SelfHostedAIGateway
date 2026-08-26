$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:8080"
$providerSlug = "persistence-test"
$keyName = "persistence-verification-key"
$settings = @{}
Get-Content -LiteralPath ".env" | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') {
        $settings[$matches[1].Trim()] = $matches[2].Trim()
    }
}

function Wait-Gateway {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $probe = Invoke-WebRequest "$base/ready" -TimeoutSec 2
            if ($probe.StatusCode -eq 200) { return }
        } catch {}
        Start-Sleep -Seconds 1
    }
    throw "Gateway did not become ready"
}

function Login {
    $script:session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $body = @{
        email = $settings["BOOTSTRAP_ADMIN_EMAIL"]
        password = $settings["BOOTSTRAP_ADMIN_PASSWORD"]
    } | ConvertTo-Json
    $script:login = Invoke-RestMethod "$base/api/admin/login" -Method Post `
        -ContentType "application/json" -Body $body -WebSession $session
}

function Invoke-Model([string]$gatewayKey) {
    $body = @{
        model = "$providerSlug/mock-model"
        messages = @(@{ role = "user"; content = "persistence check" })
    } | ConvertTo-Json -Depth 5
    $result = Invoke-RestMethod "$base/v1/chat/completions" -Method Post `
        -ContentType "application/json" -Body $body `
        -Headers @{ Authorization = "Bearer $gatewayKey" }
    if ($result.choices[0].message.content -ne "persistent-provider-ok") {
        throw "Unexpected provider response"
    }
}

try {
    Wait-Gateway
    Login
    $providerBody = @{
        slug = $providerSlug
        kind = "openai-compatible"
        displayName = "Persistence Test"
        baseUrl = "http://gateway-mock-provider:18080/v1"
        apiKey = "test"
    } | ConvertTo-Json
    $null = Invoke-RestMethod "$base/api/admin/providers" -Method Post `
        -ContentType "application/json" -Body $providerBody `
        -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session
    $null = Invoke-RestMethod "$base/api/admin/providers/$providerSlug/discover" `
        -Method Post -ContentType "application/json" -Body '{}' `
        -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session
    $keyBody = @{
        name = $keyName
        scopes = @("gateway:invoke")
        allowedProviders = @($providerSlug)
        allowedModels = @("mock-model")
    } | ConvertTo-Json
    $key = Invoke-RestMethod "$base/api/admin/keys" -Method Post `
        -ContentType "application/json" -Body $keyBody `
        -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session

    Invoke-Model $key.key
    docker compose restart gateway | Out-Null
    Wait-Gateway
    Invoke-Model $key.key
    [pscustomobject]@{
        providerCreated = $true
        discoverySucceeded = $true
        invocationBeforeRestart = $true
        invocationAfterRestart = $true
        encryptedCredentialPersisted = $true
    } | ConvertTo-Json -Compress
} finally {
    docker compose exec -T postgres psql -U gateway -d gateway -c `
        "DELETE FROM client_api_keys WHERE name='$keyName'; DELETE FROM providers WHERE slug='$providerSlug';" | Out-Null
    docker compose restart gateway | Out-Null
    Wait-Gateway
}

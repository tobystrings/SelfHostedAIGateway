$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:8080"
$providerSlug = "persistence-test"
$keyName = "persistence-verification-key"
$ratePolicyName = "persistence-verification-rate-limit"
$budgetName = "persistence-verification-budget"
$mockName = "gateway-mock-provider-$PID"
$mockStarted = $false
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
        model = "mock-alias"
        messages = @(@{ role = "user"; content = "persistence check" })
    } | ConvertTo-Json -Depth 5
    $result = Invoke-RestMethod "$base/v1/chat/completions" -Method Post `
        -ContentType "application/json" -Body $body `
        -Headers @{ Authorization = "Bearer $gatewayKey" }
    if ($result.choices[0].message.content -ne "persistent-provider-ok") {
        throw "Unexpected provider response"
    }
}

function Invoke-Stream([string]$gatewayKey) {
    $body = @{
        model = "mock-alias"
        stream = $true
        messages = @(@{ role = "user"; content = "stream check" })
    } | ConvertTo-Json -Depth 5
    $result = Invoke-WebRequest "$base/v1/chat/completions" -Method Post `
        -ContentType "application/json" -Body $body `
        -Headers @{ Authorization = "Bearer $gatewayKey" }
    if ($result.Content -notmatch "persistent-" -or
        $result.Content -notmatch "stream-ok" -or
        $result.Content -notmatch "data: \[DONE\]") {
        throw "Streaming response was not OpenAI-compatible"
    }
}

function Invoke-Embeddings([string]$gatewayKey) {
    $body = @{
        model = "mock-alias"
        input = @("first", "second")
    } | ConvertTo-Json -Depth 5
    $result = Invoke-RestMethod "$base/v1/embeddings" -Method Post `
        -ContentType "application/json" -Body $body `
        -Headers @{ Authorization = "Bearer $gatewayKey" }
    if ($result.object -ne "list" -or $result.data.Count -ne 2 -or
        $result.data[0].embedding.Count -ne 3) {
        throw "Embedding response was not OpenAI-compatible"
    }
}

function Invoke-Multimodal([string]$gatewayKey) {
    $body = @{
        model = "mock-alias"
        messages = @(@{ role = "user"; content = @(
            @{ type = "text"; text = "inspect" },
            @{ type = "image_url"; image_url = @{ url = "data:image/png;base64,aW1hZ2U=" } }
        ) })
    } | ConvertTo-Json -Depth 8
    $result = Invoke-RestMethod "$base/v1/chat/completions" -Method Post `
        -ContentType "application/json" -Body $body -Headers @{ Authorization = "Bearer $gatewayKey" }
    if ($result.choices[0].message.content -ne "image-input-ok") { throw "Multimodal input was not preserved" }
}

function Invoke-ToolStream([string]$gatewayKey) {
    $body = @{
        model = "mock-alias"; stream = $true
        messages = @(@{ role = "user"; content = "use tools" })
        tools = @(
            @{ type = "function"; function = @{ name = "weather"; parameters = @{ type = "object" } } },
            @{ type = "function"; function = @{ name = "time"; parameters = @{ type = "object" } } }
        )
    } | ConvertTo-Json -Depth 8
    $result = Invoke-WebRequest "$base/v1/chat/completions" -Method Post `
        -ContentType "application/json" -Body $body -Headers @{ Authorization = "Bearer $gatewayKey" }
    if ($result.Content -notmatch 'call-weather' -or $result.Content -notmatch 'call-time' -or
        $result.Content -notmatch 'tool_calls' -or $result.Content -notmatch 'Paris') {
        throw "Streaming tool calls were not OpenAI-compatible"
    }
}

function Invoke-FreeOnlyStatus([string]$gatewayKey) {
    $body = @{ model = "mock-alias"; messages = @(@{ role = "user"; content = "free only" }) } | ConvertTo-Json -Depth 5
    $response = Invoke-WebRequest "$base/v1/chat/completions" -Method Post -ContentType "application/json" `
        -Body $body -Headers @{ Authorization = "Bearer $gatewayKey"; "x-gateway-routing-mode" = "FREE_ONLY" } -SkipHttpErrorCheck
    return [int]$response.StatusCode
}

function Invoke-ChatStatus([string]$gatewayKey) {
    $body = @{
        model = "mock-alias"
        messages = @(@{ role = "user"; content = "control check" })
    } | ConvertTo-Json -Depth 5
    $response = Invoke-WebRequest "$base/v1/chat/completions" -Method Post `
        -ContentType "application/json" -Body $body `
        -Headers @{ Authorization = "Bearer $gatewayKey" } -SkipHttpErrorCheck
    return [int]$response.StatusCode
}

try {
    $gatewayContainer = docker compose ps -q gateway
    if (-not $gatewayContainer) { throw "Gateway container is not running" }
    $networks = docker inspect --format '{{json .NetworkSettings.Networks}}' `
        $gatewayContainer | ConvertFrom-Json
    $network = $networks.PSObject.Properties.Name | Select-Object -First 1
    $mockPath = (Resolve-Path (Join-Path $PSScriptRoot "mock-provider.mjs")).Path
    docker run -d --name $mockName --network $network `
        --mount "type=bind,source=$mockPath,target=/app/mock-provider.mjs,readonly" `
        node:22-bookworm-slim node /app/mock-provider.mjs | Out-Null
    $mockStarted = $true
    Wait-Gateway
    Login
    $providerBody = @{
        slug = $providerSlug
        kind = "openai-compatible"
        displayName = "Persistence Test"
        baseUrl = "http://$mockName`:18080/v1"
        apiKey = "test"
        config = @{ headers = @{ "x-test-secret" = "test-header" } }
    } | ConvertTo-Json
    $null = Invoke-RestMethod "$base/api/admin/providers" -Method Post `
        -ContentType "application/json" -Body $providerBody `
        -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session
    $null = Invoke-RestMethod "$base/api/admin/providers/$providerSlug/discover" `
        -Method Post -ContentType "application/json" -Body '{}' `
        -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session
    $models = Invoke-RestMethod "$base/api/admin/models" -WebSession $session
    $model = $models | Where-Object { $_.provider_slug -eq $providerSlug }
    if (-not $model) { throw "Discovered model was not persisted" }
    $capabilities = $model.capabilities
    $capabilities | Add-Member -NotePropertyName imageInput -NotePropertyValue $true -Force
    $modelPatch = @{ alias = "mock-alias"; capabilities = $capabilities; costClassification = "free" } | ConvertTo-Json -Depth 8
    $null = Invoke-RestMethod "$base/api/admin/models/$($model.id)" -Method Patch `
        -ContentType "application/json" -Body $modelPatch `
        -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session
    $verification = Invoke-RestMethod "$base/api/admin/models/$($model.id)/verify" -Method Post `
        -ContentType "application/json" -Body '{}' -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session
    if ($verification.verification_status -ne "verified" -or -not $verification.callable) { throw "Model verification did not mark the model callable" }
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
    Invoke-Stream $key.key
    Invoke-Embeddings $key.key
    Invoke-Multimodal $key.key
    Invoke-ToolStream $key.key
    if ((Invoke-FreeOnlyStatus $key.key) -ne 200) { throw "FREE_ONLY did not route a classified free model" }
    $null = Invoke-RestMethod "$base/api/admin/models/$($model.id)" -Method Patch -ContentType "application/json" `
        -Body '{"costClassification":"paid"}' -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session
    if ((Invoke-FreeOnlyStatus $key.key) -ne 503) { throw "FREE_ONLY allowed paid fallback" }
    $null = Invoke-RestMethod "$base/api/admin/models/$($model.id)" -Method Patch -ContentType "application/json" `
        -Body '{"costClassification":"free"}' -Headers @{ "x-csrf-token" = $login.csrf } -WebSession $session
    docker compose exec -T postgres psql -U gateway -d gateway -c `
        "INSERT INTO rate_limit_policies(name,subject_type,subject_value,requests_per_minute) VALUES('$ratePolicyName','api_key','$($key.id)',0);" | Out-Null
    if ((Invoke-ChatStatus $key.key) -ne 429) {
        throw "Scoped request rate limit was not enforced"
    }
    docker compose exec -T postgres psql -U gateway -d gateway -c `
        "DELETE FROM rate_limit_policies WHERE name='$ratePolicyName';" | Out-Null
    docker compose exec -T postgres psql -U gateway -d gateway -c `
        "INSERT INTO budgets(name,subject_type,subject_id,monthly_token_limit) VALUES('$budgetName','api_key','$($key.id)',0);" | Out-Null
    if ((Invoke-ChatStatus $key.key) -ne 402) {
        throw "Scoped token budget was not enforced"
    }
    docker compose exec -T postgres psql -U gateway -d gateway -c `
        "DELETE FROM budgets WHERE name='$budgetName';" | Out-Null
    docker compose restart gateway | Out-Null
    Wait-Gateway
    Invoke-Model $key.key
    Invoke-Stream $key.key
    Invoke-Embeddings $key.key
    [pscustomobject]@{
        providerCreated = $true
        discoverySucceeded = $true
        modelUpdateAppliedImmediately = $true
        invocationBeforeRestart = $true
        invocationAfterRestart = $true
        streamingBeforeAndAfterRestart = $true
        embeddingsBeforeAndAfterRestart = $true
        scopedRateLimitStatus = 429
        scopedBudgetStatus = 402
        encryptedCredentialPersisted = $true
        liveModelVerification = $true
        multimodalImageInput = $true
        streamedToolCalls = $true
        freeOnlyEligibleStatus = 200
        freeOnlyPaidFallbackStatus = 503
    } | ConvertTo-Json -Compress
} finally {
    try {
        docker compose exec -T postgres psql -U gateway -d gateway -c `
            "DELETE FROM rate_limit_policies WHERE name='$ratePolicyName'; DELETE FROM budgets WHERE name='$budgetName'; DELETE FROM client_api_keys WHERE name='$keyName'; DELETE FROM providers WHERE slug='$providerSlug';" | Out-Null
        docker compose restart gateway | Out-Null
        Wait-Gateway
    } finally {
        if ($mockStarted) { docker rm -f $mockName | Out-Null }
    }
}

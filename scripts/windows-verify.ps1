$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))

function Write-Step([string]$Name) {
    Write-Host "=== $Name ===" -ForegroundColor Cyan
}

function Wait-Docker {
    Write-Step "Docker daemon"
    try {
        docker info *> $null
        Write-Host "Docker daemon is running." -ForegroundColor Green
        return
    } catch {
        $dockerDesktop = Join-Path $Env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
        if (-not (Test-Path $dockerDesktop)) {
            throw "Docker CLI is installed, but Docker Desktop was not found at '$dockerDesktop'. Start/install Docker Desktop, then rerun this script."
        }

        Write-Host "Docker Desktop is installed but not running. Starting it now..." -ForegroundColor Yellow
        Start-Process $dockerDesktop
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 2
            try {
                docker info *> $null
                Write-Host "Docker daemon is ready." -ForegroundColor Green
                return
            } catch {}
        }
        throw "Docker Desktop started, but the Linux engine did not become ready. Open Docker Desktop, wait until it says Engine running, then rerun this script."
    }
}

Write-Step "Environment"
node --version
npm --version
git --version
docker --version
docker compose version

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $master = [Convert]::ToBase64String($bytes)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $session = [Convert]::ToBase64String($bytes)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $pg = [Convert]::ToBase64String($bytes).Replace("/","_").Replace("+","-").TrimEnd("=")
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $adminPassword = [Convert]::ToBase64String($bytes).Replace("/","_").Replace("+","-").TrimEnd("=")
    $text = Get-Content ".env" -Raw
    $text = $text -replace 'POSTGRES_PASSWORD=change-me-now', "POSTGRES_PASSWORD=$pg"
    $text = $text -replace 'MASTER_ENCRYPTION_KEY=', "MASTER_ENCRYPTION_KEY=$master"
    $text = $text -replace 'SESSION_SECRET=change-this-to-a-long-random-secret', "SESSION_SECRET=$session"
    $text = $text -replace 'BOOTSTRAP_ADMIN_PASSWORD=change-this-immediately', "BOOTSTRAP_ADMIN_PASSWORD=$adminPassword"
    Set-Content ".env" $text -NoNewline
    Write-Host "Created .env with random local secrets." -ForegroundColor Green
    Write-Host "ADMIN EMAIL: admin@example.local" -ForegroundColor Yellow
    Write-Host "ADMIN PASSWORD: $adminPassword" -ForegroundColor Yellow
} else {
    Write-Host ".env already exists; preserving the current secrets." -ForegroundColor DarkGray
}

Write-Step "Install"
npm install --no-audit --no-fund

Write-Step "Typecheck"
npm run typecheck

Write-Step "Lint"
npm run lint

Write-Step "Tests"
npm test

Write-Step "Build"
npm run build

Wait-Docker

Write-Step "Docker build/start"
docker compose up -d --build

Write-Step "Waiting for health"
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:8080/health" -TimeoutSec 3
        if ($response.status -eq "ok") {
            $healthy = $true
            break
        }
    } catch {}
    Start-Sleep -Seconds 2
}

if (-not $healthy) {
    docker compose logs --tail 200
    throw "Gateway health check failed"
}

Write-Step "Ready"
Invoke-RestMethod -Uri "http://localhost:8080/ready" | ConvertTo-Json -Depth 5
Write-Host "Verification completed." -ForegroundColor Green

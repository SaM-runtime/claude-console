# Prints the latest locally recorded Codex rate-limit reading as one JSON line.
# This script only reads session rollout files and performs no network requests.
[CmdletBinding()]
param(
    [Parameter()]
    [AllowEmptyString()]
    [string]$SessionsRoot = ''
)

$ErrorActionPreference = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($SessionsRoot)) {
    $SessionsRoot = Join-Path $env:USERPROFILE '.codex\sessions'
}

if (-not (Test-Path -LiteralPath $SessionsRoot -PathType Container)) {
    return
}

$currentMonth = Join-Path $SessionsRoot (Get-Date -Format 'yyyy\MM')
$searchDirectories = @()
if (Test-Path -LiteralPath $currentMonth -PathType Container) {
    $searchDirectories += $currentMonth
}
if ($currentMonth -ne $SessionsRoot) {
    $searchDirectories += $SessionsRoot
}

foreach ($directory in $searchDirectories) {
    $files = Get-ChildItem -LiteralPath $directory -Recurse -File -Filter 'rollout-*.jsonl' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 5

    foreach ($file in $files) {
        $hit = Select-String -LiteralPath $file.FullName -Pattern '"rate_limits"' -SimpleMatch |
            Select-Object -Last 1
        if (-not $hit) {
            continue
        }

        $event = $hit.Line | ConvertFrom-Json
        $payload = if ($event.payload) { $event.payload } else { $event }
        $rateLimits = $payload.rate_limits
        if (-not $rateLimits -and $payload.info) {
            $rateLimits = $payload.info.rate_limits
        }
        if (-not $rateLimits) {
            continue
        }

        [pscustomobject]@{
            at = $event.timestamp
            rate_limits = $rateLimits
        } | ConvertTo-Json -Depth 6 -Compress
        return
    }
}

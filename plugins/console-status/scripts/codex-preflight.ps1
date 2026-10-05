# Read-only Codex broker preflight.
# Prints one line beginning with OK, STALE, or UNKNOWN. It never stops a process.
[CmdletBinding()]
param(
    [Parameter()]
    [AllowEmptyString()]
    [string]$CompanionScript = '',

    [Parameter()]
    [AllowEmptyString()]
    [string]$CompanionStateDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($CompanionStateDir)) {
    $localData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localData)) {
        $localData = $env:LOCALAPPDATA
    }
    $CompanionStateDir = Join-Path (Join-Path $localData 'Temp') 'codex-companion'
}

$companionStatus = if ([string]::IsNullOrWhiteSpace($CompanionScript)) {
    'UNKNOWN(unconfigured)'
} elseif (Test-Path -LiteralPath $CompanionScript -PathType Leaf) {
    'OK'
} else {
    'MISSING'
}

$codexPackage = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
if (-not $codexPackage) {
    "UNKNOWN codex=unavailable companion=$companionStatus"
    return
}

$currentVersion = $codexPackage.Version.ToString()
$expectedPathPart = "OpenAI.Codex_$currentVersion"
$stale = @{}

try {
    $appServers = Get-CimInstance Win32_Process -Filter "Name='codex.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -match 'app-server' }
} catch {
    "UNKNOWN codex=$currentVersion companion=$companionStatus process-scan=unavailable"
    return
}

foreach ($process in $appServers) {
    if ($process.ExecutablePath -and $process.ExecutablePath -match [regex]::Escape($expectedPathPart)) {
        continue
    }

    # app-server <- command shell <- companion broker
    $parent = $process
    for ($depth = 0; $depth -lt 3 -and $parent; $depth++) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($parent -and $parent.CommandLine -match 'app-server-broker\.mjs') {
            $stale[[int]$parent.ProcessId] = $true
            break
        }
    }
}

if ($stale.Count -eq 0) {
    "OK codex=$currentVersion companion=$companionStatus"
    return
}

$owners = @{}
if (Test-Path -LiteralPath $CompanionStateDir -PathType Container) {
    Get-ChildItem -LiteralPath $CompanionStateDir -Recurse -File -Filter 'broker.json' -ErrorAction SilentlyContinue |
        ForEach-Object {
            $workspace = $_.Directory.Name -replace '-[0-9a-f]{16}$', ''
            try {
                $content = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction Stop
                foreach ($match in [regex]::Matches($content, '"pid"\s*:\s*(\d+)')) {
                    $owners[[int]$match.Groups[1].Value] = $workspace
                }
            } catch {
                # An unreadable state file does not make the process scan unsafe.
            }
        }
}

$brokerSummary = $stale.Keys |
    Sort-Object |
    ForEach-Object {
        $workspace = $owners[[int]$_]
        if ([string]::IsNullOrWhiteSpace($workspace)) {
            $workspace = 'unknown'
        }
        "$_($workspace)"
    }

"STALE codex=$currentVersion companion=$companionStatus brokers=$($brokerSummary -join ' ')"

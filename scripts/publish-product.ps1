[CmdletBinding()]
param(
    [string]$NodeExe = "",
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$ProductDirectoryName = "DouyinAutomation"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Assert-PathInside {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Label
    )

    $normalizedPath = Get-NormalizedPath $Path
    $normalizedParent = Get-NormalizedPath $Parent
    $prefix = $normalizedParent + [System.IO.Path]::DirectorySeparatorChar
    if (-not $normalizedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must stay inside $normalizedParent; actual path: $normalizedPath"
    }
}

function Invoke-DotnetPublish {
    param(
        [Parameter(Mandatory)][string]$Dotnet,
        [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][string]$Output
    )

    & $Dotnet publish $Project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -p:DebugSymbols=false --nologo -o $Output
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet publish failed with exit code $LASTEXITCODE`: $Project"
    }
}

$scriptDirectory = Split-Path -Parent $PSCommandPath
$projectRoot = Get-NormalizedPath (Join-Path $scriptDirectory "..")
$distRoot = Get-NormalizedPath (Join-Path $projectRoot "dist")
$productRoot = Get-NormalizedPath (Join-Path $distRoot $ProductDirectoryName)
$stagingRoot = Get-NormalizedPath (Join-Path $distRoot (".DouyinAutomation.publish-" + [Guid]::NewGuid().ToString("N")))
$backupRoot = Get-NormalizedPath (Join-Path $distRoot (".DouyinAutomation.previous-" + [Guid]::NewGuid().ToString("N")))

Assert-PathInside -Path $distRoot -Parent $projectRoot -Label "dist directory"
Assert-PathInside -Path $productRoot -Parent $distRoot -Label "product directory"
Assert-PathInside -Path $stagingRoot -Parent $distRoot -Label "staging directory"
Assert-PathInside -Path $backupRoot -Parent $distRoot -Label "backup directory"

$launcherProject = Join-Path $projectRoot "desktop\DouyinAutomation.Launcher\DouyinAutomation.Launcher.csproj"
$desktopProject = Join-Path $projectRoot "desktop\DouyinAutomation.Desktop\DouyinAutomation.Desktop.csproj"
$cliFile = Join-Path $projectRoot "src\cli.js"
$packageFile = Join-Path $projectRoot "package.json"
foreach ($required in @($launcherProject, $desktopProject, $cliFile, $packageFile)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required project file is missing: $required"
    }
}

$dotnetCommand = Get-Command dotnet.exe -ErrorAction Stop
$dotnetVersion = & $dotnetCommand.Source --version
if ($LASTEXITCODE -ne 0 -or -not ($dotnetVersion -match '^(\d+)\.') -or [int]$Matches[1] -lt 10) {
    throw "Publishing requires .NET SDK 10+. Detected: $dotnetVersion"
}

if ([string]::IsNullOrWhiteSpace($NodeExe)) {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $NodeExe = $nodeCommand.Source
}
$NodeExe = Get-NormalizedPath $NodeExe
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw "Node executable does not exist: $NodeExe"
}
$nodeVersion = (& $NodeExe --version).Trim()
if ($LASTEXITCODE -ne 0 -or -not ($nodeVersion -match '^v(\d+)\.') -or [int]$Matches[1] -lt 22) {
    throw "Publishing requires Node.js 22+. Detected: $nodeVersion"
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

$published = $false
try {
    $appDirectory = Join-Path $stagingRoot "app"
    $runtimeDirectory = Join-Path $stagingRoot "runtime"
    $licenseDirectory = Join-Path $stagingRoot "LICENSES"
    New-Item -ItemType Directory -Path $appDirectory, $runtimeDirectory, $licenseDirectory -Force | Out-Null

    Write-Host "[1/5] Publishing self-contained single-file Launcher..."
    Invoke-DotnetPublish -Dotnet $dotnetCommand.Source -Project $launcherProject -Output $stagingRoot

    Write-Host "[2/5] Publishing self-contained single-file Desktop..."
    Invoke-DotnetPublish -Dotnet $dotnetCommand.Source -Project $desktopProject -Output $appDirectory

    $launcherExecutables = @(Get-ChildItem -LiteralPath $stagingRoot -Filter "*.exe" -File)
    $launcherExe = if ($launcherExecutables.Count -eq 1) { $launcherExecutables[0].FullName } else { "" }
    $desktopExe = Join-Path $appDirectory "DouyinAutomation.Desktop.exe"
    if ($launcherExecutables.Count -ne 1 -or -not (Test-Path -LiteralPath $launcherExe -PathType Leaf)) {
        throw "Expected exactly one Launcher executable in staging root. Found: $($launcherExecutables.Count)"
    }
    if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
        throw "Desktop executable was not published: $desktopExe"
    }

    Write-Host "[3/5] Copying bundled Node, source files, and documentation..."
    Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $runtimeDirectory "node.exe")
    Copy-Item -LiteralPath (Join-Path $projectRoot "src") -Destination (Join-Path $stagingRoot "src") -Recurse
    Copy-Item -LiteralPath $packageFile -Destination (Join-Path $stagingRoot "package.json")
    if (Test-Path -LiteralPath (Join-Path $projectRoot "package-lock.json")) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "package-lock.json") -Destination (Join-Path $stagingRoot "package-lock.json")
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination (Join-Path $stagingRoot "README.md")
    $projectLicenseDirectory = Join-Path $projectRoot "LICENSES"
    if (Test-Path -LiteralPath $projectLicenseDirectory -PathType Container) {
        Get-ChildItem -LiteralPath $projectLicenseDirectory -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $licenseDirectory -Recurse -Force
        }
    }

    Write-Host "[4/5] Collecting bundled runtime licenses..."
    $dotnetHome = Split-Path -Parent $dotnetCommand.Source
    foreach ($licenseName in @("LICENSE.txt", "ThirdPartyNotices.txt")) {
        $licenseSource = Join-Path $dotnetHome $licenseName
        if (-not (Test-Path -LiteralPath $licenseSource -PathType Leaf)) {
            throw ".NET runtime license file is missing: $licenseSource"
        }
        Copy-Item -LiteralPath $licenseSource -Destination (Join-Path $licenseDirectory ("dotnet-" + $licenseName))
    }

    $nodeLicense = Join-Path $licenseDirectory "Node.js-LICENSE.txt"
    if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) {
        $nodeLicenseCandidates = @(
            (Join-Path (Split-Path -Parent $NodeExe) "LICENSE"),
            (Join-Path (Split-Path -Parent $NodeExe) "LICENSE.txt")
        )
        $localNodeLicense = $nodeLicenseCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if ($localNodeLicense) {
            Copy-Item -LiteralPath $localNodeLicense -Destination $nodeLicense
        }
        else {
            $licenseUri = "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE"
            Write-Host "The local Node installation has no LICENSE; downloading the exact $nodeVersion license from the official Node.js repository..."
            Invoke-WebRequest -Uri $licenseUri -OutFile $nodeLicense -UseBasicParsing
        }
    }

    Write-Host "[5/5] Validating and switching the product directory..."
    $forbiddenRuntime = Join-Path $stagingRoot ".runtime"
    if (Test-Path -LiteralPath $forbiddenRuntime) {
        throw "Staging unexpectedly contains .runtime. Publishing stopped to protect local profile/session data."
    }
    $forbiddenSession = Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force -File | Where-Object { $_.Name -ieq "session.json" }
    if ($forbiddenSession) {
        throw "Staging unexpectedly contains session.json. Publishing stopped."
    }

    if (Test-Path -LiteralPath $productRoot) {
        Move-Item -LiteralPath $productRoot -Destination $backupRoot
    }
    try {
        Move-Item -LiteralPath $stagingRoot -Destination $productRoot

        # Existing product data belongs to the user.  Keep it across upgrades by
        # moving the previous runtime directory into the freshly published tree.
        # Both paths are below dist and on the same volume, so this is a rename
        # rather than a second, partially copied Chrome profile.
        $previousRuntime = Join-Path $backupRoot ".runtime"
        $currentRuntime = Join-Path $productRoot ".runtime"
        if (Test-Path -LiteralPath $previousRuntime -PathType Container) {
            if (Test-Path -LiteralPath $currentRuntime) {
                throw "The new product unexpectedly contains .runtime; refusing to overwrite existing user data."
            }
            Move-Item -LiteralPath $previousRuntime -Destination $currentRuntime
            if (-not (Test-Path -LiteralPath $currentRuntime -PathType Container)) {
                throw "Failed to preserve the existing product .runtime directory."
            }
        }

        $published = $true
    }
    catch {
        # If runtime migration completed before another switch step failed, put
        # it back in the backup before restoring the old product.  This keeps
        # profile/session data recoverable even on a failed upgrade.
        $previousRuntime = Join-Path $backupRoot ".runtime"
        $currentRuntime = Join-Path $productRoot ".runtime"
        if ((Test-Path -LiteralPath $currentRuntime -PathType Container) -and
            -not (Test-Path -LiteralPath $previousRuntime)) {
            Move-Item -LiteralPath $currentRuntime -Destination $previousRuntime
        }
        if (Test-Path -LiteralPath $productRoot -PathType Container) {
            Move-Item -LiteralPath $productRoot -Destination $stagingRoot
        }
        if (Test-Path -LiteralPath $backupRoot -PathType Container) {
            Move-Item -LiteralPath $backupRoot -Destination $productRoot
        }
        throw
    }

    if (Test-Path -LiteralPath $backupRoot -PathType Container) {
        Remove-Item -LiteralPath $backupRoot -Recurse -Force
    }

    Write-Host ""
    Write-Host "Product published: $productRoot" -ForegroundColor Green
    Write-Host "Entry point: $(Join-Path $productRoot (Split-Path -Leaf $launcherExe))"
    Write-Host "Node: $nodeVersion (copied to runtime\node.exe)"
    Write-Host "User data lives under product\.runtime; existing product data was preserved during an upgrade."
}
finally {
    if (-not $published -and (Test-Path -LiteralPath $stagingRoot -PathType Container)) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}

<#
.SYNOPSIS
  One-command release driver for dsh-balance (the flow documented in AGENTS.md).

.DESCRIPTION
  Flow: typecheck -> build -> version bump (package.json) -> commit -> tag vX.Y.Z
        -> push main + tag (triggers GitHub Actions release.yml) -> wait for CI
        -> verify npm dist-tags.latest / SLSA provenance / GitHub Release.

  Usage:
    .\scripts\release.ps1                       # patch bump (0.1.6 -> 0.1.7)
    .\scripts\release.ps1 -Version 0.2.0        # explicit target version
    .\scripts\release.ps1 -CommitAll            # commit ALL uncommitted working-tree changes
    .\scripts\release.ps1 -NoPush               # local only: verify + bump + commit + tag
    .\scripts\release.ps1 -NoVerify             # skip CI wait and npm/Release verification
    .\scripts\release.ps1 -DryRun               # print the plan only, no side effects

  Notes:
  - The working tree must be clean unless -CommitAll is given.
  - Release records (AGENTS.md / DEVELOPMENT.md 10.2) are NOT updated by this
    script - do that manually after the release.
  - Auth: git push uses your local ssh/https credentials; npm publishing is done
    by CI via Trusted Publishing (OIDC), no local login needed.
.PARAMETER Version
  Target version (e.g. 0.2.0). Default: auto-increment from package.json.
.PARAMETER Bump
  Increment kind: patch (default) / minor / major.
.PARAMETER CommitMessage
  Commit message. Default: the version number itself (e.g. "0.1.7").
.PARAMETER CommitAll
  Stage and commit ALL working-tree changes (code + docs + screenshots).
.PARAMETER NoPush
  Stop after local steps (typecheck/build/bump/commit/tag), do not push.
.PARAMETER NoVerify
  After push, skip CI polling and npm/Release verification.
.PARAMETER DryRun
  Print the plan only; make no changes.
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',
  [string]$CommitMessage = '',
  [switch]$CommitAll,
  [switch]$NoPush,
  [switch]$NoVerify,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PkgPath = Join-Path $RepoRoot 'package.json'
$Owner = 'LemCAE'
$Repo = 'dsh-balance'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

# --- Preflight: repo and remote -----------------------------------------
if (-not (Test-Path $PkgPath)) { throw "package.json not found: $PkgPath" }
if (-not $DryRun) {
  $remote = (& git remote get-url origin 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $remote) { throw 'git remote origin is missing' }
  if ($remote -match 'github\.com[:/]([^/]+)/([^/]+?)(\.git)?$') {
    $Owner = $Matches[1]; $Repo = $Matches[2]
  }
}

# --- Version computation ------------------------------------------------
$current = [regex]::Match((Get-Content -Raw $PkgPath), '"version"\s*:\s*"([^"]+)"').Groups[1].Value
if (-not $current) { throw 'cannot parse current version from package.json' }

if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "invalid target version: $Version (expected X.Y.Z)" }
  $target = $Version
  if ($target -le $current) { Write-Warn "target $target is not newer than current $current - npm will reject an existing version" }
} else {
  $parts = $current -split '\.'
  switch ($Bump) {
    'major' { $target = '{0}.0.0' -f ([int]$parts[0] + 1) }
    'minor' { $target = '{0}.{1}.0' -f $parts[0], ([int]$parts[1] + 1) }
    default { $target = '{0}.{1}.{2}' -f $parts[0], $parts[1], ([int]$parts[2] + 1) }
  }
}
$tag = "v$target"

# --- Working tree state -------------------------------------------------
$porcelain = (& git status --porcelain) -join "`n"
$dirty = $porcelain -ne ''
if ($dirty -and -not $CommitAll -and -not $DryRun) {
  throw "working tree is dirty - commit first or pass -CommitAll to include all changes:`n$porcelain"
}
if ((-not $DryRun) -and (@(& git tag --list $tag).Count -gt 0)) { throw "tag $tag already exists locally" }

# --- DryRun: print the plan only ----------------------------------------
if ($DryRun) {
  $plan = @()
  $plan += 'DryRun plan (no changes will be made):'
  $plan += "  repo        : $Owner/$Repo"
  $plan += "  current     : $current"
  $plan += "  target      : $target  (tag $tag)"
  $plan += "  branch      : $(& git rev-parse --abbrev-ref HEAD)"
  if ($dirty) {
    $count = ($porcelain -split "`n" | Where-Object { $_ }).Count
    $plan += "  working tree: DIRTY ($count items) - abort unless -CommitAll"
  } else {
    $plan += '  working tree: clean'
  }
  $plan += '  steps       : pnpm.cmd typecheck && pnpm.cmd build'
  $plan += "                write version $target to package.json"
  if ($CommitAll) { $plan += '                git add -A (all changes)' } else { $plan += '                git add package.json' }
  $plan += "                git commit -m <message>"
  $plan += "                git tag $tag"
  if ($NoPush) { $plan += '                [NoPush] stop, do not push' }
  else {
    $plan += "                git push origin main $tag  (triggers release.yml)"
    if (-not $NoVerify) { $plan += '                poll CI -> verify npm latest/provenance + GitHub Release' }
  }
  $plan | ForEach-Object { Write-Host $_ }
  exit 0
}

# --- Verify and build ---------------------------------------------------
Write-Step 'typecheck + build'
$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) { $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source }
if (-not $pnpm) { throw 'pnpm not found (pnpm.cmd)' }
& $pnpm typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
Write-Ok 'typecheck passed'
& $pnpm build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
Write-Ok 'build passed'

# --- Version write ------------------------------------------------------
Write-Step "bump version $current -> $target"
$raw = Get-Content -Raw $PkgPath
# Use ${1}/${2} so the version digits are never parsed as part of a
# backreference (e.g. '$1' + '0.1.7' would read as group 10).
$newRaw = $raw -replace '("version"\s*:\s*")[^"]+(")', ('${1}' + $target + '${2}')
if ($newRaw -eq $raw) { throw 'package.json version replacement failed' }
[System.IO.File]::WriteAllText($PkgPath, $newRaw, (New-Object System.Text.UTF8Encoding($false)))
$check = Get-Content -Raw $PkgPath | ConvertFrom-Json
if ($check.version -ne $target) { throw "package.json version verify failed: got '$($check.version)', expected '$target'" }
Write-Ok "package.json -> $target"

# --- Commit and tag -----------------------------------------------------
if ($CommitAll) { & git add -A } else { & git add package.json }
if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
$msg = if ([string]::IsNullOrEmpty($CommitMessage)) { $target } else { $CommitMessage }
& git commit -m $msg
if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
Write-Ok "committed: $msg"
& git tag $tag
Write-Ok "tagged: $tag"

if ($NoPush) {
  Write-Step '[NoPush] local steps done. To finish manually:'
  "    git push origin main $tag"
  exit 0
}

# --- Push -----------------------------------------------------------------
Write-Step "pushing main + $tag"
& git push origin main $tag
if ($LASTEXITCODE -ne 0) { throw 'git push failed (check credentials/network)' }
Write-Ok 'pushed - GitHub Actions triggered'

if ($NoVerify) {
  Write-Step '[NoVerify] skipping verification. See:'
  "    https://github.com/$Owner/$Repo/actions"
  exit 0
}

# --- Wait for CI and verify ---------------------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$deadline = (Get-Date).AddMinutes(10)
$run = $null
Write-Step 'waiting for CI (max 10 minutes)'
do {
  Start-Sleep -Seconds 15
  try {
    $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/actions/runs?per_page=10" -Headers @{ 'User-Agent' = 'dsh-balance-release' } -TimeoutSec 30
    $run = $r.workflow_runs | Where-Object { $_.head_branch -eq $tag } | Select-Object -First 1
  } catch { Write-Warn "run query failed: $($_.Exception.Message)" }
  if ($run) { Write-Ok "run $($run.id) status=$($run.status) conclusion=$($run.conclusion)" }
} while ((-not $run -or $run.status -ne 'completed') -and (Get-Date) -lt $deadline)

if (-not $run -or $run.status -ne 'completed') {
  Write-Warn 'CI did not finish in time - check manually:'
  "    https://github.com/$Owner/$Repo/actions"
  exit 2
}
if ($run.conclusion -ne 'success') {
  Write-Warn "CI conclusion is $($run.conclusion), see logs:"
  "    $($run.html_url)"
  exit 2
}
Write-Ok 'CI succeeded'

# npm verification
try {
  $pkg = Invoke-RestMethod -Uri "https://registry.npmjs.org/$Owner/$Repo" -TimeoutSec 30
  $latest = $pkg.'dist-tags'.latest
  $prov = $null -ne $pkg.versions."$target".dist.attestations
  Write-Step 'npm verification'
  Write-Ok "dist-tags.latest = $latest (expected $target)"
  Write-Ok "SLSA provenance = $prov"
  if ($latest -ne $target) { Write-Warn "latest does not match target: $latest" }
} catch { Write-Warn "npm verification failed: $($_.Exception.Message)" }

# GitHub Release verification
try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/tags/$tag" -Headers @{ 'User-Agent' = 'dsh-balance-release' } -TimeoutSec 30
  Write-Step 'GitHub Release verification'
  Write-Ok "$($rel.name)  published=$($rel.published_at)"
} catch { Write-Warn "Release verification failed: $($_.Exception.Message)" }

Write-Step 'Done. Remember to update release records manually:'
"    AGENTS.md (status/todo) and DEVELOPMENT.md (10.2 version table)"
"    Host upgrade: dsh plugin --profile web update @lemcae/dsh-balance (restart dsh web if host code changed)"

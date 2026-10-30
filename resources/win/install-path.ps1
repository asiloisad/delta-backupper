#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $InstallDirectory,
    [ValidateSet('Install', 'Uninstall')] [string] $Mode = 'Install',
    [switch] $DryRun
)
$ErrorActionPreference = 'Stop'
$resolvedInstall = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
if ($resolvedInstall -eq [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($InstallDirectory)).TrimEnd('\')) { throw 'A drive or share root cannot be an application installation directory.' }
if ($resolvedInstall -match '[\r\n\0%;]') { throw 'Installation path cannot be represented safely in the user PATH.' }
$target = Join-Path $resolvedInstall 'bin'
$environmentKey = $(if ($DryRun) { [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment') } else { [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') })
$record = $(if ($DryRun) { [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Delta Backupper') } else { [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Delta Backupper') })
try {
    $current = $(if ($null -ne $environmentKey) { [string]$environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { '' })
    $parts = @($current.Split(';'))
    $previouslyExisted = $null -ne $environmentKey -and $environmentKey.GetValueNames() -contains 'Path'
    $currentKind = $(if ($previouslyExisted) { $environmentKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString })
    $contains = @($parts | Where-Object { [StringComparer]::OrdinalIgnoreCase.Equals($_.TrimEnd('\'), $target) }).Count -gt 0
    $recordedDirectory = $(if ($null -ne $record) { [string]$record.GetValue('InstallDirectory', '') } else { '' })
    $recordedAdded = $null -ne $record -and $record.GetValue('AddedToPath', 0) -eq 1
    $sameInstallation = [StringComparer]::OrdinalIgnoreCase.Equals($recordedDirectory, $resolvedInstall)
    $next = $current
    $added = $false
    $restoreAbsent = $false
    $nextKind = $currentKind
    if ($Mode -eq 'Install') {
        if (!$contains) { $next = $(if (!$current) { $target } else { "$current;$target" }); $added = $true }
        elseif ($sameInstallation -and $recordedAdded) { $added = $true }
    } elseif ($sameInstallation -and $recordedAdded) {
        $written = [string]$record.GetValue('PathWrittenByInstall', '')
        if ($current -ceq $written) {
            $next = [string]$record.GetValue('PathBeforeInstall', '')
            $restoreAbsent = $record.GetValue('PathPreviouslyExisted', 1) -eq 0
            $nextKind = [Microsoft.Win32.RegistryValueKind][int]$record.GetValue('PathPreviousKind', [int][Microsoft.Win32.RegistryValueKind]::ExpandString)
        } else {
            # Preserve concurrent user edits; remove only our exact path entry.
            $next = @($parts | Where-Object { ![StringComparer]::OrdinalIgnoreCase.Equals($_.TrimEnd('\'), $target) }) -join ';'
        }
    }
    if (!$DryRun) {
        if ($Mode -eq 'Install') {
            if ($added -and !$contains) {
                $record.SetValue('PathBeforeInstall', $current, [Microsoft.Win32.RegistryValueKind]::String)
                $record.SetValue('PathPreviouslyExisted', [int]$previouslyExisted, [Microsoft.Win32.RegistryValueKind]::DWord)
                $record.SetValue('PathPreviousKind', [int]$currentKind, [Microsoft.Win32.RegistryValueKind]::DWord)
                $record.SetValue('PathWrittenByInstall', $next, [Microsoft.Win32.RegistryValueKind]::String)
            }
            $record.SetValue('InstallDirectory', $resolvedInstall)
            $record.SetValue('AddedToPath', [int]$added, [Microsoft.Win32.RegistryValueKind]::DWord)
        }
        if ($restoreAbsent) { $environmentKey.DeleteValue('Path', $false) }
        elseif ($next -cne $current -or $nextKind -ne $currentKind) { $environmentKey.SetValue('Path', $next, $nextKind) }
        if ($Mode -eq 'Uninstall' -and $sameInstallation) {
            foreach ($name in @('InstallDirectory', 'AddedToPath', 'PathBeforeInstall', 'PathPreviouslyExisted', 'PathPreviousKind', 'PathWrittenByInstall')) { $record.DeleteValue($name, $false) }
            if ($record.GetValueNames().Count -eq 0 -and $record.GetSubKeyNames().Count -eq 0) {
                $record.Dispose(); $record = $null
                [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('Software\Delta Backupper', $false)
            }
        }
    }
    [pscustomobject]@{ mode = $Mode; dryRun = [bool]$DryRun; changed = $next -cne $current } | ConvertTo-Json -Compress
} finally { if ($null -ne $record) { $record.Dispose() }; if ($null -ne $environmentKey) { $environmentKey.Dispose() } }

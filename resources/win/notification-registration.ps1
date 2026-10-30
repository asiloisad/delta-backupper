#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Check', 'Prepare', 'Repair', 'Remove')] [string] $Mode = 'Check',
    [string] $InstallDirectory
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$identity = $null
if ($InstallDirectory) {
    if ($Mode -ne 'Remove') { throw 'An installation directory is valid only for notification cleanup.' }
    $executable = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'Delta Backupper.exe'))
    $identity = [pscustomobject]@{ appId = 'app.deltabackupper'; name = 'Delta Backupper'; clsid = '{889B388B-3FE2-488E-9FE4-124BF5AE4CB1}'; executable = $executable; iconPath = (Join-Path $InstallDirectory 'resources/branding/app.ico'); command = ('"' + $executable + '"'); shortcut = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Delta Backupper.lnk') }
} else {
    $json = [Console]::In.ReadToEnd()
    if ($json.Length -gt 65536) { throw 'Notification identity input is too large.' }
    $identity = $json | ConvertFrom-Json
}
if (!$identity -or $identity.appId -cnotmatch '^app\.deltabackupper(?:\.development|\.probe\.[0-9a-f-]{36})?$' -or $identity.clsid -cnotmatch '^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$') { throw 'Invalid notification identity.' }
if ($identity.name -notmatch '^Delta Backupper(?: Development| Probe [0-9a-f-]{36})?$') { throw 'Invalid notification application name.' }
# Installer-owned cleanup may omit presentation data; its icon has one current default location.
if (!$identity.PSObject.Properties['iconPath']) { $identity | Add-Member -NotePropertyName iconPath -NotePropertyValue (Join-Path ([IO.Path]::GetDirectoryName($identity.executable)) 'resources/branding/app.ico') }
foreach ($name in @('appId', 'name', 'clsid', 'executable', 'iconPath', 'command', 'shortcut')) { if (!($identity.$name -is [string]) -or $identity.$name.Length -gt 32768 -or $identity.$name -match '[\r\n\0]') { throw 'Invalid notification identity field.' } }
$expectedShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) ($identity.name + '.lnk')
if (![StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($identity.shortcut), $expectedShortcut)) { throw 'Notification shortcut is outside its exact Start Menu location.' }
$expectedExecutable = [IO.Path]::GetFullPath($identity.executable)
if (![StringComparer]::OrdinalIgnoreCase.Equals($expectedExecutable, $identity.executable) -or $expectedExecutable.IndexOf('"') -ge 0) { throw 'Invalid notification executable path.' }
$expectedIcon = [IO.Path]::GetFullPath($identity.iconPath)
if (![StringComparer]::OrdinalIgnoreCase.Equals($expectedIcon, $identity.iconPath) -or $expectedIcon.IndexOf('"') -ge 0 -or [IO.Path]::GetExtension($expectedIcon) -ine '.ico') { throw 'Invalid notification icon path.' }
$clsidPath = 'Software\Classes\CLSID\' + $identity.clsid
$appIdPath = 'Software\Classes\AppUserModelId\' + $identity.appId
$root = [Microsoft.Win32.Registry]::CurrentUser
function IsOwned([Microsoft.Win32.RegistryKey] $key) {
    return $null -ne $key -and [StringComparer]::OrdinalIgnoreCase.Equals([string]$key.GetValue('DeltaOwnerExecutable', ''), $expectedExecutable) -and [StringComparer]::Ordinal.Equals([string]$key.GetValue('DeltaAppId', ''), [string]$identity.appId)
}
function CheckRegistry {
    foreach ($keyPath in @($clsidPath, $appIdPath)) {
        $key = $root.OpenSubKey($keyPath)
        try { if ($key -and !(IsOwned $key)) { throw 'A foreign registry key already uses the notification identity.' } } finally { if ($key) { $key.Dispose() } }
    }
    $server = $root.OpenSubKey($clsidPath + '\LocalServer32')
    try {
        if ($server) {
            $command = [string]$server.GetValue('', '')
            $sameQuotedExecutable = $command.StartsWith(('"' + $expectedExecutable + '" '), [StringComparison]::OrdinalIgnoreCase)
            if ($command -cne $identity.command -and ![StringComparer]::OrdinalIgnoreCase.Equals($command, $expectedExecutable) -and !$sameQuotedExecutable) { throw 'A foreign command already uses the notification COM server.' }
        }
    } finally { if ($server) { $server.Dispose() } }
}
function WriteRegistry {
    $key = $root.CreateSubKey($clsidPath)
    try {
        $key.SetValue('', $identity.name + ' Notification Activator')
        $key.SetValue('DeltaOwnerExecutable', $expectedExecutable)
        $key.SetValue('DeltaAppId', $identity.appId)
        $key.SetValue('CustomActivator', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
    } finally { $key.Dispose() }
    $server = $root.CreateSubKey($clsidPath + '\LocalServer32')
    try { $server.SetValue('', $identity.command) } finally { $server.Dispose() }
    $key = $root.CreateSubKey($appIdPath)
    try {
        $key.SetValue('DeltaOwnerExecutable', $expectedExecutable)
        $key.SetValue('DeltaAppId', $identity.appId)
        $key.SetValue('DisplayName', $identity.name)
        $key.SetValue('IconUri', $expectedIcon)
        $key.SetValue('CustomActivator', $identity.clsid)
    } finally { $key.Dispose() }
}
if ($Mode -eq 'Remove') {
    $removed = @(); $preserved = @()
    # Cleanup is deliberately exact: unrelated subkeys/values remain, even under our own identity.
    foreach ($keyPath in @($clsidPath, $appIdPath)) {
        $key = $root.OpenSubKey($keyPath, $true)
        if (!$key) { continue }
        $owned = IsOwned $key
        if ($owned -and $keyPath -eq $clsidPath) {
            $server = $key.OpenSubKey('LocalServer32', $true)
            if ($server) {
                $command = [string]$server.GetValue('', '')
                $owned = $command -ceq $identity.command -or [StringComparer]::OrdinalIgnoreCase.Equals($command, $expectedExecutable)
                if ($owned) {
                    if ($server.GetValueNames() -contains '') { $server.DeleteValue('', $false) }
                    $emptyServer = $server.GetValueNames().Count -eq 0 -and $server.GetSubKeyNames().Count -eq 0
                    $server.Dispose(); $server = $null
                    if ($emptyServer) { $key.DeleteSubKey('LocalServer32', $false) }
                }
                if ($server) { $server.Dispose() }
            }
        }
        if ($owned) {
            $names = $(if ($keyPath -eq $clsidPath) { @('', 'DeltaOwnerExecutable', 'DeltaAppId', 'CustomActivator') } else { @('DeltaOwnerExecutable', 'DeltaAppId', 'DisplayName', 'IconUri', 'CustomActivator') })
            foreach ($name in $names) { $key.DeleteValue($name, $false) }
            $emptyKey = $key.GetValueNames().Count -eq 0 -and $key.GetSubKeyNames().Count -eq 0
            $key.Dispose(); $key = $null
            if ($emptyKey) { $root.DeleteSubKey($keyPath, $false) }
            $removed += $keyPath
        } else { $preserved += $keyPath }
        if ($key) { $key.Dispose() }
    }
    if ([IO.File]::Exists($expectedShortcut)) {
        if (([IO.File]::GetAttributes($expectedShortcut) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $preserved += 'shortcut' }
        else {
            $wscript = New-Object -ComObject WScript.Shell
            $shortcut = $wscript.CreateShortcut($expectedShortcut)
            $shell = New-Object -ComObject Shell.Application
            $item = $shell.NameSpace([IO.Path]::GetDirectoryName($expectedShortcut)).ParseName([IO.Path]::GetFileName($expectedShortcut))
            $shortcutId = [string]$item.ExtendedProperty('System.AppUserModel.ID')
            $shortcutClsid = [string]$item.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID')
            if ([StringComparer]::OrdinalIgnoreCase.Equals($shortcut.TargetPath, $expectedExecutable) -and $shortcutId -ceq $identity.appId -and [StringComparer]::OrdinalIgnoreCase.Equals($shortcutClsid.Trim('{}'), $identity.clsid.Trim('{}'))) { [IO.File]::Delete($expectedShortcut); $removed += 'shortcut' }
            else { $preserved += 'shortcut' }
        }
    }
    [pscustomobject]@{ mode = $Mode; removed = $removed; preserved = $preserved } | ConvertTo-Json -Compress
    exit 0
}
CheckRegistry
if ($Mode -eq 'Prepare') { WriteRegistry }
$nativeObserved = $false
if ($Mode -eq 'Repair') {
    # The native presenter may preserve an already-complete custom registration.
    # Its support query is not an acknowledgement of any particular registry write.
    # Verify our owned command instead of requiring Electron to overwrite it first.
    Start-Sleep -Milliseconds 100
    CheckRegistry
    $server = $root.OpenSubKey($clsidPath + '\LocalServer32')
    try { $command = $(if ($server) { [string]$server.GetValue('', '') } else { '' }) } finally { if ($server) { $server.Dispose() } }
    $nativeObserved = [StringComparer]::OrdinalIgnoreCase.Equals($command, $expectedExecutable)
    WriteRegistry
    $server = $root.OpenSubKey($clsidPath + '\LocalServer32')
    try { if (!$server -or [string]$server.GetValue('', '') -cne $identity.command) { throw 'The notification launch command could not be verified.' } } finally { if ($server) { $server.Dispose() } }
}
[pscustomobject]@{ mode = $Mode; nativeRegistrationObserved = $nativeObserved; registrationVerified = ($Mode -eq 'Repair' -or $Mode -eq 'Prepare') } | ConvertTo-Json -Compress

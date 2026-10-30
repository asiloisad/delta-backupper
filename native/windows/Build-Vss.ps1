#requires -Version 5.1
[CmdletBinding()]
param([string] $OutputDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$nativeRoot = [IO.Path]::GetDirectoryName($PSCommandPath)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $nativeRoot '../..'))
if (!$OutputDirectory) { $OutputDirectory = Join-Path $projectRoot '.dev/native/windows' }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($outputRoot)
$utf8 = [Text.UTF8Encoding]::new($false)
$source = Join-Path $nativeRoot 'delta-vss.cpp'
$sharedSource = Join-Path $nativeRoot 'vss-support.cpp'
$resourceTemplate = Join-Path $nativeRoot 'branding.rc'
$icon = Join-Path $projectRoot 'resources/branding/app.ico'
$package = Join-Path $projectRoot 'package.json'
$binary = Join-Path $outputRoot 'delta-vss.exe'
$inputs = @($source, $sharedSource, $PSCommandPath, $resourceTemplate, $icon, $package) | ForEach-Object { [pscustomobject]@{ path = $_; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() } }
$applicationVersion = [string]([IO.File]::ReadAllText($package, $utf8) | ConvertFrom-Json).version
if ($applicationVersion -cnotmatch '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw 'Invalid application version for native VSS resources.' }
$parts = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], 0)
if (@($parts | Where-Object { $_ -lt 0 -or $_ -gt 65535 }).Count) { throw 'Application version exceeds native Windows version limits.' }
$resourceSource = Join-Path $outputRoot 'branding.rc'
$resourceBinary = Join-Path $outputRoot 'branding.res'
$resourceText = [IO.File]::ReadAllText($resourceTemplate, $utf8).Replace('@@DELTA_ICON@@', $icon.Replace('\', '\\')).Replace('@@DELTA_NUMERIC_VERSION@@', ($parts -join ',')).Replace('@@DELTA_VERSION@@', $applicationVersion)
if ($resourceText.Contains('@@DELTA_')) { throw 'Unresolved native VSS branding resource token.' }
[IO.File]::WriteAllText($resourceSource, $resourceText, $utf8)
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or !$installation) { throw 'MSVC x64 C++ build tools were not found.' }
$toolset = Get-ChildItem -LiteralPath (Join-Path $installation 'VC/Tools/MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdk = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um/vsbackup.h') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$toolset -or !$sdk) { throw 'MSVC and Windows SDK with VSS headers are required.' }
$compiler = Join-Path $toolset.FullName 'bin/Hostx64/x64/cl.exe'
$resourceCompiler = Join-Path $sdkRoot "bin/$($sdk.Name)/x64/rc.exe"
if (!(Test-Path -LiteralPath $resourceCompiler -PathType Leaf)) { throw 'The selected Windows SDK resource compiler was not found.' }
$resourceOutput = & $resourceCompiler '/nologo' '/c65001' "/I$($sdk.FullName)/um" "/I$($sdk.FullName)/shared" "/fo$resourceBinary" $resourceSource 2>&1
$resourceExit = $LASTEXITCODE
[IO.File]::WriteAllText((Join-Path $outputRoot 'resource-build.log'), ($resourceOutput -join "`n") + "`n", $utf8)
if ($resourceExit -ne 0) { throw "Native VSS resource build failed; see $outputRoot/resource-build.log" }
$arguments = @('/nologo', '/std:c++17', '/EHsc', '/O2', '/W4', '/WX', '/MT', '/utf-8', '/D_WIN32_WINNT=0x0A00', '/DUNICODE', '/D_UNICODE', "/I$($toolset.FullName)/include")
foreach ($include in @('um', 'shared', 'ucrt', 'winrt')) { $arguments += "/I$($sdk.FullName)/$include" }
$arguments += @("/Fo$(Join-Path $outputRoot 'delta-vss.obj')", "/Fe$binary", $source, $resourceBinary, '/link', '/SUBSYSTEM:CONSOLE', '/MANIFEST:EMBED', "/MANIFESTUAC:level='asInvoker' uiAccess='false'", '/OPT:REF', '/OPT:ICF', "/LIBPATH:$($toolset.FullName)/lib/x64", "/LIBPATH:$sdkRoot/Lib/$($sdk.Name)/um/x64", "/LIBPATH:$sdkRoot/Lib/$($sdk.Name)/ucrt/x64", 'VssApi.lib', 'Ole32.lib', 'OleAut32.lib', 'Advapi32.lib', 'Uuid.lib', 'User32.lib', 'Shell32.lib')
$originalNativeBuildPath = $env:PATH
try {
    # LINK invokes rc.exe again to embed its generated asInvoker manifest.
    $env:PATH = ([IO.Path]::GetDirectoryName($resourceCompiler)) + ';' + ([IO.Path]::GetDirectoryName($compiler)) + ';' + $originalNativeBuildPath
    $output = & $compiler @arguments 2>&1
    $compilerExit = $LASTEXITCODE
} finally { $env:PATH = $originalNativeBuildPath }
[IO.File]::WriteAllText((Join-Path $outputRoot 'build.log'), ($output -join "`n") + "`n", $utf8)
if ($compilerExit -ne 0) { throw "Native VSS build failed; see $outputRoot/build.log" }
foreach ($sourceRecord in $inputs) { if ((Get-FileHash -LiteralPath $sourceRecord.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceRecord.sha256) { throw 'Native VSS sources changed during compilation; rebuild.' } }
$selfTest = & $binary --self-test
if ($LASTEXITCODE -ne 0) { throw 'Native VSS helper self-test failed.' }
$testResult = $selfTest | ConvertFrom-Json
if ($testResult.status -cne 'passed' -or $testResult.selfTestsPassed -ne 7 -or $testResult.createdSnapshot -isnot [bool] -or $testResult.createdSnapshot) { throw 'Native VSS helper did not confirm its deterministic self-tests.' }
$manifest = [ordered]@{ schemaVersion = 1; timestampUtc = [DateTime]::UtcNow.ToString('o'); binaryPath = $binary; binarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant(); toolset = $toolset.Name; sdk = $sdk.Name; resourceCompiler = $resourceCompiler; applicationVersion = $applicationVersion; inputs = @($inputs); selfTest = $testResult; elevatedLeaseQualification = 'unverified' }
[IO.File]::WriteAllText((Join-Path $outputRoot 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8) + "`n", $utf8)
$manifest | ConvertTo-Json -Depth 8

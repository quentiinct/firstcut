# FirstCut - fabrique l'installateur dist\FirstCut-Setup-<version>.exe
#
# Utilise uniquement ce qui est deja dans Windows : PowerShell et le
# compilateur C# de .NET Framework 4 (csc.exe). Etapes :
#   1. copie du dossier extension (sans les fichiers de developpement du SDK)
#   2. archive zip, embarquee dans le .exe
#   3. icone dessinee a partir de Logo.cs
#   4. compilation
#
#   .\installer\build.ps1

$ErrorActionPreference = 'Stop'

$racine = Split-Path $PSScriptRoot -Parent
$ext    = Join-Path $racine 'extension'
$obj    = Join-Path $PSScriptRoot 'obj'
$dist   = Join-Path $racine 'dist'

$manifeste = Get-Content (Join-Path $ext 'CSXS\manifest.xml') -Raw
if ($manifeste -notmatch 'ExtensionBundleVersion="([0-9.]+)"') { throw 'Version introuvable dans le manifeste.' }
$version = $Matches[1]
Write-Host "FirstCut $version"

# Le SDK Anthropic est installe par npm dans extension\node_modules.
if (-not (Test-Path (Join-Path $ext 'node_modules\@anthropic-ai\sdk\package.json'))) {
    Write-Host 'Installation des dependances (npm ci)...'
    Push-Location $ext
    try { npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci a echoue.' } }
    finally { Pop-Location }
}

if (Test-Path $obj) { Remove-Item -Recurse -Force $obj -Confirm:$false }
New-Item -ItemType Directory -Force $obj | Out-Null
New-Item -ItemType Directory -Force $dist | Out-Null

# 1. copie, sans cartes de source, declarations TypeScript ni sources du SDK
$paquet = Join-Path $obj 'payload'
robocopy $ext $paquet /MIR /NJH /NJS /NP /NFL /NDL /XF *.map *.d.ts *.d.mts *.d.cts CHANGELOG.md | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copie de l'extension impossible (robocopy $LASTEXITCODE)." }
$srcSdk = Join-Path $paquet 'node_modules\@anthropic-ai\sdk\src'
if (Test-Path $srcSdk) { Remove-Item -Recurse -Force $srcSdk -Confirm:$false }

# le SDK doit toujours se charger apres le tri
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $sdk = (Join-Path $paquet 'node_modules\@anthropic-ai\sdk').Replace('\', '/')
    & node -e "const A=require('$sdk'); const C=A.default||A; const c=new C({apiKey:'test'}); if(!c.beta||!c.beta.messages) throw new Error('SDK incomplet'); console.log('SDK ok');"
    if ($LASTEXITCODE -ne 0) { throw 'Le SDK ne se charge plus apres le tri des fichiers.' }
}

# 2. archive
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $obj 'payload.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($paquet, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$mo = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Panneau archive : $mo Mo"

# 3. icone
$logo = Join-Path $PSScriptRoot 'Logo.cs'
Add-Type -TypeDefinition (Get-Content $logo -Raw) -ReferencedAssemblies System.Drawing
$ico = Join-Path $obj 'firstcut.ico'
[FirstCutLogo]::SaveIco($ico)

# 4. compilation
$v4 = $version.Split('.')
while ($v4.Count -lt 4) { $v4 += '0' }
$infos = Join-Path $obj 'BuildInfo.cs'
@"
using System.Reflection;
[assembly: AssemblyTitle("FirstCut - installation")]
[assembly: AssemblyDescription("Installe le panneau FirstCut dans Adobe Premiere Pro")]
[assembly: AssemblyProduct("FirstCut")]
[assembly: AssemblyCompany("@quentiinct")]
[assembly: AssemblyCopyright("(c) 2026 @quentiinct")]
[assembly: AssemblyVersion("$($v4 -join '.')")]
[assembly: AssemblyFileVersion("$($v4 -join '.')")]
[assembly: AssemblyInformationalVersion("$version")]
static class BuildInfo { public const string Version = "$version"; }
"@ | Set-Content -Encoding ASCII $infos

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Compilateur C# de .NET Framework 4 introuvable.' }

$exe = Join-Path $dist "FirstCut-Setup-$version.exe"
$cscArgs = @(
    '/nologo', '/target:winexe', '/optimize+', '/codepage:65001', '/platform:anycpu',
    "/out:$exe",
    "/win32icon:$ico",
    "/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')",
    "/resource:$zip,payload.zip",
    '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    (Join-Path $PSScriptRoot 'FirstCutSetup.cs'), $logo, $infos
)
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "La compilation a echoue (csc $LASTEXITCODE)." }

$mo = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "Installateur : $exe ($mo Mo)"

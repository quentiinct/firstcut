# FirstCut - installation du panneau dans Premiere Pro.
#
# Copie le dossier "extension" vers le dossier des extensions CEP de
# l'utilisateur, sous le nom com.firstcut.ppro. Ne touche a aucune autre
# extension. A relancer apres chaque modification du dossier "extension".
#
#   .\install.ps1                    installe / met a jour
#   .\install.ps1 -ActiverModeDebug  active aussi le chargement des extensions
#                                    non signees (necessaire une seule fois)

param(
    [switch]$ActiverModeDebug
)

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'extension'
$cible  = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.firstcut.ppro'

if (-not (Test-Path (Join-Path $source 'CSXS\manifest.xml'))) {
    throw "Dossier 'extension' introuvable a cote de ce script : $source"
}

# Premiere ne charge une extension non signee que si le mode debug CEP est actif.
$versionsCsxs = 9, 10, 11, 12, 13
if ($ActiverModeDebug) {
    foreach ($v in $versionsCsxs) {
        $cle = "HKCU:\Software\Adobe\CSXS.$v"
        if (-not (Test-Path $cle)) { New-Item -Path $cle -Force | Out-Null }
        Set-ItemProperty -Path $cle -Name PlayerDebugMode -Value '1' -Type String
    }
    Write-Host "Mode debug CEP active (CSXS $($versionsCsxs -join ', '))."
}

$actif = $false
foreach ($v in $versionsCsxs) {
    $cle = "HKCU:\Software\Adobe\CSXS.$v"
    if (Test-Path $cle) {
        $val = (Get-ItemProperty $cle -ErrorAction SilentlyContinue).PlayerDebugMode
        if ("$val" -eq '1') { $actif = $true }
    }
}

# Ancien nom du panneau : on le retire pour ne pas l'avoir en double dans Premiere.
$ancien = Join-Path $env:APPDATA 'AdobeCEPextensionscom.autoderush.ppro'
if (Test-Path $ancien) {
    Remove-Item -Recurse -Force $ancien -Confirm:$false
    Write-Host "Ancienne version retiree : $ancien"
}

New-Item -ItemType Directory -Force $cible | Out-Null
robocopy $source $cible /MIR /NJH /NJS /NP /NFL /NDL | Out-Null
if ($LASTEXITCODE -ge 8) { throw "La copie a echoue (robocopy, code $LASTEXITCODE)." }

Write-Host "FirstCut installe dans : $cible"
if (-not $actif) {
    Write-Warning "Le mode debug CEP n'est pas actif : Premiere ne chargera pas le panneau."
    Write-Warning "Relance :  .\install.ps1 -ActiverModeDebug"
}
Write-Host "Redemarre Premiere Pro, puis ouvre : Fenetre > Extensions > FirstCut"
exit 0

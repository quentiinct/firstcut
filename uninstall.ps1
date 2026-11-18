# FirstCut - desinstallation.
#
# Retire uniquement le panneau FirstCut du dossier des extensions CEP.
#
#   .\uninstall.ps1                  retire le panneau
#   .\uninstall.ps1 -AvecReglages    retire aussi les reglages et les journaux

param(
    [switch]$AvecReglages
)

$ErrorActionPreference = 'Stop'

$cible = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.firstcut.ppro'
if (Test-Path $cible) {
    Remove-Item -Recurse -Force $cible -Confirm:$false
    Write-Host "Panneau retire : $cible"
} else {
    Write-Host "Le panneau n'etait pas installe."
}

if ($AvecReglages) {
    $donnees = Join-Path $env:APPDATA 'FirstCut'
    if (Test-Path $donnees) {
        Remove-Item -Recurse -Force $donnees -Confirm:$false
        Write-Host "Reglages et journaux retires : $donnees"
    }
}

$temp = Join-Path $env:TEMP 'FirstCut'
if (Test-Path $temp) { Remove-Item -Recurse -Force $temp -Confirm:$false }

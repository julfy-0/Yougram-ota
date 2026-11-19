<#
  Выпуск сборки Yougram в OTA (GitHub) одной командой.

  .\tools\release.ps1                       # берёт последний APK из проекта приложения, заметки из notes.txt
  .\tools\release.ps1 -Rollout 10           # раздать ~10% устройств
  .\tools\release.ps1 -Apk C:\path\app.apk -Notes "- Исправления" -Banner banner.png
  .\tools\release.ps1 -DryRun               # показать, что будет сделано, ничего не записывая
  .\tools\release.ps1 -NoPush               # только записать файлы, git не трогать

  Папку приложения можно задать один раз:  setx YOUGRAM_APP_DIR "C:\dev\Yougram"
#>
param(
  [string]$AppDir = $env:YOUGRAM_APP_DIR,
  [string]$Apk,
  [string]$Notes = "notes.txt",
  [string]$Banner,
  [ValidateRange(1, 100)][int]$Rollout = 100,
  [switch]$NoPush,
  [switch]$DryRun,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if ($AppDir) { $env:YOUGRAM_APP_DIR = $AppDir }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Не найден Node.js (https://nodejs.org)" }
if (-not $NoPush -and -not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Не найден git (или используйте -NoPush)" }

if (-not $Apk) {
  if (-not $AppDir) { throw "Укажите -Apk путь\к\app.apk или -AppDir папка_проекта (либо переменную YOUGRAM_APP_DIR)" }
  $out = Join-Path $AppDir "app\build\outputs\apk"
  $found = Get-ChildItem $out -Recurse -Filter *.apk -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "androidTest" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $found) { throw "APK не найден в $out. Соберите проект или укажите -Apk" }
  $Apk = $found.FullName
}
if (-not (Test-Path $Apk)) { throw "Файл не найден: $Apk" }
$apkItem = Get-Item $Apk

if ($Notes -eq "notes.txt" -and -not (Test-Path $Notes)) {
  Write-Warning "notes.txt не найден: релиз уйдёт без списка изменений"
  $Notes = $null
}
if ($Banner -and -not (Test-Path $Banner)) { throw "Баннер не найден: $Banner" }

Write-Host ""
Write-Host "APK:      $($apkItem.FullName)"
Write-Host ("Размер:   {0:N1} МБ, собран {1}" -f ($apkItem.Length / 1MB), $apkItem.LastWriteTime)
Write-Host "Раздача:  $Rollout%"
if ($Notes) { Write-Host "Заметки:  $Notes" }
if ($Banner) { Write-Host "Баннер:   $Banner" }
if ($apkItem.LastWriteTime -lt (Get-Date).AddDays(-1)) { Write-Warning "этому APK больше суток. Это точно свежая сборка?" }
if (-not $Yes -and -not $DryRun) {
  $answer = Read-Host "Опубликовать? (y/N)"
  if ($answer -notmatch '^(y|д)') { Write-Host "Отменено."; exit 0 }
}

$a = @("tools\add-release.mjs", $apkItem.FullName, "--rollout", $Rollout)
if ($Notes) { $a += @("--notes", $Notes) }
if ($Banner) { $a += @("--banner", $Banner) }
if (-not $NoPush) { $a += "--push" }
if ($DryRun) { $a += "--dry-run" }
& node @a
if ($LASTEXITCODE -ne 0) { throw "Не удалось (код $LASTEXITCODE)" }

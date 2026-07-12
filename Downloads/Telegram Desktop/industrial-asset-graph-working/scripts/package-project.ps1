$root = Split-Path -Parent $PSScriptRoot
$zip = Join-Path (Split-Path -Parent $root) 'industrial-asset-graph-working.zip'
$exclude = @('.git', 'node_modules', 'dist', 'artifacts', 'graphify-out', 'tsconfig.app.tsbuildinfo')

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
$items = Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -notin $exclude }
Compress-Archive -LiteralPath $items.FullName -DestinationPath $zip -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $names = $archive.Entries.FullName
  if ($names -notcontains 'README.md' -or $names -notcontains 'package.json' -or $names -notcontains 'package-lock.json') {
    throw 'Archive is missing required setup files.'
  }
  Write-Output "Archive: $zip"
  Write-Output "Entries: $($names.Count)"
  Write-Output "Bytes: $((Get-Item -LiteralPath $zip).Length)"
} finally {
  $archive.Dispose()
}

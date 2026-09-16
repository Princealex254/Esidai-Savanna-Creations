$projectDir = 'C:\Users\Alex Senerwa\Desktop\Esidai Project'
$files = Get-ChildItem -Path $projectDir -Recurse -Filter "*.html"
foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if ($content -eq $null) { continue }
    $original = $content
    # Make mobile nav panel translucent: change solid white background to semi-transparent + backdrop blur
    $content = $content -replace 'background:var(--white);flex-direction:column;align-items:flex-start', 'background:rgba(255,253,248,.88);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);flex-direction:column;align-items:flex-start'
    if ($content -ne $original) {
        Set-Content $file.FullName $content -NoNewline
        Write-Output "Updated: $($file.FullName)"
    }
}
Write-Output "Done"
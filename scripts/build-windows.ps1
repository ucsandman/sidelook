$ErrorActionPreference = 'Stop'
$sidelookRoot = Split-Path -Parent $PSScriptRoot
Set-Location $sidelookRoot
$sidelookVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
$sidelookBuild = Join-Path $sidelookRoot ".artifacts/windows-$sidelookVersion"
$sidelookPayload = Join-Path $sidelookBuild ('payload-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $sidelookPayload | Out-Null
$sidelookWebViewVersion = '1.0.4191.47'
$sidelookWebViewHash = 'f492bbf547d0da329553b6727435b677579b1e9f91cc9e4a1ad029366d5f23d0'
$sidelookWebViewPackage = Join-Path $sidelookBuild "Microsoft.Web.WebView2.$sidelookWebViewVersion.nupkg"
if (-not (Test-Path -LiteralPath $sidelookWebViewPackage)) { Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sidelookWebViewVersion/microsoft.web.webview2.$sidelookWebViewVersion.nupkg" -OutFile $sidelookWebViewPackage }
if ((Get-FileHash -LiteralPath $sidelookWebViewPackage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sidelookWebViewHash) { throw 'Official WebView2 SDK package checksum mismatch.' }
$sidelookWebView = Join-Path $sidelookBuild ('webview2-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $sidelookWebView | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($sidelookWebViewPackage,$sidelookWebView)
# Fixed public inputs only. No profile, credentials, local artifacts or user revisions.
foreach ($file in @('server.mjs','package.json','LICENSE')) { Copy-Item -LiteralPath (Join-Path $sidelookRoot $file) -Destination $sidelookPayload }
# Include launcher source so its changes also select a fresh immutable install directory.
Get-ChildItem -LiteralPath (Join-Path $sidelookRoot 'desktop') -Filter '*.cs' -File | Copy-Item -Destination $sidelookPayload
Copy-Item -LiteralPath (Join-Path $sidelookWebView 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $sidelookPayload
Copy-Item -LiteralPath (Join-Path $sidelookWebView 'LICENSE.txt') -Destination (Join-Path $sidelookPayload 'WEBVIEW2-LICENSE.txt')
New-Item -ItemType Directory -Force -Path (Join-Path $sidelookPayload 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $sidelookRoot 'scripts/dictate.ps1') -Destination (Join-Path $sidelookPayload 'scripts')
Copy-Item -LiteralPath (Join-Path $sidelookRoot 'scripts/check-publisher.ps1') -Destination (Join-Path $sidelookPayload 'scripts')
foreach ($file in @('computer.ps1','Computer.cs')) { Copy-Item -LiteralPath (Join-Path $sidelookRoot "scripts/$file") -Destination (Join-Path $sidelookPayload 'scripts') }
foreach ($dir in @('lib','public')) {
    $target = Join-Path $sidelookPayload $dir
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    # lib nests (lib/agent, lib/agent/providers), so the tree is walked and each file lands under its own relative path.
    Get-ChildItem -LiteralPath (Join-Path $sidelookRoot $dir) -File -Recurse | Where-Object { $_.Extension -in @('.mjs','.js','.html','.css','.svg') } | ForEach-Object {
        $relative = $_.FullName.Substring((Join-Path $sidelookRoot $dir).Length).TrimStart('\','/')
        $destination = Join-Path $target $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination
    }
}
# The one runtime dependency (Agent mode's DashClaw SDK): the published package files only, from the lockfile-pinned install.
$sidelookDashclaw = Join-Path $sidelookPayload 'node_modules/dashclaw'
New-Item -ItemType Directory -Force -Path $sidelookDashclaw | Out-Null
foreach ($file in @('dashclaw.js','index.cjs','dashclaw.d.ts','package.json','LICENSE')) { Copy-Item -LiteralPath (Join-Path $sidelookRoot "node_modules/dashclaw/$file") -Destination $sidelookDashclaw }
$sidelookNodeZip = Join-Path $sidelookBuild 'node.zip'
$sidelookNodeHash = 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'
if (-not (Test-Path -LiteralPath $sidelookNodeZip)) { Invoke-WebRequest 'https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip' -OutFile $sidelookNodeZip }
if ((Get-FileHash -LiteralPath $sidelookNodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sidelookNodeHash) { throw 'Official Node archive checksum mismatch.' }
Expand-Archive -LiteralPath $sidelookNodeZip -DestinationPath (Join-Path $sidelookBuild 'node') -Force
$sidelookRuntime = Join-Path $sidelookPayload 'runtime'
New-Item -ItemType Directory -Force -Path $sidelookRuntime | Out-Null
Copy-Item -LiteralPath (Join-Path $sidelookBuild 'node/node-v24.15.0-win-x64/node.exe') -Destination $sidelookRuntime
Copy-Item -LiteralPath (Join-Path $sidelookBuild 'node/node-v24.15.0-win-x64/LICENSE') -Destination (Join-Path $sidelookRuntime 'NODE-LICENSE.txt')
foreach ($notice in @('LICENSE','NOTICE')) { Invoke-WebRequest "https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/$notice" -OutFile (Join-Path $sidelookRuntime "CODEX-$notice.txt") }
& npm install --prefix $sidelookRuntime --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org @openai/codex@0.153.4
if ($LASTEXITCODE -ne 0) { throw 'Official Codex package installation failed.' }
# Windows PowerShell cannot deserialize npm's empty root-package property name.
$sidelookIntegrity = 'const p=JSON.parse(require("fs").readFileSync(process.argv[2])).packages; console.log(p["node_modules/@openai/codex"].integrity); console.log(p["node_modules/@openai/codex-win32-x64"].integrity)' | & node - (Join-Path $sidelookRuntime 'package-lock.json')
if ($LASTEXITCODE -ne 0 -or $sidelookIntegrity[0] -ne 'sha512-wbHDmit7S/YvBGVX1DQmk13xtWblZ2cApeJ/pB7xDZ10Cna+DZc5ij7f0F4OxdsXN4FW1oLT48OpogUI1+8Y2w==' -or $sidelookIntegrity[1] -ne 'sha512-lMkB43kJZH0VFr+hoXc11qqR7QtQIbkr07ALgj4urKL1osNyUyuy1iXd3Vzz2iCYvBUCSw7I0l/W1cEPGx9euQ==') { throw 'Codex package integrity mismatch.' }
foreach ($binary in @((Join-Path $sidelookRuntime 'node.exe')) + @(Get-ChildItem (Join-Path $sidelookRuntime 'node_modules/@openai') -Recurse -Filter codex.exe | ForEach-Object FullName)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $binary
    if ($signature.Status -ne 'Valid') { throw 'Bundled executable signature validation failed.' }
    $publisher = if ((Split-Path -Leaf $binary) -eq 'node.exe') { 'OpenJS Foundation' } else { 'OpenAI' }
    if ($signature.SignerCertificate.Subject -notmatch $publisher) { throw 'Unexpected bundled executable publisher.' }
}
& (Join-Path $sidelookRuntime 'node.exe') (Join-Path $sidelookRuntime 'node_modules/@openai/codex/bin/codex.js') --version
if ($LASTEXITCODE -ne 0) { throw 'Bundled Codex verification failed.' }
$sidelookZip = Join-Path $sidelookBuild 'payload.zip'
Compress-Archive -Path (Join-Path $sidelookPayload '*') -DestinationPath $sidelookZip -Force
$sidelookHash = (Get-FileHash -LiteralPath $sidelookZip -Algorithm SHA256).Hash.ToLowerInvariant()
$sidelookInfo = Join-Path $sidelookBuild 'BuildInfo.cs'
Set-Content -LiteralPath $sidelookInfo -Value "internal static class BuildInfo { public const string Version = `"$sidelookVersion`"; public const string PayloadHash = `"$sidelookHash`"; }"
$sidelookExe = Join-Path $sidelookBuild "Sidelook-$sidelookVersion-Windows-x64.exe"
$sidelookCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
# UI Automation and its Point type sit in the framework's WPF folder, which csc does not search by name.
$sidelookWpf = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/WPF'
$sidelookWebViewCore = Join-Path $sidelookWebView 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$sidelookWebViewForms = Join-Path $sidelookWebView 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
$sidelookSources = @(Get-ChildItem -LiteralPath (Join-Path $sidelookRoot 'desktop') -Filter '*.cs' -File | ForEach-Object FullName)
$sidelookIcon = Join-Path $sidelookRoot 'desktop/sidelook.ico'
if (-not (Test-Path -LiteralPath $sidelookIcon)) { throw 'desktop/sidelook.ico is missing. Run scripts/build-icon.ps1 first.' }
& $sidelookCompiler /nologo /target:winexe /platform:x64 /optimize+ "/win32icon:$sidelookIcon" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Web.Extensions.dll /reference:Microsoft.CSharp.dll "/reference:$sidelookWpf/UIAutomationClient.dll" "/reference:$sidelookWpf/UIAutomationTypes.dll" "/reference:$sidelookWpf/WindowsBase.dll" "/reference:$sidelookWebViewCore" "/reference:$sidelookWebViewForms" "/resource:$sidelookZip,payload.zip" "/resource:$sidelookWebViewCore,Microsoft.Web.WebView2.Core.dll" "/resource:$sidelookWebViewForms,Microsoft.Web.WebView2.WinForms.dll" "/out:$sidelookExe" $sidelookSources $sidelookInfo
if ($LASTEXITCODE -ne 0) { throw 'Windows launcher compilation failed.' }
$sidelookExeHash = (Get-FileHash -LiteralPath $sidelookExe -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $sidelookBuild 'SHA256SUMS.txt') -Value "$sidelookExeHash  Sidelook-$sidelookVersion-Windows-x64.exe"
Write-Output "PASS: packaged Sidelook $sidelookVersion, Node 24.15.0, Codex 0.153.4, WebView2 SDK $sidelookWebViewVersion. Executable bytes: $((Get-Item -LiteralPath $sidelookExe).Length)"

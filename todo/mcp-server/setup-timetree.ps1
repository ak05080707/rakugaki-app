& {
# TimeTree 読み取りの設定（Windows PowerShell に貼り付けて Enter）
# 先に Claude を終了しておくこと。コネクターを最新版にして、TimeTree のログイン情報を Claude Desktop の設定に追加する。
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dir = Join-Path $env:USERPROFILE 'komu-todo-mcp'
if (-not (Test-Path (Join-Path $dir 'index.mjs'))) { throw '先に「E. 会社PCの Claude」のインストールを済ませてください' }
$node = (Get-Command node).Source

Write-Host "`n[1/3] コネクターを最新版にしています…" -ForegroundColor Cyan
$base = 'https://raw.githubusercontent.com/ak05080707/rakugaki-app/claude/practical-bohr-07lnjy/todo/mcp-server'
foreach ($f in 'index.mjs', 'timetree.mjs', 'configure.mjs', 'outlook.ps1', 'package.json', 'package-lock.json') {
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$f" -OutFile (Join-Path $dir $f)
}
Push-Location $dir
try { & npm.cmd install --omit=dev --no-audit --no-fund | Out-Host } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'npm install に失敗しました' }

Write-Host "`n[2/3] TimeTree のログイン情報を入力してください" -ForegroundColor Cyan
$email = (Read-Host '  TimeTree のメールアドレス').Trim()
$sec = Read-Host '  TimeTree のパスワード（入力しても画面には出ません）' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$env:TIMETREE_EMAIL = $email
$env:TIMETREE_PASSWORD = $pw

Write-Host "`n[3/3] TimeTree にログインできるか確認しています…" -ForegroundColor Cyan
$env:KOMU_TT = 'file:///' + ((Join-Path $dir 'timetree.mjs') -replace '\\', '/')
$js = "import(process.env.KOMU_TT).then(m => m.listCalendars()).then(c => console.log('OK ' + c.map(x => x.name).join(' / ')), e => console.log('NG ' + e.message))"
$out = (& $node -e $js | Out-String).Trim()
if ($out -notlike 'OK *') {
  Write-Host "  $out" -ForegroundColor Yellow
  Write-Host '  ログインできなかったので、設定は保存していません。もう一度貼り付けてやり直してください。' -ForegroundColor Yellow
  return
}
Write-Host "  OK: カレンダー → $($out.Substring(3))"
& $node (Join-Path $dir 'configure.mjs') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Claude Desktop の設定に失敗しました' }
Write-Host "`n完了しました。Claude を起動してください。" -ForegroundColor Green
}

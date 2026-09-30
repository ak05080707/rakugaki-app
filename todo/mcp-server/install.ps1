& {
# 工務TODO MCPコネクター インストーラー（Windows PowerShell に貼り付けて Enter）
# 1) Node.js が無ければ入れる  2) コネクターを %USERPROFILE%\komu-todo-mcp に置く
# 3) Claude Desktop の設定に komu-todo を追加  4) TODO につながるか確認
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = '__TODO_API_URL__'
$key = '__TODO_API_KEY__'
if ($url -like '__*') { $url = Read-Host 'ウェブアプリのURL（…/exec）を貼り付けて Enter' }
if ($key -like '__*') { $key = Read-Host '合言葉（API_KEY）を貼り付けて Enter' }
$url = ($url.Trim() -replace '\?.*$', '')
$key = $key.Trim()
if ($url -notmatch '^https://script\.google\.com/.+/exec$') { throw "URL が …/exec で終わっていません: $url" }

Write-Host "`n[1/4] Node.js を確認しています…" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  Node.js をインストールします（「このアプリがデバイスに変更を加えることを許可しますか」→ はい）'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js が見つかりません。https://nodejs.org/ja から LTS 版を入れてから、もう一度貼り付けてください。' }
}
$node = (Get-Command node).Source
Write-Host "  OK: $node ($(& $node -v))"

Write-Host "`n[2/4] コネクターをダウンロードしています…" -ForegroundColor Cyan
$dir = Join-Path $env:USERPROFILE 'komu-todo-mcp'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$base = 'https://raw.githubusercontent.com/ak05080707/rakugaki-app/claude/practical-bohr-07lnjy/todo/mcp-server'
foreach ($f in 'index.mjs', 'configure.mjs', 'outlook.ps1', 'package.json', 'package-lock.json') {
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$f" -OutFile (Join-Path $dir $f)
}
Push-Location $dir
try { & npm.cmd install --omit=dev --no-audit --no-fund | Out-Host } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'npm install に失敗しました' }
Write-Host "  OK: $dir"

Write-Host "`n[3/4] Claude Desktop の設定に追加しています…" -ForegroundColor Cyan
# JSON の書き込みは Node.js で行う（Windows PowerShell 5.1 の ConvertTo-Json は配列を崩すことがあるため）
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:TODO_API_URL = $url
$env:TODO_API_KEY = $key
& $node (Join-Path $dir 'configure.mjs') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Claude Desktop の設定に失敗しました' }

Write-Host "`n[4/4] TODO につながるか確認しています…" -ForegroundColor Cyan
# Claude と同じ仕組み（Node.js）で実際に TODO を読んでみる
$env:KOMU_MCP_INDEX = 'file:///' + ((Join-Path $dir 'index.mjs') -replace '\\', '/')
$js = "import(process.env.KOMU_MCP_INDEX).then(m => m.gas('list')).then(r => console.log('OK ' + r.length), e => console.log('NG ' + e.message))"
$out = (& $node -e $js | Out-String).Trim()
if ($out -like 'OK *') {
  Write-Host "  OK: TODO $($out.Substring(3)) 件を読み込めました"
} else {
  Write-Host "  TODO への接続確認がうまくいきませんでした。設定は書き込み済みです。" -ForegroundColor Yellow
  Write-Host "  下の内容をスクショして Claude に見せてください：" -ForegroundColor Yellow
  Write-Host "  URL: $url"
  Write-Host "  $out"
}

Write-Host "`n完了しました。Claude Desktop を一度終了して、起動し直してください。" -ForegroundColor Green
Write-Host '（右下のタスクトレイの Claude アイコンを右クリック →「終了」→ もう一度起動）'
}

param(
  [string]$Toolkit = (Join-Path $PSScriptRoot 'douyin_toolkit.js'),
  [int]$Chunk = 1800
)

# 把 douyin_toolkit.js 注入当前已登录的抖音页面。
# 单次 agent-browser eval 传 10KB+ 脚本会被截断/转义破坏，这里分片用 base64 传。
# 用法：powershell -ExecutionPolicy Bypass -File .\inject.ps1

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Toolkit)) { throw "toolkit not found: $Toolkit" }

$js = Get-Content $Toolkit -Raw -Encoding UTF8
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))

agent-browser eval "window.__dy_b64=''" | Out-Null
for ($i = 0; $i -lt $b64.Length; $i += $Chunk) {
  $part = $b64.Substring($i, [Math]::Min($Chunk, $b64.Length - $i))
  agent-browser eval "window.__dy_b64+='$part'" | Out-Null
}

$ready = agent-browser eval "eval(new TextDecoder().decode(Uint8Array.from(atob(window.__dy_b64),c=>c.charCodeAt(0))))"
$type = agent-browser eval "typeof DY"
Write-Output "inject: $ready"
Write-Output "typeof DY: $type"
if ($type -notmatch 'object') { throw 'injection failed: DY is not defined' }
Write-Output 'next: agent-browser eval "(async()=>JSON.stringify(await DY.check()))()"'

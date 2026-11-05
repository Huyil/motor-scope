/**
 * dsh-motorscope — host half.
 *
 * Owns the Windows-side MotorScope process while DSH runs in WSL:
 *   - discovers `scope_server.py` through PowerShell (pid, port, cmdline, health)
 *   - starts it in a visible console window through a generated .cmd launcher
 *   - stops the whole window tree (cmd → python → openocd) before restarting
 *
 * The browser talks to /motorscope/api/* on the DSH origin; the page itself is
 * served by the Windows process and embedded as an iframe by the client half.
 */
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-motorscope'
export const inject = ['webServer']

/** Windows-side project (where start_scope.bat and scope_server.py live). */
const WIN_PROJECT = 'D:\\Code\\motor-scope'
/** The same directory as WSL sees it (used for the launcher and python probe). */
const WSL_PROJECT = '/mnt/d/Code/motor-scope'
const WIN_PYTHON = WIN_PROJECT + '\\runtime\\python\\python.exe'
const WSL_PYTHON = WSL_PROJECT + '/runtime/python/python.exe'
const WIN_LAUNCHER = WIN_PROJECT + '\\runtime\\dsh-launch.cmd'
const WSL_LAUNCHER = WSL_PROJECT + '/runtime/dsh-launch.cmd'
const WIN_FORWARDER = WIN_PROJECT + '\\runtime\\dsh-lan-forward.py'
const WSL_FORWARDER = WSL_PROJECT + '/runtime/dsh-lan-forward.py'
const WIN_FORWARD_READY = WIN_PROJECT + '\\runtime\\dsh-lan-forward.port'
const WSL_FORWARD_READY = WSL_PROJECT + '/runtime/dsh-lan-forward.port'
const WIN_FORWARD_LOG = WIN_PROJECT + '\\runtime\\dsh-lan-forward.log'
const WIN_FORWARD_OUT = WIN_PROJECT + '\\runtime\\dsh-lan-forward.out'
const WSL_FORWARD_OUT = WSL_PROJECT + '/runtime/dsh-lan-forward.out'
const PLUGIN_FORWARDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lan_forward.py')
const DEFAULT_ARGS = ['--auto', '--port', '8765']
const API_PREFIX = '/motorscope/api'

/** LAN exposure: Windows portproxy 80 -> the loopback server, plus a scoped firewall rule. */
const LAN_PORT = 80
const LAN_RULE = 'MotorScope LAN 80'
const LAN_IP_SCRIPT = String.raw`
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$ips = @()
try {
  $ips += [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    ForEach-Object { $_.IPAddressToString }
} catch {}
try {
  $ips += Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress
} catch {}
$ips |
  Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notmatch '^(127\.|169\.254\.)' -and $_ -ne '0.0.0.0' } |
  Select-Object -Unique
`
let lanInfoCache = null

function lanRank(ip) {
  if (/^192\.168\./.test(ip)) return 0
  if (/^10\./.test(ip)) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  return 9
}

function subnet24(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(String(ip || ''))
  return m ? m[1] + '.' + m[2] + '.' + m[3] + '.0/24' : String(ip || '')
}

async function lanInfo() {
  if (lanInfoCache) return lanInfoCache
  try {
    const { stdout } = await ps(LAN_IP_SCRIPT, 15000)
    const ips = String(stdout ?? '').split(/\s+/).map(x => x.trim()).filter(ip =>
      /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.') && ip !== '0.0.0.0')
    ips.sort((a, b) => lanRank(a) - lanRank(b))
    const ip = ips[0] || ''
    lanInfoCache = ip ? { ip, subnet: subnet24(ip) } : { ip: '', subnet: '' }
  } catch {
    lanInfoCache = { ip: '', subnet: '' }
  }
  return lanInfoCache
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'motorscope-panel.json')

const PS_CANDIDATES = [
  'powershell.exe',
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
]
let psBin = ''

/** Run one executable and capture stdout/stderr; rejects with both attached. */
function runFile(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout ?? '')
        error.stderr = String(stderr ?? '')
        reject(error)
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** Run a PowerShell script, caching the first working executable path. */
async function ps(script, timeout = 20000) {
  let lastError
  for (const bin of (psBin ? [psBin] : PS_CANDIDATES)) {
    try {
      const result = await runFile(bin, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], timeout)
      psBin = bin
      return result
    } catch (error) {
      lastError = error
      if (error && error.code === 'ENOENT') continue
      throw error
    }
  }
  throw lastError ?? new Error('powershell.exe not found')
}

/** Fire-and-forget a PowerShell snippet; ignore stdio so a long-lived child cannot hold our pipes. */
function spawnDetached(script) {
  const bin = psBin || PS_CANDIDATES[0]
  const child = spawn(bin, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child.pid || 0
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Split a Windows command line into tokens (quotes stripped, no empty args). */
function tokenize(command) {
  const out = []
  let current = ''
  let quoted = false
  for (const ch of String(command ?? '')) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (current !== '') {
        out.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current !== '') out.push(current)
  return out
}

/** The scope_server.py arguments from a process command line (`--open` dropped). */
function parseArgs(command) {
  const tokens = tokenize(command)
  const at = tokens.findIndex(token => /(^|[\\/])scope_server\.py$/i.test(token))
  if (at < 0) return []
  return tokens.slice(at + 1).filter(token => token !== '--open')
}

function parseRows(stdout) {
  const text = String(stdout ?? '').replace(/^\uFEFF/, '').trim()
  if (text === '') return []
  const brace = text.indexOf('{')
  const bracket = text.indexOf('[')
  const starts = [brace, bracket].filter(index => index >= 0)
  if (starts.length === 0) return []
  const data = JSON.parse(text.slice(Math.min(...starts)))
  const raw = Array.isArray(data) ? data : (Array.isArray(data.rows) ? data.rows : [])
  return raw.map(row => ({
    pid: Number(row.pid) || 0,
    ppid: Number(row.ppid) || 0,
    parentName: String(row.parentName ?? ''),
    parentCmd: String(row.parentCmd ?? ''),
    exe: String(row.exe ?? ''),
    cmd: String(row.cmd ?? ''),
    ports: Array.isArray(row.ports) ? row.ports.map(Number).filter(Boolean) : [],
    healthy: row.healthy === true,
  })).filter(row => row.pid > 0)
}

function readSaved() {
  try {
    const value = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return {
      args: Array.isArray(value.args) ? value.args.map(String) : [],
      port: Number(value.port) || 0,
    }
  } catch {
    return { args: [], port: 0 }
  }
}

function remember(args, port) {
  if (!Array.isArray(args) || args.length === 0) return
  const saved = readSaved()
  const sameArgs = JSON.stringify(saved.args) === JSON.stringify(args)
  const samePort = !port || saved.port === port
  if (sameArgs && samePort) return
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
      args,
      port: port || saved.port || 0,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  } catch {
    // A missing cache only costs one default launch; never fail the API for it.
  }
}

const DISCOVER_SCRIPT = String.raw`
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$rows=@()
$procs=@(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'scope_server\.py' })
foreach($p in $procs){
  $ports=@()
  netstat -ano | Select-String ("LISTENING\s+" + $p.ProcessId + "$") | ForEach-Object {
    $m=[regex]::Match($_.Line, ':(\d+)\s')
    if($m.Success -and -not ($ports -contains [int]$m.Groups[1].Value)){ $ports += [int]$m.Groups[1].Value }
  }
  $healthy=$false
  if($ports.Count -gt 0){
    try {
      $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ("http://127.0.0.1:" + $ports[0] + "/api/status")
      $healthy=($r.StatusCode -eq 200)
    } catch {}
  }
  $parent=Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId)
  $rows += [pscustomobject]@{ pid=$p.ProcessId; ppid=$p.ParentProcessId; parentName=$parent.Name; parentCmd=$parent.CommandLine; exe=$p.ExecutablePath; cmd=$p.CommandLine; ports=$ports; healthy=$healthy }
}
@{ rows = @($rows) } | ConvertTo-Json -Compress -Depth 5
`

async function discover() {
  const { stdout } = await ps(DISCOVER_SCRIPT, 20000)
  const rows = parseRows(stdout)
  for (const row of rows) {
    row.args = parseArgs(row.cmd)
    if (row.ports.length === 0) {
      const at = row.args.indexOf('--port')
      const port = at >= 0 ? Number(row.args[at + 1]) : 0
      if (port) row.ports = [port]
    }
    row.port = row.ports[0] || 0
    row.url = row.port ? 'http://127.0.0.1:' + row.port + '/' : null
  }
  const first = rows.find(row => row.healthy) || rows[0]
  if (first && first.args.length > 0) remember(first.args, first.port)
  return rows
}

let cached = { at: 0, state: null }
function invalidate() {
  cached = { at: 0, state: null }
}

async function state(force = false) {
  if (!force && cached.state !== null && Date.now() - cached.at < 1500) return cached.state
  const rows = await discover()
  const saved = readSaved()
  const active = rows.find(row => row.healthy) || rows[0]
  const args = active && active.args.length > 0
    ? active.args
    : (saved.args.length > 0 ? saved.args : DEFAULT_ARGS)
  const next = {
    ok: true,
    running: rows.length > 0,
    healthy: Boolean(active && active.healthy),
    count: rows.length,
    pid: active ? active.pid : null,
    port: (active && active.port) || saved.port || 8765,
    url: active && active.url ? active.url : null,
    args,
    savedArgs: saved.args,
    cmdline: active ? active.cmd : '',
    parent: active ? active.parentName : '',
    project: WIN_PROJECT,
    ts: Date.now(),
  }
  cached = { at: Date.now(), state: next }
  return next
}

/** Quote one argument for the generated .cmd launcher. */
function winQuote(argument) {
  const text = String(argument)
  if (text === '') return '""'
  return /[\s&|<>^"]/.test(text) ? '"' + text.replace(/"/g, '\\"') + '"' : text
}

/** The plugin manages LAN via the independent forwarder; never bind scope_server to 0.0.0.0. */
function serverArgs(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    if (a === '--host' || a === '--lan-port') { i++; continue }
    if (a.startsWith('--host=') || a.startsWith('--lan-port=')) continue
    out.push(a)
  }
  return out
}

function launcherText(args) {
  const python = existsSync(WSL_PYTHON) ? WIN_PYTHON : 'python.exe'
  return [
    '@echo off',
    'chcp 65001 >nul',
    'title MotorScope (DSH)',
    'cd /d "' + WIN_PROJECT + '"',
    '"' + python + '" -u "' + WIN_PROJECT + '\\scope_server.py"' + (args.length ? ' ' + args.map(winQuote).join(' ') : ''),
    '',
  ].join('\r\n')
}

async function launch(args) {
  args = serverArgs(args)
  mkdirSync(dirname(WSL_LAUNCHER), { recursive: true })
  writeFileSync(WSL_LAUNCHER, launcherText(args), 'utf8')
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    "$ErrorActionPreference='Stop'",
    "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','\"" + WIN_LAUNCHER + "\"' -WorkingDirectory '" + WIN_PROJECT + "' -PassThru",
    '$p.Id',
  ].join('\n')
  const { stdout } = await ps(script, 20000)
  const launchedPid = Number(String(stdout).trim().split(/\s+/).pop()) || null
  remember(args, 0)
  invalidate()
  const deadline = Date.now() + 20000
  let current = null
  while (Date.now() < deadline) {
    await sleep(450)
    current = await state(true)
    if (current.running && current.healthy) break
  }
  if (current === null) current = await state(true)
  if (current.running && !current.healthy) {
    current = Object.assign({}, current, {
      warning: '进程已启动，但 20 秒内 /api/status 没就绪；请看新开的控制台窗口。',
    })
  }
  return Object.assign({}, current, { launchedPid })
}

async function stopRows(rows) {
  const pids = rows.map(row => row.pid).filter(Boolean)
  if (pids.length === 0) return
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    "$ErrorActionPreference='SilentlyContinue'",
    '$pids = @(' + pids.join(',') + ')',
    '$kill = @()',
    'foreach($procId in $pids){',
    '  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId)',
    '  if(-not $proc){ continue }',
    '  $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $proc.ParentProcessId)',
    "  if($parent -and $parent.Name -eq 'cmd.exe' -and ($parent.CommandLine -match 'scope_server\\.py|dsh-launch|start_scope')){",
    '    $kill += $parent.ProcessId',
    '  } else {',
    '    $kill += $procId',
    '  }',
    '}',
    'foreach($k in ($kill | Select-Object -Unique)){ & taskkill.exe /PID $k /T /F 2>&1 | Out-Null }',
    '$deadline = (Get-Date).AddSeconds(8)',
    'while((Get-Date) -lt $deadline){',
    '  $alive = @($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })',
    '  if($alive.Count -eq 0){ break }',
    '  Start-Sleep -Milliseconds 200',
    '}',
    '"stopped"',
  ].join('\n')
  await ps(script, 30000)
  invalidate()
}

async function start() {
  const rows = await discover()
  if (rows.length > 0) await stopRows(rows)
  const saved = readSaved()
  return launch(saved.args.length > 0 ? saved.args : DEFAULT_ARGS)
}

async function stop() {
  const rows = await discover()
  if (rows.length > 0) await stopRows(rows)
  invalidate()
  return state(true)
}

async function restart() {
  const rows = await discover()
  const args = rows.length > 0 && rows[0].args.length > 0
    ? rows[0].args
    : (readSaved().args.length > 0 ? readSaved().args : DEFAULT_ARGS)
  if (rows.length > 0) await stopRows(rows)
  return launch(args)
}

/** Serialize start/stop/restart so two clicks cannot race the same process tree. */
let queue = Promise.resolve()
function exclusive(work) {
  const run = queue.then(work, work)
  queue = run.then(() => undefined, () => undefined)
  return run
}

/** Reject cross-site POSTs: browsers send Origin, same-origin panel fetches match Host. */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === (req.headers.host || '')
  } catch {
    return false
  }
}

const FORWARD_DISCOVER_SCRIPT = String.raw`
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$rows=@()
$procs=@(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'dsh-lan-forward\.py' })
foreach($p in $procs){
  $rows += [pscustomobject]@{ pid=$p.ProcessId; cmd=$p.CommandLine }
}
@{ rows = @($rows) } | ConvertTo-Json -Compress -Depth 3
`

function ensureForwarderScript() {
  if (!existsSync(PLUGIN_FORWARDER)) throw new Error('缺少 scripts/lan_forward.py')
  mkdirSync(dirname(WSL_FORWARDER), { recursive: true })
  copyFileSync(PLUGIN_FORWARDER, WSL_FORWARDER)
}

/** Running forwarder processes (independent from scope_server.py). */
async function discoverForwarder() {
  try {
    const { stdout } = await ps(FORWARD_DISCOVER_SCRIPT, 15000)
    const text = String(stdout ?? '').trim()
    const at = text.indexOf('{')
    if (at < 0) return []
    const data = JSON.parse(text.slice(at))
    const raw = Array.isArray(data) ? data : (Array.isArray(data.rows) ? data.rows : [])
    const rows = raw.map(row => ({
      pid: Number(row.pid) || 0,
      cmd: String(row.cmd ?? ''),
    })).filter(row => row.pid > 0)
    let port = 0
    try {
      if (existsSync(WSL_FORWARD_READY)) {
        port = Number(readFileSync(WSL_FORWARD_READY, 'utf8').trim()) || 0
      }
    } catch { /* missing ready file only hides the port */ }
    return rows.map(row => Object.assign(row, { port }))
  } catch {
    return []
  }
}

async function stopForwarder() {
  const rows = await discoverForwarder()
  const pids = rows.map(row => row.pid).filter(Boolean)
  if (pids.length > 0) {
    const script = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      "$ErrorActionPreference='SilentlyContinue'",
      'Stop-Process -Id ' + pids.join(',') + ' -Force',
    ].join('\n')
    await ps(script, 10000).catch(() => {})
  }
  try {
    if (existsSync(WSL_FORWARD_READY)) unlinkSync(WSL_FORWARD_READY)
  } catch { /* ignore */ }
}

/**
 * Start the independent Windows-side TCP forwarder:
 *   0.0.0.0:<actual> -> 127.0.0.1:<scope port>
 * It does NOT restart scope_server.py; the sampler stays connected.
 */
async function startForwarder(targetPort) {
  ensureForwarderScript()
  await stopForwarder()
  try {
    if (existsSync(WSL_FORWARD_LOG)) unlinkSync(WSL_FORWARD_LOG)
    if (existsSync(WSL_FORWARD_OUT)) unlinkSync(WSL_FORWARD_OUT)
  } catch { /* ignore */ }
  const forwarderArgs = [
    '-u', WIN_FORWARDER,
    '--listen', '0.0.0.0',
    '--port', '0',
    '--target-host', '127.0.0.1',
    '--target-port', String(targetPort),
    '--ready-file', WIN_FORWARD_READY,
  ]
  const argText = forwarderArgs.map(arg => '"' + String(arg).replace(/"/g, '\\"') + '"').join(' ')
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    "$ErrorActionPreference='Stop'",
    "Start-Process -FilePath '" + WIN_PYTHON + "' -ArgumentList '" + argText + "'"
      + " -WorkingDirectory '" + WIN_PROJECT + "' -WindowStyle Hidden"
      + " -RedirectStandardError '" + WIN_FORWARD_LOG + "'"
      + " -RedirectStandardOutput '" + WIN_FORWARD_OUT + "'",
  ].join('\n')
  spawnDetached(script)
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await sleep(200)
    try {
      if (existsSync(WSL_FORWARD_READY)) {
        const port = Number(readFileSync(WSL_FORWARD_READY, 'utf8').trim()) || 0
        if (port > 0) return { pid: 0, port, targetPort }
      }
    } catch { /* retry */ }
  }
  const rows = await discoverForwarder()
  if (rows.length > 0 && rows[0].port > 0) {
    return { pid: rows[0].pid, port: rows[0].port, targetPort }
  }
  let log = ''
  try { log = readFileSync(WSL_FORWARD_LOG, 'utf8').slice(-800) } catch { /* ignore */ }
  throw new Error('转发器启动失败' + (log ? '：' + log : '（详见 runtime/dsh-lan-forward.log）'))
}

const LAN_STATE_SCRIPT = String.raw`
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$pp = $false
$reg = reg.exe query "HKLM\SYSTEM\CurrentControlSet\Services\PortProxy\v4tov4\tcp" /v "0.0.0.0/80" 2>$null
if ($LASTEXITCODE -eq 0) { $pp = $true }
$fw = $false
$out = netsh.exe advfirewall firewall show rule name="MotorScope LAN 80" 2>$null
if ($LASTEXITCODE -eq 0 -and ($out -match 'MotorScope LAN 80')) { $fw = $true }
$svc = (Get-Service iphlpsvc).Status -eq 'Running'
@{ portproxy=$pp; firewall=$fw; service=$svc; enabled=($pp -and $fw -and $svc) } | ConvertTo-Json -Compress
`

async function lanState() {
  const { stdout } = await ps(LAN_STATE_SCRIPT, 15000)
  const text = String(stdout ?? '').trim()
  const start = text.indexOf('{')
  const parsed = start >= 0 ? JSON.parse(text.slice(start)) : {}
  return {
    portproxy: parsed.portproxy === true,
    firewall: parsed.firewall === true,
    service: parsed.service === true,
    enabled: parsed.enabled === true,
  }
}

async function lanShareSet(enabled) {
  if (!enabled) {
    await stopForwarder()
    try { await lanSet(false) } catch { /* port 80 cleanup is best-effort */ }
    return await state(true)
  }
  const current = await state()
  if (!current.running || !current.port) throw new Error('先启动 MotorScope')
  await startForwarder(current.port)
  return await state(true)
}

async function lanSet(enabled) {
  if (enabled) {
    const forwarders = await discoverForwarder()
    if (forwarders.length === 0) throw new Error('先打开局域网共享')
  }
  const info = await lanInfo()
  const subnet = info.subnet || '192.168.0.0/24'
  let targetPort = readSaved().port || 8765
  try {
    const rows = await discover()
    if (rows.length > 0 && rows[0].port) targetPort = rows[0].port
  } catch { /* discovery is best-effort */ }
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    "$ErrorActionPreference='Stop'",
    "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    "if (-not $admin) { throw 'ADMIN_REQUIRED' }",
    'Start-Service iphlpsvc -ErrorAction SilentlyContinue',
    enabled
      ? 'netsh.exe interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 | Out-Null\n'
        + 'netsh.exe interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=127.0.0.1 connectport=' + targetPort + ' | Out-Null\n'
        + 'netsh.exe advfirewall firewall delete rule name="MotorScope LAN 80" | Out-Null\n'
        + 'netsh.exe advfirewall firewall add rule name="MotorScope LAN 80" dir=in action=allow protocol=TCP localport=80 remoteip=' + subnet + ' profile=any | Out-Null'
      : 'netsh.exe interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 | Out-Null\n'
        + 'netsh.exe advfirewall firewall delete rule name="MotorScope LAN 80" | Out-Null',
    '"ok"',
  ].join('\n')
  try {
    await ps(script, 30000)
  } catch (error) {
    const text = String(error.stderr ?? '') + String(error.stdout ?? '')
    if (text.includes('ADMIN_REQUIRED')) throw new Error('需要管理员权限运行 DSH（当前进程未提升）')
    throw error
  }
  const state = await lanState()
  if (enabled && !state.enabled) throw new Error('局域网开放未生效：portproxy / 防火墙 / iphlpsvc 检查失败')
  return state
}

async function lanPayload() {
  const info = await lanInfo()
  const forwarders = await discoverForwarder()
  const forwarder = forwarders[0] || null
  let p80 = await lanState()
  const share = Boolean(forwarder)
  if (!share && p80.enabled) {
    try { await lanSet(false); p80 = await lanState() } catch { /* needs admin */ }
  }
  const port = forwarder ? forwarder.port : 0
  return {
    share,
    port80: p80.enabled,
    enabled: share || p80.enabled,
    ip: info.ip,
    subnet: info.subnet,
    port,
    url: share && info.ip && port ? 'http://' + info.ip + ':' + port + '/' : '',
    url80: p80.enabled && info.ip ? 'http://' + info.ip + '/' : '',
    portproxy: p80.portproxy,
    firewall: p80.firewall,
    service: p80.service,
  }
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function apply(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
        const action = path.slice(API_PREFIX.length) || '/'
        if (req.method === 'POST' && !sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        if (action === '/lan' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, lan: await lanPayload() })
          return
        }
        if (action === '/lan/share/on' && req.method === 'POST') {
          const next = await exclusive(() => lanShareSet(true))
          sendJson(res, 200, { ok: true, state: next, lan: await lanPayload() })
          return
        }
        if (action === '/lan/share/off' && req.method === 'POST') {
          const next = await exclusive(() => lanShareSet(false))
          sendJson(res, 200, { ok: true, state: next, lan: await lanPayload() })
          return
        }
        if (action === '/lan/port80/on' && req.method === 'POST') {
          await lanSet(true)
          sendJson(res, 200, { ok: true, lan: await lanPayload() })
          return
        }
        if (action === '/lan/port80/off' && req.method === 'POST') {
          await lanSet(false)
          sendJson(res, 200, { ok: true, lan: await lanPayload() })
          return
        }
        if (action === '/lan/on' && req.method === 'POST') {
          await lanSet(true)
          sendJson(res, 200, { ok: true, lan: await lanPayload() })
          return
        }
        if (action === '/lan/off' && req.method === 'POST') {
          await lanSet(false)
          sendJson(res, 200, { ok: true, lan: await lanPayload() })
          return
        }
        if (action === '/state' && req.method === 'GET') {
          sendJson(res, 200, await state())
          return
        }
        if (action === '/start' && req.method === 'POST') {
          sendJson(res, 200, { ok: true, state: await exclusive(() => start()) })
          return
        }
        if (action === '/stop' && req.method === 'POST') {
          sendJson(res, 200, { ok: true, state: await exclusive(() => stop()) })
          return
        }
        if (action === '/restart' && req.method === 'POST') {
          sendJson(res, 200, { ok: true, state: await exclusive(() => restart()) })
          return
        }
        sendJson(res, 404, { ok: false, error: 'unknown motorscope api: ' + action })
      } catch (error) {
        console.error('[dsh-motorscope]', error)
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })
  ctx.effect(() => dispose, 'dsh-motorscope: api routes')
  console.log('[dsh-motorscope] api ready at ' + API_PREFIX)
}

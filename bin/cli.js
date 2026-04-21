#!/usr/bin/env node
/**
 * cc-voice CLI — 一键启动入口
 *
 * Usage:
 *   npx cc-voice              # 快速隧道 (trycloudflare.com 随机域名)
 *   npx cc-voice --local      # 仅局域网，不启隧道
 *   npx cc-voice --tunnel-token=eyJ...  # 命名隧道 (自定义域名)
 *
 * 环境变量覆盖:
 *   PORT / CLAUDE_MODEL / CLAUDE_PERMISSION_MODE / CLAUDE_CWD / TUNNEL_TOKEN
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── 加载 .env ─────────────────────────────────────────────
const projectRoot = path.join(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val; // 不覆盖已有环境变量
    }
  }
}

// ─── 参数解析 ────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a === '--local') flags.local = true;
  else if (a === '--tunnel') flags.tunnel = true;
  else if (a === '--help' || a === '-h') flags.help = true;
  else if (a.startsWith('--tunnel-token=')) { flags.tunnelToken = a.split('=')[1]; flags.tunnel = true; }
  else if (a.startsWith('--relay=')) flags.relay = a.split('=')[1];
  else if (a.startsWith('--port=')) flags.port = a.split('=')[1];
  else if (a.startsWith('--model=')) flags.model = a.split('=')[1];
  else if (a.startsWith('--cwd=')) flags.cwd = a.split('=')[1];
}

if (flags.help) {
  console.log(`
  cc-voice — 手机遥控你的 Claude Code

  Usage:
    npx cc-voice              快速启动 (通过 ccvoice.app 中继)
    npx cc-voice --local      仅局域网
    npx cc-voice --tunnel     用 Cloudflare Tunnel (需要 cloudflared)
    npx cc-voice --tunnel-token=eyJ...  命名隧道
    npx cc-voice --port=3456  指定端口
    npx cc-voice --model=opus 指定 Claude 模型
    npx cc-voice --cwd=/path  Claude 工作目录
    npx cc-voice --relay=URL  自定义 relay 地址

  连接模式 (默认 relay):
    relay   — 通过 ccvoice.app 公共中继，无需额外配置 (推荐)
    tunnel  — 自建 Cloudflare Tunnel，需安装 cloudflared
    local   — 仅局域网访问

  环境变量:
    PORT  CLAUDE_MODEL  CLAUDE_PERMISSION_MODE  CLAUDE_CWD  RELAY_URL
  `);
  process.exit(0);
}

// ─── Preflight Check ────────────────────────────────────
function check(cmd, label, required) {
  try {
    const ver = execSync(`${cmd} --version 2>/dev/null || ${cmd} -v 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000
    }).trim().split('\n')[0];
    console.log(`  ✅ ${label}: ${ver}`);
    return true;
  } catch {
    if (required) {
      console.log(`  ❌ ${label}: 未找到`);
      return false;
    }
    console.log(`  ⚠️  ${label}: 未找到 (可选)`);
    return false;
  }
}

function checkClaude() {
  try {
    execSync('claude -p "1" --output-format text --max-turns 1 2>/dev/null', {
      encoding: 'utf-8', timeout: 15000
    });
    console.log('  ✅ Claude CLI: 已登录');
    return true;
  } catch {
    // 可能超时但 claude 存在
    try {
      execSync('which claude || where claude', { encoding: 'utf-8', timeout: 3000 });
      console.log('  ⚠️  Claude CLI: 存在但未验证登录态');
      return true;
    } catch {
      console.log('  ❌ Claude CLI: 未找到');
      console.log('     安装: npm install -g @anthropic-ai/claude-code');
      return false;
    }
  }
}

console.log('\n  🔍 环境检查...\n');

const nodeOk = check('node', 'Node.js', true);
const claudeOk = checkClaude();
const cloudflaredOk = check('cloudflared', 'cloudflared', false);

if (!nodeOk || !claudeOk) {
  console.log('\n  ❌ 缺少必要依赖，无法启动。\n');
  process.exit(1);
}

console.log('');

// ─── 模式判断 ────────────────────────────────────────────
// 默认用 relay 公共通道（不需要 cloudflared）
// --local    仅局域网
// --tunnel   用 cloudflare tunnel（需要 cloudflared）
const RELAY_URL = flags.relay || process.env.RELAY_URL || 'https://ccvoice.app';

if (!flags.local && !flags.tunnel) {
  // 默认 relay 模式，不需要 cloudflared
  console.log(`  📡 模式: Relay (${RELAY_URL})\n`);
} else if (flags.tunnel) {
  if (!cloudflaredOk) {
    console.log('\n  💡 未检测到 cloudflared，回退到 relay 模式。');
    console.log('     安装 cloudflared: brew install cloudflared\n');
    flags.tunnel = false;
  }
} else {
  console.log('  📡 模式: 仅局域网\n');
}

// ─── 启动服务 ───────────────────────────────────────────
const PORT = flags.port || process.env.PORT || '3456';
const serverEnv = {
  ...process.env,
  PORT,
  BRIDGE_MODE: 'cli',
  CLAUDE_MODEL: flags.model || process.env.CLAUDE_MODEL || 'sonnet',
  CLAUDE_CWD: flags.cwd || process.env.CLAUDE_CWD || process.cwd(),
};

const serverPath = path.join(__dirname, '..', 'server.js');
const serverProc = spawn(process.execPath, [serverPath], {
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverReady = false;

serverProc.stdout.on('data', (d) => {
  process.stdout.write(d);
  if (!serverReady && d.toString().includes('running at')) {
    serverReady = true;
    if (flags.local) return;
    if (flags.tunnel) {
      startTunnel(PORT);
    } else {
      startRelay(PORT);
    }
  }
});
serverProc.stderr.on('data', (d) => process.stderr.write(d));
serverProc.on('close', (code) => {
  console.log(`\n  服务已停止 (exit ${code})`);
  process.exit(code || 0);
});

// ─── Relay 模式（默认）──────────────────────────────────
// 1. 向 relay server 申请配对码
// 2. 以 upstream 身份连入 relay
// 3. relay 透传手机 ↔ 本地的所有 WS 消息
const WebSocket = require('ws');
let relayWs = null;
let relayCode = null;
let relayRetry = 0;
let relayPingTimer = null;

async function startRelay(port) {
  try {
    // 首次连接才申请配对码，重连复用
    if (!relayCode) {
      const res = await fetch(`${RELAY_URL}/api/relay/create`, { method: 'POST' });
      if (!res.ok) throw new Error(`Relay API error: ${res.status}`);
      const { code } = await res.json();
      relayCode = code;
    }

    // 连接 relay 作为 upstream（复用同一个 code）
    connectRelayUpstream(port, relayCode);
  } catch (e) {
    console.error(`\n  ❌ Relay 连接失败: ${e.message}`);
    console.log('     回退到局域网模式，手机需连同一 WiFi 使用 LAN 地址。\n');
  }
}

function connectRelayUpstream(port, code) {
  const wsUrl = RELAY_URL.replace(/^http/, 'ws');
  const url = `${wsUrl}/relay?code=${code}&role=upstream`;

  relayWs = new WebSocket(url);

  relayWs.on('open', () => {
    relayRetry = 0;
    printRelayInfo(code);

    // 心跳保活（每 20s ping 一次，防止 Cloudflare 关闭空闲连接）
    clearInterval(relayPingTimer);
    relayPingTimer = setInterval(() => {
      if (relayWs?.readyState === WebSocket.OPEN) relayWs.ping();
    }, 20000);

    // 连接本地 WS 并桥接
    bridgeLocalWs(port);
  });

  relayWs.on('close', (code_) => {
    clearInterval(relayPingTimer);
    if (localWs) { try { localWs.close(); } catch {} localWs = null; }
    console.log(`\n  ⚠️  Relay 连接断开 (code: ${code_})`);
    relayRetry++;
    const delay = Math.min(relayRetry * 2, 30);
    console.log(`     ${delay}s 后重连 (配对码不变: ${relayCode})...\n`);
    setTimeout(() => connectRelayUpstream(port, relayCode), delay * 1000);
  });

  relayWs.on('error', (e) => {
    console.error('  [relay]', e.message);
  });
}

// 桥接：relay ↔ 本地 WS server
let localWs = null;

let relayMsgHandler = null;

function bridgeLocalWs(port) {
  // 清理旧连接
  if (localWs) {
    try { localWs.removeAllListeners(); localWs.close(); } catch {}
    localWs = null;
  }
  // 清理旧的 relay message handler（防止重复绑定）
  if (relayMsgHandler && relayWs) {
    try { relayWs.removeListener('message', relayMsgHandler); } catch {}
  }

  localWs = new WebSocket(`ws://localhost:${port}`);

  localWs.on('open', () => {
    console.log('  ✅ Relay ↔ 本地桥接就绪\n');
  });

  // 本地 → relay（转发给手机）
  localWs.on('message', (data) => {
    if (relayWs?.readyState === WebSocket.OPEN) {
      relayWs.send(data.toString());
    }
  });

  // relay → 本地（来自手机的消息）
  relayMsgHandler = (data) => {
    const msg = data.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type?.startsWith('relay:')) {
        if (parsed.type === 'relay:peer_connected' && parsed.role === 'downstream') {
          console.log('  📱 手机已连接!\n');
        } else if (parsed.type === 'relay:peer_disconnected' && parsed.role === 'downstream') {
          console.log('  📱 手机已断开\n');
        }
        return;
      }
    } catch {}

    if (localWs?.readyState === WebSocket.OPEN) {
      localWs.send(msg);
    } else {
      console.log('  ⚠️  本地 WS 未就绪，丢弃消息');
      bridgeLocalWs(port); // 尝试重建
    }
  };
  relayWs.on('message', relayMsgHandler);

  localWs.on('close', () => {
    console.log('  ⚠️  本地 WS 断开，2s 后重连...');
    setTimeout(() => bridgeLocalWs(port), 2000);
  });

  localWs.on('error', () => {});
}

function printRelayInfo(code) {
  const phoneUrl = `${RELAY_URL}/#pair=${code}`;
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  📱 手机打开 ccvoice.app 输入配对码:              ║');
  console.log('  ║                                                  ║');
  console.log(`  ║           配对码:  ${code}                        ║`);
  console.log('  ║                                                  ║');
  console.log('  ║  或直接扫码:                                      ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  printQR(phoneUrl);
}

// ─── Tunnel 模式（备用）─────────────────────────────────
function startTunnel(port) {
  const token = flags.tunnelToken || process.env.TUNNEL_TOKEN;

  if (token) {
    console.log('  🌍 启动命名隧道...\n');
    const tunnel = spawn('cloudflared', ['tunnel', 'run', '--token', token], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    tunnel.stdout.on('data', (d) => process.stdout.write(d));
    tunnel.stderr.on('data', (d) => {
      const line = d.toString();
      process.stderr.write(d);
      if (line.includes('Registered tunnel connection')) {
        console.log('\n  ✅ 隧道已连接');
      }
    });
    tunnel.on('close', (code) => {
      if (code !== 0) {
        console.log(`\n  ⚠️  隧道断开 (exit ${code})，5s 后重连...`);
        setTimeout(() => startTunnel(port), 5000);
      }
    });
    setupCleanup(tunnel);
  } else {
    console.log('  🌍 启动快速隧道...\n');
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    tunnel.stderr.on('data', (d) => {
      const line = d.toString();
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) printAccessInfo(match[0]);
    });
    tunnel.on('close', (code) => {
      if (code !== 0) {
        console.log(`\n  ⚠️  隧道断开 (exit ${code})，5s 后重连...`);
        setTimeout(() => startTunnel(port), 5000);
      }
    });
    setupCleanup(tunnel);
  }
}

function printAccessInfo(url) {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  📱 手机扫码或浏览器打开:                         ║');
  console.log(`  ║  ${url.padEnd(48)}║`);
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  printQR(url);
}

// ─── QR 码 ──────────────────────────────────────────────
function printQR(text) {
  try {
    const qr = require('qrcode-terminal');
    qr.generate(text, { small: true }, (code) => {
      console.log(code);
    });
  } catch {
    console.log('  💡 安装 qrcode-terminal 可显示二维码:');
    console.log('     npm install -g qrcode-terminal\n');
  }
}

// ─── 清理 ───────────────────────────────────────────────
let tunnelProc = null;
function setupCleanup(tunnel) {
  tunnelProc = tunnel;
}

function cleanup() {
  if (tunnelProc) tunnelProc.kill();
  if (relayWs) relayWs.close();
  if (localWs) localWs.close();
  if (serverProc) serverProc.kill();
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

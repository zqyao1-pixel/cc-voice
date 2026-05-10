#!/usr/bin/env node
/**
 * ccvoice v3 — CLI 包装器
 *
 * 包装 Claude Code 原生进程，捕获 stdin/stdout，
 * 通过加密 WebSocket 转发到 relay，实现手机远程控制。
 *
 * Usage:
 *   ccvoice                     # 启动，显示配对二维码
 *   ccvoice --local             # 仅本地，不连 relay
 *   ccvoice --project ~/myapp   # 指定项目目录
 *   ccvoice --relay wss://...   # 自定义 relay
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

// ─── .env 加载 ─────────────────────────────────────────
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
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ─── 参数解析 ──────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
const claudeArgs = []; // 透传给 claude 的参数

for (const a of args) {
  if (a === '--local') flags.local = true;
  else if (a === '--help' || a === '-h') flags.help = true;
  else if (a === '--unsafe') flags.unsafe = true;
  else if (a.startsWith('--project=')) flags.project = a.split('=').slice(1).join('=');
  else if (a.startsWith('--relay=')) flags.relay = a.split('=').slice(1).join('=');
  else if (a.startsWith('--model=')) flags.model = a.split('=').slice(1).join('=');
  else if (a === '--verbose') flags.verbose = true;
  else claudeArgs.push(a); // 其余参数透传给 claude
}

if (flags.help) {
  console.log(`
  ccvoice — 手机遥控你的 Claude Code (v3)

  Usage:
    ccvoice                       启动并显示配对二维码
    ccvoice --local               仅本地，不连 relay
    ccvoice --project=~/myapp     指定项目目录
    ccvoice --model=opus          指定 Claude 模型
    ccvoice --relay=wss://...     自定义 relay 地址
    ccvoice --unsafe              允许 owner 跳过 Claude 工具批准（默认关闭）
    ccvoice [claude args...]      其余参数透传给 claude

  环境变量:
    RELAY_URL  CLAUDE_MODEL  CLAUDE_CWD
  `);
  process.exit(0);
}

// ─── 配置 ──────────────────────────────────────────────
const RELAY_URL = flags.relay || process.env.RELAY_URL || 'https://ccvoice.app';
const CLAUDE_CWD = flags.project || process.env.CLAUDE_CWD || process.cwd();
const CLAUDE_MODEL = flags.model || process.env.CLAUDE_MODEL || 'sonnet';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const PERMISSION_MODE = flags.unsafe
  ? 'bypassPermissions'
  : (process.env.CLAUDE_PERMISSION_MODE || 'default');

// ─── 加密模块 ──────────────────────────────────────────
// X25519 ECDH + AES-256-GCM
const E2E = {
  generateKeyPair() {
    const keyPair = crypto.generateKeyPairSync('x25519');
    // 导出 raw 格式公钥 (32 bytes)，与 Web Crypto API 兼容
    const publicKeyRaw = keyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    return {
      publicKey: publicKeyRaw,
      privateKey: keyPair.privateKey,
    };
  },

  deriveSharedSecret(privateKey, peerPublicKeyRaw) {
    // 从 raw 32 bytes 构造 X25519 公钥
    // X25519 SPKI DER = 固定 12 字节头 + 32 字节 raw key
    const spkiHeader = Buffer.from('302a300506032b656e032100', 'hex');
    const spkiDer = Buffer.concat([spkiHeader, Buffer.from(peerPublicKeyRaw)]);
    const peerPubKey = crypto.createPublicKey({
      key: spkiDer,
      type: 'spki',
      format: 'der',
    });
    return crypto.diffieHellman({
      privateKey: privateKey,
      publicKey: peerPubKey,
    });
  },

  // 从 ECDH 共享密钥派生 AES-256 密钥
  deriveAESKey(sharedSecret) {
    return crypto.createHash('sha256').update(sharedSecret).digest();
  },

  encrypt(plaintext, aesKey) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Web Crypto 兼容：tag 追加到 ciphertext 尾部
    const combined = Buffer.concat([encrypted, tag]);
    return { nonce: nonce.toString('base64'), ciphertext: combined.toString('base64') };
  },

  decrypt(encrypted, aesKey) {
    const nonce = Buffer.from(encrypted.nonce, 'base64');
    const combined = Buffer.from(encrypted.ciphertext, 'base64');
    // Web Crypto 兼容：tag 是最后 16 字节
    const ciphertext = combined.subarray(0, -16);
    const tag = combined.subarray(-16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  },
};

// ─── 状态 ──────────────────────────────────────────────
let relayWs = null;
let relayCode = null;       // 配对码 (CLI 启动时生成,owner 用此码首次配对)
let inviteCode = null;      // 邀请码 (owner 配对成功后生成,给 observer 用)
let keyPair = null;
let aesKey = null;       // 配对完成后的共享加密密钥
let paired = false;
let pingTimer = null;
let localMode = false;   // 本地键盘是否接管
let sessionId = null;    // Claude CLI session ID (跨消息连续)
let claudeBusy = false;  // 当前是否有 claude -p 在执行
let messageQueue = [];   // 排队等待的消息

// 已连接的 peers (peerId → { role: 'owner'|'observer', aesKey, nickname })
const peers = new Map();
let groupKey = null;     // 群组加密密钥 (多人场景)
// 待处理建议 (id → { id, text, from, nickname, status, createdAt })
const pendingSuggestions = new Map();

// ─── Claude Code 调用 (每条消息一次 claude -p --resume) ─
function sendToClaude(text) {
  if (claudeBusy) {
    messageQueue.push(text);
    console.log(`  ⏳ Claude 忙碌中，排队 (队列: ${messageQueue.length})`);
    broadcastToRemote({ type: 'status', status: 'queued', queueLength: messageQueue.length });
    return;
  }

  claudeBusy = true;
  broadcastToRemote({ type: 'status', status: 'thinking' });

  const cliArgs = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--model', CLAUDE_MODEL,
    '--permission-mode', PERMISSION_MODE,
  ];

  // 有 session ID → resume（上下文连续）
  if (sessionId) {
    cliArgs.push('--resume', sessionId);
    if (flags.verbose) console.log(`  [claude] RESUME ${sessionId}`);
  }

  cliArgs.push(...claudeArgs, '-'); // 从 stdin 读取

  const child = spawn(CLAUDE_BIN, cliArgs, {
    cwd: CLAUDE_CWD,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // 通过 stdin 传 prompt
  child.stdin.write(text);
  child.stdin.end();

  // stdout → 解析 stream-json → 本地显示 + 广播
  let stdoutBuf = '';
  let fullResponse = '';

  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);

        // 捕获 session ID
        if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
          if (!sessionId) {
            sessionId = evt.session_id;
            console.log(`  📌 Session: ${sessionId}`);
          }
        }
        if (evt.session_id && !sessionId) sessionId = evt.session_id;

        // 本地显示
        displayEvent(evt);
        // 广播给远程客户端
        broadcastToRemote({ type: 'terminal_event', event: evt });

        // 收集完整回复
        const chunk = extractText(evt);
        if (chunk) fullResponse += chunk;

      } catch {
        process.stdout.write(line + '\n');
        broadcastToRemote({ type: 'terminal_raw', data: line });
      }
    }
  });

  child.stderr.on('data', (d) => {
    if (flags.verbose) process.stderr.write(`  [claude] ${d.toString()}`);
  });

  child.on('close', (code) => {
    claudeBusy = false;

    if (code === 0) {
      broadcastToRemote({ type: 'status', status: 'done' });
      process.stdout.write('\n');
    } else {
      console.error(`  ❌ Claude exit ${code}`);
      broadcastToRemote({ type: 'status', status: 'error', code });
    }

    // 处理队列中的下一条消息
    if (messageQueue.length > 0) {
      const next = messageQueue.shift();
      console.log(`  📤 处理队列消息 (剩余: ${messageQueue.length})`);
      sendToClaude(next);
    }
  });

  child.on('error', (err) => {
    claudeBusy = false;
    console.error(`  ❌ Claude 启动失败: ${err.message}`);
    broadcastToRemote({ type: 'status', status: 'error', message: err.message });
  });
}

// 从 stream-json 事件提取文本
function extractText(evt) {
  if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
    const d = evt.event.delta;
    if (d?.type === 'text_delta' && d.text) return d.text;
  }
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    return evt.message.content.filter(c => c.type === 'text').map(c => c.text || '').join('');
  }
  return '';
}

// 从 stream-json 事件中提取可读内容并本地显示
function displayEvent(evt) {
  // system init
  if (evt.type === 'system' && evt.subtype === 'init') {
    console.log(`  ✅ Claude 会话已启动 (session: ${evt.session_id || 'unknown'})`);
    return;
  }

  // 文本增量
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text) {
        process.stdout.write(block.text);
      }
    }
    return;
  }

  // stream delta
  if (evt.type === 'content_block_delta' || (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta')) {
    const delta = evt.delta || evt.event?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      process.stdout.write(delta.text);
    }
    return;
  }

  // result
  if (evt.type === 'result') {
    if (evt.is_error) {
      console.error(`\n  ❌ Error: ${evt.error || 'unknown'}`);
    } else {
      process.stdout.write('\n');
    }
    return;
  }
}

// ─── 远程消息广播 ──────────────────────────────────────
function broadcastToRemote(msg) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return;
  if (!groupKey && !aesKey) return; // 没配对就不发

  try {
    const key = groupKey || aesKey;
    const encrypted = E2E.encrypt(JSON.stringify(msg), key);
    relayWs.send(JSON.stringify({ type: 'encrypted', payload: encrypted }));
  } catch (e) {
    if (flags.verbose) console.error('  [broadcast error]', e.message);
  }
}

// 处理远程客户端发来的消息
function handleRemoteMessage(msg) {
  // msg.from 是 client 自报 peerId。在 paired 加密信道里,只有持有 group
  // key 的 peer 能发出能解密的消息,所以 from 在已配对集合内是可信的。
  const sender = peers.get(msg.from);
  const senderRole = sender?.role;
  const senderNick = sender?.nickname || msg.nickname || (msg.from || '').substring(0, 4).toUpperCase();

  switch (msg.type) {
    case 'input':
      // 仅 Owner 可直接发指令;observer 走 suggestion 流程。
      if (senderRole !== 'owner') {
        console.log(`  ⚠️  非 owner (${senderNick}) 尝试 input,已拒绝`);
        break;
      }
      console.log(`\n  📱 [${senderNick}] ${msg.text.substring(0, 80)}`);
      // ★ 广播 owner 输入 — 让所有 downstream 看到 owner 在做什么
      // (relay 已经移除 D2D 直发,所有可见消息必须由 CLI 广播)
      broadcastToRemote({
        type: 'user_input',
        text: msg.text,
        from: msg.from,
        nickname: senderNick,
        role: 'owner',
      });
      sendToClaude(msg.text);
      break;

    case 'suggestion': {
      // Observer 建议 — 生成 id,存 pending,广播 suggestion_broadcast
      const id = crypto.randomBytes(4).toString('hex');
      const sugg = {
        id,
        text: msg.text || '',
        from: msg.from || 'observer',
        nickname: senderNick,
        status: 'pending',
        createdAt: Date.now(),
      };
      pendingSuggestions.set(id, sugg);
      console.log(`\n  💡 [建议 ${id} from ${senderNick}] ${sugg.text}`);
      broadcastToRemote({ type: 'suggestion_broadcast', ...sugg });
      break;
    }

    case 'approve_suggestion': {
      if (senderRole !== 'owner') {
        console.log(`  ⚠️  非 owner 尝试批准建议,已拒绝`);
        break;
      }
      const sugg = pendingSuggestions.get(msg.id);
      if (!sugg || sugg.status !== 'pending') break;
      sugg.status = 'approved';
      console.log(`  ✅ [批准建议 ${sugg.id}] ${sugg.text.substring(0, 80)}`);
      broadcastToRemote({ type: 'suggestion_broadcast', ...sugg });
      sendToClaude(sugg.text);
      pendingSuggestions.delete(sugg.id);
      break;
    }

    case 'reject_suggestion': {
      if (senderRole !== 'owner') break;
      const sugg = pendingSuggestions.get(msg.id);
      if (!sugg || sugg.status !== 'pending') break;
      sugg.status = 'rejected';
      console.log(`  🚫 [忽略建议 ${sugg.id}]`);
      broadcastToRemote({ type: 'suggestion_broadcast', ...sugg });
      pendingSuggestions.delete(sugg.id);
      break;
    }

    case 'voice_transcript':
      // 语音 — Owner 直接执行,Observer 转成建议
      if (senderRole === 'owner') {
        console.log(`\n  🎤 [${senderNick}] ${msg.text.substring(0, 80)}`);
        broadcastToRemote({
          type: 'user_input',
          text: msg.text,
          from: msg.from,
          nickname: senderNick,
          role: 'owner',
        });
        sendToClaude(msg.text);
      } else {
        const id = crypto.randomBytes(4).toString('hex');
        const sugg = {
          id,
          text: msg.text || '',
          from: msg.from || 'observer',
          nickname: senderNick,
          status: 'pending',
          createdAt: Date.now(),
        };
        pendingSuggestions.set(id, sugg);
        console.log(`\n  🎤💡 [Observer 语音建议 ${id} from ${senderNick}] ${sugg.text}`);
        broadcastToRemote({ type: 'suggestion_broadcast', ...sugg });
      }
      break;

    default:
      if (flags.verbose) console.log(`  [remote] unknown type: ${msg.type}`);
  }
}

// 广播当前参与者列表 (含 CLI 自己 + 所有 paired peer)
function broadcastParticipants() {
  const participants = [
    { id: 'cli', role: 'upstream', nickname: 'Claude Code' },
    ...[...peers.entries()].map(([id, p]) => ({
      id,
      role: p.role,
      nickname: p.nickname || id.substring(0, 4).toUpperCase(),
    })),
  ];
  broadcastToRemote({ type: 'participants', participants });
}

// 异步生成邀请码 — owner 配对成功后调用,把别名注册到 relay 的 KV。
// 失败时降级为复用配对码 (旧行为),保证仍然可用。
async function generateInviteCode() {
  try {
    const res = await fetch(`${RELAY_URL}/api/relay/create-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: relayCode }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    inviteCode = data.inviteCode;
    console.log(`\n  🎟️  邀请码: ${inviteCode}`);
    console.log(`  (配对码 ${relayCode} 仅用于首次配对,邀请码 ${inviteCode} 用于邀请其他设备)\n`);
    // 通知所有 paired peer (主要是 owner)
    broadcastToRemote({ type: 'invite_code', inviteCode });
  } catch (e) {
    console.error(`  ⚠️  邀请码生成失败: ${e.message},降级使用配对码`);
    inviteCode = relayCode;
    broadcastToRemote({ type: 'invite_code', inviteCode });
  }
}

// ─── Relay 连接 ────────────────────────────────────────
async function connectRelay() {
  if (flags.local) {
    console.log('  📡 模式: 仅本地\n');
    return;
  }

  try {
    // 申请配对码
    if (!relayCode) {
      const res = await fetch(`${RELAY_URL}/api/relay/create`, { method: 'POST' });
      if (!res.ok) throw new Error(`Relay API ${res.status}`);
      const data = await res.json();
      relayCode = data.code;
    }

    // 生成加密密钥对
    keyPair = E2E.generateKeyPair();

    // 连接 relay
    const wsUrl = RELAY_URL.replace(/^http/, 'ws');
    const url = `${wsUrl}/relay?code=${relayCode}&role=upstream`;

    relayWs = new WebSocket(url);

    relayWs.on('open', () => {
      console.log('  ✅ Relay 已连接\n');

      // 心跳
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (relayWs?.readyState === WebSocket.OPEN) relayWs.ping();
      }, 20000);

      // 显示配对信息
      printPairInfo();
    });

    relayWs.on('message', (raw) => {
      const data = raw.toString();
      try {
        const msg = JSON.parse(data);
        handleRelayMessage(msg);
      } catch {}
    });

    relayWs.on('close', (code) => {
      clearInterval(pingTimer);
      console.log(`  ⚠️  Relay 断开 (${code})，3s 后重连...`);
      setTimeout(() => connectRelay(), 3000);
    });

    relayWs.on('error', (e) => {
      if (flags.verbose) console.error('  [relay error]', e.message);
    });

  } catch (e) {
    console.error(`  ❌ Relay 连接失败: ${e.message}`);
    console.log('     将在 5s 后重试...\n');
    setTimeout(() => connectRelay(), 5000);
  }
}

function handleRelayMessage(msg) {
  // Relay 控制消息
  if (msg.type?.startsWith('relay:')) {
    if (msg.type === 'relay:peer_connected') {
      console.log(`  📱 peer 已连接`);
    } else if (msg.type === 'relay:peer_disconnected') {
      // 清理 peers 表,避免 ghost 计入 owner 分配
      const peerId = msg.peerId;
      if (peerId && peers.has(peerId)) {
        const wasOwner = peers.get(peerId).role === 'owner';
        peers.delete(peerId);
        console.log(`  📱 ${wasOwner ? 'Owner' : 'Observer'} 已断开 (${peerId.substring(0, 8)})`);
        // 如果 owner 离开且还有 observer,把第一个 observer 升级为 owner
        if (wasOwner && peers.size > 0) {
          const [firstId, firstPeer] = [...peers.entries()][0];
          firstPeer.role = 'owner';
          console.log(`  👑 ${firstId.substring(0, 8)} 升级为 Owner`);
        }
        broadcastParticipants();
      }
    }
    return;
  }

  // 配对握手：收到客户端的公钥
  if (msg.type === 'pair_handshake') {
    try {
      const peerPubKeyDer = Buffer.from(msg.publicKey, 'base64');
      const sharedSecret = E2E.deriveSharedSecret(keyPair.privateKey, peerPubKeyDer);
      const peerAesKey = E2E.deriveAESKey(sharedSecret);

      const peerId = msg.peerId || 'default';
      const nickname = (msg.nickname || '').trim() || peerId.substring(0, 4).toUpperCase();
      const existing = peers.get(peerId);
      let assignedRole;
      if (existing) {
        assignedRole = existing.role;
      } else {
        const ownerExists = [...peers.values()].some(p => p.role === 'owner');
        assignedRole = ownerExists ? 'observer' : 'owner';
      }
      peers.set(peerId, { role: assignedRole, aesKey: peerAesKey, nickname });

      // 如果是第一个 peer，用这个作为主 aesKey
      if (!aesKey) aesKey = peerAesKey;

      // ★ 顺序: 先 ack → 再 group_key (避免 race)
      // (group_key 在 ack 之前到达会因 downstream 没建好 sharedAESKey 解密失败)
      relayWs.send(JSON.stringify({
        type: 'pair_handshake_ack',
        publicKey: keyPair.publicKey.toString('base64'),
        peerId,
        role: assignedRole,
        nickname,
        inviteCode: inviteCode || null,  // 已有邀请码顺带发过去
      }));

      paired = true;
      console.log(`  🔐 E2E 加密已建立 (${assignedRole}: ${nickname} / ${peerId.substring(0, 8)})`);

      // group_key 分发
      if (peers.size > 1 && !groupKey) {
        groupKey = crypto.randomBytes(32);
        for (const [id, peer] of peers) {
          const encryptedGK = E2E.encrypt(groupKey.toString('base64'), peer.aesKey);
          relayWs.send(JSON.stringify({ type: 'group_key', peerId: id, payload: encryptedGK }));
        }
      } else if (groupKey) {
        const encryptedGK = E2E.encrypt(groupKey.toString('base64'), peerAesKey);
        relayWs.send(JSON.stringify({ type: 'group_key', peerId, payload: encryptedGK }));
      }

      // 第一个 owner 配对成功 → 异步生成邀请码
      if (assignedRole === 'owner' && !inviteCode) {
        generateInviteCode();
      }

      // 发送会话状态 + 参与者列表
      broadcastToRemote({ type: 'session_info', cwd: CLAUDE_CWD, model: CLAUDE_MODEL });
      broadcastParticipants();
      // 重发未决建议给新加入的 peer
      for (const sugg of pendingSuggestions.values()) {
        broadcastToRemote({ type: 'suggestion_broadcast', ...sugg });
      }

    } catch (e) {
      console.error('  ❌ 配对握手失败:', e.message);
    }
    return;
  }

  // 加密消息：解密后处理
  if (msg.type === 'encrypted' && msg.payload) {
    try {
      const key = groupKey || aesKey;
      if (!key) { console.log('  ⚠️  收到加密消息但未配对'); return; }
      const decrypted = E2E.decrypt(msg.payload, key);
      const innerMsg = JSON.parse(decrypted);
      handleRemoteMessage(innerMsg);
    } catch (e) {
      if (flags.verbose) console.error('  [decrypt error]', e.message);
    }
    return;
  }
}

// ─── 配对信息展示 ──────────────────────────────────────
function printPairInfo() {
  // QR 编码配对码 URL,owner 首次配对扫这个
  const pairUrl = `${RELAY_URL}/v3/#pair=${relayCode}`;

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  📱 Owner 首次配对 (扫码或输入):                   ║');
  console.log('  ║                                                  ║');
  console.log(`  ║     配对码:  ${relayCode}                             ║`);
  console.log('  ║                                                  ║');
  console.log('  ║  🔐 端到端加密 (X25519 + AES-256-GCM)            ║');
  console.log('  ║  Owner 配对成功后会自动生成邀请码给其他设备       ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');

  // QR 码
  try {
    const qr = require('qrcode-terminal');
    qr.generate(pairUrl, { small: true }, (code) => {
      console.log(code);
    });
  } catch {
    console.log(`  📎 或打开: ${pairUrl}\n`);
  }
}

// ─── 本地键盘输入 ──────────────────────────────────────
function setupLocalInput() {
  if (!process.stdin.isTTY) return;

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '  > ',
  });

  rl.prompt();

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    // 内置命令
    if (text === '/quit' || text === '/exit') {
      console.log('  👋 再见');
      cleanup();
      process.exit(0);
    }
    if (text === '/status') {
      console.log(`  Session: ${sessionId || '未启动'}`);
      console.log(`  Relay: ${relayWs?.readyState === WebSocket.OPEN ? '已连接' : '未连接'}`);
      console.log(`  Peers: ${peers.size}`);
      console.log(`  Busy: ${claudeBusy}`);
      console.log(`  Queue: ${messageQueue.length}`);
      rl.prompt();
      return;
    }
    if (text === '/new') {
      sessionId = null;
      console.log('  🔄 新会话（下条消息将创建新 session）');
      rl.prompt();
      return;
    }

    // 发给 Claude
    broadcastToRemote({ type: 'local_input', text });
    sendToClaude(text);
    rl.prompt();
  });

  rl.on('close', () => {
    cleanup();
    process.exit(0);
  });
}

// ─── 清理 ──────────────────────────────────────────────
function cleanup() {
  clearInterval(pingTimer);
  if (relayWs) try { relayWs.close(); } catch {}
  if (claudeProc) try { claudeProc.kill(); } catch {}
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ─── 主流程 ────────────────────────────────────────────
async function main() {
  console.log('\n  🎙️  ccvoice v3 — 手机遥控 Claude Code\n');

  // 检查 claude 是否可用
  try {
    const { execSync } = require('child_process');
    const ver = execSync(`${CLAUDE_BIN} --version 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }).trim();
    console.log(`  ✅ Claude Code: ${ver}`);
  } catch {
    console.log('  ❌ Claude Code 未找到');
    console.log('     安装: npm install -g @anthropic-ai/claude-code\n');
    process.exit(1);
  }

  console.log(`  📂 项目目录: ${CLAUDE_CWD}`);
  console.log(`  🤖 模型: ${CLAUDE_MODEL}`);
  console.log(`  🔒 权限模式: ${PERMISSION_MODE}`);
  if (PERMISSION_MODE === 'bypassPermissions') {
    console.log('');
    console.log('  \x1b[1;31m⚠️  危险: bypassPermissions 已启用\x1b[0m');
    console.log('  \x1b[1;31m   任何配对成功的 owner 可在本机执行任意命令、读写任意文件。\x1b[0m');
    console.log('  \x1b[1;31m   仅在你完全信任配对码的传递路径时使用。\x1b[0m');
  }
  console.log('');

  // 连 relay（非阻塞）
  connectRelay();

  // 本地键盘输入（等待用户或远程输入触发 Claude）
  setupLocalInput();

  console.log('  💡 输入消息或等待手机连接...');
  console.log('     /status 查看状态  /new 新会话  /quit 退出\n');
}

main().catch((e) => {
  console.error('  ❌ 启动失败:', e.message);
  process.exit(1);
});

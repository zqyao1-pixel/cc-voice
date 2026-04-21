/**
 * ccvoice v3 — Web 前端 (E2E 加密 + 终端渲染)
 *
 * 配对 → ECDH 密钥交换 → AES-256-GCM 加密通信 → 终端事件流渲染
 */

const $ = (id) => document.getElementById(id);

// ─── E2E 加密 (Web Crypto API) ─────────────────────────
const E2E = {
  async generateKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'X25519' },
      true, // extractable
      ['deriveBits']
    );
    const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    return { keyPair, publicKeyRaw: new Uint8Array(pubRaw) };
  },

  async deriveSharedSecret(privateKey, peerPublicKeyRaw) {
    const peerPubKey = await crypto.subtle.importKey(
      'raw', peerPublicKeyRaw,
      { name: 'X25519' },
      false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: peerPubKey },
      privateKey,
      256
    );
    return new Uint8Array(bits);
  },

  async deriveAESKey(sharedSecret) {
    const hash = await crypto.subtle.digest('SHA-256', sharedSecret);
    return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  },

  async encrypt(plaintext, aesKey) {
    const encoder = new TextEncoder();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      encoder.encode(plaintext)
    );
    return {
      nonce: btoa(String.fromCharCode(...nonce)),
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    };
  },

  async decrypt(encrypted, aesKey) {
    const nonce = Uint8Array.from(atob(encrypted.nonce), c => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  },
};

// ─── 状态 ──────────────────────────────────────────────
const state = {
  ws: null,
  relayCode: null,
  relayUrl: null,
  peerId: crypto.randomUUID().slice(0, 8),
  role: 'owner',        // 从 localStorage 或配对参数决定
  keyPair: null,
  aesKey: null,          // 与 CLI 的共享密钥
  groupKey: null,        // 多人场景下的群组密钥
  connected: false,
  encrypted: false,
  claudeStatus: 'idle',  // idle | thinking | executing | done | error
  events: [],            // 终端事件历史
  participants: [],
  reconnectTimer: null,
  reconnectRetry: 0,
};

// ─── 配对 ──────────────────────────────────────────────
function initPairScreen() {
  // 检查 URL hash 或 localStorage 中的配对码
  const hash = location.hash;
  if (hash.startsWith('#pair=')) {
    const code = hash.slice(6).toUpperCase();
    $('pairInput').value = code;
    // 自动连接
    setTimeout(() => startPairing(code), 300);
  }

  const saved = localStorage.getItem('ccvoice-code');
  if (saved && !$('pairInput').value) {
    $('pairInput').value = saved;
  }

  $('pairBtn').onclick = () => startPairing($('pairInput').value.trim().toUpperCase());
  $('pairInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('pairBtn').click();
  });
  // 自动大写
  $('pairInput').addEventListener('input', () => {
    $('pairInput').value = $('pairInput').value.toUpperCase();
  });
}

async function startPairing(code) {
  if (!code || code.length < 4) {
    $('pairError').textContent = '请输入有效配对码';
    return;
  }

  $('pairBtn').disabled = true;
  $('pairBtn').textContent = '连接中...';
  $('pairError').textContent = '';

  const relayUrl = detectRelay();
  state.relayUrl = relayUrl;
  state.relayCode = code;

  try {
    // 检查房间是否存在
    const res = await fetch(`${relayUrl}/api/relay/status?code=${code}`);
    if (!res.ok) throw new Error('配对码无效或已过期');
    const data = await res.json();
    if (!data.hasUpstream) throw new Error('电脑端未连接，请先在终端运行 ccvoice');

    // 保存配对码
    localStorage.setItem('ccvoice-code', code);

    // 生成密钥对
    state.keyPair = await E2E.generateKeyPair();

    // 连接 WebSocket
    await connectRelay(code);

  } catch (e) {
    $('pairError').textContent = e.message;
    $('pairBtn').disabled = false;
    $('pairBtn').textContent = '连接';
  }
}

function detectRelay() {
  // 如果在 ccvoice.app 上访问，relay 就是自己
  if (location.hostname === 'ccvoice.app' || location.hostname.endsWith('.ccvoice.app')) {
    return location.origin;
  }
  return 'https://ccvoice.app';
}

// ─── Relay WebSocket ───────────────────────────────────
async function connectRelay(code) {
  return new Promise((resolve, reject) => {
    const wsUrl = state.relayUrl.replace(/^http/, 'ws');
    const url = `${wsUrl}/relay?code=${code}&role=downstream&peerId=${state.peerId}`;

    state.ws = new WebSocket(url);

    state.ws.onopen = () => {
      state.connected = true;
      state.reconnectRetry = 0;
      console.log('[relay] connected');

      // 发送配对握手（包含公钥）
      const pubKeyBase64 = btoa(String.fromCharCode(...state.keyPair.publicKeyRaw));
      state.ws.send(JSON.stringify({
        type: 'pair_handshake',
        publicKey: pubKeyBase64,
        peerId: state.peerId,
        role: state.role,
      }));

      resolve();
    };

    state.ws.onmessage = (e) => handleRelayMessage(e.data);

    state.ws.onclose = () => {
      state.connected = false;
      updateStatusUI();
      scheduleReconnect();
    };

    state.ws.onerror = () => {
      reject(new Error('WebSocket 连接失败'));
    };
  });
}

async function handleRelayMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  // Relay 控制消息
  if (msg.type?.startsWith('relay:')) {
    if (msg.type === 'relay:peer_connected') {
      addSystemEvent(`${msg.role} 已连接`);
      if (msg.totalDownstreams) updateParticipants();
    } else if (msg.type === 'relay:peer_disconnected') {
      addSystemEvent(`${msg.role} 已断开`);
    } else if (msg.type === 'relay:upstream_gone') {
      addSystemEvent('⚠️ 电脑端已断开，等待重连...');
      state.claudeStatus = 'idle';
      updateStatusUI();
    }
    return;
  }

  // 配对握手响应：收到 CLI 的公钥
  if (msg.type === 'pair_handshake_ack') {
    try {
      const peerPubKeyRaw = Uint8Array.from(atob(msg.publicKey), c => c.charCodeAt(0));
      const sharedSecret = await E2E.deriveSharedSecret(state.keyPair.keyPair.privateKey, peerPubKeyRaw);
      state.aesKey = await E2E.deriveAESKey(sharedSecret);
      state.encrypted = true;

      // 切换到主界面
      $('pairScreen').style.display = 'none';
      $('mainScreen').style.display = 'flex';
      updateStatusUI();
      addSystemEvent('🔐 端到端加密已建立');
      $('textInput').focus();
    } catch (e) {
      console.error('Handshake failed:', e);
      $('pairError').textContent = '加密握手失败: ' + e.message;
    }
    return;
  }

  // 群组密钥
  if (msg.type === 'group_key' && msg.peerId === state.peerId) {
    try {
      const decrypted = await E2E.decrypt(msg.payload, state.aesKey);
      const gkBytes = Uint8Array.from(atob(decrypted), c => c.charCodeAt(0));
      state.groupKey = await crypto.subtle.importKey('raw', gkBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      addSystemEvent('🔑 群组密钥已更新');
    } catch (e) {
      console.error('Group key error:', e);
    }
    return;
  }

  // 加密消息：解密后处理
  if (msg.type === 'encrypted' && msg.payload) {
    try {
      const key = state.groupKey || state.aesKey;
      if (!key) { console.warn('No decryption key'); return; }
      const decrypted = await E2E.decrypt(msg.payload, key);
      const innerMsg = JSON.parse(decrypted);
      handleDecryptedMessage(innerMsg);
    } catch (e) {
      console.error('Decrypt error:', e);
    }
    return;
  }
}

function handleDecryptedMessage(msg) {
  switch (msg.type) {
    case 'terminal_event':
      renderTerminalEvent(msg.event);
      break;
    case 'terminal_raw':
      addRawEvent(msg.data);
      break;
    case 'status':
      state.claudeStatus = msg.status;
      updateStatusUI();
      if (msg.status === 'done') scrollToBottom();
      break;
    case 'session_info':
      $('headerMeta').textContent = `${msg.model || ''} · ${shortenPath(msg.cwd || '')}`;
      break;
    case 'suggestion':
      addSuggestionEvent(msg.from, msg.text);
      break;
    case 'local_input':
      addUserEvent(`[本地] ${msg.text}`, 'local');
      break;
    case 'mode_change':
      addSystemEvent(msg.localMode ? '已切换到本地键盘模式' : '已切换到远程控制模式');
      break;
    case 'session_end':
      addSystemEvent(`Claude 会话已结束 (code: ${msg.code})`);
      state.claudeStatus = 'idle';
      updateStatusUI();
      break;
  }
}

// ─── 发送消息 ──────────────────────────────────────────
async function sendMessage(text) {
  if (!text?.trim()) return;
  text = text.trim();

  if (!state.encrypted || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addSystemEvent('❌ 未连接或未加密');
    return;
  }

  // 根据角色决定消息类型
  const msgType = state.role === 'owner' ? 'input' : 'suggestion';

  addUserEvent(text, state.role);
  $('textInput').value = '';

  try {
    const key = state.groupKey || state.aesKey;
    const payload = await E2E.encrypt(JSON.stringify({ type: msgType, text, from: state.peerId }), key);
    state.ws.send(JSON.stringify({ type: 'encrypted', payload }));
  } catch (e) {
    addSystemEvent('❌ 加密发送失败: ' + e.message);
  }
}

// ─── 终端渲染 ──────────────────────────────────────────
function renderTerminalEvent(evt) {
  if (!evt) return;

  // system init
  if (evt.type === 'system' && evt.subtype === 'init') {
    addSystemEvent(`Session: ${evt.session_id || 'started'}`);
    return;
  }

  // 文本增量 (assistant message content)
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text) {
        appendToLastAssistant(block.text);
      }
      if (block.type === 'tool_use') {
        addToolEvent(block.name, block.input);
      }
    }
    return;
  }

  // stream delta
  if (evt.type === 'content_block_delta' || (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta')) {
    const delta = evt.delta || evt.event?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      appendToLastAssistant(delta.text);
    }
    return;
  }

  // result
  if (evt.type === 'result') {
    if (evt.is_error) {
      addErrorEvent(evt.error || 'Unknown error');
    }
    // 结束当前 assistant 块
    finalizeAssistant();
    return;
  }

  // tool result
  if (evt.type === 'tool_result' || (evt.type === 'stream_event' && evt.event?.type === 'tool_result')) {
    // 工具执行结果
    return;
  }
}

// 终端 DOM 操作
let currentAssistantEl = null;

function addUserEvent(text, role) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = `terminal-event user`;
  el.textContent = `${role === 'local' ? '⌨️' : '📱'} > ${text}`;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function appendToLastAssistant(text) {
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'terminal-event assistant';
    $('terminal').appendChild(currentAssistantEl);
  }
  currentAssistantEl.textContent += text;
  scrollToBottom();
}

function finalizeAssistant() {
  currentAssistantEl = null;
}

function addToolEvent(name, input) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = 'terminal-event tool';
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input || {}).substring(0, 100);
  el.textContent = `🔧 ${name}(${inputStr})`;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function addSystemEvent(text) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = 'terminal-event system';
  el.textContent = text;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function addErrorEvent(text) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = 'terminal-event error';
  el.textContent = `❌ ${text}`;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function addRawEvent(text) {
  const el = document.createElement('div');
  el.className = 'terminal-event system';
  el.textContent = text;
  $('terminal').appendChild(el);
  scrollToBottom();
}

function addSuggestionEvent(from, text) {
  finalizeAssistant();
  const el = document.createElement('div');
  el.className = 'terminal-event suggestion';
  el.innerHTML = `💡 <strong>${from || 'observer'}</strong>: ${escapeHtml(text)}`;
  // TODO: Owner 点击可批准执行
  $('terminal').appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const t = $('terminal');
    t.scrollTop = t.scrollHeight;
  });
}

// ─── UI 状态 ───────────────────────────────────────────
function updateStatusUI() {
  const dot = $('statusDot');
  const meta = $('headerMeta');

  dot.className = 'status-dot';
  if (!state.connected) {
    dot.classList.add('disconnected');
  } else if (state.claudeStatus === 'thinking' || state.claudeStatus === 'executing') {
    dot.classList.add('thinking');
  } else if (state.encrypted) {
    dot.classList.add('encrypted');
  } else {
    dot.classList.add('connected');
  }

  // 状态文字
  const statusText = {
    idle: '就绪',
    thinking: 'Claude 思考中...',
    executing: '执行中...',
    done: '完成',
    error: '出错',
    queued: '排队中...',
  }[state.claudeStatus] || '';

  if (statusText && state.claudeStatus !== 'idle') {
    const existing = meta.textContent;
    if (!existing.includes('·')) {
      meta.textContent = statusText;
    } else {
      meta.textContent = existing.split('·')[0].trim() + ' · ' + statusText;
    }
  }
}

function updateParticipants() {
  // 简化实现：显示在线数
  // 完整实现需要 relay 返回参与者列表
}

// ─── 重连 ──────────────────────────────────────────────
function scheduleReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectRetry++;
  const delay = Math.min(state.reconnectRetry * 2000, 15000);
  console.log(`[reconnect] ${delay/1000}s (attempt ${state.reconnectRetry})`);
  state.reconnectTimer = setTimeout(async () => {
    if (!state.relayCode) return;
    try {
      await connectRelay(state.relayCode);
      // 重连后重发握手
      if (state.keyPair) {
        const pubKeyBase64 = btoa(String.fromCharCode(...state.keyPair.publicKeyRaw));
        state.ws.send(JSON.stringify({
          type: 'pair_handshake',
          publicKey: pubKeyBase64,
          peerId: state.peerId,
          role: state.role,
        }));
      }
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

// ─── 语音 ──────────────────────────────────────────────
function setupVoice() {
  const btn = $('voiceBtn');
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    btn.textContent = '🎤 语音不可用';
    btn.disabled = true;
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'zh-CN';
  let isListening = false;
  let finalTranscript = '';

  btn.addEventListener('touchstart', (e) => { e.preventDefault(); startListening(); });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); stopListening(); });
  btn.addEventListener('mousedown', () => startListening());
  btn.addEventListener('mouseup', () => stopListening());

  function startListening() {
    if (isListening) return;
    isListening = true;
    finalTranscript = '';
    btn.classList.add('listening');
    btn.textContent = '🎤 正在听...';
    try { recognition.start(); } catch {}
  }

  function stopListening() {
    if (!isListening) return;
    isListening = false;
    btn.classList.remove('listening');
    btn.textContent = '🎤 按住说话';
    try { recognition.stop(); } catch {}
    if (finalTranscript.trim()) {
      sendMessage(finalTranscript.trim());
    }
  }

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    // 实时显示
    btn.textContent = `🎤 ${finalTranscript}${interim}`;
  };

  recognition.onerror = () => {
    isListening = false;
    btn.classList.remove('listening');
    btn.textContent = '🎤 按住说话';
  };
}

// ─── 工具函数 ──────────────────────────────────────────
function shortenPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-2).join('/');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── 初始化 ────────────────────────────────────────────
function init() {
  initPairScreen();
  setupVoice();

  // 文本输入
  $('textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage($('textInput').value);
    }
  });
  $('sendBtn').addEventListener('click', () => sendMessage($('textInput').value));

  // 新会话
  $('newSessionBtn').addEventListener('click', () => {
    if (confirm('开始新会话？（当前对话上下文将清除）')) {
      sendMessage('/new');
      $('terminal').innerHTML = '';
      addSystemEvent('🔄 新会话已开始');
    }
  });

  // 断开
  $('disconnectBtn').addEventListener('click', () => {
    if (state.ws) state.ws.close();
    state.encrypted = false;
    state.aesKey = null;
    state.groupKey = null;
    $('mainScreen').style.display = 'none';
    $('pairScreen').style.display = 'flex';
    $('pairBtn').disabled = false;
    $('pairBtn').textContent = '连接';
  });
}

// 检查 X25519 支持
(async () => {
  try {
    await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    init();
  } catch {
    // X25519 不被支持，降级提示
    $('pairError').textContent = '你的浏览器不支持 X25519 加密，请使用 Chrome 113+ 或 Safari 17+';
    $('pairBtn').disabled = true;
  }
})();

/**
 * CC Voice Relay — Cloudflare Worker + Durable Object
 *
 * 公共中继服务：本地 cc-voice 实例通过 WebSocket 上连，
 * 手机通过配对码接入，所有消息双向透传。
 *
 * 路由：
 *   POST /api/relay/create    → 创建配对房间，返回 code
 *   GET  /relay?code=X&role=Y → WebSocket 升级，加入房间
 *   其他                       → 静态文件（手机 UI）
 */

import { DurableObject } from 'cloudflare:workers';

// ─── 配对码生成 ─────────────────────────────────────────
// 排除易混淆字符: 0/O, 1/I/L
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

function generateCode() {
  const arr = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// ─── Durable Object: RelayRoom ──────────────────────────
// 每个配对码对应一个 RelayRoom 实例
// 管理 upstream（本地 cc-voice）和 downstream（手机）的 WebSocket 桥接
export class RelayRoom extends DurableObject {

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      // 非 WS 请求：返回房间状态
      const upstreams = this.ctx.getWebSockets('upstream');
      return Response.json({
        hasUpstream: upstreams.length > 0,
        downstreams: this.ctx.getWebSockets('downstream').length,
      });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get('role');

    if (!['upstream', 'downstream'].includes(role)) {
      return new Response('Invalid role: must be upstream or downstream', { status: 400 });
    }

    // 限制：只允许 1 个 upstream
    if (role === 'upstream') {
      const existing = this.ctx.getWebSockets('upstream');
      if (existing.length > 0) {
        return new Response('Upstream already connected', { status: 409 });
      }
    }

    // 限制：downstream 需要有 upstream 才能连
    if (role === 'downstream') {
      const upstreams = this.ctx.getWebSockets('upstream');
      if (upstreams.length === 0) {
        return new Response('No upstream available — invalid or expired code', { status: 404 });
      }
    }

    // 创建 WebSocket 对
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 用 Hibernation API 接受连接，tag 标识角色
    this.ctx.acceptWebSocket(server, [role]);

    // 通知对端有新连接
    const otherRole = role === 'upstream' ? 'downstream' : 'upstream';
    for (const ws of this.ctx.getWebSockets(otherRole)) {
      ws.send(JSON.stringify({ type: 'relay:peer_connected', role }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── 消息转发：纯透传，不解析内容 ─────────────────────
  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags(ws);
    if (!tags || tags.length === 0) return;

    const senderRole = tags[0];
    const targetRole = senderRole === 'upstream' ? 'downstream' : 'upstream';

    for (const target of this.ctx.getWebSockets(targetRole)) {
      try {
        target.send(message);
      } catch (e) {
        // 发送失败，跳过
        console.error('Forward error:', e);
      }
    }
  }

  // ─── 连接关闭：通知对端 ────────────────────────────────
  async webSocketClose(ws, code, reason, wasClean) {
    const tags = this.ctx.getTags(ws);
    if (!tags || tags.length === 0) return;

    const senderRole = tags[0];
    const targetRole = senderRole === 'upstream' ? 'downstream' : 'upstream';

    for (const target of this.ctx.getWebSockets(targetRole)) {
      try {
        target.send(JSON.stringify({
          type: 'relay:peer_disconnected',
          role: senderRole,
        }));
      } catch (e) { /* ignore */ }
    }

    // 如果 upstream 断开，也关闭所有 downstream
    if (senderRole === 'upstream') {
      for (const target of this.ctx.getWebSockets('downstream')) {
        try { target.close(1001, 'Upstream disconnected'); } catch (e) { /* ignore */ }
      }
    }
  }

  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
    try { ws.close(1011, 'WebSocket error'); } catch (e) { /* ignore */ }
  }
}

// ─── Worker 入口 ────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for API calls
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ─── API: 创建配对房间 ──────────────────────────────
    if (url.pathname === '/api/relay/create' && request.method === 'POST') {
      const code = generateCode();
      return Response.json(
        { code, relay: `wss://${url.host}/relay` },
        { headers: corsHeaders },
      );
    }

    // ─── API: 检查房间状态 ──────────────────────────────
    if (url.pathname === '/api/relay/status' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) {
        return Response.json({ error: 'Missing code' }, { status: 400, headers: corsHeaders });
      }

      const id = env.RELAY_ROOM.idFromName(code.toUpperCase());
      const room = env.RELAY_ROOM.get(id);
      const status = await room.fetch(new Request('https://internal/status'));
      const data = await status.json();
      return Response.json(
        { code: code.toUpperCase(), ...data },
        { headers: corsHeaders },
      );
    }

    // ─── WebSocket: 加入配对房间 ─────────────────────────
    if (url.pathname === '/relay') {
      const code = url.searchParams.get('code');
      const role = url.searchParams.get('role');

      if (!code || !role) {
        return new Response('Missing code or role', { status: 400 });
      }

      if (!['upstream', 'downstream'].includes(role)) {
        return new Response('role must be upstream or downstream', { status: 400 });
      }

      const id = env.RELAY_ROOM.idFromName(code.toUpperCase());
      const room = env.RELAY_ROOM.get(id);
      return room.fetch(request);
    }

    // ─── 静态文件：由 [assets] 自动处理 ──────────────────
    // 如果配置了 [assets]，未匹配的路径走这里
    // 对于 SPA，fallback 到 index.html
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

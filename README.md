# ccvoice

手机遥控你的 Claude Code — 端到端加密，零知识中继。

Remote control Claude Code from your phone with E2E encryption.

## 快速开始

```bash
# 安装
npm install -g ccvoice

# 启动（自动生成配对码 + QR 码）
ccvoice
```

手机扫码或访问 [ccvoice.app](https://ccvoice.app)，输入配对码即可连接。

## 工作原理

```
手机浏览器 (ccvoice.app)                    你的 Mac/PC
  ├── 输入配对码                              ├── ccvoice CLI
  ├── X25519 密钥交换 ──────┐    ┌──────── X25519 密钥交换
  ├── 语音/文字输入           │    │          ├── 管理 Claude Code 会话
  └── 终端事件流渲染          │    │          └── --resume 上下文连续
                              ↓    ↓
                    Cloudflare Relay (零知识)
                      只转发加密 blob，不解密
```

### 安全模型

- **X25519 ECDH** 密钥交换：配对时手机和 CLI 各生成密钥对，通过 relay 交换公钥
- **AES-256-GCM** 加密所有消息：relay 只看到密文，无法读取内容
- **零知识中继**：Cloudflare Worker 只做消息路由，不存储、不解析

## 功能

- **语音控制**：按住说话，Web Speech API 转文字后加密发送
- **终端流式渲染**：Claude Code 的思考、工具调用、输出实时展示
- **上下文连续**：`--resume` 自动追踪 session，不丢失对话上下文
- **多设备**：多台手机可同时连接（Owner + Observer 模式）
- **Mac 睡眠恢复**：CLI 断线后手机自动重连，无需重新配对

## CLI 参数

```
ccvoice [选项]

选项:
  --relay URL       自定义 relay 地址（默认 https://ccvoice.app）
  --model MODEL     Claude 模型（默认跟随 claude 设置）
  --cwd DIR         Claude 工作目录（默认当前目录）
```

环境变量: `RELAY_URL`, `CLAUDE_MODEL`, `CLAUDE_CWD`

## 自托管 Relay

Relay 是一个 Cloudflare Worker，可以自部署：

```bash
cd relay
npm install
npx wrangler deploy
```

然后 CLI 指定你的 relay：

```bash
ccvoice --relay https://your-worker.your-account.workers.dev
```

## 技术栈

- CLI: Node.js + `node:crypto` (X25519 + AES-256-GCM)
- 前端: Vanilla JS + Web Crypto API
- Relay: Cloudflare Workers + Durable Objects
- 语音: Web Speech API
- 协议: WebSocket + JSON (加密层)

## 依赖

运行时仅需 2 个依赖：

- `ws` — WebSocket 客户端
- `qrcode-terminal` — 终端 QR 码显示

## License

MIT

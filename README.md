# CC Voice

语音控制 Claude Code + 好友 IM — 从手机远程操控 Claude Code 编程，同时和好友实时聊天，@Claude 随时唤起 AI 助手。

## 架构

```
iPhone / 手机浏览器 (PWA)
  ├── 登录 → 昵称注册，Token 认证
  ├── 按住麦克风 → Web Speech API 语音转文字
  ├── 文字输入框（支持 @Claude 唤起 AI）
  └── WebSocket 双向通信（实时消息推送）
        ↕  (Cloudflare Tunnel / HTTPS)
Node.js 服务端 (端口 3456)
  ├── Express REST API + 静态文件
  ├── SQLite 持久化（用户/好友/会话/消息）
  ├── WebSocket 服务端（多用户在线状态）
  └── 桥接层 → cc-connect
        ↕
cc-connect → Claude Code CLI → 执行任务
```

## 快速开始

### 方式 A：Cloudflare Tunnel（推荐，无需同一 WiFi）

```bash
# 1. 安装依赖
cd cc-voice
npm install

# 2. 启动服务
npm start

# 3. 另一个终端，启动隧道（自动分配公网 HTTPS 地址）
chmod +x start-tunnel.sh
./start-tunnel.sh

# 4. 手机 Safari 打开隧道分配的 https://xxx.trycloudflare.com 地址
```

### 方式 B：局域网 HTTPS（需同一 WiFi + 证书信任）

```bash
# 1. 安装依赖
npm install

# 2. 配置 HTTPS 证书
chmod +x setup-https.sh
./setup-https.sh

# 3. 启动
npm start

# 4. iPhone Safari → https://<局域网IP>:3456
#    首次需信任 CA 证书（访问 https://<IP>:3456/ca.pem 下载安装）
```

## 接入真实 Claude Code

安装 cc-connect 后：

```bash
# 安装
npm install -g cc-connect

# 启动 cc-connect
cc-connect

# 启动 CC Voice（CLI 桥接模式）
BRIDGE_MODE=cli npm start

# 或使用 Management API 模式
BRIDGE_MODE=management-api CC_API_BASE=http://localhost:8080 npm start
```

## 功能

**用户系统**
- 昵称注册，Token 认证（自动持久化）
- 每人唯一邀请码，好友通过邀请码互加

**IM 聊天**
- 1v1 私聊（DM）、群聊、AI 对话三种会话类型
- @Claude 或 @claude 在任何会话中唤起 AI 助手
- 实时消息推送（WebSocket 多端同步）
- 消息搜索、收藏（星标）

**语音控制**
- 按住说话（Web Speech API 语音转文字）
- 文字输入（Enter 发送）
- 流式显示 Claude Code 执行结果

**PWA 体验**
- 添加到主屏幕，类原生体验
- 新消息 Notification 推送
- 深色主题，iOS Safe Area 适配
- 中英双语切换

**外网穿透**
- Cloudflare Tunnel 一键启动（`start-tunnel.sh`）
- 免费随机子域名，自带 HTTPS
- 无需域名、无需 Cloudflare 账号

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3456` | 服务端口 |
| `BRIDGE_MODE` | `mock` | 桥接模式: `mock` / `cli` / `management-api` |
| `CC_PROJECT` | `main` | cc-connect 项目名 |
| `CC_API_BASE` | `http://localhost:8080` | Management API 地址 |

## 项目结构

```
cc-voice/
├── server.js          # 后端：Express + WebSocket + SQLite + 用户系统 + 桥接
├── public/
│   ├── index.html     # PWA 入口（登录 + 主界面）
│   ├── app.js         # 前端逻辑 (vanilla JS, 用户/好友/IM/语音)
│   ├── style.css      # 样式（深色主题）
│   ├── manifest.json  # PWA manifest
│   ├── sw.js          # Service Worker
│   └── icons/         # PWA 图标
├── start-tunnel.sh    # Cloudflare Tunnel 一键启动
├── setup-https.sh     # 局域网 HTTPS 证书配置
├── package.json
├── LICENSE            # MIT
└── README.md
```

## 数据存储

SQLite 数据库保存在 `data/cc-voice.db`（已 gitignore），包含：

- `users` — 用户信息、Token、邀请码
- `friends` — 好友关系（双向）
- `conversations` — 会话（ai / dm / group）
- `conv_members` — 会话成员
- `messages` — 消息记录（含发送者、星标状态）

## 技术栈

- 后端: Node.js + Express + ws + better-sqlite3
- 前端: Vanilla JS (零依赖)
- 语音: Web Speech API (webkitSpeechRecognition)
- 通信: WebSocket (实时) + REST API
- 存储: SQLite (WAL mode)
- 桥接: cc-connect (CLI / Management API)
- 穿透: Cloudflare Tunnel (trycloudflare.com)

## License

MIT

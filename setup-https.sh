#!/bin/bash
# CC Voice — HTTPS 自签证书配置脚本
# 使用 mkcert 生成本地受信任的证书

set -e

echo "🔒 配置 CC Voice HTTPS..."

# 检查 mkcert 是否安装
if ! command -v mkcert &> /dev/null; then
  echo "⚠️  mkcert 未安装，正在通过 Homebrew 安装..."
  brew install mkcert
fi

# 安装本地 CA（首次运行需要）
echo "📌 安装本地 CA 根证书..."
mkcert -install

# 创建证书目录
mkdir -p certs

# 获取本机局域网 IP
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "")
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP=$(ipconfig getifaddr en1 2>/dev/null || echo "192.168.1.100")
fi

echo "📡 检测到局域网 IP: $LOCAL_IP"

# 生成证书（覆盖 localhost + 局域网 IP）
echo "🔑 生成证书..."
mkcert -cert-file certs/server.pem -key-file certs/server-key.pem \
  localhost 127.0.0.1 ::1 "$LOCAL_IP"

echo ""
echo "✅ HTTPS 证书配置完成！"
echo ""
echo "📱 iPhone 信任设置："
echo "   1. 用 Safari 访问 https://$LOCAL_IP:3456"
echo "   2. 如果提示不安全，需要将 CA 证书安装到 iPhone："
echo "      a. 在 Mac 上运行: mkcert -CAROOT"
echo "      b. 将该目录下的 rootCA.pem 通过 AirDrop 发送到 iPhone"
echo "      c. iPhone: 设置 → 通用 → VPN与设备管理 → 安装证书"
echo "      d. iPhone: 设置 → 通用 → 关于本机 → 证书信任设置 → 开启"
echo ""
echo "🚀 启动服务: npm start"

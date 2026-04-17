/**
 * 生成 PWA 图标 (SVG → PNG via Canvas)
 * 运行: node scripts/gen-icons.js
 * 依赖: 无 (使用 Node canvas 或直接生成 SVG)
 */

const fs = require('fs');
const path = require('path');

// SVG 图标模板 — 麦克风 + 紫色渐变背景
function createIconSVG(size) {
  const micScale = size / 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="108" fill="url(#bg)"/>
  <g transform="translate(256,256) scale(5)" stroke="white" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M0 -23a3 3 0 0 0-3 3v16a3 3 0 0 0 6 0v-16a3 3 0 0 0-3-3z" fill="rgba(255,255,255,0.2)"/>
    <path d="M7 -2v2a7 7 0 0 1-14 0v-2"/>
    <line x1="0" y1="7" x2="0" y2="11"/>
    <line x1="-4" y1="11" x2="4" y2="11"/>
  </g>
</svg>`;
}

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

// 写 SVG 文件 (浏览器可以直接用，也可以后续转 PNG)
for (const size of [192, 512]) {
  const svg = createIconSVG(size);
  fs.writeFileSync(path.join(iconsDir, `icon-${size}.svg`), svg);
  console.log(`✅ Generated icon-${size}.svg`);
}

// 同时生成一个通用 favicon SVG
fs.writeFileSync(path.join(iconsDir, '..', 'favicon.svg'), createIconSVG(32));
console.log('✅ Generated favicon.svg');

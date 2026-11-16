'use strict';

/**
 * Tạo 2 ảnh chụp MẪU (không cần server thật) để kiểm tra bộ render:
 *   - samples/sample-3d.png    : chế độ thế giới 3D isometric
 *   - samples/sample-chat.png  : chế độ khung chat (fallback)
 * Chạy: npm run sample
 */

const fs = require('fs');
const path = require('path');
const { takeScreenshot } = require('../src/screenshot');
const { render3dScreenshot } = require('../src/screenshot/render3d');

const SAMPLE_DIR = path.join(__dirname, '..', 'samples');

/** Dựng địa hình giả lập: đồi thoải + hồ nước + vài cây + khối xây dựng */
function fakeWorld() {
  const blocks = [];
  const R = 26;
  const height = (x, z) => 64 + Math.round(2.4 * Math.sin(x * 0.22) + 2.1 * Math.cos(z * 0.19) + 1.2 * Math.sin((x + z) * 0.1));

  for (let x = -R; x <= R; x++) {
    for (let z = -R; z <= R; z++) {
      const h = height(x, z);
      const isPond = x > 6 && x < 18 && z > -14 && z < -2 && h <= 64; // vùng trũng thành hồ
      for (let y = h - 9; y <= h; y++) {
        let name = 'minecraft:stone';
        if (y === h) name = isPond ? 'minecraft:sand' : 'minecraft:grass_block';
        else if (y === h - 1) name = 'minecraft:dirt';
        blocks.push({ x, y, z, name });
      }
      if (isPond) {
        for (let y = h; y <= 64; y++) blocks.push({ x, y, z, name: 'minecraft:water' });
      }
    }
  }

  // Vài cây sồi
  for (const [tx, tz] of [[-10, 6], [-13, 2], [14, 10], [18, 4]]) {
    const h = height(tx, tz);
    for (let y = h + 1; y <= h + 4; y++) blocks.push({ x: tx, y, z: tz, name: 'minecraft:oak_log' });
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dy = 3; dy <= 5; dy++) {
          if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy - 4) > 4) continue;
          const y = h + dy;
          if (dx === 0 && dz === 0 && dy <= 4) continue;
          blocks.push({ x: tx + dx, y, z: tz + dz, name: 'minecraft:oak_leaves' });
        }
  }

  // Nhà nhỏ bằng gạch + kính để thấy khối "xây"
  const h0 = height(-4, -6);
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++)
      for (let dy = 1; dy <= 3; dy++) {
        const x = -4 + dx;
        const z = -6 + dz;
        const y = h0 + dy;
        const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
        if (!edge) continue;
        blocks.push({ x, y, z, name: dy === 3 ? 'minecraft:oak_planks' : dx === 0 ? 'minecraft:glass' : 'minecraft:bricks' });
      }

  return { center: { x: 0.5, y: 66, z: 0.5 }, blocks };
}

const SAMPLE_LINES = [
  { kind: 'chat', text: 'Steve_2005: ai cần mua Timely kiếm không' },
  { kind: 'chat', text: 'MarketBot: [SHOP] Diamond Block 64x đang bán 12B' },
  { kind: 'cmd', text: '/pay .steve 1500000000' },
  { kind: 'ok', text: 'Đã trả 1,500,000,000 cho .steve. Số dư còn: 2,500,000,000' },
  { kind: 'chat', text: '.steve: cảm ơn nha ^^' },
];

async function main() {
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  const meta = {
    server: 'play.example.net:19132',
    version: '1.26.60',
    botName: 'PayBot',
  };

  // --- Ảnh chế độ khung chat (fallback) ---
  const chat = await takeScreenshot({ lines: SAMPLE_LINES, meta, world: null, render3dEnabled: true });
  fs.writeFileSync(path.join(SAMPLE_DIR, 'sample-chat.png'), chat.buffer);
  console.log(`✓ Đã tạo samples/sample-chat.png (${chat.mode}, ${(chat.buffer.length / 1024).toFixed(0)} KB)`);

  // --- Ảnh chế độ 3D (đứng bên bờ nhìn ra hồ + nhà + cây) ---
  const world = fakeWorld();
  world.center = { x: 24.5, y: 63.0, z: -19.5 }; // chân đứng trên bờ đất (block cao nhất y=62)
  console.log(`Địa hình giả lập: ${world.blocks.length} khối`);
  const shot3d = await render3dScreenshot({ world, lines: SAMPLE_LINES, meta, camera: { yaw: -40, pitch: -6 } });
  fs.writeFileSync(path.join(SAMPLE_DIR, 'sample-3d.png'), shot3d);
  console.log(`✓ Đã tạo samples/sample-3d.png (${(shot3d.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error('✗ Tạo ảnh mẫu thất bại:', err);
  process.exit(1);
});

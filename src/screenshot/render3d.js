'use strict';

/**
 * ============================================================
 *  render3d.js — Ảnh chụp "thế giới 3D" GÓC NHÌN THỨ NHẤT (kiểu F2)
 * ============================================================
 *  Khác bản cũ (isometric nghiêng 45°), bản này dựng lại khung cảnh
 *  Y NHƯ BOT NHÌN THẤY khi đứng trong game — đúng như ảnh F2 chụp bằng
 *  nút F2 trong Minecraft PC:
 *   - Raycast 3D (thuật toán DDA Amanatides–Woo) từng pixel từ MẮT bot
 *     (cao cách chân 1.62 block), FOV ngang 70° mặc định của Minecraft.
 *   - Tô sáng theo mặt khối như game: mặt trên 100%, bắc/nam 80%,
 *     đông/tây 62%, đáy 50% + "hạt" nhiễu giả texture từng block.
 *   - Bầu trời gradient + MẶT TRỜI VUÔNG + mây phẳng kiểu Minecraft,
 *     sương mù mờ dần theo khoảng cách (render distance ngắn).
 *   - Render nội bộ 640x360 rồi phóng ×2 không nội suy -> nét kiểu pixel game.
 *
 *  Không cần WebGL/GPU — chạy được trên mọi VPS headless.
 *  Nếu không có dữ liệu chunk sẽ ném lỗi để tầng trên fallback sang khung chat.
 */

const { createCanvas, ImageData } = require('@napi-rs/canvas');
const { drawHud } = require('./hud');

/* ------------------------------------------------------------------ */
/*  Bảng màu block (giữ nguyên từ bản isometric)                       */
/* ------------------------------------------------------------------ */

const BLOCK_COLORS = {
  grass_block: [96, 150, 60],
  dirt: [134, 96, 67],
  coarse_dirt: [118, 85, 60],
  rooted_dirt: [142, 106, 76],
  mud: [60, 57, 54],
  stone: [125, 125, 125],
  deepslate: [78, 83, 86],
  cobblestone: [110, 110, 110],
  cobbled_deepslate: [92, 96, 99],
  bedrock: [58, 58, 58],
  sand: [219, 207, 163],
  red_sand: [190, 105, 46],
  gravel: [131, 127, 126],
  clay: [160, 166, 179],
  snow: [242, 248, 250],
  ice: [145, 189, 236],
  packed_ice: [141, 180, 231],
  water: [53, 93, 196],
  lava: [232, 121, 34],
  obsidian: [21, 18, 31],
  netherrack: [97, 38, 38],
  end_stone: [219, 222, 158],
  oak_log: [109, 85, 50],
  spruce_log: [58, 37, 16],
  birch_log: [215, 201, 142],
  oak_planks: [162, 130, 78],
  oak_leaves: [55, 116, 35],
  spruce_leaves: [42, 74, 40],
  birch_leaves: [97, 129, 60],
  sandstone: [216, 203, 155],
  terracotta: [152, 94, 67],
  quartz_block: [236, 233, 226],
  glass: [200, 220, 235],
  glowstone: [249, 212, 132],
  iron_ore: [136, 136, 136],
  gold_ore: [140, 128, 100],
  gold_block: [247, 213, 73],
  diamond_ore: [116, 141, 141],
  diamond_block: [93, 236, 229],
  emerald_block: [42, 203, 87],
  coal_ore: [99, 99, 99],
  copper_ore: [164, 118, 84],
  redstone_ore: [136, 90, 90],
  lapis_ore: [96, 118, 158],
  netherite_block: [44, 40, 43],
  bricks: [151, 97, 83],
  bookshelf: [154, 124, 74],
  crafting_table: [140, 108, 60],
  furnace: [110, 110, 110],
  tnt: [190, 68, 51],
  pumpkin: [197, 118, 26],
  hay_block: [199, 158, 56],
  moss_block: [89, 109, 46],
  mycelium: [111, 98, 98],
  podzol: [91, 63, 29],
};

const BLOCK_RULES = [
  [/water|bubble_column|kelp|seagrass/, [53, 93, 196], 0.24],
  [/ice|frosted/, [145, 189, 236], 0.3],
  [/lava/, [232, 121, 34], 0],
  [/leaves|azalea|mangrove/, [62, 118, 42], 0],
  [/_log|_stem|wood/, [110, 86, 52], 0],
  [/planks|_door|fence|stairs|slab|button|pressure_plate|trapdoor/, [160, 130, 80], 0],
  [/grass|fern|bush|crop|wheat|flower|sapling|vine|sugar/, [90, 140, 58], 0],
  [/sand/, [219, 207, 163], 0],
  [/snow/, [240, 247, 250], 0],
  [/wool|carpet|bed/, [222, 222, 222], 0],
  [/concrete_powder/, [190, 180, 170], 0],
  [/concrete|shulker/, [150, 150, 155], 0],
  [/terracotta/, [152, 94, 67], 0],
  [/glass|pane/, [198, 220, 235], 0.42],
  [/deepslate|blackstone|basalt/, [82, 86, 89], 0],
  [/nether|crimson|warped/, [92, 45, 55], 0],
  [/end|purpur/, [200, 180, 200], 0],
  [/copper/, [176, 112, 72], 0],
  [/gold/, [240, 205, 90], 0],
  [/iron/, [205, 205, 205], 0],
  [/coal/, [75, 75, 75], 0],
  [/ore/, [120, 120, 120], 0],
  [/brick/, [150, 98, 84], 0],
  [/quartz/, [235, 232, 226], 0],
  [/coral/, [225, 120, 130], 0],
  [/stone|granite|diorite|andesite|tuff|slate/, [126, 126, 126], 0],
];

const colorCache = new Map();

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const r = 110 + (h % 120);
  const g = 110 + ((h >> 5) % 120);
  const b = 110 + ((h >> 10) % 120);
  return [r, g, b];
}

/** {rgb, blend} — blend: tỉ lệ pha với màu trời (0 = đục hoàn toàn) */
function colorFor(name) {
  let cached = colorCache.get(name);
  if (cached) return cached;

  const key = name.replace(/^minecraft:/, '');
  let rgb = BLOCK_COLORS[key] ?? null;
  let blend = 0;

  if (!rgb) {
    for (const [pattern, color, b] of BLOCK_RULES) {
      if (pattern.test(key)) {
        rgb = color;
        blend = b;
        break;
      }
    }
  }
  if (!rgb) rgb = hashColor(key);

  cached = { rgb, blend };
  colorCache.set(name, cached);
  return cached;
}

/** Hash ổn định theo toạ độ block — tạo "hạt" nhiễu giả texture */
function hash3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) >>> 0;
  h = (h ^ (h >> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

/* ------------------------------------------------------------------ */
/*  Dựng lưới voxel (typed array) từ dữ liệu chunk                     */
/* ------------------------------------------------------------------ */

/**
 * @returns {{grid: Uint32Array, W: number, H: number, D: number, x0: number, y0: number, z0: number}}
 *  Mỗi cell: (r<<24)|(g<<16)|(b<<8)|blend(0..200). Cell 0 = không khí.
 */
function buildGrid(blocks, center, radius) {
  const cx = Math.floor(center.x);
  const cy = Math.floor(center.y);
  const cz = Math.floor(center.z);
  const R = Math.min(radius, 33);
  const x0 = cx - R, z0 = cz - R, y0 = Math.max(cy - 18, -64);
  const W = 2 * R + 1, D = 2 * R + 1, H = 45; // y0 .. y0+44 (cy-18 .. cy+26)
  const grid = new Uint32Array(W * H * D);

  for (const b of blocks) {
    const gx = b.x - x0;
    const gz = b.z - z0;
    const gy = b.y - y0;
    if (gx < 0 || gx >= W || gz < 0 || gz >= D || gy < 0 || gy >= H) continue;
    const { rgb, blend } = colorFor(b.name);
    grid[gx + gz * W + gy * W * D] = (rgb[0] << 24) | (rgb[1] << 16) | (rgb[2] << 8) | Math.round(blend * 200);
  }
  return { grid, W, H, D, x0, y0, z0 };
}

/* ------------------------------------------------------------------ */
/*  Trời / mây / mặt trời                                              */
/* ------------------------------------------------------------------ */

function skyColor(dirY, dir) {
  // Gradient bầu trời: chân trời sáng -> thiên đỉnh đậm (màu Minecraft)
  const horizon = [200, 220, 248];
  const zenith = [110, 156, 251];
  const t = dirY <= 0 ? 0 : Math.pow(dirY, 0.55);
  let r = horizon[0] + (zenith[0] - horizon[0]) * t;
  let g = horizon[1] + (zenith[1] - horizon[1]) * t;
  let b = horizon[2] + (zenith[2] - horizon[2]) * t;

  // Dưới chân trời (ngoài tầm sương) — xám xanh nhạt dần xuống
  if (dirY < 0) {
    const k = Math.min(1, -dirY * 2.2);
    r = 200 - 30 * k; g = 220 - 30 * k; b = 248 - 20 * k;
  }
  return [r, g, b];
}

/**
 * Phủ mặt trời vuông + mây phẳng Minecraft lên màu trời.
 * @param {[number,number,number]} dir  Hướng ray đã chuẩn hoá
 * @param {[number,number,number]} eye  Vị trí mắt
 * @param {number} cloudY  Độ cao lớp mây
 * @param {object} sun     { dir:[x,y,z], right:[x,y,z], up:[x,y,z] }
 */
function applySunClouds(rgb, dir, eye, cloudY, sun) {
  const [dx, dy, dz] = dir;
  const sd = sun.dir;
  const cosA = dx * sd[0] + dy * sd[1] + dz * sd[2];
  if (cosA > 0.965) {
    // Toạ độ trong mặt phẳng vuông góc hướng mặt trời -> hình VUÔNG như MC
    const sx = (dx * sun.right[0] + dy * sun.right[1] + dz * sun.right[2]) / cosA;
    const sy = (dx * sun.up[0] + dy * sun.up[1] + dz * sun.up[2]) / cosA;
    if (Math.abs(sx) < 0.045 && Math.abs(sy) < 0.045) return [255, 250, 220];
    if (Math.abs(sx) < 0.075 && Math.abs(sy) < 0.075) {
      return [rgb[0] + (255 - rgb[0]) * 0.55, rgb[1] + (250 - rgb[1]) * 0.55, rgb[2] + (215 - rgb[2]) * 0.55];
    }
  }

  // Mây phẳng y = cloudY: chia lưới 12x12 block, ô chọn theo hash (đậm nhạt như MC)
  if (dy > 0.008) {
    const t = (cloudY - eye[1]) / dy;
    if (t > 0 && t < 700) {
      const cxp = eye[0] + dx * t;
      const czp = eye[2] + dz * t;
      const cellX = Math.floor(cxp / 12);
      const cellZ = Math.floor(czp / 12);
      if (hash3(cellX, 7, cellZ) < 0.42) {
        const fade = Math.max(0, 1 - t / 700);
        const a = 0.85 * fade;
        return [rgb[0] + (255 - rgb[0]) * a, rgb[1] + (255 - rgb[1]) * a, rgb[2] + (255 - rgb[2]) * a];
      }
    }
  }
  return rgb;
}

/* ------------------------------------------------------------------ */
/*  Render chính                                                        */
/* ------------------------------------------------------------------ */

const FOG_COLOR = [204, 224, 248];
const FOG_START = 26;
const FOG_FAR = 58;

/**
 * @param {object} p
 * @param {{center: {x,y,z}, blocks: Array<{x,y,z,name}>}} p.world
 * @param {Array<{text: string, kind: string}>} p.lines
 * @param {{server?: string, version?: string, botName?: string, footer?: string,
 *          health?: number, hunger?: number, xp?: number, xpLevel?: number,
 *          watermark?: boolean}} [p.meta]
 * @param {{yaw?: number, pitch?: number, fov?: number}} [p.camera]
 * @param {{width?: number, height?: number, radius?: number}} [p.size]
 * @returns {Promise<Buffer>} Ảnh PNG 1280x720
 */
async function render3dScreenshot({ world, lines = [], meta = {}, camera = {}, size }) {
  const outW = size?.width ?? 1280;
  const outH = size?.height ?? 720;
  const radius = size?.radius ?? 26;

  const center = world?.center;
  const rawBlocks = world?.blocks;
  if (!center || !Array.isArray(rawBlocks) || rawBlocks.length < 150) {
    throw new Error('Chưa có đủ dữ liệu thế giới (chunk) để dựng hình 3D.');
  }

  const t0 = Date.now();
  const { grid, W, H, D, x0, y0, z0 } = buildGrid(rawBlocks, center, radius);

  // ---- Camera: mắt bot cao 1.62 block, yaw/pitch cấu hình được ----
  const yawRad = ((camera.yaw ?? 0) * Math.PI) / 180;
  const pitchRad = ((camera.pitch ?? -12) * Math.PI) / 180;
  const fov = ((camera.fov ?? 70) * Math.PI) / 180; // FOV ngang mặc định của MC

  const eye = [center.x, center.y + 1.62, center.z];
  const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
  const sy = Math.sin(yawRad), cy = Math.cos(yawRad);
  const forward = [sy * cp, sp, cy * cp];
  // Trục phải theo quy ước Minecraft (+x đông, +z nam): nhìn về -z (bắc) thì phải là +x (đông)
  const right = [-cy, 0, sy];
  // Trục lên = right × forward (pitch=0 phải cho (0,1,0))
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];

  // Mặt trời: chếch 55° bên phải, cao 38° (đứng yaw=0 sẽ thấy mặt trời góc phải)
  const sunAz = yawRad + 0.96, sunEl = 0.66;
  const sunDir = [Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), Math.cos(sunAz) * Math.cos(sunEl)];
  const sunRight = [sunDir[2], 0, -sunDir[0]];
  const srl = Math.hypot(...sunRight) || 1;
  sunRight[0] /= srl; sunRight[2] /= srl;
  const sunUp = [
    sunDir[1] * sunRight[2] - sunDir[2] * sunRight[1],
    sunDir[2] * sunRight[0] - sunDir[0] * sunRight[2],
    sunDir[0] * sunRight[1] - sunDir[1] * sunRight[0],
  ];
  const cloudY = Math.max(center.y + 45, 112);

  // ---- Render nội bộ 640x360 ----
  const RW = 640, RH = 360;
  const tanH = Math.tan(fov / 2);
  const tanV = tanH * (RH / RW);
  const px = new Uint8ClampedArray(RW * RH * 4);

  const maxDist = 64;
  const deadline = t0 + 9000; // chặn trần CPU — quá lâu thì ném lỗi để fallback

  let di = 0;
  for (let py = 0; py < RH; py++) {
    if ((py & 31) === 0 && Date.now() > deadline) {
      throw new Error('Render 3D quá lâu (server yếu) — sẽ fallback sang khung chat.');
    }
    const ry = (1 - 2 * ((py + 0.5) / RH)) * tanV;
    for (let pxX = 0; pxX < RW; pxX++) {
      const rx = (2 * ((pxX + 0.5) / RW) - 1) * tanH;

      // Hướng ray = forward + right*rx + up*ry (chuẩn hoá)
      let dx = forward[0] + right[0] * rx + up[0] * ry;
      let dyv = forward[1] + right[1] * rx + up[1] * ry;
      let dz = forward[2] + right[2] * rx + up[2] * ry;
      const len = Math.hypot(dx, dyv, dz) || 1;
      dx /= len; dyv /= len; dz /= len;

      // ---- DDA 3D (Amanatides & Woo) ----
      let mapX = Math.floor(eye[0]) - x0;
      let mapY = Math.floor(eye[1]) - y0;
      let mapZ = Math.floor(eye[2]) - z0;
      const stepX = dx > 0 ? 1 : -1;
      const stepY = dyv > 0 ? 1 : -1;
      const stepZ = dz > 0 ? 1 : -1;
      const tDX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
      const tDY = dyv !== 0 ? Math.abs(1 / dyv) : Infinity;
      const tDZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
      let tMaxX = dx !== 0 ? ((stepX > 0 ? mapX + 1 - (eye[0] - x0) : eye[0] - x0 - mapX)) * tDX : Infinity;
      let tMaxY = dyv !== 0 ? ((stepY > 0 ? mapY + 1 - (eye[1] - y0) : eye[1] - y0 - mapY)) * tDY : Infinity;
      let tMaxZ = dz !== 0 ? ((stepZ > 0 ? mapZ + 1 - (eye[2] - z0) : eye[2] - z0 - mapZ)) * tDZ : Infinity;

      let r = 0, g = 0, b = 0;
      let hitT = -1, axis = -1, blendFrac = 0;
      let hx = 0, hyv = 0, hz = 0;

      // Duyệt cho tới khi ra khỏi lưới hoặc quá xa
      for (;;) {
        let t;
        if (tMaxX < tMaxY) {
          if (tMaxX < tMaxZ) { mapX += stepX; t = tMaxX; tMaxX += tDX; axis = 0; }
          else { mapZ += stepZ; t = tMaxZ; tMaxZ += tDZ; axis = 2; }
        } else {
          if (tMaxY < tMaxZ) { mapY += stepY; t = tMaxY; tMaxY += tDY; axis = 1; }
          else { mapZ += stepZ; t = tMaxZ; tMaxZ += tDZ; axis = 2; }
        }
        if (t > maxDist) break;
        if (mapY < 0 || mapY >= H) break; // ra khỏi biên đứng -> trời/đất xa
        const cell = (mapX >= 0 && mapX < W && mapZ >= 0 && mapZ < D)
          ? grid[mapX + mapZ * W + mapY * W * D]
          : 0;
        if (cell !== 0) {
          hitT = t; axis = axis;
          blendFrac = (cell & 255) / 200;
          r = (cell >>> 24) & 255;
          g = (cell >>> 16) & 255;
          b = (cell >>> 8) & 255;
          hx = eye[0] + dx * t;
          hyv = eye[1] + dyv * t;
          hz = eye[2] + dz * t;
          break;
        }
      }

      if (hitT < 0) {
        // Trời + mặt trời + mây
        const sky = skyColor(dyv, [dx, dyv, dz]);
        const withSun = applySunClouds(sky, [dx, dyv, dz], eye, cloudY, { dir: sunDir, right: sunRight, up: sunUp });
        r = withSun[0]; g = withSun[1]; b = withSun[2];
      } else {
        // ---- Tô sáng theo mặt (đúng tỉ lệ Minecraft) + nhiễu texture ----
        let shade;
        if (axis === 1) shade = stepY > 0 ? 1.0 : 0.5;       // mặt trên / đáy
        else if (axis === 2) shade = 0.8;                     // bắc / nam
        else shade = 0.62;                                    // đông / tây

        // "Hạt" nhiễu per-block + hoa văn 2x2 trong block -> giả texture
        const bx = Math.floor(hx), byy = Math.floor(hyv), bz = Math.floor(hz);
        const grain = 0.92 + hash3(bx, byy, bz) * 0.14;
        const fine = ((Math.floor(hx * 2) + Math.floor(hyv * 2) + Math.floor(hz * 2)) & 1) === 0 ? 1 : 0.945;
        const k = shade * grain * fine;

        r *= k; g *= k; b *= k;

        // Block trong suốt (nước/kính/băng): pha nhẹ với màu trời
        if (blendFrac > 0) {
          const skyRef = skyColor(Math.max(dyv, 0.05), [dx, dyv, dz]);
          r += (skyRef[0] - r) * blendFrac;
          g += (skyRef[1] - g) * blendFrac;
          b += (skyRef[2] - b) * blendFrac;
        }

        // Sương mù theo khoảng cách (render distance ngắn như MC)
        const fog = Math.min(1, Math.max(0, (hitT - FOG_START) / (FOG_FAR - FOG_START)));
        if (fog > 0) {
          r += (FOG_COLOR[0] - r) * fog;
          g += (FOG_COLOR[1] - g) * fog;
          b += (FOG_COLOR[2] - b) * fog;
        }
      }

      px[di++] = r; px[di++] = g; px[di++] = b; px[di++] = 255;
    }
  }

  // ---- Phóng ×2 không nội suy -> nét pixel như GUI scale 2 của game ----
  const small = createCanvas(RW, RH);
  const sctx = small.getContext('2d');
  sctx.putImageData(new ImageData(px, RW, RH), 0, 0);

  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, outW, outH);

  // Vignette rất nhẹ (Java có lớp vignette mờ sẵn)
  const vig = ctx.createRadialGradient(outW / 2, outH / 2, outH * 0.42, outW / 2, outH / 2, outH * 0.92);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, outW, outH);

  // ---- Phủ HUD chuẩn F2 ----
  drawHud(ctx, { lines, meta, size: { width: outW, height: outH }, watermark: meta.watermark === true });

  console.log(`[Shot] Render 3D góc nhìn thứ nhất xong trong ${Date.now() - t0}ms (${rawBlocks.length} khối).`);
  return canvas.encode('png');
}

module.exports = { render3dScreenshot };

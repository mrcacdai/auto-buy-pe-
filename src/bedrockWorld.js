'use strict';

/**
 * ============================================================
 *  bedrockWorld.js — Giải mã chunk mạng của Bedrock (thô -> khối)
 * ============================================================
 *  bedrock-protocol nhận packet `level_chunk` chứa các "subchunk"
 *  ở định dạng palettized của Bedrock. File này giải mã từng subchunk
 *  thành danh sách khối { x, y, z, name } để chế độ render 3D dùng.
 *
 *  Định dạng subchunk mạng (Bedrock 1.18+):
 *    [header 1 byte][storage 1..n]
 *    header   = version(4 bit cao) | số storage (4 bit thấp)
 *               version = 8: không có byte chỉ số Y
 *               version = 9: có 1 byte chỉ số Y ngay sau header
 *    storage  = [flags 1 byte: bitsPerBlock(7 bit thấp) | format(1 bit cao)]
 *               [words: ceil(4096 * bits / 32) từ 32-bit little-endian]
 *               [paletteSize: varint little-endian]
 *               [paletteSize entry NBT dạng "network" (little-endian + varint)]
 *
 *  Toàn bộ hàm đều có bảo vệ: dữ liệu hỏng -> ném lỗi để tầng trên bỏ qua
 *  subchunk đó chứ không làm rơi bot.
 */

const nbt = require('prismarine-nbt');

const AIR_PATTERN = /^(minecraft:)?(air|cave_air|void_air|unknown|structure_void|info_update|info_update2|update_block_\d+)$/i;
const INVISIBLE_PATTERN = /^(minecraft:)?(light_block|barrier|border_block)/i;

function isAir(name) {
  return !name || AIR_PATTERN.test(name) || INVISIBLE_PATTERN.test(name);
}

/** Đọc 1 varint little-endian (định dạng "network" của Bedrock) */
function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint vượt quá dữ liệu');
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('varint quá dài');
  }
  return [result >>> 0, pos];
}

/**
 * Phân tích 1 entry NBT trong palette (compound chứa name/states/version).
 * Trả về { name, end } — end là số byte đã tiêu thụ.
 */
function parsePaletteEntry(buf) {
  let parsed;
  try {
    // prismarine-nbt: định dạng "network" = little-endian + varint độ dài chuỗi
    parsed = nbt.parse(buf, 'network');
  } catch {
    parsed = nbt.parse(buf, 'littleVarint'); // tên gọi khác ở một số phiên bản
  }
  const end = parsed?.metadata?.cursor;
  if (!Number.isFinite(end) || end <= 0) throw new Error('NBT không trả vị trí kết thúc');

  const tags = parsed?.parsed?.value ?? {};
  let name = null;
  if (tags?.name && tags.name.type === 'string') name = tags.name.value;
  else if (typeof tags?.name === 'string') name = tags.name;
  return { name: typeof name === 'string' ? name : null, end };
}

/**
 * Giải mã 1 buffer subchunk, đẩy các khối (toạ độ thế giới) vào `out`.
 * @param {Buffer} buf         Dữ liệu subchunk thô
 * @param {number} baseX       Toạ độ X góc (block) của subchunk
 * @param {number} baseZ       Toạ độ Z góc (block)
 * @param {number} fallbackY   Toạ độ Y góc (block) nếu subchunk không tự khai báo Y (định dạng v8)
 * @param {Array}  out         Mảng đích
 */
function decodeSubchunk(buf, baseX, baseZ, fallbackY, out) {
  if (!buf || buf.length < 2) return;

  let off = 0;
  const header = buf[off++];
  const version = header >> 4;
  let storageCount = header & 0x0f;

  if (version === 9) {
    // v9: có thêm 1 byte chỉ số Y tuyệt đối của subchunk trong chunk
    const subchunkY = buf.readInt8(off);
    off += 1;
    baseY = subchunkY * 16;
  } else if (version === 8) {
    baseY = fallbackY;
    if (storageCount === 0) return;
  } else {
    return; // định dạng cũ (pre-1.18) — không hỗ trợ, bỏ qua lặng lẽ
  }

  for (let s = 0; s < storageCount && off < buf.length; s++) {
    const flags = buf[off++];
    const bits = flags & 0x7f;
    if (bits === 0 || bits > 16) continue; // không hợp lệ với định dạng mạng 32-bit

    const wordCount = Math.ceil((4096 * bits) / 32);
    if (off + wordCount * 4 > buf.length) return;

    const words = new Uint32Array(wordCount);
    for (let w = 0; w < wordCount; w++) words[w] = buf.readUInt32LE(off + w * 4);
    off += wordCount * 4;

    const [paletteSize, afterSize] = readVarint(buf, off);
    off = afterSize;

    // Giải mã bảng màu (palette): mỗi entry là 1 NBT compound
    const palette = new Array(paletteSize).fill(null);
    for (let i = 0; i < paletteSize; i++) {
      if (off >= buf.length) return;
      try {
        const { name, end } = parsePaletteEntry(buf.subarray(off));
        palette[i] = name;
        off += end;
      } catch {
        return; // palette bị cắt cụt -> bỏ nốt subchunk này
      }
    }

    const nonAirPalette = palette.filter((n) => !isAir(n));
    if (nonAirPalette.length === 0) continue; // cả storage toàn không khí

    const mask = (1 << bits) >>> 0;

    if (paletteSize === 1) {
      // Toàn bộ 4096 khối giống nhau
      const name = palette[0];
      if (isAir(name)) continue;
      for (let i = 0; i < 4096; i++) {
        out.push({ x: baseX + (i & 15), y: baseY + (i >> 8), z: baseZ + ((i >> 4) & 15), name });
      }
      continue;
    }

    // Giải mã từng ô 4096 khối (x nhanh nhất, sau đó z, cuối cùng y)
    for (let i = 0; i < 4096; i++) {
      const bitPos = i * bits;
      const wordIdx = bitPos >>> 5;
      const shift = bitPos & 31;
      let index = words[wordIdx] >>> shift;
      if (shift + bits > 32 && wordIdx + 1 < words.length) {
        index |= words[wordIdx + 1] << (32 - shift);
      }
      index &= mask;
      const name = palette[index];
      if (isAir(name)) continue;
      out.push({ x: baseX + (i & 15), y: baseY + (i >> 8), z: baseZ + ((i >> 4) & 15), name });
    }
  }
}

/**
 * Giải mã 1 chunk (đã lưu bởi BedrockManager) và cộng dồn khối vào `out`.
 * Có cache theo Buffer subchunk (WeakMap) để những lần sau không phải phân tích NBT lại.
 * @param {{x:number,z:number,minY:number,subs:Buffer[]}} chunk
 * @param {WeakMap} cache
 * @param {Array} out
 */
function decodeLevelChunk(chunk, cache, out) {
  const baseX = chunk.x * 16;
  const baseZ = chunk.z * 16;

  for (let i = 0; i < chunk.subs.length; i++) {
    const buf = chunk.subs[i];
    let decoded = cache.get(buf);
    if (!decoded) {
      // Giải mã 1 lần: X/Z để cục bộ (0..15), Y là toạ độ thế giới tuyệt đối
      decoded = [];
      decodeSubchunk(buf, 0, 0, (chunk.minY + i) * 16, decoded);
      cache.set(buf, decoded);
    }
    for (const block of decoded) {
      out.push({ x: baseX + block.x, y: block.y, z: baseZ + block.z, name: block.name });
    }
  }
}

module.exports = { decodeSubchunk, decodeLevelChunk, isAir, readVarint };

'use strict';

/**
 * ============================================================
 *  shop/store.js — Cấu hình & trạng thái của Shop (data/shop.json)
 * ============================================================
 *  Lưu: bảng giá, kho tiền game, vị trí tin nhắn Panel Discord,
 *       cờ tắt bot (botOff). Ghi file NGUYÊN TỬ (tmp + rename) để
 *       không hỏng dữ liệu khi mất điện/crash giữa chừng.
 *
 *  Kho tiền dùng CHUỖI + BigInt để không mất chính xác với số lớn
 *  (giới hạn Bedrock là 2^63 - 1 ≈ 9,22 tỷ tỷ).
 */

const fs = require('fs');
const path = require('path');
const { MAX_I64 } = require('../amount');

const SHOP_FILE = path.join(__dirname, '..', '..', 'data', 'shop.json');

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Giá trị mặc định lập từ biến môi trường trong .env */
function defaultShopData() {
  const stockRaw = String(process.env.SHOP_STOCK || '1b').trim().toLowerCase() || '1b';
  const m = stockRaw.match(/^([0-9]*\.?[0-9]+)([kmbt])?$/);
  let stock = '1000000000';
  if (m) {
    const exp = { k: 3, m: 6, b: 9, t: 12 }[m[2] || ''] ?? 0;
    const [intPart, fracPart = ''] = m[1].split('.');
    const frac = fracPart.slice(0, exp).padEnd(exp, '0');
    stock = (intPart || '0') + frac;
  }
  return {
    price: {
      baseAmount: clampInt(process.env.PRICE_BASE_AMOUNT, 1, 9e15, 1000000),
      basePrice: clampInt(process.env.PRICE_BASE_PRICE, 1, 9e15, 10000),
      currency: (process.env.PRICE_CURRENCY || 'VND').trim() || 'VND',
    },
    stock, // chuỗi chữ số thuần — đọc qua BigInt
    panelMessage: null, // { channelId, messageId } — nơi đang hiển thị Panel
    botOff: false, // true = quản trị viên đã tắt bot mua (khóa nút Mua)
  };
}

class ShopStore {
  constructor(file = SHOP_FILE) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    const defaults = defaultShopData();
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const saved = JSON.parse(raw);
      return {
        ...defaults,
        ...saved,
        price: { ...defaults.price, ...(saved.price ?? {}) },
      };
    } catch {
      return defaults;
    }
  }

  /** Ghi file nguyên tử: ghi file tạm rồi đổi tên — không bao giờ để file dở dang */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      console.error(`[Shop] Lỗi ghi ${this.file}: ${err.message}`);
      return false;
    }
  }

  /* ---------------- Giá bán ---------------- */

  get price() {
    return this.data.price;
  }

  setPrice({ baseAmount, basePrice, currency } = {}) {
    const p = this.data.price;
    if (baseAmount !== undefined && Number.isFinite(Number(baseAmount)) && Number(baseAmount) > 0) {
      p.baseAmount = Math.floor(Number(baseAmount));
    }
    if (basePrice !== undefined && Number.isFinite(Number(basePrice)) && Number(basePrice) > 0) {
      p.basePrice = Math.floor(Number(basePrice));
    }
    if (currency !== undefined && String(currency).trim()) {
      p.currency = String(currency).trim().slice(0, 8);
    }
    this.save();
    return p;
  }

  /** Tính số tiền (VNĐ) phải trả cho `amountGame` (BigInt) tiền game — làm tròn lên */
  priceFor(amountGame) {
    const big = BigInt(amountGame);
    const { baseAmount, basePrice } = this.data.price;
    const num = big * BigInt(Math.floor(basePrice));
    const den = BigInt(Math.floor(baseAmount));
    const total = num / den;
    if (num % den !== 0n) return total + 1n; // làm tròn lên
    return total;
  }

  /* ---------------- Kho hàng (BigInt qua chuỗi) ---------------- */

  getStock() {
    try {
      const v = BigInt(this.data.stock || '0');
      return v < 0n ? 0n : v;
    } catch {
      return 0n;
    }
  }

  setStock(value) {
    let v;
    try {
      v = typeof value === 'bigint' ? value : BigInt(String(value).trim());
    } catch {
      return false;
    }
    if (v < 0n) v = 0n;
    if (v > MAX_I64) v = MAX_I64;
    this.data.stock = v.toString();
    this.save();
    return true;
  }

  addStock(delta) {
    return this.setStock(this.getStock() + BigInt(delta));
  }

  /** Trừ kho (không xuống dưới 0). Trả về kho sau khi trừ. */
  deductStock(amountGame) {
    const next = this.getStock() - BigInt(amountGame);
    this.setStock(next);
    return this.getStock();
  }

  /* ---------------- Panel Discord ---------------- */

  get panelMessage() {
    return this.data.panelMessage;
  }

  setPanelMessage(channelId, messageId) {
    this.data.panelMessage = { channelId, messageId };
    this.save();
  }

  /* ---------------- Khóa mua ---------------- */

  get botOff() {
    return !!this.data.botOff;
  }

  setBotOff(value) {
    this.data.botOff = !!value;
    this.save();
  }
}

module.exports = { ShopStore, defaultShopData };

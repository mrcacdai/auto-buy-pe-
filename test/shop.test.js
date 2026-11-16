'use strict';

/**
 * ============================================================
 *  test/shop.test.js — Kiểm thử các cơ chế Shop & Panel
 * ============================================================
 *  Chạy: node test/shop.test.js
 *  Không cần mạng / không cần Discord — test thuần logic:
 *    • store      : mặc định, giá, kho BigInt, trừ kho
 *    • format     : formatStock, parseVnd, parseGameAmount
 *    • balances   : cộng/trừ/lock/chặn âm, lịch sử
 *    • orders     : mã đơn, trạng thái, chống trùng giao dịch, retry
 *    • webhook    : đối soát memo (mã đơn, cú pháp cũ, tự nhận diện)
 *    • afk        : khóa mua khi botOff/nghỉ
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, '..', 'data', '_test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.error(`✗ ${name}: ${err.message}`);
  }
}

/* ================= STORE ================= */
const { ShopStore } = require('../src/shop/store');
const storeFile = path.join(TMP, 'shop.json');

test('store: tạo mặc định từ env', () => {
  process.env.SHOP_STOCK = '1b';
  process.env.PRICE_BASE_AMOUNT = '1000000';
  process.env.PRICE_BASE_PRICE = '10000';
  const s = new ShopStore(storeFile);
  assert.strictEqual(s.getStock(), 1000000000n);
  assert.strictEqual(s.price.baseAmount, 1000000);
  assert.strictEqual(s.price.basePrice, 10000);
  assert.strictEqual(s.botOff, false);
});

test('store: setPrice + priceFor làm tròn lên', () => {
  const s = new ShopStore(storeFile);
  s.setPrice({ baseAmount: 1000000, basePrice: 10000, currency: 'VND' });
  assert.strictEqual(s.priceFor(1500000n), 15000n); // 1.5m = 15.000đ
  assert.strictEqual(s.priceFor(1234567n), 12346n); // 12.34567 -> làm tròn lên 12.346
});

test('store: kho BigInt qua chuỗi, không âm, trừ kho', () => {
  const s = new ShopStore(storeFile);
  assert.ok(s.setStock('2500000000')); // 2.5 tỷ — vượt Number.MAX_SAFE? không, nhưng kiểm tra chuỗi
  assert.strictEqual(s.getStock(), 2500000000n);
  assert.ok(s.setStock('9999999999999999')); // 1e16 — vượt MAX_SAFE_INTEGER
  assert.strictEqual(s.getStock(), 9999999999999999n);
  s.setStock(500n);
  s.deductStock(600n); // trừ quá -> về 0
  assert.strictEqual(s.getStock(), 0n);
  assert.ok(!s.setStock('abc')); // không hợp lệ
});

test('store: lưu panelMessage + botOff bền vững', () => {
  const s = new ShopStore(storeFile);
  s.setPanelMessage('123', '456');
  s.setBotOff(true);
  const s2 = new ShopStore(storeFile); // nạp lại từ đĩa
  assert.deepStrictEqual(s2.panelMessage, { channelId: '123', messageId: '456' });
  assert.strictEqual(s2.botOff, true);
});

/* ================= FORMAT ================= */
const { formatStock, parseVnd, parseGameAmount } = require('../src/shop/format');

test('format: formatStock k/m/b/t', () => {
  assert.strictEqual(formatStock(1000n), '1k');
  assert.strictEqual(formatStock(1500000n), '1.5m');
  assert.strictEqual(formatStock(2500000000n), '2.5b');
  assert.strictEqual(formatStock(1000000000000n), '1t');
  assert.strictEqual(formatStock(999n), '999');
  assert.strictEqual(formatStock(-500000n), '-500k');
  assert.strictEqual(formatStock('500000'), '500k');
});

test('format: parseVnd nhận dạng các kiểu nhập', () => {
  assert.strictEqual(parseVnd('50000'), 50000);
  assert.strictEqual(parseVnd('50k'), 50000);
  assert.strictEqual(parseVnd('20.000'), 20000);
  assert.strictEqual(parseVnd('1,000,000'), 1000000);
  assert.strictEqual(parseVnd('1.5tr'), 1500000);
  assert.strictEqual(parseVnd('2,5k'), 2500);
  assert.strictEqual(parseVnd('abc'), null);
  assert.strictEqual(parseVnd('-5'), null);
  assert.strictEqual(parseVnd(''), null);
});

test('format: parseGameAmount dùng BigInt', () => {
  const r = parseGameAmount('2.5b');
  assert.ok(r.ok);
  assert.strictEqual(r.value, 2500000000n);
  assert.ok(!parseGameAmount('xyz').ok);
});

/* ================= BALANCES ================= */
const balances = require('../src/shop/balances');
const balFile = path.join(TMP, 'balances.json');

// Chép hàm ghi vào file test (module dùng đường dẫn cố định -> test qua stub env)
// balances.js dùng BALANCES_FILE cố định trong data/ — để không chạm data thật,
// ta kiểm thử logic qua module với file thật nhưng xóa sạch trước.
function resetBalances() {
  fs.rmSync(path.join(__dirname, '..', 'data', 'balances.json'), { force: true });
  fs.rmSync(path.join(__dirname, '..', 'data', 'balance_history.json'), { force: true });
}

(async () => {
  resetBalances();

  await (async () => {
    test('balances: cộng số dư + đọc lại', async () => {
      const r1 = await balances.addBalance('100000000000000001', 50000, 'TEST');
      assert.ok(r1.success);
      assert.strictEqual(r1.newBalance, 50000);
      assert.strictEqual(balances.getBalance('100000000000000001'), 50000);
    });

    test('balances: trừ không vượt số dư', async () => {
      const r = await balances.deductBalance('100000000000000001', 60000, 'TEST');
      assert.ok(!r.success);
      const r2 = await balances.deductBalance('100000000000000001', 20000, 'TEST');
      assert.ok(r2.success);
      assert.strictEqual(balances.getBalance('100000000000000001'), 30000);
    });

    test('balances: chặn số không hợp lệ', async () => {
      assert.ok(!(await balances.addBalance('u1', -5, 'TEST')).success);
      assert.ok(!(await balances.addBalance('u1', 0, 'TEST')).success);
      assert.ok(!(await balances.deductBalance('u1', 1.5, 'TEST')).success);
      assert.strictEqual(balances.getBalance(null), 0);
    });

    test('balances: lock chống double-spend', async () => {
      resetBalances();
      await balances.addBalance('u-lock', 100, 'TEST');
      const release = await balances.acquireLock('u-lock');
      let deductDuringLock = null;
      const p = balances.deductBalance('u-lock', 100, 'TEST').then((r) => (deductDuringLock = r));
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(deductDuringLock, null, 'phải chờ lock nhả ra mới trừ được');
      release();
      await p;
      assert.strictEqual(balances.getBalance('u-lock'), 0, 'sau lock nhả, trừ thành công');
    });

    test('balances: lịch sử biến động được ghi', async () => {
      resetBalances();
      await balances.addBalance('u-hist', 1000, 'CARD_DEPOSIT');
      await balances.deductBalance('u-hist', 400, 'BUY_MONEY');
      const hist = balances.readHistory(10);
      assert.ok(hist.length >= 2);
      assert.strictEqual(hist[0].type, 'DEDUCT'); // mới nhất trước
    });
  })();

  /* ================= ORDERS ================= */
  const orders = require('../src/shop/orders');
  const dataDir = path.join(__dirname, '..', 'data');
  fs.rmSync(path.join(dataDir, 'orders.json'), { force: true });
  fs.rmSync(path.join(dataDir, 'processed_txs.json'), { force: true });
  fs.rmSync(path.join(dataDir, 'retries.json'), { force: true });

  test('orders: tạo mã đơn không trùng', () => {
    orders.saveOrder({ orderId: 'DH100000', status: 'PENDING_PAYMENT' });
    const id = orders.generateOrderId();
    assert.match(id, /^DH\d{6}$/);
    assert.notStrictEqual(id, 'DH100000');
  });

  test('orders: lưu + cập nhật trạng thái', () => {
    orders.saveOrder({ orderId: 'DH123456', ign: '.steve', gameMoney: 5000000n, status: 'PENDING_PAYMENT', createdAt: new Date().toISOString() });
    const o = orders.getOrder('DH123456');
    assert.strictEqual(o.ign, '.steve');
    assert.strictEqual(o.gameMoney, '5000000'); // BigInt -> chuỗi khi lưu
    orders.updateOrderStatus('DH123456', 'COMPLETED', { bankTxId: 'tx_1' });
    assert.strictEqual(orders.getOrder('dh123456').status, 'COMPLETED');
    assert.strictEqual(orders.getOrder('DH123456').bankTxId, 'tx_1');
  });

  test('orders: chống trùng giao dịch (processed tx)', () => {
    orders.markProcessedTx('bank_FT123');
    assert.ok(orders.isProcessedTx('bank_FT123'));
    assert.ok(!orders.isProcessedTx('bank_FT999'));
    assert.strictEqual(orders.getTransactionId({ id: 42 }), 'bank_42');
    // dấu vân tay cố định — không random
    assert.strictEqual(
      orders.getTransactionId({ amount: 50000, description: 'muamon DH1', date: '2025-01-01' }),
      orders.getTransactionId({ amount: 50000, description: 'muamon DH1', date: '2025-01-01' })
    );
  });

  test('orders: hàng chờ retry — carry-over attempts', () => {
    orders.writeRetries([]);
    orders.addRetry({ orderId: 'DH777', ign: 'steve', gameMoney: 1000n, amountVnd: 10000 }, 30);
    orders.addRetry({ orderId: 'DH777', ign: 'steve', gameMoney: 1000n, amountVnd: 10000 }, 30);
    assert.strictEqual(orders.readRetries().length, 1);
    assert.strictEqual(orders.readRetries()[0].attempts, 2); // không đặt lại về 1
    orders.addRetry({ orderId: 'DH888', ign: 'alex', gameMoney: 2000n, amountVnd: 20000, attempts: 4 }, 1);
    assert.strictEqual(orders.readRetries().find((r) => r.orderId === 'DH888').attempts, 5);
    orders.removeRetry('DH777');
    assert.strictEqual(orders.readRetries().find((r) => r.orderId === 'DH777'), undefined);
  });

  /* ================= WEBHOOK MATCHING (dùng hàm THẬT của routes/bank.js) ================= */
  const { normalizeDesc, findMatchingPendingOrder, parseMemoDirect } = require('../web/routes/bank')._test;

  test('webhook: chuẩn hóa nội dung CK (bỏ dấu + ký tự đặc biệt)', () => {
    assert.strictEqual(normalizeDesc('Mua Mon  DH123456 cho .steve'), 'muamondh123456chosteve');
    assert.strictEqual(normalizeDesc('MÙA MÓN  DH654321 '), 'muamondh654321');
  });

  test('webhook: đối soát MÃ ĐƠN trong memo', () => {
    const pending = { orderId: 'DH123456', ign: '.steve', ignForMemo: 'steve', totalPrice: 50000 };
    const hit = findMatchingPendingOrder([pending], normalizeDesc('MUA MON DH123456 .steve'), 60000);
    assert.ok(hit && hit.order === pending);
    // thiếu tiền -> không khớp
    assert.strictEqual(findMatchingPendingOrder([pending], normalizeDesc('MUA MON DH123456'), 40000), null);
    // sai mã đơn -> không khớp
    assert.strictEqual(findMatchingPendingOrder([pending], normalizeDesc('MUA MON DH999999'), 60000), null);
  });

  test('webhook: đối soát cú pháp memo cũ muamon<ign><số>', () => {
    const pending = { orderId: 'DH654321', ign: 'stevepro', ignForMemo: 'stevepro', rawAmount: '100m', gameMoney: '100000000', totalPrice: 10000 };
    const hit = findMatchingPendingOrder([pending], normalizeDesc('muamonstevepro100m'), 12000);
    assert.ok(hit && hit.order === pending);
  });

  test('webhook: đối soát IGN + từ khóa + số tiền', () => {
    const pending = { orderId: 'DH111222', ign: 'vietanh', ignForMemo: 'vietanh', totalPrice: 20000 };
    const hit = findMatchingPendingOrder([pending], normalizeDesc('chuyen tien mua mon cho vietanh'), 20000);
    assert.ok(hit && hit.order === pending);
  });

  test('webhook: tự nhận diện "muamon <ign> <số>" và ngược lại', () => {
    const a = parseMemoDirect('muamon stevepro 100m');
    assert.ok(a && a.ign === 'stevepro' && a.amount === 100000000n);
    const b = parseMemoDirect('muamon 100m stevepro');
    assert.ok(b && b.ign === 'stevepro' && b.amount === 100000000n);
    const c = parseMemoDirect('chuyen tien khong lien quan');
    assert.strictEqual(c, null);
  });

  /* ================= AFK + BUY LOCK ================= */
  const afk = require('../src/shop/afk');

  test('afk: getBuyLock khi botOff', () => {
    const s = new ShopStore(storeFile);
    s.setBotOff(true);
    const lock = afk.getBuyLock({ store: s });
    assert.ok(lock && lock.includes('TẮT'));
    s.setBotOff(false);
    assert.strictEqual(afk.getBuyLock({ store: s }), null);
  });

  test('afk: trạng thái mặc định tắt', () => {
    const st = afk.getAfkStatus();
    assert.strictEqual(st.enabled, false);
    assert.strictEqual(st.resting, false);
  });

  /* ================= CARD SERVICE ================= */
  const cardService = require('../src/shop/cardService');

  test('card: chữ ký md5(partner_key+code+serial) ổn định', () => {
    // verifyCallbackSign dùng partner key từ env — đặt env để kiểm tra đúng kịch bản
    process.env.CARD_PARTNER_KEY = 'key_a';
    const sig1 = cardService.createSignature('key_a', 'CODE1', 'SER1');
    const sig2 = cardService.createSignature('key_a', 'CODE1', 'SER1');
    assert.strictEqual(sig1, sig2);
    assert.match(sig1, /^[a-f0-9]{32}$/);
    assert.notStrictEqual(cardService.createSignature('key_b', 'CODE1', 'SER1'), sig1);
    assert.ok(cardService.verifyCallbackSign('CODE1', 'SER1', sig1.toUpperCase())); // chấp nhận hoa/thường
    assert.ok(!cardService.verifyCallbackSign('CODE1', 'SER1', 'deadbeef'));
    delete process.env.CARD_PARTNER_KEY;
  });

  test('card: chưa cấu hình -> sendCard báo lỗi rõ ràng', async () => {
    delete process.env.CARD_DOMAIN;
    delete process.env.CARD_PARTNER_ID;
    delete process.env.CARD_PARTNER_KEY;
    const r = await cardService.sendCard({ telco: 'VIETTEL', code: 'X', serial: 'Y', amount: 10000, requestId: 'R1' });
    assert.ok(!r.success);
    assert.match(r.error, /Chưa cấu hình/);
  });

  /* ================= MBBANK / BYTEMART SERVICE ================= */
  const mbbankService = require('../src/shop/mbbankService');

  test('mbbank: extractTransactions xử lý nhiều dạng cấu trúc JSON', () => {
    // 1. Mảng trần
    assert.strictEqual(mbbankService.extractTransactions([{ id: 1 }]).length, 1);
    // 2. { data: [ ... ] }
    assert.strictEqual(mbbankService.extractTransactions({ data: [{ id: 2 }] }).length, 1);
    // 3. { transactionHistoryList: [ ... ] }
    assert.strictEqual(mbbankService.extractTransactions({ transactionHistoryList: [{ id: 3 }] }).length, 1);
    // 4. { data: { transactionHistoryList: [ ... ] } }
    assert.strictEqual(mbbankService.extractTransactions({ data: { transactionHistoryList: [{ id: 4 }] } }).length, 1);
    // 5. null / rỗng
    assert.strictEqual(mbbankService.extractTransactions(null).length, 0);
  });

  test('mbbank: getStatus trả về cấu hình an toàn', () => {
    const st = mbbankService.getStatus();
    assert.strictEqual(typeof st.enabled, 'boolean');
    assert.strictEqual(typeof st.configured, 'boolean');
  });

  /* ================= KẾT QUẢ ================= */
  console.log(`\n===== KẾT QUẢ: ${pass} pass, ${fail} fail =====`);
  if (fail > 0) {
    for (const f of failures) console.error(`  ✗ ${f.name}: ${f.err.stack?.split('\n')[1]?.trim() ?? f.err.message}`);
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})();

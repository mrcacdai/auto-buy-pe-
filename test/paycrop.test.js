'use strict';

const assert = require('assert');
const { renderPayCropScreenshot, extractPayResponseLine } = require('../src/screenshot/payCropRender');

(async () => {
  console.log('--- Test extractPayResponseLine ---');

  // Test 1: extract with lines containing 'paid'
  const lines1 = [
    { kind: 'cmd', text: '/pay hoffi116 2000000' },
    { kind: 'chat', text: 'You paid hoffi116 $ 2M (+$ 40k tax)', raw: '§fYou paid §ehoffi116 §a$ 2M §7(+§a$ 40k§7 tax)' },
  ];
  const r1 = extractPayResponseLine(lines1, 'hoffi116', '2M');
  assert.ok(r1.includes('hoffi116'), 'Phải tìm thấy dòng chứa hoffi116');
  console.log('✓ extractPayResponseLine: tìm thấy dòng chat phản hồi');

  // Test 2: empty lines fallback
  const r2 = extractPayResponseLine([], 'steve', '5m');
  assert.strictEqual(r2, 'You paid steve $ 5m');
  console.log('✓ extractPayResponseLine: fallback khi server không có phản hồi');

  console.log('\n--- Test renderPayCropScreenshot ---');
  const buffer1 = await renderPayCropScreenshot({ lines: lines1, ign: 'hoffi116', amount: '2M' });
  assert.ok(Buffer.isBuffer(buffer1), 'Kết quả phải là Buffer');
  assert.ok(buffer1.length > 5000, 'Ảnh PNG phải có dung lượng > 5KB');
  // Check PNG magic bytes: 0x89 0x50 0x4E 0x47
  assert.strictEqual(buffer1[0], 0x89);
  assert.strictEqual(buffer1[1], 0x50);
  assert.strictEqual(buffer1[2], 0x4e);
  assert.strictEqual(buffer1[3], 0x47);
  console.log('✓ renderPayCropScreenshot: render PNG hợp lệ từ phản hồi server (size: ' + buffer1.length + ' bytes)');

  const bufferFallback = await renderPayCropScreenshot({ lines: [], ign: 'player123', amount: '10M' });
  assert.ok(Buffer.isBuffer(bufferFallback));
  assert.strictEqual(bufferFallback[0], 0x89);
  console.log('✓ renderPayCropScreenshot: render PNG fallback khi không có phản hồi');

  console.log('\n===== PAY CROP TEST THÀNH CÔNG: MỌI TEST PASS =====');
})();

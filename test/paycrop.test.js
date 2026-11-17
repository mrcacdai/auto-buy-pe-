'use strict';

const assert = require('assert');
const { renderPayCropScreenshot, extractPayResponseLine, stripTaxInfo } = require('../src/screenshot/payCropRender');

(async () => {
  console.log('--- Test extractPayResponseLine (giữ nguyên toàn bộ phản hồi server) ---');
  const lines1 = [
    { kind: 'cmd', text: '/pay evil149 10000' },
    { kind: 'chat', text: 'You paid evil149 $ 10K (+$ 200 tax)', raw: '§fYou paid §eevil149 §a$ §f10K §7(+§a$ §7200 tax)' },
  ];
  const r1 = extractPayResponseLine(lines1, 'evil149', '10K');
  assert.ok(r1.includes('evil149'), 'Phải tìm thấy dòng chứa evil149');
  assert.ok(r1.includes('200 tax'), 'Phải giữ nguyên toàn bộ chữ server trả về kể cả (+ 200 tax)');
  console.log('✓ extractPayResponseLine: trích xuất đúng dòng phản hồi kèm đầy đủ thông tin thuế');

  const r2 = extractPayResponseLine([], 'steve', '5m');
  assert.strictEqual(r2, 'You paid steve $ 5m');
  console.log('✓ extractPayResponseLine: fallback khi server không có phản hồi');

  console.log('\n--- Test stripTaxInfo (tiện ích phụ trợ) ---');
  assert.strictEqual(stripTaxInfo('You paid hoffi116 $ 2M (+$ 40k tax)'), 'You paid hoffi116 $ 2M');
  assert.strictEqual(stripTaxInfo('You paid evil149 $ 10K (+$ 200 tax)'), 'You paid evil149 $ 10K');
  console.log('✓ stripTaxInfo: hoạt động chính xác khi cần lọc');

  console.log('\n--- Test renderPayCropScreenshot (in đầy đủ chữ lên background sạch) ---');
  // Test với ví dụ cụ thể của user: You paid evil149 $ 10K (+$ 200 tax)
  const bufferEvil = await renderPayCropScreenshot({
    text: 'You paid evil149 $ 10K (+$ 200 tax)',
    ign: 'evil149',
    amount: '10K',
  });
  assert.ok(Buffer.isBuffer(bufferEvil), 'Kết quả phải là Buffer');
  assert.ok(bufferEvil.length > 5000, 'Ảnh PNG phải có dung lượng > 5KB');
  assert.strictEqual(bufferEvil[0], 0x89);
  assert.strictEqual(bufferEvil[1], 0x50);
  assert.strictEqual(bufferEvil[2], 0x4e);
  assert.strictEqual(bufferEvil[3], 0x47);
  console.log('✓ renderPayCropScreenshot: render thành công ví dụ "You paid evil149 $ 10K (+$ 200 tax)" (size: ' + bufferEvil.length + ' bytes)');

  const bufferFromLines = await renderPayCropScreenshot({ lines: lines1, ign: 'evil149', amount: '10K' });
  assert.ok(Buffer.isBuffer(bufferFromLines));
  assert.strictEqual(bufferFromLines[0], 0x89);
  console.log('✓ renderPayCropScreenshot: render thành công từ mảng lines server');

  const bufferFallback = await renderPayCropScreenshot({ lines: [], ign: 'player123', amount: '10M' });
  assert.ok(Buffer.isBuffer(bufferFallback));
  assert.strictEqual(bufferFallback[0], 0x89);
  console.log('✓ renderPayCropScreenshot: render PNG fallback khi không có phản hồi');

  console.log('\n===== PAY CROP TEST THÀNH CÔNG: MỌI TEST PASS =====');
})();

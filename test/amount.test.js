'use strict';

/**
 * Test parser số tiền (parseAmount) và lược bỏ khoảng trắng IGN (sanitizeIgn).
 * Chạy: npm test
 */

const { parseAmount, sanitizeIgn } = require('../src/amount');

let passed = 0;
let failed = 0;

function checkAmount(input, expected) {
  const result = parseAmount(input);
  if (expected === null) {
    // Kỳ vọng BÁO LỖI
    if (result.ok) {
      failed++;
      console.log(`✗ "${input}" — mong đợi lỗi nhưng lại hợp lệ (${result.value})`);
    } else {
      passed++;
      console.log(`✓ "${input}" -> lỗi (đúng): ${result.error.slice(0, 60)}...`);
    }
    return;
  }
  if (result.ok && result.value === expected) {
    passed++;
    console.log(`✓ "${input}" -> ${result.display}`);
  } else {
    failed++;
    console.log(`✗ "${input}" — mong đợi ${expected}, nhận ${result.ok ? result.value : `LỖI: ${result.error}`}`);
  }
}

function checkIgn(input, expectedOk, expectedValue = null) {
  const result = sanitizeIgn(input);
  if (result.ok !== expectedOk || (expectedOk && result.ign !== expectedValue)) {
    failed++;
    console.log(`✗ sanitizeIgn("${input}") — mong đợi ok=${expectedOk}${expectedValue ? ` ign="${expectedValue}"` : ''}, nhận ${JSON.stringify(result)}`);
  } else {
    passed++;
    console.log(`✓ sanitizeIgn("${input}") -> ${expectedOk ? `"${result.ign}"` : `lỗi: ${result.error}`}`);
  }
}

const K = 1_000n;
const M = 1_000_000n;
const B = 1_000_000_000n;
const T = 1_000_000_000_000n;

console.log('--- parseAmount: hậu tố M/B (yêu cầu chính) ---');
checkAmount('5m', 5n * M);
checkAmount('5M', 5n * M);
checkAmount('1.5b', 1500000000n);
checkAmount('1.5B', 1500000000n);
checkAmount('10b', 10n * B);
checkAmount('.5m', 500000n);
checkAmount('2.75m', 2750000n);

console.log('\n--- parseAmount: hậu tố phụ k/t ---');
checkAmount('2k', 2n * K);
checkAmount('1t', T);

console.log('\n--- parseAmount: số thuần & định dạng khác ---');
checkAmount('5000000', 5n * M);
checkAmount('1,000,000', M);
checkAmount('1_000_000', M);
checkAmount(' 7 ', 7n);
checkAmount('1.2345b', 1234500000n); // cắt phần thập phân dư

console.log('\n--- parseAmount: các trường hợp phải báo lỗi ---');
checkAmount('0', null);
checkAmount('-5m', null);
checkAmount('abc', null);
checkAmount('1.2.3', null);
checkAmount('5 m 2', null);
checkAmount('1e9', null);
checkAmount('99999999999999999999', null); // vượt 2^63 - 1
checkAmount('', null);

console.log('\n--- sanitizeIgn: chấp nhận ký tự đặc biệt ---');
checkIgn('.steve', true, '.steve');
checkIgn('~Steve#123', true, '~Steve#123');
checkIgn('  .steve ', true, '.steve');
checkIgn('✔✅Player', true, '✔✅Player');
checkIgn('a.b.c.d', true, 'a.b.c.d');
checkIgn('steve\n/pay x', false); // chặn chèn lệnh
checkIgn('', false);

console.log(`\n===== KẾT QUẢ: ${passed} pass, ${failed} fail =====`);
process.exit(failed > 0 ? 1 : 0);

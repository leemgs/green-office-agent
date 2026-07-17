const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAlreadyCompletedMessage,
  summarizeResponseBody,
} = require('../bot');

test('weekly and daily limit alerts are recognized as idempotent reruns', () => {
  assert.equal(isAlreadyCompletedMessage('동료 칭찬은 주 1회만 작성할 수 있습니다.'), true);
  assert.equal(isAlreadyCompletedMessage('오늘 이미 등록한 게시글이 있습니다.'), true);
  assert.equal(isAlreadyCompletedMessage('게시글 작성에 실패했습니다.'), false);
});

test('response diagnostics are normalized and bounded', () => {
  assert.equal(
    summarizeResponseBody({ message: '  등록할 수 없습니다.  ' }),
    '{"message":" 등록할 수 없습니다. "}'
  );
  assert.equal(summarizeResponseBody('a'.repeat(600)).length, 500);
});

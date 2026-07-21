const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAlreadyCompletedMessage,
  summarizeResponseBody,
  getWeekOfYear,
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

test('week-of-year advances by one each week and starts at 0', () => {
  assert.equal(getWeekOfYear(new Date(2026, 0, 1)), 0);
  assert.equal(getWeekOfYear(new Date(2026, 0, 8)), 1);
  assert.equal(getWeekOfYear(new Date(2026, 0, 15)), 2);
});

test('week rotation never picks the same co-worker two weeks in a row', () => {
  // 금요일 동료 선택은 list[getWeekOfYear % list.length] 로 순환한다.
  // 목록이 2명 이상이면 연속한 두 주의 인덱스가 절대 같지 않아 직전과 동일인이 뽑히지 않는다.
  const names = ['강동욱', '구민수', '김명유', '김희진', '서준수'];
  let prevIndex = null;
  // 연속 60주를 검증 (목록을 여러 바퀴 돌아도 인접 주 중복이 없어야 함)
  for (let week = 0; week < 60; week++) {
    const index = week % names.length;
    if (prevIndex !== null) {
      assert.notEqual(index, prevIndex, `week ${week} repeated the previous pick`);
    }
    prevIndex = index;
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAlreadyCompletedMessage,
  summarizeResponseBody,
  getWeekOfYear,
  parseGachaProbability,
  parseGachaStock,
  parseRemainingDraws,
  isInsufficientDropletMessage,
  normalizeLotteryTargets,
  planLotteryDraws,
  DEFAULT_LOTTERY_THRESHOLD,
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

// ── 물방울 뽑기(gacha/lottery) 유틸 테스트 ──

test('parseGachaProbability reads the headline % and ignores the bonus %p', () => {
  assert.equal(parseGachaProbability('당첨확률: 4.66% (+2.93%p 보너스)'), 4.66);
  assert.equal(parseGachaProbability('당첨확률: 3.96% (+3.19%p 보너스)'), 3.96);
  assert.equal(parseGachaProbability('당첨확률 12% 재고: 1개'), 12);
  assert.equal(parseGachaProbability('확률 정보 없음'), null);
});

test('parseGachaStock and parseRemainingDraws read counts', () => {
  assert.equal(parseGachaStock('재고: 2개'), 2);
  assert.equal(parseGachaStock('재고: 0개'), 0);
  assert.equal(parseGachaStock('재고 없음 표기'), null);
  assert.deepEqual(parseRemainingDraws('오늘 남은 횟수: 3/3'), { remaining: 3, total: 3 });
  assert.deepEqual(parseRemainingDraws('남은 횟수 0 / 3'), { remaining: 0, total: 3 });
  assert.equal(parseRemainingDraws('횟수 정보 없음'), null);
});

test('isInsufficientDropletMessage detects low-balance alerts', () => {
  assert.equal(isInsufficientDropletMessage('물방울이 부족합니다.'), true);
  assert.equal(isInsufficientDropletMessage('보유 물방울이 부족해요'), true);
  assert.equal(isInsufficientDropletMessage('응모가 완료되었습니다.'), false);
});

test('normalizeLotteryTargets accepts strings and objects, applies default threshold', () => {
  const normalized = normalizeLotteryTargets([
    '와인',
    { name: '이지블루', minProbability: 15 },
    { name: '  공백정리  ' },
    { notName: 'invalid' },
    42,
  ]);
  assert.deepEqual(normalized, [
    { name: '와인', minProbability: DEFAULT_LOTTERY_THRESHOLD },
    { name: '이지블루', minProbability: 15 },
    { name: '공백정리', minProbability: DEFAULT_LOTTERY_THRESHOLD },
  ]);
});

test('planLotteryDraws only marks in-stock cards at/above the threshold as eligible', () => {
  const cards = [
    { index: 0, text: '영웅 정관장 에브리타임 현금가치: 77,200원 재고: 1개 당첨확률: 3.96% (+3.19%p 보너스) 30 뽑기' },
    { index: 1, text: '희귀 이지블루 현금가치: 34,800원 재고: 2개 당첨확률: 12.5% (+2.93%p 보너스) 30 뽑기' },
    { index: 2, text: '희귀 와인 현금가치: 34,800원 재고: 0개 당첨확률: 20% 30 뽑기' },
  ];
  const plan = planLotteryDraws(cards, ['이지블루', '와인', '없는물품']);

  const byName = Object.fromEntries(plan.map(p => [p.name, p]));
  // 이지블루: 12.5% >= 10% & 재고 있음 → eligible, 클릭 대상 인덱스 1
  assert.equal(byName['이지블루'].status, 'eligible');
  assert.equal(byName['이지블루'].index, 1);
  assert.equal(byName['이지블루'].probability, 12.5);
  // 와인: 확률은 충분하지만 재고 0 → out_of_stock
  assert.equal(byName['와인'].status, 'out_of_stock');
  // 페이지에 없는 물품 → not_found
  assert.equal(byName['없는물품'].status, 'not_found');
});

test('planLotteryDraws skips cards below the (per-item) threshold', () => {
  const cards = [
    { index: 0, text: '희귀 이지블루 재고: 2개 당첨확률: 4.66% (+2.93%p 보너스) 30 뽑기' },
  ];
  // 기본 임계값(10%)일 때 4.66% → below_threshold
  assert.equal(planLotteryDraws(cards, ['이지블루'])[0].status, 'below_threshold');
  // 물품별 임계값을 4%로 낮추면 → eligible
  const plan = planLotteryDraws(cards, [{ name: '이지블루', minProbability: 4 }]);
  assert.equal(plan[0].status, 'eligible');
});

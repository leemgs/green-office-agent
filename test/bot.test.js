const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAlreadyCompletedMessage,
  summarizeResponseBody,
  getWeekOfYear,
  parseLotteryProbability,
  parseLotteryStock,
  parseRemainingDraws,
  isInsufficientDropletMessage,
  normalizeLotteryTargets,
  planLotteryDraws,
  DEFAULT_LOTTERY_THRESHOLD,
  isWithinAttendanceWindow,
  formatKstDate,
  getHolidayName,
  hasHolidayDataForYear,
  getAttendanceSkipReason,
  getHolidaySkipReason,
  HOLIDAY_SKIP_ACTIVITIES,
  countPostingFridays,
  pickCoworkerForDate,
} = require('../bot');

const holidays = require('../data/holidays.json');

// ── 출석 시간창(평일 06:00~11:00 KST) 판별 테스트 ──
// 2026-10-12=월, 10-13=화, 10-10=토, 10-11=일. Date는 KST 벽시계로 간주한다.
test('isWithinAttendanceWindow accepts weekday 06:00~10:59 and rejects the rest', () => {
  // 평일 창 안
  assert.equal(isWithinAttendanceWindow(new Date(2026, 9, 12, 6, 0)), true);   // 월 06:00 (창 시작)
  assert.equal(isWithinAttendanceWindow(new Date(2026, 9, 12, 8, 30)), true);  // 월 08:30
  assert.equal(isWithinAttendanceWindow(new Date(2026, 9, 12, 10, 59)), true); // 월 10:59
  // 평일 창 밖
  assert.equal(isWithinAttendanceWindow(new Date(2026, 9, 12, 5, 59)), false); // 월 05:59 (창 전)
  assert.equal(isWithinAttendanceWindow(new Date(2026, 9, 12, 11, 0)), false); // 월 11:00 (경계 제외)
  assert.equal(isWithinAttendanceWindow(new Date(2026, 9, 13, 11, 46)), false);// 화 11:46 (실제 실패 케이스)
  // 주말은 시간과 무관하게 불가
  assert.equal(isWithinAttendanceWindow(new Date(2026, 9, 10, 8, 0)), false);  // 토 08:00
  assert.equal(isWithinAttendanceWindow(new Date(2026, 9, 11, 8, 0)), false);  // 일 08:00
});

// ── 법정 공휴일 건너뛰기 테스트 (data/holidays.json 기준) ──
test('holidays.json contains the requested legal holidays', () => {
  assert.equal(getHolidayName(new Date(2026, 6, 17, 8, 0), holidays), '제헌절');   // 7/17 (금)
  assert.equal(getHolidayName(new Date(2026, 9, 9, 8, 0), holidays), '한글날');    // 10/9 (금)
  assert.equal(getHolidayName(new Date(2026, 9, 5, 8, 0), holidays), '개천절 대체 휴일'); // 10/5 (월)
  assert.equal(getHolidayName(new Date(2026, 8, 24, 8, 0), holidays), '추석 전날');  // 9/24 (목)
  assert.equal(getHolidayName(new Date(2026, 9, 12, 8, 0), holidays), null);        // 10/12 (월) 평일
  assert.equal(hasHolidayDataForYear(2026, holidays), true);
  assert.equal(hasHolidayDataForYear(2027, holidays), true);
  assert.equal(hasHolidayDataForYear(2030, holidays), false);
  // 모든 키는 YYYY-MM-DD 형식
  for (const key of Object.keys(holidays)) assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});

test('formatKstDate pads month and day', () => {
  assert.equal(formatKstDate(new Date(2026, 0, 5, 9, 0)), '2026-01-05');
});

test('getAttendanceSkipReason skips holidays and out-of-window times only', () => {
  // 공휴일(평일·출석 시간대 안이어도) → 건너뜀
  assert.match(getAttendanceSkipReason(new Date(2026, 9, 9, 8, 0), holidays), /공휴일\(한글날\)/);
  assert.match(getAttendanceSkipReason(new Date(2026, 6, 17, 7, 30), holidays), /공휴일\(제헌절\)/);
  // 평일 출석 시간대 안 → 시도함(null)
  assert.equal(getAttendanceSkipReason(new Date(2026, 9, 12, 8, 0), holidays), null);
  // 평일이지만 창 밖(지연 실행) → 건너뜀
  assert.match(getAttendanceSkipReason(new Date(2026, 9, 13, 11, 46), holidays), /출석 가능 시간/);
  // 공휴일 목록이 비어 있어도 평일 창 안이면 시도함
  assert.equal(getAttendanceSkipReason(new Date(2026, 9, 9, 8, 0), {}), null);
});

test('getHolidaySkipReason skips the lottery only on holidays', () => {
  // 공휴일(평일 오후 3시) → 뽑기 건너뜀
  assert.match(getHolidaySkipReason(new Date(2026, 9, 9, 15, 0), holidays, '뽑기 응모를'), /공휴일\(한글날\)이므로 뽑기 응모를/);
  assert.match(getHolidaySkipReason(new Date(2026, 9, 5, 15, 0), holidays, '뽑기 응모를'), /개천절 대체 휴일/);
  // 평일 → 진행(null). 뽑기는 출석 시간대 제한이 없으므로 오후 3시여도 진행
  assert.equal(getHolidaySkipReason(new Date(2026, 9, 12, 15, 0), holidays, '뽑기 응모를'), null);
});

test('posting is skipped on holidays, including a Friday holiday for 동료 칭찬', () => {
  assert.equal(HOLIDAY_SKIP_ACTIVITIES.post, '포스팅을');
  // 10/9(금, 한글날) 09:00 — 금요일 동료 칭찬 포스팅 예정일이지만 공휴일 → 건너뜀
  assert.equal(
    getHolidaySkipReason(new Date(2026, 9, 9, 9, 0), holidays, HOLIDAY_SKIP_ACTIVITIES.post),
    '오늘(2026-10-09)은 공휴일(한글날)이므로 포스팅을 시도하지 않습니다.'
  );
  // 10/16(금) 평일 → 진행
  assert.equal(getHolidaySkipReason(new Date(2026, 9, 16, 9, 0), holidays, HOLIDAY_SKIP_ACTIVITIES.post), null);
});

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

// ── 동료 칭찬 순번 (공휴일 금요일은 순번을 소모하지 않음) ──
const coworkerNames = ['강동욱', '구민수', '김명유', '김희진', '서준수'];
const rotationAnchor = { anchorDate: '2026-10-16', anchorName: '김명유' };
const fri = iso => new Date(`${iso}T09:00:00`);

test('countPostingFridays counts only non-holiday Fridays after the anchor', () => {
  assert.equal(countPostingFridays('2026-10-16', fri('2026-10-16'), holidays), 0);
  assert.equal(countPostingFridays('2026-10-16', fri('2026-10-23'), holidays), 1);
  // 12/25(성탄절)·1/1(신정) 금요일은 세지 않음: 10/23~12/18 = 9회, 1/8 = 10회
  assert.equal(countPostingFridays('2026-10-16', fri('2026-12-18'), holidays), 9);
  assert.equal(countPostingFridays('2026-10-16', fri('2027-01-08'), holidays), 10);
  // 기준일 이전 날짜는 음수
  assert.equal(countPostingFridays('2026-10-16', fri('2026-10-02'), holidays), -1); // 10/9 한글날 제외
});

test('a holiday Friday does not skip anyone: the next Friday gets that turn', () => {
  const pick = iso => pickCoworkerForDate(fri(iso), coworkerNames, holidays, rotationAnchor).name;
  assert.equal(pick('2026-10-16'), '김명유'); // 기준
  assert.equal(pick('2026-10-23'), '김희진');
  // 12/18 다음 포스팅 금요일은 12/25·1/1(공휴일)을 건너뛴 1/8 → 바로 다음 사람
  const before = coworkerNames.indexOf(pick('2026-12-18'));
  assert.equal(pick('2027-01-08'), coworkerNames[(before + 1) % coworkerNames.length]);
});

test('rotation visits everyone in order across holidays and year boundaries', () => {
  // 2026-10-16부터 2년간의 '포스팅 금요일'을 순서대로 모아, 순번이 목록 순서를 정확히 따르는지 확인
  const picks = [];
  for (let d = fri('2026-10-16'); d < fri('2028-10-16'); d = new Date(d.getTime() + 7 * 864e5)) {
    if (holidays[formatKstDate(d)]) continue; // 공휴일은 포스팅 안 함
    picks.push(pickCoworkerForDate(d, coworkerNames, holidays, rotationAnchor).name);
  }
  const start = coworkerNames.indexOf('김명유');
  picks.forEach((name, i) => {
    assert.equal(name, coworkerNames[(start + i) % coworkerNames.length], `posting #${i}`);
  });
});

test('missing anchor name falls back to the first person in the list', () => {
  const pick = pickCoworkerForDate(fri('2026-10-16'), coworkerNames, holidays, { anchorDate: '2026-10-16', anchorName: '퇴사자' });
  assert.equal(pick.name, '강동욱');
});

test('data/coworker-rotation.json anchor exists in data/coworkers.txt', () => {
  const fs = require('fs');
  const rotation = require('../data/coworker-rotation.json');
  const names = fs.readFileSync(require('path').join(__dirname, '..', 'data', 'coworkers.txt'), 'utf8')
    .split(/\r?\n/).map(n => n.trim()).filter(Boolean);
  assert.match(rotation.anchorDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(names.includes(rotation.anchorName), `${rotation.anchorName} not in coworkers.txt`);
});

// ── 물방울 뽑기(lottery) 유틸 테스트 ──

test('parseLotteryProbability reads the headline % and ignores the bonus %p', () => {
  assert.equal(parseLotteryProbability('당첨확률: 4.66% (+2.93%p 보너스)'), 4.66);
  assert.equal(parseLotteryProbability('당첨확률: 3.96% (+3.19%p 보너스)'), 3.96);
  assert.equal(parseLotteryProbability('당첨확률 12% 재고: 1개'), 12);
  assert.equal(parseLotteryProbability('확률 정보 없음'), null);
});

test('parseLotteryStock and parseRemainingDraws read counts', () => {
  assert.equal(parseLotteryStock('재고: 2개'), 2);
  assert.equal(parseLotteryStock('재고: 0개'), 0);
  assert.equal(parseLotteryStock('재고 없음 표기'), null);
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

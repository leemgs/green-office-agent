const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

require('dotenv').config();

const SITE_URL = process.env.SITE_URL || 'https://green-office.uk/';
const USER_ID = process.env.USER_ID;
const USER_PASSWORD = process.env.USER_PASSWORD;

function summarizeResponseBody(body) {
  if (!body) return '';

  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 연중 주차(week-of-year) 번호. 월·수·금 포스팅이 목록을 매주 순서대로 순환하도록
// 인덱스를 정하는 데 사용된다 (list[getWeekOfYear(...) % list.length]).
function getWeekOfYear(kstDate) {
  const startOfYear = new Date(kstDate.getFullYear(), 0, 1);
  return Math.floor((kstDate - startOfYear) / (7 * 24 * 60 * 60 * 1000));
}

async function readResponseBody(response) {
  const contentType = response.headers()['content-type'] || '';

  try {
    if (contentType.includes('application/json')) {
      return summarizeResponseBody(await response.json());
    }
    return summarizeResponseBody(await response.text());
  } catch {
    return '';
  }
}

async function getVisibleFormError(page) {
  const selectors = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '.text-red-500',
    '.text-destructive',
    '[class*="error"]',
    '[class*="toast"]',
  ];

  const messages = [];
  for (const selector of selectors) {
    const texts = await page.locator(selector).allInnerTexts().catch(() => []);
    for (const text of texts) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized && !messages.includes(normalized)) messages.push(normalized);
    }
  }
  return messages.join(' | ').slice(0, 500);
}

function isAlreadyCompletedMessage(message) {
  return [
    /이미.*(?:작성|등록|보상|참여)/,
    /(?:작성|등록|보상|참여).*이미/,
    /(?:일|주)\s*1회/,
    /(?:오늘|이번\s*주).*1회/,
  ].some(pattern => pattern.test(message));
}

// ── 물방울 뽑기(gacha/lottery) 관련 상수·유틸 ──
// data/lottery.json에 등록한 물품의 당첨확률이 임계값(기본 10%) 이상일 때만 자동 응모한다.
// 한 번 응모(뽑기)할 때마다 물방울 30개가 차감된다.
const DEFAULT_LOTTERY_THRESHOLD = 10; // 응모 기준 당첨확률(%). data/lottery.json에서 물품별로 재정의 가능.
const LOTTERY_DRAW_COST = 30; // 1회 뽑기당 차감되는 물방울 수.

// 뽑기 카드 텍스트에서 "당첨확률"의 대표 확률(%)만 추출한다.
// 예) "당첨확률: 4.66% (+2.93%p 보너스)" → 4.66 (괄호 안의 보너스 %p는 무시)
function parseGachaProbability(text) {
  if (!text) return null;
  const match = text.match(/당첨\s*확률[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

// 뽑기 카드 텍스트에서 "재고" 수량을 추출한다. 예) "재고: 2개" → 2
function parseGachaStock(text) {
  if (!text) return null;
  const match = text.match(/재고[^0-9]*([0-9]+)/);
  return match ? parseInt(match[1], 10) : null;
}

// "오늘 남은 횟수: 3/3" 형태에서 남은/전체 응모 가능 횟수를 추출한다.
function parseRemainingDraws(text) {
  if (!text) return null;
  const match = text.match(/남은\s*횟수[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/);
  if (!match) return null;
  return { remaining: parseInt(match[1], 10), total: parseInt(match[2], 10) };
}

// 물방울 잔액 부족 등 응모를 더 진행하면 안 되는 안내 메시지인지 판별한다.
function isInsufficientDropletMessage(message) {
  if (!message) return false;
  return [
    /물방울.*부족/,
    /부족.*물방울/,
    /잔액.*부족/,
    /부족.*(?:합니다|해요|함)/,
  ].some(pattern => pattern.test(message));
}

// data/lottery.json 항목(문자열 또는 {name, minProbability})을 표준 형태로 정규화한다.
function normalizeLotteryTargets(rawTargets) {
  if (!Array.isArray(rawTargets)) return [];
  return rawTargets
    .map(entry => {
      if (typeof entry === 'string') {
        return { name: entry.trim(), minProbability: DEFAULT_LOTTERY_THRESHOLD };
      }
      if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
        const min = Number(entry.minProbability);
        return {
          name: entry.name.trim(),
          minProbability: Number.isFinite(min) ? min : DEFAULT_LOTTERY_THRESHOLD,
        };
      }
      return null;
    })
    .filter(target => target && target.name.length > 0);
}

// 페이지에서 수집한 카드 목록[{ index, text }]과 응모 대상 물품을 대조해
// 각 대상의 응모 여부와 사유를 결정한다. (실제 클릭 없이 순수 계산만 수행 → 단위 테스트 가능)
//   - eligible: 당첨확률 >= 기준 → 응모 대상
//   - below_threshold: 당첨확률 < 기준 → 건너뜀
//   - out_of_stock: 재고 0 → 건너뜀
//   - no_probability: 당첨확률을 읽지 못함 → 건너뜀
//   - not_found: 페이지에서 해당 물품 카드를 찾지 못함 → 건너뜀
function planLotteryDraws(cards, targets) {
  const normalized = normalizeLotteryTargets(targets);
  return normalized.map(({ name, minProbability }) => {
    const card = cards.find(c => (c.text || '').includes(name));
    if (!card) return { name, minProbability, status: 'not_found' };

    const probability = parseGachaProbability(card.text);
    const stock = parseGachaStock(card.text);
    const base = { name, minProbability, index: card.index, probability, stock };

    if (probability == null) return { ...base, status: 'no_probability' };
    if (stock != null && stock <= 0) return { ...base, status: 'out_of_stock' };
    if (probability >= minProbability) return { ...base, status: 'eligible' };
    return { ...base, status: 'below_threshold' };
  });
}

async function runBot(mode = 'attendance') {
  console.log(`Starting bot in ${mode} mode with stealth plugin...`);
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    // 1. Login
    if (!USER_ID || !USER_PASSWORD) {
      throw new Error('USER_ID or USER_PASSWORD is not set. Please check your GitHub Secrets or .env file.');
    }

    console.log(`Logging in... (ID length: ${USER_ID.length}, Pass length: ${USER_PASSWORD.length})`);
    await page.goto(`${SITE_URL}login`);
    await page.waitForTimeout(5000); 
    await page.waitForSelector('input[placeholder*="아이디"]');
    
    console.log('Filling ID...');
    await page.fill('input[placeholder*="아이디"]', USER_ID.trim());
    await page.waitForTimeout(500);
    
    console.log('Filling Password...');
    await page.fill('input[placeholder*="비밀번호"]', USER_PASSWORD.trim());
    await page.waitForTimeout(1000);
    
    console.log('Submitting login form via native click...');
    const loginBtn = page.locator('button[type="submit"], button:has-text("로그인")').last();
    await loginBtn.waitFor({ state: 'visible', timeout: 5000 });
    await loginBtn.click({ force: true });
    
    // Wait for redirection
    console.log('Waiting for redirection (15s)...');
    await page.waitForTimeout(15000); 
    
    const currentUrl = page.url();
    const loginBtnVisible = await page.locator('button:has-text("로그인")').isVisible();
    
    if (loginBtnVisible || currentUrl.includes('login')) {
      console.error('Login failed: Still on login page.');
      const pageInfo = await page.evaluate(() => {
        const errorEl = document.querySelector('.text-red-500, [role="alert"], .error-message');
        const errorText = errorEl ? errorEl.innerText.trim() : '';
        const bodyTextSnippet = document.body.innerText.slice(0, 500);
        return { errorText, bodyTextSnippet };
      });

      console.log(`Page Content Snippet: ${pageInfo.bodyTextSnippet}`);
      
      let errorMsg = pageInfo.errorText;
      if (!errorMsg) {
        // Removed '가입' to avoid false positive from '회원가입' (Sign up)
        const keywords = ['아이디/비밀번호를 확인해주세요', '틀렸습니다', '올바르지', '실패', 'Cloudflare', 'security verification', 'bot detection'];
        for (const k of keywords) {
          if (pageInfo.bodyTextSnippet.includes(k)) {
            errorMsg = (k === 'Cloudflare' || k === 'security verification') 
              ? 'Blocked by Cloudflare Bot Protection' 
              : `Detected error: ${k}`;
            break;
          }
        }
      }
      
      if (!errorMsg) errorMsg = 'Unknown error (Form may not have submitted properly or silently failed)';
      console.error(`Site status: ${errorMsg}`);
      throw new Error(`Login failed: ${errorMsg}`);
    }
    console.log('Login successful.');

    // Always run attendance if requested
    if (mode === 'attendance') {
      await handleAttendance(page);
    } else if (mode === 'post') {
      await handlePost(page);
    } else if (mode === 'gacha') {
      await handleGacha(page);
    }

  } catch (error) {
    console.error('Error during bot execution:', error);
    await page.screenshot({ path: `error-${mode}-${Date.now()}.png` });
    throw error;
  } finally {
    await browser.close();
  }
}

async function handleAttendance(page) {
  console.log('Navigating to attendance page...');
  await page.goto(`${SITE_URL}attendance`);
  await page.waitForTimeout(3000);

  // ── Check for time-restriction rejection ──
  // The site rejects attendance outside weekdays 06:00-11:00 KST with this message.
  const bodyText = await page.locator('body').innerText();
  const rejectionMessage = '출석 가능 시간은 평일 오전 6시~11시입니다';
  if (bodyText.includes(rejectionMessage)) {
    const errorMsg = `ATTENDANCE_TIME_REJECTED: 출석이 거부되었습니다. 사이트 메시지: "${rejectionMessage}"`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // ── Check if already checked in ──
  const alreadyCheckedPhrases = ['출석 완료', '이미 출석', '오늘 출석을 완료'];
  for (const phrase of alreadyCheckedPhrases) {
    if (bodyText.includes(phrase)) {
      console.log(`Already checked in today (detected: "${phrase}"). Skipping.`);
      return;
    }
  }

  console.log('Selecting attendance option: 출근 완료!');
  const optionBtn = page.locator('button:has-text("출근 완료!")');
  if (await optionBtn.isVisible()) {
    await optionBtn.click();
  } else {
    console.log('Option "출근 완료!" not found, searching for alternatives...');
    const altOptions = ["오늘도 화이팅", "좋은 아침입니다", "커피 한 잔 하실래요?", "오늘도 무사히", "직접 입력"];
    let found = false;
    for (const opt of altOptions) {
      const btn = page.locator(`button:has-text("${opt}")`);
      if (await btn.isVisible()) {
        await btn.click();
        found = true;
        console.log(`Selected alternative option: "${opt}"`);
        break;
      }
    }
    if (!found) {
      console.log('Page body text (first 500 chars):', bodyText.substring(0, 500));
      throw new Error('ATTENDANCE_NO_OPTION: 출석 옵션 버튼을 찾을 수 없습니다.');
    }
  }

  console.log('Clicking the final attendance button...');
  const submitBtn = page.locator('button:has-text("출석하기")').first();
  await submitBtn.click();
  
  await page.waitForTimeout(3000);

  // ── Verify after submit — check for late rejection ──
  const afterText = await page.locator('body').innerText();
  if (afterText.includes(rejectionMessage)) {
    const errorMsg = `ATTENDANCE_TIME_REJECTED: 출석 제출 후 거부되었습니다. 사이트 메시지: "${rejectionMessage}"`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  console.log('Attendance completed successfully.');
}

async function handlePost(page) {
  console.log('Navigating to posting page...');
  await page.goto(`${SITE_URL}posts/new`, { waitUntil: 'networkidle', timeout: 30000 });

  // This is a Next.js CSR page — wait for React to mount the category selection screen.
  console.log('Waiting for Next.js CSR hydration...');
  await page.waitForTimeout(5000);

  const kstDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const day = kstDate.getDay(); // 0: Sun, 1: Mon, 2: Tue, 3: Wed, 4: Thu, 5: Fri, 6: Sat

  let categoryName = "긍정 문구";
  let title = "💡 [오늘의 명언] 긍정적인 하루를 시작하세요";
  let content = "오늘 하루도 작은 목표를 세우고 하나씩 달성해보는 건 어떨까요?\n\n여러분의 오늘 하루도 의미 있는 작은 성취들로 가득하길 응원합니다! 🙌";
  // "동료 칭찬" 카테고리에서만 사용: 태그할 동료 이름 (긍정 문구일 땐 null 유지)
  let taggedCoworker = null;

  if (day === 5) {
    categoryName = "동료 칭찬";

    let selectedName = null;
    try {
      const fs = require('fs');
      const path = require('path');
      const coworkersFile = path.join(__dirname, 'data', 'coworkers.txt');
      
      if (fs.existsSync(coworkersFile)) {
        const fileContent = fs.readFileSync(coworkersFile, 'utf8');
        const names = fileContent
          .split(/\r?\n/)
          .map(name => name.trim())
          .filter(name => name.length > 0);
          
        if (names.length > 0) {
          // 월·수요일과 동일하게 연중 주차(week-of-year)로 순환 선택한다.
          // 무작위(random)와 달리 목록을 한 바퀴 돌기 전까지 직전 주와 같은 사람이
          // 다시 뽑히지 않으므로 "직전과 동일인 선택"이 구조적으로 방지된다.
          const weekOfYear = getWeekOfYear(kstDate);
          const rotationIndex = weekOfYear % names.length;
          selectedName = names[rotationIndex];
          console.log(`Selected co-worker for praise (week ${weekOfYear}): ${selectedName}`);
        } else {
          throw new Error('coworkers.txt is empty.');
        }
      } else {
        throw new Error(`coworkers.txt not found at ${coworkersFile}`);
      }
    } catch (fsError) {
      console.error('Error reading coworkers.txt:', fsError);
      throw new Error(`Cannot prepare co-worker praise post: ${fsError.message}`);
    }

    taggedCoworker = selectedName;
    title = `${selectedName}님을 칭찬합니다.`;
    content = `${selectedName}님과 함께 근무할 수 있어 무척 든든하고 행복합니다.\n` +
              `언제나 따뜻한 미소와 적극적인 배려로 동료들에게 큰 힘이 되어 주셔서 깊이 감사드립니다.\n\n` +
              `우리 모두 서로 격려하고 고마움을 나누는 밝은 직장 분위기가 이어지길 바라며, ${selectedName}님의 행복한 하루를 응원합니다! 👍`;
  } else if (day === 3) {
    // 수요일: "긍정 문구" 카테고리로 "오늘의 행복 한마디" 포스팅.
    // 1순위) 외부 API(행복 명언)로 매주 새로운 글을 자동 수집 — 월요일(일반 명언)과 "행복" 테마로 차별화.
    // 2순위) API 실패 시 data/life-tips.json을 주차 순환 선택하여 폴백.
    categoryName = "긍정 문구";
    let happinessFetched = false;
    try {
      console.log('Fetching happiness quote from API...');
      const response = await fetch('https://api.sobabear.com/happiness/random-quote');
      if (response.ok) {
        const json = await response.json();
        const data = json && json.data;
        if (data && data.content) {
          title = `🍀 [오늘의 행복 한마디] ${data.author || ''}의 한마디`.replace(/\s+의 한마디$/, '의 한마디');
          content = `"${data.content}"\n\n- ${data.author || '행복 명언'} -`;
          happinessFetched = true;
          console.log(`Successfully fetched happiness quote: ${title}`);
        } else {
          console.log('Happiness API response missing content, will fall back.');
        }
      } else {
        console.log(`Failed to fetch happiness quote, status: ${response.status}, will fall back.`);
      }
    } catch (apiError) {
      console.log('Error fetching happiness API, will fall back to life-tips.json:', apiError.message);
    }

    // 폴백: 외부 API 실패 시 로컬 생활정보 목록을 주차 순환으로 사용
    if (!happinessFetched) {
      try {
        const fs = require('fs');
        const path = require('path');
        const tipsFile = path.join(__dirname, 'data', 'life-tips.json');

        if (fs.existsSync(tipsFile)) {
          const tips = JSON.parse(fs.readFileSync(tipsFile, 'utf8'));
          if (Array.isArray(tips) && tips.length > 0) {
            // 연중 주차(week-of-year)로 인덱스를 정해 매주 다음 글이 순서대로 등록되도록 함
            const weekOfYear = getWeekOfYear(kstDate);
            const tip = tips[weekOfYear % tips.length];
            title = `💡 [알면 도움이 되는 생활 정보] ${tip.title}`;
            content = tip.content;
            console.log(`Fallback: selected life tip (week ${weekOfYear}): ${tip.title}`);
          } else {
            console.log('life-tips.json is empty, using default content.');
          }
        } else {
          console.log(`life-tips.json not found at ${tipsFile}, using default content.`);
        }
      } catch (tipError) {
        console.error('Error reading life-tips.json, using default content:', tipError);
      }
    }
  } else {
    // 월요일(및 그 외 수동 실행일): "긍정 문구" 카테고리로 "오늘의 명언 + 의미 해설" 포스팅.
    // data/quotes.json(명언+저자+해설)을 주차 순환 선택 → 매주 다른 명언과 함께 정확한 의미 해설이 등록됨.
    categoryName = "긍정 문구";
    try {
      const fs = require('fs');
      const path = require('path');
      const quotesFile = path.join(__dirname, 'data', 'quotes.json');

      if (fs.existsSync(quotesFile)) {
        const quotes = JSON.parse(fs.readFileSync(quotesFile, 'utf8'));
        if (Array.isArray(quotes) && quotes.length > 0) {
          // 연중 주차(week-of-year)로 인덱스를 정해 매주 다음 명언이 순서대로 등록되도록 함
          const weekOfYear = getWeekOfYear(kstDate);
          const q = quotes[weekOfYear % quotes.length];
          const author = q.profile ? `${q.author} (${q.profile})` : q.author;
          // 저자가 사람이면 "○○의 한마디", 속담/격언 등이면 라벨만 표기
          title = q.profile ? `💡 [오늘의 명언] ${q.author}의 한마디` : `💡 [오늘의 명언] ${q.author}`;
          content = `"${q.quote}"\n\n- ${author} -\n\n💬 의미: ${q.meaning}`;
          console.log(`Selected quote (week ${weekOfYear}): ${q.author}`);
        } else {
          console.log('quotes.json is empty, using default content.');
        }
      } else {
        console.log(`quotes.json not found at ${quotesFile}, using default content.`);
      }
    } catch (quoteError) {
      console.error('Error reading quotes.json, using default content:', quoteError);
    }
  }

  try {
    // ── Step 1: Select the post category ──
    // The page first shows a category picker: "어떤 글을 작성하시겠어요?"
    //   - 긍정 문구 (+10 물방울)
    //   - 동료 칭찬 (+30 물방울)
    //   - 퀘스트 (준비중)
    // We need to click categoryName before the title/content form appears.
    console.log(`Selecting post category: ${categoryName}...`);

    const categorySelectors = [
      `text=${categoryName}`,
      `:text("${categoryName}")`,
      `div:has-text("${categoryName}")`,
      `button:has-text("${categoryName}")`,
      `a:has-text("${categoryName}")`,
    ];

    let categoryClicked = false;
    for (const sel of categorySelectors) {
      console.log(`Trying category selector: ${sel}`);
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state: 'visible', timeout: 10000 });
        await loc.click();
        categoryClicked = true;
        console.log(`Clicked category with selector: ${sel}`);
        break;
      } catch {
        console.log(`Category selector ${sel} not found, trying next...`);
      }
    }

    if (!categoryClicked) {
      // Maybe the category was already selected (page remembered last choice)
      console.log('Could not find category buttons. Checking if form is already visible...');
    }

    // Wait for the form to render after category selection
    console.log('Waiting for post form to appear...');
    await page.waitForTimeout(3000);

    // Log the page state after category selection
    const bodyText = await page.locator('body').innerText();
    console.log('Page body text after category (first 500 chars):', bodyText.substring(0, 500));

    // ── Step 2: Fill the title ──
    console.log('Filling post title...');
    const titleSelectors = [
      'input[placeholder*="제목"]',
      'input[name="title"]',
      'input[type="text"]',
    ];

    let titleInput = null;
    for (const sel of titleSelectors) {
      console.log(`Trying title selector: ${sel}`);
      const loc = page.locator(sel).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: 10000 });
        titleInput = loc;
        console.log(`Found title input with selector: ${sel}`);
        break;
      } catch {
        console.log(`Selector ${sel} not found, trying next...`);
      }
    }

    if (!titleInput) {
      const html = await page.content();
      console.log('Full page HTML (first 3000 chars):', html.substring(0, 3000));
      throw new Error('Could not find any title input element on the posting page.');
    }

    await titleInput.fill(title);
    console.log('Title filled successfully.');

    // ── Step 2.5: Tag the co-worker (동료 칭찬 카테고리 전용, 필수 항목) ──
    // "태그할 동료" 필드는 자동완성 방식이라 이름을 입력한 뒤 드롭다운 항목을 클릭해야 실제 태그가 됩니다.
    // 이 필드를 채우지 않으면 등록이 유효성 검증에서 막힙니다.
    if (taggedCoworker) {
      console.log(`Tagging co-worker: ${taggedCoworker}...`);
      const tagSelectors = [
        'input[placeholder*="동료"]',
        'input[placeholder*="태그"]',
        'input[placeholder*="이름"]',
        'input[placeholder*="검색"]',
      ];

      let tagInput = null;
      for (const sel of tagSelectors) {
        console.log(`Trying tag-coworker selector: ${sel}`);
        const loc = page.locator(sel).first();
        try {
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          tagInput = loc;
          console.log(`Found tag-coworker input with selector: ${sel}`);
          break;
        } catch {
          console.log(`Tag selector ${sel} not found, trying next...`);
        }
      }

      if (!tagInput) {
        // 어떤 input들이 있는지 진단용으로 남김 — 태그 없이는 등록이 막히므로 명시적으로 실패 처리.
        const inputsInfo = await page.locator('input').evaluateAll(
          els => els.map(e => ({ placeholder: e.placeholder, name: e.name, type: e.type }))
        ).catch(() => []);
        console.log('Available inputs on page:', JSON.stringify(inputsInfo));
        throw new Error('Could not find the "태그할 동료" input. 동료 칭찬 requires tagging a co-worker.');
      }

      // 이름을 입력하고 자동완성 드롭다운에서 정확히 일치하는 항목을 선택
      await tagInput.click();
      await tagInput.fill('');
      await tagInput.type(taggedCoworker, { delay: 120 });
      await page.waitForTimeout(1500);

      const optionSelectors = [
        `li:has-text("${taggedCoworker}")`,
        `[role="option"]:has-text("${taggedCoworker}")`,
        `div[class*="option"]:has-text("${taggedCoworker}")`,
        `div[class*="item"]:has-text("${taggedCoworker}")`,
        `ul li:has-text("${taggedCoworker}")`,
      ];

      let tagged = false;
      for (const sel of optionSelectors) {
        const opt = page.locator(sel).first();
        try {
          await opt.waitFor({ state: 'visible', timeout: 3000 });
          await opt.click();
          tagged = true;
          console.log(`Selected co-worker from dropdown with selector: ${sel}`);
          break;
        } catch {
          console.log(`Dropdown option selector ${sel} not found, trying next...`);
        }
      }

      if (!tagged) {
        throw new Error(`Could not select co-worker "${taggedCoworker}" from the autocomplete results.`);
      }

      // 자동완성 항목을 클릭해도 실제 React 상태에 반영되지 않는 경우가 있으므로,
      // 선택된 동료 칩이 생겼는지 제출 전에 확인한다.
      await page.waitForTimeout(500);
      const selectedTag = page.getByText(
        new RegExp(`^@${escapeRegExp(taggedCoworker)}(?:$|\\()`)
      ).first();
      const selectedTagText = await selectedTag.innerText().catch(() => '');
      const tagInputVisible = await tagInput.isVisible().catch(() => false);
      const tagInputValue = tagInputVisible ? await tagInput.inputValue().catch(() => '') : '';
      const tagConfirmed = await selectedTag.isVisible().catch(() => false);

      console.log(
        `Co-worker tag confirmation: confirmed=${tagConfirmed}, ` +
        `inputVisible=${tagInputVisible}, inputValue="${tagInputValue}", ` +
        `section="${selectedTagText.replace(/\s+/g, ' ').trim().slice(0, 200)}"`
      );
      if (!tagConfirmed) {
        throw new Error(
          `Co-worker "${taggedCoworker}" was clicked, but the selected tag chip was not confirmed.`
        );
      }
    }

    // ── Step 3: Fill the content ──
    console.log('Filling post content...');
    const contentSelectors = [
      'textarea[placeholder*="내용"]',
      'textarea[name="content"]',
      'textarea',
      'div[contenteditable="true"]',
      '.toastui-editor-contents',
    ];

    let contentArea = null;
    for (const sel of contentSelectors) {
      console.log(`Trying content selector: ${sel}`);
      const loc = page.locator(sel).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: 10000 });
        contentArea = loc;
        console.log(`Found content area with selector: ${sel}`);
        break;
      } catch {
        console.log(`Selector ${sel} not found, trying next...`);
      }
    }

    if (!contentArea) {
      throw new Error('Could not find any content textarea on the posting page.');
    }

    await contentArea.fill(content);
    console.log('Content filled successfully.');

    // ── Step 4: Submit ──
    console.log('Clicking the post submit button...');
    const submitSelectors = [
      'button:has-text("등록하기")',
      'button:has-text("등록")',
      'button:has-text("작성")',
      'button[type="submit"]',
    ];

    let submitBtn = null;
    for (const sel of submitSelectors) {
      const loc = page.locator(sel).last();
      try {
        await loc.waitFor({ state: 'visible', timeout: 5000 });
        submitBtn = loc;
        console.log(`Found submit button with selector: ${sel}`);
        break;
      } catch {
        continue;
      }
    }

    if (!submitBtn) {
      throw new Error('Could not find any submit button on the posting page.');
    }

    if (await submitBtn.isDisabled()) {
      const formError = await getVisibleFormError(page);
      throw new Error(
        `Post submit button is disabled.${formError ? ` Form error: ${formError}` : ''}`
      );
    }

    const urlBeforeSubmit = page.url();
    const postResponses = [];
    const dialogMessages = [];
    const responseListener = response => {
      if (response.request().method() === 'POST') postResponses.push(response);
    };
    // 등록 시 사이트가 확인 대화상자(예: "등록하시겠습니까?")를 띄우는 경우가 있다.
    // 이때 dismiss()로 닫으면 등록이 '취소'되어 작성 폼에 그대로 머무른다 —
    // 이것이 이슈 #2(태그·내용이 모두 채워졌는데도 폼이 사라지지 않던 현상)의 실제 원인이다.
    // (Playwright는 핸들러가 없으면 대화상자를 자동 dismiss 하므로 과거 실행도 동일하게 취소됨.)
    // 따라서 accept()로 등록을 진행시킨다. alert 성격의 대화상자는 accept/dismiss 동작이 동일하다.
    const dialogListener = async dialog => {
      const message = dialog.message();
      dialogMessages.push(message);
      console.log(`Browser dialog after submit: type=${dialog.type()}, message="${message}"`);
      await dialog.accept().catch(() => {});
    };
    page.on('response', responseListener);
    page.on('dialog', dialogListener);

    // ── Step 5: 등록 성공 신호(주소 변경 또는 작성 폼 사라짐)를 최대 15초간 폴링 ──
    // 확인 대화상자를 accept한 뒤 실제 네비게이션이 일어나는 시간까지 함께 기다린다.
    // 등록 버튼 클릭만으로는 성공을 알 수 없으므로(필수 필드 누락·확인창 취소 시 폼에 그대로 남음)
    // 이 신호를 확인해 조용한 실패를 잡아낸다.
    let submitVerified = false;
    try {
      await submitBtn.click();

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (page.url() !== urlBeforeSubmit) {
          submitVerified = true;
          break;
        }
        const formGone = !(await page
          .locator('button:has-text("등록하기")')
          .first()
          .isVisible()
          .catch(() => false));
        if (formGone) {
          submitVerified = true;
          break;
        }
        // 주 1회/일 1회 제한 안내가 뜬 경우, 이미 등록된 것으로 보고 성공 처리
        if (dialogMessages.some(isAlreadyCompletedMessage)) {
          submitVerified = true;
          break;
        }
        await page.waitForTimeout(500);
      }
    } finally {
      page.off('response', responseListener);
      page.off('dialog', dialogListener);
    }

    if (!submitVerified) {
      const dialogError = dialogMessages.join(' | ');
      // 제한 안내(주 1회 등)를 뒤늦게 확인한 경우에도 성공으로 간주
      if (dialogError && isAlreadyCompletedMessage(dialogError)) {
        console.log(
          `Post was already completed for the allowed period; treating this rerun as successful: ${dialogError}`
        );
        return;
      }

      const bodyAfter = await page.locator('body').innerText().catch(() => '');
      const formError = await getVisibleFormError(page);
      const responseDetails = [];
      for (const response of postResponses) {
        const body = await readResponseBody(response);
        responseDetails.push(
          `${response.status()} ${response.url()}${body ? ` — ${body}` : ''}`
        );
      }
      console.log('Page body text after submit (first 500 chars):', bodyAfter.substring(0, 500));
      console.log(
        'POST responses after submit:',
        responseDetails.length > 0 ? responseDetails.join(' | ') : '(none captured)'
      );
      if (formError) console.log('Visible form error after submit:', formError);

      const diagnostic = [
        dialogError ? `browser dialog: ${dialogError}` : '',
        formError ? `form error: ${formError}` : '',
        responseDetails.length > 0 ? `POST responses: ${responseDetails.join(' | ')}` : 'no POST response captured',
      ].filter(Boolean).join('; ');
      throw new Error(
        `Post submission failed: still on the write form after clicking 등록하기; ${diagnostic}`
      );
    }

    console.log('Post completed successfully!');
  } catch (err) {
    console.log('Error during post submission:', err);
    throw err;
  }
}

// data/lottery.json에서 응모 대상 물품 목록을 읽어 정규화한다.
function loadLotteryTargets() {
  const fs = require('fs');
  const path = require('path');
  const lotteryFile = path.join(__dirname, 'data', 'lottery.json');

  if (!fs.existsSync(lotteryFile)) {
    console.log(`lottery.json not found at ${lotteryFile}. No lottery targets configured.`);
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(lotteryFile, 'utf8'));
    const targets = normalizeLotteryTargets(parsed);
    if (targets.length === 0) {
      console.log('lottery.json is empty or has no valid entries.');
    }
    return targets;
  } catch (err) {
    console.error('Error reading lottery.json:', err);
    throw new Error(`Cannot read lottery targets: ${err.message}`);
  }
}

// 뽑기 페이지의 각 카드 정보를 수집하고, 카드별 "뽑기" 버튼에 data-gacha-index 속성을 부여한다.
// (버튼에 인덱스를 심어두면, 순수 계산으로 고른 대상을 Playwright로 정확히 클릭할 수 있다.)
async function collectGachaCards(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter(btn => /뽑기/.test(btn.textContent || ''));

    const cards = [];
    buttons.forEach((btn, i) => {
      // 버튼에서 위로 올라가며 "당첨확률"을 포함하는 가장 가까운 조상(=카드)을 찾는다.
      let el = btn;
      let card = null;
      for (let depth = 0; depth < 10 && el; depth++) {
        if ((el.textContent || '').includes('당첨확률')) { card = el; break; }
        el = el.parentElement;
      }
      const source = card || btn;
      btn.setAttribute('data-gacha-index', String(i));
      cards.push({
        index: i,
        text: (source.textContent || '').replace(/\s+/g, ' ').trim(),
      });
    });
    return cards;
  });
}

// 특정 카드의 "뽑기" 버튼을 클릭해 1회 응모한다. 응모 성공 여부와 사이트 메시지를 반환한다.
async function drawGachaCard(page, index) {
  const btn = page.locator(`button[data-gacha-index="${index}"]`).first();

  try {
    await btn.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return { success: false, message: 'draw button not found' };
  }

  if (await btn.isDisabled().catch(() => false)) {
    return { success: false, message: 'draw button is disabled' };
  }

  // 응모 시 확인 대화상자가 뜨면 accept 하여 진행한다. (handlePost와 동일한 처리)
  const dialogMessages = [];
  const dialogListener = async dialog => {
    dialogMessages.push(dialog.message());
    console.log(`Browser dialog during draw: type=${dialog.type()}, message="${dialog.message()}"`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', dialogListener);

  try {
    await btn.click({ force: true });
    await page.waitForTimeout(3000);
  } finally {
    page.off('dialog', dialogListener);
  }

  // 화면 토스트/알림과 대화상자 메시지를 모아 부족·실패 여부를 판단한다.
  const toast = await getVisibleFormError(page).catch(() => '');
  const combined = [dialogMessages.join(' | '), toast].filter(Boolean).join(' | ');

  if (isInsufficientDropletMessage(combined)) {
    return { success: false, insufficient: true, message: combined };
  }
  if (/실패|오류|에러/.test(combined)) {
    return { success: false, message: combined };
  }

  return { success: true, message: combined };
}

async function handleGacha(page) {
  console.log('Navigating to gacha (물방울 뽑기) page...');
  await page.goto(`${SITE_URL}gacha`, { waitUntil: 'networkidle', timeout: 30000 });

  // Next.js CSR 페이지 — React 마운트를 기다린다.
  console.log('Waiting for Next.js CSR hydration...');
  await page.waitForTimeout(5000);

  const targets = loadLotteryTargets();
  if (targets.length === 0) {
    console.log('No lottery targets configured in data/lottery.json. Nothing to do.');
    return;
  }
  console.log(
    `Lottery targets: ${targets.map(t => `${t.name}(>=${t.minProbability}%)`).join(', ')}`
  );

  const pageText = await page.locator('body').innerText();
  const draws = parseRemainingDraws(pageText);
  let remaining = draws ? draws.remaining : null;
  console.log(`Remaining draws today: ${draws ? `${draws.remaining}/${draws.total}` : 'unknown'}`);
  if (remaining === 0) {
    console.log('No draws remaining today. Skipping.');
    return;
  }

  const cards = await collectGachaCards(page);
  console.log(`Found ${cards.length} gacha card(s).`);
  if (cards.length === 0) {
    console.log('Page body text (first 500 chars):', pageText.substring(0, 500));
    throw new Error('GACHA_NO_CARDS: 뽑기 카드를 찾을 수 없습니다.');
  }

  const plan = planLotteryDraws(cards, targets);
  for (const entry of plan) {
    const prob = entry.probability != null ? `${entry.probability}%` : 'N/A';
    console.log(`Plan — ${entry.name}: status=${entry.status}, probability=${prob}, minProbability=${entry.minProbability}%`);
  }

  let drawn = 0;
  for (const entry of plan) {
    if (entry.status !== 'eligible') {
      console.log(`- ${entry.name}: skip (${entry.status})`);
      continue;
    }
    if (remaining != null && remaining <= 0) {
      console.log(`- ${entry.name}: skip (no draws remaining today)`);
      continue;
    }

    console.log(
      `- ${entry.name}: entering lottery ` +
      `(당첨확률 ${entry.probability}% >= 기준 ${entry.minProbability}%), 물방울 -${LOTTERY_DRAW_COST} 예상`
    );
    const result = await drawGachaCard(page, entry.index);
    if (result.success) {
      drawn++;
      if (remaining != null) remaining -= 1;
      console.log(`  ✅ ${entry.name} 응모 완료.${result.message ? ` (${result.message})` : ''}`);
    } else if (result.insufficient) {
      console.log(`  ⛔ 물방울이 부족하여 응모를 중단합니다. (${result.message})`);
      break;
    } else {
      console.log(`  ⚠️ ${entry.name} 응모 실패: ${result.message || 'unknown reason'}`);
    }

    // 연속 클릭으로 인한 UI 처리 지연을 피하기 위해 잠시 대기
    await page.waitForTimeout(1500);
  }

  console.log(`Gacha finished. Draws performed: ${drawn} (물방울 약 ${drawn * LOTTERY_DRAW_COST} 차감).`);
}

module.exports = {
  runBot,
  // Exported for focused unit tests; browser workflow remains behind runBot.
  isAlreadyCompletedMessage,
  summarizeResponseBody,
  getWeekOfYear,
  // 물방울 뽑기(gacha) 순수 유틸 — 브라우저 없이 단위 테스트 가능.
  parseGachaProbability,
  parseGachaStock,
  parseRemainingDraws,
  isInsufficientDropletMessage,
  normalizeLotteryTargets,
  planLotteryDraws,
  DEFAULT_LOTTERY_THRESHOLD,
  LOTTERY_DRAW_COST,
};

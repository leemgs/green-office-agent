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
          const randomIndex = Math.floor(Math.random() * names.length);
          selectedName = names[randomIndex];
          console.log(`Selected co-worker for praise: ${selectedName}`);
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
    title = `${selectedName}을 칭찬합니다.`;
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
            const startOfYear = new Date(kstDate.getFullYear(), 0, 1);
            const weekOfYear = Math.floor((kstDate - startOfYear) / (7 * 24 * 60 * 60 * 1000));
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
          const startOfYear = new Date(kstDate.getFullYear(), 0, 1);
          const weekOfYear = Math.floor((kstDate - startOfYear) / (7 * 24 * 60 * 60 * 1000));
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
    let resolveDialog;
    const dialogReceived = new Promise(resolve => {
      resolveDialog = resolve;
    });
    const responseListener = response => {
      if (response.request().method() === 'POST') postResponses.push(response);
    };
    const dialogListener = async dialog => {
      const message = dialog.message();
      dialogMessages.push(message);
      console.log(`Browser dialog after submit: type=${dialog.type()}, message="${message}"`);
      await dialog.dismiss().catch(() => {});
      resolveDialog();
    };
    page.on('response', responseListener);
    page.on('dialog', dialogListener);

    try {
      await submitBtn.click();
      const submitOutcome = await Promise.race([
        page.waitForURL(url => url.toString() !== urlBeforeSubmit, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        }).then(() => 'navigated'),
        dialogReceived.then(() => 'dialog'),
        page.waitForTimeout(15000).then(() => 'timeout'),
      ]).catch(() => {});

      // alert를 닫은 직후 React의 finally 블록이 제출 상태를 되돌릴 시간을 준다.
      if (submitOutcome === 'dialog') {
        await page.locator('button:has-text("등록하기")').first().waitFor({
          state: 'visible',
          timeout: 3000,
        }).catch(() => {});
      }
    } finally {
      page.off('response', responseListener);
      page.off('dialog', dialogListener);
    }

    // ── Step 5: Verify the post was actually created ──
    // 등록 버튼 클릭만으로는 성공을 알 수 없음(필수 필드 누락 시 유효성 검증에서 막힘).
    // 성공하면 보통 작성 페이지를 벗어나거나 폼이 사라짐 → 이를 확인해 조용한 실패를 잡아낸다.
    const urlAfterSubmit = page.url();
    const urlChanged = urlAfterSubmit !== urlBeforeSubmit;

    // 작성 폼이 아직 그대로 남아 있으면(등록 버튼이 여전히 보임) 등록 실패로 간주
    let formStillPresent = false;
    try {
      formStillPresent = await page.locator('button:has-text("등록하기")').first().isVisible({ timeout: 2000 });
    } catch {
      formStillPresent = false;
    }

    if (!urlChanged && formStillPresent) {
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

      const dialogError = dialogMessages.join(' | ');
      if (dialogError && isAlreadyCompletedMessage(dialogError)) {
        console.log(
          `Post was already completed for the allowed period; treating this rerun as successful: ${dialogError}`
        );
        return;
      }

      const diagnostic = [
        dialogError ? `browser alert: ${dialogError}` : '',
        formError ? `form error: ${formError}` : '',
        responseDetails.length > 0 ? `POST responses: ${responseDetails.join(' | ')}` : 'no POST response captured',
      ].filter(Boolean).join('; ');
      throw new Error(
        `Post submission failed: still on the write form after clicking 등록하기; ${diagnostic}`
      );
    }

    console.log(`Post completed successfully! (url changed: ${urlChanged}, form gone: ${!formStillPresent})`);
  } catch (err) {
    console.log('Error during post submission:', err);
    throw err;
  }
}

module.exports = {
  runBot,
  // Exported for focused unit tests; browser workflow remains behind runBot.
  isAlreadyCompletedMessage,
  summarizeResponseBody,
};

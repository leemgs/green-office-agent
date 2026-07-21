# 🌿 그린메이커 자동화 봇 (Green Maker Auto Bot)

이 프로젝트는 [그린메이커(green-office.uk)](https://green-office.uk/) 커뮤니티 활동을 자동화하기 위한 도구입니다. GitHub Actions 스케줄에 따라 **평일 오전 7시에는 자동 출석체크**를, **월·수·금 오전 9시에는 요일별 자동 포스팅**을 수행합니다.

---

## 🔎 한눈에 보기 (At a Glance)

이 프로젝트는 **① GitHub Actions 스케줄(트리거)** → **② 봇(`bot.js` + Playwright)** → **③ 그린메이커 사이트**로 이어지는 단순한 파이프라인입니다. 포스팅에 필요한 글감은 로컬 데이터 파일과 외부 API에서 가져오고, 실행이 실패하면 GitHub Issue가 자동으로 생성됩니다.

```mermaid
flowchart LR
    subgraph TRIGGER["⏰ 트리거 (GitHub Actions cron)"]
        A1["출석 워크플로우<br/>평일 07:00 KST"]
        A2["포스팅 워크플로우<br/>월·수·금 09:00 KST"]
    end

    subgraph SRC["📚 콘텐츠 소스"]
        Q["data/quotes.json<br/>(명언 100개)"]
        L["data/life-tips.json<br/>(생활정보 100개)"]
        C["data/coworkers.txt<br/>(동료 명단)"]
        API["행복 명언 API<br/>(api.sobabear.com)"]
    end

    subgraph BOT["🤖 자동화 봇 (bot.js · Playwright Stealth)"]
        LOGIN["🔐 로그인"]
        ATT["✅ 출석체크"]
        POST["📝 자동 포스팅"]
        LOGIN --> ATT
        LOGIN --> POST
    end

    SITE["🌿 green-office.uk"]
    ISSUE["🐙 GitHub Issue<br/>자동 생성"]

    A1 --> LOGIN
    A2 --> LOGIN
    Q --> POST
    L --> POST
    C --> POST
    API --> POST
    ATT --> SITE
    POST --> SITE
    BOT -. 실행 실패 시 .-> ISSUE
```

| 구성 요소 | 역할 | 관련 파일 |
|-----------|------|-----------|
| **트리거** | 정해진 시각에 봇을 실행하는 GitHub Actions 스케줄 (cron) | [`.github/workflows/auto-attendance.yml`](.github/workflows/auto-attendance.yml), [`.github/workflows/auto-post.yml`](.github/workflows/auto-post.yml) |
| **봇 엔진** | Playwright(스텔스)로 로그인·출석·포스팅을 수행하는 핵심 로직 | [`bot.js`](bot.js), [`index.js`](index.js) |
| **콘텐츠 소스** | 요일별 포스팅 글감 (명언·생활정보·동료 명단·외부 API) | [`data/quotes.json`](data/quotes.json), [`data/life-tips.json`](data/life-tips.json), [`data/coworkers.txt`](data/coworkers.txt) |
| **대상 사이트** | 실제 활동이 반영되는 그린메이커 커뮤니티 | [green-office.uk](https://green-office.uk/) |
| **실패 알림** | 실행 실패 시 상세 로그를 담아 자동 생성되는 GitHub Issue | (워크플로우의 `failure()` 단계) |

---

## ✨ 주요 기능

- **자동 로그인**: 설정된 계정 정보를 사용하여 안전하게 접속합니다.
- **매일 자동 출석체크 (오전 7시)**: `오늘도 화이팅` 문구와 함께 자동으로 출석체크를 완료합니다.
- **주간 자동 포스팅 (월·수·금 오전 9시)**: 요일별로 카테고리와 내용이 다른 글을 매주 자동으로 포스팅합니다.

---

## 📅 주간 자동 포스팅 방식

매주 **월·수·금 오전 9시(KST)** 에 포스팅이 실행되며, 요일마다 글의 출처와 "새로운 글을 가져오는 방식"이 다릅니다. (관련 로직: [`bot.js`](bot.js), 스케줄: [`.github/workflows/auto-post.yml`](.github/workflows/auto-post.yml))

| 요일 | 카테고리 | 내용 | 출처 | 새 글을 가져오는 방식 | 중복 방지 |
|------|----------|------|------|----------------------|-----------|
| **월** | 긍정 문구 | 오늘의 명언 + 의미 해설 | 로컬 파일 (`data/quotes.json`) | 연중 **주차(week-of-year) 번호 % 목록 개수** 로 다음 명언을 순서대로 선택 (명언+저자+해설을 함께 게시) | ✅ **목록 한 바퀴까지 중복 없음** (현재 100개 → 약 100주 주기로 순환) |
| **수** | 긍정 문구 | 오늘의 행복 한마디 | 외부 API (`api.sobabear.com` 행복 명언) → 실패 시 로컬 `data/life-tips.json` 폴백 | API가 **날짜별로 바뀌는** 행복 명언 반환 (월요일 일반 명언과 "행복" 테마로 차별화). 실패 시 로컬 목록을 **주차 순환** | ⚠️ API는 **보장 안 됨**(이력 미기록) / 폴백 시 ✅ 한 바퀴까지 중복 없음 |
| **금** | 동료 칭찬 | ***을 칭찬합니다. | 로컬 파일 (`data/coworkers.txt`) | 월·수요일과 동일하게 연중 **주차(week-of-year) 번호 % 목록 개수** 로 다음 동료를 순서대로 선택 | ✅ **목록 한 바퀴까지 중복 없음** (현재 16명 → 약 16주 주기로 순환, 직전 주와 동일인 없음) |

> [!NOTE]
> - **수요일**은 외부 행복 명언 API를 우선 사용하고, API 장애 시 `data/life-tips.json`(주차 순환)으로 자동 폴백합니다. 폴백 목록을 늘리려면 `data/life-tips.json`에 `{ "title": "...", "content": "..." }` 항목을 추가하세요.
> - **월요일**은 `data/quotes.json`(명언+해설)을 주차 순환하므로 목록을 다 쓰기 전까지 중복이 없습니다. 명언을 추가하려면 `data/quotes.json`에 `{ "quote": "...", "author": "...", "profile": "...", "meaning": "..." }` 항목을 더 넣으면 순환 주기가 길어집니다.
> - **금요일**은 `data/coworkers.txt`를 **주차 순환**하므로 목록을 다 쓰기 전까지 **직전 주와 같은 동료가 뽑히지 않습니다.** 대상 동료를 늘리려면 `data/coworkers.txt`에 이름을 한 줄에 하나씩 추가하면 순환 주기가 길어집니다.

---

## 🔁 동작 흐름 (Operation Flow)

봇은 크게 **출석체크**와 **자동 포스팅** 두 가지 시나리오로 동작합니다. 두 시나리오 모두 로그인으로 시작하며, 어느 단계에서든 실패하면 워크플로우의 `failure()` 단계가 실패 로그를 담아 GitHub Issue를 자동 생성합니다.

### 1) 출석체크 흐름 (평일 07:00 KST)

```mermaid
sequenceDiagram
    participant CRON as ⏰ GitHub Actions
    participant BOT as 🤖 bot.js
    participant SITE as 🌿 green-office.uk
    participant GH as 🐙 GitHub Issues

    CRON->>BOT: node index.js attendance
    BOT->>SITE: 로그인 (USER_ID / USER_PASSWORD)
    SITE-->>BOT: 로그인 성공
    BOT->>SITE: /attendance 페이지 이동
    alt 출석 가능 시간 (평일 06~11시)
        BOT->>SITE: 출석 옵션 선택 → "출석하기" 클릭
        SITE-->>BOT: 출석 완료
    else 시간 외 · 이미 출석함
        SITE-->>BOT: 거부 메시지 또는 "출석 완료" 감지 → 종료
    end
    opt 실행 실패
        BOT->>GH: 실패 로그로 이슈 자동 생성
    end
```

### 2) 자동 포스팅 흐름 (월·수·금 09:00 KST)

요일에 따라 글감을 가져오는 **데이터 소스가 달라지는 것**이 핵심입니다.

```mermaid
sequenceDiagram
    participant CRON as ⏰ GitHub Actions
    participant BOT as 🤖 bot.js
    participant DATA as 📚 데이터 소스 / API
    participant SITE as 🌿 green-office.uk
    participant GH as 🐙 GitHub Issues

    CRON->>BOT: node index.js post
    BOT->>SITE: 로그인
    Note over BOT: KST 기준 요일 판별 (getDay)
    alt 월요일 — 긍정 문구
        BOT->>DATA: quotes.json 주차 순환 선택
        DATA-->>BOT: 명언 + 저자 + 의미 해설
    else 수요일 — 긍정 문구(행복)
        BOT->>DATA: 행복 명언 API 호출
        DATA-->>BOT: 성공 시 행복 명언
        DATA-->>BOT: 실패 시 life-tips.json 폴백(주차 순환)
    else 금요일 — 동료 칭찬
        BOT->>DATA: coworkers.txt 주차 순환 선택
        DATA-->>BOT: 칭찬 대상 동료 이름
    end
    Note over BOT: 제목/내용 생성
    BOT->>SITE: 카테고리 선택 → 제목·내용 입력
    opt 금요일 (동료 칭찬)
        BOT->>SITE: "태그할 동료" 자동완성에서 동료 태그(필수)
    end
    BOT->>SITE: "등록하기" 클릭
    SITE-->>BOT: 등록 검증 (URL 변경 / 작성 폼 사라짐)
    opt 실행 실패
        BOT->>GH: 실패 로그로 이슈 자동 생성
    end
```

---

## 🛠 설치 및 로컬 실행 방법

로컬 환경(내 컴퓨터)에서 테스트하거나 실행하고 싶을 때 다음 단계를 따르세요.

### 1. 사전 요구 사항
- [Node.js](https://nodejs.org/) (v18 이상 권장) 가 설치되어 있어야 합니다.

### 2. 프로젝트 내려받기 및 의존성 설치
```bash
# 레포지토리 클론
git clone https://github.com/leemgs/my-auto-comment.git
cd my-auto-comment

# 필요한 패키지 설치
npm install

# Playwright 브라우저 엔진 설치
npx playwright install chromium
```

### 3. 환경 변수 설정
프로젝트 루트 디렉토리에 `.env` 파일을 만들고 로그인 정보를 입력합니다. ( `.env.example` 파일을 복사해서 사용하세요)

```bash
cp .env.example .env
```

`.env` 파일 내용 예시:
```env
USER_ID=your_id_here
USER_PASSWORD=your_password_here
SITE_URL=https://green-office.uk/
```

### 4. 실행 테스트
```bash
# 자동 댓글 테스트
node index.js comment

# 자동 포스팅 테스트
node index.js post
```

---

## 🤖 GitHub Actions로 자동화하기 (권장)

GitHub Actions를 설정하면 내 컴퓨터를 켜두지 않아도 매일 정해진 시간에 봇이 자동으로 실행됩니다.

### Step 1: 환경 변수(Secrets) 등록
GitHub 레포지토리 페이지에서 다음 설정을 수행합니다.
1. **Settings** 탭 클릭
2. 좌측 사이드바에서 **Secrets and variables > Actions** 클릭
3. **Secrets** 탭(기본값)인지 확인합니다. (Variables 탭이 아님을 주의하세요!)
4. **New repository secret** 버튼 클릭
5. 다음 두 항목을 각각 추가합니다:
   - 이름: `USER_ID` / 값: 본인의 그린메이커 아이디
   - 이름: `USER_PASSWORD` / 값: 본인의 그린메이커 비밀번호

> [!IMPORTANT]
> 반드시 **Secrets** 탭에 등록해야 합니다. **Variables** 탭에 등록할 경우 보안상 위험하며, 일부 워크플로우에서 인식되지 않을 수 있습니다.

### Step 2: 스케줄 확인
이미 `.github/workflows/auto.yml` 파일에 스케줄이 설정되어 있습니다.
- **매일 오전 7시 (KST)**: 출석체크 수행
- **매주 목요일 오전 10시 (KST)**: 유익한 식물 정보(예: 오렌지자스민 키우기) 자동 포스팅

---

## ⚠️ 주의 사항 및 면책 조항
- 이 봇은 학습 및 개인적인 편의를 위해 제작되었습니다.
- 커뮤니티 운영 정책을 준수해 주세요. 과도한 자동 활동은 계정 정지의 원인이 될 수 있습니다.
- 본 도구의 사용으로 인해 발생하는 모든 책임은 사용자에게 있습니다.

---

## 📄 라이선스
MIT License

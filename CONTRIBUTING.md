# 기여 가이드 (Contributing)

이 프로젝트에 기여해 주셔서 감사합니다. 아래 규칙을 지켜 주세요.

## ✍️ 커밋 서명 (DCO Sign-off) — 필수

모든 커밋은 **반드시** 커밋 메시지 본문 끝에 다음 형식의 `Signed-off-by` 줄을 포함해야 합니다.

```
Signed-off-by: 이름 <이메일>
```

예시:

```
Signed-off-by: Geunsik Lim <leemgs@gmail.com>
```

이 서명은 [DCO(Developer Certificate of Origin)](https://developercertificate.org/)에 따라, 기여한 코드를 해당 라이선스로 제출할 권리가 있음을 증명하는 의미입니다.

### 서명하는 방법

커밋할 때 `-s`(또는 `--signoff`) 옵션을 사용하면 자동으로 추가됩니다.

```bash
git commit -s -m "커밋 제목"
```

`-s`가 넣어 주는 이름/이메일은 `git config`의 `user.name` / `user.email`을 사용하므로, 아래가 올바르게 설정되어 있어야 합니다.

```bash
git config user.name  "Geunsik Lim"
git config user.email "leemgs@gmail.com"
```

이미 작성한 커밋에 서명이 빠졌다면 다음으로 보완할 수 있습니다.

```bash
git commit --amend -s     # 마지막 커밋에 sign-off 추가
```

## 📝 커밋 메시지 형식

- 제목은 변경 내용을 간결하게 요약합니다. (예: `fix: 출석 예약 지연 대응`)
- 본문에는 **무엇을, 왜** 바꿨는지 적습니다.
- 본문 끝에 `Signed-off-by:` 줄을 둡니다.

```
<타입>: <제목>

<본문: 무엇을/왜 바꿨는지>

Signed-off-by: Geunsik Lim <leemgs@gmail.com>
```

## 🔀 브랜치 & PR

- `main`에 직접 푸시하지 말고 **별도 브랜치**에서 작업한 뒤 **Pull Request**로 병합합니다.
- PR을 올리기 전 로컬 테스트를 통과시켜 주세요.

```bash
npm install
npm test
```

## ✅ 테스트

- 순수 로직(시간창 판별, 뽑기 확률 파싱 등)은 `test/bot.test.js`에 단위 테스트를 추가합니다.
- `npm test`(= `node --test`)가 모두 통과해야 합니다.

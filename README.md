# FleetView

클로드 · 제미나이 · 지피티를 **작업 단위로** 한 판에서 관제하는 대시보드.

- 작업(워크플로우) 하나에 세 AI가 역할을 나눠 붙습니다. 예) `영상 만들기 → 수집(클로드) → 분석(제미나이) → 대본(지피티)`
- 앞 단계 산출물이 다음 단계 프롬프트의 `{{input}}` 으로 자동으로 넘어갑니다.
- Claude Code 세션은 자동으로 잡히고, 크롬 탭은 확장이 실시간으로 보고합니다.
- 카드를 누르면 그 자리에서 대화, 화살표를 누르면 그 화면으로 점프합니다.

## 1. 실행

```bash
node server/index.js
```

`start.cmd` 를 더블클릭해도 됩니다. 브라우저에서 http://localhost:7777 로 접속.

Node 18 이상. `@anthropic-ai/sdk` 하나만 의존합니다 (`npm install`).

## 2. 크롬 확장 설치 (한 번만)

크롬 탭 현황, 탭 이동, 대시보드에서 웹 AI로 메시지 전송이 모두 이 확장을 통해 이뤄집니다.

1. 크롬에서 `chrome://extensions` 접속
2. 오른쪽 위 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** 클릭
4. 이 폴더의 `extension` 디렉터리 선택

상단의 배지가 **확장 연결됨** 으로 바뀌면 정상입니다.

## 3. 쓰는 법

### 세션 보기
- **클로드 / 제미나이 / 지피티** 3개 레인에 세션이 모입니다.
- Claude Code 세션은 `~/.claude/projects` 를 읽어 자동으로 올라옵니다.
  - `작업중` = AI가 지금 돌고 있음 · `내 차례` = 답변 대기 중 · `대기`/`멈춤` = 유휴
- 제미나이·지피티는 해당 사이트 탭을 열어두면 자동으로 올라옵니다.

### 이동
- 카드의 `→` 또는 드로어의 **이 화면으로 이동**
  - 크롬 탭이면 그 탭이 활성화되고 창이 앞으로 나옵니다.
  - Claude Code 세션이면 그 프로젝트 폴더에서 `claude --resume` 터미널이 새로 열립니다.

### 대시보드에서 바로 대화
- 카드를 클릭 → 오른쪽 드로어에 입력창. `Ctrl+Enter` 로 전송.
- **웹 탭**: 확장이 그 탭의 입력창에 실제로 글을 넣고 전송 버튼을 누른 뒤, 응답이 멈출 때까지 기다렸다가 결과를 되읽어 옵니다. 전송 중에는 그 탭을 닫지 마세요.
- **Claude Code**: `claude --resume <세션id>` 를 헤드리스로 실행합니다.
  세션 파일은 `parentUuid` 로 엮인 트리라서, 여기서 보낸 대화는 **곁가지로 갈라져** 들어갑니다.
  그 세션이 터미널에 열려 있어도 기록이 깨지지 않지만, 답변이 그 창에는 뜨지 않습니다.
  헷갈리지 않으려면 대시보드용으로는 다른 세션이나 새 세션을 쓰세요
  (담당에 세션을 고르지 않으면 새 세션이 생깁니다 — 구독으로 동작하며 API 과금 없음).

### 어댑터 계층

모든 AI 연결은 하나의 공통 규격을 지납니다. 대시보드와 워크플로우 엔진은 이 규격만
알고, 사업자별 차이(인증 방식, 이력이 어디 있는지, 스트리밍 프로토콜, 도구 호출 표현,
오류 형식)는 각 어댑터가 흡수합니다.

| 어댑터 | 종류 | 인증 | 이력 | 스트리밍 |
|---|---|---|---|---|
| `anthropic-api` | api | `ANTHROPIC_API_KEY` | 어댑터가 보관 | O |
| `claude-code` | cli | claude CLI 로그인 | `~/.claude/projects` | O |
| `claude-channel` | cli | claude CLI 로그인 | 실행 중 세션 | X |
| `codex-cli` | cli | ChatGPT 구독 | `~/.codex/sessions` | O |
| `claude-tab` | ui | 브라우저 세션 | claude.ai | X |
| `gemini-tab` | ui | 브라우저 세션 | gemini.google.com | X |
| `chatgpt-tab` | ui | 브라우저 세션 | chatgpt.com | X |
| `chatgpt-app` | ui | 앱 로그인 | ChatGPT 앱 | X |

- **api / cli** 는 공식 경로라 안정적입니다. 상대가 UI를 바꿔도 안 깨집니다.
- **ui** 는 공식 API가 없는 소비자 앱을 구독 그대로 쓰기 위한 경로입니다.
  DOM에 의존하므로 사이트 개편 시 `extension/pageAgent.js` 의 선택자를 고쳐야 합니다.

오류는 어댑터가 공통 코드로 변환합니다:
`auth` `rate_limit` `unavailable` `bad_request` `timeout` `unsupported` `not_found` `internal`.
각 오류에 `retryable` 이 붙어 있어 호출부가 재시도 여부를 판단할 수 있습니다.

```
GET  /api/adapters                   어댑터 목록 + 인증 상태
GET  /api/adapters/threads?id=<어댑터> 그 어댑터가 아는 대화 목록
POST /api/adapters/send              { id, threadId, text }
```

#### Anthropic API 어댑터 설정

키는 직접 넣으셔야 합니다(FleetView는 키를 저장하지 않고 환경변수에서만 읽습니다).

```
setx ANTHROPIC_API_KEY "발급받은-키"
```

PowerShell을 새로 열고 FleetView를 다시 시작하면 `연결됨` 으로 바뀝니다.
키는 console.anthropic.com 에서 발급하며, **API 사용료는 Claude 구독과 별도로 청구**됩니다.
구독으로 쓰던 claude.ai / Claude 앱의 대화 목록도 API와 공유되지 않습니다.

#### ChatGPT 데스크톱 앱

`connect-chatgpt-app.cmd` 를 탐색기에서 더블클릭하면 앱을 디버그 포트로 다시 띄웁니다.
FleetView 서버가 직접 하지 않는 이유는, Claude Code 가 데스크톱 앱 안에서 돌 때
서버가 앱을 종료하면 자기 자신까지 내려가기 때문입니다(조상 프로세스 검사로도 막아둠).

**Claude 데스크톱 앱은 연동 대상이 아닙니다.** 앱이 디버그 스위치를 거부합니다:

```
Claude: refusing to start - a debugging or network-override switch is present on the command line.
```

앱에 들어있는 보호 장치라 우회하지 않습니다. Claude 는 `claude-code`(구독 그대로),
`anthropic-api`(별도 과금), `claude-tab`(구독 그대로) 세 어댑터로 붙습니다.

### Claude Code 세션 — 채널로 붙이기 (권장)

`claude -p --resume` 는 **새 프로세스**를 띄웁니다. 그 세션이 터미널에 열려 있으면
두 프로세스가 각자 대화를 소유해 기록이 곁가지로 갈라집니다.

채널은 **이미 돌고 있는 세션에 직접** 메시지를 넣습니다. 주인이 하나라 갈라지지 않습니다.

**설치 (한 번만)**

```bash
claude mcp add --scope user fleetview -- node <경로>/fleetview/channel/fleetview-channel.js
```

**세션 띄우기 — 대시보드에서**

클로드 레인의 **`+ 세션`** 버튼 → 폴더 선택 → 채널이 붙은 창이 뜹니다.
기존 세션을 채널로 바꾸려면 그 카드를 눌러 **`채널로 다시 열기`** 를 누르세요.

**직접 띄우려면**

```bash
claude --dangerously-load-development-channels server:fleetview
claude --resume <세션id> --dangerously-load-development-channels server:fleetview
```

채널이 붙은 세션은 카드에 `채널 ·` 이 표시되고, 대시보드가 자동으로 그 경로로 보냅니다.
안 붙은 세션은 예전 방식으로 가며, 곁가지가 생긴다는 경고가 드로어에 뜹니다.

**제약**
- 이미 떠 있는 세션에는 나중에 못 붙입니다. 세션당 최초 1회 재시작이 필요합니다.
- 채널은 리서치 프리뷰라 커스텀 채널에 `--dangerously-load-development-channels` 가 필요합니다.

### ChatGPT — Codex CLI (권장)

ChatGPT 구독 로그인을 그대로 씁니다. API 키가 필요 없습니다.

```bash
codex login          # 한 번만
```

세션 목록은 `~/.codex/session_index.jsonl` 에서 읽고,
`codex exec` / `codex exec resume <id>` 로 새 세션과 기존 세션을 다룹니다.
화면 조종(`chatgpt-tab` / `chatgpt-app`)보다 이쪽이 안정적입니다.

### 작업(워크플로우) — 지금은 화면에서 뺐습니다

단계를 엮어 여러 AI에게 순서대로 시키는 기능입니다. 엔진(`server/workflow.js`)과
API 는 그대로 있고 화면만 빼둔 상태입니다. 필요해지면 대시보드에 다시 붙이면 됩니다.

## 구조

```
server/
  index.js          HTTP + SSE. 모든 엔드포인트
  store.js          중앙 상태, 영속화(data.json), SSE 브로드캐스트
  claudeSessions.js ~/.claude/projects/*.jsonl 꼬리를 읽어 세션 상태 추론
  claudeRunner.js   claude CLI 헤드리스 실행
  workflow.js       단계 실행 엔진, {{input}} 치환, 자동 연쇄
  bridge.js         크롬 확장 롱폴링 명령 큐
  cdp.js            최소 Chrome DevTools Protocol 클라이언트 (내장 WebSocket)
  appBridge.js      ChatGPT 앱 기동·제어, 조상 프로세스 안전장치
  channelHub.js     채널 세션별 큐 / 롱폴링 / 답장 매칭
  sessionLauncher.js 채널을 붙여 세션을 띄운다 (환경변수 정리 포함)
  adapters/
    contract.js     공통 규격, AdapterError, 등록소
    anthropic.js    Anthropic 공식 API (@anthropic-ai/sdk)
    claudeCode.js   claude CLI 래퍼
    browserUi.js    크롬 탭 / ChatGPT 앱 UI 자동화
    codexCli.js     Codex CLI (ChatGPT 구독)
    claudeChannel.js 실행 중 Claude 세션에 직접 주입
channel/
  fleetview-channel.js  Claude Code 채널 (stdio MCP 서버)
extension/pageAgent.js  페이지 조작 코드 — 확장과 서버(CDP)가 같은 파일을 공유
extension/          크롬 확장 (탭 보고 + 페이지 조작)
web/                대시보드 UI
data.json           작업/카드 저장 파일 (자동 생성)
```

## 알려진 한계

- 웹 AI 자동 전송은 각 사이트의 DOM 구조에 의존합니다. 사이트가 개편되면
  `extension/pageAgent.js` 의 `SEL` 선택자만 고치면 됩니다. 확장과 데스크톱 앱이
  이 파일 하나를 공유하므로 한 군데만 고치면 양쪽에 적용됩니다.
- 응답 완료 판정은 "스트리밍 표시가 사라지고 2초간 텍스트 변화 없음" 휴리스틱입니다.
- Claude Code 세션 상태는 트랜스크립트 파일의 마지막 기록으로 추론합니다.
- 데스크톱 앱은 스토어 패키지라 자동 업데이트 때 설치 경로의 버전이 바뀝니다.
  경로를 저장해두지 않고 매번 실행 중인 프로세스나 패키지 정보에서 새로 알아냅니다.
- 응답 왕복 시간은 상대 서비스에 달려 있습니다. 실측: ChatGPT 앱 약 10초, 제미나이 탭 약 50초.
- 데스크톱 앱 연동은 ChatGPT 만 됩니다. Claude 앱은 위 이유로 불가합니다.
- `ui` 종류 어댑터는 구조적으로 `api`/`cli` 보다 약합니다. 중요한 자동화는 API/CLI 어댑터로 거세요.

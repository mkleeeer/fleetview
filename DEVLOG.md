# FleetView 개발 기록 — 성공과 실패 전부

이 문서는 다른 AI나 개발자에게 넘기기 위한 **가감 없는** 작업 기록입니다.
잘 된 것보다 **막힌 것과 틀렸던 판단**을 더 자세히 적었습니다.

작성 시점: 2026-08-30 / 환경: Windows 11, Node 24.14.1, Claude Code 2.1.250

---

## 1. 목표

클로드 · 제미나이 · 지피티를 **한 판에서** 관리한다.

- 여러 세션이 동시에 돌 때 뭐가 어떤 상태인지 한눈에 본다
- 크롬 창/탭 현황도 같이 본다
- 카드를 누르면 **그 화면으로 이동**한다
- 대시보드에서 채팅을 치면 **해당 AI에 바로 전송**되고 답이 돌아온다
- **작업(워크플로우) 단위**로 묶는다. 한 작업 안에서 세 AI가 역할을 나눈다
  (예: 영상 만들기 → 수집=클로드 → 분석=제미나이 → 대본=지피티)

---

## 2. 최종 구조

```
로컬 서버(:7777) ── SSE ──> 대시보드
   ├── ~/.claude/projects/*.jsonl 꼬리 읽기 → Claude Code 세션 자동 인식
   ├── ~/.claude/sessions/<pid>.json      → 지금 열려 있는 세션 판별
   ├── 크롬 확장 ←→ 롱폴링                → 탭 현황 / 포커스 / 페이지 조작
   ├── CDP (WebSocket)                    → ChatGPT 데스크톱 앱
   └── claude CLI 헤드리스                → Claude Code 세션
```

모든 연결은 **어댑터 공통 규격**을 지납니다.

```js
id, provider, label
kind      // 'api' | 'cli' | 'ui'      — 어떻게 붙었나 (안정성)
agentType // 'coding' | 'chat'         — 뭘 할 수 있나
capabilities: { streaming, tools, history, threads, createThread }
async health()      -> { ok, reason }
async listThreads() -> [{ id, title, updatedAt, meta }]
async send({ threadId, text, cwd, onDelta }) -> { text, threadId, usage, toolCalls }
```

오류는 전부 `AdapterError` 로 정규화합니다:
`auth` `rate_limit` `unavailable` `bad_request` `timeout` `unsupported` `not_found` `internal`
각각 `retryable` 플래그가 붙습니다.

| 어댑터 | kind | agentType | 인증 | 상태 |
|---|---|---|---|---|
| `claude-code` | cli | coding | 구독 | 동작 확인 |
| `codex-cli` | cli | coding | ChatGPT 구독 | **기존 세션 이어가기 확인 (7.8초)** |
| `claude-channel` | cli | coding | 구독 | **실행 중 세션 직접 주입 확인 (12.3초)** |
| `anthropic-api` | api | chat | API 키 | **미검증** (키 없음) |
| `claude-tab` | ui | chat | 브라우저 | 미검증 |
| `gemini-tab` | ui | chat | 브라우저 | 읽기 확인, 전송 1회 성공 후 회귀 |
| `chatgpt-tab` | ui | chat | 브라우저 | 읽기 확인 |
| `chatgpt-app` | ui | chat | 앱 | 전송 왕복 확인 (9.8초) |

---

## 3. 검증된 것

| 항목 | 결과 |
|---|---|
| Claude Code 세션 자동 인식 | 15개 감지. 30MB jsonl 도 꼬리 96KB 만 읽어 부담 없음 |
| 세션 상태 추론 | `작업중 / 내 차례 / 대기 / 멈춤` — 마지막 엔트리 역할 + mtime |
| 열린 세션 판별 | `~/.claude/sessions/<pid>.json` + pid 생존 확인 |
| 워크플로우 엔진 | 단계 연쇄, `{{input}}` 치환, 사람 차례 정지/재개 전부 확인 |
| 크롬 확장 | 탭 12개 수집, 페이지 코드 주입 성공 |
| 제미나이 페이지 읽기 | `site=gemini`, 마지막 응답 회수 성공 |
| ChatGPT 앱 CDP | Chrome 151 기반, webview 타깃에서 DOM 조작 성공 |
| ChatGPT 앱 전송 왕복 | 9.8초, "연동 확인됨" 회수 |
| 제미나이 탭 전송 왕복 | 49.7초 성공 (이후 회귀, 아래 참고) |
| Claude Code 새 세션 생성 | 16.5초, 세션 14→15, 구독으로 동작 |
| 유휴 세션 선형 연결 | 트리 분석으로 확인. 곁가지 없음 |
| Codex CLI 기존 세션 이어가기 | `7` → `10` → `"7,10"`. 문맥 유지 확인. 7.8초 |
| **Claude 채널 주입** | 터미널에 살아있는 세션에 대시보드에서 전송 → `"채널 확인됨"` 회수. 12.3초. 새 프로세스 없음 |

---

## 4. 실패와 오판 (중요)

### 4.1 사용자 세션을 두 번 죽였다 — 가장 심각

Claude 앱을 디버그 포트로 재실행하려고 앱을 종료했습니다. 그때 사용자의
Claude Code 세션이 함께 죽었습니다. **두 번.**

원인이 두 겹이었습니다.

**첫 번째** — 프로세스를 이름으로 골랐습니다.

```powershell
Get-Process claude | Where-Object { $_.Path -like '*Claude.exe' } | Stop-Process
```

`claude` 라는 이름으로 도는 프로세스가 두 종류였습니다.

```
8개  C:\Program Files\WindowsApps\Claude_...\app\Claude.exe        ← 데스크톱 앱
2개  C:\Users\...\AppData\Roaming\Claude\claude-code\...\claude.exe ← Claude Code CLI
```

`*Claude.exe` 와일드카드가 둘 다 잡았습니다.

**두 번째 (진짜 원인)** — 경로를 좁혀도 여전히 죽었습니다. 부모 프로세스를 추적해 보니:

```
Claude Code CLI (49364)
  └ 부모: 43172  ...\WindowsApps\Claude_...\app\Claude.exe   ← 데스크톱 앱
      └ 부모: explorer.exe
```

**Claude Code 가 Claude 데스크톱 앱의 자식 프로세스**였습니다. 앱이 곧 호스트라
어떤 필터로도 막을 수 없었습니다.

**교훈:** 프로세스를 죽이기 전에 (1) 이름이 아니라 실행 파일 경로 완전 일치로 고르고,
(2) 종료 후보가 자기 자신의 조상인지 먼저 검사한다. 둘 다 구현했습니다.

### 4.2 Claude 앱 연결은 애초에 불가능했다

위 사고를 다 겪고 나서야 알았습니다. Claude 앱은 디버그 스위치가 붙으면
기동 자체를 거부합니다.

```
Claude: refusing to start — a debugging or network-override switch is present on the command line.
```

앱에 들어있는 보호 장치입니다. ChatGPT 앱은 허용하고 Claude 앱은 막습니다.
**우회하지 않고 대상에서 제외했습니다.**

**교훈:** 앱 UI 를 밖에서 조종하는 건 우회로다. 상대가 막으면 끝난다.
공식 API/CLI 가 있으면 그쪽이 정공법이다. 실제로 Claude 는 처음부터
`claude-code` CLI 어댑터로 붙어 있었고, 그게 답이었다.

### 4.3 프롬프트가 첫 단어만 전달되고 있었다 — 오래 안 보인 버그

```js
spawn('claude', ['-p', text, '--resume', id], { shell: true })
```

`shell: true` 는 인자를 이스케이프 없이 이어붙입니다. 그래서 공백에서 잘렸습니다.

```
보낸 것: "숫자 42만 답해. 다른 말 하지 마."
도착한 것: "숫자"
```

**대시보드에서 보낸 모든 메시지가 첫 단어만 전달되고 있었습니다.**
초기 테스트가 통과한 건 우연이었습니다 — `"새 세션 확인됨" 이라고만 답해` 처럼
따옴표로 감싼 부분이 살아남아서 그럴듯한 답이 돌아왔습니다.

**수정:** 프롬프트를 argv 가 아니라 stdin 으로 넘깁니다.

**교훈:** "답이 그럴듯하게 왔다" 는 검증이 아니다. **보낸 것이 그대로 도착했는지**
기록에서 확인해야 한다.

### 4.4 곁가지 판정을 잘못했다

대시보드에서 보낸 메시지가 세션에 안 보이길래 "곁가지로 갈라졌다" 고 보고했습니다.
트리를 제대로 그려보니 **완전히 선형**이었습니다.

원인: `user` / `assistant` 엔트리만 보고 부모를 따졌는데, 실제로는 사이사이에
`attachment` 엔트리가 끼어 있어서 부모가 안 맞는 것처럼 보였습니다.

```
user"새 세션 확인됨" → attachment×5 → assistant → attachment → user"." → ...
```

**정정된 사실:**
- 꺼져 있는 세션에 보내면 **선형으로 정상 연결**된다
- 지금 열려 있는 세션은 그 프로세스가 자기 메모리로 대화 중이라 갈라진다

**교훈:** 자료 구조를 확인하지 않고 형태를 단정하지 말 것.

### 4.5 확장이 오래 기다리면 결과가 증발한다

제미나이 전송이 처음엔 49.7초에 성공했는데, 나중엔 180초 타임아웃으로 실패했습니다.

원인: MV3 서비스워커는 오래 산다는 보장이 없는데, `sendAndWait` 가 응답 완료까지
최대 170초를 **확장 안에서** 기다렸습니다. 그 사이 워커가 재시작되면 결과가 사라집니다.
50초짜리는 살아남고 170초짜리는 죽은 이유입니다.

**수정:** 확장은 짧은 작업(입력·전송·읽기)만 하고, 긴 대기는 죽지 않는 서버가 맡습니다.
서버가 1.5초마다 `read` 를 호출해 "스트리밍 표시 없음 + 3초간 텍스트 불변" 으로 완료를 판정합니다.

**미검증:** 이 수정 후 아직 성공을 못 봤습니다. 두 번 시도했는데 둘 다 **제 테스트 실수**로 깨졌습니다
(한 번은 테스트 도중 서버를 재시작해서 ECONNRESET, 한 번은 경로 이스케이프 오류).

### 4.6 온라인 판정 기준이 폴링 주기보다 짧았다

확장이 붙었는데도 대시보드는 계속 `확장 미연결` 로 표시했습니다.

```js
extOnline: Date.now() - extLastSeen < 8000   // 8초
```

롱폴링 주기는 25초입니다. 폴링 사이에 매번 오프라인으로 떨어졌습니다. 45초로 수정.

### 4.7 서버 재시작 후 탭 목록이 안 돌아왔다

확장은 탭이 **바뀔 때만** 보고하도록 짜여 있었습니다. 서버가 재시작해 메모리가
비면 아무도 다시 채워주지 않았습니다.

**수정:** 폴링이 들어왔는데 탭 목록이 비어 있으면 서버가 `reportTabs` 를 요청합니다.

### 4.8 작업 습관에서 반복된 실수

기록해 둡니다. 같은 실수를 반복하지 않기 위해서입니다.

- **말만 하고 실행하지 않은 턴이 여러 번 있었습니다.** "지금 하겠습니다" 로 끝나고
  도구를 부르지 않았습니다. 사용자가 "왜 안되냐 자꾸" 라고 할 때까지 반복됐습니다.
- **자기 테스트를 자기가 깨뜨렸습니다.** 백그라운드 테스트가 도는 중에 서버를 재시작했습니다.
- **셸 heredoc 안에서 백슬래시가 반복적으로 뭉개졌습니다.** `'*\\WindowsApps\\...'` 로
  써야 할 것이 `'*\WindowsApps\...'` 가 되어 JS 이스케이프로 먹혔습니다.
  결국 `chr(92)` 로 명시 조립해서 해결. 윈도우 경로를 다룰 땐 슬래시를 쓰거나
  파일에서 읽어오는 편이 안전합니다.
- **PowerShell 스크립트에 BOM 을 안 넣어 창이 즉시 닫혔습니다.** Windows PowerShell 5.1 은
  BOM 없는 `.ps1` 을 ANSI(CP949)로 읽습니다. 한글이 깨지면서 CP949 뒷바이트가
  백틱으로 해석돼 따옴표가 escape 되고 파싱이 깨졌습니다. UTF-8 **with BOM** 필수.

### 4.9 지피티도 공식 CLI 를 놔두고 화면을 뒤지고 있었다

"지피티를 앱으로 쓴다" 는 말에 앱 화면 조종(CDP)으로 갔습니다. 그런데
**Codex CLI 가 이미 설치돼 있었습니다.**

```
codex --version   → codex-cli 0.150.1
codex login status → Logged in using ChatGPT   (구독. API 키 불필요)
```

Claude 앱 때와 **똑같은 실수를 지피티 쪽에서도** 하고 있었던 것입니다.
정식 통로를 놔두고 화면을 뒤졌습니다.

Codex CLI 가 제공하는 것:

| 명령 | 용도 |
|---|---|
| `codex exec` | 새 세션 비대화형 실행 |
| `codex exec resume <id>` | **기존 세션 이어가기** |
| `codex queue --thread <id> --message` | 실행 중 세션에 메시지 넣기 |
| `~/.codex/session_index.jsonl` | 세션 목록 (id / thread_name / updated_at) |

`codex exec resume` 로 기존 세션을 이어가는 것을 확인했습니다.
`7` 을 답한 세션에 이어서 물으니 `10`, 다시 물으니 `"7,10"` — 문맥이 유지됩니다.

**교훈:** 새 대상을 붙이기 전에 **그 회사가 공식 CLI 를 내놨는지부터 확인한다.**
두 번 다 그걸 안 하고 화면 조종부터 시작했습니다.

### 4.10 축이 두 개라는 것을 늦게 깨달았다

어댑터에 `kind`(api/cli/ui) 만 있었습니다. 사용자가 지적해서 두 번째 축을 넣었습니다.

```
kind        = api | cli | ui      ← 어떻게 붙었나 (안정성)
agentType   = coding | chat       ← 뭘 할 수 있나
```

둘은 직교합니다. `claude-code` 와 `codex-cli` 는 cli/coding, `gemini-tab` 은 ui/chat 입니다.
이 라벨이 없어서 워크플로우에서 "파일을 고쳐야 하는 단계" 와 "그냥 물어보는 단계" 를
구분하지 못하고 있었습니다.

역할(`조사` / `문서` / `검수`)은 agentType 이 아니라 **워크플로우 단계 배정**입니다.
같은 세션이 작업에 따라 다른 역할을 맡습니다.

---

## 5. 지금 안 되는 것

| 항목 | 상태 | 이유 |
|---|---|---|
| Claude 데스크톱 앱 연결 | **영구 불가** | 앱이 디버그 스위치를 거부. 우회 안 함 |
| Anthropic API 어댑터 | 미검증 | API 키 없음. 계정 크레딧 $0 |
| 웹 탭 전송 (수정 후) | 미검증 | 테스트 실수로 두 번 깨짐 |
| 워크플로우 담당 드롭다운 | 구식 | 어댑터 기준이 아니라 예전 타깃 기준 |
| 수동 카드 | UI 없음 | 서버 API 만 있고 화면에서 추가 불가 |
| 대화 로그 영속화 | 없음 | 메모리에만. 서버 재시작 시 소실 |
| 워크플로우 분기/병렬 | 없음 | 순차 실행만 |
| 서버 자동 시작 | 없음 | `start.cmd` 수동 실행 |
| 인증 | 없음 | localhost 바인딩만. 로컬 프로그램은 누구나 API 호출 가능 |
| Electron 데스크톱 앱 | 코드만 | `desktop/main.js` 작성됨, `npm install electron` 미실행 |

---

## 6. Claude Code Channels — 구현 완료

**해결한 문제:** `claude -p --resume <id>` 는 새 프로세스를 띄운다. 대상 세션이 지금
터미널에 열려 있으면 두 프로세스가 각자 대화를 소유해 기록이 갈라진다.
채널은 이미 돌고 있는 세션에 직접 이벤트를 넣으므로 주인이 하나다.

```
대시보드 → POST /api/adapters/send (claude-channel, threadId=<세션id>)
   서버가 세션별 큐에 적재
채널(MCP 서버)이 롱폴링으로 가져감
   → notifications/claude/channel → 실행 중 세션에 <channel> 태그로 도착
Claude 가 fleetview_reply 도구 호출
   → POST /api/channel/reply → 대기 중이던 요청을 깨움 → 대시보드에 표시
```

**구성 파일**

| 파일 | 역할 |
|---|---|
| `channel/fleetview-channel.js` | stdio MCP 서버. 세션 판별 → 등록 → 롱폴링 → 주입 → 답장 |
| `server/channelHub.js` | 세션별 큐, 롱폴링 보류, 답장 매칭 |
| `server/adapters/claudeChannel.js` | 어댑터 규격으로 감싼 것 |

**자기 세션 판별:** Claude Code 가 채널을 자식 프로세스로 띄우므로, `process.ppid` 부터
위로 거슬러 올라가며 `~/.claude/sessions/<pid>.json` 을 찾는다. 중간에 셸이 끼는 경우가
있어 최대 6단계까지 올라간다.

**설치**

```bash
claude mcp add --scope user fleetview -- node <경로>/fleetview/channel/fleetview-channel.js
```

**세션 시작** (프리뷰라 커스텀 채널은 개발 플래그 필요)

```bash
claude --dangerously-load-development-channels server:fleetview
claude --resume <세션id> --dangerously-load-development-channels server:fleetview
```

**제약**
- 이미 떠 있는 세션에는 나중에 못 붙인다. 세션당 최초 1회 재시작이 필요하다.
- 리서치 프리뷰라 플래그 문법이 바뀔 수 있다.

### 6.1 붙이면서 걸린 것 — 자식 세션 마커 상속

FleetView 서버(=내 Claude Code 세션의 자식)에서 테스트용 세션을 띄웠더니 이렇게 떴다.

```
⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
```

자식 세션으로 인식되어 트랜스크립트가 저장되지 않았고, 따라서
`~/.claude/sessions/<pid>.json` 도 생기지 않아 채널이 자기 세션을 찾지 못했다.

**수정:** 세션을 띄울 때 `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_SESSION_ID` /
`CLAUDE_CODE_ENTRYPOINT` 를 비우고 실행한다. FleetView 가 세션을 띄우는 기능을
만들 때 이 처리를 반드시 넣어야 한다.

### 6.2 user 스코프 MCP 는 모든 세션에서 뜬다 — 가짜 채널 등록

`claude mcp add --scope user fleetview` 로 등록하면 **모든 세션**에서 이 MCP 서버가
자동 로드된다. 그래서 `--channels` 없이 시작한 세션에서도 채널 스크립트가 떠서
"나 붙었다" 고 FleetView 에 등록해버렸다.

그런 세션은 `notifications/claude/channel` 을 받아주지 않으므로, 대시보드는
"채널 연결됨" 이라고 표시하지만 실제로 보내면 답 없이 타임아웃 난다.

**수정:** 호스트 프로세스의 실행 인자를 직접 확인해서, `--channels` 또는
`--dangerously-load-development-channels` 에 `fleetview` 가 들어 있을 때만 등록한다.

```js
const cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=<hostPid>").CommandLine
if (!/--channels|--dangerously-load-development-channels/.test(cmd)) return false;
return /(^|[\s:])(server:)?fleetview(\s|$|@)/.test(cmd);
```

**교훈:** 능력을 선언했다고 그 능력이 활성화된 것은 아니다. 상대가 실제로 켰는지
따로 확인해야 한다.

### 6.3 대시보드가 경로를 자동으로 가른다

세션마다 채널 연결 여부(`s.channel`)를 상태에 실어 보내고, 대시보드가 그에 따라
경로를 고른다.

| 세션 상태 | 보내는 경로 | 결과 |
|---|---|---|
| 채널 붙음 | `claude-channel` 어댑터 | 실행 중인 그 창으로 직접. 곁가지 없음 |
| 채널 없음 | `claude -p --resume` | 새 프로세스. 답이 대시보드에만 남고 기록은 갈라짐 |

채널이 없는 세션은 드로어 경고문에 갈라진다는 사실과 재시작 방법을 명시한다.

## 7. 재현 방법

```bash
git clone <이 저장소>
cd fleetview
npm install
node server/index.js      # 또는 start.cmd
```

http://localhost:7777

크롬 확장: `chrome://extensions` → 개발자 모드 → 압축해제된 확장 로드 → `extension/` 폴더

ChatGPT 앱 연동: `connect-chatgpt-app.cmd` 를 **탐색기에서 더블클릭**
(서버가 직접 실행하면 안 됩니다. 4.1 참고)

---

## 8. 다른 AI 에게

이 프로젝트를 이어받는다면 다음 순서를 권합니다.

1. **채널 구현** (6장) — 사용자가 원한 "기존 세션 그대로 이어 쓰기" 의 유일한 정식 해법
2. **웹 탭 전송 재검증** (4.5) — 수정은 됐는데 성공을 못 봤습니다
3. **워크플로우 담당 드롭다운을 어댑터 기준으로 교체**
4. **대화 로그 영속화**

그리고 두 가지는 하지 마세요.

- **앱 UI 를 밖에서 조종하는 방향으로 더 가지 마세요.** 보호 장치를 우회하는 짓이고,
  Claude 앱에서 이미 막혔습니다. 공식 API/CLI/채널이 정공법입니다.
- **프로세스를 이름으로 죽이지 마세요.** 4.1 을 다시 읽어주세요.

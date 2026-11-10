# 사계몬스터 온라인 서버 (1차 기반)

이 디렉터리는 사계몬스터의 랜덤 매칭/친구 초대에 사용할 Cloudflare Worker + Durable Object 서버 기반이다.

## 제공 API

- `GET /api/health`: 서버 상태 확인
- `POST /api/queue/join`: battle 또는 trade 랜덤 대기열 참가
- `GET /api/queue/status?ticket=...&playerId=...`: 매칭 결과 확인
- `POST /api/queue/leave`: 대기열 취소
- `POST /api/invite/create`: 친구 초대 코드 생성
- `POST /api/invite/join`: 친구 코드 참가
- `GET /api/invite/status?code=...&playerId=...`: 초대 생성자의 참가 상태 확인
- `GET /api/room/{roomId}` (WebSocket Upgrade): 매칭된 두 플레이어 간 메시지 전달

## 배포

1. Cloudflare 계정에서 Workers & Pages를 활성화한다.
2. 저장소 루트에서 Wrangler를 설치하고 로그인한다: `npm install -g wrangler`, `wrangler login`.
3. `wrangler.toml`의 `ALLOWED_ORIGIN`을 실제 게임이 제공되는 HTTPS 도메인으로 바꾼다.
4. `wrangler deploy`를 실행한다.
5. `https://<worker-name>.<account-subdomain>.workers.dev/api/health`가 `ok: true`를 반환하는지 확인한다.

## 중요한 현재 한계

- NPC 메뉴에서 랜덤/친구 PvP 및 교환 매칭 흐름을 호출한다. PvP는 클라이언트 전투 계산과 메시지 동기화 방식이며 서버 권한형 판정은 아니다.
- 대전 결과를 서버가 판정하는 권한형 전투 엔진은 아직 없다. 현재 WebSocket은 메시지 중계이므로 변조된 전투 패킷을 막지 못한다.
- 교환은 서버가 제안 → 수락 → 제안자의 최종 데이터 전송 → 수신 확인의 단계를 순서대로 관리한다. 제안자/수신자 외 메시지, 단계가 맞지 않는 중복 메시지, 중복 제안은 거부하며 미완료 거래는 2분 후 만료된다. 선택 당시 내 사계몬이 그대로인지 확인한 뒤 파티에 반영하고, 연결 종료 시 미완료 교환 상태를 지운다. 다만 수신자가 저장한 직후 확인 응답이 유실되는 경우처럼 네트워크 단절과 로컬 저장이 겹치는 상황까지 원자적으로 복구하지는 못한다. 실제 소유권 원장·계정 인증·서버 권한형 자산 이전이 없으므로 위조/복제/중간 종료 시 세이브 불일치 위험이 남아 있으며, 가치 있는 온라인 자산을 안전하게 거래하는 수준은 아니다.
- 플레이어 ID는 클라이언트가 보내는 임시 식별자다. 계정 인증이나 부정 접속 방지 시스템은 아직 없다.
- 따라서 이 단계는 온라인 연결의 서버 기반만 준비한 것이며, 게임에 배포하거나 실전 매칭/교환이 완성된 상태가 아니다.


## 현재 테스트 범위

- 최신 `script.js`와 `server/worker.js`를 JavaScript 엔진에서 구문 분석했고 두 파일 모두 구문 검사를 통과했다. 이는 실행 테스트가 아니라 파싱 검사다. Cloudflare Worker 배포, 실제 브라우저 UI 실행, 두 브라우저 동시 접속/교환 왕복 테스트는 아직 수행하지 못했다.
- 실전 테스트 전에는 Worker를 배포하고 두 개의 별도 브라우저 프로필에서 같은 서버 주소로 접속해 랜덤/친구 매칭, 교환 수락/거절/취소, 파티 6마리 제한, 연결 중단 상황을 확인해야 한다.

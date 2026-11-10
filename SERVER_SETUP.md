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

- 이 서버는 매칭/초대 및 실시간 메시지 전달 기반이다. 아직 게임 화면의 NPC 메뉴와 연결되지 않았다.
- 대전 결과를 서버가 판정하는 권한형 전투 엔진은 아직 없다. 현재 WebSocket은 메시지 중계이므로 변조된 전투 패킷을 막지 못한다.
- 교환 API는 방 연결까지만 제공한다. 사계몬 소유권을 서버에서 보관·검증·이전하는 계정/인벤토리 시스템이 아직 없으므로 실제 교환 확정은 구현하지 않았다. 클라이언트 저장 데이터를 그대로 교환하면 복제/위조 위험이 있다.
- 플레이어 ID는 클라이언트가 보내는 임시 식별자다. 계정 인증이나 부정 접속 방지 시스템은 아직 없다.
- 따라서 이 단계는 온라인 연결의 서버 기반만 준비한 것이며, 게임에 배포하거나 실전 매칭/교환이 완성된 상태가 아니다.

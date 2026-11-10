const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const QUEUE_TTL = 90_000;
const INVITE_TTL = 10 * 60_000;
const ROOM_TTL = 30 * 60_000;
const MODES = new Set(["battle", "trade"]);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function randomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}
function validPlayer(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}
function validMode(value) { return MODES.has(value); }

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";
    if (request.method === "OPTIONS") {
      if (allowed && origin !== allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origin, allowed) });
    }
    if (allowed && origin && origin !== allowed) return json({ error: "origin_not_allowed" }, 403);
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "sagyemon-online", version: 1 }, 200, cors(origin, allowed));
    }
    if (!url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404, cors(origin, allowed));
    const id = env.LOBBY.idFromName("sagyemon-global-lobby");
    return env.LOBBY.get(id).fetch(request, { headers: { "x-forwarded-origin": origin } });
  }
};

function cors(origin, allowed) {
  const h = { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
  if (origin && (!allowed || origin === allowed)) h["access-control-allow-origin"] = origin;
  h.vary = "Origin";
  return h;
}

export class Lobby {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("x-forwarded-origin") || request.headers.get("Origin") || "";
    const allowed = this.env.ALLOWED_ORIGIN || "";
    const headers = cors(origin, allowed);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (url.pathname === "/api/queue/join" && request.method === "POST") return this.queueJoin(request, headers);
      if (url.pathname === "/api/queue/status" && request.method === "GET") return this.queueStatus(url, headers);
      if (url.pathname === "/api/queue/leave" && request.method === "POST") return this.queueLeave(request, headers);
      if (url.pathname === "/api/invite/create" && request.method === "POST") return this.inviteCreate(request, headers);
      if (url.pathname === "/api/invite/join" && request.method === "POST") return this.inviteJoin(request, headers);
      if (url.pathname === "/api/invite/status" && request.method === "GET") return this.inviteStatus(url, headers);
      if (url.pathname.startsWith("/api/room/") && request.headers.get("Upgrade") === "websocket") return this.roomSocket(request, url, headers);
      return json({ error: "not_found" }, 404, headers);
    } catch (error) {
      return json({ error: "server_error", message: "요청을 처리하지 못했어요." }, 500, headers);
    }
  }
  async body(request) {
    const text = await request.text();
    if (text.length > 8_000) throw new Error("body_too_large");
    return JSON.parse(text || "{}");
  }
  async newRoom(mode, a, b) {
    const roomId = randomCode(12);
    const room = {
      roomId, mode, createdAt: Date.now(), expiresAt: Date.now() + ROOM_TTL,
      players: [
        { playerId: a.playerId, displayName: a.displayName, token: crypto.randomUUID() },
        { playerId: b.playerId, displayName: b.displayName, token: crypto.randomUUID() }
      ]
    };
    await this.ctx.storage.put("room:" + roomId, room);
    return room;
  }
  roomPayload(room, playerId) {
    const own = room.players.find(p => p.playerId === playerId);
    const peer = room.players.find(p => p.playerId !== playerId);
    return { state: "matched", mode: room.mode, roomId: room.roomId, token: own.token, opponent: { playerId: peer.playerId, displayName: peer.displayName }, expiresAt: room.expiresAt };
  }
  async queueJoin(request, headers) {
    const b = await this.body(request);
    if (!validMode(b.mode) || !validPlayer(b.playerId)) return json({ error: "invalid_input" }, 400, headers);
    const displayName = typeof b.displayName === "string" ? b.displayName.trim().slice(0, 16) : "트레이너";
    const queueKey = "queue:" + b.mode;
    const ticket = crypto.randomUUID();
    const now = Date.now();
    let queue = (await this.ctx.storage.get(queueKey)) || [];
    queue = queue.filter(x => now - x.createdAt < QUEUE_TTL && x.playerId !== b.playerId);
    const partnerIndex = queue.findIndex(x => x.playerId !== b.playerId);
    if (partnerIndex >= 0) {
      const partner = queue.splice(partnerIndex, 1)[0];
      const room = await this.newRoom(b.mode, partner, { playerId: b.playerId, displayName });
      await this.ctx.storage.put(queueKey, queue);
      await this.ctx.storage.put("ticket:" + partner.ticket, { playerId: partner.playerId, result: this.roomPayload(room, partner.playerId), expiresAt: room.expiresAt });
      await this.ctx.storage.put("ticket:" + ticket, { playerId: b.playerId, result: this.roomPayload(room, b.playerId), expiresAt: room.expiresAt });
      return json({ ticket, ...this.roomPayload(room, b.playerId) }, 200, headers);
    }
    queue.push({ ticket, playerId: b.playerId, displayName, createdAt: now });
    await this.ctx.storage.put(queueKey, queue);
    await this.ctx.storage.put("ticket:" + ticket, { playerId: b.playerId, result: null, expiresAt: now + QUEUE_TTL });
    return json({ ticket, state: "waiting", expiresAt: now + QUEUE_TTL }, 200, headers);
  }
  async queueStatus(url, headers) {
    const ticket = url.searchParams.get("ticket") || "";
    const playerId = url.searchParams.get("playerId") || "";
    if (!ticket || !validPlayer(playerId)) return json({ error: "invalid_input" }, 400, headers);
    const item = await this.ctx.storage.get("ticket:" + ticket);
    if (!item || item.playerId !== playerId || item.expiresAt < Date.now()) return json({ error: "ticket_expired" }, 404, headers);
    return json(item.result || { state: "waiting", expiresAt: item.expiresAt }, 200, headers);
  }
  async queueLeave(request, headers) {
    const b = await this.body(request);
    if (!b.ticket || !validPlayer(b.playerId)) return json({ error: "invalid_input" }, 400, headers);
    for (const mode of MODES) {
      const key = "queue:" + mode;
      const queue = (await this.ctx.storage.get(key)) || [];
      await this.ctx.storage.put(key, queue.filter(x => !(x.ticket === b.ticket && x.playerId === b.playerId)));
    }
    const item = await this.ctx.storage.get("ticket:" + b.ticket);
    if (item && item.playerId === b.playerId) await this.ctx.storage.delete("ticket:" + b.ticket);
    return json({ ok: true }, 200, headers);
  }
  async inviteCreate(request, headers) {
    const b = await this.body(request);
    if (!validMode(b.mode) || !validPlayer(b.playerId)) return json({ error: "invalid_input" }, 400, headers);
    const code = randomCode();
    const invite = { code, mode: b.mode, host: { playerId: b.playerId, displayName: typeof b.displayName === "string" ? b.displayName.trim().slice(0, 16) : "트레이너" }, room: null, createdAt: Date.now(), expiresAt: Date.now() + INVITE_TTL };
    await this.ctx.storage.put("invite:" + code, invite, { expirationTtl: Math.ceil(INVITE_TTL / 1000) });
    return json({ state: "waiting", code, expiresAt: invite.expiresAt }, 200, headers);
  }
  async inviteJoin(request, headers) {
    const b = await this.body(request);
    const code = typeof b.code === "string" ? b.code.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    if (!/^[A-Z2-9]{6}$/.test(code) || !validPlayer(b.playerId)) return json({ error: "invalid_input" }, 400, headers);
    const invite = await this.ctx.storage.get("invite:" + code);
    if (!invite || invite.expiresAt < Date.now()) return json({ error: "invite_not_found" }, 404, headers);
    if (invite.host.playerId === b.playerId) return json({ error: "cannot_join_own_invite" }, 409, headers);
    if (invite.room) return json({ error: "invite_already_used" }, 409, headers);
    const guest = { playerId: b.playerId, displayName: typeof b.displayName === "string" ? b.displayName.trim().slice(0, 16) : "트레이너" };
    const room = await this.newRoom(invite.mode, invite.host, guest);
    invite.room = room;
    await this.ctx.storage.put("invite:" + code, invite, { expirationTtl: Math.ceil(Math.max(1, (invite.expiresAt - Date.now()) / 1000)) });
    return json(this.roomPayload(room, guest.playerId), 200, headers);
  }
  async inviteStatus(url, headers) {
    const code = (url.searchParams.get("code") || "").toUpperCase();
    const playerId = url.searchParams.get("playerId") || "";
    if (!/^[A-Z2-9]{6}$/.test(code) || !validPlayer(playerId)) return json({ error: "invalid_input" }, 400, headers);
    const invite = await this.ctx.storage.get("invite:" + code);
    if (!invite || invite.expiresAt < Date.now()) return json({ error: "invite_expired" }, 404, headers);
    if (invite.host.playerId !== playerId) return json({ error: "not_invite_owner" }, 403, headers);
    return json(invite.room ? this.roomPayload(invite.room, playerId) : { state: "waiting", expiresAt: invite.expiresAt }, 200, headers);
  }
  async roomSocket(request, url, headers) {
    const roomId = url.pathname.split("/").pop();
    const playerId = url.searchParams.get("playerId") || "";
    const token = url.searchParams.get("token") || "";
    const room = await this.ctx.storage.get("room:" + roomId);
    if (!room || room.expiresAt < Date.now()) return json({ error: "room_expired" }, 404, headers);
    if (!room.players.some(p => p.playerId === playerId && p.token === token)) return json({ error: "unauthorized" }, 401, headers);
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server, [roomId]);
    server.serializeAttachment({ roomId, playerId });
    server.send(JSON.stringify({ type: "connected", roomId, mode: room.mode }));
    // 방에 먼저 들어와 있던 상대에게 새 참가자의 접속을 알린다.
    for (const peer of this.ctx.getWebSockets(roomId)) {
      if (peer !== server && peer.readyState === WebSocket.OPEN) {
        try { peer.send(JSON.stringify({ type: "peer_joined", playerId })); } catch {}
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment();
    if (!meta || typeof message !== "string" || message.length > 16_000) return;
    let packet;
    try { packet = JSON.parse(message); } catch { return; }
    if (!packet || typeof packet.type !== "string") return;
    if (packet.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong", at: Date.now() })); } catch {}
      return;
    }
    const room = await this.ctx.storage.get("room:" + meta.roomId);
    if (!room || room.expiresAt < Date.now() || !room.players.some(p => p.playerId === meta.playerId)) {
      try { ws.close(1008, "room expired"); } catch {}
      return;
    }
    if (room.mode === "battle") {
      if (packet.type === "battle_action") {
        const p = packet.payload;
        if (!p || typeof p.action !== "string") return;
        // 준비 신호는 대기 단계에서만 허용한다.
        if (p.action === "ready" && p.protocol === 1) {
          const state = (await this.ctx.storage.get("battle:" + meta.roomId)) || { ready: [], rosters: [], turn: 1, actions: {} };
          if (!state.ready.includes(meta.playerId)) state.ready.push(meta.playerId);
          await this.ctx.storage.put("battle:" + meta.roomId, state);
          this.broadcast(meta.roomId, ws, { type: "battle_action", from: meta.playerId, payload: { action: "ready", protocol: 1 }, at: Date.now() });
          return;
        }
        // 실제 행동은 서버 턴 동기화가 준비된 이후에만 받을 수 있다.
        if (p.action === "choose_move" || p.action === "switch_mon") {
          const validAction = p.action === "choose_move"
            ? Number.isInteger(p.moveIndex) && p.moveIndex >= 0 && p.moveIndex <= 3
            : Number.isInteger(p.teamIndex) && p.teamIndex >= 0 && p.teamIndex <= 2;
          if (!Number.isInteger(p.turn) || p.turn < 1 || p.turn > 500 || !validAction) return;
          const state = (await this.ctx.storage.get("battle:" + meta.roomId)) || { ready: [], rosters: [], turn: 1, actions: {}, activeTeam: {} };
          if (!state.activeTeam) state.activeTeam = {};
          if (state.ready.length !== 2 || state.rosters.length !== 2 || !state.started || p.turn !== state.turn || state.actions[meta.playerId]) return;
          if (p.action === "switch_mon" && p.teamIndex === (Number.isInteger(state.activeTeam[meta.playerId]) ? state.activeTeam[meta.playerId] : 0)) return;
          state.actions[meta.playerId] = p.action === "choose_move"
            ? { action: "choose_move", moveIndex: p.moveIndex, at: Date.now() }
            : { action: "switch_mon", teamIndex: p.teamIndex, at: Date.now() };
          const players = room.players.map(x => x.playerId);
          if (players.every(id => state.actions[id])) {
            const result = {
              type: "battle_action",
              from: "server",
              payload: {
                action: "turn_choices",
                turn: state.turn,
                choices: players.map(id => ({
                  playerId: id,
                  action: state.actions[id].action,
                  ...(state.actions[id].action === "choose_move"
                    ? { moveIndex: state.actions[id].moveIndex }
                    : { teamIndex: state.actions[id].teamIndex })
                }))
              },
              at: Date.now()
            };
            players.forEach(id => {
              if (state.actions[id].action === "switch_mon") state.activeTeam[id] = state.actions[id].teamIndex;
              else if (!Number.isInteger(state.activeTeam[id])) state.activeTeam[id] = 0;
            });
            state.turn += 1;
            state.actions = {};
            await this.ctx.storage.put("battle:" + meta.roomId, state);
            this.broadcast(meta.roomId, null, result);
          } else {
            await this.ctx.storage.put("battle:" + meta.roomId, state);
          }
          return;
        }
        return;
      }
      if (packet.type === "battle_state") {
        const p = packet.payload;
        if (!p || p.action !== "roster_preview" || !p.roster || p.roster.protocol !== 1 ||
            typeof p.roster.trainer !== "string" || !Array.isArray(p.roster.party) ||
            p.roster.party.length !== 3) return;
        const validParty = p.roster.party.every(mon =>
          mon && typeof mon.species === "string" && mon.species.length <= 20 &&
          Number.isInteger(mon.level) && mon.level >= 1 && mon.level <= 100 &&
          Array.isArray(mon.types) && mon.types.length <= 2 &&
          mon.types.every(type => typeof type === "string" && type.length <= 8) &&
          Array.isArray(mon.moves) && mon.moves.length <= 4 &&
          mon.moves.every(move => typeof move === "string" && move.length <= 20) &&
          (mon.nickname == null || (typeof mon.nickname === "string" && mon.nickname.length <= 8)) &&
          (mon.ability == null || (typeof mon.ability === "string" && mon.ability.length <= 12))
        );
        if (!validParty) return;
        const state = (await this.ctx.storage.get("battle:" + meta.roomId)) || { ready: [], rosters: [], turn: 1, actions: {} };
        if (!state.rosters.includes(meta.playerId)) state.rosters.push(meta.playerId);
        const starting = state.rosters.length === 2 && !state.started;
        if (starting) state.started = true;
        await this.ctx.storage.put("battle:" + meta.roomId, state);
        this.broadcast(meta.roomId, ws, { type: "battle_state", from: meta.playerId, payload: p, at: Date.now() });
        if (starting) this.broadcast(meta.roomId, null, { type: "battle_started", from: "server", payload: { protocol: 1, firstTurn: 1 }, at: Date.now() });
        return;
      }
      return;
    }
    if (room.mode === "trade" && ["trade_offer", "trade_accept"].includes(packet.type)) {
      // 교환은 아직 소유권 검증/원자적 이전이 없으므로 검증 없는 패킷을 확정으로 처리하지 않는다.
      return;
    }
  }
  broadcast(roomId, except, packet) {
    const outgoing = JSON.stringify(packet);
    for (const peer of this.ctx.getWebSockets(roomId)) {
      if (peer !== except && peer.readyState === WebSocket.OPEN) {
        try { peer.send(outgoing); } catch {}
      }
    }
  }
  webSocketClose(ws) {
    const meta = ws.deserializeAttachment();
    if (meta && meta.roomId) {
      for (const peer of this.ctx.getWebSockets(meta.roomId)) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          try { peer.send(JSON.stringify({ type: "peer_left", playerId: meta.playerId })); } catch {}
        }
      }
    }
  }
  webSocketError(ws) { try { ws.close(1011, "connection error"); } catch {} }
}

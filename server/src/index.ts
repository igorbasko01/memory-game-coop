import { gridProblem, MAX_PLAYERS, picksPerPlayer, replay, setSizeFor, type GameConfig } from '../../webapp/src/engine/game';
import type { CellView, GameView, MemberView, RoomView } from '../../webapp/src/online/types';

export interface Env {
  DB: D1Database;
}

/** A room nobody has used for this long is forgotten, and its code can be reused. */
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
/** A player or TV that checked in this recently counts as connected. */
const ONLINE_MS = 8000;
/** After a round has been open this long, a player who has picked may also pick for someone who hasn't. */
const COVER_MS = 20000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

interface PlayerRow {
  id: string;
  nickname: string;
}

interface RoomRow {
  id: string;
  code: string;
  host_id: string;
  rows: number;
  cols: number;
  status: RoomView['status'];
  game_id: string | null;
  tv_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MemberRow {
  player_id: string;
  nickname: string;
  joined_at: number;
  last_seen: number;
}

interface GameRow {
  id: string;
  room_id: string;
  seed: number;
  rows: number;
  cols: number;
  set_size: number;
  seats: string;
  status: GameView['status'];
  started_at: number;
  finished_at: number | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });

const randomString = (alphabet: string, length: number) =>
  [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join('');

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const body = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    const data = await req.json();
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const cleanNickname = (raw: unknown) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 16);

const authenticate = async (req: Request, env: Env): Promise<PlayerRow> => {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Missing token');
  const p = await env.DB.prepare('SELECT id, nickname FROM players WHERE token_hash = ?').bind(await sha256(token)).first<PlayerRow>();
  if (!p) throw new HttpError(401, 'Unknown token');
  return p;
};

// ------------------------------------------------------------------ players

const createPlayer = async (req: Request, env: Env) => {
  const nickname = cleanNickname((await body(req)).nickname);
  if (!nickname) throw new HttpError(400, 'Choose a nickname');
  const id = randomHex(8);
  const token = randomHex(24);
  await env.DB.prepare('INSERT INTO players (id, nickname, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, nickname, await sha256(token), Date.now())
    .run();
  return json({ player: { id, nickname }, token }, 201);
};

const renamePlayer = async (req: Request, me: PlayerRow, env: Env) => {
  const nickname = cleanNickname((await body(req)).nickname);
  if (!nickname) throw new HttpError(400, 'Choose a nickname');
  await env.DB.prepare('UPDATE players SET nickname = ? WHERE id = ?').bind(nickname, me.id).run();
  return json({ player: { id: me.id, nickname } });
};

// ------------------------------------------------------------------ rooms

const loadRoom = async (env: Env, id: string) => {
  const r = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<RoomRow>();
  if (!r) throw new HttpError(404, 'Room not found');
  return r;
};

const roomByCode = async (env: Env, raw: unknown) => {
  const code = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  const r = await env.DB.prepare("SELECT * FROM rooms WHERE code = ? AND status != 'closed' AND updated_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(code, Date.now() - ROOM_TTL_MS)
    .first<RoomRow>();
  if (!r) throw new HttpError(404, 'No room with that code');
  return r;
};

const loadMembers = async (env: Env, roomId: string) =>
  (
    await env.DB.prepare(
      'SELECT m.player_id, p.nickname, m.joined_at, m.last_seen FROM room_members m JOIN players p ON p.id = m.player_id WHERE m.room_id = ? ORDER BY m.joined_at',
    )
      .bind(roomId)
      .all<MemberRow>()
  ).results;

const loadGame = (env: Env, id: string) => env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(id).first<GameRow>();

interface PickRow {
  seat: number;
  slot: number;
  cell: number;
  actor: string;
  created_at: number;
}

const configOf = (g: GameRow): GameConfig => ({ rows: g.rows, cols: g.cols, setSize: g.set_size, seed: g.seed });

const touch = (env: Env, roomId: string) => env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(Date.now(), roomId).run();

/** A game replayed from its rounds, with the picks of the round being chosen. */
const loadPlay = async (env: Env, g: GameRow) => {
  const { results: rounds } = await env.DB.prepare('SELECT n, cells, created_at FROM rounds WHERE game_id = ? ORDER BY n')
    .bind(g.id)
    .all<{ n: number; cells: string; created_at: number }>();
  const game = replay(
    configOf(g),
    rounds.map((r) => JSON.parse(r.cells) as number[]),
  );
  const picks =
    g.status === 'playing' && !game.state.over
      ? (
          await env.DB.prepare('SELECT seat, slot, cell, actor, created_at FROM picks WHERE game_id = ? AND round = ? ORDER BY seat, slot')
            .bind(g.id, rounds.length)
            .all<PickRow>()
        ).results
      : [];
  const seats = JSON.parse(g.seats) as string[];
  return { game, picks, seats, roundStartedAt: rounds.length ? rounds[rounds.length - 1].created_at : g.started_at };
};

type Play = Awaited<ReturnType<typeof loadPlay>>;

/** The game as everyone may see it: values of face-down cards never leave the server. */
const gameView = (g: GameRow, { game, picks, seats, roundStartedAt }: Play): GameView => {
  const s = game.state;
  const cells: CellView[] = game.deck.map((value, i) => {
    if (value === null) return { state: 'empty' };
    if (s.closed[i]) return { state: 'closed', value };
    if (s.lastMiss?.includes(i)) return { state: 'miss', value };
    return { state: 'down' };
  });
  return {
    id: g.id,
    status: g.status,
    rows: g.rows,
    cols: g.cols,
    setSize: g.set_size,
    sets: game.sets,
    picksPerPlayer: picksPerPlayer(seats.length),
    cells,
    picks: picks.map((p) => ({ cell: p.cell, seat: p.seat })),
    lastMiss: s.lastMiss,
    last: s.last,
    round: s.rounds,
    misses: s.misses,
    setsClosed: s.setsClosed,
    startedAt: g.started_at,
    finishedAt: g.finished_at,
    roundStartedAt,
    coverAt: roundStartedAt + COVER_MS,
  };
};

const view = async (env: Env, r: RoomRow, you: string | null): Promise<RoomView> => {
  const now = Date.now();
  const members = await loadMembers(env, r.id);
  const g = r.game_id ? await loadGame(env, r.game_id) : null;
  const game = g && r.status !== 'lobby' ? gameView(g, await loadPlay(env, g)) : null;
  const member = (m: MemberRow, seat: number, picked = 0): MemberView => ({
    id: m.player_id,
    nickname: m.nickname,
    seat,
    host: m.player_id === r.host_id,
    online: m.last_seen > now - ONLINE_MS,
    left: false,
    picked,
  });
  let shown: MemberView[];
  let waiting: MemberView[] = [];
  if (g && game) {
    // The game's players, in seat order, even if someone has left the room since.
    const seats = JSON.parse(g.seats) as string[];
    const left = seats.filter((id) => !members.some((m) => m.player_id === id));
    const gone = left.length
      ? (
          await env.DB.prepare(`SELECT id, nickname FROM players WHERE id IN (${left.map(() => '?').join(', ')})`)
            .bind(...left)
            .all<PlayerRow>()
        ).results
      : [];
    shown = seats.map((id, seat) => {
      const m = members.find((x) => x.player_id === id);
      const picked = game.picks.filter((p) => p.seat === seat).length;
      if (m) return member(m, seat, picked);
      return { id, nickname: gone.find((p) => p.id === id)?.nickname ?? 'Player', seat, host: false, online: false, left: true, picked };
    });
    waiting = members.filter((m) => !seats.includes(m.player_id)).map((m, i) => member(m, seats.length + i));
  } else {
    shown = members.map((m, seat) => member(m, seat));
  }
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    rows: r.rows,
    cols: r.cols,
    hostId: r.host_id,
    you,
    members: shown,
    waiting,
    tv: !!r.tv_seen_at && r.tv_seen_at > now - ONLINE_MS,
    nextSetSize: setSizeFor(Math.max(1, members.length)),
    game,
    now,
  };
};

/** The room as a member sees it; also records that they are still connected. */
const memberView = async (env: Env, r: RoomRow, me: PlayerRow) => {
  const now = Date.now();
  const seen = await env.DB.prepare('UPDATE room_members SET last_seen = ? WHERE room_id = ? AND player_id = ?').bind(now, r.id, me.id).run();
  if (seen.meta.changes !== 1) throw new HttpError(403, 'You are not in this room');
  return json(await view(env, r, me.id));
};

const readGrid = (data: Record<string, unknown>, fallback: { rows: number; cols: number }) => ({
  rows: data.rows === undefined ? fallback.rows : Number(data.rows),
  cols: data.cols === undefined ? fallback.cols : Number(data.cols),
});

const createRoom = async (req: Request, me: PlayerRow, env: Env) => {
  const { rows, cols } = readGrid(await body(req), { rows: 4, cols: 4 });
  const problem = gridProblem(rows, cols, 2);
  if (problem) throw new HttpError(400, problem);
  const now = Date.now();
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomString(CODE_ALPHABET, 4);
    const taken = await env.DB.prepare("SELECT 1 FROM rooms WHERE code = ? AND status != 'closed' AND updated_at > ?")
      .bind(code, now - ROOM_TTL_MS)
      .first();
    if (taken) continue;
    const id = randomHex(8);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rooms (id, code, host_id, rows, cols, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'lobby', ?, ?)").bind(
        id,
        code,
        me.id,
        rows,
        cols,
        now,
        now,
      ),
      env.DB.prepare('INSERT INTO room_members (room_id, player_id, joined_at, last_seen) VALUES (?, ?, ?, ?)').bind(id, me.id, now, now),
    ]);
    return json(await view(env, await loadRoom(env, id), me.id), 201);
  }
  throw new HttpError(503, 'Could not find a free room code, try again');
};

const joinRoom = async (req: Request, me: PlayerRow, env: Env) => {
  const r = await roomByCode(env, (await body(req)).code);
  const members = await loadMembers(env, r.id);
  if (members.some((m) => m.player_id === me.id)) return memberView(env, r, me);
  if (r.status === 'playing') {
    // Someone who left (or was removed from) the game in progress can come back to their seat.
    const g = r.game_id ? await loadGame(env, r.game_id) : null;
    if (!g || !(JSON.parse(g.seats) as string[]).includes(me.id))
      throw new HttpError(409, 'A game is in progress in that room. Join when it ends, or watch it on a TV.');
    const now = Date.now();
    await env.DB.prepare('INSERT OR IGNORE INTO room_members (room_id, player_id, joined_at, last_seen) VALUES (?, ?, ?, ?)').bind(r.id, me.id, now, now).run();
    return memberView(env, r, me);
  }
  if (members.length >= MAX_PLAYERS) throw new HttpError(409, `That room is full (${MAX_PLAYERS} players)`);
  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO room_members (room_id, player_id, joined_at, last_seen) VALUES (?, ?, ?, ?)').bind(r.id, me.id, now, now).run();
  // Two players can join the last place at once: the later one leaves again.
  const after = await loadMembers(env, r.id);
  if (after.findIndex((m) => m.player_id === me.id) >= MAX_PLAYERS) {
    await env.DB.prepare('DELETE FROM room_members WHERE room_id = ? AND player_id = ?').bind(r.id, me.id).run();
    throw new HttpError(409, `That room is full (${MAX_PLAYERS} players)`);
  }
  await touch(env, r.id);
  return memberView(env, r, me);
};

const requireHost = (r: RoomRow, me: PlayerRow) => {
  if (r.host_id !== me.id) throw new HttpError(403, 'Only the host can do that');
};

const changeSettings = async (req: Request, me: PlayerRow, env: Env, id: string) => {
  const r = await loadRoom(env, id);
  requireHost(r, me);
  if (r.status === 'playing') throw new HttpError(409, 'The grid can be changed between games');
  const { rows, cols } = readGrid(await body(req), r);
  const problem = gridProblem(rows, cols, 2);
  if (problem) throw new HttpError(400, problem);
  await env.DB.prepare('UPDATE rooms SET rows = ?, cols = ?, updated_at = ? WHERE id = ?').bind(rows, cols, Date.now(), r.id).run();
  return memberView(env, await loadRoom(env, id), me);
};

/** Starts a game with everyone in the room, in join order. Also used for "play again". */
const startGame = async (me: PlayerRow, env: Env, id: string) => {
  const r = await loadRoom(env, id);
  requireHost(r, me);
  if (r.status === 'playing') return memberView(env, r, me);
  const seats = (await loadMembers(env, r.id)).map((m) => m.player_id);
  const setSize = setSizeFor(seats.length);
  const problem = gridProblem(r.rows, r.cols, setSize);
  if (problem) throw new HttpError(400, `${problem} of ${setSize}. Pick a bigger grid.`);
  const gameId = randomHex(8);
  const now = Date.now();
  // The game first, so a room never points at a game that isn't there yet. A start that loses a race leaves an unused game.
  await env.DB.prepare("INSERT INTO games (id, room_id, seed, rows, cols, set_size, seats, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'playing', ?)")
    .bind(gameId, r.id, crypto.getRandomValues(new Uint32Array(1))[0], r.rows, r.cols, setSize, JSON.stringify(seats), now)
    .run();
  await env.DB.prepare("UPDATE rooms SET status = 'playing', game_id = ?, updated_at = ? WHERE id = ? AND status != 'playing'").bind(gameId, now, r.id).run();
  return memberView(env, await loadRoom(env, id), me);
};

const finishGame = async (env: Env, r: RoomRow, gameId: string, status: 'won' | 'ended') => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE games SET status = ?, finished_at = ? WHERE id = ? AND status = 'playing'").bind(status, now, gameId),
    env.DB.prepare("UPDATE rooms SET status = 'finished', updated_at = ? WHERE id = ? AND game_id = ?").bind(now, r.id, gameId),
  ]);
};

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint/i.test(e.message);

/**
 * Picks a card for the round being chosen. Picking your own card again takes it
 * back; picking another card when you've picked all yours moves your oldest pick.
 * A player who has picked can also pick for someone who left the room, at once, or
 * for anyone who hasn't picked once the round has been open for COVER_MS. The round is flipped as soon as every pick is in.
 */
const pick = async (req: Request, me: PlayerRow, env: Env, id: string) => {
  const r = await loadRoom(env, id);
  const data = await body(req);
  if (r.status !== 'playing' || !r.game_id) return memberView(env, r, me);
  const g = (await loadGame(env, r.game_id))!;
  const play = await loadPlay(env, g);
  const { game, picks, seats } = play;
  const mySeat = seats.indexOf(me.id);
  if (mySeat < 0) throw new HttpError(403, 'You are not playing in this game');
  // A pick meant for a round that has already been flipped is ignored.
  if (Number(data.round) !== game.state.rounds || game.state.over) return memberView(env, r, me);
  const problem = game.cellProblem(data.cell);
  if (problem) throw new HttpError(400, problem);
  const cell = data.cell as number;
  const quota = picksPerPlayer(seats.length);
  const now = Date.now();
  const freeSlot = (seat: number) => [...Array(quota).keys()].find((slot) => !picks.some((p) => p.seat === seat && p.slot === slot));
  const insert = (seat: number, slot: number) =>
    env.DB.prepare('INSERT INTO picks (game_id, round, seat, slot, cell, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(g.id, game.state.rounds, seat, slot, cell, me.id, now)
      .run();
  const taken = picks.find((p) => p.cell === cell);
  try {
    if (taken) {
      if (taken.seat !== mySeat && taken.actor !== me.id) throw new HttpError(409, 'Someone else picked that card');
      await env.DB.prepare('DELETE FROM picks WHERE game_id = ? AND round = ? AND seat = ? AND slot = ?').bind(g.id, game.state.rounds, taken.seat, taken.slot).run();
    } else if (freeSlot(mySeat) !== undefined) {
      await insert(mySeat, freeSlot(mySeat)!);
    } else {
      // Someone who left the room can be picked for at once; anyone else once the round has been open COVER_MS.
      const present = new Set((await loadMembers(env, r.id)).map((m) => m.player_id));
      const open = seats.map((id, seat) => ({ seat, left: !present.has(id) })).filter((s) => freeSlot(s.seat) !== undefined);
      const timedOut = now >= play.roundStartedAt + COVER_MS;
      const away = (open.find((s) => s.left) ?? (timedOut ? open[0] : undefined))?.seat ?? -1;
      if (away >= 0) await insert(away, freeSlot(away)!);
      else {
        const oldest = picks.filter((p) => p.seat === mySeat).sort((a, b) => a.created_at - b.created_at)[0];
        await env.DB.prepare('UPDATE picks SET cell = ?, actor = ?, created_at = ? WHERE game_id = ? AND round = ? AND seat = ? AND slot = ?')
          .bind(cell, me.id, now, g.id, game.state.rounds, oldest.seat, oldest.slot)
          .run();
      }
    }
  } catch (e) {
    // Two players picked the same card, or the same slot, at the same moment.
    if (isUniqueViolation(e)) throw new HttpError(409, 'Someone just picked that card');
    throw e;
  }
  await flipIfReady(env, r, g);
  return memberView(env, await loadRoom(env, id), me);
};

/** Flips the round (once) when every player's picks are in. */
const flipIfReady = async (env: Env, r: RoomRow, g: GameRow) => {
  const { game, picks } = await loadPlay(env, g);
  if (picks.length !== g.set_size) return;
  const cells = picks.map((p) => p.cell);
  if (game.roundProblem(cells)) return;
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO rounds (game_id, n, cells, created_at) VALUES (?, ?, ?, ?)')
    .bind(g.id, game.state.rounds, JSON.stringify(cells), Date.now())
    .run();
  if (inserted.meta.changes !== 1) return;
  game.play(cells);
  if (game.state.over) await finishGame(env, r, g.id, 'won');
  else if (game.state.rounds % 5 === 0) await touch(env, r.id);
};

/** The host stops the game in progress; the room goes back to choosing the next one. */
const endGame = async (me: PlayerRow, env: Env, id: string) => {
  const r = await loadRoom(env, id);
  requireHost(r, me);
  if (r.status === 'playing' && r.game_id) await finishGame(env, r, r.game_id, 'ended');
  return memberView(env, await loadRoom(env, id), me);
};

/**
 * Takes a player out of the room. In a game in progress their seat stays and the
 * others pick for them; the game ends only when none of its players are left.
 * The host role passes to the next player in the room.
 */
const removeMember = async (env: Env, r: RoomRow, playerId: string) => {
  await env.DB.prepare('DELETE FROM room_members WHERE room_id = ? AND player_id = ?').bind(r.id, playerId).run();
  const left = await loadMembers(env, r.id);
  const now = Date.now();
  if (r.status === 'playing' && r.game_id) {
    const g = await loadGame(env, r.game_id);
    const seats = g ? (JSON.parse(g.seats) as string[]) : [];
    if (!left.some((m) => seats.includes(m.player_id))) await finishGame(env, r, r.game_id, 'ended');
  }
  if (!left.length) await env.DB.prepare("UPDATE rooms SET status = 'closed', updated_at = ? WHERE id = ?").bind(now, r.id).run();
  else if (r.host_id === playerId) await env.DB.prepare('UPDATE rooms SET host_id = ?, updated_at = ? WHERE id = ?').bind(left[0].player_id, now, r.id).run();
};

const leaveRoom = async (me: PlayerRow, env: Env, id: string) => {
  await removeMember(env, await loadRoom(env, id), me.id);
  return json({ ok: true });
};

/** The host takes another player out of the room. */
const removePlayer = async (req: Request, me: PlayerRow, env: Env, id: string) => {
  const r = await loadRoom(env, id);
  requireHost(r, me);
  const target = String((await body(req)).playerId ?? '');
  if (target === me.id) throw new HttpError(400, 'Use Leave room to leave yourself');
  if (!(await loadMembers(env, r.id)).some((m) => m.player_id === target)) throw new HttpError(404, 'That player is not in the room');
  await removeMember(env, r, target);
  return memberView(env, await loadRoom(env, id), me);
};

/** The room this player was in most recently, so a reload can return to it. */
const currentRoom = async (me: PlayerRow, env: Env) => {
  const r = await env.DB.prepare(
    "SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.player_id = ? AND r.status != 'closed' AND r.updated_at > ? ORDER BY m.last_seen DESC LIMIT 1",
  )
    .bind(me.id, Date.now() - ROOM_TTL_MS)
    .first<RoomRow>();
  return json({ room: r ? await view(env, r, me.id) : null });
};

/** A TV screen: shows the room by its code, without an account and without being a player. */
const tvView = async (env: Env, code: string) => {
  const r = await roomByCode(env, code);
  await env.DB.prepare('UPDATE rooms SET tv_seen_at = ? WHERE id = ?').bind(Date.now(), r.id).run();
  return json(await view(env, r, null));
};

// ------------------------------------------------------------------ routing

const route = async (req: Request, env: Env): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (path === '/api/health') return json({ ok: true });
  if (path === '/api/players' && method === 'POST') return createPlayer(req, env);
  const tv = path.match(/^\/api\/tv\/([A-Za-z]{4})$/);
  if (tv && method === 'GET') return tvView(env, tv[1]);

  const me = await authenticate(req, env);
  if (path === '/api/me' && method === 'GET') return json({ player: me });
  if (path === '/api/me' && method === 'POST') return renamePlayer(req, me, env);
  if (path === '/api/me/room' && method === 'GET') return currentRoom(me, env);
  if (path === '/api/rooms' && method === 'POST') return createRoom(req, me, env);
  if (path === '/api/rooms/join' && method === 'POST') return joinRoom(req, me, env);
  const room = path.match(/^\/api\/rooms\/([0-9a-f]{16})(?:\/(settings|start|pick|end|leave|remove))?$/);
  if (room && !room[2] && method === 'GET') return memberView(env, await loadRoom(env, room[1]), me);
  if (room && room[2] && method === 'POST') {
    const id = room[1];
    switch (room[2]) {
      case 'settings':
        return changeSettings(req, me, env, id);
      case 'start':
        return startGame(me, env, id);
      case 'pick':
        return pick(req, me, env, id);
      case 'end':
        return endGame(me, env, id);
      case 'leave':
        return leaveRoom(me, env, id);
      case 'remove':
        return removePlayer(req, me, env, id);
    }
  }
  throw new HttpError(404, 'Not found');
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Server error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

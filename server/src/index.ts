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
  'access-control-expose-headers': 'x-db-trips',
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

interface RoundRow {
  n: number;
  cells: string;
  created_at: number;
}

const configOf = (g: GameRow): GameConfig => ({ rows: g.rows, cols: g.cols, setSize: g.set_size, seed: g.seed });

const touch = (env: Env, roomId: string) => env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(Date.now(), roomId).run();

/** Which room: by id, or by its code (the TV). */
type RoomRef = { id: string } | { code: string };

/** SQL that selects the room's id, with its parameters, to use as a subquery. */
const roomIdSql = (ref: RoomRef, now: number) =>
  'id' in ref
    ? { sql: '?', params: [ref.id] as unknown[] }
    : {
        sql: "(SELECT id FROM rooms WHERE code = ? AND status != 'closed' AND updated_at > ? ORDER BY created_at DESC LIMIT 1)",
        params: [ref.code, now - ROOM_TTL_MS] as unknown[],
      };

/** Reads of the game's rounds and the picks of the round being chosen (the one after the last round). */
const playStatements = (env: Env, gameSql: string, params: unknown[]) => [
  env.DB.prepare(`SELECT n, cells, created_at FROM rounds WHERE game_id = ${gameSql} ORDER BY n`).bind(...params),
  env.DB.prepare(
    `SELECT seat, slot, cell, actor, created_at FROM picks WHERE game_id = ${gameSql} AND round = (SELECT COUNT(*) FROM rounds WHERE game_id = ${gameSql}) ORDER BY seat, slot`,
  ).bind(...params, ...params),
];

/** Everything needed to show or play a room, read in one round trip. */
interface RoomState {
  /** The caller, when identified by a token. */
  me: PlayerRow | null;
  room: RoomRow;
  members: MemberRow[];
  game: GameRow | null;
  rounds: RoundRow[];
  picks: PickRow[];
  /** Names of the game's players, including any who left the room. */
  seatPlayers: PlayerRow[];
}

/**
 * Loads a room in one batch (one round trip to the database). Dependent lookups
 * (the room's game, the round being chosen) are subqueries. With `seen`, it also
 * records that the caller (a member, or the TV) is still connected.
 */
const loadState = async (
  env: Env,
  ref: RoomRef,
  opts: { who?: { tokenHash: string } | { id: string }; seen?: boolean; tv?: boolean } = {},
): Promise<RoomState> => {
  const now = Date.now();
  const R = roomIdSql(ref, now);
  const gameSql = `(SELECT game_id FROM rooms WHERE id = ${R.sql})`;
  const meSql = opts.who && 'tokenHash' in opts.who ? '(SELECT id FROM players WHERE token_hash = ?)' : '?';
  const meParam = opts.who ? ('tokenHash' in opts.who ? opts.who.tokenHash : opts.who.id) : null;
  const stmts: D1PreparedStatement[] = [];
  if (opts.who && 'tokenHash' in opts.who) stmts.push(env.DB.prepare('SELECT id, nickname FROM players WHERE token_hash = ?').bind(opts.who.tokenHash));
  if (opts.who && opts.seen)
    stmts.push(env.DB.prepare(`UPDATE room_members SET last_seen = ? WHERE room_id = ${R.sql} AND player_id = ${meSql}`).bind(now, ...R.params, meParam));
  if (opts.tv) stmts.push(env.DB.prepare(`UPDATE rooms SET tv_seen_at = ? WHERE id = ${R.sql}`).bind(now, ...R.params));
  const first = stmts.length;
  stmts.push(
    env.DB.prepare(`SELECT * FROM rooms WHERE id = ${R.sql}`).bind(...R.params),
    env.DB.prepare(
      `SELECT m.player_id, p.nickname, m.joined_at, m.last_seen FROM room_members m JOIN players p ON p.id = m.player_id WHERE m.room_id = ${R.sql} ORDER BY m.joined_at`,
    ).bind(...R.params),
    env.DB.prepare(`SELECT * FROM games WHERE id = ${gameSql}`).bind(...R.params),
    ...playStatements(env, gameSql, R.params),
    env.DB.prepare(`SELECT id, nickname FROM players WHERE id IN (SELECT value FROM json_each((SELECT seats FROM games WHERE id = ${gameSql})))`).bind(
      ...R.params,
    ),
  );
  const res = await env.DB.batch(stmts);
  const rows = <T>(i: number) => (res[i].results ?? []) as T[];
  const room = rows<RoomRow>(first)[0];
  if (!room) throw new HttpError(404, 'id' in ref ? 'Room not found' : 'No room with that code');
  return {
    me: opts.who && 'tokenHash' in opts.who ? (rows<PlayerRow>(0)[0] ?? null) : null,
    room,
    members: rows<MemberRow>(first + 1),
    game: rows<GameRow>(first + 2)[0] ?? null,
    rounds: rows<RoundRow>(first + 3),
    picks: rows<PickRow>(first + 4),
    seatPlayers: rows<PlayerRow>(first + 5),
  };
};

/** The game replayed from its rounds. Picks only count while it is being played. */
const playOf = (st: RoomState) => {
  const g = st.game!;
  const game = replay(
    configOf(g),
    st.rounds.map((r) => JSON.parse(r.cells) as number[]),
  );
  const picks = g.status === 'playing' && !game.state.over ? st.picks : [];
  const seats = JSON.parse(g.seats) as string[];
  const roundStartedAt = st.rounds.length ? st.rounds[st.rounds.length - 1].created_at : g.started_at;
  return { game, picks, seats, roundStartedAt };
};

/** The game as everyone may see it: values of face-down cards never leave the server. */
const gameView = (g: GameRow, { game, picks, seats, roundStartedAt }: ReturnType<typeof playOf>): GameView => {
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

/** The room as one viewer sees it, built from a loaded state without further queries. */
const buildView = (st: RoomState, you: string | null): RoomView => {
  const now = Date.now();
  const r = st.room;
  const members = st.members;
  const g = st.game;
  const play = g && r.status !== 'lobby' ? playOf(st) : null;
  const game = g && play ? gameView(g, play) : null;
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
  if (play && game) {
    // The game's players, in seat order, even if someone has left the room since.
    shown = play.seats.map((id, seat) => {
      const m = members.find((x) => x.player_id === id);
      const picked = game.picks.filter((p) => p.seat === seat).length;
      if (m) return member(m, seat, picked);
      const nickname = st.seatPlayers.find((p) => p.id === id)?.nickname ?? 'Player';
      return { id, nickname, seat, host: false, online: false, left: true, picked };
    });
    waiting = members.filter((m) => !play.seats.includes(m.player_id)).map((m, i) => member(m, play.seats.length + i));
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

const requireMember = (st: RoomState, playerId: string) => {
  if (!st.members.some((m) => m.player_id === playerId)) throw new HttpError(403, 'You are not in this room');
};

/** The room as a member sees it (one round trip); also records that they are still connected. */
const memberView = async (env: Env, roomId: string, me: PlayerRow, status = 200) => {
  const st = await loadState(env, { id: roomId }, { who: { id: me.id }, seen: true });
  requireMember(st, me.id);
  return json(buildView(st, me.id), status);
};

const tokenHashOf = async (req: Request) => {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Missing token');
  return sha256(token);
};

/** A poll of the room: the caller is identified inside the same batch, so it's one round trip. */
const getRoom = async (req: Request, env: Env, id: string) => {
  const st = await loadState(env, { id }, { who: { tokenHash: await tokenHashOf(req) }, seen: true });
  if (!st.me) throw new HttpError(401, 'Unknown token');
  requireMember(st, st.me.id);
  return json(buildView(st, st.me.id));
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
    return memberView(env, id, me, 201);
  }
  throw new HttpError(503, 'Could not find a free room code, try again');
};

const joinRoom = async (req: Request, me: PlayerRow, env: Env) => {
  const r = await roomByCode(env, (await body(req)).code);
  const members = await loadMembers(env, r.id);
  if (members.some((m) => m.player_id === me.id)) return memberView(env, r.id, me);
  if (r.status === 'playing') {
    // Someone who left (or was removed from) the game in progress can come back to their seat.
    const g = r.game_id ? await loadGame(env, r.game_id) : null;
    if (!g || !(JSON.parse(g.seats) as string[]).includes(me.id))
      throw new HttpError(409, 'A game is in progress in that room. Join when it ends, or watch it on a TV.');
    const now = Date.now();
    await env.DB.prepare('INSERT OR IGNORE INTO room_members (room_id, player_id, joined_at, last_seen) VALUES (?, ?, ?, ?)').bind(r.id, me.id, now, now).run();
    return memberView(env, r.id, me);
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
  return memberView(env, r.id, me);
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
  return memberView(env, id, me);
};

/** Starts a game with everyone in the room, in join order. Also used for "play again". */
const startGame = async (me: PlayerRow, env: Env, id: string) => {
  const r = await loadRoom(env, id);
  requireHost(r, me);
  if (r.status === 'playing') return memberView(env, r.id, me);
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
  return memberView(env, id, me);
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
 * for anyone who hasn't picked once the round has been open for COVER_MS. The round
 * is flipped as soon as every pick is in.
 *
 * Two round trips: one batch reads everything, one batch writes the pick, flips the
 * round in SQL if it is now complete, and reads the result back. The write batch is a
 * transaction, so when the last two picks arrive at once the second still sees the
 * first and the round is flipped exactly once.
 */
const pick = async (req: Request, env: Env, id: string) => {
  const [tokenHash, data] = await Promise.all([tokenHashOf(req), body(req)]);
  const st = await loadState(env, { id }, { who: { tokenHash }, seen: true });
  if (!st.me) throw new HttpError(401, 'Unknown token');
  const me = st.me;
  requireMember(st, me.id);
  const r = st.room;
  if (r.status !== 'playing' || !st.game || st.game.id !== r.game_id) return json(buildView(st, me.id));
  const g = st.game;
  const { game, picks, seats, roundStartedAt } = playOf(st);
  const mySeat = seats.indexOf(me.id);
  if (mySeat < 0) throw new HttpError(403, 'You are not playing in this game');
  const n = game.state.rounds;
  // A pick meant for a round that has already been flipped is ignored.
  if (Number(data.round) !== n || game.state.over) return json(buildView(st, me.id));
  const problem = game.cellProblem(data.cell);
  if (problem) throw new HttpError(400, problem);
  const cell = data.cell as number;
  const quota = picksPerPlayer(seats.length);
  const now = Date.now();
  const freeSlot = (seat: number) => [...Array(quota).keys()].find((slot) => !picks.some((p) => p.seat === seat && p.slot === slot));
  const insert = (seat: number, slot: number) =>
    env.DB.prepare('INSERT INTO picks (game_id, round, seat, slot, cell, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(g.id, n, seat, slot, cell, me.id, now);
  let write: D1PreparedStatement;
  const taken = picks.find((p) => p.cell === cell);
  if (taken) {
    if (taken.seat !== mySeat && taken.actor !== me.id) throw new HttpError(409, 'Someone else picked that card');
    write = env.DB.prepare('DELETE FROM picks WHERE game_id = ? AND round = ? AND seat = ? AND slot = ?').bind(g.id, n, taken.seat, taken.slot);
  } else if (freeSlot(mySeat) !== undefined) {
    write = insert(mySeat, freeSlot(mySeat)!);
  } else {
    // Someone who left the room can be picked for at once; anyone else once the round has been open COVER_MS.
    const present = new Set(st.members.map((m) => m.player_id));
    const open = seats.map((pid, seat) => ({ seat, left: !present.has(pid) })).filter((x) => freeSlot(x.seat) !== undefined);
    const away = (open.find((x) => x.left) ?? (now >= roundStartedAt + COVER_MS ? open[0] : undefined))?.seat;
    if (away !== undefined) write = insert(away, freeSlot(away)!);
    else {
      const oldest = picks.filter((p) => p.seat === mySeat).sort((a, b) => a.created_at - b.created_at)[0];
      write = env.DB.prepare('UPDATE picks SET cell = ?, actor = ?, created_at = ? WHERE game_id = ? AND round = ? AND seat = ? AND slot = ?').bind(
        cell,
        me.id,
        now,
        g.id,
        n,
        oldest.seat,
        oldest.slot,
      );
    }
  }
  let res: D1Result[];
  try {
    res = await env.DB.batch([
      write,
      // Flip the round once all its picks are in. Every pick was checked against this round, so they form a valid round.
      env.DB.prepare(
        `INSERT OR IGNORE INTO rounds (game_id, n, cells, created_at)
         SELECT ?, ?, (SELECT json_group_array(cell) FROM (SELECT cell FROM picks WHERE game_id = ? AND round = ? ORDER BY seat, slot)), ?
         WHERE (SELECT COUNT(*) FROM picks WHERE game_id = ? AND round = ?) = ?`,
      ).bind(g.id, n, g.id, n, now, g.id, n, g.set_size),
      env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(now, r.id),
      ...playStatements(env, '?', [g.id]),
    ]);
  } catch (e) {
    // Two players picked the same card, or the same slot, at the same moment.
    if (isUniqueViolation(e)) throw new HttpError(409, 'Someone just picked that card');
    throw e;
  }
  st.rounds = (res[3].results ?? []) as RoundRow[];
  st.picks = (res[4].results ?? []) as PickRow[];
  // The last set closed: end the game (a third round trip, once per game).
  if (playOf(st).game.state.over && g.status === 'playing') {
    await finishGame(env, r, g.id, 'won');
    g.status = 'won';
    g.finished_at = now;
    r.status = 'finished';
  }
  return json(buildView(st, me.id));
};

/** The host stops the game in progress; the room goes back to choosing the next one. */
const endGame = async (me: PlayerRow, env: Env, id: string) => {
  const r = await loadRoom(env, id);
  requireHost(r, me);
  if (r.status === 'playing' && r.game_id) await finishGame(env, r, r.game_id, 'ended');
  return memberView(env, id, me);
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
  return memberView(env, id, me);
};

/** The room this player was in most recently, so a reload can return to it. */
const currentRoom = async (me: PlayerRow, env: Env) => {
  const r = await env.DB.prepare(
    "SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.player_id = ? AND r.status != 'closed' AND r.updated_at > ? ORDER BY m.last_seen DESC LIMIT 1",
  )
    .bind(me.id, Date.now() - ROOM_TTL_MS)
    .first<RoomRow>();
  return json({ room: r ? buildView(await loadState(env, { id: r.id }), me.id) : null });
};

/** A TV screen: shows the room by its code, without an account and without being a player. */
const tvView = async (env: Env, code: string) =>
  json(buildView(await loadState(env, { code: code.toUpperCase() }, { tv: true }), null));

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

  const fast = path.match(/^\/api\/rooms\/([0-9a-f]{16})(\/pick)?$/);
  if (fast && !fast[2] && method === 'GET') return getRoom(req, env, fast[1]);
  if (fast && fast[2] && method === 'POST') return pick(req, env, fast[1]);

  const me = await authenticate(req, env);
  if (path === '/api/me' && method === 'GET') return json({ player: me });
  if (path === '/api/me' && method === 'POST') return renamePlayer(req, me, env);
  if (path === '/api/me/room' && method === 'GET') return currentRoom(me, env);
  if (path === '/api/rooms' && method === 'POST') return createRoom(req, me, env);
  if (path === '/api/rooms/join' && method === 'POST') return joinRoom(req, me, env);
  const room = path.match(/^\/api\/rooms\/([0-9a-f]{16})(?:\/(settings|start|end|leave|remove))?$/);
  if (room && room[2] && method === 'POST') {
    const id = room[1];
    switch (room[2]) {
      case 'settings':
        return changeSettings(req, me, env, id);
      case 'start':
        return startGame(me, env, id);
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

/**
 * Wraps the database to count round trips (each run/first/all, or one batch), so every
 * response can report them in an `x-db-trips` header: latency grows with each one.
 */
const countingDb = (db: D1Database) => {
  const counter = { trips: 0 };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'run' || key === 'first' || key === 'all' || key === 'raw')
          return (...args: unknown[]) => {
            counter.trips++;
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    real.set(proxy, st);
    return proxy;
  };
  const wrapped = {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: (statements: D1PreparedStatement[]) => {
      counter.trips++;
      return db.batch(statements.map((x) => real.get(x) ?? x));
    },
    exec: (query: string) => {
      counter.trips++;
      return db.exec(query);
    },
  } as unknown as D1Database;
  return { db: wrapped, counter };
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { db, counter } = countingDb(env.DB);
    let res: Response;
    try {
      res = await route(req, { ...env, DB: db });
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message }, e.status);
      else {
        console.error(e);
        res = json({ error: 'Server error' }, 500);
      }
    }
    res.headers.set('x-db-trips', String(counter.trips));
    return res;
  },
} satisfies ExportedHandler<Env>;

// Plays a whole cooperative game between three scripted players, with a TV watching, against a running server.
// Usage: npx tsx test/e2e.ts [http://localhost:8787]
import type { RoomView } from '../../webapp/src/online/types';

const base = process.argv[2] ?? 'http://localhost:8787';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const request = async (path: string, token?: string, data?: unknown) => {
  const res = await fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const call = async (path: string, token?: string, data?: unknown) => {
  const { status, body } = await request(path, token, data);
  if (status >= 400) throw new Error(`${path}: ${status} ${JSON.stringify(body)}`);
  return body;
};

const assert = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};

const main = async () => {
  const [a, b, c, d, e] = await Promise.all(['Ana', 'Ben', 'Cy', 'Dee', 'Eve'].map((nickname) => call('/api/players', undefined, { nickname })));
  const created: RoomView = await call('/api/rooms', a.token, { rows: 3, cols: 4 });
  assert(created.status === 'lobby' && created.code.length === 4, 'room waits in the lobby with a code');
  const id = created.id;
  await call('/api/rooms/join', b.token, { code: created.code.toLowerCase() });
  let room: RoomView = await call('/api/rooms/join', c.token, { code: created.code });
  assert(room.members.map((m) => m.nickname).join() === 'Ana,Ben,Cy', 'players join in turn order');
  assert(room.nextSetSize === 3, 'three players look for sets of three');
  assert((await request(`/api/rooms/${id}/start`, b.token, {})).status === 403, 'only the host starts the game');

  const tv: RoomView = await call(`/api/tv/${created.code}`);
  assert(tv.you === null && tv.status === 'lobby', 'a TV watches the room by its code');
  room = await call(`/api/rooms/${id}`, a.token);
  assert(room.tv, 'players see that a TV is connected');

  await call(`/api/rooms/${id}/settings`, a.token, { rows: 2, cols: 2 });
  assert((await request(`/api/rooms/${id}/start`, a.token, {})).status === 400, 'a grid too small for two sets of three is refused');
  await call(`/api/rooms/${id}/settings`, a.token, { rows: 3, cols: 4 });
  room = await call(`/api/rooms/${id}/start`, a.token, {});
  assert(room.status === 'playing' && room.game?.setSize === 3 && room.game.sets === 4, 'the game starts with four sets of three');
  assert(room.game!.cells.every((x) => x.state === 'down'), 'no card is shown before it is flipped');
  assert((await request('/api/rooms/join', d.token, { code: created.code })).status === 409, 'nobody joins a game in progress');
  assert((await request(`/api/rooms/${id}/flip`, b.token, { n: 0, cell: 0 })).status === 409, 'players wait for their turn');

  // Each player remembers every card they have seen.
  const tokens = [a.token, b.token, c.token];
  const known = new Map<number, number>();
  let misses = 0;
  while (room.status === 'playing') {
    const g = room.game!;
    g.cells.forEach((x, i) => 'value' in x && known.set(i, x.value));
    const playable = (i: number) => g.cells[i].state === 'down' || g.cells[i].state === 'miss';
    const unknown = g.cells.findIndex((x, i) => playable(i) && !known.has(i));
    let cell: number;
    if (g.open.length) {
      const want = known.get(g.open[0]);
      const match = [...known].find(([i, v]) => v === want && playable(i));
      cell = match ? match[0] : unknown;
    } else {
      const counts = new Map<number, number[]>();
      for (const [i, v] of known) if (playable(i)) counts.set(v, [...(counts.get(v) ?? []), i]);
      const full = [...counts.values()].find((cells) => cells.length === g.setSize);
      cell = full ? full[0] : unknown;
    }
    if (g.lastMiss) await sleep(950);
    const before = g.flips;
    room = await call(`/api/rooms/${id}/flip`, tokens[g.turn], { n: g.flips, cell });
    assert(room.game!.flips === before + 1, `flip ${before + 1}: ${room.game!.last!.result}`);
    if (room.game!.last!.result === 'miss') misses++;
  }
  const g = room.game!;
  assert(room.status === 'finished' && g.status === 'won' && g.setsClosed === 4, 'the team wins when every set is closed');
  assert(g.misses === misses && g.attempts === misses + 4, 'misses and attempts are counted');
  assert(room.members.reduce((n, m) => n + m.sets, 0) === 4, 'every set is credited to a player');
  const watched: RoomView = await call(`/api/tv/${created.code}`);
  assert(watched.game?.status === 'won' && watched.game.cells.every((x) => x.state === 'closed'), 'the TV sees the finished board');

  // A fourth and fifth player arrive for the next game: the room holds four.
  await call('/api/rooms/join', d.token, { code: created.code });
  assert((await request('/api/rooms/join', e.token, { code: created.code })).status === 409, 'a room holds four players');
  room = await call(`/api/rooms/${id}`, a.token);
  assert(room.waiting.length === 1 && room.nextSetSize === 4, 'the next game will have sets of four');
  room = await call(`/api/rooms/${id}/start`, a.token, {});
  assert(room.game?.setSize === 4 && room.members.length === 4, 'play again with four players');
  assert((await request(`/api/rooms/${id}/leave`, b.token, {})).status === 409, 'players stay while their game is going');
  room = await call(`/api/rooms/${id}/end`, a.token, {});
  assert(room.status === 'finished' && room.game?.status === 'ended', 'the host can end the game');
  await call(`/api/rooms/${id}/leave`, a.token, {});
  room = await call(`/api/rooms/${id}`, b.token);
  assert(room.hostId === b.player.id && room.members.length === 4, 'the host passes on when they leave');
  const current = await call('/api/me/room', c.token);
  assert(current.room?.id === id, 'a player returns to their room after a reload');
  console.log('\nAll good.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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

  // The first round: picks are visible (face down) and can be changed until everyone has picked.
  const pickFor = (token: string, round: number, cell: number) => call(`/api/rooms/${id}/pick`, token, { round, cell });
  room = await pickFor(a.token, 0, 0);
  assert(room.game!.picks.length === 1 && room.game!.picks[0].seat === 0 && room.members[0].picked === 1, 'a pick is shown to everyone, face down');
  assert(room.game!.cells[0].state === 'down', 'a picked card stays face down');
  assert((await request(`/api/rooms/${id}/pick`, b.token, { round: 0, cell: 0 })).status === 409, 'a card can only be picked by one player');
  room = await pickFor(a.token, 0, 1);
  assert(room.game!.picks.map((p) => p.cell).join() === '1', 'picking another card moves your pick');
  room = await pickFor(a.token, 0, 1);
  assert(room.game!.picks.length === 0, 'picking your card again takes it back');

  // Each round every player picks one card; they remember every card they have seen.
  const tokens = [a.token, b.token, c.token];
  const known = new Map<number, number>();
  let misses = 0;
  while (room.status === 'playing') {
    const g = room.game!;
    g.cells.forEach((x, i) => 'value' in x && known.set(i, x.value));
    const playable = (i: number) => g.cells[i].state === 'down' || g.cells[i].state === 'miss';
    const counts = new Map<number, number[]>();
    for (const [i, v] of known) if (playable(i)) counts.set(v, [...(counts.get(v) ?? []), i]);
    const full = [...counts.values()].find((cells) => cells.length === g.setSize);
    const unknown = g.cells.map((_, i) => i).filter((i) => playable(i) && !known.has(i));
    const cells = full ?? [...unknown, ...[...known.keys()].filter(playable)].slice(0, g.setSize);
    for (const [seat, cell] of cells.entries()) {
      room = await pickFor(tokens[seat], g.round, cell);
      if (seat < cells.length - 1) assert(room.game!.round === g.round, `round ${g.round + 1}: waits for every pick`);
    }
    assert(room.game!.round === g.round + 1, `round ${g.round + 1}: flipped, ${room.game!.last!.result}`);
    if (room.game!.last!.result === 'miss') {
      misses++;
      assert(room.game!.lastMiss!.every((c) => room.game!.cells[c].state === 'miss'), 'a missed round shows its cards');
    }
  }
  const g = room.game!;
  assert(room.status === 'finished' && g.status === 'won' && g.setsClosed === 4, 'the team wins when every set is closed');
  assert(g.misses === misses && g.round === misses + 4, 'misses and rounds are counted');
  const watched: RoomView = await call(`/api/tv/${created.code}`);
  assert(watched.game?.status === 'won' && watched.game.cells.every((x) => x.state === 'closed'), 'the TV sees the finished board');

  // A fourth and fifth player arrive for the next game: the room holds four.
  await call('/api/rooms/join', d.token, { code: created.code });
  assert((await request('/api/rooms/join', e.token, { code: created.code })).status === 409, 'a room holds four players');
  room = await call(`/api/rooms/${id}`, a.token);
  assert(room.waiting.length === 1 && room.nextSetSize === 4, 'the next game will have sets of four');
  room = await call(`/api/rooms/${id}/start`, a.token, {});
  assert(room.game?.setSize === 4 && room.members.length === 4, 'play again with four players');

  // Leaving mid-game: the seat stays, and the others pick for it straight away.
  await call(`/api/rooms/${id}/leave`, c.token, {});
  room = await call(`/api/rooms/${id}`, a.token);
  assert(room.status === 'playing' && room.members[2].left, 'a player can leave a game in progress; their seat stays');
  const round = room.game!.round;
  await pickFor(a.token, round, 0);
  await pickFor(b.token, round, 1);
  room = await pickFor(d.token, round, 2);
  assert(room.game!.round === round, 'the round waits for the seat that left');
  room = await pickFor(a.token, round, 3);
  assert(room.game!.round === round + 1, 'someone who has picked can pick for a player who left, without waiting');
  room = await call('/api/rooms/join', c.token, { code: created.code });
  assert(room.status === 'playing' && !room.members[2].left, 'a player who left can rejoin the game in progress');

  // The host can remove a player; only the host.
  assert((await request(`/api/rooms/${id}/remove`, b.token, { playerId: d.player.id })).status === 403, 'only the host removes players');
  room = await call(`/api/rooms/${id}/remove`, a.token, { playerId: d.player.id });
  assert(room.members[3].left && room.status === 'playing', 'the host removes a player; their seat stays in the game');
  assert((await request(`/api/rooms/${id}`, d.token)).status === 403, 'a removed player is out of the room');
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

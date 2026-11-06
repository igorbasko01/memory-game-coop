# Memory Co-op — online server

A Cloudflare Worker with a D1 (SQLite) database. It also serves the built web app, so the API lives under `/api/*` on the same address.

## API

All endpoints except creating a player and the TV view need `Authorization: Bearer <token>`. Room endpoints return the room as the caller sees it (`RoomView` in `webapp/src/online/types.ts`).

| Method & path | What it does |
| --- | --- |
| `POST /api/players` `{nickname}` | Creates a device player: `{player, token}` |
| `POST /api/me` `{nickname}` | Renames the player |
| `GET /api/me/room` | The room the player was in most recently (to resume after a reload) |
| `POST /api/rooms` `{rows, cols}` | Creates a room with a 4-letter code; the creator is the host |
| `POST /api/rooms/join` `{code}` | Joins a room in the lobby or between games (max 4); rejoins if already a member |
| `GET /api/rooms/:id` | The room; also marks the player as connected |
| `POST /api/rooms/:id/settings` `{rows, cols}` | Host: changes the grid between games |
| `POST /api/rooms/:id/start` | Host: starts a game with everyone in the room, in join order (also *play again*) |
| `POST /api/rooms/:id/flip` `{n, cell}` | Flips a card. `n` is the number of flips so far; a stale `n` is ignored |
| `POST /api/rooms/:id/end` | Host: ends the game in progress |
| `POST /api/rooms/:id/leave` | Leaves (not while your game is going, unless you're the host, which ends it). The host role passes on |
| `GET /api/tv/:code` | The TV view of a room, no account needed. Marks a TV as connected |

## Rules the server enforces

- The set size is the number of players when the game starts (at least 2), and the grid must hold at least two sets.
- Only the player whose turn it is may flip, except that after 20 seconds without a flip anyone in the game may (covering for someone who left).
- After a miss the next flip waits 0.9 s, so everyone sees the cards.
- Face-down values never leave the server: the board is dealt from a seed kept in the `games` table.

## Develop

```sh
npm ci
npx wrangler d1 migrations apply memory-coop --local
npm run dev    # http://localhost:8787 (build webapp/ first: it serves webapp/dist)
npm run e2e    # plays a full game between three scripted players, with a TV watching
```

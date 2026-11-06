# 🃏 Memory Co-op

A **cooperative online memory game** for 1–4 players, with an optional TV as the big screen.

## How it plays

- One player creates a **room** and picks a **grid** (presets from 3×4 to 6×8, or any size from 2×2 to 8×8). Everyone else joins on their phone with the 4-letter room code, the invite link, or the QR code on the TV.
- The cards are numbered, and **every number appears once per player**: with 3 players you look for **3 matching cards** to close a set (a solo player looks for pairs). Cells that don't fit a whole set stay empty.
- Players take turns flipping **one card each**, round-robin. An attempt continues while the cards match; when it has a full set, the set stays face up. The first card that doesn't match ends the attempt: everyone sees the cards for a moment, then they turn back over.
- The team wins together when every set is closed. The result shows the time, the misses, and who closed each set.
- **TV mode:** open the game on a TV (or laptop), choose *Use this screen as a TV* and enter the room code (or open `/?tv=ABCD`). In the lobby it shows a big QR code and the code for joining, and the players as they arrive; during the game it shows the board, whose turn it is, the set being built, stats and a flash for every set and miss. Phones show *📺 TV on* while it's connected. The TV needs no account and never sees a card before it's flipped.
- If a player drops out, anyone can flip for them after 20 seconds. The host can end a game, change the grid and start the next one (*Play again*); new players can join between games.

## Architecture

Same shape as [tennis_strategy_game](https://github.com/igorbasko01/tennis_strategy_game)'s online mode:

```
webapp/                 # Vite + TypeScript, no framework (DOM + CSS)
├── src/engine/game.ts  # The rules: dealing from a seed, flips, sets, misses. Shared with the server, unit tested
├── src/online/         # API client, device identity, the view types shared with the server
└── src/ui/             # board.ts (the cards), app.ts (phone), tv.ts (big screen), parts.ts
server/                 # One Cloudflare Worker + D1 (SQLite): serves webapp/dist and the API under /api/*
├── src/index.ts
├── migrations/
└── test/e2e.ts         # Plays a whole 3-player game (and a TV) against a running server
```

- **No stored game state.** A game is replayed from its random seed and the list of flips, with the same engine the browser uses. The deck only ever exists on the server; clients get the values of face-up cards only.
- **Polling, not sockets.** Phones poll the room about once a second, the TV a little faster. Flips are numbered (`flips` primary key `(game_id, n)`), so two flips at once or a double tap can't both count.
- **Players** are per device: a nickname and a secret token (stored hashed) kept in the browser.

See [server/README.md](server/README.md) for the API.

## Develop

```bash
cd webapp && npm install && npm test && npm run build
cd ../server && npm install
npx wrangler d1 migrations apply memory-coop --local
npm run dev        # http://localhost:8787 serves the built app and the API
npm run e2e        # in another terminal
```

Or run `VITE_API_URL=http://localhost:8787 npm run dev` in `webapp/` for hot reload. Open several browser windows (or a private window per player) to play with yourself, and one with `?tv` for the TV.

## Deploy

`.github/workflows/deploy.yml` tests and builds the web app, type-checks the Worker on pull requests, and on `main` applies D1 migrations and deploys. Before the first deploy:

1. Create the database: `cd server && npx wrangler d1 create memory-coop`, and put its id in `server/wrangler.toml` (`database_id`).
2. Add the repo secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, D1 Edit, plus Workers Routes Edit for a custom domain) and `CLOUDFLARE_ACCOUNT_ID`.
3. Optionally set a custom domain in `server/wrangler.toml` (`routes`); otherwise it is served on `memory-coop.<subdomain>.workers.dev`.

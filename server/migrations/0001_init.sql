-- Players are identified per device: a public id plus a secret token (stored hashed).
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- A room: its players gather in the lobby, play a game together, and can play again.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES players(id),
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lobby', 'playing', 'finished', 'closed')),
  -- The game being played, or the last one played.
  game_id TEXT,
  -- The last time a TV screen checked in.
  tv_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX rooms_code ON rooms (code, updated_at);

-- Who is in a room. Turn order is join order.
CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room_id, player_id)
);
CREATE INDEX room_members_player ON room_members (player_id, last_seen);

-- One game in a room. The board is dealt from the seed; its state is replayed from the flips.
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seed INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  set_size INTEGER NOT NULL,
  -- Player ids in turn order (JSON array).
  seats TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('playing', 'won', 'ended')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX games_room ON games (room_id, started_at);

-- Every round the team played: the cards picked, flipped together. Numbered from 0.
CREATE TABLE rounds (
  game_id TEXT NOT NULL REFERENCES games(id),
  n INTEGER NOT NULL,
  -- Cell indexes (JSON array), in seat order.
  cells TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, n)
);

-- The picks of the round being chosen: one row per seat and slot (a solo player has two slots).
-- A card can only be picked once per round.
CREATE TABLE picks (
  game_id TEXT NOT NULL REFERENCES games(id),
  round INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  cell INTEGER NOT NULL,
  -- Who picked it: another player can pick for someone who is away.
  actor TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, round, seat, slot),
  UNIQUE (game_id, round, cell)
);

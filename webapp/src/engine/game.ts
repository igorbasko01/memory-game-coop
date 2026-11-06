/**
 * The cooperative memory game, shared by the browser and the server.
 *
 * The board is dealt from a seed. A game is replayed from that seed and the list
 * of flipped cells, so the server only stores the flips and the browser never
 * needs to know a card before it is turned over.
 *
 * Rules:
 * - Every number appears `setSize` times; the set size is the number of players
 *   (at least 2, so a solo player looks for pairs).
 * - Players flip one card each, in turn order, round-robin across the whole game.
 * - An attempt is open while its face-up cards all show the same number. When it
 *   holds `setSize` matching cards the set is closed and stays face up.
 * - The first card that doesn't match ends the attempt as a miss: its cards are
 *   shown to everyone and then turned face down again.
 * - The team wins together when every set is closed.
 */

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 4;
export const GRID_MIN = 2;
export const GRID_MAX = 8;

/** How many matching cards make a set for this many players. */
export const setSizeFor = (players: number) => Math.max(2, Math.min(MAX_PLAYERS, players));

/** How many cards fit on a grid: whole sets only, the remaining cells stay empty. */
export const layoutOf = (rows: number, cols: number, setSize: number) => {
  const cells = rows * cols;
  const sets = Math.floor(cells / setSize);
  return { cells, sets, cards: sets * setSize, empty: cells - sets * setSize };
};

/** Why a grid can't be played with this set size, or null when it can. */
export const gridProblem = (rows: unknown, cols: unknown, setSize: number): string | null => {
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= GRID_MIN && (n as number) <= GRID_MAX;
  if (!ok(rows) || !ok(cols)) return `Rows and columns must be between ${GRID_MIN} and ${GRID_MAX}`;
  if (layoutOf(rows as number, cols as number, setSize).sets < 2) return 'The grid needs room for at least two sets';
  return null;
};

/** Ready-made grids offered in the lobby. */
export const GRID_PRESETS: { rows: number; cols: number; label: string }[] = [
  { rows: 3, cols: 4, label: 'Small' },
  { rows: 4, cols: 4, label: 'Classic' },
  { rows: 4, cols: 6, label: 'Medium' },
  { rows: 5, cols: 6, label: 'Large' },
  { rows: 6, cols: 6, label: 'Big' },
  { rows: 6, cols: 8, label: 'Huge' },
];

/** A small seeded generator (mulberry32), so the server and tests deal the same board. */
export const seededRandom = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface GameConfig {
  rows: number;
  cols: number;
  setSize: number;
  /** Players in turn order. */
  players: number;
  seed: number;
}

/**
 * The value under each cell (1..sets), or null for an empty cell. Empty cells
 * are the last ones on the board, so the cards stay in one block.
 */
export const deal = (config: Pick<GameConfig, 'rows' | 'cols' | 'setSize' | 'seed'>): (number | null)[] => {
  const { cards, empty } = layoutOf(config.rows, config.cols, config.setSize);
  const deck = Array.from({ length: cards }, (_, i) => Math.floor(i / config.setSize) + 1);
  const random = seededRandom(config.seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return [...deck, ...Array<null>(empty).fill(null)];
};

export type FlipResult = 'open' | 'set' | 'miss';

export interface GameState {
  /** The seat that closed each cell's set, or null while it's still in play. */
  closedBy: (number | null)[];
  /** Cells of the attempt in progress, in the order they were flipped. */
  open: number[];
  /** Cells of the attempt that just failed, until the next flip. */
  lastMiss: number[] | null;
  /** The result of the latest flip. */
  last: { cell: number; seat: number; result: FlipResult } | null;
  flips: number;
  /** Finished attempts: closed sets plus misses. */
  attempts: number;
  misses: number;
  setsClosed: number;
  /** Sets closed on each seat's turn. */
  setsBySeat: number[];
  /** Whose turn it is. */
  turn: number;
  over: boolean;
}

export class MemoryGame {
  readonly deck: (number | null)[];
  readonly sets: number;
  state: GameState;

  constructor(readonly config: GameConfig) {
    this.deck = deal(config);
    this.sets = layoutOf(config.rows, config.cols, config.setSize).sets;
    this.state = {
      closedBy: this.deck.map(() => null),
      open: [],
      lastMiss: null,
      last: null,
      flips: 0,
      attempts: 0,
      misses: 0,
      setsClosed: 0,
      setsBySeat: Array<number>(config.players).fill(0),
      turn: 0,
      over: false,
    };
  }

  /** Why this cell can't be flipped now, or null when it can. */
  problem(cell: unknown): string | null {
    const s = this.state;
    if (s.over) return 'The game is over';
    if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) >= this.deck.length) return 'No such card';
    const c = cell as number;
    if (this.deck[c] === null) return 'That cell is empty';
    if (s.closedBy[c] !== null) return 'That set is already closed';
    if (s.open.includes(c)) return 'That card is already face up';
    return null;
  }

  /** Flips a card on the current player's turn. */
  flip(cell: number): FlipResult {
    const why = this.problem(cell);
    if (why) throw new Error(why);
    const s = this.state;
    const seat = s.turn;
    s.lastMiss = null;
    s.open.push(cell);
    s.flips++;
    s.turn = s.flips % this.config.players;
    const value = this.deck[cell];
    let result: FlipResult = 'open';
    if (s.open.some((c) => this.deck[c] !== value)) {
      result = 'miss';
      s.lastMiss = s.open;
      s.open = [];
      s.attempts++;
      s.misses++;
    } else if (s.open.length === this.config.setSize) {
      result = 'set';
      for (const c of s.open) s.closedBy[c] = seat;
      s.open = [];
      s.attempts++;
      s.setsClosed++;
      s.setsBySeat[seat]++;
      s.over = s.setsClosed === this.sets;
    }
    s.last = { cell, seat, result };
    return result;
  }

  /** The value of a cell, as everyone may see it now: face up, closed, or just missed. */
  visible(cell: number): number | null {
    const s = this.state;
    const shown = s.closedBy[cell] !== null || s.open.includes(cell) || !!s.lastMiss?.includes(cell);
    return shown ? this.deck[cell] : null;
  }
}

/** Replays a game from its flips. */
export const replay = (config: GameConfig, flips: number[]) => {
  const game = new MemoryGame(config);
  for (const cell of flips) game.flip(cell);
  return game;
};

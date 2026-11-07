/**
 * The cooperative memory game, shared by the browser and the server.
 *
 * The board is dealt from a seed. A game is replayed from that seed and the list
 * of rounds played, so the server only stores the rounds and the browser never
 * needs to know a card before it is turned over.
 *
 * Rules:
 * - Every number appears `setSize` times; the set size is the number of players
 *   (at least 2, so a solo player looks for pairs).
 * - The team plays in rounds. In each round every player picks one card (a solo
 *   player picks two) while the cards stay face down; players can see who picked
 *   which card and change their pick until the last one is in.
 * - Then all the picked cards flip at once. If they all show the same number the
 *   set is closed and stays face up; otherwise it's a miss: everyone sees the
 *   cards, then they turn face down again.
 * - The team wins together when every set is closed.
 */

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 4;
export const GRID_MIN = 2;
export const GRID_MAX = 8;

/** How many matching cards make a set for this many players. */
export const setSizeFor = (players: number) => Math.max(2, Math.min(MAX_PLAYERS, players));

/** How many cards each player picks per round. */
export const picksPerPlayer = (players: number) => setSizeFor(players) / Math.max(1, players);

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
  seed: number;
}

/**
 * The value under each cell (1..sets), or null for an empty cell. Empty cells
 * are the last ones on the board, so the cards stay in one block.
 */
export const deal = (config: GameConfig): (number | null)[] => {
  const { cards, empty } = layoutOf(config.rows, config.cols, config.setSize);
  const deck = Array.from({ length: cards }, (_, i) => Math.floor(i / config.setSize) + 1);
  const random = seededRandom(config.seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return [...deck, ...Array<null>(empty).fill(null)];
};

export type RoundResult = 'set' | 'miss';

export interface GameState {
  /** Whether each cell's set has been closed. */
  closed: boolean[];
  /** The cells of the round that just missed, until the next round. */
  lastMiss: number[] | null;
  /** The latest round. */
  last: { cells: number[]; result: RoundResult } | null;
  /** Rounds played: closed sets plus misses. */
  rounds: number;
  misses: number;
  setsClosed: number;
  over: boolean;
}

export class MemoryGame {
  readonly deck: (number | null)[];
  readonly sets: number;
  state: GameState;

  constructor(readonly config: GameConfig) {
    this.deck = deal(config);
    this.sets = layoutOf(config.rows, config.cols, config.setSize).sets;
    this.state = { closed: this.deck.map(() => false), lastMiss: null, last: null, rounds: 0, misses: 0, setsClosed: 0, over: false };
  }

  /** Why this cell can't be picked now, or null when it can. */
  cellProblem(cell: unknown): string | null {
    if (this.state.over) return 'The game is over';
    if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) >= this.deck.length) return 'No such card';
    if (this.deck[cell as number] === null) return 'That cell is empty';
    if (this.state.closed[cell as number]) return 'That set is already closed';
    return null;
  }

  /** Why these cells can't be played as a round, or null when they can. */
  roundProblem(cells: unknown[]): string | null {
    if (cells.length !== this.config.setSize) return `A round needs ${this.config.setSize} cards`;
    if (new Set(cells).size !== cells.length) return 'Each card can be picked once';
    for (const c of cells) {
      const why = this.cellProblem(c);
      if (why) return why;
    }
    return null;
  }

  /** Flips the team's picked cards together. */
  play(cells: number[]): RoundResult {
    const why = this.roundProblem(cells);
    if (why) throw new Error(why);
    const s = this.state;
    const value = this.deck[cells[0]];
    const result: RoundResult = cells.every((c) => this.deck[c] === value) ? 'set' : 'miss';
    s.rounds++;
    if (result === 'set') {
      for (const c of cells) s.closed[c] = true;
      s.setsClosed++;
      s.lastMiss = null;
      s.over = s.setsClosed === this.sets;
    } else {
      s.misses++;
      s.lastMiss = [...cells];
    }
    s.last = { cells: [...cells], result };
    return result;
  }
}

/** Replays a game from its rounds. */
export const replay = (config: GameConfig, rounds: number[][]) => {
  const game = new MemoryGame(config);
  for (const cells of rounds) game.play(cells);
  return game;
};

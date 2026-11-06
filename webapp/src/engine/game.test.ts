import { describe, expect, it } from 'vitest';
import { deal, gridProblem, layoutOf, MemoryGame, replay, setSizeFor } from './game';

const config = { rows: 3, cols: 4, setSize: 3, players: 3, seed: 42 };

/** The cells holding each value. */
const cellsByValue = (deck: (number | null)[]) => {
  const map = new Map<number, number[]>();
  deck.forEach((v, i) => v !== null && map.set(v, [...(map.get(v) ?? []), i]));
  return map;
};

describe('set size and layout', () => {
  it('is the number of players, with pairs for a solo player', () => {
    expect([1, 2, 3, 4].map(setSizeFor)).toEqual([2, 2, 3, 4]);
  });

  it('keeps whole sets and leaves the rest of the grid empty', () => {
    expect(layoutOf(4, 4, 3)).toEqual({ cells: 16, sets: 5, cards: 15, empty: 1 });
    expect(layoutOf(4, 4, 4)).toEqual({ cells: 16, sets: 4, cards: 16, empty: 0 });
  });

  it('rejects grids that are out of range or too small', () => {
    expect(gridProblem(4, 4, 2)).toBeNull();
    expect(gridProblem(1, 4, 2)).not.toBeNull();
    expect(gridProblem(9, 4, 2)).not.toBeNull();
    expect(gridProblem(2, 3, 4)).not.toBeNull();
    expect(gridProblem('4', 4, 2)).not.toBeNull();
  });
});

describe('deal', () => {
  it('puts every number down set-size times, the same way for the same seed', () => {
    const deck = deal({ rows: 4, cols: 4, setSize: 3, seed: 7 });
    expect(deck).toHaveLength(16);
    expect(deck[15]).toBeNull();
    for (const cells of cellsByValue(deck).values()) expect(cells).toHaveLength(3);
    expect(deal({ rows: 4, cols: 4, setSize: 3, seed: 7 })).toEqual(deck);
    expect(deal({ rows: 4, cols: 4, setSize: 3, seed: 8 })).not.toEqual(deck);
  });
});

describe('a game', () => {
  it('closes a set when every player turns up the same number', () => {
    const game = new MemoryGame(config);
    const [a, b, c] = cellsByValue(game.deck).get(1)!;
    expect(game.flip(a)).toBe('open');
    expect(game.state.turn).toBe(1);
    expect(game.flip(b)).toBe('open');
    expect(game.flip(c)).toBe('set');
    expect(game.state.closedBy[a]).toBe(2);
    expect(game.state.setsBySeat).toEqual([0, 0, 1]);
    expect(game.state.turn).toBe(0);
    expect(game.visible(a)).toBe(1);
  });

  it('ends the attempt at the first card that does not match, and shows it until the next flip', () => {
    const game = new MemoryGame(config);
    const ones = cellsByValue(game.deck).get(1)!;
    const two = cellsByValue(game.deck).get(2)![0];
    game.flip(ones[0]);
    expect(game.flip(two)).toBe('miss');
    expect(game.state.open).toEqual([]);
    expect(game.state.lastMiss).toEqual([ones[0], two]);
    expect(game.visible(two)).toBe(2);
    expect(game.state.misses).toBe(1);
    // The turn keeps rotating: the third player starts the next attempt.
    expect(game.state.turn).toBe(2);
    game.flip(ones[1]);
    expect(game.state.lastMiss).toBeNull();
    expect(game.visible(two)).toBeNull();
  });

  it('refuses cards that are face up, closed or empty', () => {
    const game = new MemoryGame({ ...config, rows: 4, cols: 4 });
    const [a, b, c] = cellsByValue(game.deck).get(1)!;
    game.flip(a);
    expect(game.problem(a)).not.toBeNull();
    game.flip(b);
    game.flip(c);
    expect(game.problem(b)).not.toBeNull();
    expect(game.problem(15)).not.toBeNull();
    expect(game.problem(99)).not.toBeNull();
    expect(() => game.flip(c)).toThrow();
  });

  it('is won when every set is closed, and replays to the same state', () => {
    const game = new MemoryGame({ ...config, players: 2, setSize: 2 });
    const flips: number[] = [];
    for (const cells of cellsByValue(game.deck).values())
      for (const cell of cells) {
        game.flip(cell);
        flips.push(cell);
      }
    expect(game.state.over).toBe(true);
    expect(game.state.misses).toBe(0);
    expect(game.state.setsClosed).toBe(6);
    expect(game.problem(0)).toBe('The game is over');
    expect(replay({ ...config, players: 2, setSize: 2 }, flips).state).toEqual(game.state);
  });
});

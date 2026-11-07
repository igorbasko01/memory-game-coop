import { describe, expect, it } from 'vitest';
import { deal, gridProblem, layoutOf, MemoryGame, picksPerPlayer, replay, setSizeFor } from './game';

const config = { rows: 3, cols: 4, setSize: 3, seed: 42 };

/** The cells holding each value. */
const cellsByValue = (deck: (number | null)[]) => {
  const map = new Map<number, number[]>();
  deck.forEach((v, i) => v !== null && map.set(v, [...(map.get(v) ?? []), i]));
  return map;
};

describe('set size and layout', () => {
  it('is the number of players, with pairs for a solo player', () => {
    expect([1, 2, 3, 4].map(setSizeFor)).toEqual([2, 2, 3, 4]);
    expect([1, 2, 3, 4].map(picksPerPlayer)).toEqual([2, 1, 1, 1]);
  });

  it('keeps whole sets and leaves the rest of the grid empty', () => {
    expect(layoutOf(4, 4, 3)).toEqual({ cells: 16, sets: 5, cards: 15, empty: 1 });
    expect(layoutOf(4, 4, 4)).toEqual({ cells: 16, sets: 4, cards: 16, empty: 0 });
  });

  it('rejects grids that are out of range or too small', () => {
    expect(gridProblem(4, 4, 2)).toBeNull();
    expect(gridProblem(1, 4, 2)).not.toBeNull();
    expect(gridProblem(9, 4, 2)).not.toBeNull();
    expect(gridProblem(2, 2, 3)).not.toBeNull();
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

describe('a round', () => {
  it('closes a set when every picked card shows the same number', () => {
    const game = new MemoryGame(config);
    const ones = cellsByValue(game.deck).get(1)!;
    expect(game.play(ones)).toBe('set');
    expect(game.state.closed.filter(Boolean)).toHaveLength(3);
    expect(game.state.setsClosed).toBe(1);
    expect(game.cellProblem(ones[0])).not.toBeNull();
  });

  it('is a miss when any card differs, and the cards are shown until the next round', () => {
    const game = new MemoryGame(config);
    const [a, b] = cellsByValue(game.deck).get(1)!;
    const two = cellsByValue(game.deck).get(2)![0];
    expect(game.play([a, b, two])).toBe('miss');
    expect(game.state.lastMiss).toEqual([a, b, two]);
    expect(game.state.misses).toBe(1);
    expect(game.state.closed.some(Boolean)).toBe(false);
    // Missed cards can be picked again.
    expect(game.play(cellsByValue(game.deck).get(1)!)).toBe('set');
    expect(game.state.lastMiss).toBeNull();
  });

  it('needs set-size different, playable cards', () => {
    const game = new MemoryGame({ ...config, rows: 4, cols: 4 });
    const [a, b, c] = cellsByValue(game.deck).get(1)!;
    expect(game.roundProblem([a, b])).not.toBeNull();
    expect(game.roundProblem([a, a, b])).not.toBeNull();
    expect(game.roundProblem([a, b, 15])).not.toBeNull();
    expect(game.roundProblem([a, b, 99])).not.toBeNull();
    expect(() => game.play([a, b])).toThrow();
    game.play([a, b, c]);
    expect(game.roundProblem([a, ...cellsByValue(game.deck).get(2)!.slice(0, 2)])).not.toBeNull();
  });

  it('is won when every set is closed, and replays to the same state', () => {
    const cfg = { ...config, setSize: 2 };
    const game = new MemoryGame(cfg);
    const rounds = [...cellsByValue(game.deck).values()];
    for (const cells of rounds) game.play(cells);
    expect(game.state.over).toBe(true);
    expect(game.state.misses).toBe(0);
    expect(game.state.setsClosed).toBe(6);
    expect(game.cellProblem(0)).toBe('The game is over');
    expect(replay(cfg, rounds).state).toEqual(game.state);
  });
});

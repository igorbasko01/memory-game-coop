import { describe, expect, it } from 'vitest';
import type { MemberView, RoomView } from '../online/types';
import { withPick } from './pick';

const member = (seat: number, extra: Partial<MemberView> = {}): MemberView => ({
  id: `p${seat}`,
  nickname: `P${seat}`,
  seat,
  host: seat === 0,
  online: true,
  left: false,
  picked: 0,
  ...extra,
});

const room = (players: number, picks: { cell: number; seat: number }[] = [], extra: { left?: number[]; coverAt?: number } = {}): RoomView =>
  ({
    you: 'p0',
    members: Array.from({ length: players }, (_, s) => member(s, { left: extra.left?.includes(s), picked: picks.filter((p) => p.seat === s).length })),
    game: {
      status: 'playing',
      picksPerPlayer: players === 1 ? 2 : 1,
      coverAt: extra.coverAt ?? 1000,
      picks,
      cells: Array.from({ length: 12 }, (_, i) => (i === 11 ? { state: 'closed', value: 1 } : { state: 'down' })),
    },
  }) as unknown as RoomView;

const cells = (r: RoomView | null) => r?.game?.picks.map((p) => `${p.cell}:${p.seat}`).join(' ');

describe('showing a pick before the server answers', () => {
  it('marks your card and counts it', () => {
    const r = withPick(room(3), 4, 0);
    expect(cells(r)).toBe('4:0');
    expect(r!.members[0].picked).toBe(1);
  });

  it('takes your card back, or moves your pick', () => {
    expect(cells(withPick(room(3, [{ cell: 4, seat: 0 }]), 4, 0))).toBe('');
    expect(cells(withPick(room(3, [{ cell: 4, seat: 0 }]), 5, 0))).toBe('5:0');
  });

  it("won't take someone else's card, a closed card or a card outside the board", () => {
    expect(withPick(room(3, [{ cell: 4, seat: 1 }]), 4, 0)).toBeNull();
    expect(withPick(room(3), 11, 0)).toBeNull();
    expect(withPick(room(3), 99, 0)).toBeNull();
  });

  it('picks for a player who left at once, and for anyone else only after the wait', () => {
    expect(cells(withPick(room(3, [{ cell: 4, seat: 0 }], { left: [2] }), 5, 0))).toBe('4:0 5:2');
    expect(cells(withPick(room(3, [{ cell: 4, seat: 0 }], { coverAt: 1000 }), 5, 0))).toBe('5:0');
    expect(cells(withPick(room(3, [{ cell: 4, seat: 0 }], { coverAt: 1000 }), 5, 2000))).toBe('4:0 5:1');
  });

  it('lets a solo player pick two cards', () => {
    expect(cells(withPick(room(1, [{ cell: 4, seat: 0 }]), 5, 0))).toBe('4:0 5:0');
  });
});

import type { RoomView } from '../online/types';

/**
 * The room as it will look once the server has your pick, so the screen can show it
 * at once. Same rules as the server: picking your card again takes it back; with
 * all yours picked, another card goes to a player who left (at once) or who hasn't
 * picked in time, or else moves your pick. Returns null for a card you can't pick.
 * The server's answer replaces this guess.
 */
export const withPick = (room: RoomView, cell: number, serverNow: number): RoomView | null => {
  const game = room.game;
  const seat = room.members.findIndex((m) => m.id === room.you);
  if (!game || seat < 0 || game.status !== 'playing') return null;
  const c = game.cells[cell];
  if (!c || (c.state !== 'down' && c.state !== 'miss')) return null;
  const quota = game.picksPerPlayer;
  const picks = [...game.picks];
  const count = (s: number) => picks.filter((p) => p.seat === s).length;
  const taken = picks.findIndex((p) => p.cell === cell);
  if (taken >= 0) {
    if (picks[taken].seat !== seat) return null;
    picks.splice(taken, 1);
  } else if (count(seat) < quota) {
    picks.push({ cell, seat });
  } else {
    const open = room.members.filter((m) => count(m.seat) < quota);
    const away = open.find((m) => m.left) ?? (serverNow >= game.coverAt ? open[0] : undefined);
    if (away) picks.push({ cell, seat: away.seat });
    else {
      picks.splice(
        picks.findIndex((p) => p.seat === seat),
        1,
      );
      picks.push({ cell, seat });
    }
  }
  return {
    ...room,
    members: room.members.map((m) => ({ ...m, picked: count(m.seat) })),
    game: { ...game, picks },
  };
};

import qrcode from 'qrcode-generator';
import { layoutOf } from '../engine/game';
import type { GameView, MemberView, RoomView } from '../online/types';
import { SEAT_COLORS } from './board';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const seatColor = (seat: number) => SEAT_COLORS[seat % SEAT_COLORS.length];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A QR code for a link, as an SVG that scales to its box. */
export const qrSvg = (text: string) => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
};

export const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const gridSummary = (rows: number, cols: number, setSize: number) => {
  const l = layoutOf(rows, cols, setSize);
  return `${rows}×${cols} · ${l.sets} sets of ${setSize}${l.empty ? ` · ${l.empty} empty` : ''}`;
};

/** The players who still have cards to pick this round. */
export const stillPicking = (room: RoomView, game: GameView) => room.members.filter((m) => m.picked < game.picksPerPlayer);

const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** A short, live line about the round being chosen, as one player (or the TV) sees it. */
export const roundLine = (room: RoomView, game: GameView, you: string | null = null) => {
  if (game.status !== 'playing') return '';
  const waiting = stillPicking(room, game);
  const me = waiting.find((m) => m.id === you);
  const others = waiting.filter((m) => m.id !== you).map((m) => m.nickname);
  if (me) {
    const left = game.picksPerPlayer - me.picked;
    return game.picksPerPlayer > 1 ? `Pick ${left} more card${left === 1 ? '' : 's'}` : 'Pick a card';
  }
  const gone = waiting.filter((m) => m.left && m.id !== you).map((m) => m.nickname);
  if (others.length && gone.length === others.length) return `${names(gone)} left · someone picks for them`;
  if (others.length) return `Waiting for ${names(others)}`;
  return 'Flipping…';
};

/** What the last round did, for a moment after it flipped. */
export const lastRoundLine = (game: GameView) => {
  if (!game.last) return `Find ${game.setSize} matching cards: everyone picks, then they flip together`;
  const v = (game.cells[game.last.cells[0]] as { value?: number }).value;
  return game.last.result === 'set' ? `Last round: a set of ${v}s ✨` : 'Last round: not a match';
};

/** One slot per card of the round, in each player's colour, filled once picked. */
export const trayHtml = (room: RoomView, game: GameView) => {
  const slots = room.members.flatMap((m) =>
    [...Array(game.picksPerPlayer).keys()].map(
      (i) => `<span class="slot${i < m.picked ? ' filled' : ''}" style="--slot-color:${seatColor(m.seat)}" title="${esc(m.nickname)}">${i < m.picked ? '✓' : ''}</span>`,
    ),
  );
  return `<div class="tray" aria-label="Picks this round">${slots.join('')}</div>`;
};

export const memberHtml = (m: MemberView, opts: { you?: string | null; picks?: number | null } = {}) => {
  const tags = [m.host ? 'host' : '', m.id === opts.you ? 'you' : '', m.left ? 'left' : !m.online ? 'away' : ''].filter(Boolean);
  const done = opts.picks != null && m.picked >= opts.picks;
  return `<li class="member${opts.picks != null && !done ? ' is-picking' : ''}${done ? ' is-done' : ''}${m.online && !m.left ? '' : ' is-away'}" style="--seat-color:${seatColor(m.seat)}">
    <span class="avatar">${esc(m.nickname.slice(0, 1).toUpperCase())}</span>
    <span class="member-name">${esc(m.nickname)}${tags.map((t) => ` <small class="tag">${t}</small>`).join('')}</span>
    ${opts.picks != null ? `<span class="member-status">${done ? '✓' : '…'}</span>` : ''}
  </li>`;
};

export const statsHtml = (game: GameView, serverNow: number) => {
  const end = game.finishedAt ?? serverNow;
  return `<div class="stats">
    <span><b>${game.setsClosed}</b>/${game.sets} sets</span>
    <span><b>${game.misses}</b> ${game.misses === 1 ? 'miss' : 'misses'}</span>
    <span class="clock" data-started="${game.startedAt}" data-finished="${game.finishedAt ?? ''}">⏱ <b>${duration(end - game.startedAt)}</b></span>
  </div>`;
};

/** Keeps every on-screen game clock ticking between server updates. */
export const tickClocks = (root: HTMLElement, clockOffset: number) => {
  for (const el of root.querySelectorAll<HTMLElement>('.clock')) {
    if (el.dataset.finished) continue;
    const b = el.querySelector('b');
    if (b) b.textContent = duration(Date.now() + clockOffset - Number(el.dataset.started));
  }
};

/** A one-line verdict on how the team did. */
export const resultLine = (game: GameView) => {
  if (game.status === 'ended') return 'Game ended early';
  const ratio = game.misses / game.sets;
  if (game.misses === 0) return 'Flawless! Not a single miss 🤯';
  if (ratio <= 1) return 'Incredible teamwork! 🌟';
  if (ratio <= 2.5) return 'Great memory, team! 🎉';
  return 'You did it together! 🎉';
};

export const howToPlayHtml = `
  <ol class="rules">
    <li>One player creates a room and picks a grid; everyone else joins with the room code (1–4 players).</li>
    <li>Every number is on as many cards as there are players: with 3 players you look for <b>3 matching cards</b> (a solo player looks for pairs).</li>
    <li>You play as a team, in rounds: <b>everyone picks one card</b> (solo: two). You can see where the others picked and change your pick until the last one is in.</li>
    <li>Then all the picked cards <b>flip together</b>. All the same number? The set is closed and stays face up. Otherwise everyone sees the cards, then they turn back over. Remember them!</li>
    <li>You win together when every set is closed. Talk to each other: it's a team game.</li>
    <li>Got a TV? Open the game on it, choose <b>Use this screen as a TV</b> and enter the room code: it shows the board for everyone.</li>
  </ol>`;

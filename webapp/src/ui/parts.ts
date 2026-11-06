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

/** The player whose turn it is. */
export const turnPlayer = (room: RoomView, game: GameView) => room.members[game.turn];

/** A short, live line about the attempt in progress. */
export const attemptLine = (game: GameView) => {
  if (game.status !== 'playing') return '';
  if (game.open.length) {
    const v = (game.cells[game.open[0]] as { value: number }).value;
    const left = game.setSize - game.open.length;
    return `Find ${left} more ${v}${left === 1 ? '' : 's'}`;
  }
  if (game.last?.result === 'set') return 'Set closed! Start a new one';
  if (game.last?.result === 'miss') return 'Not a match. Start a new set';
  return `Turn up ${game.setSize} matching cards, one each`;
};

/** The slots of the attempt in progress: one per card of a set. */
export const trayHtml = (game: GameView, players: number) => {
  const slots = [];
  for (let i = 0; i < game.setSize; i++) {
    const cell = game.open[i];
    const c = cell === undefined ? null : game.cells[cell];
    // Each card of a set is flipped by the next player in turn order.
    const owner = seatColor((((game.turn - game.open.length + i) % players) + players) % players);
    slots.push(
      c && 'value' in c
        ? `<span class="slot filled" style="--slot-color:${owner}">${c.value}</span>`
        : `<span class="slot" style="--slot-color:${owner}"></span>`,
    );
  }
  return `<div class="tray" aria-label="Cards of this set">${slots.join('')}</div>`;
};

export const memberHtml = (m: MemberView, opts: { you?: string | null; turn?: number | null; showSets?: boolean } = {}) => {
  const tags = [m.host ? 'host' : '', m.id === opts.you ? 'you' : '', m.left ? 'left' : !m.online ? 'away' : ''].filter(Boolean);
  return `<li class="member${opts.turn === m.seat ? ' is-turn' : ''}${m.online && !m.left ? '' : ' is-away'}" style="--seat-color:${seatColor(m.seat)}">
    <span class="avatar">${esc(m.nickname.slice(0, 1).toUpperCase())}</span>
    <span class="member-name">${esc(m.nickname)}${tags.map((t) => ` <small class="tag">${t}</small>`).join('')}</span>
    ${opts.showSets ? `<span class="member-sets" title="Sets closed">${m.sets}</span>` : ''}
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
    <li>Take turns flipping <b>one card each</b>. Keep going while the cards match; when a set is complete it stays face up.</li>
    <li>A card that doesn't match ends the attempt: everyone sees the cards, then they turn back over. Remember them!</li>
    <li>You win together when every set is closed. Talk to each other: it's a team game.</li>
    <li>Got a TV? Open the game on it, choose <b>Use this screen as a TV</b> and enter the room code: it shows the board for everyone.</li>
  </ol>`;

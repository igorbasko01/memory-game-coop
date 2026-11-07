import { api, ApiError, linkWith } from '../online/client';
import type { GameView, RoomView } from '../online/types';
import { Board, missShowing } from './board';
import { esc, gridSummary, lastRoundLine, memberHtml, qrSvg, resultLine, roundLine, seatColor, sleep, statsHtml, tickClocks, trayHtml } from './parts';

const POLL_MS = 800;
const CODE_KEY = 'memory-coop-tv-code';

/**
 * The big screen: joins a room by its code, without being a player, and shows
 * the room's QR code, the board, who has picked this round and how the team is doing.
 */
export class TvApp {
  private generation = 0;
  private board: Board | null = null;
  private layoutKey = '';
  private panelKey = '';
  private lastRound = -1;
  private clockOffset = 0;
  private tickTimer = 0;

  constructor(private readonly root: HTMLElement) {}

  start(code: string | null) {
    document.body.classList.add('tv-mode');
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(CODE_KEY);
    } catch {
      // No storage: the code is asked again after a reload.
    }
    const c = (code || saved || '').toUpperCase();
    if (/^[A-Z]{4}$/.test(c)) this.watch(c);
    else this.entry();
  }

  private stop() {
    this.generation++;
    this.board?.destroy();
    this.board = null;
    this.layoutKey = '';
    this.panelKey = '';
    this.lastRound = -1;
    clearInterval(this.tickTimer);
  }

  private remember(code: string | null) {
    try {
      if (code) localStorage.setItem(CODE_KEY, code);
      else localStorage.removeItem(CODE_KEY);
    } catch {
      // Ignore.
    }
    history.replaceState(null, '', code ? `?tv=${code}` : '?tv');
  }

  private entry(message = '') {
    this.stop();
    this.remember(null);
    this.root.className = 'tv';
    this.root.innerHTML = `
      <div class="tv-entry">
        <div class="logo big" aria-hidden="true"><span>7</span><span>7</span><span>7</span></div>
        <h1>Memory Co-op <small>TV</small></h1>
        <p class="tv-lead">Create a room on a phone, then enter its code here.</p>
        <form id="tv-form">
          <input name="code" maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCD" aria-label="Room code" required />
          <button class="primary big">Show room</button>
        </form>
        ${message ? `<p class="warn">${esc(message)}</p>` : ''}
        <a class="link" href="${esc(location.pathname)}">← Play on this device instead</a>
      </div>`;
    const form = this.root.querySelector<HTMLFormElement>('#tv-form')!;
    const input = form.querySelector('input')!;
    input.focus();
    input.addEventListener('input', () => (input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '')));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (input.value.length === 4) this.watch(input.value);
    });
  }

  private async watch(code: string) {
    this.stop();
    const generation = this.generation;
    this.root.className = 'tv';
    this.root.innerHTML = `<div class="tv-loading">Connecting to room ${esc(code)}…</div>`;
    let first = true;
    let failures = 0;
    this.tickTimer = window.setInterval(() => tickClocks(this.root, this.clockOffset), 1000);
    while (generation === this.generation) {
      try {
        const room = await api.tv(code);
        if (generation !== this.generation) return;
        if (first) this.remember(code);
        first = false;
        failures = 0;
        if (room.status === 'closed') return this.entry(`Room ${code} was closed.`);
        this.apply(room);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return this.entry(first ? `No room with the code ${code}.` : `Room ${code} has ended.`);
        if (++failures === 5) this.root.querySelector('.tv-offline')?.removeAttribute('hidden');
      }
      await sleep(POLL_MS);
    }
  }

  private apply(room: RoomView) {
    this.clockOffset = room.now - Date.now();
    const playing = room.status === 'playing' && room.game;
    const layout = playing ? `game:${room.game!.id}` : room.status === 'finished' && room.game ? `done:${room.game.id}` : 'lobby';
    if (layout !== this.layoutKey) {
      this.layoutKey = layout;
      this.panelKey = '';
      this.board?.destroy();
      this.board = null;
      if (room.game && layout !== 'lobby') {
        this.root.innerHTML = `
          <div class="tv-game">
            <div class="tv-board-wrap"></div>
            <aside class="tv-side"></aside>
          </div>
          <div class="tv-flash" aria-live="polite"></div>
          <p class="tv-offline" hidden>Reconnecting…</p>`;
        this.board = new Board(this.root.querySelector('.tv-board-wrap')!);
      } else {
        this.root.innerHTML = `<div class="tv-lobby"></div><p class="tv-offline" hidden>Reconnecting…</p>`;
      }
    }
    this.root.querySelector('.tv-offline')?.setAttribute('hidden', '');
    if (room.game && layout !== 'lobby') this.renderGame(room, room.game);
    else this.renderLobby(room);
  }

  private joinHtml(room: RoomView, compact = false) {
    const link = linkWith('join', room.code);
    return `<div class="tv-join${compact ? ' compact' : ''}">
      <div class="qr">${qrSvg(link)}</div>
      <div>
        <p class="tv-join-label">Scan to join, or enter code</p>
        <p class="big-code">${esc(room.code)}</p>
        <p class="tv-url">${esc(link.replace(/^https?:\/\//, '').replace(/\?.*$/, ''))}</p>
      </div>
    </div>`;
  }

  private renderLobby(room: RoomView) {
    const key = JSON.stringify([room.code, room.rows, room.cols, room.members.map((m) => [m.id, m.online, m.host]), room.nextSetSize]);
    if (key === this.panelKey) return;
    this.panelKey = key;
    const slots = [];
    for (let seat = 0; seat < 4; seat++) {
      const m = room.members[seat];
      slots.push(m ? memberHtml(m) : `<li class="member empty" style="--seat-color:${seatColor(seat)}"><span class="avatar">?</span><span class="member-name">Waiting for a player…</span></li>`);
    }
    const n = Math.max(1, room.members.length);
    this.root.querySelector<HTMLElement>('.tv-lobby')!.innerHTML = `
      <header class="tv-title"><h1>Memory Co-op</h1><p>Room <b>${esc(room.code)}</b></p></header>
      ${this.joinHtml(room)}
      <section class="tv-players">
        <h2>Players</h2>
        <ul class="members big">${slots.join('')}</ul>
        <p class="set-rule"><span class="set-size">${room.nextSetSize}</span><span>${
          n === 1 ? 'Solo game: find matching pairs.' : `${n} players: find ${room.nextSetSize} matching cards per set, one card each.`
        }</span></p>
        <p class="muted">${esc(gridSummary(room.rows, room.cols, room.nextSetSize))}</p>
        <p class="tv-hint">The host starts the game from their phone.</p>
      </section>`;
  }

  private renderGame(room: RoomView, game: GameView) {
    this.board!.update(game, { initials: room.members.map((m) => m.nickname.slice(0, 1).toUpperCase()), clockOffset: this.clockOffset });
    if (game.round !== this.lastRound) {
      if (this.lastRound >= 0 && game.round === this.lastRound + 1 && game.last) this.flash(game);
      this.lastRound = game.round;
    }
    const over = game.status !== 'playing';
    const showingMiss = missShowing(game, Date.now() + this.clockOffset);
    const side = this.root.querySelector<HTMLElement>('.tv-side')!;
    side.innerHTML = `
      <header class="tv-title"><h1>Memory Co-op</h1><p>Room <b>${esc(room.code)}</b></p></header>
      ${
        over
          ? `<div class="tv-result ${game.status}">
               <h2>${game.status === 'won' ? 'Board cleared!' : 'Game over'}</h2>
               <p>${esc(resultLine(game))}</p>
             </div>`
          : `<div class="turn-card">
               <p class="turn-who"><b>Round ${game.round + 1}</b></p>
               <p class="turn-what">${esc(showingMiss ? 'Remember these cards!' : roundLine(room, game))}</p>
               ${trayHtml(room, game)}
               <p class="turn-last">${esc(lastRoundLine(game))}</p>
             </div>`
      }
      ${statsHtml(game, room.now)}
      <ul class="members big">${room.members.map((m) => memberHtml(m, { picks: over ? null : game.picksPerPlayer })).join('')}</ul>
      ${over ? `<p class="tv-hint">The host can start the next game from their phone.</p>${room.members.length + room.waiting.length < 4 ? this.joinHtml(room, true) : ''}` : ''}`;
  }

  /** A big, short message when a round flips. */
  private flash(game: GameView) {
    const last = game.last!;
    const el = this.root.querySelector<HTMLElement>('.tv-flash');
    if (!el) return;
    const value = (game.cells[last.cells[0]] as { value?: number }).value;
    el.className = `tv-flash show ${last.result}`;
    el.textContent = last.result === 'set' ? (game.status === 'won' ? 'All sets found! 🎉' : `Set of ${value}s! ✨`) : 'Not a match';
    clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(window.setTimeout(() => el.classList.remove('show'), 1600));
  }
}

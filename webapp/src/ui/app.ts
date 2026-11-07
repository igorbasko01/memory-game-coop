import { GRID_MAX, GRID_MIN, GRID_PRESETS, gridProblem, layoutOf } from '../engine/game';
import { api, ApiError, linkWith, loadIdentity, saveIdentity, type Identity } from '../online/client';
import type { GameView, RoomView } from '../online/types';
import { Board, MISS_SHOW_MS, missShowing } from './board';
import { withPick } from './pick';
import {
  esc,
  gridSummary,
  howToPlayHtml,
  memberHtml,
  resultLine,
  seatColor,
  sleep,
  statsHtml,
  tickClocks,
  lastRoundLine,
  roundLine,
  stillPicking,
  trayHtml,
} from './parts';

const POLL_MS = 900;

/** The game on a phone: name, home, lobby, the board on your turn, and the result. */
export class PhoneApp {
  private identity: Identity | null = loadIdentity();
  private room: RoomView | null = null;
  /** Bumped to stop the room's background polling. */
  private generation = 0;
  private board: Board | null = null;
  /** Server clock minus this device's clock. */
  private clockOffset = 0;
  /** Picks sent and not answered yet: the screen already shows them, so polls wait. */
  private pending = 0;
  /** Picks go to the server one after another, in tap order. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Bumped on every tap, so a poll that started before it can't undo it. */
  private taps = 0;
  private layoutKey = '';
  private panelKey = '';
  /** The round this device last showed, to notice when a new one starts. */
  private shownRound = -1;
  private tickTimer = 0;
  private unlockTimer = 0;

  constructor(private readonly root: HTMLElement) {}

  async start(params: URLSearchParams) {
    const join = params.get('join');
    if (join) history.replaceState(null, '', location.pathname);
    if (!this.identity) return this.welcome(join);
    if (join) return this.joinCode(join);
    try {
      const { room } = await api.currentRoom(this.identity.token);
      if (room && room.status !== 'closed') return this.enterRoom(room);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        saveIdentity((this.identity = null));
        return this.welcome(null);
      }
    }
    this.home();
  }

  private get token() {
    return this.identity!.token;
  }

  private screen(html: string) {
    this.stopRoom();
    this.root.className = 'phone';
    this.root.innerHTML = html;
    return this.root;
  }

  toast(message: string) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3100);
  }

  private fail(e: unknown) {
    this.toast(e instanceof Error ? e.message : 'Something went wrong');
  }

  // ---------------------------------------------------------------- welcome & home

  private welcome(join: string | null) {
    const root = this.screen(`
      <div class="screen center">
        <div class="hero">
          <div class="logo" aria-hidden="true"><span>7</span><span>7</span><span>7</span></div>
          <h1>Memory Co-op</h1>
          <p class="tagline">Find the matching cards together. 1–4 players.</p>
        </div>
        <form class="panel" id="name-form">
          <label class="field">Your name
            <input name="nickname" maxlength="16" autocomplete="nickname" placeholder="e.g. Sam" required />
          </label>
          <button class="primary big">${join ? `Join room ${esc(join.toUpperCase())}` : 'Continue'}</button>
        </form>
        <button class="ghost" data-tv>📺 Use this screen as a TV</button>
      </div>`);
    const form = root.querySelector<HTMLFormElement>('#name-form')!;
    form.querySelector('input')!.focus();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const nickname = new FormData(form).get('nickname') as string;
      const button = form.querySelector('button')!;
      button.disabled = true;
      try {
        this.identity = await api.register(nickname);
        saveIdentity(this.identity);
        if (join) await this.joinCode(join);
        else this.home();
      } catch (e) {
        this.fail(e);
        button.disabled = false;
      }
    });
    root.querySelector('[data-tv]')!.addEventListener('click', () => this.openTv());
  }

  private openTv(code = '') {
    location.href = linkWith('tv', code).replace(/=$/, '');
  }

  private home() {
    const me = this.identity!.player;
    const root = this.screen(`
      <div class="screen">
        <div class="hero small">
          <div class="logo" aria-hidden="true"><span>7</span><span>7</span><span>7</span></div>
          <h1>Memory Co-op</h1>
        </div>
        <p class="hello">Hi <b>${esc(me.nickname)}</b> <button class="link" data-rename>change name</button></p>
        <button class="primary big" data-create>Create a room</button>
        <form class="panel join" id="join-form">
          <label class="field">Join with a room code
            <input name="code" maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCD" required />
          </label>
          <button class="secondary">Join</button>
        </form>
        <button class="ghost" data-tv>📺 Use this screen as a TV</button>
        <details class="panel how"><summary>How to play</summary>${howToPlayHtml}</details>
      </div>`);
    root.querySelector('[data-create]')!.addEventListener('click', async (ev) => {
      (ev.currentTarget as HTMLButtonElement).disabled = true;
      try {
        this.enterRoom(await api.createRoom(this.token, 4, 4));
      } catch (e) {
        this.fail(e);
        (ev.target as HTMLButtonElement).disabled = false;
      }
    });
    const form = root.querySelector<HTMLFormElement>('#join-form')!;
    const input = form.querySelector('input')!;
    input.addEventListener('input', () => (input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '')));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.joinCode(input.value);
    });
    root.querySelector('[data-tv]')!.addEventListener('click', () => this.openTv());
    root.querySelector('[data-rename]')!.addEventListener('click', async () => {
      const nickname = prompt('Your name', me.nickname)?.trim();
      if (!nickname) return;
      try {
        const { player } = await api.rename(this.token, nickname);
        this.identity = { ...this.identity!, player };
        saveIdentity(this.identity);
        this.home();
      } catch (e) {
        this.fail(e);
      }
    });
  }

  private async joinCode(code: string) {
    try {
      this.enterRoom(await api.join(this.token, code));
    } catch (e) {
      this.fail(e);
      this.home();
    }
  }

  // ---------------------------------------------------------------- the room

  private stopRoom() {
    this.generation++;
    this.board?.destroy();
    this.board = null;
    this.room = null;
    this.layoutKey = '';
    this.panelKey = '';
    clearInterval(this.tickTimer);
    clearTimeout(this.unlockTimer);
  }

  private enterRoom(room: RoomView) {
    this.screen('');
    const generation = this.generation;
    this.apply(room);
    this.tickTimer = window.setInterval(() => tickClocks(this.root, this.clockOffset), 1000);
    void this.poll(generation);
  }

  private async poll(generation: number) {
    while (generation === this.generation) {
      await sleep(POLL_MS);
      if (generation !== this.generation || !this.room || this.pending) continue;
      const taps = this.taps;
      try {
        const room = await api.room(this.token, this.room.id);
        if (generation === this.generation && !this.pending && taps === this.taps) this.apply(room);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          this.toast('You are no longer in that room');
          return this.home();
        }
        // A dropped connection: keep trying.
      }
    }
  }

  private get mySeat() {
    return this.room ? this.room.members.findIndex((m) => m.id === this.room!.you) : -1;
  }

  private apply(room: RoomView) {
    this.room = room;
    this.clockOffset = room.now - Date.now();
    const layout = room.status === 'playing' && room.game ? `game:${room.game.id}` : 'lobby';
    if (layout !== this.layoutKey) {
      this.layoutKey = layout;
      this.panelKey = '';
      this.board?.destroy();
      this.board = null;
      this.root.innerHTML = `
        <div class="room">
          <header class="room-bar">
            <span class="code-chip">Room <b>${esc(room.code)}</b></span>
            <span class="tv-chip" hidden>📺 TV on</span>
            <span class="spacer"></span>
            <details class="menu">
              <summary aria-label="Menu">⋯</summary>
              <div class="menu-items">
                <button data-share>Invite players</button>
                <button data-end hidden>End game</button>
                <div class="menu-remove"></div>
                <button data-leave class="danger">Leave room</button>
              </div>
            </details>
          </header>
          <main class="room-body"></main>
        </div>`;
      this.root.querySelector('[data-leave]')!.addEventListener('click', () => this.leave());
      this.root.querySelector('[data-end]')!.addEventListener('click', () => this.endGame());
      this.root.querySelector('[data-share]')!.addEventListener('click', () => this.share());
      for (const b of this.root.querySelectorAll('.menu-items button'))
        b.addEventListener('click', () => this.root.querySelector<HTMLDetailsElement>('.menu')!.removeAttribute('open'));
      const body = this.root.querySelector<HTMLElement>('.room-body')!;
      if (room.status === 'playing' && room.game) {
        body.innerHTML = `
          <div class="turn-banner"></div>
          <div class="board-wrap"></div>
          <div class="game-foot"></div>`;
        this.board = new Board(body.querySelector('.board-wrap')!);
      }
    }
    this.root.querySelector<HTMLElement>('.tv-chip')!.hidden = !room.tv;
    const host = room.hostId === room.you;
    this.root.querySelector<HTMLElement>('[data-end]')!.hidden = !(host && room.status === 'playing');
    this.renderRemoveMenu(room, host);
    if (room.status === 'playing' && room.game) this.renderGame(room, room.game);
    else this.renderLobby(room);
  }

  private async share() {
    if (!this.room) return;
    const url = linkWith('join', this.room.code);
    const text = `Join my Memory Co-op room: ${this.room.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Memory Co-op', text, url });
      else {
        await navigator.clipboard.writeText(url);
        this.toast('Invite link copied');
      }
    } catch {
      // The share sheet was closed.
    }
  }

  /** The host's "Remove …" entries in the menu: everyone else still in the room. */
  private renderRemoveMenu(room: RoomView, host: boolean) {
    const others = host ? [...room.members, ...room.waiting].filter((m) => !m.left && m.id !== room.you) : [];
    const box = this.root.querySelector<HTMLElement>('.menu-remove')!;
    const key = others.map((m) => m.id + m.nickname).join();
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = others.map((m) => `<button class="danger" data-remove="${esc(m.id)}">Remove ${esc(m.nickname)}</button>`).join('');
    for (const b of box.querySelectorAll<HTMLButtonElement>('[data-remove]'))
      b.addEventListener('click', () => {
        this.root.querySelector<HTMLDetailsElement>('.menu')!.removeAttribute('open');
        const m = others.find((x) => x.id === b.dataset.remove);
        if (m) this.removePlayer(m.id, m.nickname);
      });
  }

  private async removePlayer(playerId: string, nickname: string) {
    if (!this.room) return;
    const playing = this.room.status === 'playing';
    if (!confirm(`Remove ${nickname} from the room?${playing ? ' The rest of you will pick for them.' : ''}`)) return;
    try {
      this.apply(await api.remove(this.token, this.room.id, playerId));
    } catch (e) {
      this.fail(e);
    }
  }

  private async leave() {
    if (!this.room) return;
    const inGame = this.room.status === 'playing' && this.mySeat >= 0;
    if (inGame && !confirm('Leave the game? The others will pick for you. You can come back with the room code.')) return;
    try {
      await api.leave(this.token, this.room.id);
      this.home();
    } catch (e) {
      this.fail(e);
    }
  }

  private async endGame() {
    if (!this.room || !confirm('End this game for everyone?')) return;
    try {
      this.apply(await api.end(this.token, this.room.id));
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------------------------------------------------------------- lobby & result

  private renderLobby(room: RoomView) {
    const host = room.hostId === room.you;
    // The players of the next game: everyone still in the room.
    const next = [...room.members.filter((m) => !m.left), ...room.waiting];
    const setSize = room.nextSetSize;
    const problem = gridProblem(room.rows, room.cols, setSize);
    const key = JSON.stringify([room.status, room.game?.id, room.game?.status, room.rows, room.cols, room.hostId, next.map((m) => [m.id, m.online]), room.tv]);
    if (key === this.panelKey) return;
    this.panelKey = key;
    const game = room.status === 'finished' ? room.game : null;
    const body = this.root.querySelector<HTMLElement>('.room-body')!;
    const presets = GRID_PRESETS.map((p) => {
      const l = layoutOf(p.rows, p.cols, setSize);
      const ok = !gridProblem(p.rows, p.cols, setSize);
      const on = p.rows === room.rows && p.cols === room.cols;
      return `<button class="preset${on ? ' on' : ''}" data-rows="${p.rows}" data-cols="${p.cols}" ${ok ? '' : 'disabled'}>
        <b>${p.label}</b><small>${p.rows}×${p.cols} · ${l.cards} cards</small></button>`;
    }).join('');
    body.innerHTML = `
      <div class="lobby">
        ${game ? this.resultHtml(room, game) : ''}
        <section class="panel">
          <h2>${game ? 'Next game' : 'Players'} <small>${next.length}/4</small></h2>
          <ul class="members">${next.map((m, seat) => memberHtml({ ...m, seat }, { you: room.you })).join('')}</ul>
          <p class="set-rule"><span class="set-size">${setSize}</span><span>${next.length === 1 ? 'Playing solo: find matching <b>pairs</b>.' : `${next.length} players: find <b>${setSize} matching cards</b> per set, one card each.`}</span></p>
          ${next.length < 4 ? `<button class="secondary" data-invite>Invite players · code <b>${esc(room.code)}</b></button>` : ''}
        </section>
        <section class="panel">
          <h2>Grid <small>${esc(gridSummary(room.rows, room.cols, setSize))}</small></h2>
          ${
            host
              ? `<div class="presets">${presets}</div>
                 <div class="custom-grid">
                   ${this.stepperHtml('rows', 'Rows', room.rows)}
                   <span class="times">×</span>
                   ${this.stepperHtml('cols', 'Columns', room.cols)}
                 </div>`
              : `<p class="muted">The host picks the grid.</p>`
          }
          ${problem ? `<p class="warn">${esc(problem)} of ${setSize}: pick a bigger grid.</p>` : ''}
        </section>
        <section class="panel tv-panel">
          <h2>📺 Big screen ${room.tv ? '<small class="ok">connected</small>' : ''}</h2>
          <p class="muted">${room.tv ? 'The TV is showing this room.' : `Open this game on a TV or laptop, choose <b>Use this screen as a TV</b> and enter <b>${esc(room.code)}</b>.`}</p>
        </section>
        ${
          host
            ? `<button class="primary big start" data-start ${problem ? 'disabled' : ''}>${game ? 'Play again' : 'Start game'}</button>`
            : `<p class="waiting-host">Waiting for the host to ${game ? 'start the next game' : 'start'}…</p>`
        }
      </div>`;
    body.querySelector('[data-invite]')?.addEventListener('click', () => this.share());
    body.querySelector('[data-start]')?.addEventListener('click', (ev) => this.startGame(ev.currentTarget as HTMLButtonElement));
    for (const b of body.querySelectorAll<HTMLButtonElement>('.preset'))
      b.addEventListener('click', () => this.setGrid(Number(b.dataset.rows), Number(b.dataset.cols)));
    for (const b of body.querySelectorAll<HTMLButtonElement>('.step'))
      b.addEventListener('click', () => {
        const d = Number(b.dataset.delta);
        if (b.dataset.dim === 'rows') this.setGrid(room.rows + d, room.cols);
        else this.setGrid(room.rows, room.cols + d);
      });
  }

  private stepperHtml(dim: 'rows' | 'cols', label: string, value: number) {
    return `<div class="stepper" aria-label="${label}">
      <button class="step" data-dim="${dim}" data-delta="-1" ${value <= GRID_MIN ? 'disabled' : ''} aria-label="Fewer ${label.toLowerCase()}">−</button>
      <span><b>${value}</b><small>${label.toLowerCase()}</small></span>
      <button class="step" data-dim="${dim}" data-delta="1" ${value >= GRID_MAX ? 'disabled' : ''} aria-label="More ${label.toLowerCase()}">+</button>
    </div>`;
  }

  private resultHtml(room: RoomView, game: GameView) {
    return `<section class="panel result ${game.status}">
      <h2>${game.status === 'won' ? 'Board cleared!' : 'Game over'}</h2>
      <p class="verdict">${esc(resultLine(game))}</p>
      ${statsHtml(game, room.now)}
      <ul class="members">${room.members
.map((m) => memberHtml(m, { you: room.you })).join('')}</ul>
    </section>`;
  }

  private async setGrid(rows: number, cols: number) {
    if (!this.room) return;
    try {
      this.apply(await api.settings(this.token, this.room.id, rows, cols));
    } catch (e) {
      this.fail(e);
    }
  }

  private async startGame(button: HTMLButtonElement) {
    if (!this.room) return;
    button.disabled = true;
    try {
      this.apply(await api.start(this.token, this.room.id));
    } catch (e) {
      this.fail(e);
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- the game

  private renderGame(room: RoomView, game: GameView) {
    const seat = this.mySeat;
    const serverNow = Date.now() + this.clockOffset;
    const me = room.members[seat];
    const playing = game.status === 'playing' && seat >= 0;
    const needToPick = playing && !!me && me.picked < game.picksPerPlayer;
    const showingMiss = missShowing(game, serverNow);
    const waiting = stillPicking(room, game).filter((m) => m.id !== room.you);
    const gone = waiting.filter((m) => m.left);
    // Players who left can be picked for at once; anyone else after a while.
    const cover = playing && !needToPick && (gone.length > 0 || (waiting.length > 0 && serverNow >= game.coverAt));
    const canPick = playing && !showingMiss;
    if (game.round !== this.shownRound) {
      if (this.shownRound >= 0 && game.last) navigator.vibrate?.(game.last.result === 'set' ? [40, 40, 80] : 150);
      this.shownRound = game.round;
    }

    const banner = this.root.querySelector<HTMLElement>('.turn-banner')!;
    banner.style.setProperty('--seat-color', seatColor(Math.max(0, seat)));
    banner.classList.toggle('mine', needToPick && !showingMiss);
    const line = showingMiss
      ? 'Remember these cards!'
      : cover
        ? gone.length
          ? `${gone.map((m) => m.nickname).join(', ')} left · tap a card to pick for them`
          : `${waiting.map((m) => m.nickname).join(', ')} seem${waiting.length === 1 ? 's' : ''} away · tap a card to pick for them`
        : roundLine(room, game, room.you);
    banner.innerHTML = `
      <div class="turn-who"><b>Round ${game.round + 1}</b> · ${esc(line)}</div>
      <div class="turn-what">${esc(needToPick && me.picked > 0 ? 'Tap your card again to take it back, or another to move it' : lastRoundLine(game))}</div>
      ${trayHtml(room, game)}`;
    this.root.querySelector<HTMLElement>('.game-foot')!.innerHTML = `
      ${statsHtml(game, room.now)}
      <ul class="members mini">${room.members.map((m) => memberHtml(m, { you: room.you, picks: game.status === 'playing' ? game.picksPerPlayer : null })).join('')}</ul>`;

    this.board!.update(game, {
      // Free cards, or your own pick (to take it back). Someone else's pick is theirs.
      playable: (cell) => canPick && game.picks.every((p) => p.cell !== cell || p.seat === seat),
      onPick: (cell) => this.pick(cell),
      initials: room.members.map((m) => m.nickname.slice(0, 1).toUpperCase()),
      mySeat: seat,
      clockOffset: this.clockOffset,
    });
    // Look again when the missed cards turn over, or when covering for someone becomes possible.
    clearTimeout(this.unlockTimer);
    const next = [showingMiss ? game.roundStartedAt + MISS_SHOW_MS : 0, !cover && waiting.length ? game.coverAt : 0].filter((t) => t > serverNow);
    if (next.length) this.unlockTimer = window.setTimeout(() => this.room && this.apply(this.room), Math.min(...next) - serverNow + 30);
  }

  /**
   * Marks the card at once and sends the pick in the background. Picks are sent in
   * tap order; once none are left waiting, the screen shows the server's answer.
   */
  private pick(cell: number) {
    const room = this.room;
    if (!room?.game) return;
    const next = withPick(room, cell, Date.now() + this.clockOffset);
    if (!next) return;
    const round = room.game.round;
    const generation = this.generation;
    this.taps++;
    this.pending++;
    this.room = next;
    this.renderGame(next, next.game!);
    this.queue = this.queue.then(async () => {
      try {
        const answer = await api.pick(this.token, room.id, round, cell);
        if (--this.pending === 0 && generation === this.generation) this.apply(answer);
      } catch (e) {
        this.pending--;
        if (generation !== this.generation) return;
        this.fail(e);
        // Undo what the screen guessed: show the room as the server has it.
        if (!this.pending) await api.room(this.token, room.id).then((r) => generation === this.generation && this.apply(r), () => undefined);
      }
    });
  }
}

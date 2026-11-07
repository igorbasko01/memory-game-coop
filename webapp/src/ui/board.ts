import type { CellView, GameView } from '../online/types';

/** Each seat's colour. */
export const SEAT_COLORS = ['#ff6b6b', '#2ec4b6', '#ffbf3c', '#9b7bff'];

/** A colour for each number, so cards are easier to remember. */
const valueColor = (v: number) => `hsl(${(v * 137.508) % 360} 70% 58%)`;

/** How long the cards of a missed round stay face up before turning back over. */
export const MISS_SHOW_MS = 2400;

/** Whether the missed cards of the last round are still face up. */
export const missShowing = (game: GameView, serverNow: number) => !!game.lastMiss && serverNow < game.roundStartedAt + MISS_SHOW_MS;

export interface BoardOptions {
  /** Cells this viewer may pick right now. */
  playable?: (cell: number) => boolean;
  onPick?: (cell: number) => void;
  /** The first letter of each seat's name, shown on the cards they picked. */
  initials?: string[];
  /** The viewer's seat, to mark their own picks. */
  mySeat?: number;
  /** Server clock minus this device's clock. */
  clockOffset?: number;
}

/** The grid of cards, sized to fit its container. Used by phones and the TV. */
export class Board {
  readonly el = document.createElement('div');
  private cards: HTMLButtonElement[] = [];
  private gameId = '';
  private rows = 0;
  private cols = 0;
  private game: GameView | null = null;
  private options: BoardOptions = {};
  private timer = 0;
  private observer = new ResizeObserver(() => this.fit());

  constructor(private readonly container: HTMLElement) {
    this.el.className = 'board';
    container.append(this.el);
    this.observer.observe(container);
  }

  destroy() {
    this.observer.disconnect();
    clearTimeout(this.timer);
    this.el.remove();
  }

  update(game: GameView, options: BoardOptions = {}) {
    this.options = options;
    this.game = game;
    if (game.id !== this.gameId) this.build(game);
    this.render();
  }

  private build(game: GameView) {
    this.gameId = game.id;
    this.rows = game.rows;
    this.cols = game.cols;
    this.el.replaceChildren();
    this.el.style.gridTemplateColumns = `repeat(${game.cols}, 1fr)`;
    this.cards = game.cells.map((_, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.innerHTML =
        '<span class="card-inner"><span class="card-back"></span><span class="card-face"><span class="card-num"></span></span></span><span class="pick-badge"></span>';
      card.addEventListener('click', () => {
        if (this.options.playable?.(i)) this.options.onPick?.(i);
      });
      this.el.append(card);
      return card;
    });
    this.fit();
  }

  private render() {
    const game = this.game;
    if (!game) return;
    const serverNow = Date.now() + (this.options.clockOffset ?? 0);
    const showMiss = missShowing(game, serverNow);
    const fresh = game.last && serverNow < game.roundStartedAt + 1500 ? game.last : null;
    game.cells.forEach((raw, i) => {
      // Missed cards turn back over after a moment.
      const c: CellView = raw.state === 'miss' && !showMiss ? { state: 'down' } : raw;
      const card = this.cards[i];
      const up = c.state === 'miss' || c.state === 'closed';
      const pick = c.state === 'down' ? game.picks.find((p) => p.cell === i) : undefined;
      card.className = `card is-${c.state}${up ? ' is-up' : ''}`;
      if (fresh?.result === 'set' && fresh.cells.includes(i)) card.classList.add('is-latest');
      const playable = (raw.state === 'down' || raw.state === 'miss') && !!this.options.playable?.(i);
      card.classList.toggle('is-playable', playable);
      card.disabled = !playable;
      const badge = card.querySelector<HTMLElement>('.pick-badge')!;
      if (pick) {
        card.classList.add('is-picked');
        if (pick.seat === this.options.mySeat) card.classList.add('is-mine');
        card.style.setProperty('--pick-color', SEAT_COLORS[pick.seat % SEAT_COLORS.length]);
        badge.textContent = this.options.initials?.[pick.seat] ?? '';
      }
      const num = card.querySelector<HTMLElement>('.card-num')!;
      if ('value' in c) {
        num.textContent = String(c.value);
        card.style.setProperty('--value-color', valueColor(c.value));
      }
      card.setAttribute('aria-label', 'value' in c ? `Card ${c.value}` : c.state === 'empty' ? 'Empty' : pick ? 'Picked card' : 'Face-down card');
    });
    clearTimeout(this.timer);
    const until = Math.max(showMiss ? game.roundStartedAt + MISS_SHOW_MS : 0, fresh ? game.roundStartedAt + 1500 : 0);
    if (until) this.timer = window.setTimeout(() => this.render(), until - serverNow + 30);
  }

  /** Sizes the cards so the whole grid fits the container (cards are 3:4). */
  fit() {
    if (!this.rows) return;
    const style = getComputedStyle(this.container);
    const width = this.container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = this.container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const gap = Math.max(4, Math.min(14, Math.min(width, height) * 0.015));
    const byWidth = (width - gap * (this.cols - 1)) / this.cols;
    const byHeight = ((height - gap * (this.rows - 1)) / this.rows) * 0.75;
    const card = Math.max(20, Math.floor(Math.min(byWidth, byHeight)));
    this.el.style.setProperty('--card-w', `${card}px`);
    this.el.style.setProperty('--gap', `${gap}px`);
    this.el.style.width = `${card * this.cols + gap * (this.cols - 1)}px`;
  }
}

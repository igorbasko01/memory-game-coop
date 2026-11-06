import type { CellView, GameView } from '../online/types';

/** Each seat's colour, in turn order. */
export const SEAT_COLORS = ['#ff6b6b', '#2ec4b6', '#ffbf3c', '#9b7bff'];

/** A colour for each number, so cards are easier to remember. */
const valueColor = (v: number) => `hsl(${(v * 137.508) % 360} 70% 58%)`;

/** How long a missed set stays face up on this screen, even once the next card is flipped. */
const MISS_SHOW_MS = 1600;

export interface BoardOptions {
  /** Cells this viewer may flip right now. */
  playable?: (cell: number) => boolean;
  onFlip?: (cell: number) => void;
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
  /** Missed cards still shown on this screen: cell → value and until when. */
  private held = new Map<number, { value: number; until: number }>();
  private heldTimer = 0;
  private lastMissKey = '';
  private observer = new ResizeObserver(() => this.fit());

  constructor(private readonly container: HTMLElement) {
    this.el.className = 'board';
    container.append(this.el);
    this.observer.observe(container);
  }

  destroy() {
    this.observer.disconnect();
    clearTimeout(this.heldTimer);
    this.el.remove();
  }

  update(game: GameView, options: BoardOptions = {}) {
    this.options = options;
    this.game = game;
    if (game.id !== this.gameId) this.build(game);
    const missKey = game.lastMiss ? `${game.flips}` : '';
    if (game.lastMiss && missKey !== this.lastMissKey) {
      const until = Date.now() + MISS_SHOW_MS;
      for (const cell of game.lastMiss) {
        const c = game.cells[cell];
        if ('value' in c) this.held.set(cell, { value: c.value, until });
      }
    }
    this.lastMissKey = missKey;
    this.render();
  }

  private build(game: GameView) {
    this.gameId = game.id;
    this.rows = game.rows;
    this.cols = game.cols;
    this.held.clear();
    this.el.replaceChildren();
    this.el.style.gridTemplateColumns = `repeat(${game.cols}, 1fr)`;
    this.cards = game.cells.map((_, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.innerHTML = '<span class="card-inner"><span class="card-back"></span><span class="card-face"><span class="card-num"></span></span></span>';
      card.addEventListener('click', () => {
        if (this.options.playable?.(i)) this.options.onFlip?.(i);
      });
      this.el.append(card);
      return card;
    });
    this.fit();
  }

  /** What a cell looks like here: a recently missed card stays up for a moment. */
  private shown(cell: number, c: CellView, now: number): CellView {
    const hold = this.held.get(cell);
    if (hold && hold.until <= now) this.held.delete(cell);
    else if (hold && c.state === 'down') return { state: 'miss', value: hold.value };
    return c;
  }

  private render() {
    const game = this.game;
    if (!game) return;
    const now = Date.now();
    game.cells.forEach((raw, i) => {
      const c = this.shown(i, raw, now);
      const card = this.cards[i];
      const up = c.state === 'open' || c.state === 'miss' || c.state === 'closed';
      card.className = `card is-${c.state}${up ? ' is-up' : ''}`;
      const playable = (raw.state === 'down' || raw.state === 'miss') && !!this.options.playable?.(i);
      card.classList.toggle('is-playable', playable);
      card.disabled = !playable;
      if (game.last?.cell === i && game.last.result !== 'miss') card.classList.add('is-latest');
      const num = card.querySelector<HTMLElement>('.card-num')!;
      if ('value' in c) {
        num.textContent = String(c.value);
        card.style.setProperty('--value-color', valueColor(c.value));
        card.setAttribute('aria-label', `Card ${c.value}`);
      } else {
        card.setAttribute('aria-label', c.state === 'empty' ? 'Empty' : 'Face-down card');
      }
      if (c.state === 'closed') card.style.setProperty('--seat-color', SEAT_COLORS[c.by % SEAT_COLORS.length]);
    });
    clearTimeout(this.heldTimer);
    if (this.held.size) {
      const next = Math.min(...[...this.held.values()].map((h) => h.until)) - now;
      this.heldTimer = window.setTimeout(() => this.render(), Math.max(50, next + 20));
    }
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

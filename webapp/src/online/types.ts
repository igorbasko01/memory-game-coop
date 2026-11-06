/** What the server sends: shared by the Worker and the browser. */

export interface MemberView {
  id: string;
  nickname: string;
  /** Turn order: join order in the lobby, frozen when a game starts. */
  seat: number;
  host: boolean;
  /** Checked in within the last few seconds. */
  online: boolean;
  /** Left the room after this game started. */
  left: boolean;
  /** Sets closed on this player's turns in the current or last game. */
  sets: number;
}

/** A card as everyone may see it: values only for cards that are face up. */
export type CellView =
  | { state: 'empty' }
  | { state: 'down' }
  | { state: 'open'; value: number }
  | { state: 'miss'; value: number }
  | { state: 'closed'; value: number; by: number };

export interface GameView {
  id: string;
  /** 'won' when every set was closed, 'ended' when the host stopped it. */
  status: 'playing' | 'won' | 'ended';
  rows: number;
  cols: number;
  setSize: number;
  sets: number;
  cells: CellView[];
  /** Cells of the attempt in progress, in flip order. */
  open: number[];
  /** Cells of the attempt that just failed, until the next flip. */
  lastMiss: number[] | null;
  last: { cell: number; seat: number; result: 'open' | 'set' | 'miss' } | null;
  /** The seat whose turn it is. */
  turn: number;
  flips: number;
  attempts: number;
  misses: number;
  setsClosed: number;
  /** Sets closed on each seat's turn. */
  setsBySeat: number[];
  startedAt: number;
  finishedAt: number | null;
  lastFlipAt: number;
  /** From this time on anyone in the game may flip for the player whose turn it is. */
  coverAt: number;
}

export interface RoomView {
  id: string;
  code: string;
  status: 'lobby' | 'playing' | 'finished' | 'closed';
  rows: number;
  cols: number;
  hostId: string;
  /** The viewer's player id; null for a TV. */
  you: string | null;
  /** In the lobby: who is in the room. During and after a game: its players, in turn order. */
  members: MemberView[];
  /** Players waiting in the room for the next game (joined after the last one started). */
  waiting: MemberView[];
  /** A TV screen is showing this room. */
  tv: boolean;
  /** The set size the next game would have with the players in the room. */
  nextSetSize: number;
  game: GameView | null;
  /** The server's clock, to compare with the times above. */
  now: number;
}

export interface Player {
  id: string;
  nickname: string;
}

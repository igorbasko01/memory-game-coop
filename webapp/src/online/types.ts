/** What the server sends: shared by the Worker and the browser. */

export interface MemberView {
  id: string;
  nickname: string;
  /** Join order in the lobby, frozen when a game starts. Also the player's colour. */
  seat: number;
  host: boolean;
  /** Checked in within the last few seconds. */
  online: boolean;
  /** Left the room after this game started. */
  left: boolean;
  /** Cards this player has picked in the round being chosen. */
  picked: number;
}

/** A card as everyone may see it: values only for cards that are face up. */
export type CellView =
  | { state: 'empty' }
  | { state: 'down' }
  | { state: 'miss'; value: number }
  | { state: 'closed'; value: number };

/** A card picked for the round being chosen (still face down). */
export interface PickView {
  cell: number;
  seat: number;
}

export interface GameView {
  id: string;
  /** 'won' when every set was closed, 'ended' when the host stopped it. */
  status: 'playing' | 'won' | 'ended';
  rows: number;
  cols: number;
  setSize: number;
  sets: number;
  /** Cards each player picks per round (2 for a solo player, otherwise 1). */
  picksPerPlayer: number;
  cells: CellView[];
  /** The picks of the round being chosen. */
  picks: PickView[];
  /** Cells of the round that just missed, until the next round. */
  lastMiss: number[] | null;
  /** The latest round played. */
  last: { cells: number[]; result: 'set' | 'miss' } | null;
  /** Rounds played so far: the one being chosen is number `round + 1`. */
  round: number;
  misses: number;
  setsClosed: number;
  startedAt: number;
  finishedAt: number | null;
  /** When the round being chosen began. */
  roundStartedAt: number;
  /** From this time on a player who has picked may also pick for someone who hasn't. */
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
  /** In the lobby: who is in the room. During and after a game: its players, in seat order. */
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

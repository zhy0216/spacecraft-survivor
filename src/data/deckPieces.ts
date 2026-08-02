/**
 * 甲板拼块数值表(GDD §4.4)。坐标是未旋转时相对锚点的正交格偏移:
 * +col = 右舷、+row = 船尾。旋转与焊接合法性属于 sim,本文件只存形状与表现名。
 */
export interface DeckPieceDef {
  type: number;
  name: string;
  icon: string;
  /** 扁平二元组:[dCol0,dRow0,dCol1,dRow1,...]；第一格恒为锚点 (0,0)。 */
  cells: readonly number[];
}

export const DECK_PIECE_BAR = 0;
export const DECK_PIECE_L = 1;
export const DECK_PIECE_SQUARE = 2;
export const DECK_PIECE_T = 3;

export const DECK_PIECES: readonly DeckPieceDef[] = [
  { type: DECK_PIECE_BAR, name: '双联甲板', icon: '▰▰', cells: [0, 0, 1, 0] },
  { type: DECK_PIECE_L, name: 'L 形甲板', icon: '◩', cells: [0, 0, 1, 0, 0, 1] },
  { type: DECK_PIECE_SQUARE, name: '方舱甲板', icon: '田', cells: [0, 0, 1, 0, 0, 1, 1, 1] },
  { type: DECK_PIECE_T, name: 'T 形甲板', icon: '⊥', cells: [0, 0, -1, 0, 1, 0, 0, 1] },
];

export const DECK_PIECE_KIND_COUNT = DECK_PIECES.length;

export function deckPieceCellCount(type: number): number {
  return (DECK_PIECES[type]?.cells.length ?? 0) / 2;
}

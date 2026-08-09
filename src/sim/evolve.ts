/**
 * 空间进化(17 号 issue T1,sim 侧)—— "满级塔 + 正交相邻指定支援"的配对判定。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 判定只是"遍历甲板 + 查配方表"的
 *   确定性算术:同一块甲板问一百遍答案都一样,Node 里拿一个纯对象就能把每一对钉住
 *   (17 号验收"配方不满足时绝不触发"那条线就住在本文件这一个函数里)。
 * 铁律 3:配对结果写进**调用方给的 out**(船坞每帧要拿它画金光连线,那条路上不许有新增分配),
 *   本模块不留任何跨帧容器 —— 与 sim/support.ts 的 supportLinks 同一条写法与同一条约定。
 *
 * 依赖方向 deck ← evolve,单向无环:本文件向 deck 要"邻居"(neighborCell)与等级/型号,
 * 向 data/evolutions 要"这一对能不能进化"(evolutionOf)。deck.ts 一个字都不认识本文件 ——
 * 反过来引就是运行期的环,而甲板只当房东这条分工也就散了。
 *
 * 「配对」的三条判据,每条都只有一处实现:
 *   **满级** —— cell.level === TOWER_MAX_LEVEL(5)。等级是塔自己的闸门,不看内容之外的任何东西;
 *   **正交相邻** —— 邻居一律走 deck 的 neighborCell:全仓只有那四个 EDGE_* 偏移,斜角进不来;
 *     洞与船体外在那边已经揉成同一个 undefined,12 号焊出的 L 形/环形甲板也自动吃到同一条规则;
 *   **型号匹配** —— evolutionOf(base, support):配方表里没有的(支援换成别的型号、或塔已是
 *     进化型)恒 -1,配对就此一行都不会产生 —— "不可逆"于是也是**结构上的**:进化塔在任何
 *     配方里都不再是 base,本函数连一行"跳过进化塔"的 if 都不用写。
 *
 * 不做在线检查:**被 12 号包成内部格的离线塔照常参与判定** —— 离线只是"打不响"这条腿
 * (03 号 online 状态机),而进化发生在船坞、替换的是塔型;进化后它占的格仍按边缘/内部格判定,
 * 被围死的照样离线(17 号口径:"进化的塔不是规则的例外")。
 *
 * 遍历顺序 = 塔格按 cells 的 row-major、每塔再按 EDGE_* 升序,**确定且与内容无关**:
 * 同 seed 两个世界的配对表逐位相同(与 supportLinks 的连线顺序同一条纪律)。
 * 一块支援可以同时喂四邻的每一座满级塔(多条配对从同一格出发),一座满级塔也可以被多块
 * 同型支援围着 —— 两个方向都只是"多几对",没有任何一处需要去重或分类讨论。
 */
import { evolutionOf } from '../data/evolutions';
import { TOWER_MAX_LEVEL } from '../data/towers';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  cellIndex,
  type Deck,
  EDGE_COUNT,
  neighborCell,
} from './deck';

/**
 * 生效中的进化配对,扁平二元组写进 out:**out[2k] = 满级塔格下标、out[2k+1] = 被吞噬的支援格下标**。
 * @param out 调用方持有的复用缓冲(船坞整局一块);进门先清长度,返回的就是它本身。
 * @returns out 自己 —— 让调用方能一行写成 `const pairs = findEvolutionPairs(deck, this.buf)`。
 *
 * 扁平二元组而不是 { tower, support } 对象数组:配对表每帧都要整块重写,
 * 对象数组等于每帧都新造十几个短命对象(铁律 3),而下标本身就是渲染层要的东西
 * (它拿 cells[i] 反查格心,与 checksum 的遍历顺序同一套编号)。
 */
export function findEvolutionPairs(deck: Deck, out: number[]): number[] {
  out.length = 0; // 复用调用方的缓冲:清长度,不新建数组
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    // 满级闸门。content/level 由建格初值、recomputeDeck 的清理、placeAt 三处共同维护:
    // 非武器格 level 恒 0,这一句就顺带把空格与支援格全挡掉了
    if (cell.content !== CELL_WEAPON || cell.level !== TOWER_MAX_LEVEL) continue;
    for (let e = 0; e < EDGE_COUNT; e++) {
      const n = neighborCell(deck, cell, e);
      // 非支援格恒 supportType -1,而配方表里没有 -1 这一列 ⇒ 武器格/空格天然进不来,
      // 故这里只问 content 一次(与 supportLinks 的"一次取表"同一条口径)
      if (!n || n.content !== CELL_SUPPORT) continue;
      if (evolutionOf(cell.towerType, n.supportType) < 0) continue;
      out.push(i, cellIndex(deck, n.col, n.row));
    }
  }
  return out;
}

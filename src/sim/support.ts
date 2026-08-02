/**
 * 邻接协同(06 号 issue T1)—— 谁跟谁配对、加成怎么叠,**全仓唯一一份规则**。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 配对只是"遍历甲板 + 查两张数值表"的
 *   确定性算术:同一块甲板问一百遍答案都一样,Node 里拿一个纯对象就能把每一对钉住。
 * 铁律 3:配对结果写进**调用方给的 out**(渲染层整局复用同一块缓冲),本模块只留一个私有暂存;
 *   syncSupportBuffs 是 World 每帧都要调一次的东西,那条路上不许有新增分配。
 *
 * 依赖方向 deck ← arc ← support,单向无环:本文件向 deck 要"邻居"(neighborCell)、
 * 向 arc 要"这一格是不是一座能开火的塔"(isTurretCell)、向 data/supports 要"这块设施吃不吃这门炮"
 * (supportAffects)。deck.ts 一个字都不认识本文件 —— 反过来引就是运行期的环,
 * 而甲板只当房东这条分工也就散了(它认识"这格有块几号设施",不认识"协同"这个概念)。
 *
 * 「生效」的三条判据,每条都只有一处实现:
 *   **正交相邻** —— 邻居一律走 deck 的 neighborCell:全仓只有那四个 EDGE_* 偏移,斜角进不来;
 *     洞与船体外在那边已经揉成同一个 undefined,故本文件一次 occupied 都不必自己判,
 *     12 号焊出的 L 形/环形甲板也自动吃到同一条规则(本文件不必知道甲板长什么样);
 *   **受益格得是一座在线的塔** —— isTurretCell:被 12 号围死的离线塔一发都打不出去,
 *     给它加成等于把一条线画到哑炮上,玩家照着连线布局却什么都没发生;
 *   **节流类型必须匹配** —— supportAffects(data/supports 那一句),装甲舱(SUPPORT_THR_NONE)
 *     对任何塔恒 false ⇒ 它永远不产生 link。
 *
 * 而"连线 = buff 来源"是**结构上**的同一份,不是两处各判一次:
 * recomputeSupportBuffs 自己也从 supportLinks 取配对(先全甲板复位成 1,再沿同一份配对逐对连乘),
 * 渲染层画线读的还是它。于是 06 号验收第二条"连线只出现在真实生效的配对上"想漂都漂不了 ——
 * 要让它出错,得先让同一个函数对同一块甲板给出两种答案。
 *
 * 叠加口径(与 data/supports 文件头那段一字同源):**四个倍率一律连乘**,
 * 两座弹药库夹一门机炮 = 射速 ×1.25²、装填 ×0.7²。连乘永远推不到 ≤ 0,
 * 而"每座 -30%"的加法在四座围一门时会把装填时间推成负数 —— 那门炮此后再也装不上弹。
 * (只有装甲舱的 hullHp 是加法,但它压根不走本文件:船体加成在 sim/damage.ts,当场遍历、不读缓存。)
 */
import { SUPPORTS, supportAffects } from '../data/supports';
import { TOWERS } from '../data/towers';
import { isTurretCell } from './arc';
import { cellIndex, type Deck, EDGE_COUNT, neighborCell } from './deck';

/**
 * 重算自己那一趟配对用的暂存。**绝不外借**(所以不导出):它与调用方传进 supportLinks 的 out
 * 必须是两块不同的数组 —— 共用一块的话,渲染层刚拿到手的配对表会被下一次 recompute 就地清空,
 * 那一帧的连线要么画到别处、要么整层消失,而且只在"重算恰好插在遍历中间"时才复现。
 */
const scratch: number[] = [];

/**
 * 生效中的邻接配对,扁平二元组写进 out:**out[2k] = 支援格下标、out[2k+1] = 受益塔格下标**。
 * @param out 调用方持有的复用缓冲(渲染层整局一块);进门先清长度,返回的就是它本身。
 * @returns out 自己 —— 让调用方能一行写成 `const pairs = supportLinks(deck, this.buf)`。
 *
 * 扁平二元组而不是 { sup, tower } 对象数组:配对表每次重算都要整块重写,
 * 对象数组等于每次放置都新造十几个短命对象(铁律 3),而下标本身就是渲染层要的东西
 * (它拿 cells[i] 反查格心,与 checksum 的遍历顺序同一套编号)。
 *
 * 遍历顺序 = 支援格按 cells 的 row-major、每格再按 EDGE_* 升序,**确定且与内容无关**:
 * 同 seed 两个世界的配对表逐位相同,连线的绘制顺序(叠色)也就不会跳。
 * 一块设施可以同时喂它四邻的每一座塔(多条 link 从同一格出发),一座塔也可以被多块设施围着 ——
 * 两个方向都只是"多几对",没有任何一处需要去重或分类讨论。
 */
export function supportLinks(deck: Deck, out: number[]): number[] {
  out.length = 0; // 复用调用方的缓冲:清长度,不新建数组
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    // 非支援格恒 supportType -1(建格初值 / recomputeDeck 的清理 / placeAt 三处共同保证),
    // 而 SUPPORTS[-1] 本就是 undefined ⇒ **一次取表**就同时挡掉了空格、武器格与不属于船体的格。
    // 不再问一遍 content/occupied:同一件事两处各判一次,迟早有一处漏掉
    // (与 damage.ts 的 hullMaxHp 同一条口径)
    const sup = SUPPORTS[cell.supportType];
    if (!sup) continue;
    for (let e = 0; e < EDGE_COUNT; e++) {
      const n = neighborCell(deck, cell, e);
      // 离线塔不算受益格(isTurretCell 已含 online):12 号把炮位焊成内脏位之后,
      // 它的加成与连线一起消失 —— 灰着的哑炮身上不该挂着一条"正在生效"的线
      if (!n || !isTurretCell(n)) continue;
      const def = TOWERS[n.towerType];
      // 类型不匹配的配对**根本不进这张表**:于是 UI 不必自己判一次"这条线该不该画",
      // 而 buff 计算也不必判一次"这一对该不该乘" —— 两条链路读的是同一份
      if (!def || !supportAffects(sup, def)) continue;
      out.push(i, cellIndex(deck, n.col, n.row));
    }
  }
  return out;
}

/**
 * 全甲板重算四个邻接 buff 缓存(cell.fireRateMul / reloadMul / heatMaxMul / chargeRateMul)。
 * 缓存的读法只有一处:sim/tower.ts 的四个 cell* 包装(取值链路唯一,别处不许再算一份)。
 *
 * 两步,顺序不可换:
 *   一、**逐格复位成 1**。全量而不是就地打补丁 —— 改一格牵动它四邻(甚至更远:12 号焊一格甲板
 *     会同时改掉几座塔的 online),十几格量级下这点开销买的是"绝不漏更新"。
 *     复位值是 **1 不是 0**:0 作倍率是把射速与热上限直接抹成 0,与"这一格没有加成"是两码事。
 *     连不属于船体的格也一起复位(它们本就该是 1),多写一次比"记得跳过"便宜。
 *   二、沿 **supportLinks** 的每一对连乘。**必须**走那个函数而不是在这里再遍历一遍四邻:
 *     "连线 = buff 来源"于是成了结构上的同一份(见文件头)——
 *     画出来的每一条线背后必然有一次连乘,反之亦然。
 *
 * 四个倍率**无差别连乘**、循环里不按设施类型分支:散热器的 fireRateMul 恒 1,乘上去是恒等
 * (data/supports 那条"不用的乘法档填 1"正是为了这一句)。少了这份恒等,这里就得写四个 if,
 * 而将来给某种设施补上第二档效果时,那四个 if 里必然有一个没人记得改。
 *
 * 末尾把 buffRevision 记成当前 revision:**记账与重算同处**,于是"重算完 = 干净"这条事实
 * 只有一个地方知道 —— syncSupportBuffs 那边就只剩一句守卫,不必再补一句盖章
 * (漏盖的话每帧都会重算一遍,而那正是守卫本身要省掉的东西)。
 */
export function recomputeSupportBuffs(deck: Deck): void {
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    c.fireRateMul = 1;
    c.reloadMul = 1;
    c.heatMaxMul = 1;
    c.chargeRateMul = 1;
  }

  const pairs = supportLinks(deck, scratch);
  for (let k = 0; k + 1 < pairs.length; k += 2) {
    // 下标是上面那一趟**现产**的(支援格取过表、受益格取过 isTurretCell),故这里的 ! 是安全的;
    // 渲染层那边多一道判空是因为它的 pairs 与绘制之间隔着别的代码,这里没有那段距离
    const sup = SUPPORTS[cells[pairs[k]!]!.supportType]!;
    const cell = cells[pairs[k + 1]!]!;
    cell.fireRateMul *= sup.fireRateMul;
    cell.reloadMul *= sup.reloadMul;
    cell.heatMaxMul *= sup.heatMaxMul;
    cell.chargeRateMul *= sup.chargeRateMul;
  }

  deck.buffRevision = deck.revision;
}

/**
 * revision 守卫版:甲板没变就整帧 O(1) 跳过。
 * 配对只依赖 occupied / content / supportType / towerType / online,这几样一变 deck.revision 就 +1,
 * 而它们一局里只变几次(放置、12 号焊拆)—— 却是每一帧都要问的东西,故守卫而不是每帧全量重算。
 *
 * 热路径的唯一入口(sim/world.ts 的 step 帧首一次、place 成功后一次):
 * 放置发生在 step **之外**(ui 的一次点击,10 号的三选一还会时停),不补 place 那一次的话,
 * 玩家会看见一块焊好的弹药库连着一门一动不动的机炮,直到下一帧才突然提速。
 * 两次调用重复也不心疼:第二次就是这一句比较。
 *
 * 直接用 placeAt 的调用方(单测)要自己调一次 —— 那正是"四个倍率是**派生量**、不是状态"的形式:
 * 没人同步它,它就还是上一份甲板的答案。
 */
export function syncSupportBuffs(deck: Deck): void {
  if (deck.buffRevision === deck.revision) return;
  recomputeSupportBuffs(deck);
}

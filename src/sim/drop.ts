/**
 * 残骸掉落物与磁吸拾取(10 号 issue T1)—— 纯逻辑。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 掉落**一次 rng 都不掷**
 *   (每只必掉、价值按型取自 data/enemies 的 scrap),于是战斗打得好不好反过来扰动不到出怪的
 *   随机序列,08 号那条"同 seed 同出怪序列"照旧成立;磁吸本身全是"速度 × dt"的确定性积分。
 * 铁律 2:每颗残骸维护 px/py = 上一逻辑帧位置,渲染层按 alpha 在两点间插值 ——
 *   被吸住的残骸每秒跑 300px(比船的巡航还快一倍),不插值的话 60Hz 的逻辑帧在 144Hz 屏上
 *   就是一串跳点,而"残骸飞进船里"恰恰是玩家每隔几秒就要看一次的正反馈。
 * 铁律 3:残骸是对象池里的普通对象,字段在 createDrop 里一次性声明齐、运行期绝不新增;
 *   收下的当场倒序 swap-remove 回收。本文件**连模块级暂存都不需要** ——
 *   磁吸不查邻域(船只有一艘,坐标由调用方直接传进来),于是这一整帧一次分配都没有。
 *
 * 磁吸的规则只有两条,而两条都是手感:
 *   一、进过 magnetRadius 一次就**锁定**(magnet = true),此后船开出半径也绝不放手 ——
 *     每帧现判的话,残骸会在半径边界上"吸一下、松一下"地抖,玩家看到的是一片残骸跟了半步又散开;
 *     锁定则让"航线擦过去 = 收得下"成为一条可预测的读数(GDD §2.2 的分钟级循环指望玩家
 *     用航线去扫残骸,那条线不能是薛定谔的)。
 *   二、锁定后**匀速直追船心**,不加速、不带惯性:加速度模型下残骸会被移动中的船拖出一条
 *     追不上的弧线,而匀速追击只要 dropMagnetSpeed 显著大于船速就必然收敛(tuning 那三行写了这笔账)。
 *
 * 本文件对世界零依赖(比 bullet.ts 的 FireSink 还少一道缝):喂一个池 + 一块甲板 + 船心坐标
 * 就能在 Node 里把每一条规则钉死(见 drop.test.ts)。World 只负责两件它才知道的事 ——
 * 敌人死了往池里放一颗、把本函数返回的那笔账记进 scrap。
 */
import type { Pool } from '../core/pool';
import { tuning } from './config';
import type { Deck } from './deck';

/** px/py = 上一逻辑帧位置(铁律 2);字段一次性声明齐,运行期不新增 */
export interface Drop {
  x: number;
  y: number;
  px: number;
  py: number;
  /**
   * 速度 px/s。未锁定时是掉落方给的漂移(MVP 恒 0 = 停在敌人倒下的地方),
   * 锁定后由 stepDrops 每帧重写成"指向船心 × dropMagnetSpeed"——
   * 存成字段而不是每帧算完就扔:渲染层要拿它给残骸摆朝向/拖尾,不必自己再求一次方向。
   */
  vx: number;
  vy: number;
  /**
   * 收下时进账多少残骸。**掉落那一刻定死**(= 该敌型的 scrap),与子弹的 damage 同口径:
   * 飞行途中绝不回查敌人(那只早就回池、甚至已经变成了另一只),也绝不随时间衰减。
   */
  value: number;
  /**
   * 是否已被磁吸锁定。**只从 false 变 true,永不回落** —— 这就是"进过半径一次就不放手"的
   * 全部实现(理由见文件头)。它是逐帧演化出来的状态,不是距离的派生量:
   * 同一个位置的两颗残骸可以一颗被吸着走、一颗还躺着,差别只在它们各自进过半径没有。
   */
  magnet: boolean;
}

/** 池 factory:字段在这里一次性声明齐,之后只被赋值、绝不新增(与 createBullet 同口径) */
export function createDrop(): Drop {
  return {
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    value: 0,
    magnet: false,
  };
}

/**
 * 池 reset:**逐字段清**,与 resetBullet / resetEnemy 同口径。
 * 漏一个,下一颗就会继承上一颗的状态 —— 最典型的是 magnet 没清:新掉的那颗一出生就自带磁吸,
 * 隔着半个屏幕从敌人尸体上直奔船而来;或者 value 没清,一颗蜂群蛭的残骸莫名其妙值 4 点。
 * 这类脏值只在池被压满(一场混战之后)才现形,是最难查的一类 bug,
 * 故单测按 Object.keys 逐字段比对,将来加字段忘了这里会被当场抓住。
 */
export function resetDrop(d: Drop): void {
  d.x = 0;
  d.y = 0;
  d.px = 0;
  d.py = 0;
  d.vx = 0;
  d.vy = 0;
  d.value = 0;
  d.magnet = false;
}

/**
 * 起吸半径(px)—— 做成**甲板的派生量**而不是让调用方直接读 tuning,
 * 是给 GDD §5.3 那块磁力收集器("拾取半径 +30%")留的唯一挂钩:届时只填本函数体,
 * stepDrops 与将来渲染层画的那个吸取圈都一个字不用改(与 damage.hullMaxHp / edgeDamageMul
 * 在 MVP 恒返回基准值是同一条口径 —— 调用点今天就接好)。
 * MVP 甲板上还没有那种设施,故 deck 眼下用不上,恒返回旋钮本身。
 * 每次现读 tuning 而不是模块加载时算死:它是面板上"拖一下看体感"的那根旋钮(验收标准第四条)。
 */
export function magnetRadius(deck: Deck): number {
  return tuning.dropMagnetRadius;
}

/**
 * 残骸的离场半径(px):离船超过这一档的**未锁定**残骸回池,并**折半入账**(见 DROP_CULL_REFUND)。
 * 地图无限之后,被玩家开过去不捡的残骸会永远躺在身后 —— DROP_MAX_ALIVE(data/economy)
 * 那道保险丝挡得住内存,挡不住"老残骸占满池、新掉落全被丢弃"的经济死账:
 * 打了怪却什么都不掉,玩家只会觉得掉落坏了。
 * 取 2000 ≳ 出怪环外沿(1300)+ 一整屏(~970):只要还看得见、或掉头一屏内能回去捡的都留着,
 * 真正被甩掉的才清 —— 与敌人的 ENEMY_FALLBEHIND_RADIUS 是同一类"身后的东西不白占内存"口径。
 * 已锁定(magnet)的一概不清:它正在飞向船,清了等于当面抢走一笔已经承诺的进账。
 */
export const DROP_CULL_RADIUS = 2000;

/**
 * 离场残骸的折半回收系数(畅玩性调整):被甩掉的那颗回池时按 ceil(value × 0.5) 记进本帧进账,
 * 而不是纯丢弃。旧口径下风筝远离/不敢回场中心的打法会整批**静默漏钱**,而游戏里没有任何读数
 * 告诉玩家漏了多少 —— 症状只是"卡弹得少"。折半保住了经济下限,又保留"亲自去捡收满额"的激励。
 * ceil 而不是 floor:面额 1 的蜂群蛭残骸(全场最多的一种)floor 会折成 0,又回到静默漏钱。
 */
export const DROP_CULL_REFUND = 0.5;

/**
 * 推进全场残骸一逻辑帧:起吸判定 → 积分 → 收取。
 * @param shipX @param shipY 船心世界坐标(调用方传本帧**积分之后**的位置:残骸追的是船现在在哪,
 *   晚一帧的话高速航行时整串残骸会恒定拖在船身后)
 * @returns **本帧收到的残骸总量**(收下的 value 之和 + 离场残骸的折半回收,没收到就是 0)——
 *   调用方直接 `scrap += stepDrops(...)`。不由本函数去写 World 的字段:掉落这一层不认识"经济",
 *   正如 bullet.ts 不认识"击杀数"。
 *
 * **倒序遍历**:收下的当场回收,而 pool 的 despawnAt 是 swap-remove ——
 * 正序时被顶上来的那颗会跳过当前下标而漏检(core/pool 的注释给的就是这条口径,
 * stepBullets 与 World.reap 同理);倒序则被顶上来的对象一定落在已经走过的区间,不漏也不重。
 */
export function stepDrops(
  drops: Pool<Drop>,
  deck: Deck,
  shipX: number,
  shipY: number,
  dt: number,
): number {
  const items = drops.items;
  // 三根旋钮**每帧现读一次**并 hoist 出循环(与 world.step 里 hoist enemySeparation 同口径):
  // 面板拖动照样即时生效,而一帧之内全场残骸必须用同一套数 —— 循环里逐颗现读的话,
  // 面板恰好在两颗残骸之间改了值,这一帧就会分裂成"前一半按旧半径、后一半按新半径"。
  const magnetR = magnetRadius(deck);
  const magnetR2 = magnetR * magnetR;
  const speed = tuning.dropMagnetSpeed;
  const collectR = tuning.dropCollectRadius;
  const collectR2 = collectR * collectR;
  // 本帧位移上限:够得着船心就不许冲过头(见下面那段),预先算好,免得逐颗乘一遍
  const stepLen = speed * dt;

  let got = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const d = items[i]!;
    // 先存上一帧位置再积分(与子弹、敌人、stepShip 同口径):渲染插值的两端由此成立
    d.px = d.x;
    d.py = d.y;

    const dx = shipX - d.x;
    const dy = shipY - d.y;
    const d2 = dx * dx + dy * dy;
    // 被甩在身后的未锁定残骸出局,但**折半入账**(经济下限账见 DROP_CULL_REFUND)。
    // 排在起吸判定之前 —— 反正两个半径差一个数量级,谁先谁后不会改变任何一颗的归属
    if (!d.magnet && d2 > DROP_CULL_RADIUS * DROP_CULL_RADIUS) {
      got += Math.ceil(d.value * DROP_CULL_REFUND);
      drops.despawnAt(i);
      continue;
    }
    // 起吸判据含边界(恰好落在起吸圆上算吸,与 arc.findArcTarget 的射程圆、bullet 的命中圆同口径)。
    // 只判"还没锁定的那些":锁定是单向的,判过一次就再也不问距离了
    if (!d.magnet && d2 <= magnetR2) d.magnet = true;

    if (d.magnet) {
      const dist = Math.sqrt(d2);
      if (dist <= stepLen) {
        // 本帧位移够得着船心就**落在船心上,绝不冲过头**:冲过头的残骸下一帧要掉头回来,
        // 于是在收取半径被拖得比一帧位移还小时(它是面板上给人拖的旋钮),残骸会绕着船心
        // 来回抖、永远收不下。落在船心 ⇒ 距离 0 ⇒ 必被下面那句收下,哪怕收取半径是 0。
        // 速度清零而不是留着上一帧的方向:它已经到站了,渲染层不该再给它画一条拖尾
        d.x = shipX;
        d.y = shipY;
        d.vx = 0;
        d.vy = 0;
      } else {
        // 匀速直追船心,**方向每帧重算**(而不是锁定那一刻定死一条直线):船一直在动,
        // 定死方向的残骸会擦着船边飞过去,而"擦过去 = 收下"正是这套磁吸唯一要保证的事。
        // dist > stepLen ≥ 0 ⇒ 这里除的一定不是 0
        d.vx = (dx / dist) * speed;
        d.vy = (dy / dist) * speed;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
      }
    } else {
      // 还没被吸住:按自己的速度漂(掉落方给什么就是什么,MVP 恒 0 = 停在敌人倒下的地方)。
      // 磁吸**不接管**这一段速度 —— 它是"这颗残骸被抛出来时的惯性",与船在哪无关
      d.x += d.vx * dt;
      d.y += d.vy * dt;
    }

    // 收取判据用**本帧走完的新位置**(这一帧的位移正是它飞完的最后一段,与直射弹
    // "先判命中再判到期"同一条理由),且**不问 magnet**:判据是"离船够近",而不是"被吸住过"——
    // 万一 dropCollectRadius 被拖得比 dropMagnetRadius 还大,贴在船身上的残骸照样该收得下
    const cdx = shipX - d.x;
    const cdy = shipY - d.y;
    if (cdx * cdx + cdy * cdy <= collectR2) {
      got += d.value;
      drops.despawnAt(i);
    }
  }
  return got;
}

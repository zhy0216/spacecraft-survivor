# 《星骸》STARWRECK

一艘由你逐格拼出来的战舰,在无尽虫潮中转舵寻找射界。
太空割草(Survivors-like)× 甲板空间拼图。

- 设计文档:[GDD.md](GDD.md)
- MVP 任务拆解:[todos/](todos/README.md)

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173 —— 玩家形态,直接开玩
npm test         # 单测:RNG / 对象池 / 空间哈希 / World 确定性
npm run build    # tsc 类型检查 + 产物构建
```

## 当前状态:玩家可畅玩的完整 MVP

打开即玩:起手配置四选一 → 甲板割草战斗(4 航段 + 精英 + Boss)→ 三选一升级 / 每两分钟整备(船坞商店、免费重排、付费修复)→ 结算入图鉴 → 元进度解锁新起手/新塔/新法令。
战斗中 `Esc` 暂停(继续 / 再来一局 / 再试一局 / 静音)。

**开发模式**:URL 加 `?debug` 恢复灰盒调参面板(实体数量、手感参数、波次读数、压测 1000 敌)与 `· dev` 页签。
`?seed=123` 指定种子 —— 同 seed 两次运行、同 tick 的 checksum 必须一致。

## 架构三铁律

1. **`sim/` 纯逻辑,永不 import pixi/DOM** —— 换来确定性、Node 单测、渲染可替换。
2. **固定时步 60Hz**(`core/loop.ts`),渲染层用 alpha 在实体 prev/cur 位置间插值。
3. **实体 = 对象池里的普通对象;界面分两层**:世界内的走 Pixi(ParticleContainer),
   菜单/卡片/面板走 DOM(`#ui` 覆盖层)。

## 目录

```
src/core     循环、种子 RNG、对象池、空间哈希、输入(02 号 issue 接线)
src/sim      世界状态与规则(纯 TS,无渲染依赖)
src/render   Pixi 渲染、镜头、灰盒纹理
src/ui       DOM 覆盖层:调参面板(后续:三选一卡片、结算)
src/data     数值配置(后续:塔/敌人/波次)
todos/       MVP issue 拆解与实施顺序
```

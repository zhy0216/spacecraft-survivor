# 29 · Boss 召唤表补位(卫生修)

- 优先级:P2(微)— 一行数据 + 一条不变量,修"注释承诺的长度契约失守"
- 依赖:无
- 来源:《玩法创新与改进探索》§七 #7(data 层盘点时发现)

## 背景

`src/data/enemies.ts:99` 的 `BOSS.summonCounts: [6, 2, 0, 0]` 长度为 4,而同字段注释
写明"长度 = ENEMY_KIND_COUNT"——孢子炮手(22 号)加入后敌型已是 5。行为上无恙
(`[4]` 读出 undefined,World 召唤循环把它当 0),但:

- 与 `WaveBurst.counts` 被单测钉死的长度不变量(短一位静默漏一型)口径不一致;
- 下一个人往表里加第 6 型敌人时,这里就是现成的静默坑。

## 任务

- [ ] `data/enemies.ts:99`:`summonCounts: [6, 2, 0, 0]` → `[6, 2, 0, 0, 0]`,
      注释点一句"长度契约与 WaveBurst.counts 同款"
- [ ] `boss.test`(或 enemies 数据不变量所在的测试文件)加一条:
      `BOSS.summonCounts.length === ENEMY_KIND_COUNT`——照抄 WaveBurst.counts 的钉法

## 验收标准

- [ ] 行为零变化:召唤仍是 6 蜂群蛭 + 2 侧掠者;固定 seed 用例一条不动、checksum 不变
- [ ] 不变量用例挡住未来"加敌型忘补召唤表"的静默漏

## 口径说明与交接

- undefined → 0 在这里语义等价,所以这是卫生修不是行为修;正因为等价,**不要**顺手
  改召唤配比——那是 Boss 二阶段(节奏方案 P5,后续批次)的事。

/**
 * content:内容名称资源(03 号 issue)。结构以本文件为准,en 照抄结构。
 * 顶层按类别(key 类别名),类别内按各数据表的 **slug** 键控 —— slug 是翻译/编辑器身份,
 * 数值 type/kind 才是存档与模拟身份(见各 data 表的 slug 字段注释)。
 * tower 的 family 字段 = 节流系标签(弹药系/过热系/充能系,按该塔 throttle 填)。
 * affix 的 description 是面向玩家的效果文案(数据表里的开发说明留在代码注释)。
 * edicts.scope.all = 全船法令的作用域标签;edicts.effects 是法令效果逐轴短语({{value}} 由
 * presenter 用 i18n/format 格式化后填入);edicts.noEffects 是全中性法令的兜底文案。
 * behaviors 是敌型行为短标签;unlocks 按解锁条目的 id 键控(玩家名字),conditions 是解锁条件文案。
 * errors 段:presenter 对越界数值的本地化错误文案,{{var}} 是原始编号。
 */
export const content = {
  towers: {
    autocannon: { name: '自动机炮', family: '弹药系' },
    laser_prism: { name: '激光棱镜', family: '过热系' },
    arc_coil: { name: '电弧塔', family: '过热系' },
    railgun: { name: '磁轨炮', family: '充能系' },
    point_defense: { name: '点防阵列', family: '弹药系' },
    plasma_mortar: { name: '等离子迫击炮', family: '充能系' },
    storm_cannon: { name: '风暴机炮', family: '弹药系' },
    aurora_array: { name: '极光阵列', family: '过热系' },
    annihilation_lance: { name: '湮灭长矛', family: '充能系' },
    thunder_crown: { name: '雷霆王冠', family: '过热系' },
    deluge_rain: { name: '焦土骤雨', family: '充能系' },
    thorn_curtain: { name: '荆棘星幕', family: '弹药系' },
    missile_nest: { name: '导弹巢', family: '弹药系' },
  },
  enemies: {
    swarm_leech: { name: '蜂群蛭' },
    side_raider: { name: '侧掠者' },
    tail_maggot: { name: '尾随蛆' },
    ram_beetle: { name: '冲撞甲虫' },
    spore_gunner: { name: '孢子炮手' },
  },
  edicts: {
    ammo_protocol: { name: '弹药协议' },
    coolant_protocol: { name: '散热协议' },
    capacitor_protocol: { name: '电容协议' },
    armor_protocol: { name: '装甲协议' },
    amp_protocol: { name: '增幅协议' },
    magnet_protocol: { name: '磁力协议' },
    gyro_calibration: { name: '重心校准' },
    cruise_calibration: { name: '巡航校准' },
    starchart_protocol: { name: '星图协议' },
    overdrive_protocol: { name: '超载协议' },
    boost_calibration: { name: '增压校准' },
    scope: {
      all: '全船',
    },
    effects: {
      fireRate: '射速 ×{{value}}',
      reload: '装填 ×{{value}}',
      heatMax: '热上限 ×{{value}}',
      chargeRate: '充能 ×{{value}}',
      damage: '全武器伤害 ×{{value}}',
      hullHp: '船体 HP {{value}}',
      damageTaken: '受击 ×{{value}}',
      xp: '经验 ×{{value}}',
      magnetRadius: '磁吸半径 ×{{value}}',
      turnRate: '转向 {{value}}°/s',
      cruiseSpeed: '巡航速度 ×{{value}}',
      boostCooldown: '加速冷却 {{value}}s',
      starCoinChance: '星币概率 {{value}}%',
    },
    noEffects: '这一条在数值表里没有任何效果',
  },
  affixes: {
    frenzy: { name: '狂热光环', description: '光环内敌人速度 ×1.6' },
    fission: { name: '裂变', description: '死亡时分裂成 3 只' },
    magnetic: { name: '磁力干扰', description: '玩家拾取半径 ×0.5' },
    armored: { name: '装甲', description: '弹药系伤害 ×0.5' },
    phased: { name: '相位', description: '能量系伤害 ×0.5' },
  },
  segments: {
    departure_lane: { name: '离港航道' },
    debris_belt: { name: '碎石带' },
    patrol_lane: { name: '巡逻线' },
    swarm_siege: { name: '虫潮合围' },
  },
  behaviors: {
    seek: '直线追船',
    strafe: '侧向驻留',
    strafeCharge: '侧向冲锋',
    seekCharge: '直线冲锋',
    spore: '远程喷吐',
  },
  unlocks: {
    'tower-missile-nest': '导弹巢',
    'edict-rapid': '超载协议',
    'elite-queen': '虫群母巢',
    conditions: {
      firstWin: '首次胜利',
      kills: '单局击杀 {{target}}',
      eliteKills: '累计精英击杀 {{target}}',
      unknown: '未知条件 #{{kind}}',
    },
  },
  boss: {
    name: '母巢巨兽',
  },
  errors: {
    unknownTower: '未知武器 #{{type}}',
    unknownEnemy: '未知敌人 #{{kind}}',
    unknownEdict: '未知法令 #{{type}}',
    unknownAffix: '未知词缀 #{{id}}',
    unknownSegment: '未知航段 #{{index}}',
    unknownFamily: '未知节流系 #{{throttle}}',
    unknownBehavior: '未知行为 #{{bh}}',
    unknownCondition: '未知条件 #{{kind}}',
  },
} as const;

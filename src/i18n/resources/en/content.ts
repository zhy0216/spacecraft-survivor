import type { DeepRecord } from '../../types';
import type { content as zhContent } from '../zh-CN/content';

/**
 * 英文内容名称。结构以 zh-CN/content 为准,值可自由换。
 * tower family 统一口径:弹药系 = ammo-fed、过热系 = heat-managed、充能系 = charge-type
 * (与 todo 08 的术语要求一致:weapon/tower、edict、affix、hull、scrap、star coin、refit)。
 */
export const content: DeepRecord<typeof zhContent> = {
  towers: {
    autocannon: { name: 'Auto Cannon', family: 'Ammo-fed' },
    laser_prism: { name: 'Laser Prism', family: 'Heat-managed' },
    arc_coil: { name: 'Arc Coil', family: 'Heat-managed' },
    railgun: { name: 'Railgun', family: 'Charge-type' },
    point_defense: { name: 'Point Defense', family: 'Ammo-fed' },
    plasma_mortar: { name: 'Plasma Mortar', family: 'Charge-type' },
    storm_cannon: { name: 'Storm Cannon', family: 'Ammo-fed' },
    aurora_array: { name: 'Aurora Array', family: 'Heat-managed' },
    annihilation_lance: { name: 'Annihilation Lance', family: 'Charge-type' },
    thunder_crown: { name: 'Thunder Crown', family: 'Heat-managed' },
    deluge_rain: { name: 'Deluge Rain', family: 'Charge-type' },
    thorn_curtain: { name: 'Thorn Curtain', family: 'Ammo-fed' },
    missile_nest: { name: 'Missile Nest', family: 'Ammo-fed' },
  },
  enemies: {
    swarm_leech: { name: 'Swarm Leech' },
    side_raider: { name: 'Side Raider' },
    tail_maggot: { name: 'Tail Maggot' },
    ram_beetle: { name: 'Ram Beetle' },
    spore_gunner: { name: 'Spore Gunner' },
  },
  edicts: {
    ammo_protocol: { name: 'Ammo Protocol' },
    coolant_protocol: { name: 'Coolant Protocol' },
    capacitor_protocol: { name: 'Capacitor Protocol' },
    armor_protocol: { name: 'Armor Protocol' },
    amp_protocol: { name: 'Amp Protocol' },
    magnet_protocol: { name: 'Magnet Protocol' },
    gyro_calibration: { name: 'Gyro Calibration' },
    cruise_calibration: { name: 'Cruise Calibration' },
    starchart_protocol: { name: 'Starchart Protocol' },
    overdrive_protocol: { name: 'Overdrive Protocol' },
    boost_calibration: { name: 'Boost Calibration' },
    scope: {
      all: 'All',
    },
    effects: {
      fireRate: 'Fire rate ×{{value}}',
      reload: 'Reload ×{{value}}',
      heatMax: 'Heat cap ×{{value}}',
      chargeRate: 'Charge ×{{value}}',
      damage: 'All weapon damage ×{{value}}',
      hullHp: 'Hull HP {{value}}',
      damageTaken: 'Damage taken ×{{value}}',
      xp: 'XP ×{{value}}',
      magnetRadius: 'Pickup radius ×{{value}}',
      turnRate: 'Turn rate {{value}}°/s',
      cruiseSpeed: 'Cruise speed ×{{value}}',
      boostCooldown: 'Boost cooldown {{value}}s',
      starCoinChance: 'Star coin chance {{value}}%',
    },
    noEffects: 'This edict has no effects in the data table.',
  },
  affixes: {
    frenzy: { name: 'Frenzy', description: 'Enemies in the aura move at ×1.6 speed.' },
    fission: { name: 'Fission', description: 'Splits into 3 smaller enemies on death.' },
    magnetic: { name: 'Magnetic Interference', description: 'Your pickup radius is ×0.5.' },
    armored: { name: 'Armored', description: 'Takes ×0.5 damage from ammo-fed weapons.' },
    phased: { name: 'Phased', description: 'Takes ×0.5 damage from heat and charge weapons.' },
  },
  segments: {
    departure_lane: { name: 'Departure Lane' },
    debris_belt: { name: 'Debris Belt' },
    patrol_lane: { name: 'Patrol Lane' },
    swarm_siege: { name: 'Swarm Siege' },
  },
  behaviors: {
    seek: 'Chase',
    strafe: 'Strafe hold',
    strafeCharge: 'Strafe charge',
    seekCharge: 'Head-on charge',
    spore: 'Ranged spit',
  },
  unlocks: {
    'tower-missile-nest': 'Missile Nest',
    'edict-rapid': 'Overdrive Protocol',
    'elite-queen': 'Hive Queen',
    conditions: {
      firstWin: 'First victory',
      kills: '{{target}} kills in a run',
      eliteKills: '{{target}} elite kills total',
      unknown: 'Unknown condition #{{kind}}',
    },
  },
  boss: {
    name: 'Hive Colossus',
  },
  errors: {
    unknownTower: 'Unknown weapon #{{type}}',
    unknownEnemy: 'Unknown enemy #{{kind}}',
    unknownEdict: 'Unknown edict #{{type}}',
    unknownAffix: 'Unknown affix #{{id}}',
    unknownSegment: 'Unknown segment #{{index}}',
    unknownFamily: 'Unknown throttle family #{{throttle}}',
    unknownBehavior: 'Unknown behavior #{{bh}}',
    unknownCondition: 'Unknown condition #{{kind}}',
  },
};

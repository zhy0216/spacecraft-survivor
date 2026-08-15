import type { DeepRecord } from '../../types';
import type { content as zhContent } from '../zh-CN/content';

/** 英文内容名称。结构以 zh-CN/content 为准,值可自由换。 */
export const content: DeepRecord<typeof zhContent> = {
  towers: {
    autoCannon: 'Auto Cannon',
    laserPrism: 'Laser Prism',
  },
  segments: {
    departureLane: 'Departure Lane',
    debrisBelt: 'Debris Belt',
    patrolLine: 'Patrol Line',
    swarmAssault: 'Swarm Assault',
  },
};

import type { GroupKey } from './groups.js';

export interface Risk {
  id: string;
  group: GroupKey;
  /** 方块上显示的短名，不超过 6 个字，不然贴图上看不清 */
  title: string;
  /** 结算时的那一句画面，要具体、要有物件 */
  scene: string;
  /** 能救你的真实条目 id。找不到时回退到同域最高证据等级的一条。 */
  keys: string[];
}

/**
 * 风险池。每一条都能在原书里找到对应条目，
 * keys 里的 id 是真实条号（章-条），不是编的。
 */
export const RISKS: Risk[] = [
  {
    id: 'crash',
    group: '身体',
    title: '车祸',
    scene: '前排没系安全带，撞上的一瞬间人就出去了。',
    keys: ['01-1', '01-2'],
  },
  {
    id: 'co',
    group: '身体',
    title: '一氧化碳',
    scene: '冬天在屋里烧煤取暖，睡着以后再没醒过来。',
    keys: ['01-3', '13-19'],
  },
  {
    id: 'mushroom',
    group: '身体',
    title: '毒蘑菇',
    scene: '一篮看着眼熟的野生蘑菇，全家进了 ICU。',
    keys: ['01-5'],
  },
  {
    id: 'ebike',
    group: '身体',
    title: '楼道起火',
    scene: '电动车在楼道里充了一夜电，半夜起火封了唯一的出口。',
    keys: ['01-6'],
  },
  {
    id: 'bp',
    group: '身体',
    title: '高血压',
    scene: '血压高了好几年没人知道，某天早上直接脑出血。',
    keys: ['01-7', '01-8'],
  },
  {
    id: 'hp',
    group: '身体',
    title: '幽门螺杆菌',
    scene: '胃一直不舒服忍着，查出来的时候已经萎缩性胃炎。',
    keys: ['01-23'],
  },
  {
    id: 'tetanus',
    group: '身体',
    title: '破伤风',
    scene: '被锈铁钉扎了一下没管，一周后张不开嘴。',
    keys: ['01-15'],
  },
  {
    id: 'guarantee',
    group: '法律',
    title: '替人担保',
    scene: '替朋友签了担保，朋友跑了，债主找上的是你。',
    keys: ['08-18'],
  },
  {
    id: 'face-loan',
    group: '法律',
    title: '帮人刷脸',
    scene: '熟人让你念了一段验证码，你背上八万块贷款。',
    keys: ['08-45'],
  },
  {
    id: 'premarital',
    group: '法律',
    title: '婚前没核底',
    scene: '结婚以后才发现对方早就结过，钱也要不回来。',
    keys: ['08-26', '08-25'],
  },
  {
    id: 'work-injury',
    group: '工作',
    title: '工伤不认',
    scene: '上班受伤，单位说走医保就行，工伤待遇全没了。',
    keys: ['19-11'],
  },
  {
    id: 'overtime',
    group: '工作',
    title: '加班费被吞',
    scene: '三年加班费一分没给，离职时才发现自己什么证据都没有。',
    keys: ['19-1', '19-8'],
  },
  {
    id: 'auto-renew',
    group: '钱',
    title: '自动续费',
    scene: '十几个自动续费没人管，一年白扣两千多。',
    keys: ['05-1'],
  },
  {
    id: 'deposit',
    group: '钱',
    title: '押金要不回',
    scene: '退租那天房东挑出一堆毛病，押金一分没退。',
    keys: ['15-1'],
  },
  {
    id: 'rent-fund',
    group: '钱',
    title: '公积金睡大觉',
    scene: '租了五年房，才知道公积金能提出来交房租。',
    keys: ['05-3', '07-16'],
  },
  {
    id: 'prenatal',
    group: '家庭',
    title: '产检漏项',
    scene: '孕早期没建册，把免费的筛查项全错过了。',
    keys: ['27-2', '27-3'],
  },
  {
    id: 'notify',
    group: '精力',
    title: '通知轰炸',
    scene: '一天被打断两百次，到晚上一件正事都没做完。',
    keys: ['03-1'],
  },
  {
    id: 'vitamin',
    group: '误区',
    title: '吃维生素防病',
    scene: '每天一把复合维生素防心血管病，其实一点用没有。',
    keys: ['06-1'],
  },
];

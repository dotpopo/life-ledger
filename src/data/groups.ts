export type GroupKey = '身体' | '钱' | '法律' | '工作' | '家庭' | '精力' | '误区';

export interface GroupMeta {
  key: GroupKey;
  /** 3D 用（线性色，会过一遍色调映射） */
  color: number;
  /** DOM 用 */
  css: string;
  hint: string;
}

export const GROUP_ORDER: GroupKey[] = ['身体', '钱', '法律', '工作', '家庭', '精力', '误区'];

/**
 * 七个域。颜色必须彼此可分辨，但不能做成彩虹：
 * 每个色都压了饱和度，靠明度和色相区分，不靠纯度。
 * 「误区」用中性灰，语义就是「做了也没用」。
 */
export const GROUPS: Record<GroupKey, GroupMeta> = {
  身体: { key: '身体', color: 0xc2413f, css: '#c2413f', hint: '车祸、火灾、中毒、筛查、疫苗' },
  钱: { key: '钱', color: 0xb08a3e, css: '#b08a3e', hint: '花钱、省钱、被骗、押金' },
  法律: { key: '法律', color: 0x5b7a85, css: '#5b7a85', hint: '合同、担保、红线、手续' },
  工作: { key: '工作', color: 0x6e6a8a, css: '#6e6a8a', hint: '工伤、加班费、失业、技能' },
  家庭: { key: '家庭', color: 0xa05a72, css: '#a05a72', hint: '婚育、孩子、老人、身后事' },
  精力: { key: '精力', color: 0x6e8a6a, css: '#6e8a6a', hint: '注意力、睡眠、放松、打击' },
  误区: { key: '误区', color: 0x8a8a8a, css: '#8a8a8a', hint: '做了也没用，甚至有害' },
};

/** 成本等级 → 点数。0 不花钱 / 少 少量 / 多 不少 */
export const COST_POINT: Record<string, number> = { 0: 0, 少: 2, 多: 4 };
export const TIME_POINT: Record<string, number> = { 少: 0, 中: 1, 多: 3 };
export const WILL_POINT: Record<string, number> = { 否: 0, 些: 1, 是: 3 };

/** 成本等级 → 人话标签（照原书的 LABEL 口径） */
export const COST_LABEL: Record<string, Record<string, string>> = {
  money: { 0: '不花钱', 少: '花少量钱', 多: '花不少钱' },
  time: { 少: '顺手', 中: '花几小时', 多: '每天占时间' },
  will: { 否: '不用毅力', 些: '要一点毅力', 是: '要很多毅力' },
};

export const GAIN_LABEL: Record<string, string> = { 大: '收益大', 中: '收益中', 小: '收益小' };

/** 证据等级 → 金属材质（不靠颜色区分等级，靠材质） */
export const GRADE_META: Record<string, { metal: number; css: string; rough: number; label: string }> = {
  A: { metal: 0xc9a227, css: '#c9a227', rough: 0.28, label: 'A 级证据' },
  B: { metal: 0x9ba0a6, css: '#9ba0a6', rough: 0.34, label: 'B 级证据' },
  C: { metal: 0x8c6a4a, css: '#8c6a4a', rough: 0.44, label: 'C 级证据' },
};

export function gradeOf(raw: string): 'A' | 'B' | 'C' {
  const m = (raw || '').match(/^[ABC]/);
  return (m ? m[0] : 'C') as 'A' | 'B' | 'C';
}

import type { CardRecord, Corpus } from './types.js';
import { RISKS, type Risk } from './data/risks.js';
import { COST_POINT, TIME_POINT, WILL_POINT, gradeOf, type GroupKey } from './data/groups.js';

export interface Resources {
  money: number;
  time: number;
  will: number;
}

/** 一手的加分明细。UI 靠它把「+42」拆开给玩家看。 */
export interface ScoreBreakdown {
  alive: number;
  clear: number;
  grade: number;
  calm: number;
  combo: number;
  total: number;
  /** 含本次在内，连了几手 */
  comboCount: number;
}

/** 一锤定音：点下去就定音，选错了就是这份信息 */
export interface MissInfo {
  risk: Risk;
  card: CardRecord;
  index: number;
  /** group = 域选错了；cost = 域对了但付不起 */
  reason: 'group' | 'cost';
}

export interface Summary {
  won: boolean;
  age: number;
  cause: string;
  scene: string;
  landed: Risk[];
  cleared: number;
  turns: number;
  bestCombo: number;
  saves: Array<{ id: string; title: string; grade: string }>;
}

export interface EngineEvents {
  onHand: (cards: CardRecord[], matchIndex: number) => void;
  onRisk: (risk: Risk, fallMs: number, token: number) => void;
  /**
   * 风险被解决。
   * card = 被出牌打掉（炸开）
   * pass = 玩家主动放过（直接按进井里）
   * land = 落地固化成一层的网格（自然落下，或者选错后砸下来）
   */
  onResolved: (risk: Risk, by: 'card' | 'pass' | 'land') => void;
  /** 这一手的岁数是怎么加出来的 */
  onScore: (s: ScoreBreakdown) => void;
  /** 一锤定音点错了：这一手直接结束 */
  onMiss: (m: MissInfo) => void;
  onResources: (res: Resources) => void;
  onStats: (s: { turn: number; age: number; cleared: number; landed: number }) => void;
  onGameOver: (s: Summary) => void;
}

/* ---------- 计分：一生总分 ---------- */
/**
 * 岁数不是真实寿命，是把「这一生过得怎么样」摊成的一个分数。
 * 四个来源，每手的数字都不一样，但玩家不用自己算：
 *
 *   起始        88
 *   活过一手    +8              有没有打掉都给，活着本身就有分
 *   打掉风险    +16             这一手真解决了问题
 *   证据等级    A +8 / B +5 / C +2      原书数据自带，卡越硬救得越漂亮
 *   从容出手    早 +8 / 中 +4 / 晚 +1   看「出手时方块落到哪了」
 *   连击        +2 × (连击-1)，封顶 +10，断一次归零
 *
 * 理论满分（19 手全打掉、全 A 卡、全从容、连击不断）= 1008。
 * 实际好局落在 850~950，一般局 600~800。
 */
const START_AGE = 88;
const TOTAL_TURNS = 19;
const AGE_ALIVE = 8;
const AGE_CLEAR = 16;
const GRADE_BONUS: Record<string, number> = { A: 8, B: 5, C: 2 };
const CALM_EARLY = 8; // 方块还在上半段（≤40%）
const CALM_MID = 4; // 40% ~ 75%
const CALM_LATE = 1; // 最后关头
const COMBO_STEP = 2;
const COMBO_CAP = 10;
const MAX_LAYERS = 10;
const HAND_SIZE = 3;

const START: Resources = { money: 8, time: 6, will: 4 };
const CAP: Resources = { money: 12, time: 10, will: 8 };
const REGEN: Resources = { money: 2, time: 2, will: 1 };

/**
 * 下落时长：越往后越快。
 * 原来是 6s → 3.2s，实测太快：选项还没读完方块就落地了，
 * 玩家只能盲点。整体放慢一倍（时长 ×2，等于速度减半）：12s → 6.4s。
 */
const FALL_MS_START = 12000;
const FALL_MS_END = 6400;

const GRADE_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

/** 出手时方块落到哪 → 从容加成。用进度而不是秒数：下落速度每手都在变。 */
export function calmBonus(progress: number): number {
  if (progress <= 0.4) return CALM_EARLY;
  if (progress <= 0.75) return CALM_MID;
  return CALM_LATE;
}

/** 连击加成。count 是「含本次在内连了几手」。 */
export function comboBonus(count: number): number {
  return Math.min(COMBO_CAP, Math.max(0, count - 1) * COMBO_STEP);
}

/** 理论满分，给 UI 当参照 */
export const PERFECT_AGE = (() => {
  let age = START_AGE;
  for (let n = 1; n <= TOTAL_TURNS; n++) {
    age += AGE_ALIVE + AGE_CLEAR + GRADE_BONUS.A + CALM_EARLY + comboBonus(n);
  }
  return age;
})();

export { START_AGE, TOTAL_TURNS, MAX_LAYERS, HAND_SIZE };

export function costOf(card: CardRecord) {
  return {
    money: COST_POINT[card.tags.money] ?? 0,
    time: TIME_POINT[card.tags.time] ?? 0,
    will: WILL_POINT[card.tags.will] ?? 0,
  };
}

export class Engine {
  private corpus: Corpus;
  private byId = new Map<string, CardRecord>();
  private ev: EngineEvents;

  private resources: Resources = { ...START };
  private hand: CardRecord[] = [];
  private riskQueue: Risk[] = [];
  private landed: Risk[] = [];
  private cleared = 0;
  private turn = 1;
  private age = START_AGE;
  private combo = 0;
  private bestCombo = 0;
  private current: Risk | null = null;
  private token = 0;
  private over = false;

  constructor(corpus: Corpus, ev: EngineEvents) {
    this.corpus = corpus;
    this.ev = ev;
    for (const c of corpus.cards) this.byId.set(c.id, c);
  }

  /* ---------- 查询 ---------- */
  get state() {
    return {
      resources: this.resources,
      hand: this.hand,
      risk: this.current,
      landed: this.landed,
      cleared: this.cleared,
      turn: this.turn,
      age: this.age,
      combo: this.combo,
      over: this.over,
    };
  }

  canAfford(card: CardRecord): boolean {
    const c = costOf(card);
    return (
      this.resources.money >= c.money &&
      this.resources.time >= c.time &&
      this.resources.will >= c.will
    );
  }

  /** 手牌里能对上下落风险的、且付得起的卡的下标 */
  playableIndexes(): number[] {
    if (!this.current) return [];
    return this.hand
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.group === this.current!.group && this.canAfford(c))
      .map(({ i }) => i);
  }

  /* ---------- 开局 ---------- */
  start() {
    this.resources = { ...START };
    this.landed = [];
    this.cleared = 0;
    this.turn = 1;
    this.age = START_AGE;
    this.combo = 0;
    this.bestCombo = 0;
    this.over = false;
    this.riskQueue = shuffle([...RISKS]);
    this.emitResources();
    this.emitStats();
    this.nextTurn();
  }

  /* ---------- 回合 ---------- */
  private nextTurn() {
    if (this.over) return;
    this.emitStats();

    this.current = this.drawRisk();
    this.hand = this.drawHand(this.current.group);
    const matchIndex = this.hand.findIndex((c) => c.group === this.current!.group);
    this.ev.onHand(this.hand, matchIndex);

    // 下落越来越快，按总手数归一，最后几手最紧张
    const span = FALL_MS_END - FALL_MS_START;
    const p = Math.min(1, (this.turn - 1) / Math.max(1, TOTAL_TURNS - 1));
    this.ev.onRisk(this.current, FALL_MS_START + span * p, this.token);
  }

  private drawRisk(): Risk {
    if (!this.riskQueue.length) this.riskQueue = shuffle([...RISKS]);
    return this.riskQueue.pop()!;
  }

  /**
   * 发牌。保证至少有一张「域对得上、而且付得起」的卡。
   * 只保证「域对」不够：一锤定音之后，如果唯一那张域对的牌恰好付不起，
   * 玩家无论怎么点都必输一层，那不叫选择，叫坑。
   * 只有在资源真的见底、牌库里找不到付得起的同域卡时，才退而求其次。
   */
  private drawHand(group: GroupKey): CardRecord[] {
    const hand = sample(this.corpus.cards, HAND_SIZE);
    const good = (c: CardRecord) => c.group === group && this.canAfford(c);
    if (hand.some(good)) return hand;

    const affordable = this.corpus.cards.filter(good);
    const sameGroup = this.corpus.cards.filter((c) => c.group === group);
    const pool = affordable.length ? affordable : sameGroup;
    if (!pool.length) return hand;

    const pick = pool[Math.floor(Math.random() * pool.length)];
    hand[Math.floor(Math.random() * hand.length)] = pick;
    return hand;
  }

  /**
   * 风险落进井里：连击断掉，只拿「活着」的分，然后进下一手。
   * 「自然没来得及出牌」和「主动放过」都走这里。
   */
  private bankLanded(risk: Risk, by: 'pass' | 'land') {
    this.landed.push(risk);
    this.current = null;
    this.combo = 0;
    this.age += AGE_ALIVE;
    this.ev.onScore({
      alive: AGE_ALIVE,
      clear: 0,
      grade: 0,
      calm: 0,
      combo: 0,
      total: AGE_ALIVE,
      comboCount: 0,
    });
    // 通知场景把落下来的方块固化成一层的网格，
    // 否则它只是停在半空，下一块会落在同一个高度，看起来像被覆盖
    this.ev.onResolved(risk, by);
    this.emitStats();

    if (this.landed.length >= MAX_LAYERS) {
      this.finish(false, risk);
      return;
    }
    this.advance();
  }

  /** 风险落地（由场景动画回调） */
  riskLanded(token: number) {
    if (this.over || token !== this.token || !this.current) return;
    const risk = this.current;
    this.token += 1; // 作废掉这一手，防止重复落地
    this.bankLanded(risk, 'land');
  }

  /**
   * 出牌。一锤定音：点哪张就是哪张，没有第二次机会。
   *
   * 域不对、或者域对但付不起，都算选错 —— 这一手直接结束，
   * 方块砸下去堆一层，进下一手。资源不扣，因为你根本没出成这张牌。
   * 唯一例外是「牌不存在」这种程序性情况，直接忽略。
   *
   * fallProgress 是出手瞬间方块落到哪了（0~1），由场景提供，
   * 用来算「从容」加成。引擎不自己读时钟：无头环境帧率低的时候
   * 场景的动画时间会被钳制，两边会算出不一样的进度。
   */
  playCard(index: number, fallProgress = 0) {
    if (this.over || !this.current) return;
    const card = this.hand[index];
    if (!card) return;
    const risk = this.current;

    if (card.group !== risk.group) {
      this.ev.onMiss({ risk, card, index, reason: 'group' });
      return;
    }
    if (!this.canAfford(card)) {
      this.ev.onMiss({ risk, card, index, reason: 'cost' });
      return;
    }

    const cost = costOf(card);
    this.resources.money -= cost.money;
    this.resources.time -= cost.time;
    this.resources.will -= cost.will;
    this.emitResources();

    this.current = null;
    this.cleared += 1;
    this.combo += 1;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.token += 1; // 作废掉正在等待的落地回调

    const grade = gradeOf(card.grade);
    const b: ScoreBreakdown = {
      alive: AGE_ALIVE,
      clear: AGE_CLEAR,
      grade: GRADE_BONUS[grade] ?? 0,
      calm: calmBonus(fallProgress),
      combo: comboBonus(this.combo),
      total: 0,
      comboCount: this.combo,
    };
    b.total = b.alive + b.clear + b.grade + b.calm + b.combo;
    this.age += b.total;

    this.ev.onScore(b);
    this.ev.onResolved(risk, 'card');
    this.advance();
  }

  /** 主动放过：有时候省下毅力比清掉这一层更值 */
  passRisk() {
    if (this.over || !this.current) return;
    this.token += 1;
    this.bankLanded(this.current, 'pass');
  }

  private advance() {
    this.turn += 1;
    this.resources.money = Math.min(CAP.money, this.resources.money + REGEN.money);
    this.resources.time = Math.min(CAP.time, this.resources.time + REGEN.time);
    this.resources.will = Math.min(CAP.will, this.resources.will + REGEN.will);
    this.emitResources();

    if (this.turn > TOTAL_TURNS) {
      this.finish(true, null);
      return;
    }
    this.nextTurn();
  }

  /* ---------- 结算 ---------- */
  private finish(won: boolean, cause: Risk | null) {
    this.over = true;
    // 最后一手打完就直接进结算了，advance() 里那次 emitStats 不会发生，
    // 不补这一下 HUD 上的净值会停在上一手，和结算页差一个加分量
    this.emitStats();
    const last = cause ?? this.landed[this.landed.length - 1] ?? null;

    // 每条漏掉的风险，找出原书里能救你的那几条。
    // 致命的那个排最前，不然列表会看起来跟死因没关系。
    const ordered = last ? [last, ...this.landed.filter((r) => r !== last)] : [...this.landed];
    const saves: Array<{ id: string; title: string; grade: string }> = [];
    const seen = new Set<string>();
    for (const risk of ordered) {
      for (const card of this.resolveKeys(risk)) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        saves.push({ id: card.id, title: card.title, grade: gradeOf(card.grade) });
        if (saves.length >= 3) break;
      }
      if (saves.length >= 3) break;
    }

    this.ev.onGameOver({
      won,
      age: this.age,
      cause: won ? `活满 ${TOTAL_TURNS} 手` : (last?.title ?? '意外'),
      scene: won
        ? `井没有满。${TOTAL_TURNS} 手走完，这辈子算圆满。`
        : (last?.scene ?? ''),
      landed: [...this.landed],
      cleared: this.cleared,
      turns: Math.min(this.turn, TOTAL_TURNS),
      bestCombo: this.bestCombo,
      saves,
    });
  }

  resolveKeys(risk: Risk): CardRecord[] {
    const out: CardRecord[] = [];
    for (const id of risk.keys) {
      const card = this.byId.get(id);
      if (card) out.push(card);
    }
    if (!out.length) {
      const pool = this.corpus.cards
        .filter((c) => c.group === risk.group)
        .sort((a, b) => GRADE_RANK[gradeOf(a.grade)] - GRADE_RANK[gradeOf(b.grade)]);
      if (pool[0]) out.push(pool[0]);
    }
    return out;
  }

  private emitResources() {
    this.ev.onResources({ ...this.resources });
  }

  private emitStats() {
    this.ev.onStats({
      turn: this.turn,
      age: this.age,
      cleared: this.cleared,
      landed: this.landed.length,
    });
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sample<T>(arr: T[], n: number): T[] {
  const idx = shuffle(arr.map((_, i) => i)).slice(0, n);
  return idx.map((i) => arr[i]);
}

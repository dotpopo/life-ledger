import type { CardRecord, Corpus } from './types.js';
import { RISKS, type Risk } from './data/risks.js';
import { COST_POINT, TIME_POINT, WILL_POINT, gradeOf } from './data/groups.js';

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
  /** wrong = 这条讲的不是这件事；cost = 讲对了但你出不起 */
  reason: 'wrong' | 'cost';
}

/**
 * 这一手的讲解。每次结算都会给一份，UI 拿它弹讲解卡。
 * 游戏的「教学」全在这里：不管你选对还是选错，都要看到原书那条建议的完整内容。
 */
export interface Lesson {
  /** 有没有接住 */
  ok: boolean;
  /** 玩家出的那张。放过和自然落地时是 null */
  picked: CardRecord | null;
  /** 原书明确指向的那一条（也就是正确答案） */
  answer: CardRecord;
  /** 没接住的原因。wrong / cost，放过和超时是 null */
  reason: 'wrong' | 'cost' | null;
  /** 这一手是怎么结束的 */
  by: 'card' | 'pass' | 'land';
  risk: Risk;
  /** 接住了才有加分明细 */
  score: ScoreBreakdown | null;
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
  onHand: (cards: CardRecord[], answerIndex: number) => void;
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
  /** 一锤定音点错了：这一手直接结束（先让方块砸下去） */
  onMiss: (m: MissInfo) => void;
  /** 这一手结算完了，把原书那条建议讲给玩家听 */
  onLesson: (l: Lesson) => void;
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
 * 最早是 6s → 3.2s，实测根本来不及读完三张卡；先放慢到 12s → 6.4s，
 * 还是偏快，再放慢一倍到 24s → 12.8s。
 * 这游戏的难点应该在「读懂哪条建议真的管用」，不该是手速。
 */
const FALL_MS_START = 24000;
const FALL_MS_END = 12800;

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
  /** 选错的那张牌，等信息带到方块落地之后一起讲 */
  private pendingMiss: { card: CardRecord; index: number; reason: 'wrong' | 'cost' } | null = null;
  /**
   * 这一手已经结算完，但还没开下一手。
   * 讲解卡没关之前一直停在这里，否则玩家根本没机会读那几百字。
   */
  private pendingNext = false;

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
      /** 讲解卡开着的时候为 true，此时不接受出牌 */
      holding: this.pendingNext,
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

  /** 手牌里真正能接住这个风险的卡的下标 */
  playableIndexes(): number[] {
    if (!this.current) return [];
    return this.hand
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => this.current!.keys.includes(c.id) && this.canAfford(c))
      .map(({ i }) => i);
  }

  /** 这个风险的原书答案。优先用手上那张，手上没有就从语料里取。 */
  answerFor(risk: Risk): CardRecord {
    const inHand = this.hand.find((c) => risk.keys.includes(c.id));
    if (inHand) return inHand;
    return this.resolveKeys(risk)[0]!;
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
    this.current = null;
    // token 也要清。它是「这一手还算不算数」的凭据，
    // 上一局留下的回调如果碰上同一个 token，会往新的一局里塞数据。
    this.token += 1;
    this.pendingMiss = null;
    this.pendingNext = false;
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
    this.hand = this.drawHand(this.current);
    const answerIndex = this.hand.findIndex((c) => this.current!.keys.includes(c.id));
    this.ev.onHand(this.hand, answerIndex);

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
   * 发牌。三条规矩：
   * 1. 手上**一定有一张原书明确指向的那一条**。不保证答案在手，玩家就只能靠运气。
   * 2. 优先挑付得起的答案，否则会出现「答案在手上但永远出不起」的死局。
   * 3. 另外两张从**别的域**抽。跨域干扰项才能逼出「读懂再选」，
   *    同域干扰项会让玩家退回去猜分类。
   */
  private drawHand(risk: Risk): CardRecord[] {
    const answers = risk.keys
      .map((id) => this.byId.get(id))
      .filter((c): c is CardRecord => !!c);
    if (!answers.length) return sample(this.corpus.cards, HAND_SIZE);

    const affordable = answers.filter((c) => this.canAfford(c));
    const pool = affordable.length ? affordable : answers;
    const answer = pool[Math.floor(Math.random() * pool.length)];

    /*
     * 干扰项：从别的域抽，而且**排除掉所有 key**。
     * 排除 key 是必须的：有些风险的答案卡本身就在别的域
     * （比如「熬夜熬到想不开」的答案有一条在精力章），
     * 不排除的话手上会出现两张都算对的牌，玩家就没法判断了。
     */
    const keySet = new Set(risk.keys);
    const others = this.corpus.cards.filter((c) => !keySet.has(c.id) && c.group !== risk.group);
    const picks = sample(others, HAND_SIZE - 1);
    return shuffle([answer, ...picks]);
  }

  /**
   * 风险落进井里：连击断掉，只拿「活着」的分，然后进下一手。
   * 「自然没来得及出牌」「主动放过」「选错后砸下来」都走这里。
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

    const miss = this.pendingMiss;
    this.pendingMiss = null;
    this.ev.onLesson({
      ok: false,
      picked: miss ? miss.card : null,
      answer: this.answerFor(risk),
      reason: miss ? miss.reason : null,
      by: miss ? 'land' : by,
      risk,
      score: null,
    });
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
   * 判定用的是**原书明确指向的那几条**（`risk.keys`），不是「同域就行」。
   * 同域判定会让「每天补维生素」这种卡接住「高血压」，那就学不到东西了。
   * 域不对、或者付不起，都算选错：这一手直接结束，方块砸下去堆一层。
   *
   * fallProgress 是出手瞬间方块落到哪了（0~1），由场景提供，用来算「从容」加成。
   * 引擎不自己读时钟：无头环境帧率低时场景的动画会被钳制，两边会算出不一样的进度。
   */
  playCard(index: number, fallProgress = 0) {
    if (this.over || !this.current || this.pendingNext) return;
    const card = this.hand[index];
    if (!card) return;
    const risk = this.current;

    if (!risk.keys.includes(card.id)) {
      this.pendingMiss = { card, index, reason: 'wrong' };
      this.ev.onMiss({ risk, card, index, reason: 'wrong' });
      return;
    }
    if (!this.canAfford(card)) {
      this.pendingMiss = { card, index, reason: 'cost' };
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
    this.ev.onLesson({
      ok: true,
      picked: card,
      answer: card,
      reason: null,
      by: 'card',
      risk,
      score: b,
    });
    this.advance();
  }

  /** 主动放过：有时候省下毅力比清掉这一层更值 */
  passRisk() {
    if (this.over || !this.current || this.pendingNext) return;
    this.token += 1;
    this.bankLanded(this.current, 'pass');
  }

  /** 讲解看完了，开下一手 */
  resumeTurn() {
    if (this.over || !this.pendingNext) return;
    this.pendingNext = false;
    this.nextTurn();
  }

  /** 玩家自己按了结束 */
  quit() {
    if (this.over) return;
    this.token += 1;
    this.finish(false, this.current, '你按下了结束');
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
    // 停在这里等讲解卡关掉。不 hold 的话下一块方块已经在掉了，
    // 玩家还在读上一手的讲解，两头都顾不上。
    this.pendingNext = true;
  }

  /* ---------- 结算 ---------- */
  private finish(won: boolean, cause: Risk | null, causeText?: string) {
    this.over = true;
    this.pendingNext = false;
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
      cause: causeText ?? (won ? `活满 ${TOTAL_TURNS} 手` : (last?.title ?? '意外')),
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

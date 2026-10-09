/**
 * 查账：不打游戏，直接查建议。
 *
 * 设计受 Jev（System One）的格式规范影响，但跑在 classifier.dev 上：
 *   - 判断要窄、要单一：这里只问「这条能不能回答这个问题」，不问别的维度
 *   - 标签用自然语言词，并给判据（对应 Jev 的 criteria）
 *   - **必须留「都不匹配」的出口**：classifier.dev 永远会返回你给的某个标签，
 *     没有出口的话再不相干的文本也会被自信地塞进最像的那一类
 *   - 粗筛偏保守：丢掉的东西你看不见，召回比精确重要
 *
 * 两段结构：
 *   ① 本地召回（离线，毫秒级）：672 张卡 + 284 个风险，中文二元组 + IDF 打分
 *   ② Jev 复核（一次请求）：把本地前 N 条交给 classifier.dev 判相关性
 *
 * 为什么要本地那一段：
 *   - 它让结果**立刻**出现，不用等网络
 *   - classifier.dev 的匿名额度会被限流甚至直接 403（实测过
 *     `proxy_requires_payment`），没有本地兜底这个功能就整个不可用
 *   - 只把前 N 条送出去，一次请求就够，不必把 956 条全发
 */
import type { CardRecord, Corpus } from './types.js';
import type { Risk } from './data/risks.js';

export interface Doc {
  kind: 'card' | 'risk';
  id: string;
  title: string;
  /** 参与打分的正文 */
  body: string;
  card?: CardRecord;
  risk?: Risk;
}

export type Verdict = 'direct' | 'near' | 'off';

export interface Hit extends Doc {
  /** 本地相关度，永远有值 */
  score: number;
  /** Jev 判定。没跑过或跑失败时是 null */
  verdict: Verdict | null;
}

/* ============================================================
   分词：中文没有空格，用「单字 + 二元组」当词
   ============================================================ */
function tokenize(text: string): string[] {
  const s = text.toLowerCase();
  const out: string[] = [];
  // 拉丁词、数字
  for (const m of s.matchAll(/[a-z0-9][a-z0-9._+-]*/g)) out.push(m[0]);
  // 中文：单字 + 相邻二元组。
  // 单字保证「押金」这种两字词只输一半也能命中，
  // 二元组保证「押金」不会和「押运」混起来。IDF 负责压制高频单字。
  for (const seg of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < seg.length; i++) {
      out.push(seg[i]);
      if (i + 1 < seg.length) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

/* ============================================================
   索引
   ============================================================ */
export interface SearchIndex {
  docs: Doc[];
  /** 每个词出现在多少个文档里，用来算 IDF */
  df: Map<string, number>;
  /** 每个文档的词频，构建时算一次 */
  tf: Array<Map<string, number>>;
  /** 文档长度（去重后的词数），用于长度归一 */
  len: number[];
  avgLen: number;
}

/** 卡片参与检索的正文。收益那段太长，只取前 120 字，避免淹没标题和说人话 */
function cardBody(card: CardRecord): string {
  const parts = [card.plain, card.gainText.slice(0, 120), card.note.slice(0, 120)];
  return parts.filter(Boolean).join(' ');
}

export function buildIndex(corpus: Corpus, risks: Risk[]): SearchIndex {
  const docs: Doc[] = [
    ...corpus.cards.map<Doc>((c) => ({
      kind: 'card',
      id: c.id,
      title: c.title,
      body: cardBody(c),
      card: c,
    })),
    ...risks.map<Doc>((r) => ({
      kind: 'risk',
      id: r.id,
      title: r.title,
      body: r.scene,
      risk: r,
    })),
  ];

  const df = new Map<string, number>();
  const tf: Array<Map<string, number>> = [];
  const len: number[] = [];

  for (const d of docs) {
    const counts = new Map<string, number>();
    for (const t of tokenize(`${d.title} ${d.title} ${d.body}`)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    tf.push(counts);
    len.push(counts.size);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const avgLen = len.reduce((a, b) => a + b, 0) / Math.max(1, len.length);
  return { docs, df, tf, len, avgLen };
}

/* ============================================================
   本地检索：BM25 的简化版
   ============================================================ */
const K1 = 1.4;
const B = 0.5;

/** 标题命中额外加权。用户在找的就是「哪条建议」，标题最直接 */
const TITLE_BOOST = 2.6;

export function searchLocal(index: SearchIndex, query: string, limit: number): Hit[] {
  const q = query.trim();
  if (!q) return [];

  const qTokens = [...new Set(tokenize(q))];
  const N = index.docs.length;
  const hits: Hit[] = [];

  // 整串命中给一个很高的底分。用户把一条建议的原文粘进来时，
  // 分词会碎掉，但整串匹配一定是对的。
  const needle = q.toLowerCase();

  for (let i = 0; i < index.docs.length; i++) {
    const doc = index.docs[i];
    const counts = index.tf[i];
    let score = 0;

    for (const t of qTokens) {
      const f = counts.get(t);
      if (!f) continue;
      const df = index.df.get(t) ?? 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = 1 - B + (B * index.len[i]) / index.avgLen;
      score += idf * ((f * (K1 + 1)) / (f + K1 * norm));
    }

    if (score <= 0) continue;

    // 标题里命中的词再加一次权
    const titleLower = doc.title.toLowerCase();
    for (const t of qTokens) {
      if (t.length >= 2 && titleLower.includes(t)) score += (index.df.get(t) ? Math.log(1 + N / index.df.get(t)!) : 1) * TITLE_BOOST;
    }

    // 整串包含：极强信号
    if (needle.length >= 3 && (titleLower.includes(needle) || doc.body.toLowerCase().includes(needle))) {
      score += 24;
    }

    hits.push({ ...doc, score, verdict: null });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/* ============================================================
   Jev 复核：classifier.dev
   ============================================================ */
const JEV_ENDPOINT = 'https://classifier.dev';

/** 一次复核最多等这么久。超时就退回本地结果，不把界面卡在「复核中」 */
const JEV_TIMEOUT_MS = 12000;

/**
 * 标签用自然语言词，并带判据。三档里「完全无关」就是那个必须留的出口。
 * 注意 classifier.dev 的 confidence 现在常常是 null（后端模型换过），
 * 所以这里只用 label 做判断，不依赖置信度阈值。
 */
const LABELS: Record<Verdict, string> = {
  direct: '直接回答了这个问题',
  near: '沾边但不直接',
  off: '完全无关',
};
const LABEL_LIST = [LABELS.direct, LABELS.near, LABELS.off];

export interface JevResult {
  ok: boolean;
  /**
   * 与传入顺序一一对应。
   * **失败时全是 null，不是某个兜底标签**：界面靠它区分
   * 「Jev 说沾边」和「Jev 压根没跑」。混成一个值就是在对用户说谎。
   */
  verdicts: Array<Verdict | null>;
  model: string;
  ms: number;
  /** 失败原因，给 UI 显示 */
  error?: string;
}

/** 送出去之前把正文压短。批次越大越慢，而且这里只要语义指纹 */
function compact(doc: Doc): string {
  return `${doc.title}｜${doc.body}`.replace(/\s+/g, ' ').slice(0, 260);
}

export async function jevCheck(
  query: string,
  docs: Doc[],
  signal?: AbortSignal
): Promise<JevResult> {
  const t0 = performance.now();
  if (!docs.length) return { ok: true, verdicts: [], model: '', ms: 0 };

  /*
   * 一定要有超时。classifier.dev 有时候不返回也不断开，
   * 不设上限的话界面会永远停在「正在让 Jev 复核…」。
   */
  const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const body = {
    labels: LABEL_LIST,
    inputs: docs.map(compact),
    instructions:
      `用户的问题是：「${query}」。逐条判断它能不能回答这个问题。\n` +
      `「${LABELS.direct}」：这条给出了针对这个问题的具体做法，看完就知道该干什么。\n` +
      `「${LABELS.near}」：属于同一个大类，但没有正面回答这个问题。\n` +
      `「${LABELS.off}」：跟这个问题没有关系。\n` +
      `拿不准时选「${LABELS.near}」，不要硬判成「${LABELS.direct}」。`,
  };

  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 明确要求不要拿用户的查询去训练。会触发预检，实测 204 通过
        'X-Classifier-Share-Data': 'false',
      },
      body: JSON.stringify(body),
      signal: both,
    });
    const ms = performance.now() - t0;
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string; code?: string };
        if (j.code) detail += ` ${j.code}`;
        if (j.error) detail += `：${j.error}`;
      } catch {
        /* 响应体不是 JSON 就用状态码 */
      }
      return { ok: false, verdicts: docs.map(() => null), model: '', ms, error: detail };
    }
    const json = (await res.json()) as {
      model?: string;
      results?: Array<{ label?: string }>;
    };
    const byLabel: Record<string, Verdict> = {
      [LABELS.direct]: 'direct',
      [LABELS.near]: 'near',
      [LABELS.off]: 'off',
    };
    const verdicts = (json.results ?? []).map((r) => byLabel[r.label ?? ''] ?? 'near');
    // 条数对不上就当作没判过，宁可退回本地结果
    if (verdicts.length !== docs.length) {
      return { ok: false, verdicts: docs.map(() => null), model: json.model ?? '', ms, error: '返回条数与请求不符' };
    }
    return { ok: true, verdicts, model: json.model ?? '', ms };
  } catch (e) {
    const ms = performance.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = signal?.aborted
      ? '已取消'
      : /time(d)?\s*out|timeout/i.test(msg)
        ? '请求超时'
        : msg;
    return { ok: false, verdicts: docs.map(() => null), model: '', ms, error: friendly };
  }
}

/* ============================================================
   合成：Jev 的判定怎么落到排序上
   ============================================================ */
const VERDICT_RANK: Record<Verdict, number> = { direct: 0, near: 1, off: 2 };

/**
 * 排序规则：
 *   1. Jev 说「直接回答了」的排最前
 *   2. 其次「沾边」，最后是 Jev 没看过或说「无关」的
 *   3. 同档内按本地分
 * Jev 说「无关」的不会被删掉，只沉到最后：用户能看见我们判断的边界，
 * 而且一旦 Jev 判错，正确答案不会凭空消失。
 */
export function mergeHits(hits: Hit[]): Hit[] {
  return [...hits].sort((a, b) => {
    const ra = a.verdict ? VERDICT_RANK[a.verdict] : 1.5;
    const rb = b.verdict ? VERDICT_RANK[b.verdict] : 1.5;
    if (ra !== rb) return ra - rb;
    return b.score - a.score;
  });
}

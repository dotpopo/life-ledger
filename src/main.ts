import './style.css';
import { WellScene } from './scene/WellScene.js';
import {
  Engine,
  MAX_LAYERS,
  PERFECT_AGE,
  TOTAL_TURNS,
  costOf,
  type Lesson,
  type Resources,
  type ScoreBreakdown,
  type Summary,
} from './engine.js';
import type { CardRecord, Corpus } from './types.js';
import { GROUPS, GRADE_META, gradeOf } from './data/groups.js';
import { RISKS } from './data/risks.js';
import {
  buildIndex,
  jevCheck,
  mergeHits,
  searchLocal,
  type Hit,
  type SearchIndex,
} from './search.js';
import { makeShareCard } from './scene/textures.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- DOM ---------- */
const canvas = $<HTMLCanvasElement>('stage');
const hudAge = $('hud-age');
const hudTurn = $('hud-turn');
const hudCleared = $('hud-cleared');
const hudLayers = $('hud-layers');

const resMoney = $('res-money');
const resTime = $('res-time');
const resWill = $('res-will');
const resMoneyV = $('res-money-v');
const resTimeV = $('res-time-v');
const resWillV = $('res-will-v');

const riskEl = $('risk');
const riskGroup = $('risk-group');
const riskTitle = $('risk-title');
const riskScene = $('risk-scene');
const riskHint = $('risk-hint');

const previewEl = $('preview');
const pvId = $('pv-id');
const pvPos = $('pv-pos');
const pvDots = $('pv-dots');
const pvTitle = $('pv-title');
const pvPlain = $('pv-plain');
const pvMeta = $('pv-meta');
const pvSrc = $('pv-src');
const pvBody = $('pv-body');
const pvPlay = $<HTMLButtonElement>('pv-play');

const toastEl = $('toast');
const settleEl = $('settle');
const helpEl = $('help');
const passBtn = $<HTMLButtonElement>('pass-btn');

const lessonEl = $('lesson');
const lessonVerdict = $('lesson-verdict');
const lessonBody = $('lesson-body');
const lessonNext = $<HTMLButtonElement>('lesson-next');
const pausedEl = $('paused');
const pauseBtn = $<HTMLButtonElement>('pause-btn');
const resumeBtn = $<HTMLButtonElement>('resume-btn');

const lookupEl = $('lookup');
const startEl = $('start');
const lkForm = $<HTMLFormElement>('lk-form');
const lkInput = $<HTMLInputElement>('lk-input');
const lkStatus = $('lk-status');
const lkResults = $('lk-results');
const lkExamples = $('lk-examples');

/* ---------- 启动屏 ---------- */
const bootEl = document.getElementById('boot');
const bootStatus = bootEl?.querySelector<HTMLElement>('.boot-status') ?? null;
const bootBar = bootEl?.querySelector<HTMLElement>('.boot-bar i') ?? null;
const bootStart = performance.now();

function setBoot(pct: number, text: string) {
  if (bootBar) bootBar.style.inlineSize = `${pct}%`;
  if (bootStatus) bootStatus.textContent = text;
}

/** 关掉启动屏。留一个最短展示时间，否则网络快的时候会一闪而过，看着像闪屏。 */
async function hideBoot() {
  if (!bootEl) return;
  setBoot(100, '就绪');
  const elapsed = performance.now() - bootStart;
  const wait = Math.max(0, 520 - elapsed);
  await new Promise((r) => setTimeout(r, wait));
  bootEl.classList.add('is-gone');
  window.setTimeout(() => bootEl.remove(), 620);
}

/** 启动失败时不要把整个 body 换掉，那样连启动屏都没了，只剩一行裸文本 */
function failBoot(err: unknown) {
  if (!bootEl) return;
  const ring = bootEl.querySelector('.boot-ring');
  ring?.remove();
  const bar = bootEl.querySelector('.boot-bar');
  bar?.remove();
  if (bootStatus) bootStatus.textContent = '启动失败';
  const pre = document.createElement('p');
  pre.className = 'boot-error';
  pre.textContent = String(err instanceof Error ? err.message : err);
  bootEl.appendChild(pre);
}

let scene: WellScene;
let engine: Engine;
let corpus: Corpus;
let toastTimer = 0;
let scorePopTimer = 0;
let lastSummary: Summary | null = null;
/** 出牌入口被触发过几次。长按预览绝不该让它增加。 */
let pickCount = 0;
const pickLog: string[] = [];

const RES_CAP: Resources = { money: 12, time: 10, will: 8 };

/* ============================================================
   启动
   ============================================================ */
async function main() {
  setBoot(12, '正在拉取 672 条法则');
  const res = await fetch('/cards.json');
  if (!res.ok) throw new Error(`语料拉取失败：HTTP ${res.status}`);
  corpus = (await res.json()) as Corpus;

  setBoot(52, '正在解析语料');
  await new Promise((r) => setTimeout(r, 0));

  // 建检索索引：672 张卡 + 284 个风险。实测 130ms 左右，放启动期做掉
  setBoot(58, '正在建检索索引');
  searchIndex = buildIndex(corpus, RISKS);
  for (const c of corpus.cards) cardById.set(c.id, c);
  for (const ex of EXAMPLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lk-ex';
    btn.textContent = ex;
    btn.addEventListener('click', () => {
      lkInput.value = ex;
      void runLookup(ex);
    });
    lkExamples.append(btn);
  }

  // 字体就绪后再画贴图，否则 Canvas 上量出来的字宽是错的，排版会歪
  if (document.fonts?.ready) await document.fonts.ready;

  setBoot(72, '正在生成 672 张卡面');
  scene = new WellScene(canvas, {
    onCardHover: handleCardHover,
  });
  scene.start();

  setBoot(88, '正在展开井');
  engine = new Engine(corpus, {
    onHand: (cards) => {
      scene.setHand(cards);
      // 换了一手牌，预览里那张可能已经不在手上了
      closePreview();
    },
    onRisk: (risk, fallMs, token) => {
      // 域标签只留文字，不刷该域的颜色。刷了颜色，再让卡面也刷同一个色，
      // 玩家一眼配对就完了，根本不会去读内容。
      riskGroup.textContent = risk.group;
      riskTitle.textContent = risk.title;
      // 情境必须给。只有「车祸」两个字，玩家不知道这是个什么问题。
      riskScene.textContent = risk.scene;
      riskHint.textContent = '读三张卡，挑出真能接住它的那条';
      riskEl.classList.add('is-on');
      scene.spawnRisk(risk, fallMs, () => engine.riskLanded(token));
    },
    onResolved: (risk, by) => {
      riskEl.classList.remove('is-on');
      if (by === 'card') scene.clearRisk(risk);
      else scene.settleFalling(risk);
    },
    /*
     * 一锤定音选错了：这一手直接结束。
     * 这里只说一句「为什么」，让方块砸下去；
     * 完整的讲解等方块落地后由 onLesson 给。
     */
    onMiss: (m) => {
      scene.rejectCard(m.index);
      toast(m.reason === 'wrong' ? '这条讲的不是这件事' : '这张你出不起');
      scene.slamRisk();
    },
    onScore: showScore,
    onResources: renderResources,
    onStats: (s) => {
      hudAge.textContent = String(s.age);
      hudTurn.textContent = String(Math.min(s.turn, TOTAL_TURNS));
      hudCleared.textContent = String(s.cleared);
      hudLayers.textContent = String(s.landed);
      scene.setDanger(s.landed / MAX_LAYERS);
    },
    onLesson: showLesson,
    onGameOver: (summary) => {
      lastSummary = summary;
      riskEl.classList.remove('is-on');
      closePreview();
      hideLesson();
      setPaused(false);
      showSettlement(summary);
    },
  });

  // HUD 里的分母和初始值都从常量来，别在 HTML 里写死，否则改了参数就对不上
  const turnMax = document.getElementById('hud-turn-max');
  if (turnMax) turnMax.textContent = `/${TOTAL_TURNS}`;
  const layerMax = document.getElementById('hud-layer-max');
  if (layerMax) layerMax.textContent = `/${MAX_LAYERS}`;
  const helpPerfect = document.getElementById('help-perfect');
  if (helpPerfect) helpPerfect.textContent = String(PERFECT_AGE);
  hudAge.textContent = String(engine.state.age);
  hudTurn.textContent = String(engine.state.turn);

  bindEvents();
  // 先给入口，让用户自己选模式
  document.body.classList.add('is-starting');
  startEl.hidden = false;

  // 自动化验证用的钩子
  (window as unknown as Record<string, unknown>).__game = {
    scene,
    engine,
    positions: () => scene.cardScreenPositions(),
    playable: () => {
      const idx = engine.playableIndexes();
      const pos = scene.cardScreenPositions();
      return idx.length ? { index: idx[0], pos: pos[idx[0]] } : { index: -1, pos: null };
    },
    state: () => engine.state,
    bootDone: () => !document.getElementById('boot'),
    picks: () => ({ count: pickCount, log: [...pickLog] }),
    perfectAge: PERFECT_AGE,
    /** 风险池。给验证脚本查题库大小、挑最长标题用 */
    risks: RISKS,
    /** 验证计分公式用：绕过点击直接出牌，进度可控 */
    play: (index: number, progress = 0) => engine.playCard(index, progress),
  };

  setBoot(96, '就绪');
  await hideBoot();

  // 支持 ?q=... 直接把查询带进来，这样一次检索可以当链接分享
  const shared = new URLSearchParams(location.search).get('q');
  if (shared && shared.trim()) openLookup(shared.trim());
}

/* ============================================================
   交互
   ============================================================ */
function handleCardPick(index: number, from = 'unknown') {
  pickCount += 1;
  pickLog.push(`${from}#${index}`);
  if (pickLog.length > 20) pickLog.shift();
  const st = engine.state;
  if (st.over || !st.risk) return;
  if (!st.hand[index]) return;

  /*
   * 一锤定音：前端不再预判对错，直接交给引擎。
   * 前端预判会泄题（它得先知道哪张对），也会变成两套判断标准。
   * 出手瞬间的方块进度一起带上，引擎用它算「从容」加成。
   */
  scene.playCard(index);
  engine.playCard(index, scene.fallProgress());
}

/* ============================================================
   预览：一层 HUD，不是面板
   ------------------------------------------------------------
   之前是把三张牌的全部内容一次列出来，问题是内容太多，
   三张同时看根本看不清。改成一次只看一张，左右滑动切换。
   面板压得极透、只做轻模糊，所以看字的同时还能看见
   手牌和正在下落的方块，是「透过 HUD 看现实」而不是「弹窗挡住游戏」。
   ============================================================ */
let pvIndex = 0;
let pvOpen = false;
/** 滑动或按键切换过之后固定住，不再跟随鼠标悬停 */
let pvPinned = false;
/** 指针当前是否停在预览面板上 */
let pvHovering = false;
let pvCloseTimer = 0;

function openPreview(index: number, pin = false) {
  const hand = engine.state.hand;
  if (!hand.length) return;
  pvIndex = ((index % hand.length) + hand.length) % hand.length;
  if (pin) pvPinned = true;
  const wasOpen = pvOpen;
  pvOpen = true;
  previewEl.hidden = false;
  if (!wasOpen) {
    // 淡入：先摘掉 is-shown 再加回来，才有过渡。已经开着就别重放，否则会闪。
    previewEl.classList.remove('is-shown');
    requestAnimationFrame(() => previewEl.classList.add('is-shown'));
  } else {
    previewEl.classList.add('is-shown');
  }
  /*
   * 进预览时相机退远，整口井进画面，方便一边读字一边盯方块下落。
   * 但只在「固定」的时候退。
   * 悬停是一眼就走的临时预览，相机一退手牌会被推出屏幕
   * （实测 y 从 794 掉到 1045，而视口只有 900），
   * 结果鼠标底下那张牌消失了，你反而没法直接点它出牌。
   */
  if (pin) scene.setFraming('preview');
  renderPreview();
}

function closePreview() {
  if (!pvOpen) return;
  pvOpen = false;
  pvPinned = false;
  previewEl.classList.remove('is-shown');
  previewEl.hidden = true;
  scene.setFraming('play');
}

function stepPreview(delta: number) {
  if (!pvOpen) return;
  const n = engine.state.hand.length;
  if (n < 2) return;
  /*
   * 内容从侧面滑进来，像相册翻页。
   * 用百分比（相对自身宽度）而不是固定像素，宽窄屏的观感才一致；
   * 正数 = 下一张，从右边进来；负数 = 上一张，从左边进来。
   * openPreview 里对下标取了模，所以第一张往前翻会绕到最后一张。
   */
  pvBody.style.setProperty('--pv-dx', delta > 0 ? '52%' : '-52%');
  openPreview(pvIndex + delta, true);
  pvBody.classList.remove('is-swap');
  void pvBody.offsetWidth;
  pvBody.classList.add('is-swap');
}

function renderPreview() {
  const hand = engine.state.hand;
  const card = hand[pvIndex];
  if (!card) {
    closePreview();
    return;
  }
  const grade = gradeOf(card.grade);
  const cost = costOf(card);

  // 这里不再显示「域」。牌面给分类线索，玩家就会去配对分类，不去读内容。
  pvId.textContent = `${card.chapter} 章 · ${card.num} 条`;
  pvPos.textContent = `${pvIndex + 1}/${hand.length}`;
  pvTitle.textContent = card.title;
  pvPlain.textContent = card.plain || card.costText || '';
  pvMeta.textContent =
    `成本 钱${cost.money} 时间${cost.time} 毅力${cost.will}` +
    `　收益 ${card.tags.gain}（${card.tags.lens}）　证据 ${grade}`;

  const src = card.sources[0];
  pvSrc.textContent = src ? `来源：${src.text}` : '';

  // 页码点。张数变了才重建，否则每次翻页都重建一遍 DOM 会闪一下。
  if (pvDots.childElementCount !== hand.length) {
    pvDots.replaceChildren(
      ...hand.map(() => {
        const dot = document.createElement('i');
        dot.className = 'pv-dot';
        return dot;
      })
    );
  }
  Array.from(pvDots.children).forEach((dot, i) => {
    dot.classList.toggle('is-on', i === pvIndex);
  });

  /*
   * 一键出牌。三张牌的按钮必须长得一模一样。
   * 之前这里会按「对不上，要『X』」/「资源不够」给出不同文案，
   * 等于替玩家把答案挑出来了：翻一眼就知道该出哪张，游戏就没得玩。
   * 现在只区分「还有风险要处理」和「这一手已经过了」，
   * 判断交给玩家；选错了由引擎给提示（toast），那是反馈，不是提前泄题。
   */
  const risk = engine.state.risk;
  pvPlay.disabled = !risk;
  pvPlay.textContent = risk ? '出这张牌' : '这一手已经过了';
}

/**
 * 悬停：电脑上鼠标停在卡片上就出预览。
 * 关闭要延迟一下：从卡片移到预览面板上的按钮，中途必然经过画布，
 * 那一刻鼠标底下没有卡片，如果立刻关，按钮就永远点不到了。
 */
function handleCardHover(index: number | null) {
  if (index === null) {
    if (pvPinned || pvHovering) return;
    window.clearTimeout(pvCloseTimer);
    pvCloseTimer = window.setTimeout(() => {
      if (!pvHovering && !pvPinned) closePreview();
    }, 260);
    return;
  }
  window.clearTimeout(pvCloseTimer);
  if (!pvPinned) openPreview(index, false);
}
/* ============================================================
   交互绑定
   ============================================================ */
function bindEvents() {
  passBtn.addEventListener('click', () => engine.passRisk());

  /* ---------- 画布上：点按出牌，长按看详情 ---------- */
  const LONG_PRESS_MS = 420;
  let pressTimer = 0;
  let downX = 0;
  let downY = 0;
  let downTime = 0;
  let downMoved = false;
  let longPressed = false;

  const buzz = () =>
    (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(12);

  canvas.addEventListener('pointerdown', (e) => {
    /*
     * 每次按下都先清掉上一次长按留下的抑制标记，而且必须清在
     * `idx === null` 的提前 return 之前。
     * 原来这行写在 return 后面，于是「长按看过详情 → 点空白处」这第一下
     * 会被当成上一次长按的尾音吞掉，表现就是预览关不掉。
     */
    longPressed = false;
    window.clearTimeout(pressTimer);
    pressTimer = 0;

    const idx = scene.pickCardAt(e.clientX, e.clientY);
    if (idx === null) return;
    downX = e.clientX;
    downY = e.clientY;
    downTime = performance.now();
    downMoved = false;
    // 手机上只有长按能看到详情，因为触摸设备根本没有 hover：
    // 点一下就直接进 pointerdown 出牌了，中间没有「停一下看看」的机会。
    pressTimer = window.setTimeout(() => {
      longPressed = true;
      openPreview(idx, true);
      buzz();
    }, LONG_PRESS_MS);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pressTimer) return;
    // 手指滑动超过 10px 就不算长按了
    if (Math.abs(e.clientX - downX) > 10 || Math.abs(e.clientY - downY) > 10) {
      downMoved = true;
      window.clearTimeout(pressTimer);
      pressTimer = 0;
    }
  });

  const endPress = (e: PointerEvent) => {
    const held = performance.now() - downTime;
    window.clearTimeout(pressTimer);
    pressTimer = 0;
    /*
     * 定时器不能作为唯一判据。
     * 低端机（以及无头环境下的软件渲染）主线程很忙时，420ms 的定时器
     * 会被拖到松手之后才轮到执行，而松手这里又把定时器清掉了，
     * 结果长按整个失效、直接变成出牌。
     * 所以松手时按「实际按住了多久」再兜一次。
     */
    if (!downMoved && !longPressed && held >= LONG_PRESS_MS) {
      const idx = scene.pickCardAt(e.clientX, e.clientY);
      if (idx !== null) {
        longPressed = true;
        openPreview(idx, true);
        buzz();
      }
    }
  };
  canvas.addEventListener('pointerup', endPress);
  canvas.addEventListener('pointercancel', endPress);

  canvas.addEventListener('click', (e) => {
    // 长按那一次不能当成点击，否则一松手就把牌打出去了
    if (longPressed) {
      longPressed = false;
      return;
    }
    const idx = scene.pickCardAt(e.clientX, e.clientY);
    if (idx !== null) {
      handleCardPick(idx, 'canvas-click');
      return;
    }
    // 点空白处收掉预览
    if (pvOpen) closePreview();
  });

  /* ---------- 预览：按钮、左右滑动、键盘 ---------- */
  $('pv-prev').addEventListener('click', () => stepPreview(-1));
  $('pv-next').addEventListener('click', () => stepPreview(1));
  $('pv-close').addEventListener('click', closePreview);
  pvPlay.addEventListener('click', () => {
    if (!pvOpen) return;
    handleCardPick(pvIndex, 'preview-play');
  });

  let swX = 0;
  let swY = 0;
  let swiping = false;
  let swId = -1;
  previewEl.addEventListener('pointerenter', () => {
    pvHovering = true;
    window.clearTimeout(pvCloseTimer);
  });
  previewEl.addEventListener('pointerleave', () => {
    pvHovering = false;
    if (pvPinned) return;
    // 同样延迟：从面板移回卡片时，先关再开会闪一下
    window.clearTimeout(pvCloseTimer);
    pvCloseTimer = window.setTimeout(() => {
      if (!pvHovering && !pvPinned) closePreview();
    }, 260);
  });
  previewEl.addEventListener('pointerdown', (e) => {
    swiping = true;
    swId = e.pointerId;
    swX = e.clientX;
    swY = e.clientY;
  });
  /*
   * 滑动的收尾挂在 window 上，不挂在面板上。
   * 横滑时手指很容易滑出面板边界，挂在面板上的话那一刻之后就收不到
   * pointerup 了，整段滑动等于白滑。这是手机上「滑不动」的第二个来源。
   */
  window.addEventListener('pointerup', (e) => {
    if (!swiping || e.pointerId !== swId) return;
    swiping = false;
    swId = -1;
    const dx = e.clientX - swX;
    const dy = e.clientY - swY;
    // 横向位移要明显大于纵向，否则会跟面板内的纵向滚动打架
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      stepPreview(dx < 0 ? 1 : -1);
      return;
    }
    /*
     * 没怎么动 = 点了一下。面板是半透明的，用户眼里它盖住的那块也是「空白」，
     * 所以点在非控件的地方要退出预览，否则点空白没反应。
     * 落在按钮上的交给按钮自己处理（✕ 关闭、‹ › 翻页、出这张牌）。
     */
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      if (!(e.target as HTMLElement).closest('button')) closePreview();
    }
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerId === swId) {
      swiping = false;
      swId = -1;
    }
  });

  /*
   * 点空白退出预览：统一在 document 上收口。
   * 面板是半透明的，用户眼里「它盖住的地方」和「它没盖住的背景」都是空白，
   * 但顶栏、资源栏、风险提示条这些都压在画布上面，会把点击吃掉、
   * 传不到 canvas 的 click 上，于是预览关不掉（用户报的「有的时候不会消失」）。
   * 只要不是点在预览面板里、也不是点在按钮之类的控件上，就退出。
   * 面板内部不在这里关，因为它要区分「点一下」和「左右滑动翻页」。
   */
  document.addEventListener('pointerdown', (e) => {
    if (!pvOpen) return;
    const t = e.target as HTMLElement;
    if (t.closest('#preview')) return;
    if (t.closest('button, a, [role="button"]')) return;
    closePreview();
  });

  $('help-btn').addEventListener('click', () => {
    helpEl.hidden = false;
  });
  $('help-close').addEventListener('click', () => {
    helpEl.hidden = true;
    // 上一局已经结束了，这里点「开始」应该直接开新局。
    // 以前是 return 掉，玩家点完什么都没发生，看着像卡住。
    if (engine.state.over) {
      restart();
      return;
    }
    if (engine.state.turn === 1 && !engine.state.risk) engine.start();
  });

  // 暂停 / 继续
  pauseBtn.addEventListener('click', () => setPaused(!scene.isPaused));
  resumeBtn.addEventListener('click', () => setPaused(false));

  // 讲解读完开下一手
  lessonNext.addEventListener('click', continueAfterLesson);

  // 主动结束这一局。讲解卡是遮罩，会把顶栏和左下角按钮全挡住，
  // 所以讲解卡里也得有一个出口，两处走同一段逻辑。
  const quitRun = () => {
    hideLesson();
    setPaused(false);
    engine.quit();
  };
  $('quit-btn').addEventListener('click', quitRun);
  $('lesson-quit').addEventListener('click', quitRun);

  $('again-btn').addEventListener('click', restart);

  $('share-btn').addEventListener('click', () => {
    if (!lastSummary) return;
    const cv = buildShareCanvas(lastSummary);
    const a = document.createElement('a');
    a.download = `井-净值${lastSummary.age}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    toast('已存下这张图');
  });

  // 模式切换：右上角的常驻切换器 + 入口的两张卡
  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes .mode-btn, #start .start-card')) {
    b.addEventListener('click', () => setMode((b.dataset.mode as Mode) ?? 'game'));
  }
  lkForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void runLookup(lkInput.value);
  });

  document.addEventListener('keydown', (e) => {
    // 在输入框里打字时不劫持按键，否则在查账框里打不出「/」
    const t = e.target as HTMLElement | null;
    const typing =
      !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    if (e.key === 'Escape') {
      // 入口上必须选一个模式，Esc 不生效
      if (!startEl.hidden) return;
      // 从最上层往下关：以身入局 → 预览 → 规则
      if (mode === 'lookup' && !lookupEl.hidden) setMode('game');
      else if (pvOpen) closePreview();
      else helpEl.hidden = true;
      return;
    }
    if (typing) return;
    if (!startEl.hidden) return;
    if (e.key === '/') {
      e.preventDefault();
      openLookup();
      return;
    }
    // 讲解卡开着的时候，回车 = 继续。故意不绑 Esc，
    // 免得手快把讲解一路按掉，那就白做了。
    if (!lessonEl.hidden && e.key === 'Enter') {
      e.preventDefault();
      continueAfterLesson();
      return;
    }
    // 暂停。放在 help/settle 的拦截之前，任何时候都能按。
    if (e.key === 'p' || e.key === 'P') {
      setPaused(!scene.isPaused);
      return;
    }
    if (!helpEl.hidden || !settleEl.hidden) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepPreview(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepPreview(1);
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      engine.passRisk();
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 3) handleCardPick(n - 1, 'key');
  });
}

function renderResources(res: Resources) {
  const set = (bar: HTMLElement, value: HTMLElement, v: number, cap: number) => {
    bar.style.inlineSize = `${Math.round((v / cap) * 100)}%`;
    value.textContent = String(v);
  };
  set(resMoney, resMoneyV, res.money, RES_CAP.money);
  set(resTime, resTimeV, res.time, RES_CAP.time);
  set(resWill, resWillV, res.will, RES_CAP.will);
}

function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('is-on'), 2600);
}

/* ============================================================
   加分：HUD 上浮一个 +N，顺便把这一手的构成摊开
   ------------------------------------------------------------
   玩家不用自己算，但要看得见数字是怎么来的，
   否则「+42」和「+8」在他眼里没区别，连击和从容就白设计了。
   ============================================================ */
function showScore(s: ScoreBreakdown) {
  const pop = document.getElementById('score-pop');
  if (!pop) return;

  const parts = [`活过 +${s.alive}`];
  if (s.clear) parts.push(`打掉 +${s.clear}`);
  if (s.grade) parts.push(`证据 +${s.grade}`);
  if (s.calm) parts.push(`从容 +${s.calm}`);
  if (s.combo) parts.push(`连击×${s.comboCount} +${s.combo}`);

  const big = document.createElement('b');
  big.textContent = `+${s.total}`;
  const small = document.createElement('span');
  small.textContent = parts.join(' · ');
  pop.replaceChildren(big, small);

  // 重放动画：先摘掉再加回来，否则连续两次同分不会重新播
  pop.classList.remove('is-on');
  void pop.offsetWidth;
  pop.classList.add('is-on');
  window.clearTimeout(scorePopTimer);
  scorePopTimer = window.setTimeout(() => pop.classList.remove('is-on'), 1700);
}

/* ============================================================
   讲解卡
   ------------------------------------------------------------
   这是整个游戏真正「教」的地方。每次决策之后都必须把原书那条建议
   讲完：说人话、收益、证据、来源。读完点「继续」才开下一手，
   不这么做的话玩家会一路点过去，什么也记不住。
   ============================================================ */
function lessonRow(k: string, v: string, bad = false) {
  const p = document.createElement('p');
  p.className = 'lesson-row';
  const kk = document.createElement('span');
  kk.className = 'lesson-k';
  kk.textContent = k;
  const vv = document.createElement('span');
  vv.className = bad ? 'lesson-v is-bad' : 'lesson-v';
  vv.textContent = v;
  p.append(kk, vv);
  return p;
}

function lessonCard(card: CardRecord, kicker: string, compact = false) {
  const wrap = document.createElement('div');
  const k = document.createElement('p');
  k.className = 'lesson-kicker';
  k.textContent = kicker;
  const t = document.createElement('h3');
  t.className = 'lesson-title';
  t.textContent = card.title;
  wrap.append(k, t);
  if (card.plain) wrap.append(lessonRow('说人话', card.plain));
  // 选错的那张只留「说人话」。它只是用来对照的，
  // 把收益和备注也铺开会把真正该读的答案挤出屏幕。
  if (!compact) {
    if (card.gainText) wrap.append(lessonRow('收益', card.gainText));
    if (card.note) wrap.append(lessonRow('备注', card.note));
  }
  return wrap;
}

function showLesson(l: Lesson) {
  lessonVerdict.textContent = l.ok
    ? '接住了'
    : l.by === 'pass'
      ? '你放过了它'
      : '这一手没接住';
  lessonVerdict.className = `lesson-verdict ${l.ok ? 'is-ok' : 'is-bad'}`;

  const parts: Node[] = [];

  // 先把问题复述一遍，不然读完讲解已经忘了刚才在防什么
  const riskBox = document.createElement('div');
  riskBox.className = 'lesson-risk';
  const rb = document.createElement('b');
  rb.textContent = l.risk.title;
  const rs = document.createElement('span');
  rs.textContent = l.risk.scene;
  riskBox.append(rb, rs);
  parts.push(riskBox);

  // 选错了就先说你选的那条讲的是别的事，再亮正确答案
  if (!l.ok && l.picked) {
    parts.push(
      lessonCard(
        l.picked,
        l.reason === 'cost' ? '你出的这张（讲对了，但你出不起）' : '你出的这张',
        true
      )
    );
    const hr = document.createElement('hr');
    hr.className = 'lesson-hr';
    parts.push(hr);
  }

  parts.push(lessonCard(l.answer, l.ok ? '原书里接住它的就是这条' : '原书里能接住它的是这条'));

  const src = l.answer.sources?.[0];
  const foot = document.createElement('p');
  foot.className = 'lesson-src';
  foot.textContent =
    `证据 ${gradeOf(l.answer.grade)} · ${l.answer.chapterTitle}（${l.answer.chapter}-${l.answer.num}）` +
    (src ? `\n来源：${src.text}` : '');
  parts.push(foot);

  lessonBody.replaceChildren(...parts);
  lessonEl.hidden = false;
  /*
   * 一定要 preventScroll，并且把面板滚回顶部。
   * 默认的 focus() 会把焦点按钮滚进视口，而按钮在面板最底下，
   * 结果玩家一睁眼看到的是讲解的结尾，前面全被滚过去了。
   */
  const inner = lessonEl.querySelector<HTMLElement>('.lesson-inner');
  if (inner) inner.scrollTop = 0;
  lessonNext.focus({ preventScroll: true });
}

function hideLesson() {
  lessonEl.hidden = true;
}

/** 讲解读完，开下一手 */
function continueAfterLesson() {
  hideLesson();
  engine.resumeTurn();
}

/* ============================================================
   暂停 / 开新局
   ============================================================ */
function setPaused(v: boolean) {
  scene.setPaused(v);
  pausedEl.hidden = !v;
  pauseBtn.textContent = v ? '继续' : '暂停';
  if (v) resumeBtn.focus();
}

/**
 * 开新局。所有开局入口都走这里，保证「每次开局都清一遍旧数据」：
 * 井里的层、正在下落的方块、碎片、暂停状态、讲解卡，一个都不留。
 * 以前「开始」按钮是直接调 engine.start() 的，绕过 scene.reset()，
 * 上一局的方块会留在场上。
 */
function restart() {
  closePreview();
  hideLesson();
  setPaused(false);
  scene.reset();
  settleEl.hidden = true;
  engine.start();
}

/* ============================================================
   查账：不打游戏，直接查建议
   ------------------------------------------------------------
   两段检索：
     ① 本地（离线，毫秒级）：672 张卡 + 284 个风险，中文二元组 + IDF
     ② Jev 复核（classifier.dev 一次请求）：把本地前 50 条交给它判相关性
   本地那一段是必须的：它让结果立刻出现，而且在 Jev 不可用时
   （实测会 403 proxy_requires_payment）整个功能还能用。
   ============================================================ */
const LOOKUP_LOCAL = 60;
/** 送去复核的条数。50 条约 6KB，一次请求；classifier.dev 每分钟 3000 次分类，够用 */
const LOOKUP_BATCH = 50;
const LOOKUP_SHOW = 8;

let searchIndex: SearchIndex | null = null;
let lookupAbort: AbortController | null = null;
const lookupCache = new Map<string, { hits: Hit[]; note: string }>();

const EXAMPLES = [
  '房东不退我押金',
  '孩子一年近视涨了一百度',
  '公司欠我加班费不给',
  '吃了头孢之后喝了酒',
  '被狗咬破了皮',
  '手机丢了怎么办',
];

const cardById = new Map<string, CardRecord>();

function lookupBadge(hit: Hit): { text: string; cls: string } {
  if (hit.kind === 'risk') return { text: '你可能遇到的是', cls: 'is-risk' };
  if (hit.verdict === 'direct') return { text: 'Jev 确认：直接回答了', cls: 'is-direct' };
  if (hit.verdict === 'near') return { text: 'Jev：沾边', cls: '' };
  if (hit.verdict === 'off') return { text: 'Jev：无关', cls: '' };
  return { text: '本地匹配', cls: '' };
}

function lookupHitEl(hit: Hit): HTMLElement {
  const el = document.createElement('article');
  el.className = 'lk-hit';
  if (hit.verdict === 'direct') el.classList.add('is-direct');
  if (hit.kind === 'risk') el.classList.add('is-risk');

  const b = lookupBadge(hit);
  const badge = document.createElement('span');
  badge.className = `lk-badge ${b.cls}`.trim();
  badge.textContent = b.text;

  const title = document.createElement('h3');
  title.className = 'lk-hit-title';
  title.textContent = hit.title;

  const body = document.createElement('p');
  body.className = 'lk-hit-body';
  body.textContent = hit.kind === 'risk' ? hit.body : (hit.card?.plain ?? '');

  const meta = document.createElement('p');
  meta.className = 'lk-hit-meta';
  if (hit.card) {
    const c = hit.card;
    const src = c.sources?.[0];
    const gain = c.gainText ? `\n收益 ${c.gainText.slice(0, 96)}…` : '';
    const source = src ? `\n来源 ${src.text.slice(0, 90)}` : '';
    meta.textContent =
      `成本 ${c.costText.split('。')[0]} · 证据 ${gradeOf(c.grade)} · ${c.chapterTitle}（${c.id}）` +
      gain +
      source;
  } else if (hit.risk) {
    const answers = hit.risk.keys
      .map((id) => cardById.get(id))
      .filter((c): c is CardRecord => !!c)
      .slice(0, 3)
      .map((c) => `${c.id}　${c.title.slice(0, 24)}`);
    meta.textContent = `原书里能接住它的是：\n${answers.join('\n')}`;
  }

  el.append(badge, title, body, meta);
  return el;
}

function renderLookup(hits: Hit[], note: string) {
  lkStatus.textContent = note;

  if (!hits.length) {
    const empty = document.createElement('p');
    empty.className = 'lk-empty';
    empty.textContent = '没找到。换个说法试试，或者点上面的例子。';
    lkResults.replaceChildren(empty);
    return;
  }

  /*
   * 命中风险时，把它的答案卡直接接在后面。
   * 用户问的是「我该怎么办」，看到「你可能遇到的是 X」之后
   * 立刻要能看到能接住 X 的那几条，不然还要再查一次。
   */
  const queue: Hit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    queue.push(h);
    if (h.risk) {
      for (const id of h.risk.keys.slice(0, 3)) {
        if (seen.has(id)) continue;
        const c = cardById.get(id);
        if (!c) continue;
        seen.add(id);
        queue.push({ kind: 'card', id: c.id, title: c.title, body: c.plain, card: c, score: h.score, verdict: null });
      }
    }
    if (queue.length >= LOOKUP_SHOW) break;
  }

  lkResults.replaceChildren(...queue.map(lookupHitEl));
}

async function runLookup(raw: string) {
  const query = raw.trim();
  if (!query || !searchIndex) return;

  // ① 本地先出结果，不等网络
  const local = searchLocal(searchIndex, query, LOOKUP_LOCAL);
  renderLookup(mergeHits(local), `本地命中 ${local.length} 条，正在让 Jev 复核…`);

  const cached = lookupCache.get(query);
  if (cached) {
    renderLookup(cached.hits, cached.note);
    return;
  }

  // ② Jev 复核前 N 条
  lookupAbort?.abort();
  const ac = new AbortController();
  lookupAbort = ac;
  const batch = local.slice(0, LOOKUP_BATCH);
  const r = await jevCheck(query, batch, ac.signal);
  if (ac.signal.aborted) return;

  const byId = new Map(batch.map((d, i) => [d.id, r.verdicts[i]]));
  const merged = mergeHits(local.map((h) => ({ ...h, verdict: byId.get(h.id) ?? null })));
  const direct = r.verdicts.filter((v) => v === 'direct').length;
  // 失败原因可能很长（classifier.dev 会把整句政策说明塞在 error 里），截断再显示
  const why = r.error && r.error.length > 58 ? `${r.error.slice(0, 58)}…` : r.error;
  const note = r.ok
    ? `本地命中 ${local.length} 条 · Jev 复核了前 ${batch.length} 条，其中 ${direct} 条直接回答了这个问题`
    : `本地命中 ${local.length} 条 · Jev 暂时用不了（${why}），下面是本地匹配`;

  lookupCache.set(query, { hits: merged, note });
  renderLookup(merged, note);
}

/* ============================================================
   模式：以身入局 / 游戏人生
   ------------------------------------------------------------
   入口先让用户自己选。选完之后右上角常驻切换器，
   两个模式之间随时来回，游戏进度不丢（只是冻住）。
   ============================================================ */
type Mode = 'lookup' | 'game';

let mode: Mode = 'game';
/** 第一次进游戏人生时要先把规则给出来，之后切换不再打断 */
let gameStarted = false;

function setMode(next: Mode) {
  mode = next;
  document.body.classList.remove('is-starting');
  document.body.classList.toggle('mode-lookup', next === 'lookup');
  document.body.classList.toggle('mode-game', next === 'game');
  startEl.hidden = true;

  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes .mode-btn')) {
    const on = b.dataset.mode === next;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }

  if (next === 'lookup') {
    // 方块冻住，不然一边读一边掉
    scene.setPaused(true);
    lookupEl.hidden = false;
    lkInput.focus();
    lkInput.select();
  } else {
    lookupEl.hidden = true;
    lookupAbort?.abort();
    lookupAbort = null;
    scene.setPaused(false);
    if (!gameStarted) {
      gameStarted = true;
      helpEl.hidden = false;
    }
  }
}

function openLookup(prefill?: string) {
  if (prefill) lkInput.value = prefill;
  setMode('lookup');
  if (prefill) void runLookup(prefill);
}

/* ============================================================
   结算
   ============================================================ */
function buildShareCanvas(summary: Summary): HTMLCanvasElement {
  return makeShareCard({
    age: summary.age,
    cause: summary.cause,
    scene: summary.scene,
    survived: summary.landed.length,
    layers: summary.landed.map((r) => ({
      group: r.group,
      title: r.title,
      color: GROUPS[r.group].css,
    })),
    saves: summary.saves,
    cleared: summary.cleared,
  });
}

function showSettlement(summary: Summary) {
  $('settle-kicker').textContent = summary.won ? '通关' : '结算';
  $('settle-age').textContent = String(summary.age);
  const cause = $('settle-cause');
  cause.textContent = summary.cause;
  cause.style.color = summary.won ? '#6e8a6a' : '#c2413f';
  $('settle-scene').textContent = summary.scene;
  $('settle-stat').textContent =
    `躲过 ${summary.cleared} 次 · 漏掉 ${summary.landed.length} 次 · ` +
    `走了 ${summary.turns}/${TOTAL_TURNS} 手 · 最长连击 ${summary.bestCombo}`;
  // 满分参照：让 1008 有个具体的样子，不然 812 只是个数字
  $('settle-perfect').textContent = `满分净值 ${PERFECT_AGE}`;

  const ul = $('settle-saves');
  ul.innerHTML = '';
  if (!summary.saves.length) {
    const li = document.createElement('li');
    li.className = 'is-empty';
    li.textContent = '一条都没漏。';
    ul.appendChild(li);
  }
  for (const save of summary.saves) {
    const li = document.createElement('li');
    const id = document.createElement('span');
    id.className = 'sid';
    id.textContent = save.id;
    const title = document.createElement('span');
    title.textContent = save.title;
    const grade = document.createElement('span');
    grade.className = 'sgrade';
    grade.textContent = save.grade;
    grade.style.color = GRADE_META[save.grade]?.css ?? '#999';
    li.append(id, title, grade);
    ul.appendChild(li);
  }

  settleEl.hidden = false;
}

main().catch((err) => {
  console.error('[启动失败]', err);
  failBoot(err);
});

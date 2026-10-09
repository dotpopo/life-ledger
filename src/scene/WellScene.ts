import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { CardRecord } from '../types.js';
import type { Risk } from '../data/risks.js';
import { GROUPS, GRADE_META, gradeOf } from '../data/groups.js';
import {
  makeBenchTexture,
  makeCardBack,
  makeCardFace,
  makeLayerTexture,
  makeMoteTexture,
  makeRiskFace,
} from './textures.js';

/* ---------- 尺寸常量：改这里就能调整个场景比例 ---------- */
const WELL_W = 5; // 井口内宽
/**
 * 井高 18，但堆满只有 10 层（到 y=13）。
 * 上面留出大段空井是故意的：出牌时相机贴得近，井顶会出画，
 * 你只看得见下半段；进预览时退远，整口井才从底一直顶到屏幕上方。
 */
const WELL_H = 18;
const WELL_BASE = 3; // 井坐在这个高度的台基上，把堆起来的层抬到台面之上
const LAYER_H = 1; // 每层高度
const MAX_LAYERS = 10; // 堆满这么多层就结算（口径与 engine.ts 的 MAX_LAYERS 一致）
const DANGER_Y = WELL_BASE + (MAX_LAYERS - 1.5) * LAYER_H; // 危险线：离堆满还差一层半
const CARD_W = 2.7;
const CARD_H = 3.9;
const CARD_Z = 7.5;
const CARD_Y = 3.4;
const SHARD_COUNT = 40;
const BENCH_R = 15;

/** 第 n 层方块的中心高度 */
const layerY = (n: number) => WELL_BASE + n * LAYER_H + LAYER_H / 2;

/**
 * 两套取景。
 * play  = 贴得近，只看井的下半段（井顶出画），层看得大；
 * preview = 退远，整口井进画面，方便一边读字一边盯着方块下落。
 */
const FRAMING = {
  play: { dist: 22, height: 5, look: 8.5 },
  preview: { dist: 38, height: 7, look: 12 },
} as const;

export interface SceneCallbacks {
  onCardHover?: (index: number | null) => void;
}

interface Falling {
  mesh: THREE.Mesh;
  risk: Risk;
  from: number;
  to: number;
  t: number;
  duration: number;
  onLand: () => void;
  landed: boolean;
}

interface Shard {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  max: number;
}

export class WellScene {
  private canvas: HTMLCanvasElement;
  private cb: SceneCallbacks;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(0, 0);
  private parallax = new THREE.Vector2(0, 0);

  private bench!: THREE.Mesh;
  private wellEdges!: THREE.LineSegments;
  private dangerRing!: THREE.Group;
  private cardGroup = new THREE.Group();
  private layerGroup = new THREE.Group();
  private shardGroup = new THREE.Group();
  private motes!: THREE.Points;
  private moteBase!: Float32Array;
  private motePhase!: Float32Array;

  private cardMeshes: THREE.Mesh[] = [];
  private cardTargets: Array<{ y: number; rot: number }> = [];

  private falling: Falling | null = null;
  private shards: Shard[] = [];

  private reducedMotion = false;
  private running = false;
  private animationId = 0;
  private last = 0;
  private elapsed = 0;
  private frameAccum = 0;
  private readonly frameStep = 1 / 60;

  private hovered = -1;
  private dangerLevel = 0;
  private dangerPulse = 0;
  /** 暂停时冻住仿真时间，画布停在最后一帧 */
  private paused = false;

  /* 随视口宽高比变化的取景参数。
     竖屏时垂直视野不变、水平视野会被压窄，手牌最外两张会被切在屏幕外，
     所以窄屏要同时把相机往后拉、把手牌收拢。 */
  // 显式标 number：FRAMING 是 as const，直接取字段会被推断成 22 / 5 / 8.5 这种字面量类型，
  // 后面按帧插值赋值就报 TS2322
  private camDist: number = FRAMING.play.dist;
  private camHeight: number = FRAMING.play.height;
  private camLook: number = FRAMING.play.look;
  private cardSpread = 5.1;
  private cardScale = 1;
  /** 0 = 出牌取景，1 = 预览取景。逐帧插值，所以切换是平滑推拉而不是瞬移。 */
  private framing = 0;
  private framingTarget = 0;
  private glassMat!: THREE.MeshStandardMaterial;
  private edgeMat!: THREE.LineBasicMaterial;
  private tickMat!: THREE.LineBasicMaterial;

  private disposed = false;
  private onResizeBound: () => void;

  constructor(canvas: HTMLCanvasElement, cb: SceneCallbacks = {}) {
    this.canvas = canvas;
    this.cb = cb;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.initRenderer();
    this.initScene();
    this.initPost();

    this.onResizeBound = () => this.resize();
    window.addEventListener('resize', this.onResizeBound);
    window.addEventListener('pointermove', this.handlePointerMove);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  /* ============================================================
     初始化
     ============================================================ */
  private initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0b0c0e, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
  }

  private initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0b0c0e, 0.016);

    this.updateView();
    this.camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(0, this.camHeight, this.camDist);
    this.camera.lookAt(0, this.camLook, 0);
    // 两个光源，不要第三个
    this.scene.add(new THREE.AmbientLight(0x4a5570, 2.1));

    const key = new THREE.DirectionalLight(0xfff0d8, 1.95);
    key.position.set(9, 33, 13);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    // 正交阴影相机必须对称且够大，否则边缘会被裁掉，表现成一片死黑
    key.shadow.camera.left = -28;
    key.shadow.camera.right = 28;
    key.shadow.camera.top = 28;
    key.shadow.camera.bottom = -28;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 90;
    key.shadow.bias = -0.0009;
    key.shadow.normalBias = 0.04;
    this.scene.add(key);

    const fill = new THREE.PointLight(0x7d90bb, 60, 52, 2);
    fill.position.set(-11, 8, -11);
    this.scene.add(fill);

    const rimLight = new THREE.PointLight(0xc9a227, 40, 40, 2);
    rimLight.position.set(0, 3, -14);
    this.scene.add(rimLight);

    this.createBench();
    this.createWell();
    this.createMotes();

    this.scene.add(this.cardGroup, this.layerGroup, this.shardGroup);
  }

  private createBench() {
    const geo = new THREE.CircleGeometry(BENCH_R, 96);
    const mat = new THREE.MeshStandardMaterial({
      map: makeBenchTexture(),
      roughness: 0.88,
      metalness: 0.12,
    });
    this.bench = new THREE.Mesh(geo, mat);
    this.bench.rotation.x = -Math.PI / 2;
    this.bench.receiveShadow = true;
    this.scene.add(this.bench);

    // 台面外沿一圈细亮边，把台子和背景分开
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(BENCH_R - 0.18, BENCH_R, 128),
      new THREE.MeshBasicMaterial({ color: 0x5a6b82, side: THREE.DoubleSide })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.006;
    this.scene.add(rim);

    // 台灯打在台面上的一滩光。没有它，台面就是一块死黑，
    // 手牌的阴影也糊在里面看不出层次。
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(12.5, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffdfa6,
        transparent: true,
        opacity: 0.055,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.014;
    this.scene.add(pool);
  }

  private createWell() {
    // 玻璃壁：几乎看不见，只提供一点点体积感
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xbccbe4,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
      roughness: 0.08,
      metalness: 0.1,
      emissive: new THREE.Color(0x1a2436),
    });
    this.glassMat = glassMat;
    const half = WELL_W / 2;
    const cy = WELL_BASE + WELL_H / 2;
    const panels: Array<[number, number, number]> = [
      [0, cy, -half],
      [0, cy, half],
      [-half, cy, 0],
      [half, cy, 0],
    ];
    for (const [x, y, z] of panels) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(WELL_W, WELL_H), glassMat);
      p.position.set(x, y, z);
      if (z !== 0) p.rotation.y = 0;
      else p.rotation.y = Math.PI / 2;
      this.scene.add(p);
    }

    // 台基：把井垫高，让堆起来的层不被前排的手牌挡住
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(WELL_W + 1.1, WELL_BASE, WELL_W + 1.1),
      new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.86, metalness: 0.16 })
    );
    plinth.position.y = WELL_BASE / 2;
    plinth.receiveShadow = true;
    plinth.castShadow = true;
    this.scene.add(plinth);

    const plinthTop = new THREE.Mesh(
      new THREE.RingGeometry(0, WELL_W * 0.78, 4, 1),
      new THREE.MeshBasicMaterial({
        color: 0x8ea3c4,
        transparent: true,
        opacity: 0.07,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    plinthTop.rotation.x = -Math.PI / 2;
    plinthTop.rotation.z = Math.PI / 4;
    plinthTop.position.y = WELL_BASE + 0.01;
    this.scene.add(plinthTop);

    // 12 条棱
    const box = new THREE.BoxGeometry(WELL_W, WELL_H, WELL_W);
    this.edgeMat = new THREE.LineBasicMaterial({
      color: 0x8ea3c4,
      transparent: true,
      opacity: 0.9,
    });
    this.wellEdges = new THREE.LineSegments(new THREE.EdgesGeometry(box), this.edgeMat);
    this.wellEdges.position.y = cy;
    this.scene.add(this.wellEdges);

    // 每层一道刻度线，像量筒。整口井都画，出牌时只看得见下半段
    const pts: number[] = [];
    for (let i = 1; i < WELL_H; i++) {
      const y = WELL_BASE + i * LAYER_H;
      pts.push(-half, y, -half, half, y, -half);
      pts.push(half, y, -half, half, y, half);
      pts.push(half, y, half, -half, y, half);
      pts.push(-half, y, half, -half, y, -half);
    }
    const ticks = new THREE.BufferGeometry();
    ticks.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.tickMat = new THREE.LineBasicMaterial({
      color: 0x44536b,
      transparent: true,
      opacity: 0.42,
    });
    this.scene.add(new THREE.LineSegments(ticks, this.tickMat));

    // 危险线：四条细方管，用 Basic 材质让泛光能吃到
    this.dangerRing = new THREE.Group();
    const t = 0.075;
    const span = WELL_W + 0.3;
    const dm = new THREE.MeshBasicMaterial({ color: 0xf0c869, transparent: true, opacity: 0.9 });
    const mk = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, t, d), dm);
      m.position.set(x, DANGER_Y, z);
      return m;
    };
    this.dangerRing.add(
      mk(span, t, 0, -span / 2),
      mk(span, t, 0, span / 2),
      mk(t, span, -span / 2, 0),
      mk(t, span, span / 2, 0)
    );
    this.scene.add(this.dangerRing);

    // 井底：一块暖色发光底盘，让井有个"底"，不然整口井是空的
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(WELL_W - 0.1, WELL_W - 0.1),
      new THREE.MeshBasicMaterial({
        color: 0xc9a227,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = WELL_BASE + 0.03;
    this.scene.add(floor);

    // 从上方打下来的光柱，很淡，只为氛围。太亮会把整个画面上半部洗掉。
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(WELL_W * 0.62, WELL_W * 1.05, WELL_H * 1.6, 40, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffe6b8,
        transparent: true,
        opacity: 0.012,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    shaft.position.y = WELL_BASE + WELL_H * 0.8 + 2;
    this.scene.add(shaft);
  }

  private createMotes() {
    const COUNT = 240;
    const pos = new Float32Array(COUNT * 3);
    this.moteBase = new Float32Array(COUNT * 3);
    this.motePhase = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const x = (Math.random() - 0.5) * 44;
      const y = Math.random() * 26 + 1;
      const z = (Math.random() - 0.5) * 40;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      this.moteBase[i * 3] = x;
      this.moteBase[i * 3 + 1] = y;
      this.moteBase[i * 3 + 2] = z;
      this.motePhase[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.motes = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: makeMoteTexture(),
        size: 0.42,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: 0xd8c9a8,
      })
    );
    this.scene.add(this.motes);
  }

  private initPost() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // 半分辨率泛光：必须在 addPass 之后再 setSize，
    // 因为 addPass 会把 pass 尺寸重置成整屏
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.46, 0.62, 0.86);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  /**
   * 按视口宽高比 + 当前取景算参数。
   * t=0 是常见桌面比例（16:10），t=1 是极窄的竖屏（约 0.46，等于 390x844）。
   */
  private updateView() {
    const a = window.innerWidth / Math.max(1, window.innerHeight);
    const ref = 1.6;
    const narrow = 0.46;
    const t = Math.min(1, Math.max(0, (ref - a) / (ref - narrow)));
    const f = this.framing;

    const from = FRAMING.play;
    const to = FRAMING.preview;
    // 窄屏只做很小的补偿：纵向取景必须保持住，
    // 否则手机上井会小到看不清堆了几层
    const k = 1 + t * 0.25;
    this.camDist = (from.dist + (to.dist - from.dist) * f) * k;
    this.camHeight = from.height + (to.height - from.height) * f;
    this.camLook = from.look + (to.look - from.look) * f;

    this.cardSpread = 5.1 - t * 2.8;
    this.cardScale = 1 - t * 0.3;
  }

  /** 切换取景。相机逐帧插值过去，是平滑推拉不是瞬移。 */
  setFraming(mode: 'play' | 'preview') {
    this.framingTarget = mode === 'preview' ? 1 : 0;
  }

  /* ============================================================
     手牌
     ============================================================ */
  setHand(cards: CardRecord[]) {
    for (const m of this.cardMeshes) {
      this.cardGroup.remove(m);
      this.disposeMesh(m);
    }
    this.cardMeshes = [];
    this.hovered = -1;

    const backTex = makeCardBack();
    cards.forEach((card, i) => {
      const grade = gradeOf(card.grade);
      const metal = GRADE_META[grade].metal;
      const faceTex = makeCardFace(card);

      const edgeMat = new THREE.MeshStandardMaterial({
        color: metal,
        roughness: GRADE_META[grade].rough,
        metalness: 0.86,
      });
      const frontMat = new THREE.MeshStandardMaterial({
        map: faceTex,
        roughness: 0.87,
        metalness: 0.02,
      });
      const backMat = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.9 });

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, CARD_H, 0.08), [
        edgeMat,
        edgeMat,
        edgeMat,
        edgeMat,
        frontMat,
        backMat,
      ]);
      mesh.castShadow = true;
      mesh.userData.cardIndex = i;
      this.cardGroup.add(mesh);
      this.cardMeshes.push(mesh);
    });
    this.layoutHand();
  }

  /** 按当前取景参数重新摆一遍手牌（视口变化时要重摆） */
  private layoutHand() {
    const n = this.cardMeshes.length;
    this.cardMeshes.forEach((mesh, i) => {
      const off = i - (n - 1) / 2;
      mesh.position.set(off * this.cardSpread, CARD_Y, CARD_Z);
      mesh.rotation.set(-0.4, -off * 0.15, 0);
      mesh.scale.setScalar(this.cardScale);
      this.cardTargets[i] = { y: CARD_Y, rot: -off * 0.15 };
    });
  }

  /** 从 DOM 侧反向控制手牌的悬停状态（手牌列表划过来时，立体卡也要抬起来） */
  hoverCard(index: number | null) {
    const next = index === null ? -1 : index;
    if (next === this.hovered) return;
    this.hovered = next;
    this.canvas.style.cursor = next >= 0 ? 'pointer' : 'default';
  }

  playCard(index: number, onDone?: () => void) {
    const mesh = this.cardMeshes[index];
    if (!mesh) {
      onDone?.();
      return;
    }
    const dur = this.reducedMotion ? 120 : 460;
    const start = performance.now();
    const from = mesh.position.clone();
    const fromRot = mesh.rotation.clone();
    const to = new THREE.Vector3(0, 9.5, 2.4);

    const step = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - start) / dur, 1);
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      mesh.position.lerpVectors(from, to, e);
      mesh.position.y += Math.sin(t * Math.PI) * 1.8;
      mesh.rotation.x = fromRot.x + e * 0.4;
      mesh.rotation.y = fromRot.y * (1 - e);
      mesh.rotation.z = fromRot.z + e * 2.4;
      const s = 1 + Math.sin(t * Math.PI) * 0.14;
      mesh.scale.setScalar(s * (1 - e * 0.55));
      if (t < 1) requestAnimationFrame(step);
      else onDone?.();
    };
    step();
  }

  rejectCard(index: number) {
    const mesh = this.cardMeshes[index];
    if (!mesh) return;
    const start = performance.now();
    const dur = 320;
    const base = mesh.rotation.z;
    const step = () => {
      if (this.disposed) return;
      const t = Math.min((performance.now() - start) / dur, 1);
      mesh.rotation.z = base + Math.sin(t * Math.PI * 3) * 0.09 * (1 - t);
      if (t < 1) requestAnimationFrame(step);
      else mesh.rotation.z = base;
    };
    step();
  }

  /* ============================================================
     风险
     ============================================================ */
  spawnRisk(risk: Risk, durationMs: number, onLand: () => void) {
    const w = WELL_W - 0.14;
    const h = LAYER_H - 0.16;
    const sideTex = makeLayerTexture(risk);
    const side = new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.72, metalness: 0.14 });
    const top = new THREE.MeshStandardMaterial({
      map: makeRiskFace(risk),
      roughness: 0.6,
      metalness: 0.2,
      emissive: new THREE.Color(GROUPS[risk.group].color).multiplyScalar(0.12),
    });
    const bottom = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 });

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), [
      side,
      side,
      top,
      bottom,
      side,
      side,
    ]);
    mesh.position.set(0, WELL_BASE + WELL_H - 1, 0);
    mesh.castShadow = true;
    this.scene.add(mesh);

    const to = layerY(this.layerGroup.children.length);
    this.falling = {
      mesh,
      risk,
      from: WELL_BASE + WELL_H - 1,
      to,
      t: 0,
      duration: Math.max(0.4, durationMs / 1000),
      onLand,
      landed: false,
    };
  }

  /** 当前下落的方块落到哪了（0~1）。没有方块时返回 0。 */
  fallProgress(): number {
    const f = this.falling;
    if (!f) return 0;
    return Math.min(f.t / f.duration, 1);
  }

  /** 暂停 / 继续。暂停时仿真时间不走，方块停在半空。 */
  setPaused(v: boolean) {
    if (this.paused === v) return;
    this.paused = v;
    // 恢复时把 last 重新对准，否则暂停这段时间会被算成一帧的超长 delta
    this.last = performance.now();
    this.frameAccum = 0;
  }

  get isPaused() {
    return this.paused;
  }

  /**
   * 一锤定音选错时调用：把正在下落的方块砸下去。
   *
   * 不能只把剩余时长压短 —— 缓动是 p²，p 已经接近 1 的时候，
   * 剩下那点位移几乎看不出来，玩家会觉得「点了没反应」。
   * 所以从方块当前位置重新起一段加速下坠。
   * 落地仍然走原来的 onLand → engine.riskLanded，
   * 堆层、判负、进下一手都在那一条路上，不另造一套状态机。
   */
  slamRisk() {
    const f = this.falling;
    if (!f) return;
    f.from = f.mesh.position.y;
    f.t = 0;
    f.duration = 0.28;
  }

  /** 炸掉正在下落的那个风险 */
  clearRisk(risk: Risk) {
    const f = this.falling;
    if (!f) return;
    this.falling = null;
    this.shatter(f.mesh.position.clone(), GROUPS[risk.group].color);
    this.scene.remove(f.mesh);
    this.disposeMesh(f.mesh);
  }

  /**
   * 把正在下落的那个方块固化成一层的网格。
   * 自然落地和主动放过都走这里，区别只是方块当时停在哪。
   * 关键是把它从 scene 挪进 layerGroup，这样层数才真的往上加。
   */
  settleFalling(risk: Risk) {
    const f = this.falling;
    this.falling = null;
    const y = layerY(this.layerGroup.children.length);
    if (f) {
      this.scene.remove(f.mesh);
      f.mesh.position.set(0, y, 0);
      this.layerGroup.add(f.mesh);
    } else {
      this.pushLayer(risk);
    }
    this.dangerPulse = 1;
  }

  /** 让风险落地，变成永久的一层 */
  pushLayer(risk: Risk) {
    const w = WELL_W - 0.14;
    const h = LAYER_H - 0.16;
    const side = new THREE.MeshStandardMaterial({
      map: makeLayerTexture(risk),
      roughness: 0.74,
      metalness: 0.12,
    });
    const top = new THREE.MeshStandardMaterial({ color: 0x191c21, roughness: 0.9 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), [
      side,
      side,
      top,
      top,
      side,
      side,
    ]);
    mesh.position.set(0, layerY(this.layerGroup.children.length), 0);
    mesh.castShadow = true;
    this.layerGroup.add(mesh);
    this.dangerPulse = 1;
  }

  clearLayers() {
    for (const m of [...this.layerGroup.children]) {
      this.layerGroup.remove(m);
      // 单个 dispose 失败不能让整个循环中断。
      // 一中断，剩下的层就留在场上，表现就是「上一局的方块没清掉」，
      // 而且控制台一点线索都没有。
      try {
        this.disposeMesh(m as THREE.Mesh);
      } catch (e) {
        console.warn('[clearLayers] 释放某一层失败', e);
      }
    }
  }

  private shatter(at: THREE.Vector3, color: number) {
    for (let i = 0; i < SHARD_COUNT; i++) {
      const s = 0.14 + Math.random() * 0.26;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(s, s, s),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
      );
      mesh.position.copy(at);
      this.shardGroup.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const r = 2.5 + Math.random() * 5;
      this.shards.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * r, 2 + Math.random() * 7, Math.sin(a) * r),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12
        ),
        life: 0,
        max: 0.7 + Math.random() * 0.5,
      });
    }
  }

  /* ============================================================
     对外状态
     ============================================================ */
  setDanger(level: number) {
    this.dangerLevel = THREE.MathUtils.clamp(level, 0, 1);
  }

  reset() {
    /*
     * 每一步都单独兜异常，最后再兜一次 clearLayers()。
     * 清理过程里任何一步抛异常，后面的清理就会被跳过，
     * 表现就是「上一局的方块还在场上」，而且控制台一点线索都没有。
     */
    this.clearLayers();
    try {
      if (this.falling) {
        this.scene.remove(this.falling.mesh);
        this.disposeMesh(this.falling.mesh);
      }
    } catch (e) {
      console.warn('[reset] 清理下落中的方块失败', e);
    }
    this.falling = null;
    try {
      for (const s of this.shards) {
        this.shardGroup.remove(s.mesh);
        this.disposeMesh(s.mesh);
      }
    } catch (e) {
      console.warn('[reset] 清理碎片失败', e);
    }
    this.shards = [];
    // 再兜一次。层没清干净是最要命的，宁可多跑一遍
    this.clearLayers();
    this.dangerLevel = 0;
    this.dangerPulse = 0;
    this.hovered = -1;
    this.framing = 0;
    this.framingTarget = 0;
  }

  /* ============================================================
     交互
     ============================================================ */
  private handlePointerMove = (e: PointerEvent) => {
    this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this.parallax.set(this.pointer.x, this.pointer.y);

    if (!this.cardMeshes.length) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.cardMeshes, false);
    const idx = hits.length ? (hits[0].object.userData.cardIndex as number) : -1;
    if (idx !== this.hovered) {
      this.hovered = idx;
      this.cb.onCardHover?.(idx < 0 ? null : idx);
      this.canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
    }
  };

  /**
   * 屏幕坐标 → 手牌下标，没命中返回 null。
   * 出牌和长按都靠它，点按/长按的判定放在 main 里，
   * 因为长按要能取消掉随后的那次出牌。
   */
  pickCardAt(clientX: number, clientY: number): number | null {
    if (!this.cardMeshes.length) return null;
    this.pointer.x = (clientX / window.innerWidth) * 2 - 1;
    this.pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.cardMeshes, false);
    return hits.length ? (hits[0].object.userData.cardIndex as number) : null;
  }

  private handleVisibility = () => {
    if (document.hidden) this.stop();
    else if (!this.disposed) this.start();
  };

  /* ============================================================
     主循环
     ============================================================ */
  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    this.animate();
  }

  stop() {
    this.running = false;
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.animationId = 0;
  }

  private animate = () => {
    if (!this.running) return;
    this.animationId = requestAnimationFrame(this.animate);

    const now = performance.now();
    const raw = (now - this.last) / 1000;
    this.last = now;
    this.frameAccum += raw;
    if (this.frameAccum < this.frameStep) return;
    const delta = Math.min(this.frameAccum, 0.05);
    this.frameAccum = 0;

    /*
     * 暂停：直接把仿真时间冻住。
     * 注意要放在累加 frameAccum 之后，否则暂停期间攒下的时间会在
     * 恢复的一瞬间全砸进去，方块会跳一大段。
     * 画布保持最后一帧，暂停遮罩是 DOM，不受影响。
     */
    if (this.paused) return;

    this.elapsed += delta;

    const motion = this.reducedMotion ? 0.25 : 1;
    const t = this.elapsed;

    // 取景推拉：出牌时贴得近，进预览时退远。
    // 同时把井的透明度跟着抬起来：低透明 = 现实里的实体，
    // 预览时它要更「实」一些，才压得住浮在上面的那层 HUD。
    if (Math.abs(this.framing - this.framingTarget) > 0.001) {
      this.framing += (this.framingTarget - this.framing) * Math.min(1, delta * 3.4);
      this.updateView();
      this.glassMat.opacity = 0.06 + this.framing * 0.11;
      this.edgeMat.opacity = 0.9 + this.framing * 0.1;
      this.tickMat.opacity = 0.42 + this.framing * 0.18;
    }

    // 相机视差：正负 3 度，不做自由旋转
    const px = this.parallax.x * 0.055;
    const py = this.parallax.y * 0.03;
    this.camera.position.x += (px * this.camDist - this.camera.position.x) * 0.05;
    this.camera.position.y += (this.camHeight + py * 4 - this.camera.position.y) * 0.05;
    this.camera.lookAt(0, this.camLook, 0);

    // 手牌漂浮 + 悬停抬起
    this.cardMeshes.forEach((mesh, i) => {
      const target = this.cardTargets[i];
      const floatY = Math.sin(t * 0.9 + i * 1.3) * 0.12 * motion;
      const hover = this.hovered === i ? 0.62 : 0;
      const wantY = target.y + floatY + hover;
      mesh.position.y += (wantY - mesh.position.y) * 0.16;
      const wantRotZ = target.rot + (this.hovered === i ? 0.04 : 0);
      mesh.rotation.z += (wantRotZ - mesh.rotation.z) * 0.14;
      const wantScale = (this.hovered === i ? 1.07 : 1) * this.cardScale;
      mesh.scale.setScalar(mesh.scale.x + (wantScale - mesh.scale.x) * 0.18);
    });

    // 下落的方块
    if (this.falling) {
      const f = this.falling;
      f.t += delta;
      const p = Math.min(f.t / f.duration, 1);
      const e = p * p;
      f.mesh.position.y = f.from + (f.to - f.from) * e;
      if (p >= 1 && !f.landed) {
        f.landed = true;
        const cb = f.onLand;
        this.falling = null;
        cb();
      }
    }

    // 碎块
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life += delta;
      s.vel.y -= 22 * delta;
      s.mesh.position.addScaledVector(s.vel, delta);
      s.mesh.rotation.x += s.spin.x * delta;
      s.mesh.rotation.y += s.spin.y * delta;
      s.mesh.rotation.z += s.spin.z * delta;
      const mat = s.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 1 - s.life / s.max);
      if (s.life >= s.max) {
        this.shardGroup.remove(s.mesh);
        this.disposeMesh(s.mesh);
        this.shards.splice(i, 1);
      }
    }

    // 危险线：层数越高越红越急
    this.dangerPulse = Math.max(0, this.dangerPulse - delta * 1.6);
    const urgency = this.dangerLevel;
    const pulse = 0.55 + Math.sin(t * (2 + urgency * 5)) * 0.2 * (0.35 + urgency);
    const mat = (this.dangerRing.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    mat.opacity = THREE.MathUtils.clamp(pulse + this.dangerPulse * 0.5, 0.25, 1);
    mat.color.setRGB(0.94, 0.78 - urgency * 0.42, 0.41 - urgency * 0.31);

    // 浮尘
    const pos = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < this.motePhase.length; i++) {
      const ph = this.motePhase[i];
      pos.setY(i, this.moteBase[i * 3 + 1] + Math.sin(t * 0.24 + ph) * 1.5 * motion);
      pos.setX(i, this.moteBase[i * 3] + Math.sin(t * 0.16 + ph * 1.7) * 1.1 * motion);
    }
    pos.needsUpdate = true;

    this.composer.render();
  };

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.updateView();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    // 半分辨率泛光，必须在 composer.setSize 之后再压一次
    this.bloom.setSize(Math.round(w / 2), Math.round(h / 2));
    this.layoutHand();
  }

  dispose() {
    this.disposed = true;
    this.stop();
    window.removeEventListener('resize', this.onResizeBound);
    window.removeEventListener('pointermove', this.handlePointerMove);
    document.removeEventListener('visibilitychange', this.handleVisibility);

    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.composer.dispose();
    this.renderer.dispose();
  }

  private disposeMesh(mesh: THREE.Mesh) {
    // 内部也各自兜一层。几何和材质是独立的 GPU 资源，
    // 一个失败不该把另一个也带下水。
    try {
      mesh.geometry.dispose();
    } catch (e) {
      console.warn('[disposeMesh] 几何释放失败', e);
    }
    const mat = mesh.material as THREE.Material | THREE.Material[];
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      try {
        m.dispose();
      } catch (e) {
        console.warn('[disposeMesh] 材质释放失败', e);
      }
    }
  }

  /** 调试钩子，给无头截图脚本用 */
  debugState() {
    return {
      cards: this.cardMeshes.length,
      layers: this.layerGroup.children.length,
      // 每层的高度，用来验证方块是真的往上堆而不是落在同一个位置
      layerYs: this.layerGroup.children.map((c) => Number(c.position.y.toFixed(2))),
      falling: !!this.falling,
      fallingY: this.falling ? Number(this.falling.mesh.position.y.toFixed(2)) : null,
      shards: this.shards.length,
      danger: this.dangerLevel,
    };
  }

  /** 每张手牌在屏幕上的中心点，供自动化点击用 */
  cardScreenPositions(): Array<{ x: number; y: number }> {
    const v = new THREE.Vector3();
    return this.cardMeshes.map((m) => {
      m.getWorldPosition(v);
      v.project(this.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
        y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      };
    });
  }
}

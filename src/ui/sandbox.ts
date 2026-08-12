// サンドボックス。箱もキャラも手で置いて、その状態から試合を始めるモード。
// UI 層なので three.js を直接触ってよい（core の決定論には一切関与しない）。
//
// 下絵は「進めない Game」をそのまま編集する。ID = 配列の添字という
// core 側の前提をそのまま満たせるので、開始時に配置を書き出すだけで済む。

import * as THREE from 'three';
import { borderWalls, isBorderWall, makeObstacle } from '../core/arena';
import {
  AGENT_HEIGHT,
  AGENT_RADIUS,
  ARENA_HALF,
  BOX_HEIGHT_BIG,
  BOX_HEIGHT_SMALL,
  SMOKE_CHARGES,
  STAMINA_MAX,
} from '../core/config';
import { Game } from '../core/game';
import type { Agent, ArenaLayout, MatchConfig, Obstacle, Team } from '../core/types';
import type { Renderer } from '../render/renderer';

/** 下絵の描画。試合中と同じ GameView を使い回すので、実体は main が渡す。 */
export interface SandboxHost {
  /** 物が増減した / 種類が変わった。シーンを作り直す */
  rebuild(game: Game): void;
  /** 位置だけ反映する（ドラッグ中は毎フレームこちら） */
  sync(game: Game): void;
}

type ToolId =
  | 'select'
  | 'boxSmall'
  | 'boxBig'
  | 'wall'
  | 'ramp'
  | 'pad'
  | 'pickup'
  | 'hider'
  | 'seeker';

interface Tool {
  id: ToolId;
  label: string;
  /** 障害物を置く道具なら、その雛形 */
  make?: () => Obstacle;
}

const TOOLS: Tool[] = [
  { id: 'select', label: '選択・移動' },
  {
    id: 'boxSmall',
    label: '小さい箱',
    make: () => makeObstacle('box', 0, 0, 0.8, 0.8, BOX_HEIGHT_SMALL),
  },
  {
    id: 'boxBig',
    label: '大きい箱',
    make: () => makeObstacle('box', 0, 0, 1.3, 1.3, BOX_HEIGHT_BIG),
  },
  { id: 'wall', label: '壁', make: () => makeObstacle('wall', 0, 0, 0.5, 3, 2.6) },
  { id: 'ramp', label: 'ランプ', make: () => makeObstacle('ramp', 0, 0, 2.6, 1.3, 1.6, 0) },
  { id: 'pad', label: 'ジャンプ台', make: () => makeObstacle('pad', 0, 0, 1, 1, 0.25) },
  { id: 'pickup', label: '補給パック' },
  { id: 'hider', label: '逃げる側' },
  { id: 'seeker', label: '鬼' },
];

/** 置く位置の刻み。Alt を押している間は刻まない。 */
const SNAP = 0.5;

/** 保存先。ブラウザを閉じても配置が残るようにしておく。 */
const STORAGE_KEY = 'hide-seek-3d.sandbox';

type Sel = { kind: 'obstacle' | 'agent' | 'pickup'; id: number } | null;

export class SandboxEditor {
  private el: HTMLDivElement;
  private draft: Game;
  private tool: ToolId = 'boxSmall';
  private sel: Sel = null;
  private drag:
    | {
        kind: 'obstacle' | 'agent' | 'pickup';
        id: number;
        offX: number;
        offZ: number;
        fromX: number;
        fromZ: number;
        fromY: number;
      }
    | null = null;
  /** 準備フェーズを入れるか。入れると鬼は中央のケージへ戻される */
  private withPrep = false;
  private message = '';
  private shown = false;

  private canvas: HTMLCanvasElement;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private pointer = new THREE.Vector2();
  private hasPointer = false;
  /** カーソルが指す設置点（刻み適用後）。`y` は乗せる面の高さ */
  private cursor: { x: number; z: number; y: number } | null = null;

  private highlight: THREE.LineSegments;
  private preview: THREE.LineSegments;

  constructor(
    root: HTMLElement,
    private renderer: Renderer,
    private host: SandboxHost,
    private onStart: (config: MatchConfig) => void,
    private onBack: () => void,
  ) {
    this.canvas = renderer.renderer.domElement as HTMLCanvasElement;

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0xffe14d }),
    );
    this.preview = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x6fe8b0 }),
    );
    this.highlight.visible = false;
    this.preview.visible = false;
    renderer.scene.add(this.highlight, this.preview);

    this.el = document.createElement('div');
    this.el.className = 'sandbox';
    this.el.style.display = 'none';
    root.appendChild(this.el);

    this.draft = this.buildDraft(2, 2);
    this.attachInput();
  }

  // ---- 下絵の作成 -------------------------------------------------------

  /** ランダム生成した盤面を下敷きにする（そこから足し引きするのが一番速い）。 */
  private buildDraft(hiders: number, seekers: number): Game {
    return new Game({
      hiders,
      seekers,
      playerTeam: null,
      seed: (Math.random() * 0xffffff) | 0,
      skipPrep: true, // 下絵ではケージを描かせない
    });
  }

  private buildFromLayout(layout: ArenaLayout): Game {
    return new Game({
      hiders: layout.agents.filter((a) => a.team === 'hider').length,
      seekers: layout.agents.filter((a) => a.team === 'seeker').length,
      playerTeam: null,
      seed: (Math.random() * 0xffffff) | 0,
      layout,
      skipPrep: true,
    });
  }

  /** いまの下絵を配置データとして書き出す。 */
  private toLayout(): ArenaLayout {
    const s = this.draft.state;
    return {
      obstacles: s.obstacles.map((o) => ({ ...o })),
      agents: s.agents.map((a) => ({
        team: a.team,
        x: a.x,
        z: a.z,
        y: a.y,
        isPlayer: a.isPlayer,
      })),
      pickups: s.pickups.map((p) => ({ x: p.x, z: p.z })),
    };
  }

  // ---- 表示 -------------------------------------------------------------

  show(): void {
    this.shown = true;
    this.message = '';
    this.el.style.display = 'flex';
    this.renderer.setCameraMode('overhead');
    this.restructure();
  }

  hide(): void {
    this.shown = false;
    this.el.style.display = 'none';
    this.highlight.visible = false;
    this.preview.visible = false;
    this.drag = null;
  }

  /**
   * 物が増減したあとの立て直し。ID を添字に振り直してからシーンを作り直す。
   * 位置だけが変わったときは `host.sync` で足りる。
   */
  private restructure(): void {
    const s = this.draft.state;
    s.obstacles.forEach((o, i) => (o.id = i));
    s.agents.forEach((a, i) => (a.id = i));
    s.pickups.forEach((p, i) => (p.id = i));
    s.config.hiders = this.count('hider');
    s.config.seekers = this.count('seeker');
    this.host.rebuild(this.draft);
    this.host.sync(this.draft);
    this.syncGizmos();
    this.render();
  }

  private count(team: Team): number {
    return this.draft.state.agents.filter((a) => a.team === team).length;
  }

  // ---- 入力 -------------------------------------------------------------

  private attachInput(): void {
    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.shown) return;
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.hasPointer = true;
      this.updateCursor(e.altKey);
      if (this.drag) this.dragTo();
      this.syncGizmos();
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.shown) return;
      if (e.button === 1) return; // 中ボタンは視点移動（Renderer 側）
      const hit = this.pick();

      if (e.button === 2) {
        // 右クリックはその場で削除。道具を持ち替えずに消せる。
        if (hit) this.remove(hit);
        return;
      }

      if (this.tool === 'select') {
        this.sel = hit;
        if (hit) this.beginDrag(hit);
        this.render();
        this.syncGizmos();
        return;
      }
      this.place();
    });

    window.addEventListener('mouseup', () => {
      if (!this.drag) return;
      this.endDrag();
    });

    window.addEventListener('keydown', (e) => {
      if (!this.shown) return;
      if (e.code === 'Escape') {
        this.setTool('select');
        return;
      }
      if (e.code === 'KeyR') {
        this.rotateSelected();
        return;
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (this.sel) this.remove(this.sel);
        return;
      }
      const digit = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'].indexOf(
        e.code,
      );
      if (digit >= 0 && digit < TOOLS.length) this.setTool(TOOLS[digit].id);
    });
  }

  private updateCursor(free: boolean): void {
    const exclude = this.drag ? { kind: this.drag.kind, id: this.drag.id } : null;
    const p = this.pointerPoint(exclude);
    if (!p) {
      this.cursor = null;
      return;
    }
    const q = (v: number): number => (free ? v : Math.round(v / SNAP) * SNAP);
    const x = q(p.x);
    const z = q(p.z);
    // 高さは刻んだあとの位置で決める。ずれた先が宙に浮くのを避ける。
    this.cursor = { x, z, y: this.supportAt(x, z, exclude) };
  }

  /**
   * カーソルが指す床の (x, z)。箱や壁の**上面**を指していればその面の上の点、
   * それ以外は地面。俯瞰カメラなので、背の高い箱は手前の側面を指しやすい
   * （その場合は地面側に落ちるが、地面の点が箱の footprint に入るので
   * `supportAt` が拾って結局その箱の上に乗る）。
   */
  private pointerPoint(exclude: NonNullable<Sel> | null): { x: number; z: number } | null {
    if (!this.hasPointer) return null;
    this.raycaster.setFromCamera(this.pointer, this.renderer.camera);
    const ray = this.raycaster.ray;
    const box = new THREE.Box3();
    const hit = new THREE.Vector3();
    let best: { x: number; z: number } | null = null;
    let bestDist = Infinity;

    for (const o of this.draft.state.obstacles) {
      // 斜面と薄いジャンプ台の上には積ませない（乗り物として使う物なので）。
      if (o.kind === 'ramp' || o.kind === 'pad') continue;
      if (isBorderWall(o)) continue;
      if (exclude?.kind === 'obstacle' && exclude.id === o.id) continue;
      const top = o.y + o.h;
      box.min.set(o.x - o.hw, o.y, o.z - o.hd);
      box.max.set(o.x + o.hw, top, o.z + o.hd);
      if (!ray.intersectBox(box, hit)) continue;
      const d = ray.origin.distanceTo(hit);
      if (d >= bestDist) continue;
      bestDist = d;
      best = Math.abs(hit.y - top) < 0.02 ? { x: hit.x, z: hit.z } : null;
    }
    if (best) return best;

    const ground = new THREE.Vector3();
    if (!ray.intersectPlane(this.groundPlane, ground)) return null;
    return { x: ground.x, z: ground.z };
  }

  /** その位置で足場になる面の高さ。何も無ければ地面（0）。 */
  private supportAt(x: number, z: number, exclude: NonNullable<Sel> | null): number {
    let top = 0;
    for (const o of this.draft.state.obstacles) {
      if (o.kind === 'ramp' || o.kind === 'pad') continue;
      if (isBorderWall(o)) continue;
      if (exclude?.kind === 'obstacle' && exclude.id === o.id) continue;
      if (Math.abs(x - o.x) > o.hw || Math.abs(z - o.z) > o.hd) continue;
      top = Math.max(top, o.y + o.h);
    }
    return top;
  }

  /** カーソルの下にある物。手前にあるものを優先する（本物の 3D 判定）。 */
  private pick(): Sel {
    if (!this.hasPointer) return null;
    this.raycaster.setFromCamera(this.pointer, this.renderer.camera);
    const ray = this.raycaster.ray;
    const box = new THREE.Box3();
    const hit = new THREE.Vector3();
    let best: Sel = null;
    let bestDist = Infinity;

    const test = (
      kind: 'obstacle' | 'agent' | 'pickup',
      id: number,
      cx: number,
      cz: number,
      hw: number,
      hd: number,
      y0: number,
      y1: number,
    ): void => {
      box.min.set(cx - hw, y0, cz - hd);
      box.max.set(cx + hw, y1, cz + hd);
      if (!ray.intersectBox(box, hit)) return;
      const d = ray.origin.distanceTo(hit);
      if (d < bestDist) {
        bestDist = d;
        best = { kind, id };
      }
    };

    const s = this.draft.state;
    for (const a of s.agents) test('agent', a.id, a.x, a.z, AGENT_RADIUS, AGENT_RADIUS, a.y, a.y + AGENT_HEIGHT);
    for (const p of s.pickups) test('pickup', p.id, p.x, p.z, 0.6, 0.6, 0, 1.4);
    for (const o of s.obstacles) {
      if (isBorderWall(o)) continue; // 外周の壁は消させない
      test('obstacle', o.id, o.x, o.z, o.hw, o.hd, o.y, o.y + o.h);
    }
    return best;
  }

  // ---- 置く・消す・動かす -----------------------------------------------

  private place(): void {
    const c = this.cursor;
    if (!c) return;
    const s = this.draft.state;
    // 直前の「置けない」を引きずらない。失敗したらこの下で出し直す。
    this.message = '';

    if (this.tool === 'hider' || this.tool === 'seeker') {
      if (!this.agentFits(c.x, c.z, c.y, -1)) return this.warn('ここには立てない');
      s.agents.push(this.newAgent(this.tool, c.x, c.z, c.y));
      this.sel = { kind: 'agent', id: s.agents.length - 1 };
      this.restructure();
      return;
    }

    if (this.tool === 'pickup') {
      // 補給パックは箱の上から拾えない仕様なので、床にしか置かせない。
      if (c.y > 0) return this.warn('補給パックは床にしか置けない');
      if (!this.pickupFits(c.x, c.z)) return this.warn('ここには置けない');
      s.pickups.push({ id: s.pickups.length, x: c.x, z: c.z, active: true, respawnAt: 0 });
      this.sel = { kind: 'pickup', id: s.pickups.length - 1 };
      this.restructure();
      return;
    }

    const tool = TOOLS.find((t) => t.id === this.tool);
    if (!tool?.make) return;
    const o = tool.make();
    o.x = c.x;
    o.z = c.z;
    o.y = c.y;
    if (!this.obstacleFits(o, c.x, c.z, c.y, -1)) return this.warn('ここには置けない');
    o.id = s.obstacles.length;
    s.obstacles.push(o);
    this.sel = { kind: 'obstacle', id: o.id };
    this.restructure();
  }

  /**
   * 下絵に置くエージェント。ここでの状態は「位置と陣営」しか使われない
   * （試合開始時に core 側が初期値から作り直す）。
   */
  private newAgent(team: Team, x: number, z: number, y = 0): Agent {
    return {
      id: 0,
      team,
      x,
      z,
      y,
      vx: 0,
      vz: 0,
      vy: 0,
      facing: team === 'seeker' ? 0 : Math.atan2(-x, -z),
      grounded: true,
      stamina: STAMINA_MAX,
      caught: false,
      grabbed: -1,
      grabOffX: 0,
      grabOffZ: 0,
      boostUntil: -99,
      smokeCharges: team === 'hider' ? SMOKE_CHARGES : 0,
      lastSmokeAt: -99,
      isPlayer: false,
      lastSeenAt: -99,
    };
  }

  private remove(sel: NonNullable<Sel>): void {
    this.message = '';
    const s = this.draft.state;
    if (sel.kind === 'obstacle') {
      const o = s.obstacles[sel.id];
      if (!o || isBorderWall(o)) return;
      s.obstacles.splice(sel.id, 1);
    } else if (sel.kind === 'agent') {
      s.agents.splice(sel.id, 1);
    } else {
      s.pickups.splice(sel.id, 1);
    }
    this.sel = null;
    this.restructure();
  }

  private beginDrag(sel: NonNullable<Sel>): void {
    const p = this.item(sel);
    if (!p) return;
    // 掴んだ瞬間は自分自身を除いた点を基準にする（自分の上面に吸い付かせない）。
    const g = this.pointerPoint(sel);
    if (!g) return;
    this.drag = {
      kind: sel.kind,
      id: sel.id,
      offX: p.x - g.x,
      offZ: p.z - g.z,
      fromX: p.x,
      fromZ: p.z,
      fromY: p.y ?? 0,
    };
  }

  private dragTo(): void {
    const d = this.drag;
    if (!d) return;
    const exclude = { kind: d.kind, id: d.id } as NonNullable<Sel>;
    const g = this.pointerPoint(exclude);
    if (!g) return;
    const p = this.item(exclude);
    if (!p) return;
    p.x = g.x + d.offX;
    p.z = g.z + d.offZ;
    // 箱の上を通せば持ち上がり、床へ戻せば下りる。
    if (p.y !== undefined) p.y = this.supportAt(p.x, p.z, exclude);
    this.host.sync(this.draft);
  }

  /** 置けない場所で離したら元に戻す。半端に重なった状態を残さない。 */
  private endDrag(): void {
    this.message = '';
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const p = this.item({ kind: d.kind, id: d.id });
    if (!p) return;

    const snap = (v: number): number => Math.round(v / SNAP) * SNAP;
    const x = snap(p.x);
    const z = snap(p.z);
    const exclude = { kind: d.kind, id: d.id } as NonNullable<Sel>;
    // 刻んだ先の足場で判定する。ずれて宙に浮くのを避ける。
    const y = p.y !== undefined ? this.supportAt(x, z, exclude) : 0;
    const ok =
      d.kind === 'agent'
        ? this.agentFits(x, z, y, d.id)
        : d.kind === 'pickup'
          ? this.pickupFits(x, z)
          : this.obstacleFits(this.draft.state.obstacles[d.id], x, z, y, d.id);

    if (ok) {
      p.x = x;
      p.z = z;
      if (p.y !== undefined) p.y = y;
    } else {
      p.x = d.fromX;
      p.z = d.fromZ;
      if (p.y !== undefined) p.y = d.fromY;
      this.warn('そこには置けないので戻した');
    }
    this.host.sync(this.draft);
    this.syncGizmos();
  }

  /** 位置を書き換えられる実体。障害物とエージェントだけ高さ（`y`）を持つ。 */
  private item(sel: NonNullable<Sel>): { x: number; z: number; y?: number } | null {
    const s = this.draft.state;
    if (sel.kind === 'obstacle') return s.obstacles[sel.id] ?? null;
    if (sel.kind === 'agent') return s.agents[sel.id] ?? null;
    return s.pickups[sel.id] ?? null;
  }

  private rotateSelected(): void {
    this.message = '';
    if (this.sel?.kind !== 'obstacle') return;
    const o = this.draft.state.obstacles[this.sel.id];
    if (!o) return;
    if (o.kind === 'ramp') {
      const next = ((o.rampDir + 1) % 4) as 0 | 1 | 2 | 3;
      // 傾斜の軸が X ↔ Z で入れ替わるときだけ、寸法も入れ替える。
      if (o.rampDir <= 1 !== next <= 1) [o.hw, o.hd] = [o.hd, o.hw];
      o.rampDir = next;
    } else {
      [o.hw, o.hd] = [o.hd, o.hw];
    }
    if (!this.obstacleFits(o, o.x, o.z, o.y, o.id)) {
      // 回した先が塞がっていたら戻す。
      if (o.kind === 'ramp') {
        const back = ((o.rampDir + 3) % 4) as 0 | 1 | 2 | 3;
        if (o.rampDir <= 1 !== back <= 1) [o.hw, o.hd] = [o.hd, o.hw];
        o.rampDir = back;
      } else {
        [o.hw, o.hd] = [o.hd, o.hw];
      }
      this.warn('回すと重なるので戻した');
    }
    this.restructure();
  }

  // ---- 置けるかの判定 ---------------------------------------------------

  /** 高さの区間が重なるか。触れているだけ（上に乗っている）は重なりとしない。 */
  private overlapsY(y0: number, h0: number, y1: number, h1: number): boolean {
    return y0 < y1 + h1 - 1e-3 && y1 < y0 + h0 - 1e-3;
  }

  private obstacleFits(o: Obstacle, x: number, z: number, y: number, ignoreId: number): boolean {
    if (Math.abs(x) + o.hw > ARENA_HALF || Math.abs(z) + o.hd > ARENA_HALF) return false;
    const s = this.draft.state;
    for (const other of s.obstacles) {
      if (other.id === ignoreId) continue;
      if (isBorderWall(other)) continue;
      if (Math.abs(x - other.x) >= o.hw + other.hw || Math.abs(z - other.z) >= o.hd + other.hd) {
        continue;
      }
      // 真上に積むぶんには重ならない。
      if (this.overlapsY(y, o.h, other.y, other.h)) return false;
    }
    // 人の上には置かない。
    for (const a of s.agents) {
      if (Math.abs(x - a.x) >= o.hw + AGENT_RADIUS || Math.abs(z - a.z) >= o.hd + AGENT_RADIUS) {
        continue;
      }
      if (this.overlapsY(y, o.h, a.y, AGENT_HEIGHT)) return false;
    }
    return true;
  }

  private agentFits(x: number, z: number, y: number, ignoreId: number): boolean {
    if (Math.abs(x) > ARENA_HALF - AGENT_RADIUS || Math.abs(z) > ARENA_HALF - AGENT_RADIUS) {
      return false;
    }
    const s = this.draft.state;
    for (const o of s.obstacles) {
      // ランプとジャンプ台は上を歩けるので重なってよい。
      if (o.kind === 'ramp' || o.kind === 'pad') continue;
      if (isBorderWall(o)) continue;
      if (Math.abs(x - o.x) >= o.hw + AGENT_RADIUS || Math.abs(z - o.z) >= o.hd + AGENT_RADIUS) {
        continue;
      }
      // 箱の上に立つぶんには重ならない。
      if (this.overlapsY(y, AGENT_HEIGHT, o.y, o.h)) return false;
    }
    for (const a of s.agents) {
      if (a.id === ignoreId) continue;
      if (Math.abs(y - a.y) >= AGENT_HEIGHT * 0.8) continue; // 上下に離れていれば重ならない
      if (Math.hypot(x - a.x, z - a.z) < AGENT_RADIUS * 2) return false;
    }
    return true;
  }

  private pickupFits(x: number, z: number): boolean {
    if (Math.abs(x) > ARENA_HALF - 1 || Math.abs(z) > ARENA_HALF - 1) return false;
    for (const o of this.draft.state.obstacles) {
      if (o.kind === 'ramp' || o.kind === 'pad') continue;
      if (isBorderWall(o)) continue;
      if (Math.abs(x - o.x) < o.hw + 0.8 && Math.abs(z - o.z) < o.hd + 0.8) return false;
    }
    return true;
  }

  /** 空いている場所を探す。＋ボタンでキャラを増やすときの置き場所。 */
  private freeSpot(team: Team): { x: number; z: number } | null {
    // 鬼は中央寄り、逃げる側は外周寄りから探す（既定の配置と同じ気持ち）。
    for (let ring = 0; ring < 12; ring++) {
      const r = team === 'seeker' ? 1.5 + ring * 1.6 : ARENA_HALF - 3 - ring * 1.6;
      if (r < 1 || r > ARENA_HALF - 1) continue;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = Math.round((Math.sin(a) * r) / SNAP) * SNAP;
        const z = Math.round((Math.cos(a) * r) / SNAP) * SNAP;
        if (this.agentFits(x, z, 0, -1)) return { x, z };
      }
    }
    return null;
  }

  private addAgent(team: Team): void {
    this.message = '';
    const spot = this.freeSpot(team);
    if (!spot) return this.warn('空いている場所が無い');
    const s = this.draft.state;
    s.agents.push(this.newAgent(team, spot.x, spot.z));
    this.sel = { kind: 'agent', id: s.agents.length - 1 };
    this.restructure();
  }

  private removeLastAgent(team: Team): void {
    this.message = '';
    const s = this.draft.state;
    for (let i = s.agents.length - 1; i >= 0; i--) {
      if (s.agents[i].team !== team) continue;
      s.agents.splice(i, 1);
      this.sel = null;
      this.restructure();
      return;
    }
  }

  /** 人間が操作する 1 人を決める。同じ相手をもう一度押すと観戦に戻る。 */
  private setPlayer(id: number | null): void {
    this.message = '';
    for (const a of this.draft.state.agents) a.isPlayer = a.id === id;
    this.restructure();
  }

  // ---- ギズモ（選択枠とプレビュー） -------------------------------------

  private syncGizmos(): void {
    const sel = this.sel;
    if (sel) {
      const box = this.boundsOf(sel);
      if (box) {
        this.highlight.visible = true;
        this.highlight.scale.set(box.w, box.h, box.d);
        this.highlight.position.set(box.x, box.y + box.h / 2, box.z);
      } else {
        this.highlight.visible = false;
      }
    } else {
      this.highlight.visible = false;
    }

    // 置く道具を持っているときは、置かれる形と可否をその場に出す。
    const c = this.cursor;
    const tool = TOOLS.find((t) => t.id === this.tool);
    if (!c || !tool || tool.id === 'select' || this.drag) {
      this.preview.visible = false;
      return;
    }
    let w = 1.2;
    let d = 1.2;
    let h = 1.4;
    let ok: boolean;
    if (tool.id === 'hider' || tool.id === 'seeker') {
      w = d = AGENT_RADIUS * 2;
      h = AGENT_HEIGHT;
      ok = this.agentFits(c.x, c.z, c.y, -1);
    } else if (tool.id === 'pickup') {
      ok = c.y === 0 && this.pickupFits(c.x, c.z);
    } else {
      const o = tool.make!();
      w = o.hw * 2;
      d = o.hd * 2;
      h = o.h;
      ok = this.obstacleFits(o, c.x, c.z, c.y, -1);
    }
    this.preview.visible = true;
    this.preview.scale.set(w, h, d);
    this.preview.position.set(c.x, c.y + h / 2, c.z);
    (this.preview.material as THREE.LineBasicMaterial).color.setHex(ok ? 0x6fe8b0 : 0xff5b5b);
  }

  private boundsOf(
    sel: NonNullable<Sel>,
  ): { x: number; z: number; y: number; w: number; d: number; h: number } | null {
    const s = this.draft.state;
    if (sel.kind === 'obstacle') {
      const o = s.obstacles[sel.id];
      return o ? { x: o.x, z: o.z, y: o.y, w: o.hw * 2, d: o.hd * 2, h: o.h } : null;
    }
    if (sel.kind === 'agent') {
      const a = s.agents[sel.id];
      return a
        ? { x: a.x, z: a.z, y: a.y, w: AGENT_RADIUS * 2, d: AGENT_RADIUS * 2, h: AGENT_HEIGHT }
        : null;
    }
    const p = s.pickups[sel.id];
    return p ? { x: p.x, z: p.z, y: 0, w: 1.2, d: 1.2, h: 1.4 } : null;
  }

  // ---- 保存 / 呼び出し ---------------------------------------------------

  private save(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ layout: this.toLayout(), withPrep: this.withPrep }),
      );
      this.warn('保存した');
    } catch {
      this.warn('保存できなかった');
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.warn('保存された配置が無い');
      const data = JSON.parse(raw) as { layout: ArenaLayout; withPrep?: boolean };
      if (!data?.layout?.obstacles?.length) return this.warn('保存された配置が読めない');
      this.draft = this.buildFromLayout(data.layout);
      this.withPrep = data.withPrep === true;
      this.sel = null;
      this.restructure();
      this.warn('呼び出した');
    } catch {
      this.warn('保存された配置が読めない');
    }
  }

  // ---- 開始 -------------------------------------------------------------

  private startMatch(): void {
    const hiders = this.count('hider');
    const seekers = this.count('seeker');
    if (hiders === 0 || seekers === 0) {
      return this.warn('逃げる側と鬼を 1 人以上ずつ置くこと');
    }
    const layout = this.toLayout();
    const player = layout.agents.find((a) => a.isPlayer) ?? null;
    this.hide();
    this.onStart({
      hiders,
      seekers,
      playerTeam: player?.team ?? null,
      seed: (Math.random() * 0xffffff) | 0,
      layout,
      skipPrep: !this.withPrep,
    });
  }

  // ---- パネル -----------------------------------------------------------

  private setTool(id: ToolId): void {
    this.tool = id;
    if (id !== 'select') this.sel = null;
    this.render();
    this.syncGizmos();
  }

  private warn(text: string): void {
    this.message = text;
    const el = this.el.querySelector('.sb-msg');
    if (el) el.textContent = text;
  }

  private render(): void {
    const s = this.draft.state;
    const hiders = s.agents.filter((a) => a.team === 'hider');
    const seekers = s.agents.filter((a) => a.team === 'seeker');
    const player = s.agents.find((a) => a.isPlayer) ?? null;

    const roster = (team: Team, list: typeof s.agents): string => {
      const name = team === 'hider' ? '逃げる側' : '鬼';
      return `
        <div class="sb-team ${team}">
          <div class="sb-team-head">
            <span class="dot"></span><b>${name}</b>
            <span class="sb-count">${list.length}</span>
            <button class="sb-minus" data-team="${team}" title="1 人減らす">−</button>
            <button class="sb-plus" data-team="${team}" title="1 人増やす">＋</button>
          </div>
          <div class="sb-members">
            ${list
              .map(
                (a, i) => `
              <button class="sb-member ${a.isPlayer ? 'player' : ''} ${
                this.sel?.kind === 'agent' && this.sel.id === a.id ? 'sel' : ''
              }" data-id="${a.id}">
                ${name} ${i + 1}${a.isPlayer ? ' <em>操作中</em>' : ''}
              </button>`,
              )
              .join('')}
          </div>
        </div>`;
    };

    this.el.innerHTML = `
      <div class="sb-panel">
        <div class="sb-head">
          <h2>サンドボックス</h2>
          <p>好きなように置いて、その状態から始める。</p>
        </div>

        <div class="sb-section">
          <div class="sb-title">置くもの<span class="sb-sub">クリックで設置 / 右クリックで削除</span></div>
          <div class="sb-tools">
            ${TOOLS.map(
              (t, i) =>
                `<button class="sb-tool ${t.id === this.tool ? 'on' : ''}" data-tool="${t.id}">
                   <span class="sb-key">${i + 1}</span>${t.label}
                 </button>`,
            ).join('')}
          </div>
        </div>

        <div class="sb-section">
          <div class="sb-title">キャラクター<span class="sb-sub">押すと操作するキャラを選ぶ</span></div>
          ${roster('hider', hiders)}
          ${roster('seeker', seekers)}
          <button class="sb-spectate ${player ? '' : 'on'}">観戦（全員 AI）</button>
        </div>

        <div class="sb-section">
          <div class="sb-title">盤面</div>
          <div class="sb-row">
            <button class="sb-gen">ランダム生成</button>
            <button class="sb-clear">空にする</button>
          </div>
          <div class="sb-row">
            <button class="sb-save">保存</button>
            <button class="sb-load">呼び出し</button>
          </div>
          <label class="sb-check">
            <input type="checkbox" class="sb-prep" ${this.withPrep ? 'checked' : ''} />
            準備フェーズを入れる（鬼は中央のケージへ戻る）
          </label>
        </div>

        <div class="sb-msg">${this.message}</div>

        <div class="sb-actions">
          <button class="sb-start">この配置で開始</button>
          <button class="sb-back">メニューへ</button>
        </div>

        <div class="sb-help">
          <div><kbd>1</kbd>〜<kbd>9</kbd> 道具　<kbd>Esc</kbd> 選択　<kbd>R</kbd> 回す　<kbd>Del</kbd> 消す</div>
          <div><kbd>Alt</kbd> 刻みなしで置く　<kbd>ホイール</kbd> ズーム　<kbd>中ドラッグ</kbd> 視点移動</div>
        </div>
      </div>`;

    const q = <T extends HTMLElement>(sel: string): T => this.el.querySelector<T>(sel)!;

    this.el.querySelectorAll<HTMLButtonElement>('.sb-tool').forEach((b) => {
      b.onclick = () => this.setTool(b.dataset.tool as ToolId);
    });
    this.el.querySelectorAll<HTMLButtonElement>('.sb-plus').forEach((b) => {
      b.onclick = () => this.addAgent(b.dataset.team as Team);
    });
    this.el.querySelectorAll<HTMLButtonElement>('.sb-minus').forEach((b) => {
      b.onclick = () => this.removeLastAgent(b.dataset.team as Team);
    });
    this.el.querySelectorAll<HTMLButtonElement>('.sb-member').forEach((b) => {
      b.onclick = () => {
        const id = Number(b.dataset.id);
        this.sel = { kind: 'agent', id };
        // 既に操作中の相手をもう一度押したら観戦へ戻す。
        const cur = this.draft.state.agents.find((a) => a.isPlayer);
        this.setPlayer(cur?.id === id ? null : id);
      };
    });
    q<HTMLButtonElement>('.sb-spectate').onclick = () => this.setPlayer(null);
    q<HTMLButtonElement>('.sb-gen').onclick = () => {
      this.draft = this.buildDraft(this.count('hider') || 2, this.count('seeker') || 2);
      this.sel = null;
      this.restructure();
    };
    q<HTMLButtonElement>('.sb-clear').onclick = () => {
      this.draft = this.buildFromLayout({ obstacles: borderWalls(), agents: [], pickups: [] });
      this.sel = null;
      this.restructure();
    };
    q<HTMLButtonElement>('.sb-save').onclick = () => this.save();
    q<HTMLButtonElement>('.sb-load').onclick = () => this.load();
    q<HTMLInputElement>('.sb-prep').onchange = (e) => {
      this.withPrep = (e.target as HTMLInputElement).checked;
    };
    q<HTMLButtonElement>('.sb-start').onclick = () => this.startMatch();
    q<HTMLButtonElement>('.sb-back').onclick = () => {
      this.hide();
      this.onBack();
    };
  }
}

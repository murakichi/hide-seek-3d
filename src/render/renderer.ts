// three.js のセットアップ。見下ろしカメラと、その操作（ズーム・追従・俯瞰）。

import * as THREE from 'three';
import { ARENA_HALF } from '../core/config';

/** カメラの俯角。45 度より少し寝かせて奥行きを出しつつ、遮蔽で見えなくなりすぎないようにする。 */
const CAMERA_PITCH = (57 * Math.PI) / 180;

/** 俯瞰でアリーナ全体を写すのに要る半径。既定のズームでもある。 */
const FIT_RADIUS = ARENA_HALF + 2.5;
/** これ以上は寄れない。人型が画面の 1/8 ほどになる。 */
const MIN_RADIUS = 5;
/** 追従に切り替えたときの既定の寄り。周りの箱と鬼が入るくらい。 */
const FOLLOW_RADIUS = 13;
/** ホイール 1 ノッチぶんの倍率。 */
const ZOOM_STEP = 1.15;

/** 俯瞰＝アリーナ全体を見る、追従＝自分（観戦中は残っている逃走者）を追う。 */
export type CameraMode = 'overhead' | 'follow';

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private sun: THREE.DirectionalLight;

  /** 既定は俯瞰。全体が見えている状態から始める。 */
  private mode: CameraMode = 'overhead';
  /** モードごとのズーム（画面に収める半径 m）。切り替えても各々の寄りを覚えておく */
  private radius: Record<CameraMode, number> = { overhead: FIT_RADIUS, follow: FOLLOW_RADIUS };
  /** いま見ている床の点。追従はここを目標へ寄せていく */
  private center = new THREE.Vector2();
  /** 俯瞰でパンした先。追従から戻ってきても保つ */
  private pan = new THREE.Vector2();
  private panning = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x0d1017);
    this.scene.fog = new THREE.Fog(0x0d1017, 60, 110);

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 200);

    const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x1a1d25, 1.1);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xffffff, 1.9);
    this.sun.position.set(18, 34, 14);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -ARENA_HALF - 6;
    cam.right = ARENA_HALF + 6;
    cam.top = ARENA_HALF + 6;
    cam.bottom = -ARENA_HALF - 6;
    cam.near = 1;
    cam.far = 90;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.buildGround();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.attachControls(canvas);
  }

  /**
   * ホイールでズーム、中ボタンドラッグで俯瞰の視点移動。
   * 左右のボタンは操作（掴む・ロック）に使っているので触らない。
   */
  private attachControls(canvas: HTMLCanvasElement): void {
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY > 0 ? -1 : 1);
      },
      { passive: false },
    );
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.panning = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) this.panning = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (this.panning) this.panBy(e.movementX, e.movementY);
    });
    window.addEventListener('blur', () => {
      this.panning = false;
    });
  }

  get cameraMode(): CameraMode {
    return this.mode;
  }

  setCameraMode(mode: CameraMode): void {
    this.mode = mode;
  }

  toggleCameraMode(): CameraMode {
    this.mode = this.mode === 'overhead' ? 'follow' : 'overhead';
    return this.mode;
  }

  /** steps が正で寄る。ホイール 1 ノッチ / ボタン 1 押しが 1。 */
  zoomBy(steps: number): void {
    const next = this.radius[this.mode] * Math.pow(ZOOM_STEP, -steps);
    this.radius[this.mode] = Math.min(FIT_RADIUS, Math.max(MIN_RADIUS, next));
  }

  /** 俯瞰の視点移動。掴んだ床がカーソルに付いてくる向きに動かす。 */
  private panBy(dxPx: number, dyPx: number): void {
    if (this.mode !== 'overhead') return;
    const perPx = this.worldPerPixel();
    this.pan.x = clamp(this.pan.x - dxPx * perPx, -ARENA_HALF, ARENA_HALF);
    // 床は寝ているぶん、画面の縦方向は奥行きに引き伸ばして効く。
    this.pan.y = clamp(
      this.pan.y - (dyPx * perPx) / Math.sin(CAMERA_PITCH),
      -ARENA_HALF,
      ARENA_HALF,
    );
  }

  /**
   * 毎フレーム呼ぶ。follow はカメラで追う相手の位置（居なければ null）。
   * 追従はそのまま貼り付けるとカメラが小刻みに震えるので、指数で寄せる。
   */
  updateCamera(dt: number, follow: { x: number; z: number } | null): void {
    // 端に居る相手をそのまま中央に置くと画面の半分が場外になる。
    // 見えている範囲がアリーナから大きくはみ出さないところまでで止める。
    const limit = Math.max(0, ARENA_HALF - this.radius[this.mode] * 0.5);
    const wantX = clamp(this.mode === 'follow' && follow ? follow.x : this.pan.x, -limit, limit);
    const wantZ = clamp(this.mode === 'follow' && follow ? follow.z : this.pan.y, -limit, limit);
    const k = 1 - Math.exp(-9 * Math.max(0, Math.min(0.25, dt)));
    this.center.x += (wantX - this.center.x) * k;
    this.center.y += (wantZ - this.center.y) * k;
    this.place();
  }

  /** 画面 1 ピクセルが床の何メートルにあたるか（画面中央での近似）。 */
  private worldPerPixel(): number {
    const vFov = (this.camera.fov * Math.PI) / 180;
    const height = this.renderer.domElement.clientHeight || 1;
    return (2 * Math.tan(vFov / 2) * this.distance()) / height;
  }

  /** いまのズームで、見たい半径が画面に収まるカメラ距離。 */
  private distance(): number {
    const need = this.radius[this.mode];
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    return Math.max(need / Math.tan(vFov / 2), need / Math.tan(hFov / 2)) * 1.05;
  }

  private place(): void {
    const dist = this.distance();
    const cx = this.center.x;
    const cz = this.center.y;
    this.camera.position.set(
      cx,
      Math.sin(CAMERA_PITCH) * dist,
      cz + Math.cos(CAMERA_PITCH) * dist,
    );
    this.camera.lookAt(cx, 0, cz);
    this.camera.updateProjectionMatrix();
  }

  private buildGround(): void {
    const size = ARENA_HALF * 2;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.95, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(size, size / 2, 0x3d4759, 0x333c4b);
    grid.position.y = 0.02;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    // アリーナ外の暗い床（フィールドの縁を分かりやすくする）
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 3, size * 3),
      new THREE.MeshStandardMaterial({ color: 0x151922, roughness: 1 }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.05;
    this.scene.add(outer);
  }

  /**
   * 画面サイズが変わってもズームの意味（画面に収める半径）を保つ。
   * 縦横それぞれの画角から距離を取るので、どの縦横比でも切れない。
   */
  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.place();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

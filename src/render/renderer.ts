// three.js のセットアップ。見下ろし固定カメラ。

import * as THREE from 'three';
import { ARENA_HALF } from '../core/config';

/** カメラの俯角。45 度より少し寝かせて奥行きを出しつつ、遮蔽で見えなくなりすぎないようにする。 */
const CAMERA_PITCH = (57 * Math.PI) / 180;

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private sun: THREE.DirectionalLight;

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

  /** アリーナ全体が画面に収まる高さにカメラを置く。 */
  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;

    // 縦横それぞれの画角から、フィールドが確実に収まる距離を取る。
    // 見下ろしているぶん奥行き方向は縮むので、この見積もりは常に安全側に出る。
    const need = ARENA_HALF + 2.5;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = Math.max(need / Math.tan(vFov / 2), need / Math.tan(hFov / 2)) * 1.05;

    this.camera.position.set(0, Math.sin(CAMERA_PITCH) * dist, Math.cos(CAMERA_PITCH) * dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

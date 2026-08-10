// キーボード + マウスを Action に変換する。カメラ基準の移動と、マウス位置への視線。

import * as THREE from 'three';
import type { Action } from './core/types';

export class InputManager {
  private keys = new Set<string>();
  private pointer = new THREE.Vector2();
  private hasPointer = false;
  private lmb = false;
  private rmb = false;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      // スペースでのページスクロールを止める。
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.hasPointer = true;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.lmb = true;
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** マウスカーソルが指す床の座標。取れなければ null。 */
  aimPoint(camera: THREE.Camera): { x: number; z: number } | null {
    if (!this.hasPointer) return null;
    this.raycaster.setFromCamera(this.pointer, camera);
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, this.hit)) return null;
    return { x: this.hit.x, z: this.hit.z };
  }

  /**
   * 画面基準の入力を作る。カメラは +Z 側から見下ろしているので、
   * 画面の上方向はワールドの -Z、右方向は +X になる。
   */
  buildAction(camera: THREE.Camera, agentX: number, agentZ: number): Action {
    let mx = 0;
    let mz = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) mz -= 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) mz += 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) mx -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) mx += 1;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
    }

    let aimX = 0;
    let aimZ = 0;
    const aim = this.aimPoint(camera);
    if (aim) {
      const dx = aim.x - agentX;
      const dz = aim.z - agentZ;
      const d = Math.hypot(dx, dz);
      if (d > 0.6) {
        aimX = dx / d;
        aimZ = dz / d;
      }
    }

    return {
      moveX: mx,
      moveZ: mz,
      aimX,
      aimZ,
      jump: this.isDown('Space'),
      dash: this.isDown('ShiftLeft') || this.isDown('ShiftRight'),
      grab: this.isDown('KeyE') || this.lmb,
      lock: this.isDown('KeyF') || this.rmb,
      smoke: this.isDown('KeyQ'),
    };
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }
}

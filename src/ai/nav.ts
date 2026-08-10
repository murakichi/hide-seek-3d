// AI 用のグリッド経路探索。障害物は動くので、一定間隔でグリッドを作り直す。

import { ARENA_HALF, AGENT_RADIUS } from '../core/config';
import { blocksHorizontally } from '../core/physics';
import type { Obstacle } from '../core/types';

const CELL = 0.75;

export class NavGrid {
  readonly size: number;
  readonly blocked: Uint8Array;
  /** 各セルを最後に「見た / 通った」時刻。探索の優先度に使う */
  readonly lastVisited: Float32Array;

  constructor() {
    this.size = Math.ceil((ARENA_HALF * 2) / CELL);
    this.blocked = new Uint8Array(this.size * this.size);
    this.lastVisited = new Float32Array(this.size * this.size);
  }

  cx(x: number): number {
    return Math.floor((x + ARENA_HALF) / CELL);
  }

  worldX(cx: number): number {
    return (cx + 0.5) * CELL - ARENA_HALF;
  }

  inBounds(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.size && cz < this.size;
  }

  idx(cx: number, cz: number): number {
    return cz * this.size + cx;
  }

  /**
   * 障害物からブロックマップを作り直す。エージェント半径ぶん膨らませる。
   * blockedCenterRadius に正の値を渡すと中央の円も通行止めにする
   * （準備フェーズ中の鬼のケージ。ここを空けておくと逃げる側が縁に張り付いて動けなくなる）。
   */
  rebuild(obstacles: readonly Obstacle[], blockedCenterRadius = 0): void {
    this.blocked.fill(0);
    const pad = AGENT_RADIUS * 0.9;
    for (const o of obstacles) {
      if (!blocksHorizontally(o, 0)) continue;
      const x0 = this.cx(o.x - o.hw - pad);
      const x1 = this.cx(o.x + o.hw + pad);
      const z0 = this.cx(o.z - o.hd - pad);
      const z1 = this.cx(o.z + o.hd + pad);
      for (let cz = Math.max(0, z0); cz <= Math.min(this.size - 1, z1); cz++) {
        for (let cx = Math.max(0, x0); cx <= Math.min(this.size - 1, x1); cx++) {
          this.blocked[this.idx(cx, cz)] = 1;
        }
      }
    }

    if (blockedCenterRadius > 0) {
      const r = blockedCenterRadius + pad;
      for (let cz = 0; cz < this.size; cz++) {
        for (let cx = 0; cx < this.size; cx++) {
          if (Math.hypot(this.worldX(cx), this.worldX(cz)) < r) this.blocked[this.idx(cx, cz)] = 1;
        }
      }
    }
  }

  isBlockedWorld(x: number, z: number): boolean {
    const cx = this.cx(x);
    const cz = this.cx(z);
    if (!this.inBounds(cx, cz)) return true;
    return this.blocked[this.idx(cx, cz)] === 1;
  }

  /** 塞がれていない最寄りのセルを探す（目標が箱の中にある場合の救済）。 */
  nearestFree(x: number, z: number): { cx: number; cz: number } | null {
    const sx = Math.max(0, Math.min(this.size - 1, this.cx(x)));
    const sz = Math.max(0, Math.min(this.size - 1, this.cx(z)));
    if (this.blocked[this.idx(sx, sz)] === 0) return { cx: sx, cz: sz };
    for (let r = 1; r < 8; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = sx + dx;
          const cz = sz + dz;
          if (!this.inBounds(cx, cz)) continue;
          if (this.blocked[this.idx(cx, cz)] === 0) return { cx, cz };
        }
      }
    }
    return null;
  }

  /**
   * A*。経路をワールド座標の配列で返す。到達不能なら null。
   * グリッドが小さい（48x48 程度）ので毎回フルスキャンでも十分速い。
   */
  findPath(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
  ): Array<{ x: number; z: number }> | null {
    const start = this.nearestFree(fromX, fromZ);
    const goal = this.nearestFree(toX, toZ);
    if (!start || !goal) return null;

    const n = this.size * this.size;
    const startIdx = this.idx(start.cx, start.cz);
    const goalIdx = this.idx(goal.cx, goal.cz);
    if (startIdx === goalIdx) return [{ x: toX, z: toZ }];

    const g = new Float32Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const open = new MinHeap();

    g[startIdx] = 0;
    open.push(startIdx, this.heuristic(start.cx, start.cz, goal.cx, goal.cz));

    const dirs: Array<[number, number, number]> = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ];

    while (open.size > 0) {
      const cur = open.pop();
      if (cur === goalIdx) return this.reconstruct(cameFrom, cur, toX, toZ);
      if (closed[cur]) continue;
      closed[cur] = 1;

      const cx = cur % this.size;
      const cz = (cur - cx) / this.size;

      for (const [dx, dz, cost] of dirs) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!this.inBounds(nx, nz)) continue;
        const ni = this.idx(nx, nz);
        if (this.blocked[ni] || closed[ni]) continue;
        // 斜め移動は角抜けを禁止する。
        if (dx !== 0 && dz !== 0) {
          if (this.blocked[this.idx(cx + dx, cz)] || this.blocked[this.idx(cx, cz + dz)]) continue;
        }
        const ng = g[cur] + cost;
        if (ng < g[ni]) {
          g[ni] = ng;
          cameFrom[ni] = cur;
          open.push(ni, ng + this.heuristic(nx, nz, goal.cx, goal.cz));
        }
      }
    }
    return null;
  }

  private heuristic(ax: number, az: number, bx: number, bz: number): number {
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  }

  private reconstruct(
    cameFrom: Int32Array,
    goal: number,
    toX: number,
    toZ: number,
  ): Array<{ x: number; z: number }> {
    const path: Array<{ x: number; z: number }> = [];
    let cur = goal;
    while (cur >= 0) {
      const cx = cur % this.size;
      const cz = (cur - cx) / this.size;
      path.push({ x: this.worldX(cx), z: this.worldX(cz) });
      cur = cameFrom[cur];
    }
    path.reverse();
    path.shift(); // 現在地は要らない
    if (path.length > 0) path[path.length - 1] = { x: toX, z: toZ };
    return path;
  }
}

/** A* 用の最小ヒープ。 */
class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.prio.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p] <= this.prio[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPrio = this.prio.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.prio[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.items.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}

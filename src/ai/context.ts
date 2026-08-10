// AI 全体で共有する情報（ナビゲーショングリッド、チーム単位の申し合わせ）と共通ヘルパー。

import { AGENT_RADIUS, ARENA_HALF, DT, EYE_HEIGHT } from '../core/config';
import type { Game } from '../core/game';
import { hasLineOfSight } from '../core/physics';
import { Rng } from '../core/rng';
import type { Action, Agent, Obstacle } from '../core/types';
import { NavGrid } from './nav';
import type { AiParams } from './params';

export interface AiContext {
  game: Game;
  nav: NavGrid;
  params: AiParams;
  rng: Rng;
  /**
   * 逃げる側の拠点。エージェントごとに別の場所を割り当てる。
   * 全員で 1 箇所に固まると、そこを見つけられた時点で全滅するため。
   */
  shelters: Map<number, { x: number; z: number }>;
  /** 鬼チームが共有する「このセルを最後に見た時刻」マップ */
  seekerExplore: Float32Array;
  /** 鬼が今どこへ向かっているか。担当がバラけるように参照する */
  seekerGoals: Map<number, { x: number; z: number }>;
  time: number;
}

export function emptyAction(): Action {
  return {
    moveX: 0,
    moveZ: 0,
    aimX: 0,
    aimZ: 0,
    jump: false,
    dash: false,
    grab: false,
    lock: false,
    smoke: false,
  };
}

/** 経路に沿って進むための移動ベクトル。到達済みのウェイポイントは捨てる。 */
export function followPath(
  agent: Agent,
  path: Array<{ x: number; z: number }>,
): { mx: number; mz: number } {
  while (path.length > 0) {
    const wp = path[0];
    const d = Math.hypot(wp.x - agent.x, wp.z - agent.z);
    // 到達とみなす距離は移動速度に見合わせる。狭すぎると通過点を捉えきれず、
    // 目標を行き過ぎてから戻る動きになって失速する。
    if (d < 1.1 && path.length > 1) {
      path.shift();
      continue;
    }
    if (d < 0.5) {
      path.shift();
      continue;
    }
    return { mx: (wp.x - agent.x) / d, mz: (wp.z - agent.z) / d };
  }
  return { mx: 0, mz: 0 };
}

/** 目標が近く、間に遮蔽が無ければ直進する（経路探索のガタつきを消す）。 */
export function directIfClear(
  ctx: AiContext,
  agent: Agent,
  tx: number,
  tz: number,
): { mx: number; mz: number } | null {
  const dx = tx - agent.x;
  const dz = tz - agent.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return { mx: 0, mz: 0 };
  const y = agent.y + 0.6;
  if (!hasLineOfSight(ctx.game.state.obstacles, agent.x, y, agent.z, tx, y, tz)) return null;
  return { mx: dx / d, mz: dz / d };
}

/**
 * 進行方向の足元に段差があればジャンプする（箱に登る / 引っかかりを抜ける）。
 * eager を立てると、詰まる前でも障害物を見つけた時点で跳ぶ。
 * 高所に逃げた相手を追うときは、減速を待っていると足場に乗れない。
 */
export function shouldJump(
  ctx: AiContext,
  agent: Agent,
  mx: number,
  mz: number,
  eager = false,
): boolean {
  if (!agent.grounded) return false;
  const speed = Math.hypot(agent.vx, agent.vz);
  const probe = AGENT_RADIUS + (eager ? 1.1 : 0.7);
  const px = agent.x + mx * probe;
  const pz = agent.z + mz * probe;
  if (!ctx.nav.isBlockedWorld(px, pz)) return false;
  if (eager) return true;
  // 目標方向に進みたいのに速度が出ていない = 詰まっている。
  return speed < 1.6 || nearRamp(ctx.game.state.obstacles, px, pz);
}

function nearRamp(obstacles: readonly Obstacle[], x: number, z: number): boolean {
  for (const o of obstacles) {
    if (o.kind !== 'ramp') continue;
    if (Math.abs(x - o.x) < o.hw + 1 && Math.abs(z - o.z) < o.hd + 1) return true;
  }
  return false;
}

/** 拾える状態にある最寄りの補給パック。範囲外なら null。 */
export function nearestPickup(
  ctx: AiContext,
  agent: Agent,
  maxDist: number,
): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bestD = maxDist;
  for (const p of ctx.game.state.pickups) {
    if (!p.active) continue;
    const d = Math.hypot(p.x - agent.x, p.z - agent.z);
    if (d < bestD) {
      bestD = d;
      best = { x: p.x, z: p.z };
    }
  }
  return best;
}

/** 指定地点が観測者から見えるか（遮蔽の有無だけを見る簡易版）。 */
export function isCovered(
  obstacles: readonly Obstacle[],
  observer: Agent,
  x: number,
  z: number,
): boolean {
  return !hasLineOfSight(
    obstacles,
    observer.x,
    observer.y + EYE_HEIGHT,
    observer.z,
    x,
    1.0,
    z,
  );
}

export function clampToArena(v: number): number {
  const lim = ARENA_HALF - AGENT_RADIUS - 0.2;
  return Math.max(-lim, Math.min(lim, v));
}

/** 一定間隔でだけ true を返すタイマー。AI の思考頻度を落とすのに使う。 */
export class Ticker {
  private acc: number;
  constructor(private interval: number, offset = 0) {
    this.acc = offset;
  }
  ready(): boolean {
    this.acc -= DT;
    if (this.acc <= 0) {
      this.acc = this.interval;
      return true;
    }
    return false;
  }
  force(): void {
    this.acc = 0;
  }
}

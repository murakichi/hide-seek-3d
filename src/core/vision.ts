// 「誰が誰を見えているか」の判定。隠れる意味を成立させる中核。

import {
  EYE_HEIGHT,
  HIDER_SENSE_DIST,
  PERIPHERAL_DIST,
  SMOKE_HEIGHT,
  SMOKE_RADIUS,
  VIEW_DIST,
  viewDistFor,
  VIEW_FOV,
} from './config';
import { angleDiff, hasLineOfSight, segmentHitsSphere } from './physics';
import type { Agent, GameState, Team } from './types';

/** observer から target が見えるか。 */
export function canSee(state: GameState, observer: Agent, target: Agent): boolean {
  const dx = target.x - observer.x;
  const dz = target.z - observer.z;
  const dist = Math.hypot(dx, dz);
  // 鬼の視界だけ人数で割る（盤面あたりの探索能力を一定にするため）。
  const range = observer.team === 'seeker' ? viewDistFor(state.config.seekers) : VIEW_DIST;
  if (dist > range) return false;

  const peripheral = observer.team === 'hider' ? HIDER_SENSE_DIST : PERIPHERAL_DIST;
  if (dist > peripheral) {
    const ang = Math.atan2(dx, dz);
    if (Math.abs(angleDiff(ang, observer.facing)) > VIEW_FOV / 2) return false;
  }

  // 胴体中央を狙って 1 本、頭を狙って 1 本。片方でも通れば見えている扱い。
  const oy = observer.y + EYE_HEIGHT;
  const clear =
    hasLineOfSight(state.obstacles, observer.x, oy, observer.z, target.x, target.y + 0.9, target.z) ||
    hasLineOfSight(
      state.obstacles,
      observer.x,
      oy,
      observer.z,
      target.x,
      target.y + EYE_HEIGHT,
      target.z,
    );
  if (!clear) return false;

  return !smokeBlocks(state, observer.x, oy, observer.z, target.x, target.y + 1.1, target.z);
}

/** 2 点を結ぶ視線が煙に遮られているか。 */
export function smokeBlocks(
  state: GameState,
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
): boolean {
  for (const smoke of state.smokes) {
    if (
      segmentHitsSphere(x1, y1, z1, x2, y2, z2, smoke.x, SMOKE_HEIGHT, smoke.z, SMOKE_RADIUS)
    ) {
      return true;
    }
  }
  return false;
}

/** team の誰か 1 人でも見えている敵の ID 集合。 */
export function visibleEnemies(state: GameState, team: Team): Set<number> {
  const seen = new Set<number>();
  const observers = state.agents.filter((a) => a.team === team && !a.caught);
  const targets = state.agents.filter((a) => a.team !== team && !a.caught);
  for (const t of targets) {
    for (const o of observers) {
      if (canSee(state, o, t)) {
        seen.add(t.id);
        break;
      }
    }
  }
  return seen;
}

/** 視界情報からチームの「最後に見た位置」メモを更新する。 */
export function updateMemory(state: GameState): { hider: Set<number>; seeker: Set<number> } {
  const result = {
    hider: visibleEnemies(state, 'hider'),
    // 準備フェーズ中の鬼は目隠しされている扱い。ここを開けていると
    // 隠れる過程が丸見えになり、放たれた瞬間に直行されて隠れる意味が消える。
    seeker: state.phase === 'prep' ? new Set<number>() : visibleEnemies(state, 'seeker'),
  };
  for (const team of ['hider', 'seeker'] as Team[]) {
    const mem = state.memory[team];
    for (const id of result[team]) {
      const a = state.agents[id];
      mem.set(id, { x: a.x, z: a.z, t: state.time });
      a.lastSeenAt = state.time;
    }
  }
  return result;
}

// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// issue #002「逃走が壁沿いの往復になり、鬼の前を何度も横切る」を数値で確かめる。
//
// 測るもの:
//   - 壁沿い: 逃走中に壁まで 6m 未満だったティックの割合
//   - 折り返し: 進行方向が 1.5 秒前と 120 度以上ずれた回数
//   - 往復: 6〜20 秒前に居た場所から 5m 以内へ戻った回数
//   - その往復の直後（3 秒以内）に再発見された回数
//   - 煙幕が実戦で使われているか（issue #002 の未計測項目）
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { ARENA_HALF, DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { Agent, GameState, MatchConfig } from '../core/types';
import { canSee } from '../core/vision';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 40;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const SEED0 = Number(process.argv[4] ?? 1234);
const TRIGGER = DEFAULT_PARAMS.hider.fleeTriggerDist;

/** hider.ts の knownThreats を再現して、逃走モードかどうかを判定する。 */
function fleeing(s: GameState, agent: Agent): boolean {
  let best = Infinity;
  for (const a of s.agents) {
    if (a.team !== 'seeker' || a.caught) continue;
    let pos: { x: number; z: number } | null = null;
    if (canSee(s, agent, a)) pos = { x: a.x, z: a.z };
    else {
      const rec = s.memory.hider.get(a.id);
      if (rec && s.time - rec.t < 4) pos = { x: rec.x, z: rec.z };
    }
    if (pos) best = Math.min(best, Math.hypot(pos.x - agent.x, pos.z - agent.z));
  }
  return best < TRIGGER;
}

let fleeTicks = 0;
let wallTicks = 0;
let reversals = 0;
let revisits = 0;
let revisitThenSeen = 0;
let detects = 0;
let smokeUsed = 0;
let smokeHeldAtCatch = 0;
let caught = 0;
let wallGapAtCatch = 0;

const TRAIL = Math.round(20 / DT);
const REV_LAG = Math.round(1.5 / DT);

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);

  const trail = new Map<number, Array<{ x: number; z: number; t: number }>>();
  const heading = new Map<number, Array<{ x: number; z: number }>>();
  const lastRevisit = new Map<number, number>();
  const wasSeen = new Map<number, boolean>();
  const prevSmoke = new Map<number, number>();
  const prevCaught = new Set<number>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      const seekers = s.agents.filter((a) => a.team === 'seeker' && !a.caught);
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;

        const ps = prevSmoke.get(a.id);
        if (ps !== undefined && a.smokeCharges < ps) smokeUsed++;
        prevSmoke.set(a.id, a.smokeCharges);

        const isFlee = fleeing(s, a);
        if (isFlee) {
          fleeTicks++;
          const gap = Math.min(ARENA_HALF - Math.abs(a.x), ARENA_HALF - Math.abs(a.z));
          if (gap < 6) wallTicks++;
        }

        // 進行方向の折り返し
        const hs = heading.get(a.id) ?? [];
        const speed = Math.hypot(a.vx, a.vz);
        hs.push(speed > 1 ? { x: a.vx / speed, z: a.vz / speed } : { x: 0, z: 0 });
        if (hs.length > REV_LAG + 1) hs.shift();
        if (isFlee && hs.length > REV_LAG) {
          const old = hs[0];
          const now = hs[hs.length - 1];
          const mag = Math.hypot(old.x, old.z) * Math.hypot(now.x, now.z);
          if (mag > 0.5 && old.x * now.x + old.z * now.z < -0.5) reversals++;
        }
        heading.set(a.id, hs);

        // 往復: 6〜20 秒前の自分の位置へ 5m 以内まで戻った
        const tr = trail.get(a.id) ?? [];
        if (isFlee && s.time - (lastRevisit.get(a.id) ?? -99) > 3) {
          for (const pt of tr) {
            const age = s.time - pt.t;
            if (age < 6 || age > 20) continue;
            if (Math.hypot(pt.x - a.x, pt.z - a.z) < 5) {
              revisits++;
              lastRevisit.set(a.id, s.time);
              break;
            }
          }
        }
        tr.push({ x: a.x, z: a.z, t: s.time });
        if (tr.length > TRAIL) tr.shift();
        trail.set(a.id, tr);

        const visible = seekers.some((k) => canSee(s, k, a));
        if (visible && !(wasSeen.get(a.id) ?? false)) {
          detects++;
          if (s.time - (lastRevisit.get(a.id) ?? -99) < 3) revisitThenSeen++;
        }
        wasSeen.set(a.id, visible);
      }
    }

    game.step(actions);

    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caught++;
      smokeHeldAtCatch += a.smokeCharges;
      wallGapAtCatch += Math.min(ARENA_HALF - Math.abs(a.x), ARENA_HALF - Math.abs(a.z));
    }
    if (game.state.phase === 'over') break;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  逃走モードのティック: ${fleeTicks}`);
console.log(`    壁まで 6m 未満: ${wallTicks} (${pct(wallTicks, fleeTicks)})  ※面積比なら 47%`);
console.log(`    折り返し(1.5 秒で 120 度超): ${reversals}`);
console.log(`  往復(6〜20 秒前の位置へ 5m 以内に戻った): ${revisits}`);
console.log(`  発見イベント: ${detects}`);
console.log(`    直前 3 秒に往復していた: ${revisitThenSeen} (${pct(revisitThenSeen, detects)})`);
console.log(`  煙幕の使用: ${smokeUsed} 回`);
console.log(`  捕獲: ${caught}`);
console.log(`    捕獲時に残っていた煙幕: 平均 ${(smokeHeldAtCatch / Math.max(1, caught)).toFixed(2)} 回ぶん`);
console.log(
  `    捕獲地点の壁までの距離: 平均 ${(wallGapAtCatch / Math.max(1, caught)).toFixed(1)}m  ※一様なら 7.3m`,
);

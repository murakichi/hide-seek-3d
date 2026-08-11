// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// issue #21 / #13。「高所は本当に安全か」「そもそも登れているか」を測る。
//
//   - 追跡中に到達した最高高度
//   - CATCH_VERTICAL(1.6) を超える高さに居たティック（地上の鬼からは捕獲不能）
//   - その高さで捕まった回数
//   - 大箱（上面 > 1.6）のうち「地上から登れる踏み台が 3m 以内に無い」ものの数
//     ＝ 踏み台をどければ鬼が登れなくなる候補
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { CATCH_VERTICAL, CLIMB_REACH, DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 40;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const SEED0 = Number(process.argv[4] ?? 1234);

let huntTicks = 0;
let aboveCatchTicks = 0;
let anyHeightTicks = 0;
let maxHeightSum = 0;
let hiderCount = 0;
let caught = 0;
let caughtHigh = 0;
/** 追跡開始時点の「高所」候補 */
let perches = 0;
let perchesIsolated = 0;
let gamesWithIsolated = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const maxH = new Map<number, number>();
  const prevCaught = new Set<number>();
  let counted = false;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      if (!counted) {
        counted = true;
        // 追跡開始時点の地形を数える
        let iso = 0;
        for (const o of s.obstacles) {
          if (o.kind === 'wall' || o.kind === 'ramp' || o.kind === 'pad') continue;
          const top = o.y + o.h;
          if (top <= CATCH_VERTICAL) continue; // 立っても捕獲を防げない
          perches++;
          // 地上から登れる踏み台（上面 <= CLIMB_REACH）が近くにあるか
          let step = false;
          for (const q of s.obstacles) {
            if (q.id === o.id || q.kind === 'wall') continue;
            const qtop = q.y + q.h;
            const climbableFromGround = q.kind === 'pad' || q.kind === 'ramp' || qtop <= CLIMB_REACH;
            if (!climbableFromGround) continue;
            // その踏み台の上から o の上面へ届くか
            const reachTop = q.kind === 'pad' ? 3.0 : qtop + CLIMB_REACH;
            if (reachTop < top) continue;
            const gap =
              Math.hypot(q.x - o.x, q.z - o.z) - Math.max(o.hw, o.hd) - Math.max(q.hw, q.hd);
            if (gap < 3) {
              step = true;
              break;
            }
          }
          if (!step) iso++;
        }
        perchesIsolated += iso;
        if (iso > 0) gamesWithIsolated++;
      }

      huntTicks += s.agents.filter((a) => a.team === 'hider' && !a.caught).length;
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        if (a.y > 0.4) anyHeightTicks++;
        if (a.y > CATCH_VERTICAL) aboveCatchTicks++;
        maxH.set(a.id, Math.max(maxH.get(a.id) ?? 0, a.y));
      }
    }

    const yBefore = new Map(
      game.state.agents.filter((a) => a.team === 'hider').map((a) => [a.id, a.y]),
    );
    game.step(actions);
    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caught++;
      if ((yBefore.get(a.id) ?? 0) > CATCH_VERTICAL) caughtHigh++;
    }
    if (game.state.phase === 'over') break;
  }

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    hiderCount++;
    maxHeightSum += maxH.get(a.id) ?? 0;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(2)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  CATCH_VERTICAL=${CATCH_VERTICAL}  CLIMB_REACH=${CLIMB_REACH.toFixed(2)}`);
console.log(`  追跡中のティック(逃げる側のべ): ${huntTicks}`);
console.log(`    y > 0.4（何かに乗っている）: ${anyHeightTicks} (${pct(anyHeightTicks, huntTicks)})`);
console.log(
  `    y > ${CATCH_VERTICAL}（地上からは捕獲不能）: ${aboveCatchTicks} (${pct(aboveCatchTicks, huntTicks)})`,
);
console.log(`  1 人あたりの到達最高高度: 平均 ${(maxHeightSum / Math.max(1, hiderCount)).toFixed(2)}`);
console.log(`  捕獲 ${caught} 件  うち y > ${CATCH_VERTICAL} で捕まった: ${caughtHigh}`);
console.log(
  `  高所候補（上面 > ${CATCH_VERTICAL}）: 1 試合あたり ${(perches / GAMES).toFixed(1)} 個  ` +
    `うち踏み台が 3m 以内に無い: ${(perchesIsolated / GAMES).toFixed(1)} 個`,
);
console.log(`  「孤立した高所」が 1 個以上ある試合: ${gamesWithIsolated} / ${GAMES}`);

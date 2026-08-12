// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 「既存の高台に複数人が集まっていないか」を見る。
//
// 前サイクルの教訓: 発火回数ではなく **その挙動を取った人の生存率** を見る。
// 建設側（PR #67）では予約で 21.7% -> 38.1% になった。既存の高台でも同じか。
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { CATCH_VERTICAL, DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 2);
const SEEKERS = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 1234);

let totalHiders = 0;
let survivors = 0;
let startedHigh = 0;
let startedHighSurvived = 0;
/** 追跡開始時、高台に「2 人以上」で乗っていた人数 */
let crowded = 0;
let crowdedSurvived = 0;
let highTicks = 0;
let huntTicks = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const startedHighIds = new Set<number>();
  const crowdedIds = new Set<number>();
  let counted = false;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      if (!counted) {
        counted = true;
        const high = s.agents.filter((a) => a.team === 'hider' && a.y > CATCH_VERTICAL);
        for (const a of high) {
          startedHigh++;
          startedHighIds.add(a.id);
          // 半径 4m 以内に別の高台組が居るなら「固まっている」
          const near = high.some(
            (b) => b.id !== a.id && Math.hypot(b.x - a.x, b.z - a.z) < 4,
          );
          if (near) {
            crowded++;
            crowdedIds.add(a.id);
          }
        }
      }
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        huntTicks++;
        if (a.y > CATCH_VERTICAL) highTicks++;
      }
    }

    game.step(actions);
    if (game.state.phase === 'over') break;
  }

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    if (!a.caught) {
      survivors++;
      if (startedHighIds.has(a.id)) startedHighSurvived++;
      if (crowdedIds.has(a.id)) crowdedSurvived++;
    }
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  追跡開始時に高台へ立てていた: ${startedHigh} / ${totalHiders} 人 (${pct(startedHigh, totalHiders)})`);
console.log(`    そのうち生存: ${startedHighSurvived} / ${startedHigh} (${pct(startedHighSurvived, startedHigh)})`);
console.log(`  そのうち 4m 以内に味方が居た（固まり）: ${crowded} 人 (${pct(crowded, startedHigh)})`);
console.log(`    そのうち生存: ${crowdedSurvived} / ${crowded} (${pct(crowdedSurvived, crowded)})`);
console.log(`  高台に居たティック: ${pct(highTicks, huntTicks)}`);
console.log(`  全体の生存率: ${pct(survivors, totalHiders)}`);

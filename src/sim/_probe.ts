// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// PR #50（鬼が隙間を跳べるようになった）のあと、高台がまだ効いているかを見る。
//
//   - 追跡開始時に高台（y > CATCH_VERTICAL）に居た人数
//   - その人が最後まで生き残った割合
//   - 高台に居る間に鬼が同じ高さ帯（|y差| < CATCH_VERTICAL）へ来た回数
//   - 高台の上で捕まった回数
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

let startedHigh = 0;
let startedHighSurvived = 0;
let totalHiders = 0;
let survivors = 0;
let highTicks = 0;
let huntTicks = 0;
let seekerReachedHigh = 0; // 高台に居る人へ鬼が同じ高さ帯まで来たティック
let caughtHigh = 0;
let caught = 0;

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
  const prevCaught = new Set<number>();
  let counted = false;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      if (!counted) {
        counted = true;
        for (const a of s.agents) {
          if (a.team !== 'hider') continue;
          if (a.y > CATCH_VERTICAL) {
            startedHigh++;
            startedHighIds.add(a.id);
          }
        }
      }
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        huntTicks++;
        if (a.y <= CATCH_VERTICAL) continue;
        highTicks++;
        const near = s.agents.some(
          (k) =>
            k.team === 'seeker' &&
            !k.caught &&
            Math.abs(k.y - a.y) < CATCH_VERTICAL &&
            Math.hypot(k.x - a.x, k.z - a.z) < 13,
        );
        if (near) seekerReachedHigh++;
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
    totalHiders++;
    if (!a.caught) {
      survivors++;
      if (startedHighIds.has(a.id)) startedHighSurvived++;
    }
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  追跡開始時に高台に居た: ${startedHigh} / ${totalHiders} 人 (${pct(startedHigh, totalHiders)})`);
console.log(`    そのうち最後まで生き残った: ${startedHighSurvived} / ${startedHigh} (${pct(startedHighSurvived, startedHigh)})`);
console.log(`  全体の生存率: ${pct(survivors, totalHiders)}`);
console.log(`  高台に居たティック: ${pct(highTicks, huntTicks)}`);
console.log(`    うち鬼が同じ高さ帯 13m 以内まで来ていた: ${pct(seekerReachedHigh, highTicks)}`);
console.log(`  捕獲 ${caught} 件  うち高台の上で: ${caughtHigh} (${pct(caughtHigh, caught)})`);

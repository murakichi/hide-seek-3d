// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
//
// A. 高所（issue #13）— 待機先を高所にする変更が効いているか
//    - 追跡中に y > CATCH_VERTICAL(1.6) に居たティック（地上からは捕獲不能）
//    - その高さで捕まった回数
//
// B. 運搬の空回り（ユーザーからの指摘）— 箱が壁に引っ掛かって同じ動作を繰り返していないか
//    - 準備フェーズで「掴んでいるのに箱が動いていない」ティックの割合
//    - 同じ箱を掴み直した回数（諦めても戻ってきていないか）
//    - 準備フェーズのうち、空回りに溶けた秒数
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { CATCH_VERTICAL, DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const SEED0 = Number(process.argv[4] ?? 1234);

// A
let huntTicks = 0;
let highTicks = 0;
let caught = 0;
let caughtHigh = 0;
let survived = 0;
let totalHiders = 0;

// B
let holdTicks = 0; // 箱を掴んでいたティック
let stalledTicks = 0; // 掴んでいるのに箱が動いていないティック
let regrabs = 0; // 一度離した箱をまた掴んだ回数
let grabs = 0;
let lockedAtHunt = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const prevCaught = new Set<number>();
  const prevGrab = new Map<number, number>();
  const grabbedBefore = new Map<number, Set<number>>();
  const lastBoxPos = new Map<number, { x: number; z: number }>();
  let countedLocks = false;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'prep') {
      for (const a of s.agents) {
        if (a.team !== 'hider') continue;
        const held = a.grabbed;
        const prev = prevGrab.get(a.id) ?? -1;
        if (held >= 0 && held !== prev) {
          grabs++;
          const seen = grabbedBefore.get(a.id) ?? new Set<number>();
          if (seen.has(held)) regrabs++;
          seen.add(held);
          grabbedBefore.set(a.id, seen);
        }
        prevGrab.set(a.id, held);

        if (held >= 0) {
          holdTicks++;
          const box = s.obstacles[held];
          const last = lastBoxPos.get(held);
          if (last && Math.hypot(box.x - last.x, box.z - last.z) < 0.02) stalledTicks++;
          lastBoxPos.set(held, { x: box.x, z: box.z });
        }
      }
    } else if (s.phase === 'hunt') {
      if (!countedLocks) {
        countedLocks = true;
        lockedAtHunt += s.obstacles.filter((o) => o.lockedBy === 'hider').length;
      }
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        huntTicks++;
        if (a.y > CATCH_VERTICAL) highTicks++;
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
    if (!a.caught) survived++;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(2)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log('  [A] 高所');
console.log(`    y > ${CATCH_VERTICAL} に居たティック: ${highTicks} / ${huntTicks} (${pct(highTicks, huntTicks)})`);
console.log(`    捕獲 ${caught} 件  うちその高さで捕まった: ${caughtHigh}`);
console.log(`    生存 ${survived} / ${totalHiders} 人 (${pct(survived, totalHiders)})`);
console.log('  [B] 運搬の空回り（準備フェーズ）');
console.log(`    掴んでいたティック: ${holdTicks}  1 試合あたり ${(holdTicks * DT / GAMES).toFixed(1)} 秒`);
console.log(
  `    うち箱が動いていない: ${stalledTicks} (${pct(stalledTicks, holdTicks)})  ` +
    `1 試合あたり ${(stalledTicks * DT / GAMES).toFixed(1)} 秒`,
);
console.log(`    掴み直し: ${grabs} 回中 ${regrabs} 回が「前にも掴んだ箱」 (${pct(regrabs, grabs)})`);
console.log(`    追跡開始時のロック箱数: ${(lockedAtHunt / GAMES).toFixed(1)} 個/試合`);

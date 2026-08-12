// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 捕獲の 72.5%(3v3) は鬼 1 人によるもの。逃げる側の方が速い（9.4 対 8.8）のに
// 1 対 1 で捕まっているので、**追跡中の実効速度**を見る。
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HIDER_SPEED, HUNT_TIME, PREP_TIME, SEEKER_SPEED } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 2);
const SEEKERS = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 1234);
/** 「追われている」とみなす距離 */
const NEAR = 13;

let chaseTicks = 0;
let hiderSpeedSum = 0;
let seekerSpeedSum = 0;
/** 逃げる側が «鬼から遠ざかる» 向きに進めていた割合（内積 > 0） */
let awayTicks = 0;
/** 距離の変化量の合計（正なら離せている） */
let gapDelta = 0;
/** 逃げる側の速度が最大の 60% を下回っていたティック */
let slowTicks = 0;
/** 追跡が «途切れた»（NEAR の外に出た）あと 3 秒以内に また追われた回数 */
let reChase = 0;
let chaseEnd = 0;
let totalHiders = 0;
let survivors = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const wasChased = new Map<number, boolean>();
  const lastChaseEnd = new Map<number, number>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        let best = null;
        let bestD = NEAR;
        for (const sk of s.agents) {
          if (sk.team !== 'seeker' || sk.caught) continue;
          const d = Math.hypot(sk.x - a.x, sk.z - a.z);
          if (d < bestD) {
            bestD = d;
            best = sk;
          }
        }
        const chased = best !== null;
        const prev = wasChased.get(a.id) ?? false;
        if (chased && !prev) {
          const end = lastChaseEnd.get(a.id);
          if (end !== undefined && s.time - end < 3) reChase++;
        }
        if (!chased && prev) {
          chaseEnd++;
          lastChaseEnd.set(a.id, s.time);
        }
        wasChased.set(a.id, chased);
        if (!best) continue;

        chaseTicks++;
        const hs = Math.hypot(a.vx, a.vz);
        hiderSpeedSum += hs;
        seekerSpeedSum += Math.hypot(best.vx, best.vz);
        if (hs < HIDER_SPEED * 0.6) slowTicks++;
        // 鬼から遠ざかる向きに進めているか
        const len = Math.hypot(a.x - best.x, a.z - best.z) || 1;
        const dot = (a.vx * (a.x - best.x)) / len + (a.vz * (a.z - best.z)) / len;
        if (dot > 0) awayTicks++;
        gapDelta += dot * DT;
      }
    }

    game.step(actions);
    if (game.state.phase === 'over') break;
  }

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    if (!a.caught) survivors++;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})  追跡=${NEAR}m 以内`);
console.log(`  全体の生存率: ${pct(survivors, totalHiders)}`);
console.log(`  追跡ティック: ${chaseTicks}`);
console.log(`  平均速度  逃 ${(hiderSpeedSum / Math.max(1, chaseTicks)).toFixed(2)} / 上限 ${HIDER_SPEED}   鬼 ${(seekerSpeedSum / Math.max(1, chaseTicks)).toFixed(2)} / 上限 ${SEEKER_SPEED}`);
console.log(`  逃げる側が上限の 60% 未満だった: ${pct(slowTicks, chaseTicks)}`);
console.log(`  鬼から遠ざかる向きに進めていた: ${pct(awayTicks, chaseTicks)}`);
console.log(`  距離の増減（合計）: ${gapDelta.toFixed(0)} m`);
console.log(`  追跡が切れた回数: ${chaseEnd}   うち 3 秒以内に再開: ${reChase} (${pct(reChase, chaseEnd)})`);

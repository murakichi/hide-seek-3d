// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 追跡中、逃げる側は上限の 60% 未満のティックが 16.3% あった。
// **鬼側と比べて、どちらがより «詰まって» いるのか**を見る。
//
// 逃げる側は毎ティック向きを選び直すので、鬼より曲がりが多く、
// 障害物に当たって速度を失っている可能性がある。
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
const NEAR = 13;

let chaseTicks = 0;
let hSlow = 0;
let sSlow = 0;
/** 入力（moveX/moveZ）は出ているのに実速度が上限の 60% 未満 = 何かに当たっている */
let hBlocked = 0;
let sBlocked = 0;
/** 前ティックからの進行方向の変化（度）の合計 */
let hTurn = 0;
let sTurn = 0;
let turnN = 0;
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
  const prevHeading = new Map<number, number>();

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
        if (!best) continue;
        chaseTicks++;

        const measure = (
          ag: typeof a,
          cap: number,
          onSlow: () => void,
          onBlocked: () => void,
        ): number => {
          const sp = Math.hypot(ag.vx, ag.vz);
          if (sp < cap * 0.6) {
            onSlow();
            const act = actions.get(ag.id);
            const input = act ? Math.hypot(act.moveX, act.moveZ) : 0;
            if (input > 0.5) onBlocked();
          }
          const head = Math.atan2(ag.vx, ag.vz);
          const prev = prevHeading.get(ag.id);
          prevHeading.set(ag.id, head);
          if (prev === undefined || sp < 1) return 0;
          let d = Math.abs(head - prev);
          if (d > Math.PI) d = Math.PI * 2 - d;
          return (d * 180) / Math.PI;
        };

        hTurn += measure(a, HIDER_SPEED, () => hSlow++, () => hBlocked++);
        sTurn += measure(best, SEEKER_SPEED, () => sSlow++, () => sBlocked++);
        turnN++;
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
console.log(`  全体の生存率: ${pct(survivors, totalHiders)}   追跡ティック ${chaseTicks}`);
console.log(`  上限の 60% 未満だったティック   逃 ${pct(hSlow, chaseTicks)}   鬼 ${pct(sSlow, chaseTicks)}`);
console.log(`    うち入力は出ていた（＝当たっている） 逃 ${pct(hBlocked, chaseTicks)}   鬼 ${pct(sBlocked, chaseTicks)}`);
console.log(`  1 ティックあたりの進行方向の変化   逃 ${(hTurn / Math.max(1, turnN)).toFixed(2)} 度   鬼 ${(sTurn / Math.max(1, turnN)).toFixed(2)} 度`);

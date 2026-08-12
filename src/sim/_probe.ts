// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 「高台を作る」が成立しているかを見る。
//
//   - 追跡開始時に「ジャンプ台の隣にある、踏み台の無い高台」が何個あるか
//   - 追跡開始時に高台（y > CATCH_VERTICAL）へ立てていた人数
//   - 高台に居たティックの割合と、その人の生存率
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { AGENT_RADIUS, CATCH_VERTICAL, DT, GRAVITY, HUNT_TIME, PAD_JUMP_SPEED, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const PAD_REACH = (PAD_JUMP_SPEED * PAD_JUMP_SPEED) / (2 * GRAVITY);
const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 2);
const SEEKERS = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 1234);
const GAP = DEFAULT_PARAMS.hider.gapHopReach;
const ISO = DEFAULT_PARAMS.hider.perchIsolation;

let readyPerches = 0;
let startedHigh = 0;
let startedHighSurvived = 0;
let totalHiders = 0;
let survivors = 0;
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
  let counted = false;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      if (!counted) {
        counted = true;
        // 「台の隣にある、踏み台の無い高台」を数える
        for (const o of s.obstacles) {
          if (o.kind === 'wall' || o.kind === 'pad' || o.kind === 'ramp') continue;
          const top = o.y + o.h;
          if (top <= CATCH_VERTICAL || top > PAD_REACH) continue;
          const nearPad = s.obstacles.some(
            (q) =>
              q.kind === 'pad' &&
              Math.hypot(q.x - o.x, q.z - o.z) - Math.max(o.hw, o.hd) - AGENT_RADIUS <= GAP,
          );
          if (!nearPad) continue;
          const hasStep = s.obstacles.some(
            (q) =>
              q.id !== o.id &&
              q.kind !== 'wall' &&
              q.y + q.h <= 1.64 &&
              Math.hypot(q.x - o.x, q.z - o.z) - Math.max(q.hw, q.hd) < ISO,
          );
          if (!hasStep) readyPerches++;
        }
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
    }
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  追跡開始時の「台の隣・踏み台なし」高台: ${(readyPerches / GAMES).toFixed(2)} 個/試合`);
console.log(`  追跡開始時に高台へ立てていた: ${startedHigh} / ${totalHiders} 人 (${pct(startedHigh, totalHiders)})`);
console.log(`    そのうち生存: ${startedHighSurvived} / ${startedHigh} (${pct(startedHighSurvived, startedHigh)})`);
console.log(`  高台に居たティック: ${pct(highTicks, huntTicks)}`);
console.log(`  全体の生存率: ${pct(survivors, totalHiders)}`);

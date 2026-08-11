// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// issue #32「ロックした箱が鬼を呼び寄せる」を数値で確かめる。
//
//   - ロック箱は拠点のどれくらい近くに固まっているか
//   - 鬼が追跡フェーズの何割を「ロック箱の 5m 以内」で過ごしているか
//     （`pickPatrolGoal` が加点する範囲そのもの）
//   - 追跡開始から、鬼が最初に誰かの拠点へ 6m 以内に来るまでの時間
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const SEED0 = Number(process.argv[4] ?? 1234);
/** 鬼の巡回採点がロック箱を加点する半径 */
const LURE_R = 5;

let lockedCount = 0;
let lockedNearShelter = 0;
let seekerTicks = 0;
let seekerNearLocked = 0;
let reachTimes: number[] = [];
let neverReached = 0;
let caught = 0;
let totalHiders = 0;
let survived = 0;

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
  let counted = false;
  let huntStart = 0;
  let reached = -1;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      const shelters = s.agents
        .filter((a) => a.team === 'hider')
        .map((a) => ai.shelterOf(a.id))
        .filter((v): v is { x: number; z: number } => v !== null);

      if (!counted) {
        counted = true;
        huntStart = s.time;
        for (const o of s.obstacles) {
          if (o.lockedBy !== 'hider') continue;
          lockedCount++;
          const near = shelters.some((h) => Math.hypot(h.x - o.x, h.z - o.z) < 6);
          if (near) lockedNearShelter++;
        }
      }

      const locked = s.obstacles.filter((o) => o.lockedBy === 'hider');
      for (const k of s.agents) {
        if (k.team !== 'seeker' || k.caught) continue;
        seekerTicks++;
        if (locked.some((o) => Math.hypot(o.x - k.x, o.z - k.z) < LURE_R)) seekerNearLocked++;
        if (reached < 0 && shelters.some((h) => Math.hypot(h.x - k.x, h.z - k.z) < 6)) {
          reached = s.time - huntStart;
        }
      }
    }

    game.step(actions);
    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caught++;
    }
    if (game.state.phase === 'over') break;
  }

  if (reached >= 0) reachTimes.push(reached);
  else neverReached++;

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    if (!a.caught) survived++;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
const avg = (xs: number[]): string =>
  xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '—';
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(
  `  追跡開始時のロック箱: ${(lockedCount / GAMES).toFixed(1)} 個/試合  ` +
    `うち拠点から 6m 以内: ${lockedNearShelter} / ${lockedCount} (${pct(lockedNearShelter, lockedCount)})`,
);
console.log(
  `  鬼がロック箱の ${LURE_R}m 以内に居たティック: ${pct(seekerNearLocked, seekerTicks)}`,
);
console.log(
  `  鬼が最初に拠点 6m 以内へ来るまで: 平均 ${avg(reachTimes)} 秒  ` +
    `（一度も来なかった試合 ${neverReached} / ${GAMES}）`,
);
console.log(`  捕獲 ${caught} / 生存 ${survived} / ${totalHiders} 人 (${pct(survived, totalHiders)})`);

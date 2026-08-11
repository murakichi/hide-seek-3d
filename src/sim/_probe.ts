// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 3v3 の勝率が 1% まで落ちている理由を探す。トレースで見えた 2 つを数える。
//
//   A. 味方同士が固まっていないか
//      - 生存中の逃走者どうしの平均距離
//      - 2 人以上が 8m 以内に居たティックの割合
//      - 1 人の鬼が同じティックに 2 人以上を見ていた回数（＝まとめて見つかっている）
//   B. 壁に貼り付いていないか
//      - 追跡中に壁まで 3m 未満だったティックの割合（一様なら 25.6%）
//   C. 発見の速さ
//      - 追跡開始から各人が最初に見つかるまでの時間
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { ARENA_HALF, DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';
import { canSee } from '../core/vision';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 3);
const SEEKERS = Number(process.argv[3] ?? 3);
const SEED0 = Number(process.argv[4] ?? 1234);

let ticks = 0;
let pairSum = 0;
let pairCount = 0;
let closeTicks = 0; // 2 人以上が 8m 以内
let wallTicks = 0; // 壁まで 3m 未満（のべ人数）
let hiderTicks = 0;
let doubleSightTicks = 0; // 1 人の鬼が同じティックに 2 人以上を見た
let sightTicks = 0; // 鬼が誰かを見ていたティック（のべ鬼数）
const firstSeen: number[] = [];
let neverSeen = 0;
let shelterPairSum = 0;
let shelterPairCount = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const seenAt = new Map<number, number>();
  let huntStart = -1;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      if (huntStart < 0) {
        huntStart = s.time;
        // 拠点どうしの距離（初期配置がそもそも近いのか）
        const hs = s.agents
          .filter((a) => a.team === 'hider')
          .map((a) => ai.shelterOf(a.id))
          .filter((v): v is { x: number; z: number } => v !== null);
        for (let i = 0; i < hs.length; i++) {
          for (let j = i + 1; j < hs.length; j++) {
            shelterPairSum += Math.hypot(hs[i].x - hs[j].x, hs[i].z - hs[j].z);
            shelterPairCount++;
          }
        }
      }
      ticks++;
      const alive = s.agents.filter((a) => a.team === 'hider' && !a.caught);
      for (const a of alive) {
        hiderTicks++;
        const gap = Math.min(ARENA_HALF - Math.abs(a.x), ARENA_HALF - Math.abs(a.z));
        if (gap < 3) wallTicks++;
      }
      let close = false;
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const d = Math.hypot(alive[i].x - alive[j].x, alive[i].z - alive[j].z);
          pairSum += d;
          pairCount++;
          if (d < 8) close = true;
        }
      }
      if (close) closeTicks++;

      for (const k of s.agents) {
        if (k.team !== 'seeker' || k.caught) continue;
        const seen = alive.filter((a) => canSee(s, k, a));
        if (seen.length > 0) sightTicks++;
        if (seen.length >= 2) doubleSightTicks++;
        for (const a of seen) if (!seenAt.has(a.id)) seenAt.set(a.id, s.time - huntStart);
      }
    }

    game.step(actions);
    if (game.state.phase === 'over') break;
  }

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    const t0 = seenAt.get(a.id);
    if (t0 === undefined) neverSeen++;
    else firstSeen.push(t0);
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
const avg = (xs: number[]): string =>
  xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '—';
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log('  [A] 味方が固まっていないか');
console.log(`    拠点どうしの距離: 平均 ${(shelterPairSum / Math.max(1, shelterPairCount)).toFixed(1)}m`);
console.log(`    追跡中の逃走者どうしの距離: 平均 ${(pairSum / Math.max(1, pairCount)).toFixed(1)}m`);
console.log(`    2 人以上が 8m 以内に居たティック: ${pct(closeTicks, ticks)}`);
console.log(
  `    1 人の鬼が同時に 2 人以上を見ていた: ${pct(doubleSightTicks, sightTicks)}（見えていたティックのうち）`,
);
console.log('  [B] 壁への貼り付き');
console.log(`    壁まで 3m 未満: ${pct(wallTicks, hiderTicks)}（一様なら 25.6%）`);
console.log('  [C] 発見の速さ');
console.log(
  `    追跡開始から最初に見つかるまで: 平均 ${avg(firstSeen)} 秒  ` +
    `（一度も見つからなかった ${neverSeen} 人）`,
);

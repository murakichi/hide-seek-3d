// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 「見られていない間のパック寄り道」（boostGrabDist）が誰の役に立っているかを見る。
//
// 前サイクルの教訓: 発火回数を数えても採否は分からない。
// **その挙動を取った人の生存率**を、取らなかった人と比べる。
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 2);
const SEEKERS = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 1234);

let totalHiders = 0;
let survivors = 0;
/** 追跡中に一度でもブーストが乗った人 */
let boosted = 0;
let boostedSurvived = 0;
let boostTicks = 0;
let huntTicks = 0;
/** ブーストが乗ったあと、その人が捕まるまでにかかった秒数 */
let boostToCaught = 0;
let boostToCaughtN = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const boostedIds = new Set<number>();
  const firstBoostAt = new Map<number, number>();
  const caughtAt = new Map<number, number>();
  const prevCaught = new Set<number>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        huntTicks++;
        if (a.boostUntil > s.time) {
          boostTicks++;
          if (!boostedIds.has(a.id)) {
            boostedIds.add(a.id);
            firstBoostAt.set(a.id, s.time);
          }
        }
      }
    }

    game.step(actions);
    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caughtAt.set(a.id, game.state.time);
    }
    if (game.state.phase === 'over') break;
  }

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    if (!a.caught) survivors++;
    if (boostedIds.has(a.id)) {
      boosted++;
      if (!a.caught) boostedSurvived++;
      const c = caughtAt.get(a.id);
      const b = firstBoostAt.get(a.id);
      if (c !== undefined && b !== undefined) {
        boostToCaught += c - b;
        boostToCaughtN++;
      }
    }
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})  boostGrabDist=${DEFAULT_PARAMS.hider.boostGrabDist}`);
console.log(`  追跡中にブーストが乗った: ${boosted} / ${totalHiders} 人 (${pct(boosted, totalHiders)})`);
console.log(`    そのうち生存: ${boostedSurvived} / ${boosted} (${pct(boostedSurvived, boosted)})`);
console.log(`    乗ってから捕まるまで: ${(boostToCaught / Math.max(1, boostToCaughtN)).toFixed(1)} 秒 (${boostToCaughtN} 人)`);
console.log(`  ブーストが乗っていたティック: ${pct(boostTicks, huntTicks)}`);
console.log(`  全体の生存率: ${pct(survivors, totalHiders)}`);

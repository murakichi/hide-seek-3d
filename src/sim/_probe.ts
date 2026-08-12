// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
//
// 仮説: 鬼の巡回は `age`（そのセルを最後に見てからの経過時間）で行き先を選ぶ。
// 拠点は試合を通じて動かないので age が溜まり続け、**いずれ必ず巡回目標になる。**
// 逃げる側は振り切ると拠点へ帰るので、**自分から掃除待ちの場所へ戻っている**のでは。
//
// 見るもの:
//   - 捕獲された地点が、自分の拠点から何 m か
//   - 鬼が «拠点の周り» で過ごした時間の割合（面積比と比べる）
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { ARENA_HALF, DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 2);
const SEEKERS = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 1234);
/** 「拠点の周り」とみなす半径 */
const HOME_R = 6;

let caught = 0;
let caughtNearHome = 0;
let distAtCatchSum = 0;
/** 鬼が どれかの拠点から HOME_R 以内に居たティック */
let seekerNearHome = 0;
let seekerTicks = 0;
/** 逃げる側が拠点から HOME_R 以内に居たティック */
let hiderNearHome = 0;
let hiderTicks = 0;
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
  const prevCaught = new Set<number>();
  /** 拠点は準備フェーズで決まるので、hunt に入った時点で控える */
  let homes: Array<{ id: number; x: number; z: number }> = [];

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      if (homes.length === 0) {
        for (const a of s.agents) {
          if (a.team !== 'hider') continue;
          const h = ai.shelterOf(a.id);
          if (h) homes.push({ id: a.id, x: h.x, z: h.z });
        }
      }
      for (const a of s.agents) {
        if (a.caught) continue;
        if (a.team === 'seeker') {
          seekerTicks++;
          if (homes.some((h) => Math.hypot(h.x - a.x, h.z - a.z) < HOME_R)) seekerNearHome++;
        } else {
          hiderTicks++;
          const mine = homes.find((h) => h.id === a.id);
          if (mine && Math.hypot(mine.x - a.x, mine.z - a.z) < HOME_R) hiderNearHome++;
        }
      }
    }

    const before = new Map(
      game.state.agents
        .filter((a) => a.team === 'hider' && !a.caught)
        .map((a) => [a.id, { x: a.x, z: a.z }]),
    );
    game.step(actions);
    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caught++;
      const b = before.get(a.id);
      const mine = homes.find((h) => h.id === a.id);
      if (!b || !mine) continue;
      const d = Math.hypot(mine.x - b.x, mine.z - b.z);
      distAtCatchSum += d;
      if (d < HOME_R) caughtNearHome++;
    }
    if (game.state.phase === 'over') break;
  }

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    if (!a.caught) survivors++;
  }
}

// 拠点 1 つあたりの円の面積 / アリーナ面積
const areaShare = (Math.PI * HOME_R * HOME_R * HIDERS) / ((ARENA_HALF * 2) ** 2);
const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})  拠点の周り=${HOME_R}m`);
console.log(`  全体の生存率: ${pct(survivors, totalHiders)}  (捕獲 ${caught} 件)`);
console.log(`  捕獲が自分の拠点から ${HOME_R}m 以内: ${pct(caughtNearHome, caught)}`);
console.log(`  捕獲時の拠点からの距離（平均）: ${(distAtCatchSum / Math.max(1, caught)).toFixed(1)} m`);
console.log(`  鬼が拠点の周りに居たティック: ${pct(seekerNearHome, seekerTicks)}   (面積比では ${(areaShare * 100).toFixed(1)}%)`);
console.log(`  逃げる側が自分の拠点の周りに居たティック: ${pct(hiderNearHome, hiderTicks)}`);

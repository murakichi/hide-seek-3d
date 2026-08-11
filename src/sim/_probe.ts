// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 補給パックのブーストが使えているかを測る。
//
// ブースト中のダッシュ消費は DASH_COST * BOOST_DASH_COST = 34 * 0.45 = 15.3/秒。
// 回復は 19/秒なので、**ブースト中はダッシュし放題**（6 秒間）。
// hider.ts は BOOST を一度も参照しておらず、パックを拾うのも
// 「スタミナが 75% 未満」かつ「追われていない」ときだけ。
//
//   - 逃げる側／鬼が 1 試合に取ったパックの数
//   - 追跡中にブーストが効いていたティックの割合
//   - 逃走モード中にブーストが効いていた割合（本当に欲しい場面で効いているか）
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { Agent, GameState, MatchConfig } from '../core/types';
import { canSee } from '../core/vision';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 2);
const SEEKERS = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 1234);
const TRIGGER = DEFAULT_PARAMS.hider.fleeTriggerDist;

function fleeing(s: GameState, agent: Agent): boolean {
  let best = Infinity;
  for (const a of s.agents) {
    if (a.team !== 'seeker' || a.caught) continue;
    let pos: { x: number; z: number } | null = null;
    if (canSee(s, agent, a)) pos = { x: a.x, z: a.z };
    else {
      const rec = s.memory.hider.get(a.id);
      if (rec && s.time - rec.t < 4) pos = { x: rec.x, z: rec.z };
    }
    if (pos) best = Math.min(best, Math.hypot(pos.x - agent.x, pos.z - agent.z));
  }
  return best < TRIGGER;
}

let hiderPicks = 0;
let seekerPicks = 0;
let hiderTicks = 0;
let hiderBoostTicks = 0;
let fleeTicks = 0;
let fleeBoostTicks = 0;
let packsActive = 0;
let packSamples = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const prevBoost = new Map<number, number>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      packsActive += s.pickups.filter((p) => p.active).length;
      packSamples++;
      for (const a of s.agents) {
        if (a.caught) continue;
        const pb = prevBoost.get(a.id) ?? -99;
        if (a.boostUntil > pb) {
          if (a.team === 'hider') hiderPicks++;
          else seekerPicks++;
        }
        prevBoost.set(a.id, a.boostUntil);
        if (a.team !== 'hider') continue;
        hiderTicks++;
        const boosted = s.time < a.boostUntil;
        if (boosted) hiderBoostTicks++;
        if (fleeing(s, a)) {
          fleeTicks++;
          if (boosted) fleeBoostTicks++;
        }
      }
    }

    game.step(actions);
    if (game.state.phase === 'over') break;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  追跡中に取ったパック: 逃 ${(hiderPicks / GAMES).toFixed(2)} 個/試合  鬼 ${(seekerPicks / GAMES).toFixed(2)} 個/試合`);
console.log(`  盤上に残っていたパック: 平均 ${(packsActive / Math.max(1, packSamples)).toFixed(1)} 個`);
console.log(`  逃げる側がブースト中だったティック: ${pct(hiderBoostTicks, hiderTicks)}`);
console.log(`  そのうち逃走モード中: ${pct(fleeBoostTicks, fleeTicks)}（逃走ティックのうち）`);

// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 「箱を乗り越えて逃げる」が実際に働いているかを見る。
//   - 逃走中に鬼の視線が切れた回数（遮蔽を使えているか）
//   - 逃走中に逃走者が地面より高い位置に居たティックの割合
//   - 捕獲されるまでの時間
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { Agent, GameState, MatchConfig } from '../core/types';
import { canSee } from '../core/vision';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 40;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
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

let fleeTicks = 0;
let elevatedTicks = 0; // 地面より高いところに居た
let losLost = 0; // 見えていた→見えなくなった
let caught = 0;
let survivedHiders = 0;
let totalHiders = 0;
let huntSeconds = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const wasSeen = new Map<number, boolean>();
  const prevCaught = new Set<number>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      huntSeconds += DT;
      const seekers = s.agents.filter((a) => a.team === 'seeker' && !a.caught);
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        if (fleeing(s, a)) {
          fleeTicks++;
          if (a.y > 0.4) elevatedTicks++;
        }
        const visible = seekers.some((k) => canSee(s, k, a));
        if (!visible && (wasSeen.get(a.id) ?? false)) losLost++;
        wasSeen.set(a.id, visible);
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

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    if (!a.caught) survivedHiders++;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  逃走モードのティック: ${fleeTicks}`);
console.log(`    地面より高い位置に居た: ${elevatedTicks} (${pct(elevatedTicks, fleeTicks)})`);
console.log(`  視線を切った回数: ${losLost}  （追跡 1 分あたり ${(losLost / Math.max(1, huntSeconds / 60)).toFixed(1)} 回）`);
console.log(`  捕獲: ${caught} / 生存 ${survivedHiders} / ${totalHiders} 人 (${pct(survivedHiders, totalHiders)})`);

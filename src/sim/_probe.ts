// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 追跡フェーズで「鬼が近いのに逃げる入力が出ていない」ティックを数える。

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { ARENA_HALF, DT, EYE_HEIGHT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 24;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const TRIGGER = DEFAULT_PARAMS.hider.fleeTriggerDist;

let threatTicks = 0;
let frozenTicks = 0;
let frozenNearWall = 0;
let frozenNearBox = 0;
/** 硬直がどのくらい続いたか（連続ティック数の分布） */
const runs: number[] = [];
let caughtWhileFrozen = 0;
let caught = 0;

for (let i = 0; i < GAMES; i++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: 1234 + i * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const run = new Map<number, number>();
  const wasFrozen = new Map<number, boolean>();
  const prevCaught = new Set<number>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        const near = Math.min(
          ...s.agents
            .filter((k) => k.team === 'seeker' && !k.caught)
            .map((k) => Math.hypot(k.x - a.x, k.z - a.z)),
        );
        if (near > TRIGGER) {
          if ((run.get(a.id) ?? 0) > 0) runs.push(run.get(a.id)!);
          run.set(a.id, 0);
          wasFrozen.set(a.id, false);
          continue;
        }
        threatTicks++;
        const act = actions.get(a.id);
        const mag = act ? Math.hypot(act.moveX, act.moveZ) : 0;
        if (mag < 0.05) {
          frozenTicks++;
          run.set(a.id, (run.get(a.id) ?? 0) + 1);
          wasFrozen.set(a.id, true);
          const wallGap = Math.min(ARENA_HALF - Math.abs(a.x), ARENA_HALF - Math.abs(a.z));
          if (wallGap < 3) frozenNearWall++;
          let boxNear = false;
          for (const o of s.obstacles) {
            if (o.kind === 'ramp' || o.kind === 'pad' || o.kind === 'wall') continue;
            if (Math.hypot(o.x - a.x, o.z - a.z) < 3.2) boxNear = true;
          }
          if (boxNear) frozenNearBox++;
        } else {
          if ((run.get(a.id) ?? 0) > 0) runs.push(run.get(a.id)!);
          run.set(a.id, 0);
          wasFrozen.set(a.id, false);
        }
      }
    }

    game.step(actions);

    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caught++;
      if (wasFrozen.get(a.id)) caughtWhileFrozen++;
    }
    if (game.state.phase === 'over') break;
  }
  for (const v of run.values()) if (v > 0) runs.push(v);
}

runs.sort((a, b) => b - a);
const longest = runs.slice(0, 5).map((r) => (r * DT).toFixed(1));
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合  (EYE=${EYE_HEIGHT})`);
console.log(`  鬼が ${TRIGGER}m 以内にいたティック: ${threatTicks}`);
console.log(
  `  そのうち移動入力ゼロ: ${frozenTicks} (${((frozenTicks / Math.max(1, threatTicks)) * 100).toFixed(1)}%)  ` +
    `壁際 ${frozenNearWall} / 箱の近く ${frozenNearBox}`,
);
console.log(`  硬直の最長 5 件(秒): ${longest.join(', ')}`);
console.log(`  捕獲 ${caught} 件のうち、硬直中に捕まった: ${caughtWhileFrozen}`);

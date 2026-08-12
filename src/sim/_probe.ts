// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// **どこで負けているか**を広く測る。高台まわりが 4 サイクル続けて不採用だったので、
// 対象を決め打ちせずに分布を見る。
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import {
  ARENA_HALF,
  CATCH_VERTICAL,
  DT,
  HUNT_TIME,
  PREP_TIME,
  SMOKE_CHARGES,
  STAMINA_MAX,
} from '../core/config';
import { Game } from '../core/game';
import { canSee } from '../core/vision';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 2);
const SEEKERS = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 1234);

let totalHiders = 0;
let survivors = 0;
let caught = 0;
/** 捕まった時点で煙幕が残っていた人 */
let caughtWithSmoke = 0;
let smokeUsedTotal = 0;
/** 捕まった地点がアリーナ外周から 3m 以内（隅・壁際） */
let caughtNearWall = 0;
/** 捕まった時点でスタミナが 25% 未満 */
let caughtLowStamina = 0;
/** 捕まった時点で高台に居た */
let caughtHigh = 0;
/** 「見られている」ティックの割合 */
let seenTicks = 0;
let huntTicks = 0;
let nearWallTicks = 0;
/** 一度も見つからずに逃げ切った人 */
let neverSeen = 0;
/** 初めて見られてから捕まるまでの秒数 */
let survivalAfterSeen = 0;
let survivalAfterSeenN = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const firstSeenAt = new Map<number, number>();
  const prevCaught = new Set<number>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        huntTicks++;
        const seen = s.agents.some(
          (sk) => sk.team === 'seeker' && !sk.caught && canSee(s, sk, a),
        );
        if (seen) {
          seenTicks++;
          if (!firstSeenAt.has(a.id)) firstSeenAt.set(a.id, s.time);
        }
        if (ARENA_HALF - Math.max(Math.abs(a.x), Math.abs(a.z)) < 3) nearWallTicks++;
      }
    }

    // 捕獲の瞬間の状態を、step の前に控えておく
    const before = new Map(
      game.state.agents
        .filter((a) => a.team === 'hider' && !a.caught)
        .map((a) => [
          a.id,
          {
            x: a.x,
            z: a.z,
            y: a.y,
            stamina: a.stamina,
            smoke: a.smokeCharges,
          },
        ]),
    );
    game.step(actions);
    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caught++;
      const b = before.get(a.id);
      if (!b) continue;
      if (b.smoke > 0) caughtWithSmoke++;
      const edge = ARENA_HALF - Math.max(Math.abs(b.x), Math.abs(b.z));
      if (edge < 3) caughtNearWall++;
      if (b.stamina < STAMINA_MAX * 0.25) caughtLowStamina++;
      if (b.y > CATCH_VERTICAL) caughtHigh++;
      const seenAt = firstSeenAt.get(a.id);
      if (seenAt !== undefined) {
        survivalAfterSeen += game.state.time - seenAt;
        survivalAfterSeenN++;
      }
    }
    if (game.state.phase === 'over') break;
  }

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    smokeUsedTotal += SMOKE_CHARGES - a.smokeCharges;
    if (!a.caught) survivors++;
    if (!firstSeenAt.has(a.id)) neverSeen++;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  全体の生存率: ${pct(survivors, totalHiders)}  (捕獲 ${caught} 件)`);
console.log(`  一度も見つからなかった: ${pct(neverSeen, totalHiders)}`);
console.log(`  見られていたティック: ${pct(seenTicks, huntTicks)}`);
console.log(`  初めて見られてから捕まるまで: ${(survivalAfterSeen / Math.max(1, survivalAfterSeenN)).toFixed(1)} 秒`);
console.log(`  --- 捕まった瞬間の状態 ---`);
console.log(`  煙幕が残っていた: ${pct(caughtWithSmoke, caught)}   (1 人あたり使用 ${(smokeUsedTotal / Math.max(1, totalHiders)).toFixed(2)} / ${SMOKE_CHARGES})`);
console.log(`  壁際 3m 以内: ${pct(caughtNearWall, caught)}   (滞在時間では ${pct(nearWallTicks, huntTicks)}、面積では 25.4%)`);
console.log(`  スタミナ 25% 未満: ${pct(caughtLowStamina, caught)}`);
console.log(`  高台の上: ${pct(caughtHigh, caught)}`);

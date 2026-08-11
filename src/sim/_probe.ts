// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// issue #31「運搬が空回りする」。詰まり検出のしきい値を変えたときに
// 準備フェーズの成果がどう動くかを見る。
//
//   - 掴んでいた時間のうち、箱が動いていない時間（＝捨てている時間）
//   - 諦めた回数（`boxStall` が閾値を超えた回数の代理として、掴み→離しの回数）
//   - 追跡開始時にロックできた箱の数（準備フェーズの成果そのもの）
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { cloneParams, DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const SEED0 = Number(process.argv[4] ?? 1234);
const VALUES = [1.2, 0.8, 0.5, 0.3];

console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
for (const v of VALUES) {
  const params = cloneParams(DEFAULT_PARAMS);
  params.hider.haulStallTime = v;

  let holdTicks = 0;
  let stalledTicks = 0;
  let releases = 0;
  let locked = 0;
  let slotted = 0;

  for (let g = 0; g < GAMES; g++) {
    const config: MatchConfig = {
      hiders: HIDERS,
      seekers: SEEKERS,
      playerTeam: null,
      seed: SEED0 + g * 7919,
    };
    const game = new Game(config);
    const ai = new AiDirector(game, params);
    const prevGrab = new Map<number, number>();
    const lastBoxPos = new Map<number, { x: number; z: number }>();
    let counted = false;

    for (let t = 0; t < MAX_TICKS; t++) {
      const actions = ai.tick();
      const s = game.state;

      if (s.phase === 'prep') {
        for (const a of s.agents) {
          if (a.team !== 'hider') continue;
          const held = a.grabbed;
          const prev = prevGrab.get(a.id) ?? -1;
          if (prev >= 0 && held !== prev) releases++;
          prevGrab.set(a.id, held);
          if (held < 0) continue;
          holdTicks++;
          const box = s.obstacles[held];
          const last = lastBoxPos.get(held);
          if (last && Math.hypot(box.x - last.x, box.z - last.z) < 0.02) stalledTicks++;
          lastBoxPos.set(held, { x: box.x, z: box.z });
        }
      } else if (s.phase === 'hunt' && !counted) {
        counted = true;
        locked += s.obstacles.filter((o) => o.lockedBy === 'hider').length;
        // 拠点の外周に載った箱（壁として立っているか）
        for (const a of s.agents) {
          if (a.team !== 'hider') continue;
          const h = ai.shelterOf(a.id);
          if (!h) continue;
          slotted += s.obstacles.filter(
            (o) => o.kind === 'box' && Math.hypot(o.x - h.x, o.z - h.z) < 4.5,
          ).length;
        }
      }

      game.step(actions);
      if (game.state.phase === 'over') break;
    }
  }

  const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
  console.log(
    `  stall=${v.toFixed(1)}秒  掴み ${(holdTicks * DT / GAMES).toFixed(1)}秒/試合  ` +
      `空回り ${(stalledTicks * DT / GAMES).toFixed(1)}秒 (${pct(stalledTicks, holdTicks)})  ` +
      `手放し ${(releases / GAMES).toFixed(1)}回  ` +
      `ロック ${(locked / GAMES).toFixed(1)}個  拠点周りの箱 ${(slotted / GAMES).toFixed(1)}個`,
  );
}

// 改善サイクル用の使い捨て計測スクリプト。調べたいことに合わせて中身を書き換える。
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers>
//
// 今の計測: 逃走モード中に速度が出ているか。逃げる側は鬼より足が速い設定なので、
// 追われている間の平均速度が鬼を下回っていたら、速度負けではなく走り方の問題。

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HIDER_SPEED, HUNT_TIME, PREP_TIME, SEEKER_SPEED } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';
import { canSee } from '../core/vision';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 24;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const P = DEFAULT_PARAMS.hider;

/** 鬼に見られているのに、逃げる側は鬼を感知していない時間 */
const unaware = { n: 0, spd: 0 };
/** 逃走モード（脅威を感知している）の時間 */
const fleeing = { n: 0, spd: 0, seekerSpd: 0, dash: 0, gap: 0 };
/** 指示方向の振れ */
let turnSum = 0;
let turnN = 0;
let bigTurns = 0;
const lastDir = new Map<number, number>();

for (let i = 0; i < GAMES; i++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: 1234 + i * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      const seekers = s.agents.filter((k) => k.team === 'seeker' && !k.caught);
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;

        // 逃げる側が把握している脅威（HiderBrain.knownThreats と同じ条件）
        let known = Infinity;
        for (const k of seekers) {
          const rec = s.memory.hider.get(k.id);
          const remembered = rec !== undefined && s.time - rec.t < 4;
          if (canSee(s, a, k) || remembered) {
            known = Math.min(known, Math.hypot(k.x - a.x, k.z - a.z));
          }
        }
        const spd = Math.hypot(a.vx, a.vz);
        const act = actions.get(a.id);

        if (known >= P.fleeTriggerDist) {
          if (seekers.some((k) => canSee(s, k, a))) {
            unaware.n++;
            unaware.spd += spd;
          }
          continue;
        }

        const near = seekers.reduce((b, k) =>
          Math.hypot(k.x - a.x, k.z - a.z) < Math.hypot(b.x - a.x, b.z - a.z) ? k : b,
        );
        fleeing.n++;
        fleeing.spd += spd;
        fleeing.seekerSpd += Math.hypot(near.vx, near.vz);
        fleeing.gap += Math.hypot(near.x - a.x, near.z - a.z);
        if (act?.dash) fleeing.dash++;

        if (act && Math.hypot(act.moveX, act.moveZ) > 0.05) {
          const ang = Math.atan2(act.moveX, act.moveZ);
          const prev = lastDir.get(a.id);
          if (prev !== undefined) {
            let d = ang - prev;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            turnSum += Math.abs(d);
            turnN++;
            if (Math.abs(d) > Math.PI / 2) bigTurns++;
          }
          lastDir.set(a.id, ang);
        }
      }
    }

    game.step(actions);
    if (game.state.phase === 'over') break;
  }
}

const avg = (sum: number, n: number): string => (sum / Math.max(1, n)).toFixed(2);
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合   (最高速度 逃 ${HIDER_SPEED} / 鬼 ${SEEKER_SPEED} m/s)`);
console.log(
  `  見られているのに気づいていない: ${(unaware.n * DT).toFixed(0)} 秒  平均速度 ${avg(unaware.spd, unaware.n)}`,
);
console.log(`  逃走モード: ${(fleeing.n * DT).toFixed(0)} 秒`);
console.log(`    逃げる側の平均速度 ${avg(fleeing.spd, fleeing.n)} m/s`);
console.log(`    鬼の平均速度       ${avg(fleeing.seekerSpd, fleeing.n)} m/s`);
console.log(`    ダッシュ指示の割合 ${((fleeing.dash / Math.max(1, fleeing.n)) * 100).toFixed(1)}%`);
console.log(`    平均の間合い       ${avg(fleeing.gap, fleeing.n)} m`);
console.log(
  `    指示方向の振れ ${(((turnSum / Math.max(1, turnN)) * 180) / Math.PI).toFixed(1)} 度/tick` +
    `  90 度超の切り返し ${((bigTurns / Math.max(1, turnN)) * 100).toFixed(1)}%`,
);

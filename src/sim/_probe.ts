// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// issue #10「逃げる側が追われている間にダッシュを使わない」と同じ指標を測る。
// 鬼が 14m 以内にいる「追われている」状態で、両者のダッシュ使用率とスタミナを見る。
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
/** 「追われている」とみなす距離 */
const NEAR = 14;

let ticks = 0;
let hiderDash = 0;
let hiderStamina = 0;
let seekerDash = 0;
let seekerStamina = 0;
let seekerTicks = 0;
/** 5 秒窓で鬼との距離が伸びたか */
let windows = 0;
let windowsGained = 0;
let caught = 0;
let totalHiders = 0;
let survived = 0;
let staminaAtCatch = 0;
let caughtExhausted = 0;

const WIN = Math.round(5 / DT);

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const distHist = new Map<number, number[]>();
  const prevCaught = new Set<number>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      const seekers = s.agents.filter((a) => a.team === 'seeker' && !a.caught);
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        if (seekers.length === 0) continue;
        let nearD = Infinity;
        for (const k of seekers) nearD = Math.min(nearD, Math.hypot(k.x - a.x, k.z - a.z));
        if (nearD > NEAR) {
          distHist.set(a.id, []);
          continue;
        }
        ticks++;
        if (actions.get(a.id)?.dash) hiderDash++;
        hiderStamina += a.stamina;

        const dh = distHist.get(a.id) ?? [];
        dh.push(nearD);
        if (dh.length >= WIN) {
          windows++;
          if (dh[dh.length - 1] > dh[0]) windowsGained++;
          distHist.set(a.id, []);
        } else {
          distHist.set(a.id, dh);
        }
      }

      // 鬼側は「逃げる側を 14m 以内に捉えている」ティックだけ数える
      for (const k of seekers) {
        const near = s.agents.some(
          (a) => a.team === 'hider' && !a.caught && Math.hypot(k.x - a.x, k.z - a.z) <= NEAR,
        );
        if (!near) continue;
        seekerTicks++;
        if (actions.get(k.id)?.dash) seekerDash++;
        seekerStamina += k.stamina;
      }
    }

    const staminaBefore = new Map(
      game.state.agents.filter((a) => a.team === 'hider').map((a) => [a.id, a.stamina]),
    );
    game.step(actions);
    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caught++;
      staminaAtCatch += staminaBefore.get(a.id) ?? 0;
      if ((staminaBefore.get(a.id) ?? 0) < 25) caughtExhausted++;
    }
    if (game.state.phase === 'over') break;
  }

  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    if (!a.caught) survived++;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0}, 追われている = ${NEAR}m 以内)`);
console.log(
  `  逃  ダッシュ率 ${pct(hiderDash, ticks)}  平均スタミナ ${(hiderStamina / Math.max(1, ticks)).toFixed(0)}`,
);
console.log(
  `  鬼  ダッシュ率 ${pct(seekerDash, seekerTicks)}  平均スタミナ ${(seekerStamina / Math.max(1, seekerTicks)).toFixed(0)}`,
);
console.log(`  5 秒窓で距離が伸びた割合: ${pct(windowsGained, windows)} (${windows} 窓)`);
console.log(`  捕獲時のスタミナ 平均 ${(staminaAtCatch / Math.max(1, caught)).toFixed(0)}  25 未満で捕まった ${pct(caughtExhausted, caught)}`);
console.log(`  捕獲 ${caught} / 生存 ${survived} / ${totalHiders} 人 (${pct(survived, totalHiders)})`);

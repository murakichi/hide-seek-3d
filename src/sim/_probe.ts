// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 3v3 の勝率 1% が行動側で解けるのかを決めるために、「見られている時間」を測る。
//
//   - 逃走者が誰かの視界に入っていたティックの割合
//   - 視界から消えてから再発見されるまでの時間（＝振り切れているか）
//   - 見失いの回数（1 人あたり・追跡 1 分あたり）
//   - 生存時間（追跡開始から捕獲まで）
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';
import { canSee } from '../core/vision';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 3);
const SEEKERS = Number(process.argv[3] ?? 3);
const SEED0 = Number(process.argv[4] ?? 1234);

let hiderTicks = 0;
let seenTicks = 0;
let losses = 0; // 見失い（見えていた→見えなくなった）
const regainGaps: number[] = []; // 見失ってから再発見までの秒
let stillLost = 0; // 見失ったまま試合が終わった
let huntSeconds = 0;
const survival: number[] = [];
let survivors = 0;
let totalHiders = 0;

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
  const lostAt = new Map<number, number>();
  const prevCaught = new Set<number>();
  let huntStart = -1;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      if (huntStart < 0) huntStart = s.time;
      huntSeconds += DT;
      const seekers = s.agents.filter((a) => a.team === 'seeker' && !a.caught);
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        hiderTicks++;
        const seen = seekers.some((k) => canSee(s, k, a));
        if (seen) seenTicks++;
        const before = wasSeen.get(a.id) ?? false;
        if (before && !seen) {
          losses++;
          lostAt.set(a.id, s.time);
        } else if (!before && seen) {
          const t0 = lostAt.get(a.id);
          if (t0 !== undefined) {
            regainGaps.push(s.time - t0);
            lostAt.delete(a.id);
          }
        }
        wasSeen.set(a.id, seen);
      }
    }

    game.step(actions);
    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      if (huntStart >= 0) survival.push(game.state.time - huntStart);
      if (lostAt.has(a.id)) {
        // 見失われたまま捕まった（＝記憶で追われた）
      }
    }
    if (game.state.phase === 'over') break;
  }

  stillLost += lostAt.size;
  for (const a of game.state.agents) {
    if (a.team !== 'hider') continue;
    totalHiders++;
    if (!a.caught) survivors++;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
const avg = (xs: number[]): string =>
  xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '—';
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  見られていたティック: ${pct(seenTicks, hiderTicks)}`);
console.log(
  `  見失い: ${losses} 回  （逃走者 1 人あたり ${(losses / Math.max(1, totalHiders)).toFixed(1)} 回 / ` +
    `追跡 1 分あたり ${(losses / Math.max(1, huntSeconds / 60)).toFixed(1)} 回）`,
);
console.log(
  `  見失ってから再発見まで: 平均 ${avg(regainGaps)} 秒  （そのまま逃げ切った ${stillLost} 件）`,
);
console.log(`  捕まるまでの生存時間: 平均 ${avg(survival)} 秒`);
console.log(`  生存 ${survivors} / ${totalHiders} 人 (${pct(survivors, totalHiders)})`);

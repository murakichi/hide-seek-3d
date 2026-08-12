// 使い捨ての計測。鬼の踏み切り（shouldLeap）が通常の対戦で何回発動しているかを数える。
//
// PR #50 で「隙間を挟んだ足場へ跳び移る」を入れたところ、3v3 の逃げ側勝率が
// 25.0% → 38.0% に上がった（＝鬼が弱くなった）。跳べるようになったのに弱くなるのは
// **跳ぶ必要のない場面で跳んでいる**からだと考えられる。
//
// `shouldLeap` は平地でも「進行方向にある届く足場」なら発動するので、
// 追跡中に小箱を見つけるたびに跳び乗っている可能性がある。
// 高所の相手を追っている場面と、そうでない場面を分けて数える。
//
// 使い方: npx tsx src/sim/_probe-leap.ts <hiders> <seekers> [games]

import { AiDirector } from '../ai/director';
import { CATCH_VERTICAL, DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const HIDERS = Number(process.argv[2] ?? 3);
const SEEKERS = Number(process.argv[3] ?? 3);
const GAMES = Number(process.argv[4] ?? 20);

let games = 0;
/** ジャンプ指示が出て、実際に踏み切った（接地→非接地）回数 */
let takeoffs = 0;
/** そのうち、生きている逃走者の誰かが CATCH_VERTICAL より高い位置に居た */
let takeoffsWithHighPrey = 0;
/** そのうち、鬼自身が高所（0.5 超）に居た＝台の上を渡っている */
let takeoffsFromHigh = 0;
/** 鬼が地上に居て、かつ高所に逃走者が居ない踏み切り＝無駄跳びの疑い */
let pointless = 0;
/** 鬼が空中に居たティック */
let airborne = 0;
let seekerTicks = 0;

for (let i = 0; i < GAMES; i++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: 1234 + i * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game);
  const s = game.state;
  const wasGrounded = new Map<number, boolean>();
  games++;

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    // 踏み切りの瞬間を捉えるため、step の前に「接地していて jump 指示」を控えておく
    const jumping = new Map<number, boolean>();
    for (const a of s.agents) {
      if (a.team !== 'seeker' || a.caught) continue;
      jumping.set(a.id, Boolean(actions.get(a.id)?.jump) && a.grounded);
    }

    game.step(actions);
    if (s.phase !== 'hunt') {
      if (s.phase === 'over') break;
      continue;
    }

    const highPrey = s.agents.some(
      (a) => a.team === 'hider' && !a.caught && a.y > CATCH_VERTICAL,
    );

    for (const a of s.agents) {
      if (a.team !== 'seeker' || a.caught) continue;
      seekerTicks++;
      if (!a.grounded) airborne++;

      const was = wasGrounded.get(a.id) ?? true;
      // 接地していた鬼が jump 指示を出して浮いた＝踏み切り
      if (was && !a.grounded && jumping.get(a.id)) {
        takeoffs++;
        if (highPrey) takeoffsWithHighPrey++;
        if (a.y > 0.5) takeoffsFromHigh++;
        if (!highPrey && a.y <= 0.5) pointless++;
      }
      wasGrounded.set(a.id, a.grounded);
    }
  }
}

const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${games} 試合  鬼の踏み切り`);
console.log(`  踏み切り ${takeoffs} 回（1 試合あたり ${(takeoffs / games).toFixed(1)}）`);
console.log(`  うち高所に逃走者が居た:     ${takeoffsWithHighPrey} (${pct(takeoffsWithHighPrey, takeoffs)})`);
console.log(`  うち鬼自身が台の上に居た:   ${takeoffsFromHigh} (${pct(takeoffsFromHigh, takeoffs)})`);
console.log(`  **どちらでもない（無駄跳びの疑い）: ${pointless} (${pct(pointless, takeoffs)})**`);
console.log(`  鬼が空中に居たティックの割合: ${pct(airborne, seekerTicks)}`);

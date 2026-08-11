// 使い捨ての計測（issue #28）。追跡の担当が分かれていないことを数値で確かめる。
//
// 見たいのは「群がっているか」ではなく **「群がったせいで誰も追われていない逃走者が
// 居るか」**。逃げ側は 1 人でも残れば勝ちなので、放置された 1 人が勝敗を決める。
// 逃走者が 1 人しか残っていない場面で全員が集まるのは挟み撃ちであって欠陥ではない。
//
// 使い方: npx tsx src/sim/_probe-chase-assign.ts <hiders> <seekers> [games] [chaseMaxSeekers]
//
// 3v3 の勝率は既に 0% で床に張り付いていて差が出ないので、
// **機構が効いたかどうかはここで見る。**

import { AiDirector } from '../ai/director';
import { cloneParams, DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import { canSee } from '../core/vision';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const HIDERS = Number(process.argv[2] ?? 3);
const SEEKERS = Number(process.argv[3] ?? 3);
const GAMES = Number(process.argv[4] ?? 30);
const params = cloneParams(DEFAULT_PARAMS);
if (process.argv[5] !== undefined) params.seeker.chaseMaxSeekers = Number(process.argv[5]);

let huntTicks = 0;
/** 2 人以上の逃走者が生きているティック（群がりが問題になりうる場面） */
let multiAlive = 0;
/** そのうち、2 人以上の鬼が同じ相手を見ているティック */
let piled = 0;
/** そのうち、誰にも見られていない逃走者が同時に居るティック */
let piledAndNeglected = 0;
/** 見られている鬼の重なりの合計（重複度の平均を出すため） */
let seerSum = 0;
let seerN = 0;
/** 放置された逃走者ティックの合計 */
let neglectedSum = 0;

for (let i = 0; i < GAMES; i++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: 1234 + i * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, params);
  const s = game.state;

  for (let t = 0; t < MAX_TICKS; t++) {
    game.step(ai.tick());
    if (s.phase !== 'hunt') {
      if (s.phase === 'over') break;
      continue;
    }
    huntTicks++;

    const alive = s.agents.filter((a) => a.team === 'hider' && !a.caught);
    const seekers = s.agents.filter((a) => a.team === 'seeker' && !a.caught);
    if (alive.length < 2) continue;
    multiAlive++;

    // 実際の担当は協調の掲示（targetId）を見る。
    // 「見えているか」ではなく「誰を追っているか」がこの修正の対象。
    const intents = ai.ctx.coop.seeker.others(-1, s.time);
    const perTarget = new Map<number, number>();
    for (const it of intents) {
      if (it.targetId < 0) continue;
      perTarget.set(it.targetId, (perTarget.get(it.targetId) ?? 0) + 1);
    }
    let maxSeers = 0;
    let neglected = 0;
    for (const h of alive) {
      const n = perTarget.get(h.id) ?? 0;
      if (n > maxSeers) maxSeers = n;
      // 追われてもおらず、誰からも見えてもいない＝完全に放置
      let visible = false;
      for (const k of seekers) {
        if (canSee(s, k, h)) {
          visible = true;
          break;
        }
      }
      if (n === 0 && !visible) neglected++;
      if (n > 0) {
        seerSum += n;
        seerN++;
      }
    }
    if (maxSeers >= 2) {
      piled++;
      if (neglected > 0) {
        piledAndNeglected++;
        neglectedSum += neglected;
      }
    }
  }
}

const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合  chaseMaxSeekers=${params.seeker.chaseMaxSeekers}`);
console.log(`  追跡フェーズ ${huntTicks} ティック、うち逃走者 2 人以上 ${multiAlive} (${pct(multiAlive, huntTicks)})`);
console.log(`  そのうち 2 人以上の鬼が同じ相手を追っている: ${piled} (${pct(piled, multiAlive)})`);
console.log(`  さらに誰にも追われず見えてもいない逃走者が居る:     ${piledAndNeglected} (${pct(piledAndNeglected, multiAlive)})`);
console.log(`  追われている逃走者 1 人あたりの鬼の数（平均）: ${(seerSum / Math.max(1, seerN)).toFixed(2)}`);
console.log(`  群がり中に放置されていた人数（平均）: ${(neglectedSum / Math.max(1, piledAndNeglected)).toFixed(2)}`);

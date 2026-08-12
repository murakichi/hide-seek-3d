// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
//
// ユーザーの案「開始前に敵を囲ってしまうのはどう？」を、**AI に建てさせる前に**
// 盤面を手で組んで価値だけ確かめる。
//
// 準備フェーズ中の鬼は半径 `SEEKER_CAGE_RADIUS`(2.6) のケージから出られない。
// 箱には配置制限が無い（ケージの判定は agent にしか掛からない）ので、
// ケージの外周に大箱（上面 2.2 > CLIMB_REACH 1.64）を並べてロックすれば、
// 鬼は「登れない・掴めない」壁に囲まれる。解錠は 1 個 UNLOCK_TIME(1.6 秒)。
//
// 測るもの: 追跡フェーズ開始から、鬼が «囲いの外»（半径 R+2）へ出るまでの秒数。
//
// 使い方: npx tsx src/sim/_probe-cage.ts <seekers> [囲う個数] [半径]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import {
  BOX_HEIGHT_BIG,
  DT,
  HUNT_TIME,
  PREP_TIME,
  SEEKER_CAGE_RADIUS,
} from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig, Obstacle } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 20;
const SEEKERS = Number(process.argv[2] ?? 2);
const COUNT = Number(process.argv[3] ?? 10);
const RING_R = Number(process.argv[4] ?? 4.2);
/** ここを越えたら «囲いを抜けた» とみなす */
const ESCAPE_R = RING_R + 2;

let escapeSum = 0;
let escapeN = 0;
let neverEscaped = 0;
let hiderWins = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: SEEKERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: 1234 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const s = game.state;

  if (COUNT > 0) {
    // 既にケージの近くにある箱をどけてから、リングを作る。
    for (const o of s.obstacles) {
      if (o.kind !== 'box') continue;
      if (Math.hypot(o.x, o.z) < ESCAPE_R + 1) {
        o.x += 18;
        o.z += 18;
      }
    }
    for (let i = 0; i < COUNT; i++) {
      const ang = (i / COUNT) * Math.PI * 2;
      const box: Obstacle = {
        id: s.obstacles.length,
        kind: 'box',
        x: Math.sin(ang) * RING_R,
        z: Math.cos(ang) * RING_R,
        y: 0,
        hw: 1.1,
        hd: 1.1,
        h: BOX_HEIGHT_BIG,
        heldBy: -1,
        lockedBy: 'hider',
        unlockProgress: 0,
      };
      s.obstacles.push(box);
    }
  }

  let escaped = false;
  let huntStart = -1;
  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    if (game.state.phase === 'hunt') {
      if (huntStart < 0) huntStart = game.state.time;
      if (!escaped) {
        const out = game.state.agents.some(
          (a) => a.team === 'seeker' && !a.caught && Math.hypot(a.x, a.z) > ESCAPE_R,
        );
        if (out) {
          escaped = true;
          escapeSum += game.state.time - huntStart;
          escapeN++;
        }
      }
    }
    game.step(actions);
    if (game.state.phase === 'over') break;
  }
  if (!escaped) neverEscaped++;
  if (game.state.winner === 'hider') hiderWins++;
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(
  `${SEEKERS}v${SEEKERS} / ${GAMES} 試合   囲い ${COUNT} 個 @ 半径 ${RING_R}（ケージは ${SEEKER_CAGE_RADIUS}）`,
);
console.log(`  鬼が半径 ${ESCAPE_R} を越えるまで: ${(escapeSum / Math.max(1, escapeN)).toFixed(1)} 秒`);
console.log(`  最後まで出られなかった試合: ${neverEscaped} / ${GAMES}`);
console.log(`  逃げる側の勝率: ${pct(hiderWins, GAMES)}`);

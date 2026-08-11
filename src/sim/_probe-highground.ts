// 使い捨ての再現環境。ユーザーが hider で実際に使った勝ち筋を再現する。
//
//   「低い台から少し離れたところに高い台を並べて設置し、
//     低い台からそこに飛び移ることで鬼が来れなくなって勝った」
//
// 仕様上そうなる理由:
//   - 素の登坂力 CLIMB_REACH = 1.64 → 地上からは小箱(1.3)にしか乗れない
//   - 小箱の上(y=1.3)からは 2.94 まで届く → 大箱(2.2)・2 段積み(2.6)へ飛び移れる
//   - CATCH_VERTICAL = 1.6 → 地上の鬼は y=2.2 の相手に触れない
//
// AI の逃げ側はこれをやらないので、通常の対戦にも CI にも一切現れない。
// ここでは盤面を手で組み、逃走者を高所に置いて、鬼が登って来られるかだけを見る。
//
// 使い方: npx tsx src/sim/_probe-highground.ts [gap] [seconds]
//   gap … 低い台と高い台の間隔（m）。ユーザーの「少し離れた」を振って調べる

import { AiDirector } from '../ai/director';
import {
  BOX_HEIGHT_BIG,
  BOX_HEIGHT_SMALL,
  CATCH_VERTICAL,
  CLIMB_REACH,
  DT,
} from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig, Obstacle } from '../core/types';

const GAP = Number(process.argv[2] ?? 2.5);
const SECONDS = Number(process.argv[3] ?? 40);
/**
 * `free` を渡すと逃走者を固定せず、AI に動かせる。
 *
 * 固定したままだと「鬼が登れるか」しか見えない。実際には、鬼が登ってきたら
 * 逃走者は飛び降りて振り切れる可能性がある。**登れるようになったこと自体が
 * 鬼の時間を浪費させる罠になっていないか**は、動く相手で見ないと分からない。
 */
const FREE = process.argv[4] === 'free';
/**
 * `wall` を渡すと、高い足場を箱ではなく**内壁**（高さ 2.6）にする。
 * 内壁も小箱の上からは届く＝乗れる足場なので、逃げる側は壁の上を経由できる。
 * 鬼が壁を足場として無視していると、同じ穴が壁の側に残る。
 */
const VIA_WALL = process.argv[5] === 'wall';

function box(id: number, x: number, z: number, h: number): Obstacle {
  return {
    id,
    kind: 'box',
    x,
    z,
    y: 0,
    vy: 0,
    hw: 1,
    hd: 1,
    h,
    lockedBy: null,
    unlockProgress: 0,
    heldBy: -1,
    rampDir: 0,
  };
}

const config: MatchConfig = { hiders: 1, seekers: 1, playerTeam: null, seed: 1234 };
const game = new Game(config);
const s = game.state;

// 盤面を組み直す。中央に「低い台」、そこから GAP だけ離して「高い台」を 3 枚並べる。
s.obstacles.length = 0;
s.obstacles.push(box(1, 0, 0, BOX_HEIGHT_SMALL));
const highX = 2 + GAP; // 低い台の縁(1m) + 隙間 + 高い台の半幅(1m)
const HIGH_H = VIA_WALL ? 2.6 : BOX_HEIGHT_BIG; // 内壁は 2.6
const HIGH_KIND = VIA_WALL ? ('wall' as const) : ('box' as const);
for (const [i, z] of [-2, 0, 2].entries()) {
  const o = box(2 + i, highX, z, HIGH_H);
  o.kind = HIGH_KIND;
  s.obstacles.push(o);
}

const hider = s.agents.find((a) => a.team === 'hider')!;
const seeker = s.agents.find((a) => a.team === 'seeker')!;

// 逃走者は高い台の上、鬼は少し離れた地面。追跡フェーズから始める。
hider.x = highX;
hider.z = 0;
hider.y = HIGH_H;
seeker.x = -8;
seeker.z = 0;
seeker.y = 0;
s.phase = 'hunt';
s.time = 0;

const ai = new AiDirector(game);

console.log(`高所の再現  隙間 ${GAP} m  （低い台 ${BOX_HEIGHT_SMALL} / 高い台 ${HIGH_H} ${HIGH_KIND}）`);
console.log(`  地上からの登坂力 ${CLIMB_REACH.toFixed(2)} m → 高い台(${BOX_HEIGHT_BIG})には直接乗れない`);
console.log(`  低い台の上からは ${(BOX_HEIGHT_SMALL + CLIMB_REACH).toFixed(2)} m まで届く → 乗れるはず`);
console.log(`  捕獲の垂直判定 ${CATCH_VERTICAL} m → 地上の鬼は高い台の相手に触れない`);
console.log('');

let onLow = 0;
let onHigh = 0;
let maxY = 0;
let caught = false;
let jumpTicks = 0;
let groundedOnLow = 0;
const ticks = Math.ceil(SECONDS / DT);
for (let t = 0; t < ticks; t++) {
  const actions = ai.tick();
  const act = actions.get(seeker.id);
  const onLowNow = seeker.y > BOX_HEIGHT_SMALL - 0.2 && seeker.y < HIGH_H - 0.2;
  if (onLowNow && seeker.grounded) {
    groundedOnLow++;
    if (act?.jump) jumpTicks++;
    if (groundedOnLow % 120 === 1) {
      const d = Math.hypot(highX - seeker.x, 0 - seeker.z);
      console.log(
        `    [低い台の上] t=${s.time.toFixed(1)} 目標まで ${d.toFixed(1)}m  ` +
          `jump=${act?.jump} move=(${act?.moveX.toFixed(2)},${act?.moveZ.toFixed(2)})  ${ai.describe(seeker.id)}`,
      );
    }
  }
  game.step(actions);
  if (!FREE) {
    // 逃走者は動かさない。鬼が「登れるかどうか」だけを見る。
    hider.x = highX;
    hider.z = 0;
    hider.y = HIGH_H;
    hider.vx = 0;
    hider.vz = 0;
    hider.vy = 0;
  }

  if (seeker.y > maxY) maxY = seeker.y;
  if (seeker.y > BOX_HEIGHT_SMALL - 0.2 && seeker.y < HIGH_H - 0.2) onLow++;
  if (seeker.y >= HIGH_H - 0.2) onHigh++;
  if (hider.caught) {
    caught = true;
    console.log(`  捕獲 t=${s.time.toFixed(1)}`);
    break;
  }
  if (t % 300 === 0) {
    console.log(
      `  t=${s.time.toFixed(1).padStart(5)}  鬼(${seeker.x.toFixed(1)},${seeker.z.toFixed(1)}) y=${seeker.y.toFixed(2)}  ${ai.describe(seeker.id)}`,
    );
  }
}

console.log('');
console.log(`  到達した最高の高さ: ${maxY.toFixed(2)} m`);
console.log(`  低い台の上に居たティック: ${onLow} / 高い台の上: ${onHigh}`);
console.log(`  低い台の上で接地していたティック: ${groundedOnLow}、うち jump 指示: ${jumpTicks}`);
console.log(`  結果: ${caught ? '捕獲できた' : '**登れず、捕まえられなかった**'}`);

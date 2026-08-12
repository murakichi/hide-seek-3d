// 使い捨ての診断。囲まれた鬼が「なぜ解錠しないのか」を見る（issue #84）。
//
// `_probe-cage.ts` と同じ盤面を組み、鬼の入力と内部状態を毎秒出す。
// 見たいのは次の 3 つ。
//   - 解錠指示 (act.lock) が出ているか
//   - 移動入力が壁の方を向いているか（向いていないと findBlocker が空を返す）
//   - 目標が何秒で切り替わっているか（repickAfter で捨てていると解錠が続かない）
//
// 使い方: npx tsx src/sim/_probe-cage-why.ts [囲う個数] [半径]

import { AiDirector } from '../ai/director';
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
const COUNT = Number(process.argv[2] ?? 10);
const RING_R = Number(process.argv[3] ?? 4.2);

const config: MatchConfig = { hiders: 2, seekers: 2, playerTeam: null, seed: 1234 };
const game = new Game(config);
const s = game.state;

// ケージの外周にロックした大箱を並べる。
// **id は配列の添字と一致させること。** `a.grabbed = o.id` を
// `s.obstacles[a.grabbed]` で引くので、ずれると掴んだ瞬間に落ちる。
const ringFrom = s.obstacles.length;
for (let i = 0; i < COUNT; i++) {
  const a = (i / COUNT) * Math.PI * 2;
  s.obstacles.push({
    id: s.obstacles.length,
    kind: 'box',
    x: Math.cos(a) * RING_R,
    z: Math.sin(a) * RING_R,
    y: 0,
    vy: 0,
    hw: 1.1,
    hd: 1.1,
    h: BOX_HEIGHT_BIG,
    lockedBy: 'hider',
    unlockProgress: 0,
    heldBy: -1,
    rampDir: 0,
  });
}

const ai = new AiDirector(game);
const seeker = s.agents.find((a) => a.team === 'seeker')!;

console.log(`囲い ${COUNT} 個 @ 半径 ${RING_R}（ケージ ${SEEKER_CAGE_RADIUS}）`);
console.log('');

let lockTicks = 0;
let grabTicks = 0;
let huntTicks = 0;
let goalChanges = 0;
let prevGoal = '';
/** 解錠が進んだ最大値 */
let maxUnlock = 0;

for (let t = 0; t < MAX_TICKS; t++) {
  const actions = ai.tick();
  const act = actions.get(seeker.id);
  game.step(actions);
  if (s.phase !== 'hunt') {
    if (s.phase === 'over') break;
    continue;
  }
  huntTicks++;
  if (act?.lock) lockTicks++;
  if (act?.grab) grabTicks++;

  const desc = ai.describe(seeker.id);
  if (desc !== prevGoal) {
    goalChanges++;
    prevGoal = desc;
  }
  for (const o of s.obstacles) {
    if (o.unlockProgress > maxUnlock) maxUnlock = o.unlockProgress;
  }

  if (huntTicks % 300 === 1) {
    const r = Math.hypot(seeker.x, seeker.z);
    // 一番近い囲いの箱
    let near: Obstacle | null = null;
    let nd = Infinity;
    for (const o of s.obstacles) {
      if (o.id < ringFrom) continue;
      const d = Math.hypot(o.x - seeker.x, o.z - seeker.z);
      if (d < nd) {
        nd = d;
        near = o;
      }
    }
    const dot = near
      ? ((near.x - seeker.x) / nd) * (act?.moveX ?? 0) + ((near.z - seeker.z) / nd) * (act?.moveZ ?? 0)
      : 0;
    console.log(
      `t=${s.time.toFixed(1).padStart(5)} 半径 ${r.toFixed(1)}  ` +
        `lock=${act?.lock} grab=${act?.grab} 速度 ${Math.hypot(seeker.vx, seeker.vz).toFixed(1)}  ` +
        `最寄りの囲いまで ${nd.toFixed(1)}m 向き ${dot.toFixed(2)}  解錠 ${(near?.unlockProgress ?? 0).toFixed(2)}  ${desc}`,
    );
  }
}

console.log('');
console.log(`  追跡フェーズ ${huntTicks} ティック`);
console.log(`  解錠指示が出ていたティック: ${lockTicks} (${((lockTicks / Math.max(1, huntTicks)) * 100).toFixed(1)}%)`);
console.log(`  掴み指示が出ていたティック: ${grabTicks} (${((grabTicks / Math.max(1, huntTicks)) * 100).toFixed(1)}%)`);
console.log(`  目標が切り替わった回数: ${goalChanges}（${(huntTicks / Math.max(1, goalChanges) * DT).toFixed(2)} 秒に 1 回）`);
console.log(`  解錠の最大進行度: ${maxUnlock.toFixed(2)}（1.0 で解錠）`);
console.log(`  最終半径: ${Math.hypot(seeker.x, seeker.z).toFixed(1)}`);

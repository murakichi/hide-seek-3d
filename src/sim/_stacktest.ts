// 箱の積み上げが成立するかを、入力を手で組んで確かめる使い捨てスクリプト。
//   npx tsx src/sim/_stacktest.ts

import { AGENT_RADIUS, DT, STEP_HEIGHT } from '../core/config';
import { Game } from '../core/game';
import { emptyAction } from '../core/types';
import type { Action, Obstacle } from '../core/types';

const game = new Game({ hiders: 1, seekers: 1, playerTeam: null, seed: 1234 });
const s = game.state;
const hider = s.agents.find((a) => a.team === 'hider')!;

// 検証しやすいように、小さい箱を 2 つだけ手元に並べ直す。
const boxes = s.obstacles.filter((o) => o.kind === 'box' && o.h < 1.5).slice(0, 2);
if (boxes.length < 2) throw new Error('小さい箱が 2 つ必要');
const [target, carried] = boxes as [Obstacle, Obstacle];

// 邪魔な障害物を遠くへ退ける（この試験は物理だけを見る）。
for (const o of s.obstacles) {
  if (o.kind === 'wall') continue;
  if (o === target || o === carried) continue;
  o.x = 500;
  o.z = 500;
}
// 準備フェーズ中は逃げる側が中央のケージに入れないので、外周寄りで試す。
for (const a of s.agents) {
  a.x = 0;
  a.z = 0;
  a.y = 0;
}

target.x = 0;
target.z = 12;
target.y = 0;
carried.x = 0;
carried.z = 8;
carried.y = 0;

hider.x = 0;
hider.z = 8 - (carried.hd + AGENT_RADIUS + 0.3);
hider.facing = 0; // +Z を向く

const act = (over: Partial<Action>): Map<number, Action> =>
  new Map([[hider.id, { ...emptyAction(), ...over }]]);

const log = (label: string) =>
  console.log(
    `${label.padEnd(22)} 逃(${hider.x.toFixed(2)},${hider.z.toFixed(2)},y=${hider.y.toFixed(2)})  ` +
      `運ぶ箱 z=${carried.z.toFixed(2)} y=${carried.y.toFixed(2)}  ` +
      `台の箱 z=${target.z.toFixed(2)} 上面=${(target.y + target.h).toFixed(2)}`,
  );

log('初期');

// 1. 掴む（その場で 0.3 秒）
for (let t = 0; t < 0.3 / DT; t++) game.step(act({ grab: true }));
log('掴んだ後');
if (hider.grabbed !== carried.id) throw new Error('掴めていない');

// 2. 掴んだまま +Z へ押していき、台の箱の手前で跳ぶ
let jumped = false;
for (let t = 0; t < 4 / DT; t++) {
  const gap = target.z - target.hd - (carried.z + carried.hd);
  const wantJump = !jumped && gap < 0.9 && hider.grounded;
  if (wantJump) jumped = true;
  game.step(act({ grab: true, moveZ: 1, jump: wantJump }));
  if (jumped && carried.y > target.y + target.h - STEP_HEIGHT && carried.z > target.z - 0.2) break;
}
log('跳んで運んだ後');

// 3. 手を離して落とす
for (let t = 0; t < 2 / DT; t++) game.step(act({}));
log('放して落ちた後');

const top = target.y + target.h;
const stacked =
  Math.abs(carried.y - top) < 0.05 &&
  Math.abs(carried.x - target.x) < target.hw + carried.hw &&
  Math.abs(carried.z - target.z) < target.hd + carried.hd;

console.log('');
console.log(`台の箱の上面 ${top.toFixed(2)} / 運んだ箱の底 ${carried.y.toFixed(2)}`);
console.log(stacked ? '✓ 積み上がった' : '✗ 積み上がらなかった');
if (!stacked) process.exitCode = 1;

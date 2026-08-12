// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// issue #81「壁越しの箱を運ぼうとして失敗する」の実測。
//
//   - 掴んだ箱と置き場所の間に壁があった運搬の割合
//   - そのうち置き切れずに終わった割合
//   - 準備時間のうち «箱が進んでいない» 時間の割合
//
// 使い方: npx tsx src/sim/_probe.ts <hiders> <seekers> [seed0]

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig, Obstacle } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
const HIDERS = Number(process.argv[2] ?? 2);
const SEEKERS = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 1234);

/** 線分が «壁» または «据え置きの箱» に当たるか（数点サンプル）。 */
function crossesKind(
  kinds: (o: Obstacle) => boolean,
  obstacles: readonly Obstacle[],
  x1: number,
  z1: number,
  x2: number,
  z2: number,
): boolean {
  const steps = Math.max(4, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / 0.6));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = x1 + (x2 - x1) * t;
    const pz = z1 + (z2 - z1) * t;
    for (const o of obstacles) {
      if (!kinds(o)) continue;
      if (Math.abs(px - o.x) < o.hw + 0.5 && Math.abs(pz - o.z) < o.hd + 0.5) return true;
    }
  }
  return false;
}

let hauls = 0;
let haulsThroughWall = 0;
let haulsThroughBox = 0;
let haulTicks = 0;
let haulTicksThroughWall = 0;
/** 箱がほぼ動いていなかった運搬ティック */
let stalledTicks = 0;
let stalledThroughWall = 0;
let prepTicks = 0;
/** 運搬中に «置き場所に着く前に» 掴みが外れた回数 */
let grabLost = 0;
let reachedSlot = 0;

for (let g = 0; g < GAMES; g++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: SEED0 + g * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  /** agent id -> 掴んでいる箱 id と、掴んだ時点で壁を挟んでいたか */
  const held = new Map<number, { box: number; wall: boolean; lastX: number; lastZ: number }>();

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'prep') {
      for (const a of s.agents) {
        if (a.team !== 'hider') continue;
        prepTicks++;
        const cur = held.get(a.id);
        if (a.grabbed < 0) {
          if (cur) {
            const b = s.obstacles[cur.box];
            const home2 = ai.shelterOf(a.id);
            // 拠点の近くで放したなら «置けた»、そうでなければ «外れた»
            if (home2 && Math.hypot(b.x - home2.x, b.z - home2.z) < 5) reachedSlot++;
            else grabLost++;
          }
          held.delete(a.id);
          continue;
        }
        const box = s.obstacles[a.grabbed];
        const home = ai.shelterOf(a.id);
        if (!home) continue;
        if (!cur || cur.box !== a.grabbed) {
          // 掴んだ瞬間。箱 -> 拠点の間に壁があるかを記録する。
          const wall = crossesKind(
            (o) => o.kind === 'wall',
            s.obstacles,
            box.x,
            box.z,
            home.x,
            home.z,
          );
          // 据え置きの箱（自分が掴んでいるもの以外で、ロック済み＝拠点の壁）
          const boxBlock = crossesKind(
            (o) => o.kind === 'box' && o.id !== box.id && o.lockedBy !== null,
            s.obstacles,
            box.x,
            box.z,
            home.x,
            home.z,
          );
          if (boxBlock) haulsThroughBox++;
          held.set(a.id, { box: a.grabbed, wall, lastX: box.x, lastZ: box.z });
          hauls++;
          if (wall) haulsThroughWall++;
          continue;
        }
        haulTicks++;
        if (cur.wall) haulTicksThroughWall++;
        const moved = Math.hypot(box.x - cur.lastX, box.z - cur.lastZ);
        cur.lastX = box.x;
        cur.lastZ = box.z;
        if (moved < 0.02) {
          stalledTicks++;
          if (cur.wall) stalledThroughWall++;
        }
      }
    }

    game.step(actions);
    if (game.state.phase === 'over') break;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合 (seed0=${SEED0})`);
console.log(`  運搬の開始: ${hauls} 回   うち箱と拠点の間に壁: ${haulsThroughWall} (${pct(haulsThroughWall, hauls)})`);
console.log(`  うち据え置きの箱（ロック済み）を挟む: ${haulsThroughBox} (${pct(haulsThroughBox, hauls)})`);
console.log(`  運搬中のティック: ${haulTicks}   うち壁越し: ${pct(haulTicksThroughWall, haulTicks)}`);
console.log(`  箱が動いていなかったティック: ${pct(stalledTicks, haulTicks)}`);
console.log(`    壁越しの運搬に限ると: ${pct(stalledThroughWall, haulTicksThroughWall)}`);
console.log(`    壁を挟まない運搬に限ると: ${pct(stalledTicks - stalledThroughWall, haulTicks - haulTicksThroughWall)}`);
console.log(`  運搬の終わり方: 拠点に届いた ${reachedSlot} / 途中で外れた ${grabLost} (${pct(grabLost, reachedSlot + grabLost)} が失敗)`);
console.log(`  準備フェーズに占める運搬の時間: ${pct(haulTicks, prepTicks)}`);

// フィールド生成。シードから決定論的に障害物を並べる。

import { ARENA_HALF, BOX_HEIGHT_BIG, BOX_HEIGHT_SMALL, SEEKER_CAGE_RADIUS } from './config';
import { Rng } from './rng';
import type { Obstacle, ObstacleKind, Pickup } from './types';

let nextId = 0;

function make(
  kind: ObstacleKind,
  x: number,
  z: number,
  hw: number,
  hd: number,
  h: number,
  rampDir: 0 | 1 | 2 | 3 = 0,
): Obstacle {
  return {
    id: nextId++,
    kind,
    x,
    z,
    y: 0,
    vy: 0,
    hw,
    hd,
    h,
    lockedBy: null,
    unlockProgress: 0,
    heldBy: -1,
    rampDir,
  };
}

/** 外周の壁。エージェントが場外に出ないようにする物理的な境界も兼ねる。 */
function borderWalls(): Obstacle[] {
  const t = 0.6;
  const a = ARENA_HALF + t;
  return [
    make('wall', 0, a, a + t, t, 3),
    make('wall', 0, -a, a + t, t, 3),
    make('wall', a, 0, t, a + t, 3),
    make('wall', -a, 0, t, a + t, 3),
  ];
}

/** 部屋らしさを作る固定壁。中央のケージ周辺は空けておく。 */
function interiorWalls(rng: Rng): Obstacle[] {
  const walls: Obstacle[] = [];
  const t = 0.5;
  const wallH = 2.6;

  // 4 象限それぞれに L 字の仕切りを 1 つ置く。長さと位置だけランダム化する。
  const quads: Array<[number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (const [sx, sz] of quads) {
    const cx = sx * rng.range(7, 14);
    const cz = sz * rng.range(7, 14);
    const lenA = rng.range(4, 8);
    const lenB = rng.range(3.5, 7);
    // L 字の 2 辺。片方に隙間（入口）が空くように少しずらす。
    walls.push(make('wall', cx, cz - sz * lenA * 0.5, t, lenA * 0.5, wallH));
    walls.push(make('wall', cx + sx * lenB * 0.5, cz, lenB * 0.5, t, wallH));
  }

  // 中央を横切る短い壁（鬼が出た直後の視界を切る）
  const side = rng.next() < 0.5 ? 1 : -1;
  walls.push(make('wall', side * rng.range(4.5, 6.5), 0, t, rng.range(2.5, 4), wallH));

  return walls;
}

/** 中央のケージから離れた位置をサンプリングする。 */
function scatterPos(rng: Rng, existing: Obstacle[], hw: number, hd: number): { x: number; z: number } | null {
  for (let attempt = 0; attempt < 60; attempt++) {
    const x = rng.range(-ARENA_HALF + 2, ARENA_HALF - 2);
    const z = rng.range(-ARENA_HALF + 2, ARENA_HALF - 2);
    if (Math.hypot(x, z) < SEEKER_CAGE_RADIUS + 2.5) continue;
    const margin = 1.2;
    let ok = true;
    for (const o of existing) {
      if (
        Math.abs(x - o.x) < hw + o.hw + margin &&
        Math.abs(z - o.z) < hd + o.hd + margin
      ) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, z };
  }
  return null;
}

/**
 * 障害物一式を生成する。
 * @param seed 乱数シード
 * @param scale 参加人数に応じた物量スケール（1on1 で 1.0、3on3 で 1.6 程度）
 */
export function buildArena(seed: number, scale: number): Obstacle[] {
  nextId = 0;
  const rng = new Rng(seed);
  const obstacles: Obstacle[] = [...borderWalls(), ...interiorWalls(rng)];

  // 押して動かせる箱。大小混ぜる（小さい箱は運びやすく、大きい箱は壁になる）。
  const boxCount = Math.round(10 * scale);
  for (let i = 0; i < boxCount; i++) {
    const big = rng.next() < 0.4;
    const hw = big ? rng.range(1.1, 1.5) : rng.range(0.65, 0.9);
    const hd = big ? rng.range(1.1, 1.5) : rng.range(0.65, 0.9);
    const h = big ? BOX_HEIGHT_BIG : BOX_HEIGHT_SMALL;
    const p = scatterPos(rng, obstacles, hw, hd);
    if (!p) continue;
    obstacles.push(make('box', p.x, p.z, hw, hd, h));
  }

  // ランプ。箱の上に登るための手段。動かせない。
  const rampCount = Math.max(2, Math.round(2 * scale));
  for (let i = 0; i < rampCount; i++) {
    const dir = rng.int(0, 4) as 0 | 1 | 2 | 3;
    const along = 2.6;
    const across = 1.3;
    const hw = dir <= 1 ? along : across;
    const hd = dir <= 1 ? across : along;
    const p = scatterPos(rng, obstacles, hw, hd);
    if (!p) continue;
    obstacles.push(make('ramp', p.x, p.z, hw, hd, 1.6, dir));
  }

  // ジャンプ台。踏むと箱や内壁の上まで一気に上がれる。
  // 追う側も使えるので、高所は安全地帯ではなく「別のルート」として機能する。
  const padCount = Math.max(2, Math.round(2.5 * scale));
  for (let i = 0; i < padCount; i++) {
    const p = scatterPos(rng, obstacles, 1, 1);
    if (!p) continue;
    obstacles.push(make('pad', p.x, p.z, 1, 1, 0.25));
  }

  return obstacles;
}

/**
 * 補給パックを撒く。開けた場所ではなく、壁や箱の陰になりやすい位置を選ぶ
 * （取りに行くこと自体がリスクになるように）。
 */
export function buildPickups(seed: number, obstacles: readonly Obstacle[], count: number): Pickup[] {
  const rng = new Rng(seed ^ 0x27d4eb2f);
  const pickups: Pickup[] = [];

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const x = rng.range(-ARENA_HALF + 2, ARENA_HALF - 2);
      const z = rng.range(-ARENA_HALF + 2, ARENA_HALF - 2);
      if (Math.hypot(x, z) < SEEKER_CAGE_RADIUS + 3) continue;

      let clear = true;
      for (const o of obstacles) {
        if (Math.abs(x - o.x) < o.hw + 1.1 && Math.abs(z - o.z) < o.hd + 1.1) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      // 既に置いたパックとは離す。1 箇所にまとめ取りされないように。
      if (pickups.some((p) => Math.hypot(p.x - x, p.z - z) < 7)) continue;

      pickups.push({ id: pickups.length, x, z, active: true, respawnAt: 0 });
      break;
    }
  }
  return pickups;
}

/** ランプ上の指定位置における床の高さ。傾斜方向に沿って線形に上る。 */
export function rampHeightAt(o: Obstacle, x: number, z: number): number {
  let t: number;
  switch (o.rampDir) {
    case 0:
      t = (x - (o.x - o.hw)) / (o.hw * 2);
      break;
    case 1:
      t = ((o.x + o.hw) - x) / (o.hw * 2);
      break;
    case 2:
      t = (z - (o.z - o.hd)) / (o.hd * 2);
      break;
    default:
      t = ((o.z + o.hd) - z) / (o.hd * 2);
      break;
  }
  return Math.max(0, Math.min(1, t)) * o.h;
}

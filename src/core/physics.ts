// 幾何・衝突のプリミティブ。状態を持たない純関数だけを置く。

import { rampHeightAt } from './arena';
import { STEP_HEIGHT } from './config';
import type { Obstacle } from './types';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 円 (x, z, r) が AABB と重なっていれば、最短距離で押し出した新しい中心を返す。
 * 重なっていなければ null。
 */
export function pushCircleOutOfBox(
  x: number,
  z: number,
  r: number,
  o: Obstacle,
): { x: number; z: number } | null {
  const relX = x - o.x;
  const relZ = z - o.z;
  const nearX = clamp(relX, -o.hw, o.hw);
  const nearZ = clamp(relZ, -o.hd, o.hd);
  const dx = relX - nearX;
  const dz = relZ - nearZ;
  const d2 = dx * dx + dz * dz;

  if (d2 > r * r) return null;

  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    const push = r - d;
    return { x: x + (dx / d) * push, z: z + (dz / d) * push };
  }

  // 中心が矩形の内側に入り込んでいる場合は、貫入の浅い軸へ抜く。
  const penX = o.hw + r - Math.abs(relX);
  const penZ = o.hd + r - Math.abs(relZ);
  if (penX < penZ) {
    const s = relX >= 0 ? 1 : -1;
    return { x: o.x + s * (o.hw + r), z };
  }
  const s = relZ >= 0 ? 1 : -1;
  return { x, z: o.z + s * (o.hd + r) };
}

/** その障害物が、足元 feetY にいるエージェントの水平移動を遮るか。 */
export function blocksHorizontally(o: Obstacle, feetY: number): boolean {
  // 斜面は登れるので、ジャンプ台は踏めるように、どちらも通過扱いにする。
  if (o.kind === 'ramp' || o.kind === 'pad') return false;
  return o.h > feetY + STEP_HEIGHT;
}

/**
 * (x, z) で足を乗せられる面の高さ。地面は 0。
 * feetY より STEP_HEIGHT 以上高い面には乗れない（横からめり込めない）。
 */
export function supportHeight(
  obstacles: readonly Obstacle[],
  x: number,
  z: number,
  r: number,
  feetY: number,
): number {
  let best = 0;
  for (const o of obstacles) {
    if (o.kind === 'ramp') {
      if (Math.abs(x - o.x) > o.hw || Math.abs(z - o.z) > o.hd) continue;
      const h = rampHeightAt(o, x, z);
      if (h <= feetY + STEP_HEIGHT && h > best) best = h;
      continue;
    }
    // 上面に乗るのは、円の中心が矩形の少し外側までに収まっているとき。
    if (Math.abs(x - o.x) > o.hw + r * 0.7 || Math.abs(z - o.z) > o.hd + r * 0.7) continue;
    if (o.h <= feetY + STEP_HEIGHT && o.h > best) best = o.h;
  }
  return best;
}

/** AABB 同士が重なるか（掴んだ箱を動かすときの判定用）。 */
export function boxesOverlap(a: Obstacle, ax: number, az: number, b: Obstacle, margin = 0): boolean {
  return (
    Math.abs(ax - b.x) < a.hw + b.hw + margin && Math.abs(az - b.z) < a.hd + b.hd + margin
  );
}

/** レイと AABB の交差判定（slab method）。垂直方向も見るので箱を飛び越えた視線は通る。 */
function raySegmentHitsBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  len: number,
  o: Obstacle,
): boolean {
  const bounds = [
    [o.x - o.hw, o.x + o.hw],
    [0, o.h],
    [o.z - o.hd, o.z + o.hd],
  ];
  const org = [ox, oy, oz];
  const dir = [dx, dy, dz];

  let tMin = 0;
  let tMax = len;
  for (let i = 0; i < 3; i++) {
    const d = dir[i];
    const [lo, hi] = bounds[i];
    if (Math.abs(d) < 1e-8) {
      if (org[i] < lo || org[i] > hi) return false;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - org[i]) * inv;
    let t2 = (hi - org[i]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }
  return true;
}

/** 2 点間に視線が通るか（障害物に遮られていなければ true）。 */
export function hasLineOfSight(
  obstacles: readonly Obstacle[],
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;

  for (const o of obstacles) {
    // ランプとジャンプ台は低いので、視線は遮らない扱いにする（見た目と一致させる）。
    if (o.kind === 'ramp' || o.kind === 'pad') continue;
    if (raySegmentHitsBox(x1, y1, z1, nx, ny, nz, len, o)) return false;
  }
  return true;
}

/** 線分が球と交わるか。煙が視線を遮っているかの判定に使う。 */
export function segmentHitsSphere(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-9) {
    return (x1 - cx) ** 2 + (y1 - cy) ** 2 + (z1 - cz) ** 2 <= r * r;
  }
  // 線分上で球心に最も近い点を求め、その距離を半径と比べる。
  let t = ((cx - x1) * dx + (cy - y1) * dy + (cz - z1) * dz) / len2;
  t = clamp(t, 0, 1);
  const px = x1 + dx * t - cx;
  const py = y1 + dy * t - cy;
  const pz = z1 + dz * t - cz;
  return px * px + py * py + pz * pz <= r * r;
}

/** 角度差を -PI..PI に正規化する。 */
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

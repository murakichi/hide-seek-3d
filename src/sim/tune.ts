// AI パラメータの自動チューニング。
// 片方の陣営のパラメータだけを揺らして自己対戦させ、勝率が上がった変更を採用する
// （ランダム再スタート付きの山登り）。結果は src/ai/tuned.json に書き出され、
// ゲーム側は起動時にそれを読み込む。
//
// 使い方:
//   npm run tune -- --side hider --iters 40 --games 16 --hiders 2 --seekers 2
//   npm run tune -- --side seeker --iters 40

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cloneParams, DEFAULT_PARAMS, type AiParams } from '../ai/params';
import { Rng } from '../core/rng';
import type { MatchConfig, Team } from '../core/types';
import { runMatch } from './headless';

type Range = [number, number];

const SEEKER_RANGES: Record<string, Range> = {
  chaseDashDist: [6, 24],
  memoryTrust: [2, 14],
  patrolDistWeight: [0.1, 1.6],
  lockedBoxLure: [0, 20],
  repathInterval: [0.2, 0.8],
  scanSpeed: [0.4, 4],
  clearDist: [1.2, 4],
};

const HIDER_RANGES: Record<string, Range> = {
  boostGrabSafeDist: [0, 16],
  boostGrabDist: [0, 16],
  perchPrepMargin: [4, 20],
  padApproach: [4, 18],
  gapHopReach: [0, 7],
  perchIsolation: [1.5, 6],
  lockShelter: [0, 1],
  decoyLockDist: [0, 18],
  decoyLockMargin: [4, 18],
  shelterRadius: [2, 4],
  fleeTriggerDist: [6, 20],
  fleeDashDist: [3, 16],
  fleeSamples: [8, 32],
  fleeDistWeight: [0.3, 2.5],
  fleeCoverBonus: [0, 40],
  fleeTurnCost: [0, 60],
  fleeClimbCost: [0, 40],
  retreatMargin: [1, 8],
  roamBias: [0, 0.8],
  threatMemory: [4, 20],
  threatKeepAway: [4, 18],
};

function ranges(side: Team): Record<string, Range> {
  return side === 'seeker' ? SEEKER_RANGES : HIDER_RANGES;
}

function clamp(v: number, [lo, hi]: Range): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 1〜3 個のパラメータをランダムに選んで摂動させる。 */
function mutate(base: AiParams, side: Team, rng: Rng): AiParams {
  const next = cloneParams(base);
  const table = ranges(side);
  const keys = Object.keys(table);
  const count = 1 + rng.int(0, 3);

  for (let i = 0; i < count; i++) {
    const key = rng.pick(keys);
    const range = table[key];
    const span = range[1] - range[0];
    // 正規分布に近い揺らぎ。小さな調整を多めに、たまに大きく動かす。
    const noise = (rng.next() + rng.next() + rng.next() - 1.5) * 0.45;
    const target = side === 'seeker' ? next.seeker : next.hider;
    const current = (target as unknown as Record<string, number>)[key];
    (target as unknown as Record<string, number>)[key] = clamp(current + span * noise, range);
  }
  return next;
}

/**
 * side 側の勝率を測る。
 * 相手側のパラメータは baseline のまま固定し、シード列も固定して比較の分散を抑える。
 *
 * 人数構成は必ず複数まとめて評価する。1 つの構成だけで最適化すると、
 * その人数でしか通用しない値が「勝率が上がった」として採用されてしまう。
 */
function evaluate(
  candidate: AiParams,
  baseline: AiParams,
  side: Team,
  games: number,
  sizes: Array<[number, number]>,
  seed0: number,
): number {
  const params: AiParams = {
    seeker: side === 'seeker' ? candidate.seeker : baseline.seeker,
    hider: side === 'hider' ? candidate.hider : baseline.hider,
  };

  let wins = 0;
  let total = 0;
  for (const [hiders, seekers] of sizes) {
    for (let i = 0; i < games; i++) {
      const config: MatchConfig = { hiders, seekers, playerTeam: null, seed: seed0 + i * 7919 };
      if (runMatch(config, params).winner === side) wins++;
      total++;
    }
  }
  return wins / total;
}

/** "1x1,2x2" のような指定を人数構成の配列にする。 */
function parseSizes(spec: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)\s*[xv]\s*(\d+)$/i);
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out.length > 0 ? out : [[1, 1], [2, 2], [3, 3]];
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function main(): void {
  const side = (argStr('side', 'hider') === 'seeker' ? 'seeker' : 'hider') as Team;
  const iters = arg('iters', 30);
  const games = arg('games', 10);
  const sizes = parseSizes(argStr('sizes', '1x1,2x2,3x3'));
  const seed0 = arg('seed', 20260810);
  const write = !process.argv.includes('--dry-run');

  const rng = new Rng(seed0 ^ 0x5f3759df);
  let best = cloneParams(DEFAULT_PARAMS);
  let bestScore = evaluate(best, DEFAULT_PARAMS, side, games, sizes, seed0);

  const label = sizes.map(([h, s]) => `${h}v${s}`).join('/');
  console.log(`${side} を ${label} で調整 (${iters} 世代 x ${games * sizes.length} 試合)`);
  console.log(`初期勝率 ${(bestScore * 100).toFixed(1)}%\n`);

  let sinceImprovement = 0;
  for (let i = 0; i < iters; i++) {
    // 手詰まりが続いたら、初期値から探索し直して局所解を抜ける。
    const seedParams = sinceImprovement >= 8 ? cloneParams(DEFAULT_PARAMS) : best;
    const candidate = mutate(seedParams, side, rng);
    const score = evaluate(candidate, DEFAULT_PARAMS, side, games, sizes, seed0);

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
      sinceImprovement = 0;
      console.log(`  #${i + 1} 更新 -> ${(score * 100).toFixed(1)}%`);
    } else {
      sinceImprovement++;
      if (sinceImprovement === 8) console.log(`  #${i + 1} 停滞のため探索を再開`);
    }
  }

  console.log(`\n最終勝率 ${(bestScore * 100).toFixed(1)}%`);
  const tunedSide = side === 'seeker' ? best.seeker : best.hider;
  console.log(JSON.stringify({ [side]: tunedSide }, null, 2));

  if (write) {
    // 反対側の調整結果を消さないよう、既存の内容にマージする。
    const path = resolve(process.cwd(), 'src/ai/tuned.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      existing = {};
    }
    const merged = { ...existing, [side]: tunedSide };
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    console.log(`\n${path} に書き出しました。`);
  }
}

main();

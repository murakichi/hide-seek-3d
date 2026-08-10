// AI の挙動を決める数値。ここだけを触れば戦術を調整できるようにしてある
// （ヘッドレス対戦での自動チューニング / 改善ループの対象）。

import tuned from './tuned.json';

export interface SeekerParams {
  /** 追跡時にダッシュを使う距離のしきい値 */
  chaseDashDist: number;
  /** 直近目撃をどれだけ信用し続けるか（秒） */
  memoryTrust: number;
  /** 巡回目標を選ぶときの「距離」ペナルティ係数 */
  patrolDistWeight: number;
  /** ロックされた箱の周辺を怪しむ強さ */
  lockedBoxLure: number;
  /** 目標再計算の間隔（秒） */
  repathInterval: number;
  /** 見回し（首振り）の角速度 */
  scanSpeed: number;
  /** 進路を塞ぐ箱をどけると判断する距離 */
  clearDist: number;
}

export interface HiderParams {
  /** 拠点の外周半径（この円周上に箱を並べる） */
  shelterRadius: number;
  /** 鬼をこの距離まで感知したら逃走に切り替える */
  fleeTriggerDist: number;
  /** 逃走時にダッシュを使う距離 */
  fleeDashDist: number;
  /** 逃走先候補のサンプル数 */
  fleeSamples: number;
  /** 逃走先スコア：鬼からの距離の重み */
  fleeDistWeight: number;
  /** 逃走先スコア：鬼から見えない場所のボーナス */
  fleeCoverBonus: number;
  /** 逃走先スコア：直前に選んだ方向から向きを変えることの代償（1 ラジアンあたり） */
  fleeTurnCost: number;
  /** 準備終了の何秒前に拠点へ戻るか */
  retreatMargin: number;
  /** 拠点に籠もるか、動き回るかの傾向（0=静止, 1=遊動） */
  roamBias: number;
}

export interface AiParams {
  seeker: SeekerParams;
  hider: HiderParams;
}

/** 手で決めた基準値。自動チューニングの出発点でもある。 */
const BASE_PARAMS: AiParams = {
  seeker: {
    chaseDashDist: 14,
    memoryTrust: 6,
    patrolDistWeight: 0.55,
    lockedBoxLure: 8,
    repathInterval: 0.4,
    scanSpeed: 1.9,
    clearDist: 2.2,
  },
  hider: {
    shelterRadius: 2.5,
    fleeTriggerDist: 13,
    fleeDashDist: 9,
    fleeSamples: 24,
    fleeDistWeight: 1,
    fleeCoverBonus: 14,
    fleeTurnCost: 30,
    retreatMargin: 3,
    roamBias: 0.25,
  },
};

/** 深いコピー（チューニング時に元を壊さないため）。 */
export function cloneParams(p: AiParams): AiParams {
  return { seeker: { ...p.seeker }, hider: { ...p.hider } };
}

/**
 * `npm run tune` が書き出した値を基準値に重ねる。
 * tuned.json が空でも動くように、キー単位の部分マージにしてある。
 */
function applyTuned(base: AiParams, overrides: Partial<Record<keyof AiParams, unknown>>): AiParams {
  const merged = cloneParams(base);
  for (const side of ['seeker', 'hider'] as const) {
    const patch = overrides[side];
    if (!patch || typeof patch !== 'object') continue;
    const target = merged[side] as unknown as Record<string, number>;
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (key in target && typeof value === 'number' && Number.isFinite(value)) {
        target[key] = value;
      }
    }
  }
  return merged;
}

export const DEFAULT_PARAMS: AiParams = applyTuned(BASE_PARAMS, tuned);

// 味方同士の申し合わせ。チームごとに 1 つ持ち、全員がここを読み書きする。
//
// 協調には 3 つの段階があり、必要な強さが違うので別々の仕組みにしてある。
//
//   1. 共有知識 (`grid`)     — 「そこは調べた」など、誰の持ち物でもない事実
//   2. 意図の共有 (`post`)   — 「自分はここへ向かう」。強制力は無く、参考にするだけ
//   3. 予約 (`claim`)        — 「これは自分が引き受けた」。1 つを取り合わないための排他
//
// 弱い方から使うこと。予約は取り合いと乗っ取りが起きるので、
// 「近くに寄りすぎない」程度で足りるなら 2 で済ませる。
//
// **「見たものの共有」はここには無い。** それはゲーム本体の担当で、
// `game.state.memory[team]` にチーム共有の「最後に見た敵の位置と時刻」が入っている
// （`src/core/vision.ts` の `updateMemory`）。1 人が見つければチーム全員が知る。
// ここに作り直さないこと。
//
// **決定論を壊さないこと。** ここは `Math.random()` も実時間も使わない。
// 取り合いの決着は「点差 → ID の小さい方」で必ず一意に決まる。

/**
 * 予約の種類。増やすときはここに足す。
 *
 * - `target`  追う相手 / 警戒する相手
 * - `area`    担当する区画
 * - `shelter` 拠点
 * - `box`     運ぶ箱
 */
export type ClaimKind = 'target' | 'area' | 'shelter' | 'box';

/** 味方が今やろうとしていること。強制力は無い。 */
export interface Intent {
  /** 行動の名前。`SeekerBrain.mode` などをそのまま入れる */
  mode: string;
  /** 向かっている先 */
  x: number;
  z: number;
  /** 相手を追っているならその ID。無ければ -1 */
  targetId: number;
  /** 最後に更新した時刻 */
  at: number;
}

interface Claim {
  key: string;
  owner: number;
  /** 主張の強さ。大きいほど優先。奪うには差が `STEAL_MARGIN` 以上必要 */
  score: number;
  /** 予約に紐づく座標（拠点など、キーだけでは位置が決まらないもの用） */
  x: number;
  z: number;
  /** 最後に主張し直した時刻 */
  at: number;
  /** これを過ぎて主張し直されなければ捨てる。`Infinity` なら捨てない */
  ttl: number;
}

export interface ClaimOptions {
  /** 予約に紐づく座標 */
  x?: number;
  z?: number;
  /**
   * 主張し直さずに保てる秒数。既定は `CLAIM_TTL`。
   *
   * 毎ティック主張し直す使い方（区画の担当など）は既定でよい。
   * 試合を通して動かさないもの（拠点）は `Infinity` にする。
   * **既定のまま「一度だけ主張して放置」をやると、掃除で消えて事故になる。**
   */
  ttl?: number;
}

/**
 * 予約を奪うのに必要な点差。
 *
 * 0 にすると、わずかな点差で毎ティック持ち主が入れ替わる。
 * `fleeDirection` が毎ティック方向を選び直して速度が乗らなかったのと同じ形の事故で、
 * あちらは 1 ティックあたり平均 10.7 度の振れとして観測された
 * （`docs/journal/2026-08-10.md`）。予約でも同じことが起きるので最初から入れておく。
 * 実際に取り合う予約を足すときは `src/ai/params.ts` へ移して自動探索の対象にすること。
 */
const STEAL_MARGIN = 4;

/**
 * 主張し直されなくなった予約を捨てるまでの秒数。
 * 思考は毎ティック走るので短くてよい。長いと、
 * 諦めた相手の予約が残って味方が動けなくなる。
 */
const CLAIM_TTL = 0.4;

/** 意図を「まだ有効」とみなす秒数。 */
const INTENT_TTL = 0.5;

export class TeamCoop {
  /** 「このセルを最後に確認した時刻」など、チームで共有する数値マップ */
  readonly grid: Float32Array;

  /** kind ごとの key → 予約 */
  private claims = new Map<ClaimKind, Map<string, Claim>>();
  /** 逆引き: owner → kind → key */
  private owned = new Map<number, Map<ClaimKind, string>>();
  private intents = new Map<number, Intent>();

  constructor(gridSize: number) {
    this.grid = new Float32Array(gridSize);
  }

  // ---- 共有知識 ---------------------------------------------------------

  /** `grid` の添字。呼び出し側が NavGrid の添字をそのまま使う前提。 */
  markGrid(index: number, time: number): void {
    this.grid[index] = time;
  }

  // ---- 意図の共有 -------------------------------------------------------

  /** 自分が今どこへ何をしに行くかを掲示する。毎ティック呼ぶ。 */
  post(agentId: number, intent: Omit<Intent, 'at'>, now: number): void {
    this.intents.set(agentId, { ...intent, at: now });
  }

  /**
   * 味方の意図。自分の分は含まない。
   * 掲示が古いものは除く（諦めた相手の目標を避け続けないように）。
   */
  others(agentId: number, now: number): Intent[] {
    const out: Intent[] = [];
    for (const [id, it] of this.intents) {
      if (id === agentId) continue;
      if (now - it.at > INTENT_TTL) continue;
      out.push(it);
    }
    return out;
  }

  /** 同じ相手を狙っている味方の数（自分を含まない）。 */
  othersTargeting(agentId: number, targetId: number, now: number): number {
    let n = 0;
    for (const it of this.others(agentId, now)) {
      if (it.targetId === targetId) n++;
    }
    return n;
  }

  // ---- 予約 -------------------------------------------------------------

  /**
   * `key` を自分のものとして主張する。取れたら true。
   *
   * 空いていれば取れる。自分が持っていれば更新するだけ。
   * 他人が持っている場合は、点差が `STEAL_MARGIN` を超えたときだけ奪える。
   * 同点は ID の小さい方が勝つ（決定論のため。順序に依存させない）。
   *
   * 1 エージェントが同じ kind で持てる予約は 1 つ。別の key を主張すると乗り換える。
   */
  claim(
    kind: ClaimKind,
    key: string,
    agentId: number,
    score: number,
    now: number,
    opts: ClaimOptions = {},
  ): boolean {
    const byKey = this.claims.get(kind) ?? new Map<string, Claim>();
    if (!this.claims.has(kind)) this.claims.set(kind, byKey);

    const held = byKey.get(key);
    if (held && held.owner !== agentId) {
      const stale = now - held.at > held.ttl;
      const beats =
        score > held.score + STEAL_MARGIN ||
        (score === held.score && agentId < held.owner);
      if (!stale && !beats) return false;
      this.dropOwned(held.owner, kind);
    }

    // 同じ kind の別の予約を持っていたら手放す。
    const prev = this.owned.get(agentId)?.get(kind);
    if (prev !== undefined && prev !== key) {
      const prevMap = this.claims.get(kind);
      if (prevMap?.get(prev)?.owner === agentId) prevMap.delete(prev);
    }

    byKey.set(key, {
      key,
      owner: agentId,
      score,
      x: opts.x ?? 0,
      z: opts.z ?? 0,
      at: now,
      ttl: opts.ttl ?? CLAIM_TTL,
    });
    let mine = this.owned.get(agentId);
    if (!mine) {
      mine = new Map();
      this.owned.set(agentId, mine);
    }
    mine.set(kind, key);
    return true;
  }

  /** その key を押さえている味方の ID。空いていれば null。 */
  holder(kind: ClaimKind, key: string): number | null {
    return this.claims.get(kind)?.get(key)?.owner ?? null;
  }

  /** 自分がその kind で押さえている key。無ければ null。 */
  keyOf(agentId: number, kind: ClaimKind): string | null {
    return this.owned.get(agentId)?.get(kind) ?? null;
  }

  /** 自分がその kind で押さえている座標。無ければ null。 */
  posOf(agentId: number, kind: ClaimKind): { x: number; z: number } | null {
    const key = this.keyOf(agentId, kind);
    if (key === null) return null;
    const c = this.claims.get(kind)?.get(key);
    return c ? { x: c.x, z: c.z } : null;
  }

  /** 予約を手放す。kind を省くと全部。 */
  release(agentId: number, kind?: ClaimKind): void {
    const mine = this.owned.get(agentId);
    if (!mine) return;
    for (const [k, key] of mine) {
      if (kind !== undefined && k !== kind) continue;
      const byKey = this.claims.get(k);
      if (byKey?.get(key)?.owner === agentId) byKey.delete(key);
      mine.delete(k);
    }
  }

  private dropOwned(agentId: number, kind: ClaimKind): void {
    this.owned.get(agentId)?.delete(kind);
  }

  /**
   * 期限切れと、脱落した味方の分を掃除する。毎ティック 1 回、思考の前に呼ぶ。
   * これが無いと、捕まった味方が押さえたままの区画を全員が避け続ける。
   */
  sweep(now: number, active: ReadonlySet<number>): void {
    for (const [kind, byKey] of this.claims) {
      for (const [key, c] of byKey) {
        if (now - c.at <= c.ttl && active.has(c.owner)) continue;
        byKey.delete(key);
        this.dropOwned(c.owner, kind);
      }
    }
    for (const [id, it] of this.intents) {
      if (active.has(id) && now - it.at <= INTENT_TTL) continue;
      this.intents.delete(id);
    }
  }

  // ---- 観測 -------------------------------------------------------------

  /**
   * トレース用の 1 行表示。
   * 集計値だけでは「味方が譲り合って両方止まった」のような事故が見えない
   * （このプロジェクトは同じ形の見落としを何度かやっている）。
   */
  describe(now: number): string {
    const parts: string[] = [];
    for (const [kind, byKey] of this.claims) {
      const items = [...byKey.values()]
        .filter((c) => now - c.at <= c.ttl)
        .sort((a, b) => (a.owner - b.owner) || (a.key < b.key ? -1 : 1))
        .map((c) => `#${c.owner}:${c.key}`);
      if (items.length) parts.push(`${kind}[${items.join(' ')}]`);
    }
    return parts.length ? parts.join(' ') : '-';
  }

  /** トレース用。掲示されている意図を 1 行で。 */
  describeIntents(agentIds: readonly number[], now: number): string {
    const parts: string[] = [];
    for (const id of agentIds) {
      const it = this.intents.get(id);
      if (!it || now - it.at > INTENT_TTL) continue;
      const tgt = it.targetId >= 0 ? `→#${it.targetId}` : '';
      parts.push(`#${id} ${it.mode}${tgt}(${it.x.toFixed(0)},${it.z.toFixed(0)})`);
    }
    return parts.length ? parts.join('  ') : '-';
  }
}

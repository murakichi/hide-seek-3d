// 鬼の思考。見えていれば追う、見失えば最後の目撃地点、それも無ければ
// 「長く見ていない場所」を優先して巡回する。ロックされた箱は隠れ場所の手がかりとして重視する。

import {
  CATCH_VERTICAL,
  CLIMB_REACH,
  GRAVITY,
  JUMP_SPEED,
  DT,
  GRAB_RANGE,
  SEEKER_SPEED,
  STEP_HEIGHT,
  STAMINA_MAX,
  viewDistFor,
  VIEW_FOV,
} from '../core/config';
import { canSee } from '../core/vision';
import type { Action, Agent, Obstacle } from '../core/types';
import {
  directIfClear,
  emptyAction,
  followPath,
  nearestPickup,
  shouldJump,
  Ticker,
  type AiContext,
} from './context';

type Mode = 'chase' | 'investigate' | 'patrol';

/**
 * 跳び移り先として認める落差の下限。これより下の面は、跳ばずに歩いて落ちればよい。
 * ただし隙間を挟んでいる場合は跳ばないと届かないので、少しだけ下も対象にする。
 */
const LEAP_DROP = 1.2;

/**
 * 着地に要求する余裕（m）。縁ぎりぎりを狙うと側面にぶつかって跳ね返される。
 * `shouldJump`（すぐ手前の障害物に反応する既存の判定）が隣接した足場を扱うので、
 * こちらは「余裕を持って上に乗れる隙間」だけを担当する。
 */
const LEAP_MARGIN = 0.8;

/**
 * 登坂中に経路探索をやめて直進に切り替える距離。
 *
 * 目標が箱の上だと nav では通行不可セルなので `findPath` が経路を返さない。
 * 直進に切り替わる前に止まってしまうと、そこで詰まって目標を捨てることになる。
 * **踏み切りが届く距離（ダッシュ時で 4〜5 m）より広く取らないと、
 * 跳べる位置まで近づく前に動けなくなる。**
 * 広げすぎると踏み台が遠いうちから直進して途中の箱に突っかかるので、その手前で止める。
 */
const CLIMB_APPROACH = 4.5;

/** 諦めた目標を避け続ける秒数。長すぎると盤面の一部を見なくなる */
const AVOID_TIME = 12;
/** 諦めた目標のまわり、この距離までを避ける */
const AVOID_RADIUS = 5;

export class SeekerBrain {
  private path: Array<{ x: number; z: number }> = [];
  private goal: { x: number; z: number } | null = null;
  private mode: Mode = 'patrol';
  private repath: Ticker;
  private scanAngle = 0;
  private stuckTimer = 0;
  private clearTarget = -1;
  /** 今の目標に対してこれまでで一番近づけた距離。詰まり判定に使う */
  private bestDist = Infinity;
  /** その距離を更新できていない時間（秒） */
  private noProgress = 0;
  private prevGoalX = NaN;
  private prevGoalZ = NaN;
  /** 諦めた目標。しばらく選び直さないための一時的な除外リスト */
  private avoid: Array<{ x: number; z: number; t: number }> = [];

  constructor(seedOffset: number) {
    this.repath = new Ticker(0.4, seedOffset * 0.07);
  }

  /** デバッグ表示用の内部状態。 */
  describe(): string {
    const g = this.goal ? `(${this.goal.x.toFixed(0)},${this.goal.z.toFixed(0)})` : '-';
    return `${this.mode} goal=${g}${this.clearTarget >= 0 ? ` clear#${this.clearTarget}` : ''}`;
  }

  act(ctx: AiContext, agent: Agent): Action {
    const p = ctx.params.seeker;
    const act = emptyAction();
    const s = ctx.game.state;

    if (s.phase === 'prep') {
      // ケージの中。出た瞬間に動けるよう、外を見回して待つ。
      this.scanAngle += p.scanSpeed * 0.9 * (1 / 60);
      act.aimX = Math.sin(this.scanAngle);
      act.aimZ = Math.cos(this.scanAngle);
      return act;
    }

    this.markExplored(ctx, agent);

    // 目標へ近づけない状態が続いていたら、その目標は諦める。
    // 到達判定だけで選び直していると、壁や到達不能な目標に張り付いたまま
    // 試合が終わる（トレースで鬼 3 人が 36〜54 秒間まったく動かない試合を確認した）。
    const givenUp = this.mode !== 'chase' && this.goal !== null && this.noProgress > p.repickAfter;
    if (givenUp) {
      this.avoid.push({ x: this.goal!.x, z: this.goal!.z, t: ctx.game.state.time });
      if (this.avoid.length > 6) this.avoid.shift();
      this.goal = null;
      this.path = [];
    }

    const prey = this.pickVisiblePrey(ctx, agent);
    if (prey) {
      this.mode = 'chase';
      this.goal = this.interceptPoint(ctx, agent, prey, p.chaseLeadTime);
      this.path = [];
    } else {
      const lead = givenUp ? null : this.recallLead(ctx, agent);
      if (lead) {
        this.mode = 'investigate';
        this.goal = lead;
      } else if (this.mode !== 'patrol' || !this.goal || this.reached(agent, this.goal, 1.4)) {
        this.mode = 'patrol';
        // 息が切れたままだと、見つけても追いつけない。巡回のついでに補給する。
        const pack =
          agent.stamina < STAMINA_MAX * 0.55 ? nearestPickup(ctx, agent, 15) : null;
        this.goal = pack ?? this.pickPatrolGoal(ctx, agent);
        this.path = [];
        this.repath.force();
      }
    }

    this.trackProgress(agent);

    if (!this.goal) return act;
    // 味方に「自分はここへ何をしに行く」を掲示する。強制力は無く、参考にされるだけ。
    ctx.coop.seeker.post(
      agent.id,
      { mode: this.mode, x: this.goal.x, z: this.goal.z, targetId: prey?.id ?? -1 },
      ctx.time,
    );

    // 相手が高いところへ逃げたら、一段ずつ踏み台を経由して追い上げる。
    //
    // 判断の基準は「見えている相手の高さ」ではなく**「目標地点の高さ」**にする。
    // 相手が見えていることを条件にしていると、見失った瞬間に登る手段が全部止まり、
    // 高所が探索対象から消える（目撃地点が箱の上だと経路も取れないため）。
    const targetX = prey ? prey.x : this.goal.x;
    const targetZ = prey ? prey.z : this.goal.z;
    const targetY = prey ? prey.y : this.groundHeightAt(ctx, this.goal.x, this.goal.z);
    // **登るのは、そこに居られると触れない高さのときだけ。**
    // 高さの差だけで判定すると、逃げる側が小箱(1.3)に乗るたびに登ろうとして
    // 時間を浪費する。小箱の上は `CATCH_VERTICAL`(1.6) の内側なので地上から捕まえられる。
    // この条件を入れる前は 3v3 で逃げ側の勝率が 10 ポイント上がった（＝鬼が弱くなった）。
    const climbing = targetY > agent.y + 0.4 && targetY > CATCH_VERTICAL;
    if (climbing) {
      const step = this.climbTarget(ctx, agent, targetX, targetZ, targetY);
      if (step) this.goal = step;
    }

    // 追跡中は視線が通っているので直進でよい。それ以外は経路探索。
    let dir = this.mode === 'chase' ? directIfClear(ctx, agent, this.goal.x, this.goal.z) : null;

    // 足場に乗る直前だけは、経路探索を無視してまっすぐ突っ込む。
    // 足場そのものが障害物として扱われるので、経路に任せると避けて回り込んでしまう。
    // 逆に踏み台が遠いうちから直進させると、途中の箱に突っかかって止まる。
    const goalDist = Math.hypot(this.goal.x - agent.x, this.goal.z - agent.z);
    if (!dir && climbing && goalDist < CLIMB_APPROACH) {
      const d = goalDist || 1;
      dir = { mx: (this.goal.x - agent.x) / d, mz: (this.goal.z - agent.z) / d };
    }
    if (!dir) {
      if (this.repath.ready() || this.path.length === 0) {
        this.path = ctx.nav.findPath(agent.x, agent.z, this.goal.x, this.goal.z) ?? [];
      }
      const f = followPath(agent, this.path);
      dir = f.mx === 0 && f.mz === 0 ? directIfClear(ctx, agent, this.goal.x, this.goal.z) : f;
    }
    if (!dir) dir = { mx: 0, mz: 0 };

    act.moveX = dir.mx;
    act.moveZ = dir.mz;

    const dist = Math.hypot(this.goal.x - agent.x, this.goal.z - agent.z);
    act.dash = this.mode === 'chase' ? dist < p.chaseDashDist : dist > 6;
    // 相手が上に居るときは、隙間を挟んだ足場へも踏み切る。
    act.jump =
      shouldJump(ctx, agent, dir.mx, dir.mz, climbing && goalDist < 4.5) ||
      this.shouldLeap(ctx, agent, dir);

    // 追跡中は獲物を、それ以外は進行方向を少しずつ振りながら見る。
    // 目標は迎撃点でも、視線は相手そのものに置く。先を見ると視野角から
    // 相手が外れて、回り込んでいる最中に見失う。
    if (this.mode === 'chase') {
      const look = prey ?? this.goal;
      act.aimX = look.x - agent.x;
      act.aimZ = look.z - agent.z;
    } else {
      const base = Math.atan2(dir.mx, dir.mz);
      this.scanAngle += p.scanSpeed * (1 / 60);
      const sweep = Math.sin(this.scanAngle) * (VIEW_FOV * 0.35);
      act.aimX = Math.sin(base + sweep);
      act.aimZ = Math.cos(base + sweep);
    }

    // 足場に乗ろうとしている間だけは箱に触らない（足場ごと引き抜いてしまう）。
    // それ以外は、登る途中で詰まったときにどかせるようにしておく。
    if (!climbing || goalDist >= 4.5) this.handleObstruction(ctx, agent, act, dir);
    return act;
  }

  /**
   * 追いかける先。相手の**現在位置**ではなく、進路を先読みした迎撃点を返す。
   *
   * 鬼は逃げる側より遅い（8.8 対 9.4）ので、現在位置を追い続けると真後ろに
   * つくだけで永久に追いつけない。実際、1v1 のトレースでは 50 秒間
   * 9〜13 m の距離を保ったまま一度も詰められていなかった。
   * 相手が曲がったときに内側を取れるよう、到達までにかかる時間ぶんだけ
   * 進路の先を狙う。
   */
  private interceptPoint(
    ctx: AiContext,
    agent: Agent,
    prey: Agent,
    leadTime: number,
  ): { x: number; z: number } {
    const here = { x: prey.x, z: prey.z };
    if (leadTime <= 0) return here;

    // 到達時間と迎撃点は互いに依存するので数回だけ回して近づける。
    // 相手の方が速いと解が発散するため、leadTime で頭打ちにする。
    let t = Math.hypot(prey.x - agent.x, prey.z - agent.z) / SEEKER_SPEED;
    for (let i = 0; i < 3; i++) {
      t = Math.min(t, leadTime);
      const px = prey.x + prey.vx * t;
      const pz = prey.z + prey.vz * t;
      t = Math.hypot(px - agent.x, pz - agent.z) / SEEKER_SPEED;
    }
    t = Math.min(t, leadTime);

    const x = prey.x + prey.vx * t;
    const z = prey.z + prey.vz * t;

    // 予測点が壁や箱の中だと、そこへ向かう経路が取れずに動きが濁る。
    // その場合は素直に現在位置を追う。
    const nav = ctx.nav;
    const cx = nav.cx(x);
    const cz = nav.cx(z);
    if (!nav.inBounds(cx, cz) || nav.blocked[nav.idx(cx, cz)]) return here;
    return { x, z };
  }

  /**
   * 目標へ近づけているかを見張る。
   *
   * 経路が取れないと `followPath` も `directIfClear` も向きを返さず、移動入力が
   * ゼロのまま `patrol` を維持してしまう。`pickPatrolGoal` は「到達したら選び直す」
   * ようになっているので、**到達できない目標を掴むと二度と選び直さない。**
   * 実際、壁際で 54 秒間まったく動かない鬼をトレースで確認した。
   * 壁は `findBlocker` の対象外（箱だけを見ている）なので、そちらの復帰処理も働かない。
   */
  private trackProgress(agent: Agent): void {
    const goal = this.goal;
    if (!goal) {
      this.noProgress = 0;
      this.bestDist = Infinity;
      return;
    }
    if (goal.x !== this.prevGoalX || goal.z !== this.prevGoalZ) {
      this.prevGoalX = goal.x;
      this.prevGoalZ = goal.z;
      this.bestDist = Infinity;
      this.noProgress = 0;
    }
    const d = Math.hypot(goal.x - agent.x, goal.z - agent.z);
    // 少しでも近づけていれば詰まっていない。しきい値は経路のぶれを吸収する程度。
    if (d < this.bestDist - 0.4) {
      this.bestDist = d;
      this.noProgress = 0;
    } else {
      this.noProgress += DT;
    }
  }

  /**
   * その地点で足を置ける高さ。何も無ければ 0（地面）。
   *
   * 目撃地点が箱の上なら、その箱の上面が返る。
   * 「見えている相手の高さ」ではなくこれを登坂の基準にすることで、
   * **見失ったあとも高所を追える**ようにする。
   */
  private groundHeightAt(ctx: AiContext, x: number, z: number): number {
    let top = 0;
    for (const o of ctx.game.state.obstacles) {
      if (Math.abs(x - o.x) > o.hw || Math.abs(z - o.z) > o.hd) continue;
      const t = o.y + o.h;
      if (t > top) top = t;
    }
    return top;
  }

  /**
   * 隙間を越えて高い足場へ跳び移るための踏み切り。
   *
   * `shouldJump` は「進行方向のすぐ先が塞がっているか」でしか跳ばない。
   * **隙間を挟んで高い台に飛び移る場合、目の前にあるのは空きスペースなので
   * 条件を満たさず、永久に跳ばない。** 実際、低い台の上で接地していた 51 ティックの間
   * ジャンプ指示は 1 度も出ていなかった（`_probe-highground.ts`、隙間 4 m）。
   *
   * 逃げる側はこれを使って「低い台 → 少し離れた高い台」へ渡り、
   * 地上の鬼が `CATCH_VERTICAL`（1.6 m）に届かない高さへ逃げ込める。
   * 鬼も同じ経路を使えなければ、その場所は安全地帯になる。
   */
  private shouldLeap(
    ctx: AiContext,
    agent: Agent,
    dir: { mx: number; mz: number },
  ): boolean {
    if (!agent.grounded) return false;
    if (Math.hypot(dir.mx, dir.mz) < 0.5) return false;

    for (const o of ctx.game.state.obstacles) {
      // 壁も除外しない。内壁は高さ 2.6 m で、小箱(1.3)の上からは届く＝乗れる足場。
      // 逃げる側が壁の上を経由して渡れる以上、鬼が壁を無視すると同じ穴が残る。
      // 届かない壁（外周は 3 m）は下の高さ判定で自然に落ちる。
      const top = o.y + o.h;
      if (top > agent.y + CLIMB_REACH) continue; // 今の高さからは届かない
      if (top < agent.y - LEAP_DROP) continue; // 落差が大きい先は跳ばずに落ちればよい

      // 対象は「今より高い足場」か、「自分が既に高所に居るときの同じ高さの足場」。
      // 平地で低い箱に反応して跳ね回らないようにする。
      const higher = top > agent.y + 0.2;
      const elevated = agent.y > 0.5;
      if (!higher && !elevated) continue;

      const dx = o.x - agent.x;
      const dz = o.z - agent.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.001) continue;
      // 進行方向にあるものだけ。横や後ろの足場に反応して跳ねない。
      if ((dx / d) * dir.mx + (dz / d) * dir.mz < 0.7) continue;

      // 跳んでいる間に「その面の高さ以上に居る」区間を求め、
      // その間に進める水平距離が足場の上に重なるかを見る。
      // y(t) = JUMP_SPEED·t − (GRAVITY/2)·t²。段差 STEP_HEIGHT ぶんは自動で乗れる。
      const rise = Math.max(0, top - agent.y - STEP_HEIGHT);
      const disc = JUMP_SPEED * JUMP_SPEED - 2 * GRAVITY * rise;
      if (disc < 0) continue; // その高さには跳んでも届かない
      const root = Math.sqrt(disc);
      // **今の速度**で計算する。追跡中はダッシュしていて 1.5 倍速いので、
      // 基準速度で見積もると飛距離を 5 割見誤って足場を飛び越す。
      const speed = Math.max(2, Math.hypot(agent.vx, agent.vz));
      const reachMin = Math.max(0, ((JUMP_SPEED - root) / GRAVITY) * speed);
      const reachMax = ((JUMP_SPEED + root) / GRAVITY) * speed;

      const edge = d - Math.max(o.hw, o.hd);
      const far = edge + 2 * Math.max(o.hw, o.hd); // 足場の向こう端
      // 縁ぎりぎりで踏み切ると側面にぶつかって跳ね返される。余裕を持って乗れるときだけ。
      // これが無いと、地上から低い台へ 4 m 手前で跳び続けて側面に当たり、
      // いつまでも台に乗れなくなる（実測で最高到達 1.22 m、台の上面 1.3 m に届かない）。
      if (reachMax < edge + LEAP_MARGIN) continue; // 手前に落ちる
      if (reachMin > far - 0.3) continue; // 飛び越してしまう
      return true;
    }
    return false;
  }

  /**
   * 見えている逃走者のうち、担当が空いていて最も近い者。
   *
   * 単に一番近い相手を返すと、**同じ相手が全員に見えているとき全員がそこへ向かう。**
   * 逃げ側は 1 人でも残れば勝ちなので、放置された 1 人が勝敗を決める。
   * 実測では、逃走者が 2 人以上生きているティックのうち 19.0% で 2 人以上の鬼が
   * 同じ相手を見ており、11.5% では同時に誰にも見られていない逃走者が居た（3v3 / 30 試合）。
   *
   * そこで `chaseMaxSeekers` 人が既に向かっている相手は避けて別の相手を選ぶ。
   * ただし**見えている相手が全員埋まっていたら、素直に一番近い相手を追う。**
   * 見えているのに誰も追わないのは、担当を分ける目的に対しても損。
   */
  private pickVisiblePrey(ctx: AiContext, agent: Agent): Agent | null {
    const p = ctx.params.seeker;
    let best: Agent | null = null;
    let bestD = Infinity;
    let taken: Agent | null = null;
    let takenD = Infinity;
    for (const a of ctx.game.state.agents) {
      if (a.team !== 'hider' || a.caught) continue;
      if (!canSee(ctx.game.state, agent, a)) continue;
      const d = Math.hypot(a.x - agent.x, a.z - agent.z);
      if (ctx.coop.seeker.othersTargeting(agent.id, a.id, ctx.time) >= p.chaseMaxSeekers) {
        if (d < takenD) {
          takenD = d;
          taken = a;
        }
        continue;
      }
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best ?? taken;
  }

  /**
   * 高所の相手を追うための次の一歩。
   * 一度のジャンプで届く面にしか乗れないので、届かない相手には
   * 「今から乗れて、相手に近い」踏み台を選んで経由する。
   */
  private climbTarget(
    ctx: AiContext,
    agent: Agent,
    preyX: number,
    preyZ: number,
    preyY: number,
  ): { x: number; z: number } | null {
    // 直接跳び移れるなら回り道は要らない。
    if (preyY <= agent.y + CLIMB_REACH) return null;
    const prey = { x: preyX, z: preyZ };

    let best: Obstacle | null = null;
    let bestScore = Infinity;
    for (const o of ctx.game.state.obstacles) {
      // 壁も踏み台の候補にする。内壁は 2.6 m で、逃げる側が経由路に使える高さ。
      // 届かないものは下の高さ判定で落ちる。
      const toPrey = Math.hypot(o.x - prey.x, o.z - prey.z);
      const toSelf = Math.hypot(o.x - agent.x, o.z - agent.z);

      if (o.kind === 'pad') {
        // ジャンプ台は一気に高く上がれるが、跳んでいる間に届く範囲に
        // 相手が居なければ意味がない。
        if (toPrey > 9) continue;
      } else {
        const top = o.y + o.h;
        if (top > agent.y + CLIMB_REACH) continue; // 今の高さからは乗れない
        if (top <= agent.y + 0.2) continue; // 登ったことにならない
      }

      // 相手に近い足場を優先しつつ、遠回りしすぎないようにする。
      // ジャンプ台は一段で済むので強く優先する。
      const score = toPrey + toSelf * 0.6 - (o.kind === 'pad' ? 9 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  /**
   * チームの記憶から、まだ新しい目撃情報を拾う。
   *
   * 記憶はチームで共有しているので、そのまま拾うと**全員が同じ 1 点へ向かう**。
   * 実際 3v3 のトレースでは 3 人が試合中ずっと互いに 3 m 以内に固まり、
   * 全員が同じ `investigate goal` を持っていた。3 人いても網は 1 人ぶんにしかならない。
   * そこで 1 つの手がかりに向かうのは近い順に `leadMaxSeekers` 人までとし、
   * あぶれた鬼は巡回に回して別の場所を見る（巡回側には元から分散処理がある）。
   */
  private recallLead(ctx: AiContext, agent: Agent): { x: number; z: number } | null {
    const mem = ctx.game.state.memory.seeker;
    const p = ctx.params.seeker;
    const mates = ctx.game.state.agents.filter(
      (a) => a.team === 'seeker' && !a.caught && a.id !== agent.id,
    );
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    for (const [id, rec] of mem) {
      const target = ctx.game.state.agents[id];
      if (target.caught) continue;
      const age = ctx.game.state.time - rec.t;
      if (age > p.memoryTrust) continue;
      const d = Math.hypot(rec.x - agent.x, rec.z - agent.z);
      if (d < 1.2) continue; // そこには居なかった

      // 自分より近い味方が定員ぶん居るなら、その手がかりは任せる。
      let closer = 0;
      for (const m of mates) {
        if (Math.hypot(m.x - rec.x, m.z - rec.z) < d) closer++;
      }
      if (closer >= p.leadMaxSeekers) continue;

      const score = d + age * 2;
      if (score < bestScore) {
        bestScore = score;
        best = { x: rec.x, z: rec.z };
      }
    }
    return best;
  }

  /** 長く確認していない場所を探す。ロックされた箱の近くは怪しいので加点。 */
  private pickPatrolGoal(ctx: AiContext, agent: Agent): { x: number; z: number } | null {
    const nav = ctx.nav;
    const p = ctx.params.seeker;
    const now = ctx.game.state.time;
    const lockedBoxes = ctx.game.state.obstacles.filter(
      (o) => o.kind === 'box' && o.lockedBy === 'hider',
    );
    const others = ctx.coop.seeker.others(agent.id, ctx.time);

    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;

    for (let cz = 1; cz < nav.size - 1; cz += 2) {
      for (let cx = 1; cx < nav.size - 1; cx += 2) {
        const i = nav.idx(cx, cz);
        if (nav.blocked[i]) continue;
        const x = nav.worldX(cx);
        const z = nav.worldX(cz);
        const age = ctx.game.state.time - ctx.coop.seeker.grid[i];
        const dist = Math.hypot(x - agent.x, z - agent.z);
        if (dist < 3) continue;
        // 直前に諦めた目標のあたりは、しばらく選ばない。
        // 選び直しても同じ場所が最高点のままだと、諦めた意味がなくなる。
        let abandoned = false;
        for (const a of this.avoid) {
          if (now - a.t > AVOID_TIME) continue;
          if (Math.hypot(x - a.x, z - a.z) < AVOID_RADIUS) {
            abandoned = true;
            break;
          }
        }
        if (abandoned) continue;

        let score = age - dist * p.patrolDistWeight;
        for (const b of lockedBoxes) {
          const bd = Math.hypot(x - b.x, z - b.z);
          if (bd < 5) score += p.lockedBoxLure * (1 - bd / 5);
        }
        // 味方の担当エリアからは離れる。
        for (const g of others) {
          const gd = Math.hypot(x - g.x, z - g.z);
          if (gd < 8) score -= (8 - gd) * 1.6;
        }
        if (score > bestScore) {
          bestScore = score;
          best = { x, z };
        }
      }
    }
    return best;
  }

  /** 視界に入ったセルを既確認としてマークする（レイマーチの近似）。 */
  private markExplored(ctx: AiContext, agent: Agent): void {
    const nav = ctx.nav;
    const rays = 9;
    for (let r = 0; r < rays; r++) {
      const a = agent.facing + (r / (rays - 1) - 0.5) * VIEW_FOV;
      const sx = Math.sin(a);
      const sz = Math.cos(a);
      const range = viewDistFor(ctx.game.state.config.seekers);
      for (let t = 0.5; t < range; t += 0.75) {
        const x = agent.x + sx * t;
        const z = agent.z + sz * t;
        const cx = nav.cx(x);
        const cz = nav.cx(z);
        if (!nav.inBounds(cx, cz)) break;
        const i = nav.idx(cx, cz);
        if (nav.blocked[i]) break;
        ctx.coop.seeker.markGrid(i, ctx.game.state.time);
      }
    }
  }

  /**
   * 詰まったときの処理。箱に阻まれているなら、ロックを剥がすか掴んでどける。
   * 隠れ家に籠もった相手を掘り出すための動き。
   */
  private handleObstruction(
    ctx: AiContext,
    agent: Agent,
    act: Action,
    dir: { mx: number; mz: number },
  ): void {
    const moving = Math.hypot(dir.mx, dir.mz) > 0.1;
    const speed = Math.hypot(agent.vx, agent.vz);
    this.stuckTimer = moving && speed < 1.2 ? this.stuckTimer + 1 / 60 : 0;

    const blocker = this.findBlocker(ctx, agent, dir);
    if (blocker && (this.stuckTimer > 0.35 || this.clearTarget === blocker.id)) {
      this.clearTarget = blocker.id;
      act.aimX = blocker.x - agent.x;
      act.aimZ = blocker.z - agent.z;
      if (blocker.lockedBy === 'hider') {
        act.lock = true; // 接触してロック解除
      } else {
        // 掴んで自分の背後へ引き抜く。
        act.grab = true;
        const away = Math.hypot(agent.x - blocker.x, agent.z - blocker.z) || 1;
        act.moveX = (agent.x - blocker.x) / away;
        act.moveZ = (agent.z - blocker.z) / away;
        act.dash = false;
      }
      if (this.stuckTimer > 3) {
        this.clearTarget = -1;
        this.stuckTimer = 0;
        this.goal = null;
      }
    } else if (this.clearTarget >= 0 && !blocker) {
      this.clearTarget = -1;
    }
  }

  /** 進行方向の手前にある、どかせる / 解錠できる箱。 */
  private findBlocker(
    ctx: AiContext,
    agent: Agent,
    dir: { mx: number; mz: number },
  ): Obstacle | null {
    const p = ctx.params.seeker;
    let best: Obstacle | null = null;
    let bestD = Infinity;
    for (const o of ctx.game.state.obstacles) {
      if (o.kind !== 'box') continue;
      const dx = o.x - agent.x;
      const dz = o.z - agent.z;
      const d = Math.max(0, Math.hypot(dx, dz) - Math.max(o.hw, o.hd));
      if (d > Math.max(p.clearDist, GRAB_RANGE)) continue;
      const len = Math.hypot(dx, dz) || 1;
      if ((dx / len) * dir.mx + (dz / len) * dir.mz < 0.35) continue;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  private reached(agent: Agent, goal: { x: number; z: number }, tol: number): boolean {
    return Math.hypot(goal.x - agent.x, goal.z - agent.z) < tol;
  }
}

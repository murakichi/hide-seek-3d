// 逃げる側の思考。準備時間で拠点を囲んでロックし、鬼が出てきたら
// 「相手から見えず、かつ遠い」場所へ逃げ続ける。

import {
  AGENT_RADIUS,
  ARENA_HALF,
  CLIMB_REACH,
  DT,
  EYE_HEIGHT,
  GRAB_MAX_SIZE,
  GRAB_RANGE,
  HIDER_SPEED,
  STAMINA_MAX,
} from '../core/config';
import { angleDiff, hasLineOfSight } from '../core/physics';
import type { Action, Agent, Obstacle } from '../core/types';
import { canSee } from '../core/vision';
import {
  clampToArena,
  directIfClear,
  emptyAction,
  followPath,
  isCovered,
  nearestPickup,
  shouldJump,
  Ticker,
  type AiContext,
} from './context';

type Job =
  | { kind: 'idle' }
  | { kind: 'fetch'; box: number; slot: number }
  | { kind: 'haul'; box: number; slot: number }
  | { kind: 'lock'; box: number; until: number };

const SLOT_COUNT = 8;
/** これより遠い箱は準備時間内に運びきれないので候補にしない */
const MAX_HAUL_DIST = 13;

/**
 * その地点を塞いでいるのが「跳んで乗り越えられる箱」だけか。
 * 経路探索のグリッドは登れる箱も塞がれた扱いにするので、
 * 逃走方向を選ぶときだけはここで見分ける。壁と大きい箱は乗り越えられない。
 */
function climbableAt(obstacles: readonly Obstacle[], x: number, z: number): boolean {
  let found = false;
  for (const o of obstacles) {
    if (o.kind === 'ramp' || o.kind === 'pad') continue;
    if (Math.abs(x - o.x) > o.hw + AGENT_RADIUS * 0.9) continue;
    if (Math.abs(z - o.z) > o.hd + AGENT_RADIUS * 0.9) continue;
    // 1 つでも乗り越えられないものが重なっていたら通れない。
    // 箱は積めるので、見るのは高さ `h` ではなく上面 `y + h`。
    // 積んだ 2 段（上面 2.6）は地面からは登れない。
    if (o.kind === 'wall' || o.y + o.h > CLIMB_REACH) return false;
    found = true;
  }
  return found;
}

export class HiderBrain {
  private path: Array<{ x: number; z: number }> = [];
  private job: Job = { kind: 'idle' };
  private repath: Ticker;
  private rethink: Ticker;
  private stuckTimer = 0;
  private wanderAngle = 0;
  /** 直前のティックで選んだ逃走方向（逃走モードでないときは null） */
  private fleeAngle: number | null = null;
  /** 運搬に失敗した箱と、再挑戦できるようになる時刻 */
  private avoid = new Map<number, number>();
  /** 運び込めなかった置き場所と、再挑戦できるようになる時刻 */
  private avoidSlots = new Map<number, number>();
  /** 運搬中の箱が前ティックにいた位置。箱自体が進んでいるかを見る */
  private lastBoxX = 0;
  private lastBoxZ = 0;
  /** 箱が進まないまま経過した秒数 */
  private boxStall = 0;

  constructor(seedOffset: number) {
    this.repath = new Ticker(0.35, seedOffset * 0.05);
    this.rethink = new Ticker(0.5, seedOffset * 0.11);
  }

  act(ctx: AiContext, agent: Agent): Action {
    return ctx.game.state.phase === 'prep' ? this.prepare(ctx, agent) : this.evade(ctx, agent);
  }

  /** このエージェントに割り当てられた拠点。 */
  private home(ctx: AiContext, agent: Agent): { x: number; z: number } | null {
    return ctx.shelters.get(agent.id) ?? null;
  }

  /** デバッグ表示用の内部状態。 */
  describe(): string {
    const j = this.job;
    const detail = j.kind === 'fetch' || j.kind === 'haul' ? `${j.box}->${j.slot}` : '';
    return `${j.kind}${detail ? `(${detail})` : ''} path=${this.path.length}`;
  }

  // ---- 準備フェーズ -----------------------------------------------------

  private prepare(ctx: AiContext, agent: Agent): Action {
    const act = emptyAction();
    const p = ctx.params.hider;
    const shelter = this.home(ctx, agent);
    if (!shelter) return act;

    // 残り時間がわずかなら、荷物を捨てて拠点の内側に入る。
    if (ctx.game.state.phaseTime < p.retreatMargin) {
      this.releaseJob();
      return this.moveTo(ctx, agent, act, shelter.x, shelter.z, false);
    }

    // 仕事の状態が切り替わったら同じティック内でやり直す。
    // 遷移のたびに入力を空で返すと、1 ティックおきに停止して前に進めなくなる。
    for (let pass = 0; pass < 4; pass++) {
      if (this.runJob(ctx, agent, act, shelter, pass)) break;
    }
    return act;
  }

  /** 現在の仕事を 1 段階進める。act を埋め終えたら true、状態が変わっただけなら false。 */
  private runJob(
    ctx: AiContext,
    agent: Agent,
    act: Action,
    shelter: { x: number; z: number },
    pass: number,
  ): boolean {
    const s = ctx.game.state;

    switch (this.job.kind) {
      case 'idle': {
        // 思考の間引きはするが、遷移直後（pass > 0）は即座に次の仕事を探す。
        if (this.rethink.ready() || pass > 0) {
          const next = this.planJob(ctx, agent, shelter);
          if (next) {
            this.job = next;
            return false;
          }
        }
        this.moveTo(ctx, agent, act, shelter.x, shelter.z, false);
        return true;
      }

      case 'fetch': {
        const box = s.obstacles[this.job.box];
        if (box.lockedBy !== null || (box.heldBy >= 0 && box.heldBy !== agent.id)) {
          this.releaseJob();
          return false;
        }
        if (agent.grabbed === box.id) {
          this.job = { kind: 'haul', box: box.id, slot: this.job.slot };
          // 運搬の進捗判定を、掴んだ時点の箱の位置から始める。
          this.lastBoxX = box.x;
          this.lastBoxZ = box.z;
          this.boxStall = 0;
          return false;
        }
        // 掴んだ相対位置は保たれるので、押す側でも引く側でも運べる。
        // 回り込む位置を決め打ちすると到達不能な点を選びがちなので、素直に箱へ寄る。
        const approach = this.approachPoint(ctx, box, agent);
        this.moveTo(ctx, agent, act, approach.x, approach.z, false);
        act.aimX = box.x - agent.x;
        act.aimZ = box.z - agent.z;
        const reach =
          Math.hypot(box.x - agent.x, box.z - agent.z) - Math.max(box.hw, box.hd) - AGENT_RADIUS;
        act.grab = reach < GRAB_RANGE;

        // いつまでも掴めないなら、その箱をしばらく諦める。
        if (this.stuckTimer > 2.5) this.abandon(ctx, box.id);
        return true;
      }

      case 'haul': {
        const box = s.obstacles[this.job.box];
        if (agent.grabbed !== box.id) {
          this.releaseJob();
          return false;
        }
        const slot = this.slotPos(ctx, shelter, this.job.slot);
        if (Math.hypot(box.x - slot.x, box.z - slot.z) < 0.8) {
          this.job = { kind: 'lock', box: box.id, until: s.time + 4 };
          return false;
        }
        act.grab = true;
        // 箱がスロットに載るようなエージェント位置を目標にする。
        this.moveTo(ctx, agent, act, slot.x - agent.grabOffX, slot.z - agent.grabOffZ, false);
        act.aimX = box.x - agent.x;
        act.aimZ = box.z - agent.z;

        // 詰まりは「箱が進んでいるか」で判定する。運び手の速度で見ると、
        // 箱が壁に噛んだまま本人だけが壁沿いに滑っている状態を見逃して、
        // 同じ動きを延々と繰り返してしまう。
        const moved = Math.hypot(box.x - this.lastBoxX, box.z - this.lastBoxZ);
        this.lastBoxX = box.x;
        this.lastBoxZ = box.z;
        this.boxStall = moved < 0.02 ? this.boxStall + DT : 0;
        // つかえたら跳ぶ。掴んだ箱は持ち手の足元に付いてくるので、
        // 相手が乗せられる高さなら持ち上がって上に載り、そうでなければ何も起きず
        // 下の «諦める» に落ちる。積むかどうかを事前に判断しないのは、
        // 積み方の作り込みが逃げる側のサイクルの仕事だから（ここでは機能を使えるようにするだけ）。
        if (this.boxStall > 0.35 && agent.grounded) act.jump = true;
        if (this.boxStall > ctx.params.hider.haulStallTime) {
          // その置き場所自体が無理筋のこともあるので、箱と一緒にしばらく避ける。
          this.avoidSlots.set(this.job.slot, s.time + 8);
          this.abandon(ctx, box.id);
        }
        return true;
      }

      case 'lock': {
        const box = s.obstacles[this.job.box];
        if (box.lockedBy !== null || s.time > this.job.until) {
          this.releaseJob();
          return false;
        }
        // 運んできた直後とは限らないので、届いていなければまず寄る。
        const reach =
          Math.hypot(box.x - agent.x, box.z - agent.z) - Math.max(box.hw, box.hd) - AGENT_RADIUS;
        if (reach > GRAB_RANGE * 0.75) {
          const approach = this.approachPoint(ctx, box, agent);
          this.moveTo(ctx, agent, act, approach.x, approach.z, false);
        }
        act.aimX = box.x - agent.x;
        act.aimZ = box.z - agent.z;
        act.lock = true;
        return true;
      }
    }
  }

  /**
   * 次に運ぶ箱と置き場所を決める。
   * 運搬距離が支配的なので、箱とスロットの組み合わせをまとめて評価する。
   */
  private planJob(ctx: AiContext, agent: Agent, shelter: { x: number; z: number }): Job | null {
    const s = ctx.game.state;

    // 拠点の外周にもともと在る箱は、運ぶ必要が無いのでその場で固める。
    // 運搬が準備時間の大半を食うので、これが一番安く壁を増やせる。
    const ring = ctx.params.hider.shelterRadius + 1.6;
    for (const o of s.obstacles) {
      if (o.kind !== 'box' || o.lockedBy !== null || o.heldBy >= 0) continue;
      if ((this.avoid.get(o.id) ?? 0) > s.time) continue;
      if (Math.hypot(o.x - shelter.x, o.z - shelter.z) > ring) continue;
      return { kind: 'lock', box: o.id, until: s.time + 8 };
    }

    const openSlots: Array<{ i: number; x: number; z: number; inward: number }> = [];
    const shelterLen = Math.hypot(shelter.x, shelter.z) || 1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if ((this.avoidSlots.get(i) ?? 0) > s.time) continue;
      const pos = this.slotPos(ctx, shelter, i);
      if (this.slotFilled(ctx, pos)) continue;
      // アリーナ中央を向いている面ほど、鬼の侵入経路になりやすいので優先して塞ぐ。
      const inward =
        (-shelter.x * (pos.x - shelter.x) + -shelter.z * (pos.z - shelter.z)) / shelterLen;
      openSlots.push({ i, x: pos.x, z: pos.z, inward });
    }
    if (openSlots.length === 0) return null;

    let bestJob: Job | null = null;
    let bestCost = Infinity;
    for (const o of s.obstacles) {
      if (o.kind !== 'box' || o.lockedBy !== null || o.heldBy >= 0) continue;
      if (o.hw + o.hd > GRAB_MAX_SIZE) continue;
      if ((this.avoid.get(o.id) ?? 0) > s.time) continue;
      const toAgent = Math.hypot(o.x - agent.x, o.z - agent.z);
      for (const slot of openSlots) {
        const haul = Math.hypot(o.x - slot.x, o.z - slot.z);
        if (haul < 0.8) continue; // 既にそこにある
        if (haul > MAX_HAUL_DIST) continue;
        // 運搬距離を最重視。近づく距離と入口優先度で微調整する。
        const cost = haul * 1.6 + toAgent * 0.7 - slot.inward * 1.2;
        if (cost < bestCost) {
          bestCost = cost;
          bestJob = { kind: 'fetch', box: o.id, slot: slot.i };
        }
      }
    }

    return bestJob;
  }

  private releaseJob(): void {
    this.job = { kind: 'idle' };
    this.rethink.force();
  }

  /** 運べなかった箱をしばらく候補から外す。同じ失敗を繰り返さないため。 */
  private abandon(ctx: AiContext, boxId: number): void {
    this.avoid.set(boxId, ctx.game.state.time + 6);
    this.stuckTimer = 0;
    this.boxStall = 0;
    this.releaseJob();
  }

  /** 拠点を囲む配置スロット。既に壁がある方向は自然に「埋まっている」と判定される。 */
  private slotPos(
    ctx: AiContext,
    shelter: { x: number; z: number },
    i: number,
  ): { x: number; z: number } {
    const a = (i / SLOT_COUNT) * Math.PI * 2;
    const r = ctx.params.hider.shelterRadius;
    return {
      x: clampToArena(shelter.x + Math.sin(a) * r),
      z: clampToArena(shelter.z + Math.cos(a) * r),
    };
  }

  private slotFilled(ctx: AiContext, pos: { x: number; z: number }): boolean {
    for (const o of ctx.game.state.obstacles) {
      if (o.kind === 'ramp') continue;
      if (Math.abs(pos.x - o.x) < o.hw + 0.35 && Math.abs(pos.z - o.z) < o.hd + 0.35) return true;
    }
    return false;
  }

  /**
   * 箱に取り付く位置。箱の四辺のうち、自分から見て一番近くて空いている面を選ぶ。
   * どの面から掴んでも運べるので、到達できることだけを条件にする。
   */
  private approachPoint(ctx: AiContext, box: Obstacle, agent: Agent): { x: number; z: number } {
    const back = Math.max(box.hw, box.hd) + AGENT_RADIUS + 0.25;
    const sides = [
      { x: box.x + back, z: box.z },
      { x: box.x - back, z: box.z },
      { x: box.x, z: box.z + back },
      { x: box.x, z: box.z - back },
    ];
    let best = sides[0];
    let bestD = Infinity;
    for (const s of sides) {
      const x = clampToArena(s.x);
      const z = clampToArena(s.z);
      if (ctx.nav.isBlockedWorld(x, z)) continue;
      const d = Math.hypot(x - agent.x, z - agent.z);
      if (d < bestD) {
        bestD = d;
        best = { x, z };
      }
    }
    return best;
  }

  // ---- 逃走フェーズ -----------------------------------------------------

  private evade(ctx: AiContext, agent: Agent): Action {
    const act = emptyAction();
    const s = ctx.game.state;
    const p = ctx.params.hider;
    const threats = this.knownThreats(ctx, agent);
    const nearest = threats.length
      ? Math.min(...threats.map((t) => Math.hypot(t.x - agent.x, t.z - agent.z)))
      : Infinity;

    if (nearest < p.fleeTriggerDist) {
      // 逃走中は目標地点を決め打ちしない。地点を目指すと壁際で詰まったり、
      // 目標更新の間に距離を詰められる。毎ティック方向を選び直す方が粘れる。
      const dir = this.fleeDirection(ctx, agent, threats);
      act.moveX = dir.mx;
      act.moveZ = dir.mz;
      this.path = [];

      // 囲まれて速度が出ないときは、乗り越えて抜けることを試みる。
      const speed = Math.hypot(agent.vx, agent.vz);
      this.stuckTimer = speed < HIDER_SPEED * 0.3 ? this.stuckTimer + DT : 0;
      // 乗り越える向きを選んだなら、詰まるのを待たずに跳ぶ。減速してからでは箱に乗れない。
      act.jump = shouldJump(ctx, agent, dir.mx, dir.mz, dir.climb) || this.stuckTimer > 0.4;

      // 迫られている間は相手を見て、回り込みに反応できるようにする。
      const closest = threats.reduce((best, t) =>
        Math.hypot(t.x - agent.x, t.z - agent.z) < Math.hypot(best.x - agent.x, best.z - agent.z)
          ? t
          : best,
      );
      act.aimX = closest.x - agent.x;
      act.aimZ = closest.z - agent.z;
      act.dash = nearest < p.fleeDashDist;

      // 追いつかれる直前で、しかも実際に見られているときだけ煙を使う。
      // 見られていないのに撒くと、そこに居ることを教えるだけになる。
      if (agent.smokeCharges > 0 && nearest < 8) {
        const watched = s.agents.some(
          (sk) => sk.team === 'seeker' && !sk.caught && canSee(s, sk, agent),
        );
        if (watched) act.smoke = true;
      }
      return act;
    }

    // ここから先は「今は追われていない」状態。ただし逃走の判定材料である
    // knownThreats は数秒で切れるので、切れた直後に鬼がいなくなったものとして
    // 動くと、まだ近くにいる鬼へ自分から歩いて行くことになる。
    // 目的地へ動く前に、その道のりが直近の鬼へ近づかないかを必ず確かめる。
    const recent = this.recentThreats(ctx, agent);

    // 逃走が切れたら方向の引き継ぎも切る。次に追われたときは白紙から選び直す。
    // ただし後段の「退く」も fleeDirection で向きを決めるので、そちらへ抜けるときだけは
    // 引き継ぎを戻す。毎ティック白紙にすると退避中だけ方向が振れて速度が乗らない。
    const carriedFleeAngle = this.fleeAngle;
    this.fleeAngle = null;

    // 追われていない間に補給しておく。追われてから走ると間に合わない。
    if (agent.stamina < STAMINA_MAX * 0.75) {
      const pack = nearestPickup(ctx, agent, 13);
      if (pack && !this.routeIsRisky(ctx, agent, pack.x, pack.z, recent)) {
        return this.moveTo(ctx, agent, act, pack.x, pack.z, false);
      }
    }

    // 脅威が無い間は拠点付近で待機。たまに周囲を見る。
    const home = this.home(ctx, agent) ?? { x: agent.x, z: agent.z };
    const d = Math.hypot(home.x - agent.x, home.z - agent.z);
    // 待機中こそ周囲の確認が命綱なので、速めに首を振る。
    this.wanderAngle += 2.4 / 60;

    // 帰り道がさっきまで鬼が居た側を通るなら、帰らずに退く。
    // 拠点は逃走のたびに置き去りにされるので、鬼と拠点の間に自分が居る形に
    // なりやすい。そこで最短経路を取ると鬼の正面に出てしまう。
    if (d > 2.2 && this.routeIsRisky(ctx, agent, home.x, home.z, recent)) {
      this.fleeAngle = carriedFleeAngle;
      const dir = this.fleeDirection(ctx, agent, recent);
      this.path = [];
      act.moveX = dir.mx;
      act.moveZ = dir.mz;
      act.jump = shouldJump(ctx, agent, dir.mx, dir.mz, dir.climb);
      // 退いている間も鬼が居た方を見ておく。回り込まれたら逃走に切り替わる。
      const closest = recent.reduce((best, t) =>
        Math.hypot(t.x - agent.x, t.z - agent.z) < Math.hypot(best.x - agent.x, best.z - agent.z)
          ? t
          : best,
      );
      act.aimX = closest.x - agent.x;
      act.aimZ = closest.z - agent.z;
      return act;
    }

    if (d > 2.2) {
      this.moveTo(ctx, agent, act, home.x, home.z, false);
    } else if (p.roamBias > 0.01) {
      act.moveX = Math.sin(this.wanderAngle) * p.roamBias;
      act.moveZ = Math.cos(this.wanderAngle) * p.roamBias;
    }
    act.aimX = Math.sin(this.wanderAngle);
    act.aimZ = Math.cos(this.wanderAngle);
    return act;
  }

  /**
   * 直近に鬼が居たと分かっている場所。逃走判定の knownThreats より長く覚えておく。
   * こちらは「動いてよいか」の判断にだけ使うので、古い情報でも害が小さい。
   */
  private recentThreats(ctx: AiContext, agent: Agent): Array<{ x: number; z: number }> {
    const s = ctx.game.state;
    const keep = ctx.params.hider.threatMemory;
    const out: Array<{ x: number; z: number }> = [];
    for (const a of s.agents) {
      if (a.team !== 'seeker' || a.caught) continue;
      if (canSee(s, agent, a)) {
        out.push({ x: a.x, z: a.z });
        continue;
      }
      const rec = s.memory.hider.get(a.id);
      if (rec && s.time - rec.t < keep) out.push({ x: rec.x, z: rec.z });
    }
    return out;
  }

  /**
   * 目的地までの道のりが、直近の脅威へ近づく形でしきい値を割るか。
   * 「今より近づく」ことを条件に入れているのは、既に脅威の近くで待機している
   * 場合まで動けなくしないため。止めてしまうと硬直して狩られる。
   */
  private routeIsRisky(
    ctx: AiContext,
    agent: Agent,
    tx: number,
    tz: number,
    threats: Array<{ x: number; z: number }>,
  ): boolean {
    if (threats.length === 0) return false;
    const keepAway = ctx.params.hider.threatKeepAway;
    const dist = Math.hypot(tx - agent.x, tz - agent.z);
    if (dist < 1e-3) return false;
    const steps = Math.max(2, Math.min(10, Math.ceil(dist / 2.5)));
    for (const t of threats) {
      const now = Math.hypot(t.x - agent.x, t.z - agent.z);
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        const px = agent.x + (tx - agent.x) * f;
        const pz = agent.z + (tz - agent.z) * f;
        const d = Math.hypot(t.x - px, t.z - pz);
        if (d < keepAway && d < now - 0.5) return true;
      }
    }
    return false;
  }

  /** 見えている鬼＋チームの記憶にある鬼の位置。 */
  private knownThreats(ctx: AiContext, agent: Agent): Array<{ x: number; z: number }> {
    const s = ctx.game.state;
    const out: Array<{ x: number; z: number }> = [];
    for (const a of s.agents) {
      if (a.team !== 'seeker') continue;
      if (canSee(s, agent, a)) {
        out.push({ x: a.x, z: a.z });
        continue;
      }
      const rec = s.memory.hider.get(a.id);
      if (rec && s.time - rec.t < 4) out.push({ x: rec.x, z: rec.z });
    }
    return out;
  }

  /**
   * 逃げる方向を選ぶ。周囲を扇形にスキャンし、
   * 「進める距離」「鬼から離れられるか」「壁に詰まらないか」「遮蔽が取れるか」で採点する。
   */
  private fleeDirection(
    ctx: AiContext,
    agent: Agent,
    threats: Array<{ x: number; z: number }>,
  ): { mx: number; mz: number; climb: boolean } {
    const p = ctx.params.hider;
    const s = ctx.game.state;
    const seekers = s.agents.filter((a) => a.team === 'seeker' && !a.caught);
    const heading = Math.hypot(agent.vx, agent.vz) > 1 ? Math.atan2(agent.vx, agent.vz) : null;

    let bestDir = { mx: 0, mz: 0, climb: false };
    let bestAngle = 0;
    let bestScore = -Infinity;
    // 全方向が塞がっていたときのために、一番遠くまで進める方向を控えておく。
    let fallbackDir = { mx: 0, mz: 0, climb: false };
    let fallbackAngle = 0;
    let fallbackClear = -1;
    const samples = Math.max(8, Math.round(p.fleeSamples));

    for (let i = 0; i < samples; i++) {
      const ang = (i / samples) * Math.PI * 2;
      const dx = Math.sin(ang);
      const dz = Math.cos(ang);

      // その方向にどこまで走れるか。
      // 見る距離は移動速度に見合わせる。短いと曲がり始めが遅れて壁に突っ込む。
      let clear = 0;
      let climb = false;
      for (const t of [2, 4, 6, 8.5, 11.5]) {
        const px = agent.x + dx * t;
        const pz = agent.z + dz * t;
        if (Math.abs(px) > ARENA_HALF - 0.8 || Math.abs(pz) > ARENA_HALF - 0.8) break;
        if (ctx.nav.isBlockedWorld(px, pz)) {
          // 塞いでいるのが乗り越えられる高さの箱なら、そこは通れる。
          // nav は登れる箱も一律で塞がれた扱いにするので、この判定が無いと
          // 「箱を挟める向き」＝遮蔽が取れる向きを、最初から候補から捨ててしまう。
          if (!climbableAt(ctx.game.state.obstacles, px, pz)) break;
          climb = true;
        }
        clear = t;
      }
      // 脅威から遠ざかる向きを優先して控える。塞がれていても、
      // 壁ずりで抜けられることがあるので停止よりはるかにまし。
      let awayness = 0;
      for (const t of threats) {
        const len = Math.hypot(t.x - agent.x, t.z - agent.z) || 1;
        awayness -= ((t.x - agent.x) / len) * dx + ((t.z - agent.z) / len) * dz;
      }
      const fallbackValue = clear + awayness;
      if (fallbackValue > fallbackClear) {
        fallbackClear = fallbackValue;
        fallbackDir = { mx: dx, mz: dz, climb };
        fallbackAngle = ang;
      }

      if (clear < 2) continue;

      const px = agent.x + dx * clear;
      const pz = agent.z + dz * clear;
      let score = clear * 1.8;

      for (const t of threats) {
        const before = Math.hypot(t.x - agent.x, t.z - agent.z);
        const after = Math.hypot(t.x - px, t.z - pz);
        score += (after - before) * p.fleeDistWeight * 7;
        // 相手のすぐ横をすり抜けるコースは、触られて終わるので強く避ける。
        if (after < 3.5) score -= 60;
      }

      // 壁や隅に貼り付くと逃げ場が無くなる。
      const wallGap = Math.min(ARENA_HALF - Math.abs(px), ARENA_HALF - Math.abs(pz));
      if (wallGap < 6) score -= (6 - wallGap) * 4;

      // 味方と同じ方向へ逃げない。固まると鬼にまとめて見つかり、
      // 1 人でも残れば勝ちというルールの利点を自分から捨てることになる。
      for (const mate of s.agents) {
        if (mate.team !== 'hider' || mate.id === agent.id || mate.caught) continue;
        const gap = Math.hypot(mate.x - px, mate.z - pz);
        if (gap < 7) score -= (7 - gap) * 3;
      }

      // 全員の視線が切れる方向なら大きく加点。
      if (seekers.length > 0 && seekers.every((sk) => isCovered(s.obstacles, sk, px, pz))) {
        score += p.fleeCoverBonus;
      }

      // 乗り越えは登る間だけ足が止まるので、その代償を引く。
      if (climb) score -= p.fleeClimbCost;

      // 急な切り返しは減速につながるので、進行方向を保つ方に寄せる。
      if (heading !== null) score -= Math.abs(angleDiff(ang, heading)) * 2.2;

      // 直前のティックで選んだ方向から離れるほど減点する。
      // 毎ティック採点し直すと、間合いや `clear` のわずかな変化で選択が隣の候補へ
      // 飛び移り続け、加速し切る前に向きが変わって逃げ足そのものが鈍る。
      // 「乗り換えるならはっきり良い方向へ」に寄せることで、走り出しの速度が乗る。
      if (this.fleeAngle !== null) {
        score -= Math.abs(angleDiff(ang, this.fleeAngle)) * p.fleeTurnCost;
      }

      // 息が上がってきたら、逃げる先に補給パックがあるコースを選ぶ。
      if (agent.stamina < STAMINA_MAX * 0.5) {
        for (const pack of s.pickups) {
          if (!pack.active) continue;
          const before = Math.hypot(pack.x - agent.x, pack.z - agent.z);
          if (before > 12) continue;
          const after = Math.hypot(pack.x - px, pack.z - pz);
          if (after < before) score += (before - after) * 3.5;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestDir = { mx: dx, mz: dz, climb };
        bestAngle = ang;
      }
    }

    // どの向きにも「走れる」と言えるだけの空きが無かった場合。
    // ここで停止すると、箱に囲まれたまま何十秒も固まって狩られる。
    if (bestScore === -Infinity) {
      this.fleeAngle = fallbackAngle;
      return fallbackDir;
    }
    this.fleeAngle = bestAngle;
    return bestDir;
  }

  // ---- 移動共通 ---------------------------------------------------------

  private moveTo(
    ctx: AiContext,
    agent: Agent,
    act: Action,
    tx: number,
    tz: number,
    urgent: boolean,
  ): Action {
    const remaining = Math.hypot(tx - agent.x, tz - agent.z);
    let dir = directIfClear(ctx, agent, tx, tz);
    if (!dir || remaining > 8) {
      if (this.repath.ready() || this.path.length === 0) {
        this.path = ctx.nav.findPath(agent.x, agent.z, tx, tz) ?? [];
      }
      const f = followPath(agent, this.path);
      if (f.mx !== 0 || f.mz !== 0) dir = f;
    }
    // 経路も直線も取れないときは、とりあえず目標の方角へ押し込む。
    // 壁ずりで抜けられることが多く、少なくとも完全停止よりはましな挙動になる。
    if (!dir && remaining > 0.3) {
      dir = { mx: (tx - agent.x) / remaining, mz: (tz - agent.z) / remaining };
    }
    if (!dir) dir = { mx: 0, mz: 0 };

    act.moveX = dir.mx;
    act.moveZ = dir.mz;
    if (!urgent) {
      act.aimX = dir.mx;
      act.aimZ = dir.mz;
    }
    act.jump = shouldJump(ctx, agent, dir.mx, dir.mz);

    // 「行きたいのに進めていない」ことを詰まりの基準にする。移動指令の有無で
    // 判定すると、経路が取れずに指令が空になった状態を見逃してしまう。
    // しきい値は基本速度に対する割合。固定値にすると、速度を上げたときに
    // 「壁沿いにジリジリ滑っている」状態が「動いている」と判定されてしまう。
    const speed = Math.hypot(agent.vx, agent.vz);
    this.stuckTimer = remaining > 1 && speed < HIDER_SPEED * 0.3 ? this.stuckTimer + DT : 0;
    if (this.stuckTimer > 0.6) act.jump = true;

    return act;
  }
}

/**
 * 拠点候補を良い順に選ぶ。壁に守られていて、箱が近くにあり、中央から遠い場所ほど高評価。
 * 逃げる側が複数いる場合は互いに離れた場所を返す。1 箇所に固まると全滅するため。
 */
export function chooseShelters(ctx: AiContext, count: number): Array<{ x: number; z: number }> {
  const s = ctx.game.state;
  const nav = ctx.nav;
  const scored: Array<{ x: number; z: number; score: number }> = [];

  for (let cz = 2; cz < nav.size - 2; cz += 2) {
    for (let cx = 2; cx < nav.size - 2; cx += 2) {
      if (nav.blocked[nav.idx(cx, cz)]) continue;
      const x = nav.worldX(cx);
      const z = nav.worldX(cz);
      const fromCenter = Math.hypot(x, z);
      if (fromCenter < 10) continue;

      // 鬼が放たれる中央から直接見通せる場所は、開幕で即バレするので避ける。
      const hiddenFromSpawn = !hasLineOfSight(s.obstacles, 0, EYE_HEIGHT, 0, x, 1, z);

      // 周囲がどれだけ遮蔽物に囲まれているか（8 方向のレイが短いほど良い）。
      let cover = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        let t = 0.75;
        for (; t < 7; t += 0.75) {
          if (nav.isBlockedWorld(x + Math.sin(a) * t, z + Math.cos(a) * t)) break;
        }
        cover += Math.max(0, 7 - t);
      }

      // 運べる箱が近くにあるか。運搬距離が準備時間を食い潰すので、ここが最も効く。
      let boxes = 0;
      for (const o of s.obstacles) {
        if (o.kind !== 'box' || o.lockedBy !== null) continue;
        if (o.hw + o.hd > GRAB_MAX_SIZE) continue;
        const d = Math.hypot(o.x - x, o.z - z);
        if (d < MAX_HAUL_DIST) boxes += 1 - d / MAX_HAUL_DIST;
      }

      // 隅や壁際は「中央から遠い」ので高く評価されがちだが、
      // 見つかった瞬間に逃げ道が片側しか無くなるため実際には最悪の隠れ場所になる。
      const wallGap = Math.min(ARENA_HALF - Math.abs(x), ARENA_HALF - Math.abs(z));
      const cornered = wallGap < 6 ? (6 - wallGap) * 9 : 0;

      const score =
        cover * 1.4 + boxes * 16 + fromCenter * 0.3 + (hiddenFromSpawn ? 25 : 0) - cornered;
      scored.push({ x, z, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return [{ x: 0, z: 0 }];

  // 1 番目は単純に最高評価の場所。
  const picked = [{ x: scored[0].x, z: scored[0].z }];

  // 2 番目以降は「評価の高さ」と「既に選んだ拠点からの距離」を両方見て選ぶ。
  // 評価だけで選ぶと上位候補は隣接セルに固まっているので、全員が同じ物陰に
  // 集合してまとめて発見されてしまう。
  const separation = (c: { x: number; z: number }): number =>
    Math.min(...picked.map((p) => Math.hypot(p.x - c.x, p.z - c.z)));

  while (picked.length < count) {
    let best: { x: number; z: number } | null = null;
    let bestValue = -Infinity;
    for (const cand of scored) {
      const sep = separation(cand);
      if (sep < 8) continue; // この距離までは「同じ場所」とみなす
      const value = cand.score + sep * 2.5;
      if (value > bestValue) {
        bestValue = value;
        best = { x: cand.x, z: cand.z };
      }
    }
    // 離れた候補が尽きたら、せめて一番遠いところへ散らす。
    if (!best) {
      let far = -1;
      for (const cand of scored) {
        const sep = separation(cand);
        if (sep > far) {
          far = sep;
          best = { x: cand.x, z: cand.z };
        }
      }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked;
}

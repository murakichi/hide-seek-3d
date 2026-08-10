// 鬼の思考。見えていれば追う、見失えば最後の目撃地点、それも無ければ
// 「長く見ていない場所」を優先して巡回する。ロックされた箱は隠れ場所の手がかりとして重視する。

import { CLIMB_REACH, GRAB_RANGE, STAMINA_MAX, VIEW_DIST, VIEW_FOV } from '../core/config';
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

export class SeekerBrain {
  private path: Array<{ x: number; z: number }> = [];
  private goal: { x: number; z: number } | null = null;
  private mode: Mode = 'patrol';
  private repath: Ticker;
  private scanAngle = 0;
  private stuckTimer = 0;
  private clearTarget = -1;

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

    const prey = this.pickVisiblePrey(ctx, agent);
    if (prey) {
      this.mode = 'chase';
      this.goal = { x: prey.x, z: prey.z };
      this.path = [];
    } else {
      const lead = this.recallLead(ctx, agent);
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

    if (!this.goal) return act;
    ctx.seekerGoals.set(agent.id, this.goal);

    // 相手が高いところへ逃げたら、一段ずつ踏み台を経由して追い上げる。
    const climbing = prey !== null && prey.y > agent.y + 0.4;
    if (climbing && prey) {
      const step = this.climbTarget(ctx, agent, prey);
      if (step) this.goal = step;
    }

    // 追跡中は視線が通っているので直進でよい。それ以外は経路探索。
    let dir = this.mode === 'chase' ? directIfClear(ctx, agent, this.goal.x, this.goal.z) : null;

    // 足場に乗る直前だけは、経路探索を無視してまっすぐ突っ込む。
    // 足場そのものが障害物として扱われるので、経路に任せると避けて回り込んでしまう。
    // 逆に踏み台が遠いうちから直進させると、途中の箱に突っかかって止まる。
    const goalDist = Math.hypot(this.goal.x - agent.x, this.goal.z - agent.z);
    if (!dir && climbing && goalDist < 4.5) {
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
    act.jump = shouldJump(ctx, agent, dir.mx, dir.mz, climbing && goalDist < 4.5);

    // 追跡中は獲物を、それ以外は進行方向を少しずつ振りながら見る。
    if (this.mode === 'chase') {
      act.aimX = this.goal.x - agent.x;
      act.aimZ = this.goal.z - agent.z;
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

  /** 見えている逃走者のうち、最も近い者。 */
  private pickVisiblePrey(ctx: AiContext, agent: Agent): Agent | null {
    let best: Agent | null = null;
    let bestD = Infinity;
    for (const a of ctx.game.state.agents) {
      if (a.team !== 'hider' || a.caught) continue;
      if (!canSee(ctx.game.state, agent, a)) continue;
      const d = Math.hypot(a.x - agent.x, a.z - agent.z);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /**
   * 高所の相手を追うための次の一歩。
   * 一度のジャンプで届く面にしか乗れないので、届かない相手には
   * 「今から乗れて、相手に近い」踏み台を選んで経由する。
   */
  private climbTarget(
    ctx: AiContext,
    agent: Agent,
    prey: Agent,
  ): { x: number; z: number } | null {
    // 直接跳び移れるなら回り道は要らない。
    if (prey.y <= agent.y + CLIMB_REACH) return null;

    let best: Obstacle | null = null;
    let bestScore = Infinity;
    for (const o of ctx.game.state.obstacles) {
      if (o.kind === 'wall') continue;
      const toPrey = Math.hypot(o.x - prey.x, o.z - prey.z);
      const toSelf = Math.hypot(o.x - agent.x, o.z - agent.z);

      if (o.kind === 'pad') {
        // ジャンプ台は一気に高く上がれるが、跳んでいる間に届く範囲に
        // 相手が居なければ意味がない。
        if (toPrey > 9) continue;
      } else {
        if (o.h > agent.y + CLIMB_REACH) continue; // 今の高さからは乗れない
        if (o.h <= agent.y + 0.2) continue; // 登ったことにならない
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

  /** チームの記憶から、まだ新しい目撃情報を拾う。 */
  private recallLead(ctx: AiContext, agent: Agent): { x: number; z: number } | null {
    const mem = ctx.game.state.memory.seeker;
    const p = ctx.params.seeker;
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    for (const [id, rec] of mem) {
      const target = ctx.game.state.agents[id];
      if (target.caught) continue;
      const age = ctx.game.state.time - rec.t;
      if (age > p.memoryTrust) continue;
      const d = Math.hypot(rec.x - agent.x, rec.z - agent.z);
      if (d < 1.2) continue; // そこには居なかった
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
    const lockedBoxes = ctx.game.state.obstacles.filter(
      (o) => o.kind === 'box' && o.lockedBy === 'hider',
    );
    const others = [...ctx.seekerGoals.entries()].filter(([id]) => id !== agent.id).map(([, g]) => g);

    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;

    for (let cz = 1; cz < nav.size - 1; cz += 2) {
      for (let cx = 1; cx < nav.size - 1; cx += 2) {
        const i = nav.idx(cx, cz);
        if (nav.blocked[i]) continue;
        const x = nav.worldX(cx);
        const z = nav.worldX(cz);
        const age = ctx.game.state.time - ctx.seekerExplore[i];
        const dist = Math.hypot(x - agent.x, z - agent.z);
        if (dist < 3) continue;

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
      for (let t = 0.5; t < VIEW_DIST; t += 0.75) {
        const x = agent.x + sx * t;
        const z = agent.z + sz * t;
        const cx = nav.cx(x);
        const cz = nav.cx(z);
        if (!nav.inBounds(cx, cz)) break;
        const i = nav.idx(cx, cz);
        if (nav.blocked[i]) break;
        ctx.seekerExplore[i] = ctx.game.state.time;
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

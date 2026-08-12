// ゲーム本体。描画にも入力デバイスにも依存しない決定論シミュレーション。
// 同じ config・同じ Action 列を与えれば必ず同じ結果になる（学習・リプレイの前提）。

import { buildArena, buildPickups } from './arena';
import * as C from './config';
import {
  blocksHorizontally,
  boxesOverlap,
  clamp,
  obstaclesCollide,
  pushCircleOutOfBox,
  supportHeight,
  topOf,
} from './physics';
import { Rng } from './rng';
import { updateMemory } from './vision';
import { emptyAction } from './types';
import type { Action, Agent, GameState, MatchConfig, Obstacle, Team } from './types';

export class Game {
  state!: GameState;
  private rng!: Rng;
  /** 直近ティックの可視情報（AI と描画が参照する） */
  visible: { hider: Set<number>; seeker: Set<number> } = {
    hider: new Set(),
    seeker: new Set(),
  };

  constructor(config: MatchConfig) {
    this.reset(config);
  }

  reset(config: MatchConfig): void {
    this.rng = new Rng(config.seed);
    const layout = config.layout;
    const scale = 0.75 + (config.hiders + config.seekers) * 0.16;
    const obstacles = layout
      ? layout.obstacles.map((o, i) => ({
          ...o,
          id: i,
          vy: 0,
          heldBy: -1,
          unlockProgress: 0,
        }))
      : buildArena(config.seed, scale);
    const agents = layout
      ? this.spawnFromLayout(layout)
      : this.spawnAgents(config, obstacles);
    const pickups = layout
      ? layout.pickups.map((p, i) => ({ id: i, x: p.x, z: p.z, active: true, respawnAt: 0 }))
      : buildPickups(
          config.seed,
          obstacles,
          Math.round((config.hiders + config.seekers) * C.PICKUPS_PER_AGENT),
        );

    // 準備フェーズを飛ばす場合は、最初から追跡フェーズの残り時間で始める。
    const skipPrep = config.skipPrep === true;

    this.state = {
      config,
      phase: skipPrep ? 'hunt' : 'prep',
      time: 0,
      phaseTime: skipPrep ? C.huntTimeFor(config.seekers) : C.PREP_TIME,
      agents,
      obstacles,
      pickups,
      smokes: [],
      winner: null,
      endReason: '',
      memory: { hider: new Map(), seeker: new Map() },
      tick: 0,
    };
    this.visible = { hider: new Set(), seeker: new Set() };
  }

  /**
   * 手で組んだ配置からエージェントを作る。並び順がそのまま ID になるので、
   * `agents[id]` で引く箇所（掴んでいる箱の持ち主など）と辻褄が合う。
   */
  private spawnFromLayout(layout: NonNullable<MatchConfig['layout']>): Agent[] {
    let id = 0;
    // 人間が操作できるのは 1 人だけ。複数指定されていたら最初の 1 人を採る。
    let playerTaken = false;
    return layout.agents.map((sp) => {
      const isPlayer = sp.isPlayer && !playerTaken;
      if (isPlayer) playerTaken = true;
      return this.makeAgent(id++, sp.team, sp.x, sp.z, isPlayer, sp.y ?? 0);
    });
  }

  private makeAgent(
    id: number,
    team: Team,
    x: number,
    z: number,
    isPlayer: boolean,
    y = 0,
  ): Agent {
    return {
      id,
      team,
      x,
      z,
      y,
      vx: 0,
      vz: 0,
      vy: 0,
      facing: team === 'seeker' ? 0 : Math.atan2(-x, -z),
      grounded: true,
      stamina: C.STAMINA_MAX,
      caught: false,
      grabbed: -1,
      grabOffX: 0,
      grabOffZ: 0,
      boostUntil: -99,
      smokeCharges: team === 'hider' ? C.SMOKE_CHARGES : 0,
      lastSmokeAt: -99,
      isPlayer,
      lastSeenAt: -99,
    };
  }

  private spawnAgents(config: MatchConfig, obstacles: Obstacle[]): Agent[] {
    const agents: Agent[] = [];
    let id = 0;

    const mk = (team: Team, x: number, z: number, isPlayer: boolean): Agent =>
      this.makeAgent(id++, team, x, z, isPlayer);

    // 逃げる側は外周寄りに散らす。障害物と重ならない位置を探す。
    for (let i = 0; i < config.hiders; i++) {
      const baseAngle = (i / config.hiders) * Math.PI * 2 + this.rng.range(-0.3, 0.3);
      let px = 0;
      let pz = 0;
      for (let attempt = 0; attempt < 40; attempt++) {
        const r = this.rng.range(9, C.ARENA_HALF - 2);
        const a = baseAngle + this.rng.range(-0.5, 0.5);
        px = Math.sin(a) * r;
        pz = Math.cos(a) * r;
        if (!this.overlapsAny(obstacles, px, pz, C.AGENT_RADIUS + 0.4)) break;
      }
      agents.push(mk('hider', px, pz, config.playerTeam === 'hider' && i === 0));
    }

    // 鬼は中央のケージに詰める。
    for (let i = 0; i < config.seekers; i++) {
      const a = (i / config.seekers) * Math.PI * 2;
      const r = config.seekers > 1 ? 1.1 : 0;
      agents.push(
        mk('seeker', Math.sin(a) * r, Math.cos(a) * r, config.playerTeam === 'seeker' && i === 0),
      );
    }

    return agents;
  }

  private overlapsAny(obstacles: readonly Obstacle[], x: number, z: number, r: number): boolean {
    for (const o of obstacles) {
      if (o.kind === 'ramp') continue;
      if (Math.abs(x - o.x) < o.hw + r && Math.abs(z - o.z) < o.hd + r) return true;
    }
    return false;
  }

  get playerAgent(): Agent | null {
    return this.state.agents.find((a) => a.isPlayer) ?? null;
  }

  aliveHiders(): Agent[] {
    return this.state.agents.filter((a) => a.team === 'hider' && !a.caught);
  }

  /** 1 ティック進める。actions に無いエージェントは何もしない。 */
  step(actions: Map<number, Action>): void {
    const s = this.state;
    if (s.phase === 'over') return;

    const dt = C.DT;
    s.time += dt;
    s.phaseTime -= dt;
    s.tick++;

    if (s.phase === 'prep' && s.phaseTime <= 0) {
      s.phase = 'hunt';
      s.phaseTime = C.huntTimeFor(s.config.seekers);
    }

    for (const a of s.agents) {
      if (a.caught) continue;
      const act = actions.get(a.id) ?? emptyAction();
      this.applyInput(a, act, dt);
    }

    this.integrate(dt);
    // 掴んだ箱を先に動かしてから衝突を解く。逆順にすると、押している本人が
    // 箱に押し戻されて箱が永久に動かないデッドロックになる。
    this.moveGrabbedObstacles();
    // 手を離した箱を落とす。落ちた先に箱があればその上で止まる（＝積み上がる）。
    this.settleObstacles(dt);
    this.resolveCollisions();

    this.resolvePickups();
    for (let i = s.smokes.length - 1; i >= 0; i--) {
      if (s.smokes[i].until <= s.time) s.smokes.splice(i, 1);
    }
    this.visible = updateMemory(s);
    this.resolveCatches();
    this.checkEnd();
  }

  // ---- 入力の反映 -------------------------------------------------------

  private applyInput(a: Agent, act: Action, dt: number): void {
    const s = this.state;
    const caged = s.phase === 'prep' && a.team === 'seeker';

    let mx = act.moveX;
    let mz = act.moveZ;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
    }

    // ダッシュ判定とスタミナ。
    let speedMult = 1;
    const wantsDash = act.dash && mag > 0.1 && !caged;
    if (wantsDash && a.stamina > C.DASH_MIN_STAMINA) {
      speedMult = C.DASH_MULT;
      const base = a.team === 'seeker' ? C.SEEKER_DASH_COST : C.DASH_COST;
      const cost = s.time < a.boostUntil ? base * C.BOOST_DASH_COST : base;
      a.stamina = Math.max(0, a.stamina - cost * dt);
    } else {
      a.stamina = Math.min(C.STAMINA_MAX, a.stamina + C.STAMINA_REGEN * dt);
    }
    // 箱を掴んでいる間は遅くなる。
    if (a.grabbed >= 0) speedMult *= C.GRAB_SLOWDOWN;

    const baseSpeed = a.team === 'seeker' ? C.SEEKER_SPEED : C.HIDER_SPEED;
    const target = baseSpeed * speedMult;
    const accel = a.grounded ? C.ACCEL_GROUND : C.ACCEL_AIR;

    const desiredVx = mx * target;
    const desiredVz = mz * target;
    a.vx += clamp(desiredVx - a.vx, -accel * dt, accel * dt);
    a.vz += clamp(desiredVz - a.vz, -accel * dt, accel * dt);

    if (mag < 0.05 && a.grounded) {
      const f = Math.max(0, 1 - C.FRICTION_GROUND * dt);
      a.vx *= f;
      a.vz *= f;
    }

    // 向き。aim 指定があればそちらを優先し、無ければ進行方向を向く。
    const aimMag = Math.hypot(act.aimX, act.aimZ);
    if (aimMag > 0.05) {
      a.facing = Math.atan2(act.aimX, act.aimZ);
    } else if (Math.hypot(a.vx, a.vz) > 0.6) {
      a.facing = Math.atan2(a.vx, a.vz);
    }

    if (act.jump && a.grounded && !caged) {
      a.vy = C.JUMP_SPEED;
      a.grounded = false;
      // 踏み切りで進行方向へひと押しする。跳ねながら走ると少しだけ速いので、
      // ジャンプが「箱に登るためだけの操作」で終わらなくなる。
      const speed = Math.hypot(a.vx, a.vz);
      if (speed > 0.5) {
        const cap = target * C.JUMP_IMPULSE_CAP;
        const boosted = Math.min(speed + C.JUMP_IMPULSE, Math.max(cap, speed));
        a.vx = (a.vx / speed) * boosted;
        a.vz = (a.vz / speed) * boosted;
      }
    }

    this.updateGrab(a, act, dt);

    // 煙幕。追跡フェーズでしか使えない（準備中に撒いても消えてしまう）。
    if (
      act.smoke &&
      a.team === 'hider' &&
      a.smokeCharges > 0 &&
      s.phase === 'hunt' &&
      s.time - a.lastSmokeAt > C.SMOKE_COOLDOWN
    ) {
      a.smokeCharges--;
      a.lastSmokeAt = s.time;
      s.smokes.push({
        id: s.tick,
        x: a.x,
        z: a.z,
        until: s.time + C.SMOKE_TIME,
        bornAt: s.time,
      });
    }
  }

  private updateGrab(a: Agent, act: Action, dt: number): void {
    const s = this.state;

    if (!act.grab && a.grabbed >= 0) {
      s.obstacles[a.grabbed].heldBy = -1;
      a.grabbed = -1;
    }

    if (act.grab && a.grabbed < 0) {
      const o = this.findGrabTarget(a);
      if (o) {
        o.heldBy = a.id;
        a.grabbed = o.id;
        a.grabOffX = o.x - a.x;
        a.grabOffZ = o.z - a.z;
      }
    }

    if (act.lock) {
      const o = a.grabbed >= 0 ? s.obstacles[a.grabbed] : this.findLockTarget(a);
      if (o && o.kind === 'box') {
        if (o.lockedBy === null) {
          o.unlockProgress += dt / C.LOCK_TIME;
          if (o.unlockProgress >= 1) {
            o.lockedBy = a.team;
            o.unlockProgress = 0;
            // ロックした箱は掴めなくなるので手放す。
            if (o.heldBy >= 0) {
              s.agents[o.heldBy].grabbed = -1;
              o.heldBy = -1;
            }
          }
        } else if (o.lockedBy !== a.team) {
          o.unlockProgress += dt / C.UNLOCK_TIME;
          if (o.unlockProgress >= 1) {
            o.lockedBy = null;
            o.unlockProgress = 0;
          }
        }
      }
    }
  }

  /** 掴める箱を探す。正面に近いものを優先。 */
  private findGrabTarget(a: Agent): Obstacle | null {
    let best: Obstacle | null = null;
    let bestScore = Infinity;
    const fx = Math.sin(a.facing);
    const fz = Math.cos(a.facing);

    for (const o of this.state.obstacles) {
      if (o.kind !== 'box') continue;
      if (o.heldBy >= 0) continue;
      if (o.lockedBy !== null) continue; // ロック中の箱は動かせない
      if (o.hw + o.hd > C.GRAB_MAX_SIZE) continue;

      const dx = o.x - a.x;
      const dz = o.z - a.z;
      const dist = Math.max(0, Math.hypot(dx, dz) - Math.max(o.hw, o.hd) - C.AGENT_RADIUS);
      if (dist > C.GRAB_RANGE) continue;

      const len = Math.hypot(dx, dz) || 1;
      const dot = (dx / len) * fx + (dz / len) * fz;
      if (dot < 0.2) continue; // 背後の箱は掴まない

      const score = dist - dot * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }

  /** ロック / アンロック対象。掴んでいなくても手が届けば操作できる。 */
  private findLockTarget(a: Agent): Obstacle | null {
    let best: Obstacle | null = null;
    let bestDist = Infinity;
    for (const o of this.state.obstacles) {
      if (o.kind !== 'box') continue;
      const dx = o.x - a.x;
      const dz = o.z - a.z;
      const dist = Math.max(0, Math.hypot(dx, dz) - Math.max(o.hw, o.hd) - C.AGENT_RADIUS);
      if (dist > C.GRAB_RANGE) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = o;
      }
    }
    return best;
  }

  // ---- 物理 -------------------------------------------------------------

  private integrate(dt: number): void {
    const s = this.state;
    for (const a of s.agents) {
      if (a.caught) continue;

      a.x += a.vx * dt;
      a.z += a.vz * dt;

      a.vy -= C.GRAVITY * dt;
      a.y += a.vy * dt;

      const floor = supportHeight(s.obstacles, a.x, a.z, C.AGENT_RADIUS, a.y + 0.001);
      if (a.y <= floor + 1e-3 && a.vy <= 0) {
        a.y = floor;
        a.vy = 0;
        a.grounded = true;
        if (this.onBouncePad(a)) {
          a.vy = C.PAD_JUMP_SPEED;
          a.grounded = false;
        }
      } else {
        a.grounded = false;
      }

      // 準備フェーズ中は中央のケージが境界になる。
      // 鬼は出られず、逃げる側は入れない（開幕で隣に立たれるのを防ぐ）。
      if (s.phase === 'prep') {
        const d = Math.hypot(a.x, a.z);
        const limit =
          a.team === 'seeker'
            ? C.SEEKER_CAGE_RADIUS - C.AGENT_RADIUS
            : C.SEEKER_CAGE_RADIUS + C.AGENT_RADIUS;
        const outside = a.team === 'seeker' ? d > limit : d < limit;
        if (outside && d > 1e-6) {
          const k = limit / d;
          a.x *= k;
          a.z *= k;
          // 境界に食い込む向きの速度だけを消す。全部消すとその場に貼り付いて
          // 動けなくなるので、縁に沿って滑れるように接線成分は残す。
          const nx = a.x / limit;
          const nz = a.z / limit;
          const into = a.vx * nx + a.vz * nz;
          const digging = a.team === 'seeker' ? into > 0 : into < 0;
          if (digging) {
            a.vx -= into * nx;
            a.vz -= into * nz;
          }
        }
      }
    }
  }

  /** いま着地した面がジャンプ台か。 */
  private onBouncePad(a: Agent): boolean {
    for (const o of this.state.obstacles) {
      if (o.kind !== 'pad') continue;
      if (Math.abs(a.y - topOf(o)) > 0.12) continue;
      if (Math.abs(a.x - o.x) > o.hw + C.AGENT_RADIUS * 0.6) continue;
      if (Math.abs(a.z - o.z) > o.hd + C.AGENT_RADIUS * 0.6) continue;
      return true;
    }
    return false;
  }

  private resolveCollisions(): void {
    const s = this.state;

    for (const a of s.agents) {
      if (a.caught) continue;

      for (const o of s.obstacles) {
        if (!blocksHorizontally(o, a.y)) continue;
        const p = pushCircleOutOfBox(a.x, a.z, C.AGENT_RADIUS, o);
        if (!p) continue;
        // 押し出し方向の速度成分を殺す（壁ずりが自然になる）。
        const nx = p.x - a.x;
        const nz = p.z - a.z;
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-6) {
          const dot = (a.vx * nx + a.vz * nz) / nl;
          if (dot < 0) {
            a.vx -= (dot * nx) / nl;
            a.vz -= (dot * nz) / nl;
          }
        }
        a.x = p.x;
        a.z = p.z;
      }

      // 場外に出ないよう最後に押し戻す。
      const lim = C.ARENA_HALF - C.AGENT_RADIUS;
      a.x = clamp(a.x, -lim, lim);
      a.z = clamp(a.z, -lim, lim);
    }

    // エージェント同士。すり抜けると鬼が団子になるので軽く反発させる。
    const list = s.agents.filter((a) => !a.caught);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (Math.abs(a.y - b.y) > C.AGENT_HEIGHT * 0.8) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const minD = C.AGENT_RADIUS * 2;
        if (d >= minD || d < 1e-6) continue;
        const push = (minD - d) / 2;
        const nx = dx / d;
        const nz = dz / d;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
      }
    }
  }

  /**
   * 掴んだ箱をエージェントに追従させる。
   * 一方向が塞がっていても軸ごとに分けて動かすので、壁沿いに押していける。
   */
  private moveGrabbedObstacles(): void {
    const s = this.state;
    for (const a of s.agents) {
      if (a.grabbed < 0 || a.caught) continue;
      const o = s.obstacles[a.grabbed];

      // 手が届く範囲を大きく超えたら離す。箱が動かせずに置いていかれた場合など。
      const gap =
        Math.hypot(a.x - o.x, a.z - o.z) - Math.max(o.hw, o.hd) - C.AGENT_RADIUS;
      if (gap > C.GRAB_RANGE + 1) {
        o.heldBy = -1;
        a.grabbed = -1;
        continue;
      }

      // 縦は先。持ち手の足元の高さへ箱を合わせてから、水平に動かす。
      // 順序を逆にすると、跳んだ瞬間はまだ箱が地面の高さにあるので
      // 積みたい箱の真上へ運べない。
      o.vy = 0;
      if (o.y !== a.y && this.canPlaceObstacle(o, o.x, o.z, a.y)) o.y = a.y;

      const maxStep = C.GRAB_SPEED * C.DT;
      const dx = clamp(a.x + a.grabOffX - o.x, -maxStep, maxStep);
      const dz = clamp(a.z + a.grabOffZ - o.z, -maxStep, maxStep);
      if (dx === 0 && dz === 0) continue;

      if (this.canPlaceObstacle(o, o.x + dx, o.z + dz, o.y)) {
        o.x += dx;
        o.z += dz;
      } else if (this.canPlaceObstacle(o, o.x + dx, o.z, o.y)) {
        o.x += dx;
      } else if (this.canPlaceObstacle(o, o.x, o.z + dz, o.y)) {
        o.z += dz;
      }
    }
  }

  /**
   * 手を離した箱を落とす。真下に別の箱があればその上面で止まり、積み上がる。
   * 支えより上に浮いている箱だけが対象なので、地面に置かれた箱は素通りする。
   */
  private settleObstacles(dt: number): void {
    for (const o of this.state.obstacles) {
      if (o.kind !== 'box' || o.heldBy >= 0) continue;
      const rest = this.supportUnder(o);
      if (o.y <= rest + 1e-6) {
        // 下の箱が抜かれて宙に浮いた場合、rest が上がることもある。
        if (o.y < rest) o.y = rest;
        o.vy = 0;
        continue;
      }
      o.vy -= C.GRAVITY * dt;
      o.y += o.vy * dt;
      if (o.y <= rest) {
        o.y = rest;
        o.vy = 0;
      }
    }
  }

  /** 箱の真下にある支えの高さ。何も無ければ地面（0）。 */
  private supportUnder(o: Obstacle): number {
    let best = 0;
    for (const other of this.state.obstacles) {
      if (other.id === o.id) continue;
      if (other.kind === 'ramp' || other.kind === 'pad') continue;
      if (!boxesOverlap(o, o.x, o.z, other)) continue;
      const top = topOf(other);
      // 自分の底より上にある面には載れない（横の壁の上面などを拾わない）。
      if (top <= o.y + C.STEP_HEIGHT && top > best) best = top;
    }
    return best;
  }

  private canPlaceObstacle(o: Obstacle, x: number, z: number, y: number): boolean {
    if (Math.abs(x) + o.hw > C.ARENA_HALF || Math.abs(z) + o.hd > C.ARENA_HALF) return false;
    for (const other of this.state.obstacles) {
      if (other.id === o.id) continue;
      if (other.kind === 'ramp') continue;
      // ジャンプ台は薄いので高さで見ると「上に載せられる」判定になってしまうが、
      // 塞ぐと踏めなくなるので、従来どおり footprint ごと置けないままにする。
      if (other.kind === 'pad') {
        if (boxesOverlap(o, x, z, other)) return false;
        continue;
      }
      if (obstaclesCollide(o, x, z, y, other)) return false;
    }
    // 他のエージェントを押し潰さない。掴んでいる本人は判定から外す。
    for (const a of this.state.agents) {
      if (a.caught || a.id === o.heldBy) continue;
      if (a.y >= y + o.h - 0.05) continue; // 上に乗っている場合は無視
      if (a.y + C.AGENT_HEIGHT <= y) continue; // 頭上を通す場合も無視
      if (
        Math.abs(a.x - x) < o.hw + C.AGENT_RADIUS * 0.9 &&
        Math.abs(a.z - z) < o.hd + C.AGENT_RADIUS * 0.9
      ) {
        return false;
      }
    }
    return true;
  }

  /** 補給パックの取得と復活。 */
  private resolvePickups(): void {
    const s = this.state;
    for (const p of s.pickups) {
      if (!p.active) {
        if (s.time >= p.respawnAt) p.active = true;
        continue;
      }
      for (const a of s.agents) {
        if (a.caught) continue;
        // 準備フェーズ中の鬼はケージから出られないので実質取れないが、明示しておく。
        if (s.phase === 'prep' && a.team === 'seeker') continue;
        if (Math.abs(a.y) > 1.2) continue; // 箱の上からは拾えない
        if (Math.hypot(a.x - p.x, a.z - p.z) > C.PICKUP_RADIUS + C.AGENT_RADIUS) continue;

        a.stamina = C.STAMINA_MAX;
        a.boostUntil = s.time + C.BOOST_TIME;
        p.active = false;
        p.respawnAt = s.time + C.PICKUP_RESPAWN;
        break;
      }
    }
  }

  // ---- 決着 -------------------------------------------------------------

  private resolveCatches(): void {
    const s = this.state;
    if (s.phase !== 'hunt') return;

    for (const seeker of s.agents) {
      if (seeker.team !== 'seeker') continue;
      for (const hider of s.agents) {
        if (hider.team !== 'hider' || hider.caught) continue;
        const d = Math.hypot(hider.x - seeker.x, hider.z - seeker.z);
        if (d < C.CATCH_DIST && Math.abs(hider.y - seeker.y) < C.CATCH_VERTICAL) {
          hider.caught = true;
          if (hider.grabbed >= 0) {
            s.obstacles[hider.grabbed].heldBy = -1;
            hider.grabbed = -1;
          }
        }
      }
    }
  }

  private checkEnd(): void {
    const s = this.state;
    if (s.phase !== 'hunt') return;

    if (this.aliveHiders().length === 0) {
      s.phase = 'over';
      s.winner = 'seeker';
      s.endReason = '逃げる側は全員捕まった';
      return;
    }
    if (s.phaseTime <= 0) {
      s.phase = 'over';
      s.winner = 'hider';
      s.endReason = '時間切れ — 逃げ切り成功';
    }
  }
}

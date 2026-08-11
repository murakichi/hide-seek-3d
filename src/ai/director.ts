// AI 全体の取りまとめ。ナビゲーショングリッドの再構築と、各エージェントへの思考の割り当て。

import { AGENT_RADIUS, SEEKER_CAGE_RADIUS } from '../core/config';
import type { Game } from '../core/game';
import { Rng } from '../core/rng';
import type { Action, Team } from '../core/types';
import { Ticker, type AiContext } from './context';
import { TeamCoop } from './coop';
import { chooseShelters, HiderBrain } from './hider';
import { NavGrid } from './nav';
import { DEFAULT_PARAMS, type AiParams } from './params';
import { SeekerBrain } from './seeker';

export class AiDirector {
  readonly ctx: AiContext;
  private seekers = new Map<number, SeekerBrain>();
  private hiders = new Map<number, HiderBrain>();
  private navTicker = new Ticker(0.25);

  constructor(game: Game, params: AiParams = DEFAULT_PARAMS) {
    const nav = new NavGrid();
    nav.rebuild(game.state.obstacles);
    this.ctx = {
      game,
      nav,
      params,
      rng: new Rng(game.state.config.seed ^ 0x9e3779b9),
      coop: {
        hider: new TeamCoop(nav.size * nav.size),
        seeker: new TeamCoop(nav.size * nav.size),
      },
      time: 0,
    };

    for (const a of game.state.agents) {
      if (a.isPlayer) continue;
      if (a.team === 'seeker') this.seekers.set(a.id, new SeekerBrain(a.id));
      else this.hiders.set(a.id, new HiderBrain(a.id));
    }

    // 逃げる側は 1 人ずつ別の拠点に散らす。人間が混ざっていても
    // AI が同じ場所に固まらないよう、chooseShelters には全員分を要求する。
    // 拠点は「予約」として持つ。誰がどこを引き受けたかが 1 箇所で分かるので、
    // 後から「拠点を見つかったので取り直す」を足すときもここだけを見ればよい。
    const hiders = game.state.agents.filter((a) => a.team === 'hider');
    const spots = chooseShelters(this.ctx, hiders.length);
    hiders.forEach((a, i) => {
      const spot = spots[i % spots.length];
      // 拠点は試合を通して動かさないので寿命なし。
      this.ctx.coop.hider.claim('shelter', `s${i}`, a.id, 0, 0, {
        x: spot.x,
        z: spot.z,
        ttl: Infinity,
      });
    });
  }

  /** デバッグ用。指定エージェントの思考状態を文字列で返す。 */
  describe(agentId: number): string {
    return (this.hiders.get(agentId) ?? this.seekers.get(agentId))?.describe() ?? '-';
  }

  /** 逃げる側に割り当てた拠点（トレース表示用）。 */
  shelterOf(agentId: number): { x: number; z: number } | null {
    return this.ctx.coop.hider.posOf(agentId, 'shelter');
  }

  /** チームの申し合わせの状態（トレース表示用）。 */
  describeCoop(team: Team): string {
    const ids = this.ctx.game.state.agents
      .filter((a) => a.team === team && !a.caught)
      .map((a) => a.id);
    const coop = this.ctx.coop[team];
    return `予約 ${coop.describe(this.ctx.time)} / 意図 ${coop.describeIntents(ids, this.ctx.time)}`;
  }

  /** 1 ティック分の AI 入力をまとめて返す。 */
  tick(): Map<number, Action> {
    const ctx = this.ctx;
    const s = ctx.game.state;
    ctx.time = s.time;
    if (this.navTicker.ready()) {
      // 準備フェーズ中は中央のケージも障害物として扱う。経路がケージを突っ切ると、
      // 逃げる側が境界に押し戻され続けてその場から動けなくなる。
      ctx.nav.rebuild(
        s.obstacles,
        s.phase === 'prep' ? SEEKER_CAGE_RADIUS + AGENT_RADIUS : 0,
      );
    }

    // 思考の前に、期限切れと脱落者の申し合わせを掃除する。
    // これが無いと、捕まった味方が押さえたままの担当を全員が避け続ける。
    const active: Record<Team, Set<number>> = { hider: new Set(), seeker: new Set() };
    for (const a of s.agents) {
      if (!a.caught) active[a.team].add(a.id);
    }
    ctx.coop.hider.sweep(ctx.time, active.hider);
    ctx.coop.seeker.sweep(ctx.time, active.seeker);

    const actions = new Map<number, Action>();
    for (const a of ctx.game.state.agents) {
      if (a.isPlayer || a.caught) continue;
      const brain = a.team === 'seeker' ? this.seekers.get(a.id) : this.hiders.get(a.id);
      if (!brain) continue;
      actions.set(a.id, brain.act(ctx, a));
    }
    return actions;
  }
}

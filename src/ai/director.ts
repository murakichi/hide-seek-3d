// AI 全体の取りまとめ。ナビゲーショングリッドの再構築と、各エージェントへの思考の割り当て。

import { AGENT_RADIUS, SEEKER_CAGE_RADIUS } from '../core/config';
import type { Game } from '../core/game';
import { Rng } from '../core/rng';
import type { Action } from '../core/types';
import { Ticker, type AiContext } from './context';
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
      shelters: new Map(),
      seekerExplore: new Float32Array(nav.size * nav.size),
      seekerGoals: new Map(),
      time: 0,
    };

    for (const a of game.state.agents) {
      if (a.isPlayer) continue;
      if (a.team === 'seeker') this.seekers.set(a.id, new SeekerBrain(a.id));
      else this.hiders.set(a.id, new HiderBrain(a.id));
    }

    // 逃げる側は 1 人ずつ別の拠点に散らす。人間が混ざっていても
    // AI が同じ場所に固まらないよう、chooseShelters には全員分を要求する。
    const hiders = game.state.agents.filter((a) => a.team === 'hider');
    const spots = chooseShelters(this.ctx, hiders.length);
    hiders.forEach((a, i) => this.ctx.shelters.set(a.id, spots[i % spots.length]));
  }

  /** デバッグ用。指定エージェントの思考状態を文字列で返す。 */
  describe(agentId: number): string {
    return (this.hiders.get(agentId) ?? this.seekers.get(agentId))?.describe() ?? '-';
  }

  /** 逃げる側に割り当てた拠点（トレース表示用）。 */
  shelterOf(agentId: number): { x: number; z: number } | null {
    return this.ctx.shelters.get(agentId) ?? null;
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

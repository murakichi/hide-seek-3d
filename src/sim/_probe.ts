// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 追跡フェーズで「脅威を見失ったあと、逃げる側が鬼の方へ戻っていないか」を数える。
//
// 仮説: knownThreats の記憶は 4 秒で切れる。切れた瞬間に evade() は
// 「拠点へ帰る」分岐に落ちるので、鬼が拠点との間にいると自分から近づいてしまう。

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { Agent, GameState, MatchConfig } from '../core/types';
import { canSee } from '../core/vision';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 24;
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const TRIGGER = DEFAULT_PARAMS.hider.fleeTriggerDist;

/** hider.ts の knownThreats を再現する。 */
function knownThreats(s: GameState, agent: Agent): Array<{ x: number; z: number }> {
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

let huntTicks = 0;
let idleTicks = 0; // 逃走モードでないティック
let idleNearTicks = 0; // そのうち鬼が 25m 以内にいたティック
let approachTicks = 0; // さらに鬼へ向かって進んでいたティック
let approachDistSum = 0; // 鬼へ詰めた距離の合計(m)

let detects = 0; // 見えていない→見えた の遷移
let detectsWhileApproaching = 0; // 直前 1.5 秒に鬼へ詰めていた発見
let detectsWhileIdle = 0; // 発見時に逃走モードでなかった

let caught = 0;
let caughtApproaching = 0;
let homeDistAtCatch = 0;

for (let i = 0; i < GAMES; i++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: 1234 + i * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game, DEFAULT_PARAMS);
  const seen = new Map<number, boolean>();
  // 直近 1.5 秒ぶんの「鬼へ詰めた量」
  const recentApproach = new Map<number, number[]>();
  const prevCaught = new Set<number>();
  const WINDOW = Math.round(1.5 / DT);

  for (let t = 0; t < MAX_TICKS; t++) {
    const actions = ai.tick();
    const s = game.state;

    if (s.phase === 'hunt') {
      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        huntTicks++;
        const seekers = s.agents.filter((k) => k.team === 'seeker' && !k.caught);
        if (seekers.length === 0) continue;

        let near = seekers[0];
        let nearD = Infinity;
        for (const k of seekers) {
          const d = Math.hypot(k.x - a.x, k.z - a.z);
          if (d < nearD) {
            nearD = d;
            near = k;
          }
        }

        const threats = knownThreats(s, a);
        const knownNear = threats.length
          ? Math.min(...threats.map((th) => Math.hypot(th.x - a.x, th.z - a.z)))
          : Infinity;
        const fleeing = knownNear < TRIGGER;

        const act = actions.get(a.id);
        const mag = act ? Math.hypot(act.moveX, act.moveZ) : 0;
        // 移動入力が最寄りの鬼へどれだけ向いているか（-1..1）
        let toward = 0;
        if (act && mag > 0.05 && nearD > 1e-3) {
          toward =
            (act.moveX / mag) * ((near.x - a.x) / nearD) +
            (act.moveZ / mag) * ((near.z - a.z) / nearD);
        }

        const list = recentApproach.get(a.id) ?? [];
        list.push(toward > 0.3 ? 1 : 0);
        if (list.length > WINDOW) list.shift();
        recentApproach.set(a.id, list);

        if (!fleeing) {
          idleTicks++;
          if (nearD < 25) {
            idleNearTicks++;
            if (toward > 0.3) {
              approachTicks++;
              approachDistSum += toward * mag * 9.4 * DT;
            }
          }
        }

        const visible = seekers.some((k) => canSee(s, k, a));
        const key = a.id;
        if (visible && !(seen.get(key) ?? false)) {
          detects++;
          const recent = recentApproach.get(key) ?? [];
          const ratio = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : 0;
          if (ratio > 0.5) detectsWhileApproaching++;
          if (!fleeing) detectsWhileIdle++;
        }
        seen.set(key, visible);
      }
    }

    game.step(actions);

    for (const a of game.state.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      caught++;
      const recent = recentApproach.get(a.id) ?? [];
      const ratio = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : 0;
      if (ratio > 0.4) caughtApproaching++;
      const home = ai.shelterOf(a.id);
      if (home) homeDistAtCatch += Math.hypot(home.x - a.x, home.z - a.z);
    }
    if (game.state.phase === 'over') break;
  }
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合`);
console.log(`  追跡フェーズのティック: ${huntTicks}`);
console.log(`  逃走モードでない: ${idleTicks} (${pct(idleTicks, huntTicks)})`);
console.log(`    うち鬼が 25m 以内: ${idleNearTicks}`);
console.log(
  `    さらに鬼へ向かって前進: ${approachTicks} (${pct(approachTicks, idleNearTicks)})  ` +
    `詰めた距離 合計 ${approachDistSum.toFixed(0)}m`,
);
console.log(`  発見イベント: ${detects}`);
console.log(`    直前 1.5 秒に鬼へ詰めていた: ${detectsWhileApproaching} (${pct(detectsWhileApproaching, detects)})`);
console.log(`    発見時に逃走モードでなかった: ${detectsWhileIdle} (${pct(detectsWhileIdle, detects)})`);
console.log(`  捕獲: ${caught}`);
console.log(`    直前 1.5 秒に鬼へ詰めていた: ${caughtApproaching} (${pct(caughtApproaching, caught)})`);
console.log(`    捕獲地点と拠点の平均距離: ${(homeDistAtCatch / Math.max(1, caught)).toFixed(1)}m`);

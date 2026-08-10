// 一時的な計測スクリプト（改善サイクル用・使い捨て）。
// 追跡フェーズで実際に何が起きているかを人数構成ごとに出す。
//
//   npx tsx src/sim/_probe.ts
//
// 【視界】隠れることが機能しているか
//   初発見までの秒数 / 視線を切った回数 / 切ってから再発見までの秒数 / 見られている割合
// 【追走】追われている間に距離が開くことがあるか
//   鬼との平均距離 / 両者のダッシュ使用率とスタミナ / 距離が開いた窓の割合

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const GAMES = 30;
/** 「追われている」とみなす距離 */
const CHASE_DIST = 14;
/** 距離の増減を見る窓（5 秒） */
const WINDOW = Math.round(5 / DT);

interface HiderLog {
  firstSeen: number | null;
  seenTicks: number;
  losBreaks: number;
  /** 視線を切ってから次に見つかるまでの秒 */
  freeSpans: number[];
  caughtAt: number | null;
  survivedAfterSeen: number | null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function run(hiders: number, seekers: number) {
  const logs: HiderLog[] = [];
  let huntTicks = 0;
  let wins = 0;

  let chaseTicks = 0;
  let distSum = 0;
  let hiderDashTicks = 0;
  let seekerDashTicks = 0;
  let hiderStamina = 0;
  let seekerStamina = 0;
  let windows = 0;
  let widened = 0;

  for (let i = 0; i < GAMES; i++) {
    const config: MatchConfig = { hiders, seekers, playerTeam: null, seed: 1234 + i * 7919 };
    const game = new Game(config);
    const ai = new AiDirector(game, DEFAULT_PARAMS);
    const s = game.state;

    const log = new Map<number, HiderLog>();
    const wasSeen = new Map<number, boolean>();
    const freeSince = new Map<number, number>();
    const distHist = new Map<number, number[]>();
    let huntStart: number | null = null;

    for (const a of s.agents) {
      if (a.team !== 'hider') continue;
      log.set(a.id, {
        firstSeen: null,
        seenTicks: 0,
        losBreaks: 0,
        freeSpans: [],
        caughtAt: null,
        survivedAfterSeen: null,
      });
      wasSeen.set(a.id, false);
      distHist.set(a.id, []);
    }

    // 最後の 1 人が捕まった瞬間に phase が over になる。その ticks も見ないと
    // 1v1 の「発見から捕獲まで」が空になる。
    let ended = false;
    for (let t = 0; t < MAX_TICKS && !ended; t++) {
      const actions = ai.tick();
      game.step(actions);
      if (s.phase === 'over') ended = true;
      if (s.phase !== 'hunt' && huntStart === null) continue;
      if (huntStart === null) {
        huntStart = s.time;
        for (const id of log.keys()) freeSince.set(id, s.time);
      }
      huntTicks++;

      const seekersAlive = s.agents.filter((k) => k.team === 'seeker' && !k.caught);

      for (const a of s.agents) {
        if (a.team !== 'hider') continue;
        const l = log.get(a.id)!;
        if (a.caught) {
          if (l.caughtAt === null) {
            l.caughtAt = s.time;
            if (l.firstSeen !== null) l.survivedAfterSeen = s.time - huntStart - l.firstSeen;
          }
          continue;
        }

        const seen = game.visible.seeker.has(a.id);
        if (seen) {
          l.seenTicks++;
          if (l.firstSeen === null) l.firstSeen = s.time - huntStart;
          if (!wasSeen.get(a.id)) l.freeSpans.push(s.time - (freeSince.get(a.id) ?? s.time));
        } else if (wasSeen.get(a.id)) {
          l.losBreaks++;
          freeSince.set(a.id, s.time);
        }
        wasSeen.set(a.id, seen);

        if (!seekersAlive.length) continue;
        const near = Math.min(...seekersAlive.map((k) => Math.hypot(k.x - a.x, k.z - a.z)));
        if (near > CHASE_DIST) continue;

        chaseTicks++;
        distSum += near;
        if (actions.get(a.id)?.dash) hiderDashTicks++;
        hiderStamina += a.stamina;
        const chaser = seekersAlive.reduce((m, k) =>
          Math.hypot(k.x - a.x, k.z - a.z) < Math.hypot(m.x - a.x, m.z - a.z) ? k : m,
        );
        if (actions.get(chaser.id)?.dash) seekerDashTicks++;
        seekerStamina += chaser.stamina;

        const h = distHist.get(a.id)!;
        h.push(near);
        if (h.length > WINDOW) {
          windows++;
          if (h[h.length - 1] > h[h.length - 1 - WINDOW] + 0.5) widened++;
        }
      }
    }

    if (s.winner === 'hider') wins++;
    for (const [id, l] of log) {
      if (l.caughtAt === null && wasSeen.get(id) === false) {
        l.freeSpans.push(s.time - (freeSince.get(id) ?? s.time));
      }
      logs.push(l);
    }
  }

  const seenLogs = logs.filter((l) => l.firstSeen !== null);
  const survived = logs.filter((l) => l.survivedAfterSeen !== null);
  const neverSeen = logs.filter((l) => l.firstSeen === null).length;
  const escaped = seenLogs.filter((l) => l.caughtAt === null).length;
  const seenSec = logs.reduce((a, l) => a + l.seenTicks * DT, 0);

  const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;

  console.log(`\n=== ${hiders}v${seekers}  ${GAMES} 試合  逃げ側勝率 ${pct(wins, GAMES)} ===`);
  console.log(`  [視界] 逃走者 ${logs.length} 人`);
  console.log(`    一度も見つからず  ${neverSeen} 人`);
  console.log(`    見つかって逃げ切り ${escaped} / ${seenLogs.length} 人 (${pct(escaped, seenLogs.length)})`);
  console.log(`    初発見まで        ${avg(seenLogs.map((l) => l.firstSeen!)).toFixed(1)} 秒（追跡開始から）`);
  console.log(`    発見から捕獲まで  ${avg(survived.map((l) => l.survivedAfterSeen!)).toFixed(1)} 秒`);
  console.log(`    視線切り回数      ${avg(seenLogs.map((l) => l.losBreaks)).toFixed(2)} 回/人`);
  console.log(`    切ってから再発見  ${avg(logs.flatMap((l) => l.freeSpans.slice(1))).toFixed(1)} 秒`);
  console.log(`    見られている割合  ${pct(seenSec, huntTicks * DT)}`);
  console.log(`  [追走] ${CHASE_DIST}m 以内 ${(chaseTicks * DT).toFixed(0)} 秒`);
  console.log(`    平均距離          ${(distSum / Math.max(1, chaseTicks)).toFixed(1)} m`);
  console.log(`    逃 ダッシュ率     ${pct(hiderDashTicks, chaseTicks)}  ` +
    `平均スタミナ ${(hiderStamina / Math.max(1, chaseTicks)).toFixed(0)}`);
  console.log(`    鬼 ダッシュ率     ${pct(seekerDashTicks, chaseTicks)}  ` +
    `平均スタミナ ${(seekerStamina / Math.max(1, chaseTicks)).toFixed(0)}`);
  console.log(`    5 秒で距離が開いた ${pct(widened, windows)}`);
}

run(1, 1);
run(2, 2);
run(3, 3);

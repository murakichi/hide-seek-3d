// 鬼のパラメータを振って効きを見る計測スクリプト（改善サイクル用）。
//
// `_ab.ts` が「変更前後」を 3 シードで比べるのに対し、こちらは
// **1 つのパラメータを複数の値で振って**当たりを付けるためのもの。
// 値を決めたら `_ab.ts` で採否を確かめる、という順で使う。
//
//   npx tsx src/sim/_sweep.ts sweep 1 1 80 chaseLeadTime 0,0.6,1.2,2 1234
//   npx tsx src/sim/_sweep.ts shake 3 3 48   視線を切ったあと何 m 離れられているか
//   npx tsx src/sim/_sweep.ts where 1 1 48   発見地点がロック箱にどれだけ寄っているか
//
// 掃引の結果は必ず 2 シード以上で確かめること。1 シードだと 3v3 で符号が反転する。

import { AiDirector } from '../ai/director';
import { cloneParams, DEFAULT_PARAMS } from '../ai/params';
import { ARENA_HALF, DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';
import { runSeries } from './headless';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const MODE = process.argv[2] ?? 'where';

/** 逃げる側がロックした箱のうち、最も近いものまでの距離。 */
function distToLocked(
  obstacles: Array<{ kind: string; lockedBy: string | null; x: number; z: number }>,
  x: number,
  z: number,
): number | null {
  let best = Infinity;
  for (const o of obstacles) {
    if (o.kind !== 'box' || o.lockedBy !== 'hider') continue;
    const d = Math.hypot(o.x - x, o.z - z);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

/**
 * 発見地点・捕獲地点がロック箱にどれだけ寄っているかを測る。
 * 比較対象として、アリーナ上の通行可能な点からロック箱までの平均距離も出す。
 * 発見地点の方が明らかに近ければ、ロック箱が居場所を教えていることになる。
 */
function where(hiders: number, seekers: number, games: number): void {
  const detectDist: number[] = [];
  const catchDist: number[] = [];
  const arenaDist: number[] = [];
  let detections = 0;

  for (let i = 0; i < games; i++) {
    const config: MatchConfig = {
      hiders,
      seekers,
      playerTeam: null,
      seed: 1234 + i * 7919,
    };
    const game = new Game(config);
    const ai = new AiDirector(game, DEFAULT_PARAMS);
    const s = game.state;
    const seenOnce = new Set<number>();
    const prevCaught = new Set<number>();
    let sampled = false;

    for (let t = 0; t < MAX_TICKS; t++) {
      game.step(ai.tick());

      // 追跡開始直後のロック状況で、アリーナ全体の基準値を取る。
      if (s.phase === 'hunt' && !sampled) {
        sampled = true;
        for (let gx = -ARENA_HALF + 2; gx <= ARENA_HALF - 2; gx += 4) {
          for (let gz = -ARENA_HALF + 2; gz <= ARENA_HALF - 2; gz += 4) {
            const d = distToLocked(s.obstacles, gx, gz);
            if (d !== null) arenaDist.push(d);
          }
        }
      }

      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        if (!game.visible.seeker.has(a.id) || seenOnce.has(a.id)) continue;
        seenOnce.add(a.id);
        detections++;
        const d = distToLocked(s.obstacles, a.x, a.z);
        if (d !== null) detectDist.push(d);
      }
      for (const a of s.agents) {
        if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
        prevCaught.add(a.id);
        const d = distToLocked(s.obstacles, a.x, a.z);
        if (d !== null) catchDist.push(d);
      }
      if (s.phase === 'over') break;
    }
  }

  console.log(`${hiders}v${seekers} / ${games} 試合  ロック箱までの距離`);
  console.log(`  アリーナ上の任意の点から  ${mean(arenaDist).toFixed(1)} m  (n=${arenaDist.length})`);
  console.log(`  初めて発見された地点から  ${mean(detectDist).toFixed(1)} m  (n=${detectDist.length}/${detections})`);
  console.log(`  捕獲された地点から        ${mean(catchDist).toFixed(1)} m  (n=${catchDist.length})`);
}

/** 鬼のパラメータを 1 つ振って、逃げ側勝率がどう動くかを見る。 */
function sweep(
  key: keyof typeof DEFAULT_PARAMS.seeker,
  hiders: number,
  seekers: number,
  games: number,
  values: number[],
  seed0: number,
): void {
  console.log(`${hiders}v${seekers} / ${games} 試合 (seed0=${seed0})  seeker.${key} の掃引`);
  for (const v of values) {
    const params = cloneParams(DEFAULT_PARAMS);
    params.seeker[key] = v;
    const r = runSeries(games, hiders, seekers, params, seed0);
    console.log(
      `  ${key}=${String(v).padStart(4)}  逃げ側勝率 ${(r.hiderWinRate * 100).toFixed(1).padStart(5)}%  ` +
        `生存 ${r.avgSurvivors.toFixed(2)}  初補足 ${r.avgFirstCatch?.toFixed(1) ?? '—'} 秒`,
    );
  }
}

/**
 * 見失われた逃走者が、そのあと目撃地点からどれだけ離れられているかを測る。
 * 鬼は memoryTrust 秒だけ目撃地点を信じて向かってくるので、
 * その間に十分離れていなければ視線を切った意味がない。
 */
function shake(hiders: number, seekers: number, games: number): void {
  const trust = DEFAULT_PARAMS.seeker.memoryTrust;
  const at: Record<number, number[]> = { 2: [], 4: [], 6: [] };
  let events = 0;
  let caughtAfterLost = 0;
  let lostTotal = 0;

  for (let i = 0; i < games; i++) {
    const config: MatchConfig = { hiders, seekers, playerTeam: null, seed: 1234 + i * 7919 };
    const game = new Game(config);
    const ai = new AiDirector(game, DEFAULT_PARAMS);
    const s = game.state;
    const wasSeen = new Set<number>();
    // 見失った時点の座標と時刻。以後の距離を追う。
    const pending: Array<{ id: number; x: number; z: number; t: number; done: Set<number> }> = [];
    const prevCaught = new Set<number>();

    for (let t = 0; t < MAX_TICKS; t++) {
      game.step(ai.tick());

      // 捕獲の検出はフェーズ判定より先に行う。最後の 1 人が捕まった瞬間に
      // phase が 'over' へ移るので、hunt に限ると 1v1 の捕獲を取りこぼす。
      for (const a of s.agents) {
        if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
        prevCaught.add(a.id);
        const ev = pending.filter((e) => e.id === a.id).pop();
        if (ev) {
          lostTotal++;
          if (s.time - ev.t < trust) caughtAfterLost++;
        }
      }

      if (s.phase !== 'hunt') {
        if (s.phase === 'over') break;
        continue;
      }

      for (const a of s.agents) {
        if (a.team !== 'hider' || a.caught) continue;
        const seen = game.visible.seeker.has(a.id);
        if (seen) wasSeen.add(a.id);
        else if (wasSeen.has(a.id)) {
          wasSeen.delete(a.id);
          events++;
          pending.push({ id: a.id, x: a.x, z: a.z, t: s.time, done: new Set() });
        }
      }

      for (const ev of pending) {
        const a = s.agents[ev.id];
        const age = s.time - ev.t;
        for (const mark of [2, 4, 6]) {
          if (age < mark || ev.done.has(mark)) continue;
          ev.done.add(mark);
          if (!a.caught) at[mark].push(Math.hypot(a.x - ev.x, a.z - ev.z));
        }
      }

    }
  }

  console.log(`${hiders}v${seekers} / ${games} 試合  視線を切ったあとの離脱距離 (memoryTrust=${trust}s)`);
  console.log(`  見失われた回数 ${events}`);
  for (const mark of [2, 4, 6]) {
    const xs = at[mark];
    const far = xs.filter((d) => d > 10).length;
    console.log(
      `  ${mark} 秒後: 平均 ${mean(xs).toFixed(1)} m  ` +
        `(全力なら ${(9.4 * mark).toFixed(0)} m)  10m 超えは ${((far / Math.max(1, xs.length)) * 100).toFixed(0)}%  n=${xs.length}`,
    );
  }
  console.log(`  見失われた後 ${trust} 秒以内に捕まった: ${caughtAfterLost}/${lostTotal}`);
}

const hiders = Number(process.argv[3] ?? 1);
const seekers = Number(process.argv[4] ?? 1);
const games = Number(process.argv[5] ?? 48);

if (MODE === 'sweep') {
  const key = (process.argv[6] ?? 'lockedBoxLure') as keyof typeof DEFAULT_PARAMS.seeker;
  const values = (process.argv[7] ?? '0,4,8,12').split(',').map(Number);
  const seed0 = Number(process.argv[8] ?? 1234);
  sweep(key, hiders, seekers, games, values, seed0);
} else if (MODE === 'shake') {
  shake(hiders, seekers, games);
} else {
  where(hiders, seekers, games);
}

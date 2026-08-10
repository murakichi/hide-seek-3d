// ヘッドレス対戦。描画なしで AI 同士を大量に戦わせ、バランスと AI の強さを測る。
// 使い方: npm run sim -- --games 100 --hiders 2 --seekers 2

import { AiDirector } from '../ai/director';
import { DEFAULT_PARAMS, type AiParams } from '../ai/params';
import { DT, HUNT_TIME, PREP_TIME } from '../core/config';
import { Game } from '../core/game';
import type { MatchConfig, Winner } from '../core/types';

/** 最長の試合でも必ず終わる打ち切り点。 */
const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);

export interface MatchResult {
  winner: Winner;
  /** 決着までの経過秒 */
  time: number;
  /** 生き残った逃走者の数 */
  survivors: number;
  /** 最初に捕まった時刻（誰も捕まらなければ null） */
  firstCatch: number | null;
  /** 準備フェーズ終了時にロックされていた箱の数 */
  lockedBoxes: number;
}

export function runMatch(config: MatchConfig, params: AiParams = DEFAULT_PARAMS): MatchResult {
  const game = new Game(config);
  const ai = new AiDirector(game, params);

  let firstCatch: number | null = null;
  let lockedBoxes = 0;
  let prevPhase = game.state.phase;
  let caughtCount = 0;

  for (let t = 0; t < MAX_TICKS; t++) {
    game.step(ai.tick());

    if (prevPhase === 'prep' && game.state.phase === 'hunt') {
      lockedBoxes = game.state.obstacles.filter((o) => o.lockedBy === 'hider').length;
    }
    prevPhase = game.state.phase;

    const nowCaught = game.state.agents.filter((a) => a.team === 'hider' && a.caught).length;
    if (nowCaught > caughtCount) {
      caughtCount = nowCaught;
      if (firstCatch === null) firstCatch = game.state.time;
    }

    if (game.state.phase === 'over') break;
  }

  return {
    winner: game.state.winner,
    time: game.state.time,
    survivors: game.aliveHiders().length,
    firstCatch,
    lockedBoxes,
  };
}

export interface SeriesResult {
  games: number;
  hiderWins: number;
  seekerWins: number;
  hiderWinRate: number;
  avgSurvivors: number;
  avgFirstCatch: number | null;
  avgLockedBoxes: number;
  msPerGame: number;
}

export function runSeries(
  games: number,
  hiders: number,
  seekers: number,
  params: AiParams = DEFAULT_PARAMS,
  seed0 = 1234,
): SeriesResult {
  const t0 = Date.now();
  let hiderWins = 0;
  let seekerWins = 0;
  let survivors = 0;
  let lockedBoxes = 0;
  const catchTimes: number[] = [];

  for (let i = 0; i < games; i++) {
    const config: MatchConfig = {
      hiders,
      seekers,
      playerTeam: null,
      seed: seed0 + i * 7919,
    };
    const r = runMatch(config, params);
    if (r.winner === 'hider') hiderWins++;
    else if (r.winner === 'seeker') seekerWins++;
    survivors += r.survivors;
    lockedBoxes += r.lockedBoxes;
    if (r.firstCatch !== null) catchTimes.push(r.firstCatch);
  }

  return {
    games,
    hiderWins,
    seekerWins,
    hiderWinRate: hiderWins / games,
    avgSurvivors: survivors / games,
    avgFirstCatch: catchTimes.length
      ? catchTimes.reduce((a, b) => a + b, 0) / catchTimes.length
      : null,
    avgLockedBoxes: lockedBoxes / games,
    msPerGame: (Date.now() - t0) / games,
  };
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function main(): void {
  const games = arg('games', 30);
  const hiders = arg('hiders', 2);
  const seekers = arg('seekers', 2);

  console.log(`${hiders}v${seekers} を ${games} 試合...`);
  const r = runSeries(games, hiders, seekers);

  console.log('');
  console.log(`  逃げ側勝率   ${(r.hiderWinRate * 100).toFixed(1)}%  (${r.hiderWins}/${r.games})`);
  console.log(`  平均生存人数 ${r.avgSurvivors.toFixed(2)} / ${hiders}`);
  console.log(
    `  初補足まで   ${r.avgFirstCatch === null ? '—' : `${r.avgFirstCatch.toFixed(1)} 秒`}`,
  );
  console.log(`  ロック箱数   ${r.avgLockedBoxes.toFixed(1)}`);
  console.log(`  1 試合あたり ${r.msPerGame.toFixed(0)} ms`);
}

// 他のスクリプトから runMatch を import したときに CLI が走らないようにする。
if (process.argv[1]?.replace(/\\/g, '/').includes('sim/headless')) main();

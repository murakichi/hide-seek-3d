// 変更の採否を判断するための計測ランナー（使い捨て）。
//
// `docs/balance-log.md` の基準どおり、1 構成をシードを変えて 3 回まわして合算する。
// 24 試合や 60 試合の勝率は 3 構成の向きすら当てにならない。
//
//   npx tsx src/sim/_ab.ts 1 1 100    # 1v1 を 100 試合 × 3 シード = 300 試合
//   npx tsx src/sim/_ab.ts 2 2 100
//   npx tsx src/sim/_ab.ts 3 3 60     # 3v3 は重いので 180 試合
//
// 変更前後で同じコマンドを回し、**3 構成が同じ向きに動いたか**で判断する。
// シード別の値も出るので、向きがシードで入れ替わるならまだ試合数が足りない。

import { runSeries } from './headless';

const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const PER = Number(process.argv[4] ?? 100);
const SEEDS = [1234, 555001, 90210];

let wins = 0;
let games = 0;
let survivors = 0;
const parts: string[] = [];
for (const seed of SEEDS) {
  const r = runSeries(PER, HIDERS, SEEKERS, undefined, seed);
  wins += r.hiderWins;
  games += r.games;
  survivors += r.avgSurvivors * r.games;
  parts.push(`${(r.hiderWinRate * 100).toFixed(1)}`);
}
console.log(
  `${HIDERS}v${SEEKERS}  勝率 ${((wins / games) * 100).toFixed(1)}%  (${wins}/${games})  ` +
    `生存/人 ${((survivors / games / HIDERS) * 100).toFixed(1)}%  ` +
    `[シード別 ${parts.join(' / ')}]`,
);

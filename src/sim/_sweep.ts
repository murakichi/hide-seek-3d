// 使い捨て: fleeClimbCost を振って複数シードで勝率を測る。
// master（乗り越えなし）の同条件ベースラインは 1v1 53.3% / 3v3 63.3%。
import { cloneParams, DEFAULT_PARAMS } from '../ai/params';
import { runSeries } from './headless';

const H = Number(process.argv[2] ?? 1);
const S = Number(process.argv[3] ?? 1);
const G = Number(process.argv[4] ?? 40);
const SEEDS = [1234, 555001, 90210];
const VALUES = [0, 20];

console.log(`${H}v${S}  ${G} 試合 x ${SEEDS.length} シード = ${G * SEEDS.length} 試合/値`);
for (const v of VALUES) {
  const p = cloneParams(DEFAULT_PARAMS);
  p.hider.fleeClimbCost = v;
  let wins = 0;
  let games = 0;
  let surv = 0;
  const per: string[] = [];
  for (const seed of SEEDS) {
    const r = runSeries(G, H, S, p, seed);
    wins += r.hiderWins;
    games += r.games;
    surv += r.avgSurvivors * r.games;
    per.push(`${(r.hiderWinRate * 100).toFixed(1)}`);
  }
  console.log(
    `  climbCost=${String(v).padStart(2)}  勝率 ${((wins / games) * 100).toFixed(1)}%  ` +
      `生存/人 ${((surv / games / H) * 100).toFixed(1)}%  シード別 [${per.join(', ')}]`,
  );
}

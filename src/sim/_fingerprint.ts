// リファクタで挙動が変わっていないことを確かめる使い捨てスクリプト。
// 試合ごとの結果を 1 行ずつ出すので、変更前後の出力を diff すれば
// 「集計値は同じだが中身が違う」を見逃さない。
//
//   npx tsx src/sim/_fingerprint.ts > after.txt
//   git stash && npx tsx src/sim/_fingerprint.ts > before.txt && git stash pop
//   diff before.txt after.txt

import { runMatch } from './headless';
import type { MatchConfig } from '../core/types';

const CONFIGS: Array<[number, number]> = [
  [1, 1],
  [2, 2],
  [3, 3],
];
const GAMES = 40;
const SEEDS = [1234, 555001, 90210];

for (const [hiders, seekers] of CONFIGS) {
  for (const seed0 of SEEDS) {
    for (let i = 0; i < GAMES; i++) {
      const config: MatchConfig = {
        hiders,
        seekers,
        playerTeam: null,
        seed: seed0 + i * 7919,
      };
      const r = runMatch(config);
      console.log(
        `${hiders}v${seekers} seed=${config.seed} ` +
          `winner=${r.winner} t=${r.time.toFixed(3)} ` +
          `survivors=${r.survivors} firstCatch=${r.firstCatch?.toFixed(3) ?? '-'} ` +
          `locked=${r.lockedBoxes}`,
      );
    }
  }
}

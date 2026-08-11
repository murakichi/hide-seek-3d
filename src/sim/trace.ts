// 1 試合を詳細ログ付きで再生する。AI の改善では「なぜ負けたか」を見ないと
// パラメータを振るだけの当てずっぽうになるので、その材料を出すためのもの。
//
// 出来事の拾い方と書式は `src/sim/recorder.ts` に置いてある。
// ブラウザの「ログを保存」も同じものを使うので、片方だけ書式が育つことがない。
//
// 使い方:
//   npm run trace -- --hiders 2 --seekers 2 --seed 1234
//   npm run trace -- --seed 1234 --interval 3   # 3 秒ごとのスナップショットも出す
//   npm run trace -- --find-loss --hiders 3 --seekers 3   # 逃げ側が負けた試合を探して再生

import { AiDirector } from '../ai/director';
import { Game } from '../core/game';
import type { MatchConfig } from '../core/types';
import { runMatch } from './headless';
import { MatchRecorder } from './recorder';

interface TraceOptions {
  interval: number;
  quiet: boolean;
}

/** 1 試合を再生し、起きた出来事を標準出力に流す。戻り値は勝者。 */
export function trace(config: MatchConfig, opts: TraceOptions): string {
  const game = new Game(config);
  const ai = new AiDirector(game);
  const s = game.state;

  const rec = new MatchRecorder(game, {
    interval: opts.interval,
    quiet: opts.quiet,
    onLine: (line) => console.log(line),
    hooks: {
      describe: (id) => ai.describe(id),
      shelterOf: (id) => ai.shelterOf(id),
    },
  });

  for (let t = 0; t < 12000 && s.phase !== 'over'; t++) {
    game.step(ai.tick());
    rec.observe();
  }
  rec.finish();
  return s.winner ?? 'none';
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function main(): void {
  const hiders = arg('hiders', 2);
  const seekers = arg('seekers', 2);
  const interval = arg('interval', 0);
  const quiet = process.argv.includes('--quiet');
  let seed = arg('seed', 1234);

  // 負け試合を探して再生する。改善のネタはたいてい負け試合にある。
  if (process.argv.includes('--find-loss') || process.argv.includes('--find-win')) {
    const want = process.argv.includes('--find-win') ? 'hider' : 'seeker';
    for (let i = 0; i < 60; i++) {
      const candidate = seed + i * 7919;
      const r = runMatch({ hiders, seekers, playerTeam: null, seed: candidate });
      if (r.winner === want) {
        seed = candidate;
        console.log(`(${want === 'hider' ? '逃げ側の勝ち' : '逃げ側の負け'}試合 seed=${seed} を再生)\n`);
        break;
      }
    }
  }

  trace({ hiders, seekers, playerTeam: null, seed }, { interval, quiet });
}

main();

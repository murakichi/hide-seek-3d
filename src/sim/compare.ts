// 勝率の前後比較。同じ seed 列で「この作業ツリー」と「比較対象のツリー」を戦わせ、
// 差分を JSON で出す。CI が PR ごとに走らせて、master と比べた変化をコメントする。
//
// 使い方:
//   npx tsx src/sim/compare.ts --games 20 --hiders 2 --seekers 2 --seed 1234 \
//     --base /path/to/master-worktree --out result.json
//
// --base を省くと現在のツリーだけを測る。
//
// 比較対象からは runSeries だけを import する。比較対象は「まだこのファイルが無い
// 時点の master」でもよいので、向こう側の CLI やオプションには依存しない。
// runSeries(games, hiders, seekers, params, seed) のシグネチャだけが前提。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runSeries, type SeriesResult } from './headless';

export interface ComparePayload {
  label: string;
  hiders: number;
  seekers: number;
  seed: number;
  games: number;
  head: SeriesResult;
  base: SeriesResult | null;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function num(name: string, fallback: number): number {
  const v = Number(arg(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

type RunSeries = (
  games: number,
  hiders: number,
  seekers: number,
  params: undefined,
  seed: number,
) => SeriesResult;

async function loadBaseRunSeries(baseDir: string): Promise<RunSeries> {
  const entry = pathToFileURL(join(baseDir, 'src/sim/headless.ts')).href;
  const mod = (await import(entry)) as { runSeries?: unknown };
  if (typeof mod.runSeries !== 'function') {
    throw new Error(`${entry} に runSeries が無い。比較対象のツリーが古すぎる。`);
  }
  return mod.runSeries as RunSeries;
}

async function main(): Promise<void> {
  const games = num('games', 20);
  const hiders = num('hiders', 2);
  const seekers = num('seekers', 2);
  const seed = num('seed', 1234);
  const baseDir = arg('base', '');
  const out = arg('out', '');
  const label = arg('label', `${hiders}v${seekers}`);

  const head = runSeries(games, hiders, seekers, undefined, seed);

  let base: SeriesResult | null = null;
  if (baseDir) {
    const baseRunSeries = await loadBaseRunSeries(baseDir);
    base = baseRunSeries(games, hiders, seekers, undefined, seed);
  }

  const payload: ComparePayload = { label, hiders, seekers, seed, games, head, base };
  const json = JSON.stringify(payload);

  if (out) writeFileSync(out, json, 'utf8');
  // 人が CI ログを見たときのための 1 行。集計は JSON 側を使う。
  const pct = (r: SeriesResult): string => `${(r.hiderWinRate * 100).toFixed(1)}%`;
  console.error(
    `${label} seed=${seed} ${games} 試合: 逃げ側 ${pct(head)}` +
      (base ? ` (base ${pct(base)})` : ''),
  );
  console.log(json);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

// compare.ts が吐いた JSON を集めて、PR コメント用の Markdown にする。
//
// 使い方: npx tsx src/sim/report.ts results/ > report.md
//
// 同じ構成の複数 seed をまとめて 1 行にする。base と head は同じ seed 列で
// 戦っているので、絶対値より「差分」の方が信頼できる。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ComparePayload } from './compare';

const MARKER = '<!-- winrate-report -->';

interface Agg {
  label: string;
  hiders: number;
  seekers: number;
  seeds: number[];
  games: number;
  headWins: number;
  baseWins: number | null;
  headSurvivors: number;
  headCatch: number;
  headCatchGames: number;
}

function collect(dir: string): ComparePayload[] {
  const out: ComparePayload[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...collect(p));
      continue;
    }
    if (!name.endsWith('.json')) continue;
    out.push(JSON.parse(readFileSync(p, 'utf8')) as ComparePayload);
  }
  return out;
}

function aggregate(payloads: ComparePayload[]): Agg[] {
  const byLabel = new Map<string, Agg>();
  for (const p of payloads) {
    let a = byLabel.get(p.label);
    if (!a) {
      a = {
        label: p.label,
        hiders: p.hiders,
        seekers: p.seekers,
        seeds: [],
        games: 0,
        headWins: 0,
        baseWins: p.base ? 0 : null,
        headSurvivors: 0,
        headCatch: 0,
        headCatchGames: 0,
      };
      byLabel.set(p.label, a);
    }
    a.seeds.push(p.seed);
    a.games += p.head.games;
    a.headWins += p.head.hiderWins;
    if (p.base && a.baseWins !== null) a.baseWins += p.base.hiderWins;
    a.headSurvivors += p.head.avgSurvivors * p.head.games;
    if (p.head.avgFirstCatch !== null) {
      a.headCatch += p.head.avgFirstCatch * p.head.games;
      a.headCatchGames += p.head.games;
    }
  }
  return [...byLabel.values()].sort((x, y) => x.hiders - y.hiders);
}

/** 二項分布の 95% 信頼区間の半幅（ポイント）。 */
function ci95(wins: number, games: number): number {
  if (games === 0) return 0;
  const p = wins / games;
  return 196 * Math.sqrt((p * (1 - p)) / games);
}

function pct(wins: number, games: number): string {
  return `${((wins / games) * 100).toFixed(1)}%`;
}

function signed(v: number): string {
  const s = v >= 0 ? '+' : '−';
  return `${s}${Math.abs(v).toFixed(1)}`;
}

function main(): void {
  const dir = process.argv[2] ?? 'results';
  const payloads = collect(dir);
  if (payloads.length === 0) {
    console.log(`${MARKER}\n\n## 勝率\n\n測定結果が見つからなかった。`);
    return;
  }

  const aggs = aggregate(payloads);
  const lines: string[] = [];
  lines.push(MARKER);
  lines.push('');
  lines.push('## 勝率（逃げる側）');
  lines.push('');
  lines.push('| 構成 | master | この PR | 差分 | 平均生存 | 初補足 | 試合数 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');

  for (const a of aggs) {
    const head = pct(a.headWins, a.games);
    const base = a.baseWins === null ? '—' : pct(a.baseWins, a.games);
    const delta =
      a.baseWins === null
        ? '—'
        : signed(((a.headWins - a.baseWins) / a.games) * 100) + ' pt';
    const survivors = (a.headSurvivors / a.games).toFixed(2);
    const catchAt =
      a.headCatchGames === 0 ? '—' : `${(a.headCatch / a.headCatchGames).toFixed(1)} 秒`;
    lines.push(
      `| ${a.label} | ${base} | **${head}** | ${delta} | ${survivors} / ${a.hiders} | ${catchAt} | ${a.games} |`,
    );
  }

  const total = payloads.reduce((s, p) => s + p.head.games + (p.base?.games ?? 0), 0);
  const halfWidth = Math.max(...aggs.map((a) => ci95(a.headWins, a.games)));
  lines.push('');
  lines.push(
    `<sub>seed ${[...new Set(payloads.map((p) => p.seed))].join(', ')} を合算。` +
      `master とこの PR は同じ seed 列で戦っているので、絶対値（±${halfWidth.toFixed(0)} pt 程度ぶれる）より差分の方が読める。` +
      `合計 ${total} 試合。</sub>`,
  );
  lines.push('');
  lines.push('<details><summary>seed ごとの内訳</summary>');
  lines.push('');
  lines.push('| 構成 | seed | master | この PR | 試合数 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const p of [...payloads].sort(
    (x, y) => x.hiders - y.hiders || x.seed - y.seed,
  )) {
    const base = p.base ? pct(p.base.hiderWins, p.base.games) : '—';
    lines.push(
      `| ${p.label} | ${p.seed} | ${base} | ${pct(p.head.hiderWins, p.head.games)} | ${p.head.games} |`,
    );
  }
  lines.push('');
  lines.push('</details>');

  console.log(lines.join('\n'));
}

main();

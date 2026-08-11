// 1 試合を詳細ログ付きで再生する。AI の改善では「なぜ負けたか」を見ないと
// パラメータを振るだけの当てずっぽうになるので、その材料を出すためのもの。
//
// 使い方:
//   npm run trace -- --hiders 2 --seekers 2 --seed 1234
//   npm run trace -- --seed 1234 --interval 3   # 3 秒ごとのスナップショットも出す
//   npm run trace -- --find-loss --hiders 3 --seekers 3   # 逃げ側が負けた試合を探して再生

import { AiDirector } from '../ai/director';
import { Game } from '../core/game';
import type { Agent, MatchConfig } from '../core/types';
import { runMatch } from './headless';

function fmt(a: Agent): string {
  return `(${a.x.toFixed(1)},${a.z.toFixed(1)})`;
}

function tag(a: Agent): string {
  return `${a.team === 'hider' ? '逃' : '鬼'}#${a.id}`;
}

interface TraceOptions {
  interval: number;
  quiet: boolean;
}

/** 1 試合を再生し、起きた出来事を標準出力に流す。戻り値は勝者。 */
export function trace(config: MatchConfig, opts: TraceOptions): string {
  const game = new Game(config);
  const ai = new AiDirector(game);
  const s = game.state;

  console.log(`seed=${config.seed}  ${config.hiders}v${config.seekers}`);
  for (const a of s.agents) {
    if (a.team !== 'hider') continue;
    const home = ai.shelterOf(a.id);
    console.log(
      `  ${tag(a)} 開始${fmt(a)}` +
        (home ? ` 拠点(${home.x.toFixed(1)},${home.z.toFixed(1)})` : ''),
    );
  }
  console.log(`  補給パック ${s.pickups.length} 個 / 箱 ${s.obstacles.filter((o) => o.kind === 'box').length} 個`);

  // 前ティックの状態。差分から出来事を拾う。
  let prevPhase = s.phase;
  const prevCaught = new Set<number>();
  const prevLocked = new Map<number, string | null>();
  const prevSeen = new Set<number>();
  let nextSnapshot = 0;

  for (const o of s.obstacles) prevLocked.set(o.id, o.lockedBy);

  for (let t = 0; t < 12000 && s.phase !== 'over'; t++) {
    game.step(ai.tick());
    const now = s.time.toFixed(1).padStart(5);

    if (prevPhase !== s.phase) {
      if (s.phase === 'hunt') {
        const locked = s.obstacles.filter((o) => o.lockedBy === 'hider').length;
        console.log(`[追跡開始] t=${now}  ロックされた箱 ${locked} 個`);
        for (const a of s.agents) {
          if (a.team === 'hider') console.log(`    ${tag(a)} は ${fmt(a)} に潜伏`);
        }
      }
      prevPhase = s.phase;
    }

    // 発見と見失い
    for (const a of s.agents) {
      if (a.team !== 'hider' || a.caught) continue;
      const seen = game.visible.seeker.has(a.id);
      if (seen && !prevSeen.has(a.id)) {
        prevSeen.add(a.id);
        const by = s.agents
          .filter((k) => k.team === 'seeker')
          .reduce((best, k) =>
            Math.hypot(k.x - a.x, k.z - a.z) < Math.hypot(best.x - a.x, best.z - a.z) ? k : best,
          );
        console.log(
          `  発見 t=${now}  ${tag(by)} が ${tag(a)} を ${fmt(a)} で捕捉 ` +
            `(距離 ${Math.hypot(by.x - a.x, by.z - a.z).toFixed(1)})`,
        );
      } else if (!seen && prevSeen.has(a.id)) {
        prevSeen.delete(a.id);
        console.log(`  見失い t=${now}  ${tag(a)} が視界から消えた ${fmt(a)}`);
      }
    }

    // 捕獲
    for (const a of s.agents) {
      if (a.team !== 'hider' || !a.caught || prevCaught.has(a.id)) continue;
      prevCaught.add(a.id);
      const left = game.aliveHiders().length;
      console.log(`  捕獲 t=${now}  ${tag(a)} が ${fmt(a)} で捕まった  残り ${left} 人`);
    }

    // ロックの変化
    if (!opts.quiet) {
      for (const o of s.obstacles) {
        const before = prevLocked.get(o.id) ?? null;
        if (before === o.lockedBy) continue;
        prevLocked.set(o.id, o.lockedBy);
        const where = `(${o.x.toFixed(1)},${o.z.toFixed(1)})`;
        console.log(
          o.lockedBy === null
            ? `  解錠 t=${now}  箱#${o.id} ${where} のロックが外された`
            : `  ロック t=${now}  箱#${o.id} ${where} を ${o.lockedBy === 'hider' ? '逃げる側' : '鬼'} が固定`,
        );
      }
    }

    // 定期スナップショット
    if (opts.interval > 0 && s.time >= nextSnapshot) {
      nextSnapshot += opts.interval;
      const line = s.agents
        .filter((a) => !a.caught)
        .map((a) => `${tag(a)}${fmt(a)}${a.y > 0.3 ? `↑${a.y.toFixed(1)}` : ''} ${ai.describe(a.id)}`)
        .join('  |  ');
      console.log(`  [t=${now} ${s.phase}] ${line}`);
      // 味方同士の申し合わせ。集計値では「味方が譲り合って両方止まった」
      // 「同じ相手に全員が群がった」のような事故が見えない。
      if (s.phase !== 'prep') {
        console.log(`      鬼   ${ai.describeCoop('seeker')}`);
      }
      console.log(`      逃   ${ai.describeCoop('hider')}`);
    }
  }

  console.log(
    `[決着] ${s.winner === 'hider' ? '逃げる側の勝ち' : '鬼の勝ち'} — ${s.endReason} (t=${s.time.toFixed(1)})`,
  );
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

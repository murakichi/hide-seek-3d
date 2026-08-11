// 試合の出来事を 1 行ずつのログにする記録器。
//
// `npm run trace`（ターミナル）と、ブラウザの「ログを保存」ボタンの両方がこれを使う。
// 出力先を持たないので、片方だけ書式が育って食い違うことがない。
//
// **DOM にも Node にも依存しない。** ブラウザからも import されるので、
// `process` や `console` をここで直接触らないこと（行は呼び出し側が受け取る）。

import type { Game } from '../core/game';
import type { Agent } from '../core/types';

export interface RecorderHooks {
  /** AI の思考状態。無ければスナップショットに内部状態が出ないだけ */
  describe?(agentId: number): string;
  /** 逃げる側に割り当てた拠点 */
  shelterOf?(agentId: number): { x: number; z: number } | null;
  /**
   * 味方同士の申し合わせ（予約と意図）。
   * 集計値では「味方が譲り合って両方止まった」「同じ相手に全員が群がった」のような
   * 事故が見えないので、スナップショットに並べる。
   */
  describeCoop?(team: 'seeker' | 'hider'): string;
}

export interface RecorderOptions {
  /** 定期スナップショットの間隔（秒）。0 なら出さない */
  interval?: number;
  /** ロックの増減など細かい出来事を省く */
  quiet?: boolean;
  /** 行が増えるたびに呼ばれる。ターミナルへ流したいときに使う */
  onLine?: (line: string) => void;
  hooks?: RecorderHooks;
}

function fmt(a: Agent): string {
  return `(${a.x.toFixed(1)},${a.z.toFixed(1)})`;
}

function tag(a: Agent): string {
  return `${a.team === 'hider' ? '逃' : '鬼'}#${a.id}`;
}

/**
 * 試合を観測してログ行を組み立てる。
 *
 * 使い方は「作る → 毎ティック `observe()` → 決着後に `finish()`」。
 * `observe()` は `game.step()` の**直後**に呼ぶこと。差分から出来事を拾うので、
 * 呼び忘れたティックの出来事は落ちる。
 */
export class MatchRecorder {
  private out: string[] = [];
  private prevPhase: string;
  private prevCaught = new Set<number>();
  private prevLocked = new Map<number, string | null>();
  private prevSeen = new Set<number>();
  private nextSnapshot = 0;
  private finished = false;

  constructor(
    private game: Game,
    private opts: RecorderOptions = {},
  ) {
    const s = game.state;
    this.prevPhase = s.phase;
    for (const o of s.obstacles) this.prevLocked.set(o.id, o.lockedBy);
    this.writeHeader();
  }

  /** 組み上がった行。 */
  get lines(): readonly string[] {
    return this.out;
  }

  toText(): string {
    return this.out.join('\n') + '\n';
  }

  private push(line: string): void {
    this.out.push(line);
    this.opts.onLine?.(line);
  }

  private writeHeader(): void {
    const s = this.game.state;
    const c = s.config;
    this.push(`seed=${c.seed}  ${c.hiders}v${c.seekers}`);
    for (const a of s.agents) {
      if (a.team !== 'hider') continue;
      const home = this.opts.hooks?.shelterOf?.(a.id) ?? null;
      this.push(
        `  ${tag(a)} 開始${fmt(a)}` +
          (home ? ` 拠点(${home.x.toFixed(1)},${home.z.toFixed(1)})` : ''),
      );
    }
    this.push(
      `  補給パック ${s.pickups.length} 個 / 箱 ${s.obstacles.filter((o) => o.kind === 'box').length} 個`,
    );
  }

  /** `game.step()` の直後に毎ティック呼ぶ。 */
  observe(): void {
    const game = this.game;
    const s = game.state;
    const opts = this.opts;
    const now = s.time.toFixed(1).padStart(5);

    if (this.prevPhase !== s.phase) {
      if (s.phase === 'hunt') {
        const locked = s.obstacles.filter((o) => o.lockedBy === 'hider').length;
        this.push(`[追跡開始] t=${now}  ロックされた箱 ${locked} 個`);
        for (const a of s.agents) {
          if (a.team === 'hider') this.push(`    ${tag(a)} は ${fmt(a)} に潜伏`);
        }
      }
      this.prevPhase = s.phase;
    }

    // 発見と見失い
    for (const a of s.agents) {
      if (a.team !== 'hider' || a.caught) continue;
      const seen = game.visible.seeker.has(a.id);
      if (seen && !this.prevSeen.has(a.id)) {
        this.prevSeen.add(a.id);
        const by = s.agents
          .filter((k) => k.team === 'seeker')
          .reduce((best, k) =>
            Math.hypot(k.x - a.x, k.z - a.z) < Math.hypot(best.x - a.x, best.z - a.z) ? k : best,
          );
        this.push(
          `  発見 t=${now}  ${tag(by)} が ${tag(a)} を ${fmt(a)} で捕捉 ` +
            `(距離 ${Math.hypot(by.x - a.x, by.z - a.z).toFixed(1)})`,
        );
      } else if (!seen && this.prevSeen.has(a.id)) {
        this.prevSeen.delete(a.id);
        this.push(`  見失い t=${now}  ${tag(a)} が視界から消えた ${fmt(a)}`);
      }
    }

    // 捕獲
    for (const a of s.agents) {
      if (a.team !== 'hider' || !a.caught || this.prevCaught.has(a.id)) continue;
      this.prevCaught.add(a.id);
      const left = game.aliveHiders().length;
      this.push(`  捕獲 t=${now}  ${tag(a)} が ${fmt(a)} で捕まった  残り ${left} 人`);
    }

    // ロックの変化
    if (!opts.quiet) {
      for (const o of s.obstacles) {
        const before = this.prevLocked.get(o.id) ?? null;
        if (before === o.lockedBy) continue;
        this.prevLocked.set(o.id, o.lockedBy);
        const where = `(${o.x.toFixed(1)},${o.z.toFixed(1)})`;
        this.push(
          o.lockedBy === null
            ? `  解錠 t=${now}  箱#${o.id} ${where} のロックが外された`
            : `  ロック t=${now}  箱#${o.id} ${where} を ${o.lockedBy === 'hider' ? '逃げる側' : '鬼'} が固定`,
        );
      }
    }

    // 定期スナップショット
    const interval = opts.interval ?? 0;
    if (interval > 0 && s.time >= this.nextSnapshot) {
      this.nextSnapshot += interval;
      const line = s.agents
        .filter((a) => !a.caught)
        .map((a) => {
          const think = this.opts.hooks?.describe?.(a.id);
          return (
            `${tag(a)}${fmt(a)}${a.y > 0.3 ? `↑${a.y.toFixed(1)}` : ''}` +
            (think ? ` ${think}` : '')
          );
        })
        .join('  |  ');
      this.push(`  [t=${now} ${s.phase}] ${line}`);
      const coop = this.opts.hooks?.describeCoop;
      if (coop) {
        // 準備フェーズの鬼は檻の中なので申し合わせるものが無い。
        if (s.phase !== 'prep') this.push(`      鬼   ${coop('seeker')}`);
        this.push(`      逃   ${coop('hider')}`);
      }
    }
  }

  /** 決着後に 1 度だけ呼ぶ。締めの行を足す。 */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const s = this.game.state;
    this.push(
      `[決着] ${s.winner === 'hider' ? '逃げる側の勝ち' : '鬼の勝ち'} — ${s.endReason} (t=${s.time.toFixed(1)})`,
    );
  }
}

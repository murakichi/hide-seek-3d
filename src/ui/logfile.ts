// 画面で見ている試合のログをファイルに落とす。
//
// ログの中身と書式は `src/sim/recorder.ts`（ターミナルの `npm run trace` と共通）。
// ここはブラウザ固有のこと — 見出しの付与とダウンロード — だけを持つ。

import type { Game } from '../core/game';
import type { MatchRecorder } from '../sim/recorder';

/**
 * ログの先頭に付ける見出し。
 *
 * **シードを必ず載せる。** これがあれば、画面で「今の試合おかしかった」と思ったものを
 * そのままヘッドレスで再現できる（同じシード + 同じ AI = 同じ試合）。
 * 再現コマンドもそのまま貼れる形で書いておく。
 */
function header(game: Game, savedAt: Date): string {
  const c = game.state.config;
  const side =
    c.playerTeam === null ? '観戦' : c.playerTeam === 'hider' ? '逃げる側を操作' : '鬼を操作';
  const repro = `npm run trace -- --hiders ${c.hiders} --seekers ${c.seekers} --seed ${c.seed} --interval 3`;
  return [
    `# HIDE & SEEK 3D 対戦ログ`,
    `# 保存日時   ${savedAt.toISOString()}`,
    `# 構成       ${c.hiders}v${c.seekers}（${side}）`,
    `# シード     ${c.seed}`,
    `# 再現       ${repro}`,
    '',
    '# 人間が操作した試合は入力が記録されないので、上のコマンドで再現できるのは',
    '# 観戦（全員 AI）のときだけ。操作した試合のログは記録そのものが手がかりになる。',
    '',
  ].join('\n');
}

/** ファイル名。同じ試合を何度保存しても見分けが付くように時刻を入れる。 */
function fileName(game: Game, savedAt: Date): string {
  const c = game.state.config;
  const stamp = savedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `hide-seek_${c.hiders}v${c.seekers}_seed${c.seed}_${stamp}.txt`;
}

/**
 * ログをテキストファイルとして保存する。
 * ブラウザのダウンロードとして落ちるので、保存先はユーザーの設定に従う。
 */
export function downloadMatchLog(game: Game, recorder: MatchRecorder): void {
  const savedAt = new Date();
  const text = header(game, savedAt) + recorder.toText();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(game, savedAt);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 解放を次のタスクへ回す。即座に revoke するとダウンロードが始まらないことがある。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

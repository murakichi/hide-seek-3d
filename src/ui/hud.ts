// 試合中のオーバーレイ表示。

import { STAMINA_MAX } from '../core/config';
import type { Game } from '../core/game';

const SPEEDS = [1, 2, 4, 8];

export class Hud {
  private el: HTMLDivElement;
  private phaseEl: HTMLDivElement;
  private timerEl: HTMLDivElement;
  private rosterEl: HTMLDivElement;
  private staminaEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private resultEl: HTMLDivElement;
  private speedEl: HTMLDivElement;
  private toolsEl: HTMLDivElement;
  private speed = 1;

  constructor(
    root: HTMLElement,
    private onRestart: () => void,
    private onMenu: () => void,
    private onSpeed: (multiplier: number) => void,
    /** 対戦ログをファイルに保存する。渡されなければボタンを出さない */
    private onSaveLog?: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-top">
        <div class="phase"></div>
        <div class="timer"></div>
      </div>
      <div class="roster"></div>
      <div class="speed"></div>
      <div class="tools"></div>
      <div class="hud-bottom">
        <div class="stamina"><i></i></div>
        <div class="hint"></div>
      </div>
      <div class="result"></div>`;
    root.appendChild(this.el);

    this.phaseEl = this.el.querySelector('.phase')!;
    this.timerEl = this.el.querySelector('.timer')!;
    this.rosterEl = this.el.querySelector('.roster')!;
    this.staminaEl = this.el.querySelector('.stamina i')!;
    this.hintEl = this.el.querySelector('.hint')!;
    this.resultEl = this.el.querySelector('.result')!;
    this.speedEl = this.el.querySelector('.speed')!;
    this.toolsEl = this.el.querySelector('.tools')!;
    this.buildSpeedControls();
    this.buildTools();
  }

  /**
   * 試合中でも押せるログ保存。決着まで待たせない。
   * 「今の場面がおかしかった」と思った瞬間に押せることに意味がある
   * （そこまでの出来事が全部入る）。
   */
  private buildTools(): void {
    if (!this.onSaveLog) return;
    this.toolsEl.innerHTML = '<button class="savelog" title="ここまでの対戦ログをファイルに保存">ログを保存</button>';
    this.toolsEl.querySelector<HTMLButtonElement>('.savelog')!.onclick = () => this.onSaveLog!();
  }

  /** 観戦時の再生速度切り替え。AI 同士の試合を眺めるときは待ち時間が長い。 */
  private buildSpeedControls(): void {
    this.speedEl.innerHTML = SPEEDS.map(
      (m) => `<button data-m="${m}" class="${m === this.speed ? 'on' : ''}">${m}x</button>`,
    ).join('');
    this.speedEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => this.setSpeed(Number(b.dataset.m));
    });
  }

  setSpeed(multiplier: number): void {
    if (!SPEEDS.includes(multiplier)) return;
    this.speed = multiplier;
    this.speedEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.m) === multiplier);
    });
    this.onSpeed(multiplier);
  }

  /** キー 1〜4 でも切り替えられるようにする。 */
  cycleSpeedByKey(code: string): boolean {
    const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(code);
    if (i < 0) return false;
    this.setSpeed(SPEEDS[i]);
    return true;
  }

  show(): void {
    this.el.style.display = 'block';
  }

  hide(): void {
    this.el.style.display = 'none';
    this.resultEl.innerHTML = '';
    this.resultEl.classList.remove('on');
  }

  update(game: Game): void {
    const s = game.state;
    const player = game.playerAgent;

    // 早送りは観戦専用。自分が動かしている間に使えるとゲームが成立しないが、
    // 捕まって見ているだけになったら決着まで飛ばせた方がよい。
    const spectating = s.config.playerTeam === null || (player?.caught ?? false);
    this.speedEl.style.display = spectating ? 'flex' : 'none';

    const phaseLabel =
      s.phase === 'prep' ? '準備フェーズ' : s.phase === 'hunt' ? '追跡フェーズ' : '試合終了';
    this.phaseEl.textContent = phaseLabel;
    this.phaseEl.className = `phase ${s.phase}`;
    this.timerEl.textContent = s.phase === 'over' ? '' : formatTime(Math.max(0, s.phaseTime));

    const alive = game.aliveHiders().length;
    this.rosterEl.innerHTML = `
      <div class="team hider"><span class="dot"></span>逃げる側 <b>${alive}</b> / ${s.config.hiders}</div>
      <div class="team seeker"><span class="dot"></span>鬼 <b>${s.config.seekers}</b></div>`;

    if (player && !player.caught) {
      this.staminaEl.style.width = `${(player.stamina / STAMINA_MAX) * 100}%`;
      this.staminaEl.parentElement!.style.visibility = 'visible';
      this.staminaEl.classList.toggle('boost', s.time < player.boostUntil);
      const smoke =
        player.team === 'hider'
          ? `　<kbd>Q</kbd> 煙幕 <b>${player.smokeCharges}</b>`
          : '';
      this.hintEl.innerHTML =
        s.phase === 'prep' && player.team === 'hider'
          ? '<kbd>E</kbd> 箱をつかんで運ぶ　<kbd>F</kbd> ロックして固定'
          : player.team === 'seeker'
            ? '<kbd>F</kbd> ロックを解除　<kbd>E</kbd> 箱をどける'
            : `<kbd>Shift</kbd> ダッシュ　<kbd>Space</kbd> ジャンプ${smoke}`;
    } else {
      this.staminaEl.parentElement!.style.visibility = 'hidden';
      this.hintEl.textContent = player?.caught ? '捕まった — 観戦中' : '';
    }

    if (s.phase === 'over') {
      this.showResult(game);
    }
  }

  private showResult(game: Game): void {
    if (this.resultEl.classList.contains('on')) return;
    const s = game.state;
    const player = game.playerAgent;
    const win = player ? s.winner === player.team : null;
    const title = s.winner === 'hider' ? '逃げる側の勝ち' : '鬼の勝ち';
    const verdict = win === null ? '' : win ? '<div class="win">WIN</div>' : '<div class="lose">LOSE</div>';

    this.resultEl.innerHTML = `
      <div class="result-card">
        ${verdict}
        <h2>${title}</h2>
        <p>${s.endReason}</p>
        <div class="stats">経過 ${formatTime(s.time)}</div>
        <div class="result-buttons">
          <button class="again">もう一度</button>
          <button class="tomenu">設定を変える</button>
          ${this.onSaveLog ? '<button class="savelog">ログを保存</button>' : ''}
        </div>
      </div>`;
    this.resultEl.classList.add('on');
    if (this.onSaveLog) {
      // 保存しても結果画面は閉じない。何度でも押せる。
      this.resultEl.querySelector<HTMLButtonElement>('.savelog')!.onclick = () => this.onSaveLog!();
    }
    this.resultEl.querySelector<HTMLButtonElement>('.again')!.onclick = () => {
      this.resultEl.classList.remove('on');
      this.resultEl.innerHTML = '';
      this.onRestart();
    };
    this.resultEl.querySelector<HTMLButtonElement>('.tomenu')!.onclick = () => {
      this.resultEl.classList.remove('on');
      this.resultEl.innerHTML = '';
      this.onMenu();
    };
  }
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

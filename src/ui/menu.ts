// タイトル / 試合設定画面。

import type { MatchConfig, Team } from '../core/types';

export interface MenuResult {
  hiders: number;
  seekers: number;
  playerTeam: Team | null;
}

const PRESETS: Array<{ label: string; hiders: number; seekers: number }> = [
  { label: '1 on 1', hiders: 1, seekers: 1 },
  { label: '2 on 2', hiders: 2, seekers: 2 },
  { label: '3 on 3', hiders: 3, seekers: 3 },
];

const SIDES: Array<{ label: string; sub: string; value: Team | null }> = [
  { label: '逃げる', sub: '準備して隠れ、逃げ切る', value: 'hider' },
  { label: '鬼', sub: '探し出して捕まえる', value: 'seeker' },
  { label: '観戦', sub: 'AI 同士の対戦を眺める', value: null },
];

export class Menu {
  private el: HTMLDivElement;
  private preset = 1;
  private side: Team | null = 'hider';

  constructor(
    private root: HTMLElement,
    private onStart: (r: MenuResult) => void,
    /** サンドボックス（自分で盤面を組むモード）へ。渡さなければボタンを出さない */
    private onSandbox?: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'menu';
    root.appendChild(this.el);
    this.render();
  }

  private render(): void {
    this.el.innerHTML = `
      <div class="menu-card">
        <h1>HIDE &amp; SEEK <span>3D</span></h1>
        <p class="tagline">準備して、隠れて、逃げ切れ。</p>

        <div class="section">
          <div class="section-title">人数</div>
          <div class="options" data-group="preset">
            ${PRESETS.map(
              (p, i) =>
                `<button class="opt ${i === this.preset ? 'on' : ''}" data-i="${i}">${p.label}</button>`,
            ).join('')}
          </div>
        </div>

        <div class="section">
          <div class="section-title">あなたの陣営</div>
          <div class="options wide" data-group="side">
            ${SIDES.map(
              (s, i) =>
                `<button class="opt ${s.value === this.side ? 'on' : ''}" data-i="${i}">
                   <strong>${s.label}</strong><small>${s.sub}</small>
                 </button>`,
            ).join('')}
          </div>
        </div>

        <button class="start">試合開始</button>
        ${this.onSandbox ? '<button class="sandbox-enter">サンドボックス — 自分で盤面を組む</button>' : ''}

        <div class="controls">
          <div><kbd>WASD</kbd> 移動 <kbd>Shift</kbd> ダッシュ <kbd>Space</kbd> ジャンプ</div>
          <div><kbd>E</kbd>/左クリック 箱をつかむ <kbd>F</kbd>/右クリック ロック・解除 <kbd>マウス</kbd> 視線</div>
          <div><kbd>ホイール</kbd> ズーム <kbd>C</kbd> 俯瞰・追従 <kbd>中ドラッグ</kbd> 視点移動</div>
        </div>
      </div>`;

    this.el.querySelectorAll<HTMLButtonElement>('[data-group="preset"] .opt').forEach((b) => {
      b.onclick = () => {
        this.preset = Number(b.dataset.i);
        this.render();
      };
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-group="side"] .opt').forEach((b) => {
      b.onclick = () => {
        this.side = SIDES[Number(b.dataset.i)].value;
        this.render();
      };
    });
    this.el.querySelector<HTMLButtonElement>('.start')!.onclick = () => {
      const p = PRESETS[this.preset];
      this.hide();
      this.onStart({ hiders: p.hiders, seekers: p.seekers, playerTeam: this.side });
    };
    const sandboxBtn = this.el.querySelector<HTMLButtonElement>('.sandbox-enter');
    if (sandboxBtn && this.onSandbox) {
      sandboxBtn.onclick = () => {
        this.hide();
        this.onSandbox!();
      };
    }
  }

  show(): void {
    this.el.style.display = 'flex';
    this.render();
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  static toConfig(r: MenuResult, seed: number): MatchConfig {
    return { hiders: r.hiders, seekers: r.seekers, playerTeam: r.playerTeam, seed };
  }

  dispose(): void {
    this.root.removeChild(this.el);
  }
}

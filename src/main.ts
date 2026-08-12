// エントリポイント。固定タイムステップでゲームを進め、描画と UI を同期する。

import { AiDirector } from './ai/director';
import { DT } from './core/config';
import { Game } from './core/game';
import type { Action, MatchConfig } from './core/types';
import { InputManager } from './input';
import { Renderer } from './render/renderer';
import { GameView } from './render/view';
import { MatchRecorder } from './sim/recorder';
import { Hud } from './ui/hud';
import { downloadMatchLog } from './ui/logfile';
import { Menu, type MenuResult } from './ui/menu';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLDivElement;

const renderer = new Renderer(canvas);
const input = new InputManager(canvas);

let game: Game | null = null;
let ai: AiDirector | null = null;
let view: GameView | null = null;
let recorder: MatchRecorder | null = null;
let lastSetup: MenuResult | null = null;

let speed = 1;
const hud = new Hud(
  uiRoot,
  () => start(lastSetup!),
  () => toMenu(),
  (m) => {
    speed = m;
  },
  () => {
    if (game && recorder) downloadMatchLog(game, recorder);
  },
  {
    mode: () => hud.setCameraMode(renderer.toggleCameraMode()),
    zoom: (steps) => renderer.zoomBy(steps),
  },
);
hud.hide();
hud.setCameraMode(renderer.cameraMode);

/** 自分で操作していない試合か。観戦を選んだ場合と、捕まって観戦に回った場合。 */
function isSpectating(g: Game): boolean {
  if (g.state.config.playerTeam === null) return true;
  return g.playerAgent?.caught ?? false;
}

// 観戦中はキー 1〜4 でも早送りできる。C でカメラ、Z / X でズーム。
window.addEventListener('keydown', (e) => {
  if (game && isSpectating(game)) hud.cycleSpeedByKey(e.code);
  if (e.code === 'KeyC') hud.setCameraMode(renderer.toggleCameraMode());
  if (e.code === 'KeyZ') renderer.zoomBy(1);
  if (e.code === 'KeyX') renderer.zoomBy(-1);
});

/**
 * 追従カメラが追う相手。自分が生きていれば自分。
 * 観戦中と捕まったあとは、残っている逃走者（居なければ鬼の 1 人）を追う。
 */
function followTarget(g: Game): { x: number; z: number } | null {
  const player = g.playerAgent;
  if (player && !player.caught) return { x: player.x, z: player.z };
  const hider = g.aliveHiders()[0];
  if (hider) return { x: hider.x, z: hider.z };
  const seeker = g.state.agents.find((a) => a.team === 'seeker');
  return seeker ? { x: seeker.x, z: seeker.z } : null;
}

const menu = new Menu(uiRoot, (r) => start(r));

function toMenu(): void {
  hud.hide();
  menu.show();
}

function start(setup: MenuResult): void {
  lastSetup = setup;
  const config: MatchConfig = Menu.toConfig(setup, (Math.random() * 0xffffff) | 0);
  game = new Game(config);
  ai = new AiDirector(game);
  // 記録はいつでも保存できるよう、最初から回しておく。
  // スナップショットは 3 秒ごと（trace の既定と同じ）。
  recorder = new MatchRecorder(game, {
    interval: 3,
    hooks: {
      describe: (id) => ai!.describe(id),
      shelterOf: (id) => ai!.shelterOf(id),
      describeCoop: (team) => ai!.describeCoop(team),
    },
  });
  if (view) view.build(game);
  else view = new GameView(renderer, game);
  hud.show();
}

let accumulator = 0;
let lastTime = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);

  const elapsed = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  if (game && ai && view) {
    // 早送りは「同じ固定ステップを 1 フレームで多く回す」ことで実現する。
    // dt を伸ばすとシミュレーションの結果自体が変わってしまう。
    const rate = isSpectating(game) ? speed : 1;
    accumulator += elapsed * rate;
    let steps = 0;
    const maxSteps = 5 * rate;
    while (accumulator >= DT && steps < maxSteps) {
      accumulator -= DT;
      steps++;
      const actions: Map<number, Action> = ai.tick();
      const player = game.playerAgent;
      if (player && !player.caught) {
        actions.set(player.id, input.buildAction(renderer.camera, player.x, player.z));
      }
      game.step(actions);
      // step の直後に観測する。差分から出来事を拾うので、飛ばすとその分が落ちる。
      recorder?.observe();
      if (game.state.phase === 'over') recorder?.finish();
    }
    view.sync(game, game.state.config.playerTeam);
    hud.update(game);
    renderer.updateCamera(elapsed, followTarget(game));
  } else {
    renderer.updateCamera(elapsed, null);
  }

  renderer.render();
}

requestAnimationFrame(frame);

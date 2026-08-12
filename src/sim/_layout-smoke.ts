// layout 指定の Game が最後まで回るかの疎通確認（サンドボックス用の一時スクリプト）。

import { AiDirector } from '../ai/director';
import { borderWalls, makeObstacle } from '../core/arena';
import { Game } from '../core/game';
import type { ArenaLayout } from '../core/types';

const layout: ArenaLayout = {
  obstacles: [
    ...borderWalls(),
    makeObstacle('box', 5, 5, 1.3, 1.3, 2.2),
    makeObstacle('box', -6, 3, 0.8, 0.8, 1.3),
    makeObstacle('wall', 0, -8, 0.5, 3, 2.6),
    makeObstacle('ramp', 8, -4, 2.6, 1.3, 1.6, 0),
    makeObstacle('pad', -10, -10, 1, 1, 0.25),
  ],
  agents: [
    { team: 'hider', x: 12, z: 12, isPlayer: false },
    { team: 'hider', x: -14, z: 6, isPlayer: false },
    { team: 'seeker', x: 0, z: 0, isPlayer: false },
    { team: 'seeker', x: 18, z: 18, isPlayer: false },
  ],
  pickups: [{ x: 3, z: -12 }],
};

for (const skipPrep of [true, false]) {
  const game = new Game({ hiders: 2, seekers: 2, playerTeam: null, seed: 7, layout, skipPrep });
  const ai = new AiDirector(game);
  let ticks = 0;
  while (game.state.phase !== 'over' && ticks < 60 * 200) {
    game.step(ai.tick());
    ticks++;
  }
  console.log(
    `skipPrep=${skipPrep} phase=${game.state.phase} winner=${game.state.winner} ` +
      `t=${game.state.time.toFixed(1)} obstacles=${game.state.obstacles.length} ` +
      `agents=${game.state.agents.length} reason=${game.state.endReason}`,
  );
}

const empty: ArenaLayout = {
  obstacles: borderWalls(),
  agents: [
    { team: 'hider', x: 15, z: 0, isPlayer: false },
    { team: 'seeker', x: 0, z: 0, isPlayer: false },
  ],
  pickups: [],
};
const g2 = new Game({ hiders: 1, seekers: 1, playerTeam: null, seed: 3, layout: empty, skipPrep: true });
const ai2 = new AiDirector(g2);
let t2 = 0;
while (g2.state.phase !== 'over' && t2 < 60 * 200) {
  g2.step(ai2.tick());
  t2++;
}
console.log(`empty: winner=${g2.state.winner} t=${g2.state.time.toFixed(1)}`);

const run = (): string => {
  const g = new Game({ hiders: 2, seekers: 2, playerTeam: null, seed: 99, layout, skipPrep: true });
  const a = new AiDirector(g);
  while (g.state.phase !== 'over') g.step(a.tick());
  return `${g.state.winner}/${g.state.time.toFixed(3)}/${g.state.agents.map((x) => x.x.toFixed(3)).join(',')}`;
};
console.log('determinism:', run() === run() ? 'OK' : 'NG');

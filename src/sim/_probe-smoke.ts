// 使い捨ての計測。鬼が視線を切られる原因の内訳を出す。
//
// 1v1 のトレースで、鬼が 5〜10m の至近で発見しては 0.1〜0.5 秒で見失う場面が
// 繰り返し出ていた。遮蔽で切られたにしては速すぎるので、煙幕を疑う。
// `seeker.ts` は煙を一切参照していないので、もし主因なら丸ごと手つかずの領域になる。
//
// 使い方: npx tsx src/sim/_probe-smoke.ts <hiders> <seekers> [games]

import { AiDirector } from '../ai/director';
import { DT, EYE_HEIGHT, HUNT_TIME, PREP_TIME, SMOKE_RADIUS } from '../core/config';
import { Game } from '../core/game';
import { hasLineOfSight } from '../core/physics';
import { smokeBlocks } from '../core/vision';
import type { MatchConfig } from '../core/types';

const MAX_TICKS = Math.ceil((PREP_TIME + HUNT_TIME + 2) / DT);
const HIDERS = Number(process.argv[2] ?? 1);
const SEEKERS = Number(process.argv[3] ?? 1);
const GAMES = Number(process.argv[4] ?? 30);

let losses = 0;
/** 見失った瞬間、幾何的な視線は通っていたのに煙で切られていた */
let bySmoke = 0;
/** 幾何的にも切れていた（箱・壁・距離・視野角） */
let byGeometry = 0;
/** 見失った時点の距離の合計 */
let distSum = 0;
/** 煙で切られた直後、鬼が煙の中へ入っていったか（3 秒以内に煙の半径内） */
let enteredSmoke = 0;
let smokeEvents = 0;
/** 煙で切られてから再発見までの秒数 */
const regain: number[] = [];

for (let i = 0; i < GAMES; i++) {
  const config: MatchConfig = {
    hiders: HIDERS,
    seekers: SEEKERS,
    playerTeam: null,
    seed: 1234 + i * 7919,
  };
  const game = new Game(config);
  const ai = new AiDirector(game);
  const s = game.state;
  const wasSeen = new Set<number>();
  // 煙で切られた事件を追う
  const pending: Array<{ id: number; t: number; sx: number; sz: number; entered: boolean }> = [];

  for (let t = 0; t < MAX_TICKS; t++) {
    game.step(ai.tick());
    if (s.phase !== 'hunt') {
      if (s.phase === 'over') break;
      continue;
    }

    const seekers = s.agents.filter((a) => a.team === 'seeker' && !a.caught);

    for (const h of s.agents) {
      if (h.team !== 'hider' || h.caught) continue;
      const seen = game.visible.seeker.has(h.id);
      if (seen) {
        wasSeen.add(h.id);
        // 煙で切られた事件の決着
        for (let k = pending.length - 1; k >= 0; k--) {
          if (pending[k].id !== h.id) continue;
          regain.push(s.time - pending[k].t);
          pending.splice(k, 1);
        }
        continue;
      }
      if (!wasSeen.has(h.id)) continue;
      wasSeen.delete(h.id);
      losses++;

      // 一番近い鬼を基準に、切れた原因を判定する。
      let near = seekers[0];
      let nd = Infinity;
      for (const k of seekers) {
        const d = Math.hypot(k.x - h.x, k.z - h.z);
        if (d < nd) {
          nd = d;
          near = k;
        }
      }
      if (!near) continue;
      distSum += nd;

      const oy = near.y + EYE_HEIGHT;
      const clear =
        hasLineOfSight(s.obstacles, near.x, oy, near.z, h.x, h.y + 0.9, h.z) ||
        hasLineOfSight(s.obstacles, near.x, oy, near.z, h.x, h.y + EYE_HEIGHT, h.z);
      const smoked = smokeBlocks(s, near.x, oy, near.z, h.x, h.y + 1.1, h.z);
      if (clear && smoked) {
        bySmoke++;
        smokeEvents++;
        pending.push({ id: h.id, t: s.time, sx: h.x, sz: h.z, entered: false });
      } else {
        byGeometry++;
      }
    }

    // 煙に鬼が突っ込んだか
    for (const ev of pending) {
      if (ev.entered) continue;
      if (s.time - ev.t > 3) continue;
      for (const k of seekers) {
        for (const sm of s.smokes) {
          if (Math.hypot(k.x - sm.x, k.z - sm.z) < SMOKE_RADIUS) {
            ev.entered = true;
            enteredSmoke++;
            break;
          }
        }
        if (ev.entered) break;
      }
    }
  }
}

const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`${HIDERS}v${SEEKERS} / ${GAMES} 試合  視線が切れた原因`);
console.log(`  見失い ${losses} 回、平均距離 ${(distSum / Math.max(1, losses)).toFixed(1)} m`);
console.log(`  煙で切られた:   ${bySmoke} (${pct(bySmoke, losses)})`);
console.log(`  幾何で切られた: ${byGeometry} (${pct(byGeometry, losses)})`);
console.log(`  煙で切られた直後 3 秒以内に鬼が煙へ入った: ${enteredSmoke} (${pct(enteredSmoke, smokeEvents)})`);
console.log(`  煙で切られてから再発見まで: ${mean(regain).toFixed(1)} 秒 (n=${regain.length})`);

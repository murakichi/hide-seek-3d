// ゲーム状態を three.js のシーンに反映する層。ここにゲームルールは書かない。

import * as THREE from 'three';
import {
  AGENT_HEIGHT,
  AGENT_RADIUS,
  SEEKER_CAGE_RADIUS,
  SMOKE_HEIGHT,
  SMOKE_RADIUS,
  VIEW_DIST,
  viewDistFor,
  VIEW_FOV,
} from '../core/config';
import type { Game } from '../core/game';
import type { Agent, Obstacle, Pickup, Team } from '../core/types';
import type { Renderer } from './renderer';

const COLOR = {
  hider: 0x4db5ff,
  seeker: 0xff5b5b,
  hiderDark: 0x1c5f8f,
  seekerDark: 0x8f2b2b,
  box: 0xc9a06a,
  wall: 0x5b6478,
  ramp: 0x7d8798,
  pickup: 0x6fe8b0,
  pad: 0xc98bff,
};

interface AgentVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  nose: THREE.Mesh;
  ring: THREE.Mesh | null;
  ghost: THREE.Mesh;
}

export class GameView {
  private agentVisuals = new Map<number, AgentVisual>();
  private obstacleMeshes = new Map<number, THREE.Object3D>();
  private lockRings = new Map<number, THREE.Mesh>();
  private pickupMeshes = new Map<number, THREE.Object3D>();
  private smokeMeshes = new Map<number, THREE.Mesh>();
  private cage: THREE.Mesh;
  private viewCone: THREE.Mesh;
  private root = new THREE.Group();

  constructor(private renderer: Renderer, game: Game) {
    renderer.scene.add(this.root);

    this.cage = new THREE.Mesh(
      new THREE.CylinderGeometry(SEEKER_CAGE_RADIUS, SEEKER_CAGE_RADIUS, 3.2, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff5b5b,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
      }),
    );
    this.cage.position.y = 1.6;
    this.root.add(this.cage);

    // 自機の視界を示す扇形。隠れているかどうかの直感を助ける。
    // 床に寝かせた状態で扇の中心がワールド +Z を向くよう、ローカル -90 度を中心に取る。
    const coneGeo = new THREE.CircleGeometry(VIEW_DIST, 48, -VIEW_FOV / 2 - Math.PI / 2, VIEW_FOV);
    this.viewCone = new THREE.Mesh(
      coneGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05 }),
    );
    this.viewCone.rotation.x = -Math.PI / 2;
    this.viewCone.position.y = 0.05;
    this.root.add(this.viewCone);

    this.build(game);
  }

  /** 試合開始時にシーンを作り直す。 */
  build(game: Game): void {
    for (const v of this.agentVisuals.values()) this.root.remove(v.group, v.ghost);
    for (const m of this.obstacleMeshes.values()) this.root.remove(m);
    for (const m of this.lockRings.values()) this.root.remove(m);
    for (const m of this.pickupMeshes.values()) this.root.remove(m);
    for (const m of this.smokeMeshes.values()) this.root.remove(m);
    this.agentVisuals.clear();
    this.obstacleMeshes.clear();
    this.lockRings.clear();
    this.pickupMeshes.clear();
    this.smokeMeshes.clear();

    for (const o of game.state.obstacles) this.createObstacle(o);
    for (const a of game.state.agents) this.createAgent(a);
    for (const p of game.state.pickups) this.createPickup(p);
  }

  /** 補給パック。拾える間だけ浮いて回る。 */
  private createPickup(p: Pickup): void {
    const group = new THREE.Group();

    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.42),
      new THREE.MeshStandardMaterial({
        color: COLOR.pickup,
        emissive: COLOR.pickup,
        emissiveIntensity: 0.7,
        roughness: 0.3,
      }),
    );
    core.position.y = 0.95;
    core.castShadow = true;
    group.add(core);

    // 床のしるし。拾われている間もここにあることが分かるようにする。
    const pad = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.72, 24),
      new THREE.MeshBasicMaterial({
        color: COLOR.pickup,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.04;
    group.add(pad);

    group.position.set(p.x, 0, p.z);
    this.root.add(group);
    this.pickupMeshes.set(p.id, group);
  }

  private createObstacle(o: Obstacle): void {
    if (o.kind === 'ramp') {
      // 斜面は板を傾けて表現する。物理側の線形な高さと見た目を一致させる。
      // 板は常に +X 方向に上るものを作り、傾斜方向はグループの Y 回転で合わせる。
      const along = o.rampDir <= 1 ? o.hw * 2 : o.hd * 2;
      const across = o.rampDir <= 1 ? o.hd * 2 : o.hw * 2;
      const tilt = Math.atan2(o.h, along);
      const plank = new THREE.Mesh(
        new THREE.BoxGeometry(along / Math.cos(tilt), 0.25, across),
        new THREE.MeshStandardMaterial({ color: COLOR.ramp, roughness: 0.85 }),
      );
      plank.rotation.z = tilt;
      plank.position.y = o.h / 2;
      plank.castShadow = true;
      plank.receiveShadow = true;

      const g = new THREE.Group();
      g.add(plank);
      g.rotation.y = [0, Math.PI, -Math.PI / 2, Math.PI / 2][o.rampDir];
      g.position.set(o.x, 0, o.z);
      this.root.add(g);
      this.obstacleMeshes.set(o.id, g);
      return;
    }

    if (o.kind === 'pad') {
      const group = new THREE.Group();
      const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.min(o.hw, o.hd), Math.min(o.hw, o.hd) * 1.15, o.h, 20),
        new THREE.MeshStandardMaterial({
          color: COLOR.pad,
          emissive: COLOR.pad,
          emissiveIntensity: 0.45,
          roughness: 0.4,
        }),
      );
      plate.position.y = o.h / 2;
      plate.receiveShadow = true;
      group.add(plate);

      // 上向きの矢印で「跳ねる」ことを示す。
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.3, 0.6, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }),
      );
      arrow.position.y = o.h + 0.55;
      group.add(arrow);

      group.position.set(o.x, 0, o.z);
      this.root.add(group);
      this.obstacleMeshes.set(o.id, group);
      return;
    }

    const color = o.kind === 'wall' ? COLOR.wall : COLOR.box;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(o.hw * 2, o.h, o.hd * 2),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05 }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(o.x, o.y + o.h / 2, o.z);
    this.root.add(mesh);
    this.obstacleMeshes.set(o.id, mesh);

    if (o.kind === 'box') {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(Math.max(o.hw, o.hd) + 0.18, 0.07, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.root.add(ring);
      this.lockRings.set(o.id, ring);
    }
  }

  private createAgent(a: Agent): void {
    const group = new THREE.Group();
    const color = a.team === 'seeker' ? COLOR.seeker : COLOR.hider;

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(AGENT_RADIUS, AGENT_HEIGHT - AGENT_RADIUS * 2, 6, 14),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.5,
        emissive: a.team === 'seeker' ? COLOR.seekerDark : COLOR.hiderDark,
        emissiveIntensity: 0.35,
      }),
    );
    body.position.y = AGENT_HEIGHT / 2;
    body.castShadow = true;
    group.add(body);

    // 向きが分かるくちばし。
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.55, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, AGENT_HEIGHT * 0.72, AGENT_RADIUS + 0.2);
    group.add(nose);

    let ring: THREE.Mesh | null = null;
    if (a.isPlayer) {
      ring = new THREE.Mesh(
        new THREE.TorusGeometry(AGENT_RADIUS + 0.45, 0.08, 8, 28),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      group.add(ring);
    }

    this.root.add(group);

    // 見失った敵の「最後に見た位置」マーカー。
    const ghost = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.75, 20),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      }),
    );
    ghost.rotation.x = -Math.PI / 2;
    ghost.position.y = 0.08;
    ghost.visible = false;
    this.root.add(ghost);

    this.agentVisuals.set(a.id, { group, body, nose, ring, ghost });
  }

  /** 毎フレーム呼ぶ。観戦モードでは viewerTeam を null にすると全員見える。 */
  sync(game: Game, viewerTeam: Team | null): void {
    const s = game.state;

    for (const o of s.obstacles) {
      const mesh = this.obstacleMeshes.get(o.id);
      if (mesh) {
        mesh.position.x = o.x;
        mesh.position.y = o.y + o.h / 2;
        mesh.position.z = o.z;
      }
      const ring = this.lockRings.get(o.id);
      if (ring) {
        ring.position.set(o.x, o.y + o.h + 0.12, o.z);
        if (o.lockedBy) {
          ring.visible = true;
          (ring.material as THREE.MeshBasicMaterial).color.setHex(
            o.lockedBy === 'hider' ? COLOR.hider : COLOR.seeker,
          );
          (ring.material as THREE.MeshBasicMaterial).opacity = 0.9;
        } else if (o.unlockProgress > 0.01) {
          ring.visible = true;
          (ring.material as THREE.MeshBasicMaterial).color.setHex(0xffdd55);
          (ring.material as THREE.MeshBasicMaterial).opacity = o.unlockProgress;
        } else {
          ring.visible = false;
        }
      }
    }

    for (const p of s.pickups) {
      const g = this.pickupMeshes.get(p.id);
      if (!g) continue;
      const core = g.children[0];
      core.visible = p.active;
      if (p.active) {
        core.rotation.y = s.time * 1.6;
        core.position.y = 0.95 + Math.sin(s.time * 2.2) * 0.12;
      }
      const padMat = (g.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      padMat.opacity = p.active ? 0.35 : 0.12;
    }

    this.syncSmokes(game);

    const visibleToViewer = viewerTeam ? game.visible[viewerTeam] : null;

    for (const a of s.agents) {
      const v = this.agentVisuals.get(a.id);
      if (!v) continue;

      v.group.position.set(a.x, a.y, a.z);
      v.group.rotation.y = a.facing;

      const isOwnTeam = viewerTeam === null || a.team === viewerTeam;
      const spotted = visibleToViewer ? visibleToViewer.has(a.id) : true;
      const show = !a.caught && (isOwnTeam || spotted);

      v.group.visible = show;
      const mat = v.body.material as THREE.MeshStandardMaterial;
      mat.opacity = a.caught ? 0.25 : 1;
      mat.transparent = a.caught;

      // 見えていない敵は、最後に見た位置にマーカーだけ残す。
      if (!isOwnTeam && !spotted && !a.caught && viewerTeam) {
        const rec = s.memory[viewerTeam].get(a.id);
        if (rec && s.time - rec.t < 8) {
          v.ghost.visible = true;
          v.ghost.position.set(rec.x, 0.08, rec.z);
          (v.ghost.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - (s.time - rec.t) / 8);
        } else {
          v.ghost.visible = false;
        }
      } else {
        v.ghost.visible = false;
      }

      if (a.caught) {
        v.group.visible = true;
        v.group.scale.setScalar(0.55);
        v.group.position.y = a.y + 0.1;
      } else {
        v.group.scale.setScalar(1);
      }
    }

    this.cage.visible = s.phase === 'prep';

    const player = game.playerAgent;
    if (player && !player.caught) {
      this.viewCone.visible = true;
      this.viewCone.position.set(player.x, player.y + 0.06, player.z);
      this.viewCone.rotation.z = player.facing;
      // 鬼の視界は人数で割られるので、扇の大きさも合わせる。
      // ここがずれると「見えているはずなのに見つからない」と感じる。
      const range =
        player.team === 'seeker' ? viewDistFor(s.config.seekers) : VIEW_DIST;
      this.viewCone.scale.setScalar(range / VIEW_DIST);
    } else {
      this.viewCone.visible = false;
    }
  }

  /** 煙は数が少なく寿命も短いので、その都度作って消す。 */
  private syncSmokes(game: Game): void {
    const s = game.state;
    const live = new Set(s.smokes.map((k) => k.id));

    for (const [id, mesh] of this.smokeMeshes) {
      if (!live.has(id)) {
        this.root.remove(mesh);
        this.smokeMeshes.delete(id);
      }
    }

    for (const smoke of s.smokes) {
      let mesh = this.smokeMeshes.get(smoke.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(SMOKE_RADIUS, 20, 14),
          new THREE.MeshStandardMaterial({
            color: 0xdfe6f2,
            transparent: true,
            opacity: 0.5,
            roughness: 1,
          }),
        );
        mesh.position.set(smoke.x, SMOKE_HEIGHT, smoke.z);
        this.root.add(mesh);
        this.smokeMeshes.set(smoke.id, mesh);
      }
      // 発生直後に膨らみ、消える前に薄くなる。
      const age = s.time - smoke.bornAt;
      const remaining = smoke.until - s.time;
      const grow = Math.min(1, age / 0.45);
      mesh.scale.setScalar(grow);
      (mesh.material as THREE.MeshStandardMaterial).opacity =
        0.5 * Math.min(1, remaining / 1.2) * grow;
    }
  }

  dispose(): void {
    this.renderer.scene.remove(this.root);
  }
}

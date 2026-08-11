// ゲーム状態を three.js のシーンに反映する層。ここにゲームルールは書かない。

import * as THREE from 'three';
import {
  AGENT_HEIGHT,
  AGENT_RADIUS,
  SEEKER_CAGE_RADIUS,
  SMOKE_HEIGHT,
  SMOKE_RADIUS,
  VIEW_DIST,
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

/**
 * 人型の各部の寸法。AGENT_HEIGHT / AGENT_RADIUS への比率で持つので、
 * 当たり判定のサイズを変えても見た目が破綻しない。
 * 俯瞰カメラでは 1.7 m の人が数十ピクセルにしかならないので、
 * 手足は細長くせず、頭・肩・くちばしの塊で向きが読めることを優先している。
 */
const BODY = {
  hipY: 0.38, // 股関節の高さ（× 身長）
  legRadius: 0.28, // 脚の太さ（× 半径）
  legOffset: 0.34, // 脚の左右間隔（× 半径）
  torsoY: 0.55, // 胴の中心（× 身長）
  torsoRadius: 0.68, // 胴の大きさ（× 半径）
  shoulderY: 0.68, // 肩の高さ（× 身長）
  shoulderOffset: 0.95, // 肩の左右間隔（× 半径）
  armRadius: 0.21, // 腕の太さ（× 半径）
  armLength: 0.24, // 腕の長さ（× 身長）
  headRadius: 0.5, // 頭の大きさ（× 半径）
};

interface AgentVisual {
  group: THREE.Group;
  /** 腰から上。跳んだときの縮こまりや上下の揺れをここに掛ける */
  rig: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  /** 捕獲時に透過させる。体のパーツ全部ぶん持つ */
  mats: THREE.MeshStandardMaterial[];
  /** 歩幅の位相。移動距離を積んでいく（速いほど速く回る） */
  walk: number;
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
  /** 前回 sync したゲーム内時刻。手足の位相を進める差分に使う */
  private lastSyncTime = 0;

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
    this.lastSyncTime = game.state.time;

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
    const H = AGENT_HEIGHT;
    const R = AGENT_RADIUS;
    const seeker = a.team === 'seeker';
    const color = seeker ? COLOR.seeker : COLOR.hider;
    const dark = seeker ? COLOR.seekerDark : COLOR.hiderDark;

    const skin = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.5,
      emissive: dark,
      emissiveIntensity: 0.35,
    });
    // 胴は頭より一段、手足はさらに一段暗くする。同色の球が繋がると
    // 俯瞰では雪だるまの塊にしか見えないので、明度差で頭・胴・手足を分ける。
    const suit = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).lerp(new THREE.Color(dark), 0.4),
      roughness: 0.55,
    });
    const limb = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    const pupil = new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.5 });
    const mats = [skin, suit, limb, white, pupil];

    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // 脚。股関節を原点にした Group を回して振り出す。
    const legRad = R * BODY.legRadius;
    const hipY = H * BODY.hipY;
    const legGeo = new THREE.CapsuleGeometry(legRad, Math.max(0.05, hipY - legRad * 2), 4, 10);
    const legs: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * R * BODY.legOffset, hipY, 0);
      const mesh = part(legGeo, limb, hip);
      mesh.position.y = -hipY / 2;
      group.add(hip);
      legs.push(hip);
    }

    // 腰から上。跳躍や上下の揺れはこの Group ごと動かす。
    const rig = new THREE.Group();
    rig.position.y = hipY;
    group.add(rig);

    const torso = part(new THREE.SphereGeometry(R * BODY.torsoRadius, 16, 12), suit, rig);
    torso.scale.set(0.95, 1.05, 0.78);
    torso.position.y = H * BODY.torsoY - hipY;

    // 腕。肩を原点にして前後に振る。
    const armRad = R * BODY.armRadius;
    const armLen = H * BODY.armLength;
    const armGeo = new THREE.CapsuleGeometry(armRad, armLen, 4, 10);
    const arms: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * R * BODY.shoulderOffset, H * BODY.shoulderY - hipY, 0);
      const mesh = part(armGeo, limb, shoulder);
      mesh.position.y = -(armLen / 2 + armRad);
      rig.add(shoulder);
      arms.push(shoulder);
    }

    // 頭。頭頂が身長ちょうどに来る高さに置く。
    const headRad = R * BODY.headRadius;
    const headY = H - headRad * 1.05;
    const head = new THREE.Group();
    head.position.y = headY - hipY;
    rig.add(head);
    part(new THREE.SphereGeometry(headRad, 16, 12), skin, head);

    // 首。胴と頭のあいだに暗い段を入れて輪郭を切る。
    const neck = part(new THREE.CylinderGeometry(headRad * 0.5, headRad * 0.6, 0.16, 10), limb, rig);
    neck.position.y = headY - hipY - headRad * 0.85;

    // 目。俯瞰では小さいが、正面から見たときの人らしさを担う。
    for (const side of [-1, 1]) {
      const eye = part(new THREE.SphereGeometry(headRad * 0.3, 10, 8), white, head);
      eye.position.set(side * headRad * 0.42, headRad * 0.12, headRad * 0.82);
      const iris = part(new THREE.SphereGeometry(headRad * 0.15, 8, 6), pupil, head);
      iris.position.set(side * headRad * 0.42, headRad * 0.12, headRad * 1.02);
    }

    // 向きが分かるくちばし。元は胴に生えていたが、人型では顔に付ける。
    // 俯瞰だと頭から前に突き出た白い棘として読める。
    const nose = part(new THREE.ConeGeometry(headRad * 0.42, headRad * 1.5, 8), white, head);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -headRad * 0.1, headRad * 1.15);

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

    this.agentVisuals.set(a.id, {
      group,
      rig,
      legL: legs[0],
      legR: legs[1],
      armL: arms[0],
      armR: arms[1],
      mats,
      walk: 0,
      ring,
      ghost,
    });
  }

  /**
   * 人型の手足を動かす。ゲーム状態は読むだけで書き換えない（決定論に影響しない）。
   * 位相は移動距離で進めるので、速く走るほど歩幅の回転も速くなる。
   */
  private animateAgent(v: AgentVisual, a: Agent, dt: number): void {
    const speed = Math.hypot(a.vx, a.vz);
    v.walk += speed * dt * 2.4;

    const swing = Math.sin(v.walk) * Math.min(0.8, speed * 0.16);
    const grabbing = a.grabbed >= 0;

    if (!a.grounded) {
      // 跳んでいる間は脚を畳んで腕を上げる。着地との違いが俯瞰でも分かる。
      v.legL.rotation.x = -0.5;
      v.legR.rotation.x = 0.35;
      v.armL.rotation.x = -2.1;
      v.armR.rotation.x = -2.1;
    } else {
      v.legL.rotation.x = swing;
      v.legR.rotation.x = -swing;
      v.armL.rotation.x = grabbing ? -1.5 : -swing;
      v.armR.rotation.x = grabbing ? -1.5 : swing;
    }
    // 掴んでいる間は腕を内側に寄せて、箱を抱えている形にする。
    v.armL.rotation.z = grabbing ? 0.35 : 0;
    v.armR.rotation.z = grabbing ? -0.35 : 0;

    // 歩くと 1 歩ごとに腰が上下する（歩数は歩幅の 2 倍で刻む）。
    const bob = Math.abs(Math.sin(v.walk)) * Math.min(1, speed * 0.2) * 0.06;
    v.rig.position.y = AGENT_HEIGHT * BODY.hipY + bob;
  }

  /** 毎フレーム呼ぶ。観戦モードでは viewerTeam を null にすると全員見える。 */
  sync(game: Game, viewerTeam: Team | null): void {
    const s = game.state;
    // 手足のアニメーションだけに使う経過時間。早送り中は歩幅もそのぶん速く回る。
    const dt = Math.max(0, Math.min(0.5, s.time - this.lastSyncTime));
    this.lastSyncTime = s.time;

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
      for (const mat of v.mats) {
        mat.opacity = a.caught ? 0.25 : 1;
        mat.transparent = a.caught;
      }
      this.animateAgent(v, a, dt);

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
        // 捕まったら小さくうずくまる。動かない塊として場に残す。
        v.group.visible = true;
        v.group.scale.setScalar(0.55);
        v.group.position.y = a.y + 0.1;
        v.rig.rotation.x = -1.1;
        v.legL.rotation.x = -1.4;
        v.legR.rotation.x = -1.4;
        v.armL.rotation.x = 0.6;
        v.armR.rotation.x = 0.6;
      } else {
        v.group.scale.setScalar(1);
        v.rig.rotation.x = 0;
      }
    }

    this.cage.visible = s.phase === 'prep';

    const player = game.playerAgent;
    if (player && !player.caught) {
      this.viewCone.visible = true;
      this.viewCone.position.set(player.x, player.y + 0.06, player.z);
      this.viewCone.rotation.z = player.facing;
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

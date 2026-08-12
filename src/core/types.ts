// ゲームコアの型定義。
// このファイルは three.js / DOM に一切依存しない（ヘッドレス実行のため）。

export type Team = 'hider' | 'seeker';
export type Phase = 'prep' | 'hunt' | 'over';
export type Winner = 'hider' | 'seeker' | null;

/**
 * 障害物の種類。box は押して動かせる、ramp は登れる斜面、wall は固定壁、
 * pad は乗ると高く跳ね上がるジャンプ台。
 */
export type ObstacleKind = 'box' | 'ramp' | 'wall' | 'pad';

export interface Agent {
  id: number;
  team: Team;
  /** 水平位置 */
  x: number;
  z: number;
  /** 足元の高さ（0 = 地面） */
  y: number;
  vx: number;
  vz: number;
  vy: number;
  /** 向き（ラジアン、+Z を 0 として時計回り） */
  facing: number;
  grounded: boolean;
  stamina: number;
  /** 捕獲済みか（hider のみ） */
  caught: boolean;
  /** 掴んでいる障害物 ID。掴んでいなければ -1 */
  grabbed: number;
  /** 掴んだ瞬間の相対オフセット（掴み中は維持される） */
  grabOffX: number;
  grabOffZ: number;
  /** ブースト（ダッシュ消費が軽くなる）の終了時刻。過去なら効果なし */
  boostUntil: number;
  /** 残っている煙幕の数（逃げる側のみ） */
  smokeCharges: number;
  /** 最後に煙幕を使った時刻 */
  lastSmokeAt: number;
  /** 人間が操作しているか */
  isPlayer: boolean;
  /** 直近で相手に発見された時刻（演出・AI 用） */
  lastSeenAt: number;
}

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  z: number;
  /**
   * 底面の高さ。0 なら地面に置かれている。
   * 掴んだまま跳ぶと持ち上がり、放すと落ちる。他の箱の上で止まれば積み上がる。
   */
  y: number;
  /** 落下速度（掴まれていない箱だけが使う） */
  vy: number;
  /** X 方向の半幅 / Z 方向の半奥行き */
  hw: number;
  hd: number;
  /** 厚み。上面は `y + h`。地面置きなら `y` が 0 なので上面 = h */
  h: number;
  /** ロックしているチーム。null なら誰でも動かせる */
  lockedBy: Team | null;
  /** ロック解除の進行度 0..1（相手チームが接触して解除中） */
  unlockProgress: number;
  /** 掴んでいるエージェント ID。-1 なら未掴み */
  heldBy: number;
  /** ramp の場合、傾斜が上る方向（0=+X, 1=-X, 2=+Z, 3=-Z） */
  rampDir: 0 | 1 | 2 | 3;
}

/**
 * 拾える補給パック。スタミナを全回復し、しばらくダッシュ消費を軽くする。
 * 逃げる側は準備フェーズのうちに逃走ルート上のパックを押さえられるので、
 * 全体としては逃げる側に有利に働く（不利すぎるバランスの調整弁）。
 */
export interface Pickup {
  id: number;
  x: number;
  z: number;
  /** 拾える状態か。拾われると一定時間後に復活する */
  active: boolean;
  /** 復活する時刻 */
  respawnAt: number;
}

/**
 * 逃げる側が撒く煙。中を通る視線を遮る。
 * 見つかったあとの展開が「速い方が勝つ追いかけっこ」だけにならないための手段。
 */
export interface Smoke {
  id: number;
  x: number;
  z: number;
  /** 消える時刻 */
  until: number;
  /** 発生した時刻（膨らむ演出に使う） */
  bornAt: number;
}

/** 1 ティック分の入力。値域は正規化済みであることを前提とする。 */
export interface Action {
  /** ワールド座標系の移動方向（長さ 0..1） */
  moveX: number;
  moveZ: number;
  /** 向きたい方向。(0, 0) なら移動方向を向く（AI が周囲を見回すのに使う） */
  aimX: number;
  aimZ: number;
  jump: boolean;
  dash: boolean;
  /** 障害物を掴む（押し引き） */
  grab: boolean;
  /** ロック / アンロック */
  lock: boolean;
  /** 煙幕を撒く（逃げる側のみ） */
  smoke: boolean;
}

export function emptyAction(): Action {
  return {
    moveX: 0,
    moveZ: 0,
    aimX: 0,
    aimZ: 0,
    jump: false,
    dash: false,
    grab: false,
    lock: false,
    smoke: false,
  };
}

/**
 * 手で置いたエージェントの初期状態。サンドボックスが作る。
 * 誰が人間の操作対象かもここで決まる（`isPlayer` は最大 1 人）。
 */
export interface AgentSpawn {
  team: Team;
  x: number;
  z: number;
  /** 足元の高さ。箱の上に立たせたいときに使う（省略時は地面） */
  y?: number;
  isPlayer: boolean;
}

/**
 * 手で組んだ盤面。`MatchConfig.layout` に渡すと、シードからの自動生成の代わりに
 * そのまま初期状態として使われる。座標だけを持つ素の記述なので、
 * ID や掴み状態などの実行時の値は `Game` 側で振り直す。
 */
export interface ArenaLayout {
  obstacles: Obstacle[];
  agents: AgentSpawn[];
  pickups: Array<{ x: number; z: number }>;
}

export interface MatchConfig {
  /** 逃げる側の人数 */
  hiders: number;
  /** 鬼の人数 */
  seekers: number;
  /** 人間プレイヤーの陣営。null なら全員 AI（観戦 / ヘッドレス） */
  playerTeam: Team | null;
  /** 乱数シード（同じシード + 同じ入力列 = 同じ試合） */
  seed: number;
  /**
   * 手で組んだ盤面。指定するとアリーナ生成と初期配置を行わない。
   * `hiders` / `seekers` は layout のエージェント数と一致させること。
   */
  layout?: ArenaLayout;
  /**
   * 準備フェーズを飛ばして追跡フェーズから始める。
   * サンドボックスは「置いた状態がそのまま開始状態」なので既定でこちら
   * （準備フェーズを挟むと鬼が中央のケージへ引き戻されてしまう）。
   */
  skipPrep?: boolean;
}

export interface GameState {
  config: MatchConfig;
  phase: Phase;
  /** 試合開始からの経過秒 */
  time: number;
  /** 現フェーズの残り秒 */
  phaseTime: number;
  agents: Agent[];
  obstacles: Obstacle[];
  pickups: Pickup[];
  smokes: Smoke[];
  winner: Winner;
  /** 決着理由（UI 表示用） */
  endReason: string;
  /** チームごとの「最後に見た敵位置」メモ。AI と UI のゴースト表示に使う */
  memory: Record<Team, Map<number, { x: number; z: number; t: number }>>;
  tick: number;
}

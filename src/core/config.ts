// ゲームバランス定数。AI の改善ループではここではなく src/ai/params.ts を触る。

/** 固定タイムステップ。決定論を保つため描画 FPS とは切り離す。 */
export const DT = 1 / 60;

/**
 * アリーナは正方形。半径 22 → 44x44。見下ろしで一画面に収まるサイズ。
 * 移動速度に対して狭すぎると、見つかった瞬間に逃げ場が無くなって
 * 追いかけっこが成立しない。速度を上げるならここも一緒に広げること。
 */
export const ARENA_HALF = 22;

export const AGENT_RADIUS = 0.55;
export const AGENT_HEIGHT = 1.7;
/** 目線の高さ（視線判定の始点） */
export const EYE_HEIGHT = 1.4;

export const GRAVITY = 26;
/**
 * 小さい箱（`BOX_HEIGHT_SMALL`）には地面から直接乗れるが、
 * 大きい箱（`BOX_HEIGHT_BIG`）には届かない。
 * 大きい箱に上がるには低い箱やランプを踏み台にする必要がある。
 */
export const JUMP_SPEED = 8.2;
/** 段差をよじ登れる高さ（これ以下なら自動で乗り上がる） */
export const STEP_HEIGHT = 0.35;
/** ジャンプの頂点の高さ。AI が「その足場に乗れるか」を判断するのに使う */
export const JUMP_REACH = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
/** 今の足元から一度のジャンプで乗れる面の高さ */
export const CLIMB_REACH = JUMP_REACH + STEP_HEIGHT;

// 鬼の方が速いと、見つかった時点で逃げ側に打つ手が無くなる。
// 逃げ側をわずかに速くして、遮蔽と立ち回りで振り切る余地を残す。
export const HIDER_SPEED = 9.4;
export const SEEKER_SPEED = 8.8;
export const ACCEL_GROUND = 78;
/** 空中でも十分に曲がれるようにする。ジャンプが移動の選択肢になる条件 */
export const ACCEL_AIR = 34;
export const FRICTION_GROUND = 9;

/**
 * ジャンプ台の打ち上げ速度。到達高はおよそ 3.0 m で、
 * 一番高い箱にも内壁の上にも乗れるが、外周の壁は越えられない。
 */
export const PAD_JUMP_SPEED = 12.5;

/** ジャンプの踏み切りで進行方向に乗る勢い。跳ねながら走ると気持ちよく加速する */
export const JUMP_IMPULSE = 1.9;
/** 踏み切りで得られる勢いの上限（通常速度の何倍まで乗るか） */
export const JUMP_IMPULSE_CAP = 1.18;

export const DASH_MULT = 1.55;
export const STAMINA_MAX = 100;
export const DASH_COST = 34;
/**
 * 鬼は息が続かない。全力疾走を持続できると、見つかった時点で
 * 逃げる側に打つ手が無くなり「速い方が勝つ」だけの追いかけっこになる。
 * 追う側は「ここぞ」でダッシュを使う判断を迫られる。
 */
export const SEEKER_DASH_COST = 52;
export const STAMINA_REGEN = 19;
/** これを下回るとダッシュ再開不可（連打抑制） */
export const DASH_MIN_STAMINA = 12;

export const PREP_TIME = 32;
/**
 * 追跡フェーズの**最長**（鬼が 3 人以上のとき）。
 * `huntTimeFor` はここから引く方向にしか動かないので、
 * ヘッドレス実行の打ち切り上限（`PREP_TIME + HUNT_TIME`）はこの値で足りる。
 * 増やす方向の式に変えるときは `src/sim/*` の `MAX_TICKS` も一緒に直すこと。
 */
export const HUNT_TIME = 68;

/**
 * 人数が増えるほど逃げ切りに必要な時間を**伸ばす**。
 *
 * 以前は逆（人数が増えるほど縮める）だった。「鬼が増えれば盤面を虱潰しにする速度が
 * 上がるので、そのぶん短くして釣り合いを取る」という理屈だったが、当時測ると逆で、
 * 探索が速くなる効果より「1 人でも残れば逃げ側の勝ち」の増幅の方が強かった。
 *
 * **ただしこの根拠は既に成り立っていない。** 反転を決めた時点（PR #18 まで）の
 * 逃げ側勝率は 28.3 / 45.0 / 57.8% と人数に対して単調に上がっていたが、
 * その後 PR #23（1 つの目撃情報へ向かう鬼を 1 人に制限）が入って
 * 27 / 10 / 1% と**単調に下がる**形に反転した。
 *
 * マージ時の実測（各 600 試合、CI）は 1v1 27 → 42% / 2v2 10%（時間不変）/ 3v3 1%。
 * **1v1 を帯に入れる効果だけが残っている。** 3v3 が動かないのは効果が無いのではなく、
 * 初補足 41 秒・生存 0.01 人で 54 秒の時点で既に全員捕まっており、
 * 68 秒に伸ばしても差が出ようがないため（マスクされている）。
 * 逃げ側が回復したら 3v3 を伸ばす向きは不利に働くので、そのときに測り直すこと。
 *
 * 1v1 56 / 2v2 62 / 3v3 以上 68 秒。`HUNT_TIME` が最長になる向きに揃えてある
 * （ヘッドレス実行の打ち切り上限がこれを前提にしている）。
 * 実測は `docs/balance-log.md` 2026-08-11 の節。
 */
export function huntTimeFor(seekers: number): number {
  return HUNT_TIME - Math.max(0, 3 - seekers) * 6;
}

/** 捕獲成立する水平距離 */
export const CATCH_DIST = AGENT_RADIUS * 2 + 0.2;
/** 捕獲成立する垂直距離（箱の上と下では触れない） */
export const CATCH_VERTICAL = 1.6;

/**
 * 箱の高さ。踏み台にするための低い箱と、視線を止めるための高い箱。
 *
 * 視線は目線（`EYE_HEIGHT` = 1.4）から相手の頭（同じ高さ）へ引くので、
 * **1.4 以下の箱は遮蔽としてまったく働かない**。小さい箱が遮蔽にならないのは
 * 仕様であって不具合ではない（運ぶため・登るための箱）。
 *
 * 2026-08-10 に「小さい箱を 1.5 にして遮蔽にする」を 780 試合（3 構成 × 3 シード）で
 * 試した結果、見られている割合は 3v3 で 76.0% → 50.4% まで下がったのに、
 * 勝率は 3 構成そろって下がった（24.7/35.3/38.3 → 20.3/33.3/36.1）。
 * 遮蔽を増やしても逃げ切れるようにはならない。**理由は分かっていない。**
 * `docs/balance-log.md` 参照。ここを上げ直す前にその節を読むこと。
 */
export const BOX_HEIGHT_SMALL = 1.3;
/** 大きい箱。踏み台なしでは乗れず、視線も止める。 */
export const BOX_HEIGHT_BIG = 2.2;

/** 視野角（全角、ラジアン） */
export const VIEW_FOV = (115 * Math.PI) / 180;
export const VIEW_DIST = 19;
/** この距離以内なら視野角外でも気配で察知する */
export const PERIPHERAL_DIST = 3.2;
/**
 * 逃げる側だけは広く気配を感じ取る。
 * これが無いと背後から近づかれた時点で詰みになり、隠れる側の判断が成立しない。
 * 遮蔽があれば感じ取れない点は視覚と同じ。
 */
export const HIDER_SENSE_DIST = 9;

/** 掴める距離（エージェント表面から障害物表面まで） */
export const GRAB_RANGE = 1.6;
/** 掴んだ障害物を動かせる最大速度。掴み中の移動速度より速くしないと手が離れやすい */
export const GRAB_SPEED = 6;
/** 掴んでいる間の移動速度倍率 */
export const GRAB_SLOWDOWN = 0.78;
/** 掴める最大の障害物サイズ（半幅の和） */
export const GRAB_MAX_SIZE = 2.6;

/** ロックにかかる時間（秒） */
export const LOCK_TIME = 0.35;
/** 相手のロックを解除するのにかかる時間（秒） */
export const UNLOCK_TIME = 1.6;

/** 準備フェーズ中、鬼はこの円の中に閉じ込められる（中央のケージ） */
export const SEEKER_CAGE_RADIUS = 2.6;

/** 補給パックを拾える距離 */
export const PICKUP_RADIUS = 1;
/** 拾われたパックが復活するまでの秒数 */
export const PICKUP_RESPAWN = 22;
/** パックの効果時間（この間はダッシュ消費が軽い） */
export const BOOST_TIME = 6;
/** ブースト中のダッシュ消費倍率 */
export const BOOST_DASH_COST = 0.45;
/** 参加人数 1 人あたりのパック数の目安 */
export const PICKUPS_PER_AGENT = 1.2;

/** 逃げる側が持って始める煙幕の数 */
export const SMOKE_CHARGES = 2;
/** 煙の半径 */
export const SMOKE_RADIUS = 4;
/** 煙の中心の高さ。しゃがんでも立っても視線が通らない高さに置く */
export const SMOKE_HEIGHT = 1.3;
/** 煙が残る秒数 */
export const SMOKE_TIME = 7;
/** 連続使用の間隔 */
export const SMOKE_COOLDOWN = 2;

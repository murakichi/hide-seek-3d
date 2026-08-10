# HIDE & SEEK 3D

ブラウザで動く見下ろし型 3D 鬼ごっこ。Vite + TypeScript + three.js。
仕様と遊び方は `README.md`、バランス変更の履歴は `docs/balance-log.md`。

## 作業ルール

**各作業は必ず worktree を切って行うこと。** 作業を始める前に `EnterWorktree` で
その作業用の worktree を作り、その中で編集する。メインの作業ディレクトリで直接編集しない。

```
EnterWorktree({ name: "fix-hauling-stuck" })
```

名前は作業内容が分かるものにする（`fix-*`, `tune-*`, `feat-*` など）。
作業が終わったら `ExitWorktree` で抜ける。

## コマンド

```bash
npm run dev                                      # 開発サーバー
npm run build                                    # 型チェック + ビルド
npm run sim   -- --games 24 --hiders 2 --seekers 2   # ヘッドレス対戦で勝率を測る
npm run trace -- --find-loss --interval 5        # 1 試合の展開を詳細ログで見る
npm run tune  -- --side hider --iters 30         # AI パラメータの自動探索
```

AI やバランスを直すときは `/improve-ai` スキルの手順に従う
（測定 → トレース精査 → 原因を 1 つ修正 → 再測定 → 記録）。

## 構成

```
src/core/   ゲーム本体。three.js にも DOM にも依存しない決定論シミュレーション
src/ai/     ルールベース AI（seeker / hider / 経路探索 / パラメータ）
src/render/ three.js での描画
src/ui/     メニューと HUD
src/sim/    ヘッドレス対戦・トレース・自動チューニング
```

## 守ること

- **`src/core` の決定論を壊さない。** `Math.random()` や実時間を使わない。乱数は
  `Rng`（シード付き）、時間は固定ステップ `DT` のみ。同じ seed と同じ入力列で
  必ず同じ試合になることが、ヘッドレス対戦・トレース・チューニングすべての前提。
- **`src/core` から `three` や DOM を参照しない。** ヘッドレス実行ができなくなる。
- **ソースを PowerShell の `Get-Content`/`Set-Content` で書き換えない。** 既定の
  エンコーディングで読み書きされて日本語コメントと改行が壊れる。編集は Edit ツールで行う。
- **移動速度を変えたら AI の先読み距離も一緒に見直す。** `fleeDirection` のレイ長、
  `followPath` の到達判定、詰まり判定の速度しきい値は速度に対する相対値として決めている。
  速度だけ上げると AI が壁に突っ込むようになる。
- **`npm run tune` は必ず複数の人数構成で評価する。** 1 構成で最適化すると
  その人数でしか通用しない値を採用してしまう（実際に 2v2 単独で最適化した結果、
  1v1 の勝率が 42% → 17% に落ちたことがある）。
- **バランス定数（速度・時間・視界・アリーナ）は `src/core/config.ts`、
  AI の戦術パラメータは `src/ai/params.ts`。** 前者は遊び心地の問題なので
  `tune` の対象にしない。

## 現状の課題

逃げる側の勝率が目標（どの構成でも 35〜50%）に届いていない。
個人あたりの生存率がどの人数でも 12% 前後で一定なので、
「見つかったあとに逃げ切れない」ことが本質。

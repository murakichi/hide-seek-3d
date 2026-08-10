# HIDE & SEEK 3D

ブラウザで動く見下ろし型 3D 鬼ごっこ。Vite + TypeScript + three.js。
仕様と遊び方は `README.md`、バランス変更の履歴は `docs/balance-log.md`。

## 作業ルール

作業のたびに次を回す。

1. **`docs/journal/` の直近 2〜3 件を読む。** 前回の続きと、試して駄目だった案を把握する。
   `docs/issues/` に open の件があれば、優先度の高いものから拾う。
2. **worktree を切る。** `EnterWorktree` でその作業用の worktree を作り、その中で編集する。
   メインの作業ディレクトリで直接編集しない。名前は作業内容が分かるものにする
   （`fix-*`, `tune-*`, `feat-*`, `setup-*` など）。
   ```
   EnterWorktree({ name: "fix-hauling-stuck" })
   ```
3. **1 サイクルで直すのは 1 つ。** 途中で別の問題に気づいたら、その場で直さずに
   `docs/issues/` に新しい issue を立てる。
4. **`docs/journal/YYYY-MM-DD.md` に追記する。** やったこと・分かったこと・次にやること。
   価値があるのは「うまくいかなかったこと」と「意外だったこと」。成功した変更の内容自体は
   git log に残るので繰り返さない。
5. **issue を更新する。** 直ったら `status: closed` にして「解決」節を書く。閉じた issue は消さない。
6. **PR を作る。** master を取り込んでから作業ブランチを push し、`gh pr create` する。
   master へ直接マージしない。
   ```bash
   git fetch origin && git merge origin/master   # 衝突はここで解決しておく
   npm run build
   git push -u origin worktree-fix-hauling-stuck
   gh pr create --fill
   ```
   本文には**何を直したか・なぜそう判断したか（観測した事実）・勝率の前後**を書く。
   AI やバランスを触ったなら 1v1 / 2v2 / 3v3 の数字を必ず添える。
   **衝突を解決したら勝率を測り直す。** 個別に良い変更でも、組み合わせると悪化することがある。
7. `ExitWorktree` で抜ける。PR のレビューとマージは `/review-prs` が行う。

書き方の詳細は `docs/journal/README.md` と `docs/issues/README.md`。

## 改善のループ

改善は担当を分けて回す。**どのループも 1 サイクルで直すのは 1 つ**、
終わりに PR を作り、マージは `/review-prs` が行う。

| ループ | 担当 | 触ってよい | 触らない |
| --- | --- | --- | --- |
| `/improve-seeker` | 鬼の行動 | `src/ai/seeker.ts`、params の seeker 側 | `src/core`、逃げる側 |
| `/improve-hider` | 逃げる側の行動 | `src/ai/hider.ts`、params の hider 側 | `src/core`、鬼側 |
| `/improve-balance` | ゲームルール | `src/core/config.ts`、機能の追加・廃止 | AI の戦術そのもの |
| `/review-prs` | PR の取り込み | 衝突の解決、軽微な修正 | 中身を読まないマージ |

行動の 2 つは**ゲームルールを変えない**。速度や視界を変えないと解けないと判断したら、
config は触らずに `docs/issues/` に issue を立てる。そのとき**行動側で何を試して駄目だったか**を
必ず書く。それが無いとルールを変える判断ができない。

`/improve-balance` はその issue を引き取る唯一のループで、定数の調整に加えて
**機能の追加・廃止**も行う。逆に、行動で解ける問題を issue で受けたら行動側へ差し戻す。

どれを回すべきかの判断は `/improve` が引き受ける。現状を測って担当を選び、
そのループを呼ぶだけの司令塔で、自分ではコードを直さない。
**PR が 2 件以上積まれていれば、まず `/review-prs` を回す**（溜めると衝突が増えるため）。

```bash
/loop /improve           # 司令塔。測って判断し、適切なループを 1 つ回す（通常はこれ）
```

個別に指定して回すこともできる。

```bash
/loop /improve-seeker    # 攻撃側
/loop /improve-hider     # 防御側
/loop /improve-balance   # ゲームバランス
/loop /review-prs        # 積まれた PR を取り込む
```

同時に回すと `src/ai` の同じ場所で衝突するので、各ループは作業前に master を取り込み、
PR 作成前にもう一度取り込む。解決後は**勝率を測り直す**（個別に良い変更でも
組み合わせて悪化することがある）。

master に push されると GitHub Pages へ自動デプロイされる
（<https://murakichi.github.io/hide-seek-3d/>）。PR には CI（型チェック・ビルド・
ヘッドレス対戦）が走る。

## コマンド

```bash
npm run dev                                      # 開発サーバー
npm run build                                    # 型チェック + ビルド
npm run sim   -- --games 24 --hiders 2 --seekers 2   # ヘッドレス対戦で勝率を測る
npm run trace -- --find-loss --interval 5        # 1 試合の展開を詳細ログで見る
npm run tune  -- --side hider --iters 30         # AI パラメータの自動探索
```

AI やバランスを直すときは上の 3 つのループのいずれかの手順に従う
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

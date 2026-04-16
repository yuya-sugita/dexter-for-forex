# Rollout Plan — Renaissance Polymarket Bot

## Phase 概要

| Phase | 名称 | 資本リスク | 実装スコープ | 卒業条件 |
|---|---|---|---|---|
| 0 | 意思決定ドキュメント | ゼロ | 本ドキュメント群 | 全 TODO 項目に決定値が入る |
| 1 | Shadow trading | ゼロ | 読み取り専用パイプライン | 30日完走 + 事前設定の精度基準 |
| 2 | Micro live | 極小 | 執行層追加 | 60日完走 + 正の期待値 |
| 3 | Scaled live | 中 | バンクロール拡大 | 90日安定 + シャープ > 0 |
| 4 | Full autonomy | 大 | 多市場並列 + 自動学習 | 継続的改善 |

## Phase 0: 意思決定ドキュメント（現在）

### 成果物

- [x] `ARCHITECTURE.md`
- [x] `DECISION_POLICY.md`
- [x] `RISK_LIMITS.md`
- [x] `ROLLOUT_PLAN.md` (本ドキュメント)

### 卒業条件

全 TODO 項目に決定値を記入 → **Phase 0 卒業済み**

- [x] 法域確認 → 問題なし
- [x] `INITIAL_BANKROLL` (Phase 2 用) → $200
- [x] `ALLOWED_CATEGORIES` → ["politics"]
- [x] `KILL_SWITCH_DD_PCT` → 40%
- [x] `MAX_POSITION_USD` (Phase 2 用) → $20
- [x] 鍵管理方式 → 暗号化 keystore
- [x] 通知先 → Discord webhook
- [x] `ANALYSIS_INTERVAL_MIN` → 60分
- [x] `MIN_EDGE` → 0.05 (5%)
- [x] `CONFLUENCE_THRESHOLD` → 4/6

## Phase 1: Shadow Trading

### 目的

実市場データで全パイプラインを走らせ、**実際にベットせずに**判断
ロジックの品質を検証する。

### 実装スコープ

- `src/bot/` の全コンポーネント（executor.ts は dry-run モード）
- Gamma API からの市場データ取得（読み取りのみ）
- 6エージェントの JSON 出力モード実装
- Decision Gate のフル判定ロジック
- `.sapiens/bot/shadow/decisions.jsonl` への判断ログ出力
- 日次メトリクス集計

### ウォレット

不要。Gamma API は公開 API で認証不要。

### 日次オペレーション

1. bot を起動: `bun run src/bot/index.ts --phase 1`
2. `ANALYSIS_INTERVAL_MIN` ごとに自動分析サイクル
3. 判断は shadow log に記録（「もしベットしたら」の仮想ポジション）
4. 解決時に仮想 PnL を計算

### 追跡メトリクス

| メトリクス | 計算方法 | 意味 |
|---|---|---|
| 仮想ベット数/日 | count(decision == EXECUTE) | ボリュームの妥当性 |
| 仮想勝率 | wins / total resolved | エッジの存在確認 |
| 仮想 ROI | sum(pnl) / sum(cost_basis) | 期待値の符号 |
| コンフルエンス分布 | histogram(confluence_count) | エージェント一致頻度 |
| SKIP 理由分布 | histogram(skip_reason) | パイプラインの絞り具合 |
| edge 分布 | histogram(edge) | エッジの大きさ |
| 仮想シャープ | mean(daily_pnl) / std(daily_pnl) × √252 | リスク調整後リターン |

### 卒業条件（Phase 1 → Phase 2）

以下の**全て**を満たすこと:

1. **30日以上**完走（途中のバグ修正・再起動はカウントリセット）
2. **仮想勝率 > 50%**（resolved ベットのうち勝ちが過半数）
3. **仮想 ROI > 0%**（全期間で正の期待値）
4. **kill switch 未発動**（仮想 DD が KILL_SWITCH_DD_PCT 未満）
5. **エージェント診断のエラー率 < 5%**（JSON パース失敗・タイムアウト）
6. **コンフルエンス 4+ の割合 > 20%**（分析した市場のうち十分な数が
   コンフルエンスに達する）

卒業判定は**手動**で行う。自動昇格しない。

### ロールバック条件

- 仮想 DD > KILL_SWITCH_DD_PCT が 7日連続 → パイプラインにバグの
  可能性。修正してカウントリセット。
- エージェント診断エラーが 20% を超える → SKILL.md の JSON 出力
  契約を修正してからリスタート。

## Phase 2: Micro Live

### 目的

超小額の実資金で**執行層の正しさ**を検証する。判断ロジックの検証は
Phase 1 で完了している前提。

### 実装追加スコープ

- `executor.ts` を live モードに切り替え
- Polymarket CLOB API への注文発行
- ウォレット署名（暗号化 keystore）
- 実ポジション追跡（`.sapiens/bot/positions/`）
- 実 PnL 計算
- 手動レビュー用の daily summary 出力

### バンクロール

`INITIAL_BANKROLL` = **TODO** (推奨: $50-200)

### 日次オペレーション

1. bot を起動: `bun run src/bot/index.ts --phase 2`
2. `ANALYSIS_INTERVAL_MIN` ごとに自動分析 + 実注文
3. **毎日、全ポジションと当日の判断を手動レビュー**（Phase 2 の義務）
4. レビューで異常があれば即 kill switch

### 追跡メトリクス（Phase 1 に加えて）

| メトリクス | 意味 |
|---|---|
| 実 PnL (USD) | 実損益 |
| 実 DD (%) | バンクロール最大ドローダウン |
| 執行成功率 | 注文発行 → 約定の成功率 |
| スリッページ実測 | 想定価格 vs 約定価格の差 |
| ガスコスト累計 | Polygon ガス代の実績 |

### 卒業条件（Phase 2 → Phase 3）

1. **60日以上**完走
2. **実 ROI > 0%**
3. **実 DD < KILL_SWITCH_DD_PCT**
4. **執行成功率 > 95%**
5. **スリッページが Phase 1 の仮想推定値の 2倍以内**
6. **手動レビューで致命的異常ゼロ**（「この判断はバグ」がない）

### ロールバック条件

- 実 DD > L3_DD_PCT → Phase 2 を停止し、Phase 1 に戻って
  30日の shadow を再実施
- 執行エラー（注文が意図しないサイズで通った等）→ 即停止、
  executor.ts を修正してから Phase 1 へ戻る

## Phase 3: Scaled Live

### 目的

バンクロールを段階的に拡大し、**多市場での安定運用**を検証する。

### 変更点

- `INITIAL_BANKROLL` を Phase 2 の 5-10 倍に拡大
- `MAX_POSITION_USD` を引き上げ
- `ALLOWED_CATEGORIES` を追加（2-3 カテゴリ）
- 手動レビューを日次 → **週次**に緩和
- 自動アラートの精度を上げる

### 卒業条件（Phase 3 → Phase 4）

1. **90日以上**完走
2. **仮想シャープ > 0**（リスク調整後で正）
3. **月次で3ヶ月連続プラス**（または2/3ヶ月プラス）
4. **kill switch 未発動**
5. **ポストモーテムの失敗モード分布が安定**（新しい失敗モードが
   出現しなくなっている）
6. **α 縮小の発動と復帰が少なくとも1回正常に機能した**

## Phase 4: Full Autonomy

### 目的

Renaissance の最終形。人間の介入は月次レビューのみ。

### 変更点

- 全カテゴリ解禁
- バンクロールを目標水準に
- ポストモーテムからの新ルール候補を半自動で評価（MC 検証は自動、
  採用は手動承認 → 将来は自動化も検討）
- エージェント性能の月次評価（どのエージェントの診断が最も寄与
  したかを `outsider-cryptanalyst` 的に頻度分析）

### 月次レビュー項目

1. `get_position_stats` 相当のパフォーマンスサマリ
2. 失敗モード別ヒストグラム（Prompt 7）
3. エージェント別の診断正答率
4. 堀の深さベクトル (n, κ) の記録（Prompt 10）
5. 新ルール候補のレビューと採否決定
6. パラメータ調整（あれば）— 変更は1次元ずつ（Prompt 6）

### ロールバック条件

- 月次で2ヶ月連続マイナス → Phase 3 に戻る
- kill switch 発動 → Phase 2 に戻る（60日再検証）

## 全 Phase 共通ルール

1. **Phase 間の移行は手動判断**。自動昇格しない。
2. **ロールバックは即座に実行可能**。1コマンドで Phase N → Phase M
   に戻せる設計にする。
3. **各 Phase のメトリクスは永続化**する。Phase 間の比較が可能。
4. **コードの変更は Phase 1 で shadow 検証してから live に反映**。
   Phase 2+ で直接コードを変更して走らせない。
5. **Prompt 4 の完全適用**: bot のパラメータを「今回だけ」変更しない。
   変更するなら `config.json` を更新し、Phase 1 で検証してから反映。

## 時間軸（宣言的、日付は約束しない）

```
Phase 0: 即日（本ドキュメント完成）
Phase 1: TODO 決定後 1-2 週間で実装開始、30日完走
Phase 2: Phase 1 卒業後、60日完走
Phase 3: Phase 2 卒業後、90日安定
Phase 4: Phase 3 卒業後、継続的改善
```

最短でも Phase 2 の実資金投入まで **2-3 ヶ月**。これは Renaissance の
Prompt 1（データを見てから判断）と Prompt 7（失敗から学習）を bot
自体のロールアウトに適用した結果であり、短縮は哲学違反。

# Risk Limits — Renaissance Polymarket Bot

## バンクロール構造

```
TOTAL_BANKROLL (ウォレット内 USDC 残高)
├── AVAILABLE = TOTAL - オープンポジションの合計 cost basis
├── AT_RISK   = オープンポジションの合計 cost basis
└── PNL       = TOTAL - INITIAL_BANKROLL
```

`INITIAL_BANKROLL` は Phase 開始時にウォレットに入金した額。DD は
`(INITIAL_BANKROLL - TOTAL_BANKROLL) / INITIAL_BANKROLL × 100` で計算。

## 1ベット制約

| 制約 | デフォルト案 | 説明 |
|---|---|---|
| `MAX_POSITION_USD` | $50 | 1ポジションの絶対上限（Phase 2） |
| `MAX_POSITION_PCT` | 10% | バンクロール比の上限 |
| `MIN_POSITION_USD` | $1 | 最小ベット（Polymarket 最小単位考慮） |

**ケリー計算の結果がこの制約を超えた場合、制約値にキャップする。**
逆に MIN 未満なら SKIP。

Phase ごとの上限:

| Phase | MAX_POSITION_USD | MAX_POSITION_PCT |
|---|---|---|
| 1 (shadow) | — (執行なし) | — |
| 2 (micro) | $20 | 10% |
| 3 (scaled) | $200 | 5% |
| 4 (full) | $1,000 | 3% |

## 損失制約

| 制約 | デフォルト案 | 判定タイミング |
|---|---|---|
| `DAILY_LOSS_LIMIT_USD` | bankroll × 5% | 毎サイクル冒頭 |
| `WEEKLY_LOSS_LIMIT_USD` | bankroll × 10% | 毎日 00:00 UTC |
| `MONTHLY_LOSS_LIMIT_USD` | bankroll × 20% | 毎週月曜 00:00 UTC |
| `KILL_SWITCH_DD_PCT` | 40% | 毎サイクル冒頭 |

日次・週次・月次の損失が限度に達した場合:
- 日次 → その日の新規執行を停止、翌日自動復帰
- 週次 → その週の新規執行を停止、翌週自動復帰
- 月次 → その月の新規執行を停止、翌月自動復帰
- DD → kill switch 発動（手動復帰のみ）

## 集中リスク制約

| 制約 | デフォルト案 | 説明 |
|---|---|---|
| `MAX_OPEN_POSITIONS` | 10 | 同時オープンポジション数 |
| `MAX_CATEGORY_PCT` | 50% | 1カテゴリへの最大配分 |
| `MAX_CORRELATED_POSITIONS` | 3 | 相関 > 0.5 の市場への同時ポジション |

相関判定は `get_correlation_markets` の出力を使用。サブ市場
（同一イベントの候補別市場）は自動的に相関ありと見なす。

## スリッページ・執行コスト

- Polymarket のテイカー手数料: 約 1-2%（市場状況による）
- スリッページ推定: オーダーブック深度の上位 $100 の加重平均価格 vs
  mid price の差
- **執行コスト込みのエッジ**: `net_edge = edge - estimated_slippage - taker_fee`
- `net_edge < MIN_EDGE` なら SKIP

## 時間制約

| 制約 | デフォルト案 | 説明 |
|---|---|---|
| `MIN_DAYS_TO_RESOLVE` | 3日 | 解決日が近すぎる市場を避ける |
| `MAX_DAYS_TO_RESOLVE` | 180日 | 資本ロックが長すぎる市場を避ける |
| `MAX_HOLDING_DAYS` | 90日 | 保有期間上限（超えたらレビュー対象） |

`MAX_HOLDING_DAYS` 超過時:
- 自動クローズ**しない**（Prompt 4: 上書き禁止）
- alert で通知し、手動レビューを促す
- 次サイクルの Monitor で再評価対象にマーク

## 緊急停止と再起動

### 停止方法（3つ）

1. **自動**: kill switch 条件（DD / 日次損失 / 連続損失 / API エラー）
2. **半手動**: `.sapiens/bot/KILL_SWITCH` ファイルを作成
3. **完全手動**: プロセスを Ctrl+C / kill

### 再起動手順

1. 停止原因を `.sapiens/bot/state.json` で確認
2. 原因を Prompt 7 ポストモーテムで分析（手動）
3. 必要に応じて `config.json` のパラメータを調整
4. `.sapiens/bot/KILL_SWITCH` を削除
5. `bun run src/bot/index.ts --phase N` で再起動
6. 最初の1サイクルは必ず shadow モードで走らせて正常性確認

## ウォレット・鍵管理

**`.env` に秘密鍵を平文で保存しない。**

推奨（Phase 順）:

| Phase | 鍵管理 |
|---|---|
| 1 (shadow) | 不要（読み取りのみ） |
| 2 (micro) | 暗号化 keystore ファイル + パスフレーズ（起動時に入力） |
| 3+ (scaled) | ハードウェアウォレット署名 or AWS KMS |

秘密鍵がメモリ上に存在する時間を最小化する。署名処理の直前にのみ
復号し、署名後に即座にメモリからクリアする。

## 確定パラメータ

| 項目 | 決定値 |
|---|---|
| `INITIAL_BANKROLL` | $200 (Phase 2) |
| `MAX_POSITION_USD` | $20 (Phase 2) |
| `KILL_SWITCH_DD_PCT` | 40% |
| `ALLOWED_CATEGORIES` | ["politics"] |
| 鍵管理方式 | 暗号化 keystore (Phase 2) |
| 通知先 | Discord webhook |
| 法域 | 確認済み・問題なし |

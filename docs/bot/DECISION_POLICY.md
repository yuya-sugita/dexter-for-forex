# Decision Policy — Renaissance Polymarket Bot

## 判断フロー全体

```
市場発見 → フィルタ → 6エージェント診断 → コンフルエンス判定
→ エッジ計算 → サイズ算出 → ゲート通過判定 → 執行 or SKIP
```

すべての判断は**決定論的**。同じ入力に対して同じ出力を返す。
乱数を使う箇所（MC シミュレーション）は seed を固定して再現可能にする。

## 1. 市場選定フィルタ

`list_markets` の結果に以下のフィルタを順次適用:

| フィルタ | 条件 | 理由 |
|---|---|---|
| 流動性 | 24h volume > `MIN_LIQUIDITY` | 執行不可能な市場を除外 |
| 解決日距離 | days_to_resolve > `MIN_DAYS_TO_RESOLVE` | 直前の高ノイズ市場を回避 |
| カテゴリ | category in `ALLOWED_CATEGORIES` | 対象を限定して開始 |
| 重複回避 | 直近 `COOLDOWN_HOURS` 時間以内に分析済みなら SKIP | API 負荷と重複排除 |
| ポジション保有 | 既にオープンポジションがある市場は再分析しない | Monitor ループが担当 |

フィルタを通過した市場を volume 降順でソートし、上位
`MAX_MARKETS_PER_CYCLE` 件を分析キューに入れる。

**特殊ケース禁止 (Prompt 11)**: 「この市場だけフィルタを緩める」は
不可。フィルタは全市場に同一条件で適用する。

## 2. 6エージェント呼び出し規約

各市場に対し、以下の順序で6エージェントを呼び出す:

1. `outsider-mathematician`
2. `outsider-physicist`
3. `outsider-astronomer`
4. `outsider-speech-recognition`
5. `outsider-cryptanalyst`
6. `quant-analyst` (5人の出力を入力として受け取る)

- 順次実行（並列禁止、Prompt 1 準拠）
- 各エージェントは `OutsiderDiagnosis` / `QuantDiagnosis` の JSON を返す
- 1エージェントがエラーの場合: その市場の分析を中断し SKIP。
  部分的なコンフルエンスで判断しない（Prompt 11: 継ぎはぎ禁止）

## 3. コンフルエンスルール

5人の異邦人の `direction` (YES / NO / NEUTRAL) を集計:

| 一致数 | 判定 | アクション |
|---|---|---|
| 5/5 | **強コンフルエンス** | 通常サイズで執行候補 |
| 4/5 | **コンフルエンス** | 通常サイズで執行候補 |
| 3/5 | **弱コンフルエンス** | `WEAK_CONFLUENCE_FRACTION` 倍のサイズ |
| 2/5 以下 | **コンフルエンスなし** | SKIP（Prompt 3: 判断保留） |
| NEUTRAL が 3+ | **診断不能** | SKIP |

`CONFLUENCE_THRESHOLD` のデフォルト: **4** (変更可能)。
`WEAK_CONFLUENCE_FRACTION` のデフォルト: **0.5** (3/5 一致時のサイズ係数)。

## 4. エッジ計算

クオンツアナリストが算出する `edge = |estimated_true_prob - market_price|`。

| 条件 | 判定 |
|---|---|
| edge >= `MIN_EDGE` | 執行候補 |
| edge < `MIN_EDGE` | SKIP（執行コストで消える） |

`MIN_EDGE` のデフォルト: **0.05** (5%)。

edge が大きいほどケリー比も大きくなるが、**推定真確率の信頼度**が
低い場合（事前分布が広い、データが少ない）は edge が見かけ上大きくても
ケリー比を信頼しない。クオンツアナリストの `confidence` が 0.6 未満
の場合、サイズを `LOW_CONFIDENCE_FRACTION` 倍に縮小。

`LOW_CONFIDENCE_FRACTION` のデフォルト: **0.5**。

## 5. ケリーサイジング

バイナリ賭けのケリー基準:

```
f* = (p - q) / (1 - q)    # YES を買う場合
f* = (q - p) / q           # NO を買う場合（= YES を売る場合）

p = estimated_true_prob
q = market_price
```

**使用するケリー分数**:

```
recommended_fraction = f* × KELLY_DIVISOR × confluence_modifier × confidence_modifier × α

KELLY_DIVISOR = 4          # quarter-Kelly がデフォルト
confluence_modifier:
  5/5 → 1.0
  4/5 → 1.0
  3/5 → WEAK_CONFLUENCE_FRACTION (0.5)
confidence_modifier:
  quant confidence >= 0.6 → 1.0
  quant confidence <  0.6 → LOW_CONFIDENCE_FRACTION (0.5)
α = 現在の Prompt 8 縮小レベル (1.0 / 0.75 / 0.5 / 0.25 / 0.0)
```

**ポジションサイズ（USD）**:

```
position_size = bankroll × recommended_fraction
position_size = min(position_size, MAX_POSITION_USD)
position_size = min(position_size, bankroll × MAX_POSITION_PCT / 100)
```

## 6. α 縮小レベル（Prompt 8 自動発動）

| レベル | α | 発動条件 |
|---|---|---|
| 通常 | 1.00 | デフォルト |
| L1 警戒 | 0.75 | bankroll DD > `L1_DD_PCT` or 連敗 >= `L1_CONSECUTIVE_LOSSES` |
| L2 縮小 | 0.50 | bankroll DD > `L2_DD_PCT` or 連敗 >= `L2_CONSECUTIVE_LOSSES` |
| L3 防衛 | 0.25 | bankroll DD > `L3_DD_PCT` |
| L4 停止 | 0.00 | bankroll DD > `KILL_SWITCH_DD_PCT` → kill switch 発動 |

**復帰は段階的**（L3 → L2 → L1 → 通常）:

- 復帰条件: bankroll DD が1段下のレベルの DD 未満に回復 **かつ**
  直近 `RECOVERY_WINS` 回のうち過半数が勝ち
- 一気に L3 → 通常 に戻さない（Prompt 8: 段階的・機械的復帰）

## 7. kill switch 条件

以下のいずれかで即時停止:

1. bankroll DD > `KILL_SWITCH_DD_PCT`
2. 日次損失 > `DAILY_LOSS_LIMIT_USD`
3. 連続損失 >= `MAX_CONSECUTIVE_LOSSES`
4. API 連続エラー >= `CONSECUTIVE_API_ERRORS`
5. 手動: `.sapiens/bot/KILL_SWITCH` ファイル存在

発動時の挙動:
- 新規分析・執行を停止
- オープンポジションは**触らない**（Prompt 4: 上書き禁止）
- 通知送信
- 復帰は**手動のみ**

## 8. 既存ポジションへの影響ルール

- 新規分析で「既にポジション保有中の市場」を再分析しない
- ポジション追加（ナンピン）禁止。1市場1ポジション
- ポジション縮小は α で一律適用（Prompt 8）、個別縮小は禁止
- 解決済み市場は自動精算（mark_resolved）

## TODO: ユーザーが決定する数値

| パラメータ | デフォルト案 | 説明 |
|---|---|---|
| `MIN_LIQUIDITY` | $5,000 | 24h出来高の最低ライン |
| `MIN_DAYS_TO_RESOLVE` | 3 | 解決日までの最短日数 |
| `ALLOWED_CATEGORIES` | ["politics"] | 最初は1カテゴリ |
| `COOLDOWN_HOURS` | 12 | 同一市場の再分析禁止時間 |
| `MAX_MARKETS_PER_CYCLE` | 5 | 1サイクルあたり最大分析数 |
| `CONFLUENCE_THRESHOLD` | 4 | 最小コンフルエンスエージェント数 |
| `MIN_EDGE` | 0.05 | 最小エッジ (5%) |
| `KELLY_DIVISOR` | 4 | ケリー分数の除数 (quarter-Kelly) |
| `L1_DD_PCT` | 10 | L1 警戒の DD% |
| `L2_DD_PCT` | 20 | L2 縮小の DD% |
| `L3_DD_PCT` | 30 | L3 防衛の DD% |
| `KILL_SWITCH_DD_PCT` | 40 | kill switch の DD% |
| `DAILY_LOSS_LIMIT_USD` | (bankroll × 5%) | 日次損失限度 |
| `MAX_CONSECUTIVE_LOSSES` | 5 | kill switch 連続損失回数 |
| `RECOVERY_WINS` | 5 | 復帰判定の直近ベット数 |
| `ANALYSIS_INTERVAL_MIN` | 60 | 分析ループ間隔（分） |
| `MONITOR_INTERVAL_MIN` | 15 | 監視ループ間隔（分） |

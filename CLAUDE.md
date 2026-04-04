# Sapiens - Claude Code Integration

Sapiens はFX・株価指数・コモディティの定量トレード分析エージェント。Fintokei最適化。
Claude Code上では、`src/tool-runner.ts` を通じてすべてのツールを直接呼び出せる。

## セットアップ

```bash
# 依存関係（インストール済み）
bun install --ignore-scripts

# .env にTWELVE_DATA_API_KEYを設定（市場データ用、必須）
# 無料キー取得: https://twelvedata.com/
```

## ツール実行方法

```bash
# ツール一覧
bun run src/tool-runner.ts list

# ツール呼び出し
bun run src/tool-runner.ts call <tool_name> '<json_args>'

# ツールスキーマ詳細
bun run src/tool-runner.ts describe <tool_name>

# スキル一覧
bun run src/tool-runner.ts skills

# スキル手順表示
bun run src/tool-runner.ts skill <skill_name>
```

## 利用可能なツール

### 市場データ（Twelve Data API経由）

| ツール | 説明 | 必須引数 |
|--------|------|----------|
| `get_price` | リアルタイム価格クオート | `symbol` (例: "EUR/USD", "XAUUSD", "US30") |
| `get_price_history` | ヒストリカルOHLCVデータ | `symbol`, `interval` ("1min"〜"1month"), `outputsize`(default:30) |
| `list_instruments` | 対応銘柄一覧 | `category` ("all"/"fx_major"/"fx_minor"/"index"/"commodity") |
| `get_technical_indicator` | テクニカル指標計算 | `symbol`, `indicator` (sma/ema/rsi/macd/bbands/stoch/atr/adx/ichimoku等), `interval` |
| `get_multi_indicators` | 複数指標同時計算 | `symbol`, `interval`, `indicators` ([{name, time_period}]) |

### 統計分析

| ツール | 説明 | 必須引数 |
|--------|------|----------|
| `get_zscore` | z-score、パーセンタイル、平均回帰確率 | `symbol`, `interval`, `lookback` |
| `get_correlation_matrix` | 2-8銘柄のリターン相関行列 | `symbols` (配列), `interval` |
| `get_return_distribution` | 歪度/尖度/VaR/CVaR/Hurst/自己相関/JB検定 | `symbol`, `interval`, `lookback` |
| `get_volatility_regime` | ボラティリティレジーム(LOW/NORMAL/HIGH/CRISIS) | `symbol`, `interval` |
| `get_cointegration` | Engle-Granger共和分検定（ペアトレード用） | `symbolA`, `symbolB`, `interval` |
| `get_drawdown_analysis` | ドローダウン分析（最大DD/回復時間/頻度分布） | `symbol`, `interval`, `lookback` |
| `get_rolling_sharpe` | ローリングシャープレシオの推移 | `symbol`, `interval`, `lookback`, `window` |

### マクロ・計量経済分析

| ツール | 説明 | 必須引数 |
|--------|------|----------|
| `get_rate_differential` | 金利差・政策ダイバージェンス | `baseCurrency`, `quoteCurrency` |
| `get_macro_regime` | GDP/PMI/CPI/失業率からのマクロレジーム | `country` (例: "US", "JP") |
| `get_cross_asset_regime` | クロスアセットリスクオン/オフ検出 | (引数なし) |
| `get_yield_curve` | イールドカーブ分析（逆転検出/スプレッド） | `country` ("US"/"GB"/"JP"/"EU") |
| `get_macro_divergence` | 2経済圏のマクロ乖離スコア（FX方向性） | `baseCurrency`, `quoteCurrency` |
| `get_seasonal_pattern` | 月別/四半期別の季節性パターン | `symbol`, `yearsBack` |

### クオンツ戦略

| ツール | 説明 | 必須引数 |
|--------|------|----------|
| `backtest_strategy` | 戦略バックテスト(SMA/z-score/RSI/Bollinger/Donchian) | `symbol`, `strategy`, `interval` |
| `monte_carlo_simulation` | Fintokeiチャレンジのモンテカルロシミュレーション | `winRate`, `avgWinPct`, `avgLossPct`, `tradesPerDay` 等 |
| `calculate_expected_value` | 確率加重シナリオの期待値 | `scenarios` 配列 |
| `walk_forward_test` | ウォークフォワード分析（アウトオブサンプル検証） | `symbol`, `strategy`, `interval`, `numFolds` |
| `calculate_risk_of_ruin` | 破産確率の解析計算+MC検証 | `winRate`, `avgWinPct`, `avgLossPct`, `ruinThresholdPct` |
| `compare_strategies` | 複数戦略の同一銘柄比較ランキング | `symbol`, `strategies` (配列), `interval` |

### 経済カレンダー

| ツール | 説明 | 必須引数 |
|--------|------|----------|
| `get_economic_calendar` | 経済イベントカレンダー | `start_date`(optional), `country`(optional), `importance`(optional) |

### Fintokeiルール・リスク管理

| ツール | 説明 | 必須引数 |
|--------|------|----------|
| `get_fintokei_rules` | チャレンジルール(利益目標/DD制限等) | `plan` (例: "ProTrader") |
| `calculate_position_size` | ケリー基準ポジションサイジング | `symbol`, `account_balance`, `risk_per_trade` 等 |
| `check_account_health` | アカウントヘルス評価 | `account_balance`, `initial_balance`, `daily_pnl` 等 |

### トレードジャーナル

| ツール | 説明 | 必須引数 |
|--------|------|----------|
| `record_trade` | トレード記録 | `symbol`, `direction`, `entry_price`, `size` 等 |
| `close_trade` | トレード決済 | `trade_id`, `exit_price` |
| `get_trade_stats` | Sharpe/Sortino/Kelly等パフォーマンス統計 | (引数なし) |
| `get_trade_history` | トレード履歴 | `status`(optional: "open"/"closed"), `symbol`(optional) |

### その他

| ツール | 説明 |
|--------|------|
| `web_fetch` | URLからコンテンツ取得 |

## API制限

Twelve Data無料プラン: **8リクエスト/分、800リクエスト/日**。
ツール呼び出しは1つずつ順番に実行し、結果を待ってから次へ進む。
レート制限は`src/tools/forex/api.ts`で自動管理される。

## 銘柄シンボル

- **FXメジャー:** EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, USD/CAD, NZD/USD
- **FXマイナー:** EUR/GBP, EUR/JPY, GBP/JPY, AUD/JPY 他
- **指数:** JP225(日経), US30(ダウ), US500(S&P), NAS100(ナスダック), GER40(DAX), UK100(FTSE)
- **コモディティ:** XAUUSD(金), XAGUSD(銀), USOIL(WTI), UKOIL(ブレント)
- エイリアス: gold→XAUUSD, DOW→US30, NIKKEI→JP225, EURUSD→EUR/USD

## スキル（多段階ワークフロー）

スキルは定量分析の手順書。`bun run src/tool-runner.ts skill <name>` で手順を表示し、
各ステップで対応するツールを順次呼び出す。

| スキル | トリガー |
|--------|----------|
| `trade-analysis` | トレード分析、セットアップ評価、エッジ探索 |
| `fintokei-challenge` | チャレンジ通過確率、最適戦略 |
| `risk-management` | ポジションサイジング、ケリー基準 |
| `daily-routine` | 日次ルーティン、デイリーチェック |

## 使用例

```bash
# EUR/USDの現在価格
bun run src/tool-runner.ts call get_price '{"symbol":"EUR/USD"}'

# 金の日足RSI
bun run src/tool-runner.ts call get_technical_indicator '{"symbol":"XAUUSD","indicator":"rsi","interval":"1day"}'

# USD/JPYの統計レジーム判定
bun run src/tool-runner.ts call get_return_distribution '{"symbol":"USD/JPY","interval":"1day","lookback":252}'

# 来週の高インパクト経済イベント
bun run src/tool-runner.ts call get_economic_calendar '{"importance":"high"}'

# ゴールドのSMAクロスバックテスト
bun run src/tool-runner.ts call backtest_strategy '{"symbol":"XAUUSD","strategy":"sma_crossover","interval":"1day"}'

# EUR/USDとGBP/USDの共和分検定（ペアトレード）
bun run src/tool-runner.ts call get_cointegration '{"symbolA":"EUR/USD","symbolB":"GBP/USD","interval":"1day"}'

# USD/JPYのドローダウン分析
bun run src/tool-runner.ts call get_drawdown_analysis '{"symbol":"USD/JPY","interval":"1day","lookback":504}'

# 米国イールドカーブ分析
bun run src/tool-runner.ts call get_yield_curve '{"country":"US"}'

# EUR vs USDのマクロ乖離スコア
bun run src/tool-runner.ts call get_macro_divergence '{"baseCurrency":"EU","quoteCurrency":"US"}'

# XAUUSDの季節性パターン
bun run src/tool-runner.ts call get_seasonal_pattern '{"symbol":"XAUUSD","yearsBack":5}'

# 5戦略の比較ランキング
bun run src/tool-runner.ts call compare_strategies '{"symbol":"EUR/USD","strategies":["sma_crossover","mean_reversion_zscore","momentum_rsi","bollinger_breakout","donchian_channel"],"interval":"1day"}'

# ウォークフォワード分析（オーバーフィット検出）
bun run src/tool-runner.ts call walk_forward_test '{"symbol":"EUR/USD","strategy":"mean_reversion_zscore","interval":"1day","numFolds":5}'

# 破産確率計算
bun run src/tool-runner.ts call calculate_risk_of_ruin '{"winRate":0.55,"avgWinPct":1.5,"avgLossPct":-1.0,"ruinThresholdPct":10}'
```

## Sapiens哲学

- データ > ナラティブ: 定量分析に裏付けられた統計的厳密さ
- プロセス > 予測: エッジの検証に集中、方向性の当てずっぽうはしない
- リスクファースト: ケリー基準とドローダウンモデリングを最優先
- 再現可能: すべての方法論、パラメータ、データソースを開示

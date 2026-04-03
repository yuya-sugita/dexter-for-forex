# Sapiens Mobile - Architecture Spec

Fintokei最適化モバイルトレードターミナル（Bloomberg Terminal → Mobile）

## システム構成

```
┌─────────────────────────┐
│   iOS App (Expo/RN)     │
│   sapiens-mobile/       │
└────────┬────────────────┘
         │ HTTPS / WebSocket
         ▼
┌─────────────────────────┐
│   Mac VPS               │
│  ┌───────────────────┐  │
│  │ API Gateway        │  │  Express/Hono server
│  │ (Node.js)         │  │  認証 + ルーティング
│  └──┬──────────┬─────┘  │
│     │          │         │
│     ▼          ▼         │
│  ┌──────┐  ┌────────┐   │
│  │Claude│  │Trading │   │
│  │Code  │  │View    │   │
│  │(CLI) │  │(CDP)   │   │
│  └──┬───┘  └───┬────┘   │
│     │          │         │
│     ▼          ▼         │
│  ┌──────────────────┐   │
│  │ Sapiens Tools    │   │  tool-runner.ts
│  │ (33 tools)       │   │  (Twelve Data API)
│  └──────────────────┘   │
└─────────────────────────┘
```

## VPS側 API Gateway

### エンドポイント設計

```
POST /api/v1/tool          # Sapiens tool呼び出し
  body: { tool: string, args: object }
  → bun run src/tool-runner.ts call <tool> '<args>'

POST /api/v1/tv            # TradingView MCP操作
  body: { action: string, params: object }
  → TradingView CDPコマンド実行

POST /api/v1/chat          # Claude Code対話（自然言語分析依頼）
  body: { message: string }
  → Claude Code CLIにパイプ、ストリーミング応答

GET  /api/v1/stream        # WebSocket: リアルタイム価格・アラート
  → TradingView quote_get ポーリング → クライアントへpush

GET  /api/v1/health        # ヘルスチェック
  → TradingView接続状態 + API残量
```

### 認証

- APIキーベース（シンプル、VPSは個人所有）
- `Authorization: Bearer <API_KEY>` ヘッダ
- 環境変数 `SAPIENS_API_KEY` でVPS側に設定

---

## 画面設計（5 tabs + Claude Chat）

### Tab 1: Dashboard（GMM + BTMM相当）

**目的**: 朝30秒でグローバル市場の全体像を把握

```
┌─────────────────────────────┐
│ SAPIENS          09:32 JST  │
├─────────────────────────────┤
│ ■ FX Majors                 │
│ EUR/USD  1.0842  ▲+0.12%   │
│ GBP/USD  1.2956  ▼-0.08%   │
│ USD/JPY  151.23  ▲+0.34%   │
│ AUD/USD  0.6534  ▼-0.21%   │
│                              │
│ ■ Indices                    │
│ US500    5,287   ▲+0.45%   │
│ JP225    38,420  ▼-0.67%   │
│ GER40    18,234  ▲+0.15%   │
│                              │
│ ■ Commodities               │
│ XAUUSD   2,341   ▲+0.89%  │
│ USOIL    78.45   ▼-1.23%  │
│                              │
│ ■ Rate Environment           │
│ US 10Y-2Y  +42bps  NORMAL  │
│ Fed Rate   4.50%  cutting   │
│ BOJ Rate   0.50%  hiking    │
│                              │
│ ■ Risk Regime                │
│ Cross-Asset: RISK_ON (+0.4) │
│ VIX Proxy:  LOW              │
└─────────────────────────────┘
```

**データソース**:
- `get_price` × 主要銘柄 (TradingView `quote_get` で代替可)
- `get_cross_asset_regime`
- `get_yield_curve` (US)
- `get_rate_differential`

**更新頻度**: 起動時 + プルダウンリフレッシュ + 5分自動更新

---

### Tab 2: Analysis（統計分析 + ボラティリティ）

**目的**: 個別銘柄の定量分析ダッシュボード

```
┌─────────────────────────────┐
│ EUR/USD Analysis      1D    │
├─────────────────────────────┤
│ ┌─── TradingView Chart ───┐ │
│ │   (screenshot embed)    │ │
│ │   or WebView            │ │
│ └─────────────────────────┘ │
│                              │
│ ■ Statistical Regime         │
│ Hurst: 0.43 MEAN_REVERTING  │
│ Z-Score: -1.82 (8th pctl)   │
│ ACF(1): -0.12 (significant) │
│                              │
│ ■ Volatility Regime          │
│ Current: NORMAL (62nd pctl)  │
│ 10d Vol: 8.2%  30d: 7.8%   │
│ Term Structure: FLAT         │
│                              │
│ ■ Risk Metrics               │
│ VaR(95): -0.82%             │
│ CVaR(95): -1.14%            │
│ Max DD (1Y): -4.23%         │
│                              │
│ [Run Full Analysis]          │
│ [Compare Strategies]         │
└─────────────────────────────┘
```

**データソース**:
- `get_return_distribution`
- `get_volatility_regime`
- `get_zscore`
- `get_drawdown_analysis`
- `get_rolling_sharpe`
- TradingView `capture_screenshot` / `chart_get_state`

**銘柄選択**: 上部ドロップダウンまたはDashboardからタップ遷移

---

### Tab 3: Macro（マクロ + イベントリスク）

**目的**: 金利差、マクロレジーム、経済カレンダーの統合ビュー

```
┌─────────────────────────────┐
│ Macro Intelligence           │
├─────────────────────────────┤
│ ■ Rate Differentials         │
│ EUR vs USD  -1.85%  cutting  │
│ GBP vs USD   0.00%  cutting  │
│ USD vs JPY  +4.00%  diverge  │
│ AUD vs USD  -0.40%  holding  │
│                              │
│ ■ Macro Regimes              │
│ 🇺🇸 US: EXPANSION (HIGH)     │
│ 🇪🇺 EU: SLOWDOWN (MOD)       │
│ 🇯🇵 JP: RECOVERY (MOD)       │
│                              │
│ ■ Yield Curves               │
│ US: NORMAL (+42bps)          │
│ JP: FLAT (+8bps)             │
│                              │
│ ■ Upcoming Events (HIGH)     │
│ Apr 4  US NFP        🔴      │
│ Apr 10 FOMC Minutes  🔴      │
│ Apr 11 ECB Decision  🔴      │
│                              │
│ ■ Seasonal (Current Month)   │
│ XAUUSD Apr: +1.2% (70% win) │
│ EUR/USD Apr: -0.3% (40% win)│
└─────────────────────────────┘
```

**データソース**:
- `get_rate_differential` × 主要通貨
- `get_macro_regime` × US, EU, JP, GB
- `get_yield_curve` × US, JP
- `get_economic_calendar` (importance: high)
- `get_seasonal_pattern`
- `get_macro_divergence`

---

### Tab 4: Risk（PORT相当 - Fintokeiアカウント管理）

**目的**: チャレンジ通過確率とリスク管理の定量化

```
┌─────────────────────────────┐
│ Fintokei Risk Console        │
├─────────────────────────────┤
│ ■ Account Health             │
│ Plan: ProTrader Phase 1      │
│ Balance: ¥5,120,000          │
│ Initial: ¥5,000,000          │
│ P&L: +¥120,000 (+2.4%)      │
│                              │
│ ▓▓▓▓▓▓▓░░░░░░░░░  2.4%/8%  │
│ Profit Target Progress       │
│                              │
│ ■ Drawdown Status            │
│ Daily DD:  -0.3% / -5.0%    │
│ ░▒░░░░░░░░░░░░░░░  OK       │
│ Total DD:  -0.8% / -10.0%   │
│ ░▒░░░░░░░░░░░░░░░  OK       │
│                              │
│ ■ Monte Carlo Forecast       │
│ P(Pass): 62.3%               │
│ P(Fail DD): 18.2%            │
│ P(Fail Daily): 8.5%          │
│ Median Days to Pass: 14      │
│                              │
│ ■ Position Sizing             │
│ Optimal Risk/Trade: 0.75%    │
│ Max Concurrent: 2             │
│ Kelly (half): 6.2%           │
│                              │
│ ■ Trade Journal Summary       │
│ Total: 23  Win: 14 (60.9%)  │
│ Sharpe: 1.42  PF: 1.83      │
│ Avg Win: +1.2% Loss: -0.8%  │
│                              │
│ [Record Trade] [Close Trade]  │
└─────────────────────────────┘
```

**データソース**:
- `check_account_health`
- `get_fintokei_rules`
- `monte_carlo_simulation`
- `calculate_risk_of_ruin`
- `calculate_position_size`
- `get_trade_stats`
- `get_trade_history`

**入力**: アカウント残高・日次P&Lはユーザー手動入力 or トレード記録から自動算出

---

### Tab 5: Strategy（クオンツ戦略）

**目的**: 戦略のバックテスト・検証・比較

```
┌─────────────────────────────┐
│ Quant Strategy Lab           │
├─────────────────────────────┤
│ Symbol: [EUR/USD ▼]          │
│ Interval: [1day ▼]           │
│                              │
│ ■ Strategy Comparison         │
│ ┌────────────────────────┐   │
│ │ #1 Mean Reversion       │   │
│ │ Sharpe: 0.82 Win: 58%  │   │
│ │ #2 Donchian Channel     │   │
│ │ Sharpe: 0.67 Win: 45%  │   │
│ │ #3 SMA Crossover        │   │
│ │ Sharpe: 0.41 Win: 52%  │   │
│ └────────────────────────┘   │
│                              │
│ ■ Walk-Forward Validation     │
│ IS Sharpe: 0.95              │
│ OOS Sharpe: 0.72             │
│ Degradation: 24% ✅ ROBUST   │
│ OOS Positive: 4/5 folds      │
│                              │
│ ■ Cointegration Scanner       │
│ EUR/USD ~ GBP/USD            │
│ ADF: -3.82 (5% sig) ✅       │
│ Spread Z: -1.94              │
│ Half-life: 12.3 days         │
│                              │
│ [Backtest] [Walk-Forward]     │
│ [Risk of Ruin] [Monte Carlo]  │
└─────────────────────────────┘
```

**データソース**:
- `compare_strategies`
- `backtest_strategy`
- `walk_forward_test`
- `get_cointegration`
- `calculate_expected_value`

---

### Floating: Claude Chat（DAPI + 分析AI相当）

**目的**: 自然言語でSapiensツール群を操作、複合分析を依頼

```
┌─────────────────────────────┐
│ 💬 Sapiens AI                │
├─────────────────────────────┤
│                              │
│ You: EUR/USDのトレード       │
│ セットアップを評価して        │
│                              │
│ Sapiens: trade-analysisスキル │
│ を実行します。               │
│                              │
│ Step 1/8: 統計レジーム...    │
│ ├ Hurst: 0.43 (平均回帰)    │
│ ├ Z-Score: -1.82            │
│ └ → 平均回帰戦略が有利      │
│                              │
│ Step 2/8: リターン分布...    │
│ ├ Skew: -0.34 (左テール)    │
│ ├ JB検定: 不合格            │
│ └ → 標準VaRはリスク過小評価  │
│                              │
│ [送信]                        │
└─────────────────────────────┘
```

**実装**: `POST /api/v1/chat` → VPS上のClaude Code CLIにストリーミング

---

## Expo技術スタック

```
expo-app/
├── app/                    # Expo Router (file-based routing)
│   ├── (tabs)/
│   │   ├── dashboard.tsx   # Tab 1: Dashboard
│   │   ├── analysis.tsx    # Tab 2: Analysis
│   │   ├── macro.tsx       # Tab 3: Macro
│   │   ├── risk.tsx        # Tab 4: Risk
│   │   └── strategy.tsx    # Tab 5: Strategy
│   ├── chat.tsx            # Claude Chat (modal)
│   └── _layout.tsx         # Tab navigation layout
├── components/
│   ├── PriceCard.tsx       # 価格表示カード
│   ├── RegimeBadge.tsx     # レジームバッジ (LOW/NORMAL/HIGH/CRISIS)
│   ├── ProgressBar.tsx     # DD進捗バー
│   ├── StrategyRank.tsx    # 戦略ランキング行
│   ├── EventRow.tsx        # 経済イベント行
│   ├── MetricGrid.tsx      # 統計メトリクス格子
│   └── ChatBubble.tsx      # チャットメッセージ
├── hooks/
│   ├── useSapiensTool.ts   # tool呼び出しhook
│   ├── useTradingView.ts   # TV MCP操作hook
│   ├── useWebSocket.ts     # リアルタイム価格hook
│   └── useAccountState.ts  # Fintokeiアカウント状態
├── services/
│   ├── api.ts              # API Gateway クライアント
│   └── storage.ts          # AsyncStorage (アカウント設定永続化)
├── types/
│   └── index.ts            # 共通型定義
└── constants/
    ├── instruments.ts      # Fintokei銘柄マスタ
    └── theme.ts            # Bloomberg風ダークテーマ
```

### 主要ライブラリ

| パッケージ | 用途 |
|-----------|------|
| `expo-router` | ファイルベースルーティング |
| `@react-navigation/bottom-tabs` | 5タブナビゲーション |
| `react-native-reanimated` | アニメーション |
| `expo-secure-store` | APIキー安全保存 |
| `react-native-webview` | TradingViewチャート埋め込み |

### テーマ

Bloomberg風ダークテーマ:
- Background: `#0A0E17` (ほぼ黒)
- Surface: `#141821`
- Primary: `#FF6600` (Bloomberg orange)
- Positive: `#00C853`
- Negative: `#FF1744`
- Text: `#E0E0E0`
- Muted: `#6B7280`
- Font: `SF Mono` / `Menlo` (等幅)

---

## データフロー

### 起動時シーケンス (Dashboard)

```
App起動
  ├─→ GET /api/v1/health (VPS接続確認)
  ├─→ POST /api/v1/tool { tool: "list_instruments", args: { category: "all" } }
  ├─→ POST /api/v1/tool { tool: "get_cross_asset_regime", args: {} }
  ├─→ POST /api/v1/tool { tool: "get_yield_curve", args: { country: "US" } }
  └─→ WebSocket /api/v1/stream (価格ストリーム開始)
```

### 分析依頼シーケンス (Analysis tab)

```
ユーザーが銘柄を選択
  ├─→ POST /api/v1/tool { tool: "get_return_distribution", args: { symbol, interval: "1day", lookback: 252 } }
  ├─→ POST /api/v1/tool { tool: "get_volatility_regime", args: { symbol, interval: "1day" } }
  ├─→ POST /api/v1/tool { tool: "get_zscore", args: { symbol, interval: "1day", lookback: 100 } }
  ├─→ POST /api/v1/tool { tool: "get_drawdown_analysis", args: { symbol, interval: "1day", lookback: 504 } }
  └─→ POST /api/v1/tv { action: "chart_set_symbol", params: { symbol } }
      └─→ POST /api/v1/tv { action: "capture_screenshot", params: { region: "chart" } }
```

### Claude Chat シーケンス

```
ユーザーメッセージ送信
  └─→ POST /api/v1/chat { message: "EUR/USDのトレード分析して" }
      └─→ VPS: claude --message "EUR/USDのトレード分析して"
          ├─→ Claude reads CLAUDE.md (tool使い方を理解)
          ├─→ Claude calls tool-runner sequentially
          └─→ Streaming response → WebSocket → App
```

---

## API制限対策

Twelve Data無料プラン: 8 req/min, 800 req/day

### 戦略
1. **TradingViewを優先データソース化**: 価格クオート、チャート、テクニカル指標はTradingView MCP経由（API制限なし）
2. **Twelve Dataは統計計算専用**: ヒストリカルOHLCV（バックテスト/統計分析のraw data取得時のみ）
3. **キャッシュ**: 日足以上のデータは1時間キャッシュ、経済カレンダーは6時間キャッシュ
4. **バッチ処理**: Dashboard全銘柄更新はTradingView `batch_run` で一括取得

### TradingView MCP → Twelve Data 置き換えマップ

| 機能 | 旧 (Twelve Data) | 新 (TradingView MCP) |
|------|------------------|----------------------|
| 現在価格 | `get_price` | `quote_get` |
| チャート表示 | N/A | `capture_screenshot` / WebView |
| テクニカル指標 | `get_technical_indicator` | `data_get_study_values` |
| 銘柄変更 | N/A | `chart_set_symbol` |
| 複数銘柄一括 | N/A | `batch_run` |
| ヒストリカル | `get_price_history` | `data_get_ohlcv` |

**Twelve Data継続使用**: `get_economic_calendar`, 統計分析系(fetchCloses), マクロ指標

---

## 不採用機能の理由

| Bloomberg機能 | 不採用理由 |
|---------------|-----------|
| MARS (デリバティブリスク) | Fintokeiは現物CFDのみ。グリークス不要 |
| SRCH (債券スクリーニング) | 債券取引なし |
| OVME (オプション価格) | オプション取引なし |
| YAS (利回り・スプレッド) | 債券相対価値分析不要 |
| IB (メッセージング) | 個人トレーダー。機関間通信不要 |

---

## 開発フェーズ

### Phase 1: Core (MVP)
- Dashboard tab (価格一覧 + レジーム)
- Risk tab (アカウントヘルス + DD追跡)
- API Gateway (tool呼び出し + 認証)
- TradingView MCP接続

### Phase 2: Analysis
- Analysis tab (統計分析ダッシュボード)
- Macro tab (金利差 + 経済カレンダー)
- TradingViewチャート埋め込み

### Phase 3: Strategy + Chat
- Strategy tab (バックテスト + 比較)
- Claude Chat (自然言語分析)
- プッシュ通知 (経済イベントアラート)

### Phase 4: Polish
- ウィジェット (iOS Lock Screen)
- Apple Watch complication (DD残量)
- オフラインキャッシュ

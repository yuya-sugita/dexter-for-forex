# Bot Architecture — Renaissance Polymarket

## 設計原則

1. **Renaissance は分析エンジン、bot は呼び出し層**。6エージェントと
   11プロトコルを書き換えない。bot は上から呼ぶだけ。
2. **特殊ケース禁止** (Prompt 11)。市場カテゴリ別・時間帯別の分岐を
   作らない。全市場が同じパイプラインを通る。
3. **Phase 1 (shadow) で動く最小構成**を先に作る。執行層は Phase 2
   以降で接続する。
4. **状態は JSON ファイル**。DB は Phase 3 以降で検討。最初は
   `.sapiens/bot/` 配下の JSON で十分。

## コンポーネント図

```
src/bot/
├── scheduler.ts        ← cron / interval ループ
├── discovery.ts        ← list_markets → フィルタ → 分析キュー
├── analyzer.ts         ← polymarket-analysis skill を機械呼び出し
├── agents.ts           ← 6エージェントの JSON 出力ラッパー
├── confluence.ts       ← コンフルエンス判定 + Decision Gate
├── sizer.ts            ← ケリー比 → ポジションサイズ算出
├── executor.ts         ← CLOB 注文発行 (Phase 2+)
├── monitor.ts          ← オープンポジション監視 + α 縮小判定
├── postmortem.ts       ← 解決時の自動 POSTMORTEM 生成
├── kill-switch.ts      ← 緊急停止ロジック
├── state.ts            ← .sapiens/bot/ への状態永続化
├── alert.ts            ← 通知送信 (webhook / log)
├── types.ts            ← 全共通型定義
└── index.ts            ← エントリポイント (Phase 切替)
```

## データフロー

```
[Scheduler]
    │  (interval: ANALYSIS_INTERVAL_MIN 分ごと)
    v
[Discovery]
    │  list_markets(category, sort=volume)
    │  → フィルタ: 流動性 > MIN_LIQUIDITY, 解決日 > MIN_DAYS_TO_RESOLVE
    │  → 既に分析済み & ポジション保有中の市場を除外
    │  → 分析キュー (最大 MAX_MARKETS_PER_CYCLE 件)
    v
[Analyzer] (キューから1市場ずつ順次)
    │  get_market → get_implied_probability → get_market_history
    │  get_base_rate / get_polls
    │  get_correlation_markets
    v
[Agents] (6エージェントを順次呼び出し、各々 JSON 診断を返す)
    │  outsider-mathematician  → { direction, confidence, reasoning_key }
    │  outsider-physicist      → { direction, confidence, reasoning_key }
    │  outsider-astronomer     → { direction, confidence, reasoning_key }
    │  outsider-speech-recognition → { direction, confidence, reasoning_key }
    │  outsider-cryptanalyst   → { direction, confidence, reasoning_key }
    │  quant-analyst           → { edge, kelly, ev, ruin_prob }
    v
[Confluence]
    │  count(direction == majority) >= CONFLUENCE_THRESHOLD ?
    │  edge >= MIN_EDGE ?
    │  kill_switch.isActive() == false ?
    │  bankroll_health(α_level) != STOP ?
    v
[Decision Gate]
    │  PASS → Sizer → Executor (Phase 2+) / Shadow Log (Phase 1)
    │  FAIL → skip, log reason
    v
[Monitor] (別ループ、MONITOR_INTERVAL_MIN 分ごと)
    │  オープンポジションの現在価格を取得
    │  bankroll DD を計算 → α レベル判定
    │  解決済み市場を検出 → mark_resolved → Postmortem
    v
[Postmortem]
    │  failure_mode 自動分類
    │  新ルール候補を MC 検証 (改善幅が閾値未満なら棄却)
    │  結果を .sapiens/bot/postmortems/ に保存
    v
[Alert]
    │  kill switch 発動 / エラー / 約定 / 解決 → 通知先へ送信
```

## エージェント出力契約 (JSON schema)

現在の6エージェント SKILL.md は人間向け markdown 診断を返す。bot
では**同じ分析ロジック**を JSON モードで呼び出し、以下の構造化出力
を得る:

### 異邦人5人の共通出力

```typescript
interface OutsiderDiagnosis {
  agent: string;             // "outsider-mathematician" etc.
  market_id: string;
  direction: "YES" | "NO" | "NEUTRAL";
  confidence: number;        // 0.0 - 1.0
  reasoning_key: string;     // 1行の診断要約（原語、金融語禁止）
  data_points: Record<string, number>;  // 使用した数値
}
```

### クオンツアナリストの出力

```typescript
interface QuantDiagnosis {
  agent: "quant-analyst";
  market_id: string;
  estimated_true_prob: number;   // 収縮推定後の真確率
  market_price: number;          // 現在の市場価格
  edge: number;                  // |true_prob - market_price|
  direction: "YES" | "NO";      // edge が正の方向
  kelly_fraction: number;        // f* (full Kelly)
  recommended_fraction: number;  // f*/4 (quarter Kelly)
  position_size_usd: number;     // bankroll * recommended_fraction
  ruin_probability: number;      // 100ベットでの破産確率
  confluence_count: number;      // 一致エージェント数
  ev_per_dollar: number;         // 1ドルあたり期待値
}
```

### Decision Gate の出力

```typescript
interface GateDecision {
  market_id: string;
  outcome: "EXECUTE" | "SKIP";
  reason: string;              // SKIP の場合の理由コード
  quant: QuantDiagnosis;
  outsiders: OutsiderDiagnosis[];
  gate_checks: {
    edge_sufficient: boolean;
    confluence_sufficient: boolean;
    bankroll_healthy: boolean;
    concentration_ok: boolean;
    kill_switch_clear: boolean;
  };
  timestamp: string;
}
```

## ポジション状態機械

```
  DISCOVERED → ANALYZING → DIAGNOSED
                              │
                    ┌─────────┴─────────┐
                  SKIP                APPROVED
                    │                    │
                   (log)              PENDING_EXECUTION
                                        │
                                     OPEN
                                        │
                              ┌─────────┴─────────┐
                          MONITORING           α_REDUCED
                              │                    │
                              └────────┬───────────┘
                                       │
                              ┌────────┴────────┐
                          RESOLVED           CLOSED_MANUAL
                              │                    │
                          POSTMORTEM          POSTMORTEM
```

## 永続化 (.sapiens/bot/)

```
.sapiens/bot/
├── config.json          ← 運用パラメータ（RISK_LIMITS から生成）
├── state.json           ← 現在の bot 状態（α レベル、kill switch 等）
├── positions/
│   ├── open.json        ← オープンポジション一覧
│   └── closed.json      ← クローズ済み（解決含む）
├── shadow/
│   └── decisions.jsonl  ← Phase 1 の shadow ログ（1行1判断）
├── postmortems/
│   └── YYYY-MM.jsonl    ← 月別ポストモーテム
└── metrics/
    └── daily.jsonl      ← 日次メトリクス（PnL, DD, positions, α）
```

全ファイルは `.sapiens/` 配下なので `.gitignore` 済み
(Prompt 10: 尖度を守る)。

## kill switch の配線

```
kill_switch.ts は以下の条件のいずれかで発動:
1. bankroll DD > KILL_SWITCH_DD_PCT
2. 日次損失 > DAILY_LOSS_LIMIT_USD
3. 連続損失 > MAX_CONSECUTIVE_LOSSES
4. API エラーが CONSECUTIVE_API_ERRORS 回連続
5. 手動フラグ (.sapiens/bot/KILL_SWITCH ファイルの存在)

発動時:
- 新規分析・執行を即停止
- オープンポジションは触らない（Prompt 4: 上書きしない）
- alert.ts で通知
- state.json に発動理由と時刻を記録
- 復帰は手動のみ（KILL_SWITCH ファイル削除 + config.json で
  復帰条件を確認）
```

## TODO: 決定が必要な項目

以下は `DECISION_POLICY.md` と `RISK_LIMITS.md` で定義される
パラメータであり、ARCHITECTURE.md では変数名のみ参照する:

- `ANALYSIS_INTERVAL_MIN`: 分析ループの間隔（分）
- `MONITOR_INTERVAL_MIN`: 監視ループの間隔（分）
- `MAX_MARKETS_PER_CYCLE`: 1サイクルで分析する最大市場数
- `MIN_LIQUIDITY`: 分析対象の最小流動性（USD）
- `MIN_DAYS_TO_RESOLVE`: 解決日までの最小日数
- `CONFLUENCE_THRESHOLD`: 最小コンフルエンスエージェント数
- `MIN_EDGE`: 最小エッジ（|true_prob - market_price|）
- `KILL_SWITCH_DD_PCT`: kill switch 発動 DD%
- `DAILY_LOSS_LIMIT_USD`: 日次損失限度（USD）
- `MAX_CONSECUTIVE_LOSSES`: 最大連続損失回数
- `CONSECUTIVE_API_ERRORS`: API 連続エラー許容回数

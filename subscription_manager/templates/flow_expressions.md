# Power Automate 式集（コピペ用）

Power Automate の「式」タブに貼り付けると `@{...}` の中括弧を自動でつけてくれます。以下は `@{...}` を除いた**式の本体**です。

## Flow 1: Subscription Daily Notification

### 「複数の項目の取得」の Filter Query

```
NextBillingDate eq '@{formatDateTime(convertTimeZone(utcNow(), 'UTC', 'Tokyo Standard Time'), 'yyyy-MM-dd')}' and Active eq 1
```

内訳：
- `utcNow()` — 現在の UTC 時刻
- `convertTimeZone(..., 'UTC', 'Tokyo Standard Time')` — JST に変換
- `formatDateTime(..., 'yyyy-MM-dd')` — 日付のみを ISO 形式で
- `NextBillingDate eq '...' and Active eq 1` — 本日請求分かつ有効

### メール件名

```
【本日請求】@{items('Apply_to_each')?['Title']} @{items('Apply_to_each')?['Amount']} @{items('Apply_to_each')?['Currency']?['Value']}
```

### 次回請求日を更新する式

「項目の更新」の `次回請求日` フィールドに貼り付け：

```
if(equals(items('Apply_to_each')?['BillingCycle']?['Value'], '月次'),
   addToTime(items('Apply_to_each')?['NextBillingDate'], 1, 'Month'),
if(equals(items('Apply_to_each')?['BillingCycle']?['Value'], '年次'),
   addToTime(items('Apply_to_each')?['NextBillingDate'], 1, 'Year'),
   addToTime(items('Apply_to_each')?['NextBillingDate'], 3, 'Month')))
```

平坦化：

```
if(equals(items('Apply_to_each')?['BillingCycle']?['Value'], '月次'), addToTime(items('Apply_to_each')?['NextBillingDate'], 1, 'Month'), if(equals(items('Apply_to_each')?['BillingCycle']?['Value'], '年次'), addToTime(items('Apply_to_each')?['NextBillingDate'], 1, 'Year'), addToTime(items('Apply_to_each')?['NextBillingDate'], 3, 'Month')))
```

## Flow 2: Subscription FX Update

### HTTP URI（USD）

```
https://api.exchangerate.host/latest?base=USD&symbols=JPY
```

### HTTP URI（EUR）

```
https://api.exchangerate.host/latest?base=EUR&symbols=JPY
```

### JSON 解析スキーマ

```json
{
  "type": "object",
  "properties": {
    "base": { "type": "string" },
    "date": { "type": "string" },
    "rates": {
      "type": "object",
      "properties": {
        "JPY": { "type": "number" }
      }
    }
  }
}
```

### ExchangeRates 更新時の LastUpdated

```
utcNow()
```

## テスト用式

### 「今日」を JST で得る

```
formatDateTime(convertTimeZone(utcNow(), 'UTC', 'Tokyo Standard Time'), 'yyyy-MM-dd')
```

### 「N日後」を JST で得る

```
formatDateTime(convertTimeZone(addDays(utcNow(), 3), 'UTC', 'Tokyo Standard Time'), 'yyyy-MM-dd')
```

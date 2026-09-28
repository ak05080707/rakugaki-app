# 工務TODO（iPhone・iPad・Windows PC 共有）＋ 自作MCPコネクター

## 全体の仕組み

```
 iPhone / iPad / PC のブラウザ ─┐
                                ├─▶ Google Apps Script（無料）─▶ Google スプレッドシート「TODO」
 LINE（自分用の公式アカウント）─┘        ▲
                                         │ API
 Claude Desktop（会社PC）─ 自作MCP ──────┘
        │               └─ PowerShell ─▶ Outlook 2019（メール・予定表・タスク）
        └─ Plaud コネクター（接続済み）… 議事録のアクションアイテムを取り込み
```

- 置き場所は Google スプレッドシート 1枚。どの端末で変えても1分以内に他の端末にも反映される
- **完了にすると**：その場で緑色になり取り消し線 → 1秒ほどで下の「✅ 完了」欄へ移動。間違えたら「元に戻す」
- 完了分は7日間表示して、その後は自動で非表示（スプレッドシートには残る）
- 並び順：⚠️期限切れ → 📌今日 → 🗓明日以降 → 📝期限なし → ✅完了
- 毎朝7時に、今日のTODOがLINEに届く（任意）

| フォルダ | 中身 |
|---|---|
| `gas/` | Apps Script に貼るファイル（Code.gs / Index.html / Seed.gs / appsscript.json） |
| `mcp-server/` | Claude Desktop 用の自作MCPコネクター（Node.js） |

---

## ① TODO本体を作る（15分）

1. Google ドライブで **新しいスプレッドシート** を作成（名前は「工務TODO」など）
2. メニュー **拡張機能 → Apps Script** を開く
3. 最初からある `コード.gs` の中身を消して、`gas/Code.gs` を貼り付け
4. 左の「＋」→「HTML」で `Index` という名前のファイルを作り、`gas/Index.html` を貼り付け
5. 同じく「＋」→「スクリプト」で `Seed` を作り、`gas/Seed.gs` を貼り付け
6. 上の関数選択で **`setup`** を選んで ▶実行 → 権限の許可を求められたら「許可」
   （「このアプリは確認されていません」→「詳細」→「安全ではないページに移動」でOK。自分のスクリプトなので問題なし）
7. 実行ログに出る **合言葉（API_KEY）** をメモ
8. （任意）関数 **`importPlaudSeed`** を実行 → Plaud 9/19・9/27 の酒井さん担当アクション19件がTODOに入る
9. 右上 **デプロイ → 新しいデプロイ** → 種類「ウェブアプリ」
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員**（合言葉がないと開けないので中身は見られません）
10. 表示された URL（…/exec）の末尾に `?key=合言葉` を付けたものが **TODO画面のURL**

### 各端末で開く
- **iPhone / iPad**：Safari で上のURLを開く → 共有ボタン →「ホーム画面に追加」→ アプリのように使える
- **Windows PC**：Edge / Chrome で開いてブックマーク（Edge なら「…→アプリ→このサイトをアプリとしてインストール」も可）

> スクリプトを修正した時は「デプロイ → デプロイを管理 → 編集（鉛筆）→ バージョン：新バージョン」で更新。URLは変わりません。

---

## ② LINE から追加できるようにする（任意・15分）

※ 個人のLINEトークを勝手に読むことは LINE の仕様上できません。
代わりに **自分専用のLINE公式アカウント（無料）** を作り、そこに送ったものがTODOになる仕組みです。
人から来たLINEをTODOにしたい時は、そのメッセージを長押し →「転送」でこのアカウントへ。

1. [LINE Developers](https://developers.line.biz/) にLINEアカウントでログイン → プロバイダー作成 → **Messaging API チャネル** を作成
2. チャネルの「Messaging API設定」で **チャネルアクセストークン（長期）** を発行してコピー
3. Apps Script の **プロジェクトの設定（歯車）→ スクリプト プロパティ** に追加
   - `LINE_CHANNEL_ACCESS_TOKEN` ＝ コピーしたトークン
4. 「Messaging API設定」の **Webhook URL** に `①のURL…/exec?key=合言葉` を入れて「検証」→「Webhookの利用」をオン
5. 同じ画面の「応答メッセージ」「あいさつメッセージ」はオフ（LINE Official Account Manager 側で設定）
6. QRコードで友だち追加 → **最初にメッセージを送った人（自分）が持ち主として登録** されます

### LINE での使い方
| 送る内容 | 動き |
|---|---|
| `A邸 見積提出` | 期限なしで追加 |
| `明日 B現場 確認` / `今日 …` / `明後日 …` | 期限付きで追加 |
| `10/3 山田様に電話` | 10月3日期限で追加 |
| `!山口さんに電話` / `至急 …` | 🔥至急で追加 |
| `一覧` | 未完了の一覧が返ってくる |
| `完了 2` | 一覧の2番を完了に |

毎朝7時に「おはようございます☀️」と今日のTODOが届きます（無料枠は月200通なので1日1通なら余裕）。

---

## ③ 自作MCPコネクターを Claude Desktop に入れる（会社PC・10分）

Outlook 2019 は Microsoft 365 と違ってクラウドAPIがないため、**PC上のOutlookを直接操作する方式（COM）** にしています。
Outlook 2019 が入っている Windows PC の Claude Desktop で使います。

1. [Node.js](https://nodejs.org/ja)（LTS版）をインストール
2. このリポジトリの `todo/mcp-server` フォルダを PC に置く（例：`C:\tools\komu-todo-mcp`）
3. そのフォルダで PowerShell を開き `npm install`
4. Claude Desktop → 設定 → 開発者 →「構成を編集」で `claude_desktop_config.json` を開き、次を追加

```json
{
  "mcpServers": {
    "komu-todo": {
      "command": "node",
      "args": ["C:\\tools\\komu-todo-mcp\\index.mjs"],
      "env": {
        "TODO_API_URL": "https://script.google.com/macros/s/xxxxxxxx/exec",
        "TODO_API_KEY": "①でメモした合言葉"
      }
    }
  }
}
```

5. Claude Desktop を再起動 → 🔨アイコンに `komu-todo` のツールが出ればOK

### 使えるツール
| ツール | 内容 |
|---|---|
| `todo_list` / `todo_add` / `todo_add_many` / `todo_complete` / `todo_update` / `todo_delete` | TODOの操作 |
| `line_messages` | LINEに送ったメッセージの履歴 |
| `outlook_recent_mails` | 受信トレイの直近メール（未読のみも可） |
| `outlook_flagged_mails` | フラグ付き（要対応）メール |
| `outlook_search_mails` | キーワードでメール検索 |
| `outlook_calendar` | 予定表 |
| `outlook_tasks` | Outlookのタスク |
| `outlook_flag_done` | メールのフラグを完了に |
| `outlook_move_to_deleted` | 不要メールを「削除済みアイテム」へ移動（元に戻せる） |

### Claude への頼み方（例）
- 「Outlookのフラグ付きメールをTODOに入れて。期限が書いてあれば期限も」
- 「今日の未読メールから、返事や対応が必要なものだけTODOにして」
- 「Plaudの今日の会議から、私の担当分をTODOに追加して」（Plaudコネクターと組み合わせ）
- 「今日のTODOとOutlookの予定をまとめて、朝の段取りを出して」
- 「1週間分の広告メールを一覧にして。〇〇ショップは除外。OKなら削除済みへ」

### うまく動かない時
- **「プログラムがOutlookにアクセスしようとしています」と出る** … ウイルス対策ソフトが古いと出ます。「許可」でOK。毎回出る場合は Outlook の「ファイル→オプション→セキュリティセンター→プログラムによるアクセス」を確認
- **Outlookのツールがエラー** … Outlook を起動した状態で試す
- **TODOツールがエラー** … `TODO_API_URL` が `/exec` で終わっているか、合言葉が正しいかを確認

---

## Plaud 連携の確認結果（2026/9/28）
- Claude の Plaud コネクターは **接続OK**（アカウント akira1 で録音一覧・要約が読める状態）
- 自作MCPに Plaud 機能は入れていません。Claude 側で「Plaud を読む → `todo_add_many` で登録」とつなげます
- 議事録ID を `ref` に入れるので、同じ会議を2回取り込んでも二重登録されません

## 今後（Flutter 版）
データはスプレッドシート＋Apps Script の API（`doPost` の `list / add / update / setDone / delete`）なので、
Flutter でネイティブアプリを作る時も、このAPIをそのまま使えます。

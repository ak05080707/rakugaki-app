# 現場TODO共有

工事名ごとに、メンバー（出す側）とメンバー１（返事をする側）でTODOを共有するアプリ。AIは使っていません。

- 画面：GitHub Pages（このフォルダの `index.html`）
- データ：Google スプレッドシート（「TODO」「メンバー」「グループ」シート）
- 読み書き：Apps Script のウェブアプリ（`gas/Code.gs` の `doPost`）。合言葉がないと読み書きできません

配るURLの形：`https://ak05080707.github.io/rakugaki-app/genba-todo/#api=（/exec のURL）&key=（合言葉）`
（`#` から後ろはサーバーに送られません。URL と合言葉は Apps Script で `showUrl` を実行すると実行ログに出ます）

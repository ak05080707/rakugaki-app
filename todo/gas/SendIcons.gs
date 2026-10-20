/**
 * 工務TODO のアイコン（iPhone・iPad 用の画像と、PC 用の .ico）を、自分の LINE に送る。
 * Apps Script の画面で関数「sendIconsToLine」を選んで ▷実行（1回だけ）。デプロイし直す必要はありません。
 */
const ICON_BASE = 'https://raw.githubusercontent.com/ak05080707/rakugaki-app/claude/practical-bohr-07lnjy/todo/assets/';

function sendIconsToLine() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const owner = props.getProperty('LINE_OWNER_USER_ID');
  if (!token || !owner) throw new Error('LINE の設定（LINE_CHANNEL_ACCESS_TOKEN と持ち主の登録）が見つかりません');

  const iphone = [
    '📱 iPhone・iPad のホーム画面に「工務TODO」を手帳マークで置く方法',
    '',
    '① 下の手帳の画像を開いて、長押し →「写真に保存」',
    '② 今ホーム画面にある工務TODOを開き、共有ボタン（□↑）→「コピー」でURLをコピー',
    '③「ショートカット」アプリ →右上の＋ →「アクションを追加」→「URLを開く」を選び、②のURLを貼る',
    '④ 画面上の名前を「工務TODO」に変更 →下の共有ボタン →「ホーム画面に追加」',
    '⑤ アイコンをタップ →「写真を選択」→ ①の手帳の画像 →「追加」',
    '⑥ 前のアイコンは長押し →「Appを削除」でOK'
  ].join('\n');

  const pc = [
    '💻 Windows PC 用のアイコン',
    '',
    '① 下のURLを PC で開くと、アイコン（todo-icon.ico）がダウンロードされます。「ドキュメント」フォルダなど、消さない場所に移しておく',
    ICON_BASE + 'todo-icon.ico',
    '',
    '② デスクトップで右クリック →「新規作成」→「ショートカット」→ 工務TODOのURLを貼って「次へ」→ 名前「工務TODO」→「完了」',
    '③ できたショートカットを右クリック →「プロパティ」→「Web ドキュメント」タブ →「アイコンの変更」→「参照」で ① の todo-icon.ico を選ぶ →「OK」',
    '',
    '※ Edge の「アプリとしてインストール」で入れた場合は、TODO画面を最新版にすると自動で手帳マークになります。'
  ].join('\n');

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      to: owner,
      messages: [
        { type: 'text', text: iphone },
        { type: 'image', originalContentUrl: ICON_BASE + 'icon-iphone-1024.png', previewImageUrl: ICON_BASE + 'mark-line-640.png' },
        { type: 'text', text: pc }
      ]
    }),
    muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() === 200 ? 'LINE に送りました' : '送信に失敗しました: ' + res.getContentText());
}

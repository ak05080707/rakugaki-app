#!/usr/bin/env python3
"""
gas/Index.html（Apps Script 版の TODO 画面）から、GitHub Pages 版の app/index.html を作る。
画面を直したら gas/Index.html を直して、このスクリプトを実行する:  python3 todo/app/build.py

GitHub Pages 版の違い
- データは Apps Script のウェブアプリ（…/exec）に fetch で読み書きする（Code.gs の API をそのまま使う）
- URL と合言葉は、アドレスの # の後ろ（#api=…&key=…）に入れる。# 以降はサーバーに送られない
- iPhone のホーム画面アイコン・アプリ名・PWA 用の設定を追加
"""
import pathlib, re

here = pathlib.Path(__file__).resolve().parent
src = (here.parent / 'gas' / 'Index.html').read_text(encoding='utf-8')

def rep(a, b):
    global src
    assert a in src, 'not found: ' + a[:60]
    src = src.replace(a, b, 1)

# <head>：Apps Script 用の base を外し、アイコン類を追加
rep('<base target="_top">\n', '')
rep('<title>工務TODO</title>', '''<title>工務TODO</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="工務TODO">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#F3F4F7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111318" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="64x64" href="icons/favicon-64.png">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<link rel="manifest" href="manifest.webmanifest">''')

# 接続先の設定（# の後ろ → 端末に保存）
rep("const KEY = '<?= key ?>';", r"""// 接続先：アドレスの #api=…&key=… を優先し、この端末にも保存しておく
const CONF = (() => {
  const h = new URLSearchParams(location.hash.slice(1));
  let api = h.get('api') || '', key = h.get('key') || '';
  try {
    if (api && key) localStorage.setItem('todo-conf', JSON.stringify({ api, key }));
    else ({ api = '', key = '' } = JSON.parse(localStorage.getItem('todo-conf') || '{}'));
  } catch (e) {}
  return { api, key, demo: h.has('demo') };
})();""")

# サーバー呼び出しを fetch に置き換え（Code.gs の api_ と対応）
rep("""function call(fn, ...args) {
  if (window.google && google.script && google.script.run) {
    return new Promise((res, rej) =>
      google.script.run.withSuccessHandler(res).withFailureHandler(rej)[fn](KEY, ...args));
  }
  return mock[fn](...args);
}""", """const API_MAP = {
  uiList: includeDone => ({ action: 'list', includeDone: !!includeDone }),
  uiAdd: item => ({ action: 'add', source: '手入力', ...item }),
  uiUpdate: (id, fields) => ({ action: 'update', id, fields }),
  uiDelete: id => ({ action: 'delete', id }),
  uiDeleteMany: ids => ({ action: 'deleteMany', ids }),
  uiSetDoneMany: (ids, done) => ({ action: 'setDoneMany', ids, done })
};
async function call(fn, ...args) {
  if (CONF.demo || !CONF.api) return mock[fn](...args);
  const res = await fetch(CONF.api, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // プリフライトなしで送れる形
    body: JSON.stringify({ key: CONF.key, ...API_MAP[fn](...args) })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'error');
  return data.result;
}""")

# 初期化：接続先が未設定なら設定画面を出す
rep("""(function init() {
  const d = new Date();""", """function showSetup() {
  document.body.insertAdjacentHTML('afterbegin', `
    <div class="setup" id="setup">
      <div class="sheet">
        <h2 style="margin:0 0 6px;font-size:20px">工務TODO の接続先</h2>
        <p style="margin:0 0 8px;color:var(--muted);font-size:14px">Apps Script のウェブアプリのURL（…/exec）と合言葉を入れてください。この端末にだけ保存されます。</p>
        <label>ウェブアプリのURL</label><input id="setApi" placeholder="https://script.google.com/macros/s/……/exec" autocomplete="off">
        <label>合言葉</label><input id="setKey" autocomplete="off">
        <div class="acts"><button type="button" class="btn" id="setSave">保存して開く</button></div>
      </div>
    </div>`);
  $('setSave').onclick = () => {
    const api = $('setApi').value.trim().replace(/\\?.*$/, ''), key = $('setKey').value.trim();
    if (!/^https:\\/\\/script\\.google\\.com\\/.+\\/exec$/.test(api) || !key) { alert('URL（…/exec）と合言葉を確認してください'); return; }
    location.hash = 'api=' + encodeURIComponent(api) + '&key=' + encodeURIComponent(key);
    location.reload();
  };
}

(function init() {
  if (!CONF.api && !CONF.demo) { showSetup(); return; }
  const d = new Date();""")

# 設定画面用の見た目
rep(".toast { position: fixed;", """.setup { position: fixed; inset: 0; background: var(--bg); z-index: 30; display: flex; align-items: center; justify-content: center; padding: 16px; }
.setup .sheet { border-radius: 18px; box-shadow: var(--shadow); }
.toast { position: fixed;""")

out = src.replace('<!DOCTYPE html>\n', '<!DOCTYPE html>\n<!-- このファイルは build.py で gas/Index.html から自動生成しています。直接編集しないでください。 -->\n', 1)
(here / 'index.html').write_text(out, encoding='utf-8')
print('wrote', here / 'index.html', len(out))

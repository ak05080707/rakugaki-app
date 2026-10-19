/**
 * 現場TODO共有（Googleスプレッドシート版）
 * データはこのスプレッドシートの「TODO」「メンバー」「グループ」シートに保存されます。
 * AIは使っていません。
 *
 * 役割は2つ：「メンバー」（TODOを出す・完了にする・削除する側）と「メンバー１」（返事をする側）。
 * プログラムの中では、メンバー＝'上司'、メンバー１＝'部下' という名前で扱っています。
 */

// 版（アプリの一番下に出る。貼り付けとデプロイができたかの確認用）
const VERSION = '10/19-A';

// 画面（GitHub Pages）の場所
const PAGES_URL = 'https://ak05080707.github.io/rakugaki-app/genba-todo/';

// ===== 設定（必要なら書き換えてください） =====
const BUKA_CAN_CREATE = true; // メンバー１もメンバーへ依頼を出せる（出せないようにするなら false）

// ===== シート名と見出し =====
const SHEET_TODO = 'TODO';
const SHEET_MEMBER = 'メンバー';
const MEMBER_ALIASES = ['メンバー', 'メンバー１', 'メンバー1']; // どの名前のタブでも読めるようにする
const SHEET_GROUP = 'グループ';
const TODO_HEAD = ['ID', '作成日時', '工事名', '段取り or チェック', '期限', '宛先', 'グループ名', '出した人', '返事', '確認者', '確認日時', '種類'];
const KINDS = ['確認', 'お願い', '質問'];
const MEMBER_HEAD = ['名前', 'メールアドレス（任意）', '役割（メンバー/メンバー１）', '一覧に出さない（○を入れる）'];
const GROUP_HEAD = ['グループ名', 'メンバー（名前を「、」で区切る）'];
const COL = { id: 1, created: 2, project: 3, title: 4, due: 5, to: 6, group: 7, from: 8, answers: 9, checkedBy: 10, checkedAt: 11, kind: 12 };

/**
 * 画面は GitHub Pages に引っ越した。このURLを直接開いた人には案内だけ出す
 * （画面からの読み書きは、下の doPost が合言葉つきで受け付ける）
 */
function doGet() {
  const html = '<div style="font-family:sans-serif;padding:24px;line-height:1.8">' +
    '<h2>現場TODO共有は、新しいURLに引っ越しました</h2>' +
    '<p>管理者から届いた、新しいURLを開いてください。</p>' +
    '<p>（ホーム画面のアイコンも、新しいURLで作り直してください）</p></div>';
  return HtmlService.createHtmlOutput(html).setTitle('現場TODO共有')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 画面（GitHub Pages）からの読み書きの入口。
 * 本文は {"key":"合言葉","fn":"getData","args":[...]} の形。合言葉が違うと何もしない
 */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const key = PropertiesService.getScriptProperties().getProperty('GENBA_KEY');
    if (!key || req.key !== key) throw new Error('合言葉が違います。管理者から届いたURLを開き直してください。');
    const fns = { getData: getData_, addTask: addTask_, answer: answer_, check: check_, deleteTasks: deleteTasks_ };
    const fn = fns[req.fn];
    if (!fn) throw new Error('この操作はできません。');
    out = { ok: true, data: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** 合言葉を作る（まだなければ）。読みまちがえにくい文字だけ使う */
function key_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('GENBA_KEY');
  if (!key) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    key = '';
    for (let i = 0; i < 10; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
    props.setProperty('GENBA_KEY', key);
  }
  return key;
}

/** みんなに配るURLを実行ログに出す（デプロイしたあとに実行する） */
function showUrl() {
  const key = key_();
  const api = ScriptApp.getService().getUrl();
  if (!api) {
    Logger.log('まだ公開（デプロイ）されていません。先に「デプロイ」をしてから、もう一度 showUrl を実行してください。');
    Logger.log('合言葉：' + key);
    return;
  }
  Logger.log('合言葉：' + key);
  Logger.log('招待URLづくりのページ（URLと合言葉を入れるとQRコードができる）：' + PAGES_URL + 'setup.html');
  if (!/\/exec$/.test(api)) {
    Logger.log('（注意）ここで分かったURLが /exec で終わっていません：' + api);
    Logger.log('デプロイの画面に出る「ウェブアプリのURL」（/exec で終わるもの）と、上の合言葉を、新しい画面の「接続の設定」に入れてください：' + PAGES_URL);
    return;
  }
  Logger.log('みんなに配るURL（これを全部コピーして送る）：');
  Logger.log(PAGES_URL + '#api=' + encodeURIComponent(api) + '&key=' + key);
}

/** 合言葉を作り直す（URLが外にもれたとき）。前のURLは使えなくなる */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('GENBA_KEY');
  showUrl();
}

/** 最初に1回だけ実行：シートと見出しを作る */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const td = ensureSheet_(ss, SHEET_TODO, TODO_HEAD);
  // あとから増えた列（種類）の見出しを足す
  if (!String(td.getRange(1, COL.kind).getValue()).trim()) td.getRange(1, COL.kind).setValue('種類').setFontWeight('bold');
  const m = memberSheet_(ss) || ensureSheet_(ss, SHEET_MEMBER, MEMBER_HEAD);
  if (m.getLastRow() < 2) m.appendRow(['（例）山田 太郎', Session.getEffectiveUser().getEmail(), 'メンバー']);
  // あとから増えた列（一覧に出さない）の見出しを足す。もう一度 setup を実行すると付く
  if (!String(m.getRange(1, 4).getValue()).trim()) m.getRange(1, 4).setValue(MEMBER_HEAD[3]).setFontWeight('bold');
  const g = ensureSheet_(ss, SHEET_GROUP, GROUP_HEAD);
  if (g.getLastRow() < 2) g.appendRow(['（例）1班', '（例）山田 太郎']);
  key_();
  showUrl();
}

function ensureSheet_(ss, name, head) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  }
  return sh;
}

function memberSheet_(ss) {
  for (const n of MEMBER_ALIASES) { const sh = ss.getSheetByName(n); if (sh) return sh; }
  return null;
}

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = name === SHEET_MEMBER ? memberSheet_(ss) : ss.getSheetByName(name);
  if (!sh) throw new Error('「' + name + '」シートがありません。setup を実行してください。');
  return sh;
}

function rows_(name) {
  const sh = sheet_(name);
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, sh.getLastColumn()).getValues() : [];
}

// ===== 読み込み =====
function members_() {
  return rows_(SHEET_MEMBER)
    .map(r => ({ name: String(r[0]).trim(), email: String(r[1] || '').trim().toLowerCase(), role: isBossWord_(r[2]) ? '上司' : '部下', hidden: !!String(r[3] || '').trim() }))
    .filter(m => m.name);
}

/** 役割の列が「メンバー」（または以前の書き方「上司」）なら、出す側として扱う */
function isBossWord_(v) {
  const s = String(v || '').replace(/s/g, '');
  return s === 'メンバー' || s === '上司';
}

function groups_() {
  return rows_(SHEET_GROUP)
    .map(r => ({ name: String(r[0]).trim(), members: String(r[1] || '').split(/[、,，\n]+/).map(s => s.trim()).filter(Boolean) }))
    .filter(g => g.name);
}

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '');
}

function tasks_() {
  return rows_(SHEET_TODO).filter(r => r[0]).map(r => {
    let answers = {};
    try { answers = r[COL.answers - 1] ? JSON.parse(r[COL.answers - 1]) : {}; } catch (e) { answers = {}; }
    const to = String(r[COL.to - 1]);
    return {
      id: String(r[COL.id - 1]),
      created: r[COL.created - 1] instanceof Date ? r[COL.created - 1].getTime() : 0,
      project: String(r[COL.project - 1] || ''),
      title: String(r[COL.title - 1] || ''),
      due: fmtDate_(r[COL.due - 1]),
      to: to === '全員' ? 'all' : to.split('、').filter(Boolean),
      group: String(r[COL.group - 1] || ''),
      from: String(r[COL.from - 1] || ''),
      answers: answers,
      checkedBy: String(r[COL.checkedBy - 1] || ''),
      kind: String(r[COL.kind - 1] || '')
    };
  });
}

/** 今の利用者を決める。会社のGoogleアカウントでメールが分かればそれを優先する */
function resolveMe_(clientName) {
  const ms = members_();
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (email) {
    const byEmail = ms.find(m => m.email && m.email === email);
    if (byEmail) return { me: byEmail, byEmail: true };
  }
  const byName = ms.find(m => m.name === clientName);
  if (!byName) return { me: null, byEmail: false };
  // メールが登録されている人は、本人のアカウントでしか名乗れない
  if (byName.email && email && byName.email !== email) return { me: null, byEmail: false };
  return { me: byName, byEmail: false };
}

/** 画面が読む全データ */
function getData_(clientName) {
  const r = resolveMe_(clientName);
  // 全部のTODOを見られるのはメンバー（出す側）だけ。メンバー１には、自分あてと自分が出したものだけを渡す
  const ms = members_();
  let tasks = [];
  if (r.me) {
    const n = r.me.name;
    const roleOf = {};
    ms.forEach(m => { roleOf[m.name] = m.role; });
    tasks = tasks_().map(t => Object.assign(t, { fromRole: roleOf[t.from] || '' }));
    if (r.me.role !== '上司') tasks = tasks.filter(t => t.from === n || t.to === 'all' || t.to.indexOf(n) >= 0);
  }
  return {
    ver: VERSION,
    me: r.me ? { name: r.me.name, role: r.me.role } : null,
    byEmail: r.byEmail,
    canCreate: !!r.me && (r.me.role === '上司' || BUKA_CAN_CREATE),
    // 「一覧に出さない」の人は、メンバー１の一覧には入れない。メンバー（出す側）と本人には見える
    members: ms.filter(m => !m.hidden || (r.me && (r.me.role === '上司' || m.name === r.me.name))).map(m => ({ name: m.name, role: m.role })),
    groups: groups_(),
    tasks: tasks
  };
}

// ===== 書き込み =====
function need_(clientName) {
  const me = resolveMe_(clientName).me;
  if (!me) throw new Error('メンバー表に名前がありません。管理者に追加してもらってください。');
  return me;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 「=」などで始まる文字が数式にならないようにする */
function safe_(s, max) {
  s = String(s || '').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function findRow_(sh, id) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return -1;
}

function addTask_(clientName, t) {
  const me = need_(clientName);
  if (me.role !== '上司' && !BUKA_CAN_CREATE) throw new Error('TODOを出せるのは「メンバー」の人だけです。');
  const title = safe_(t.title, 200);
  if (!title) throw new Error('「段取り or チェック」を入れてください。');
  // 宛先にできるのは、一覧に出ている人・自分・グループに入っている人だけ（メンバー＝出す側は、隠した人も選べる）
  const inGroup = {};
  groups_().forEach(g => g.members.forEach(n => { inGroup[n] = true; }));
  const names = members_().filter(m => !m.hidden || me.role === '上司' || m.name === me.name || inGroup[m.name]).map(m => m.name);
  // 「全員」あては廃止。必ずグループか人を選ぶ（前に出した「全員」あてのTODOは、そのまま表示される）
  const list = (Array.isArray(t.to) ? t.to : []).filter(n => names.indexOf(n) >= 0);
  if (!list.length) throw new Error('宛先のグループか人を選んでください。');
  const to = list.join('、');
  if (KINDS.indexOf(t.kind) < 0) throw new Error('種類（確認・お願い・質問）を選んでください。');
  const due = /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? "'" + t.due : '';
  withLock_(() => {
    sheet_(SHEET_TODO).appendRow([
      Utilities.getUuid().slice(0, 8), new Date(), safe_(t.project, 60), title, due,
      to, safe_(t.group, 40), me.name, '{}', '', '', t.kind
    ]);
  });
  return getData_(clientName);
}

function answer_(clientName, id, v) {
  const me = need_(clientName);
  if (v !== 'yes' && v !== 'no') throw new Error('返事が正しくありません。');
  withLock_(() => {
    const sh = sheet_(SHEET_TODO);
    const row = findRow_(sh, id);
    if (row < 0) throw new Error('このTODOは削除されています。');
    const to = String(sh.getRange(row, COL.to).getValue());
    if (to !== '全員' && to.split('、').indexOf(me.name) < 0) throw new Error('このTODOはあなた宛ではありません。');
    if (sh.getRange(row, COL.checkedBy).getValue()) throw new Error('完了したTODOです。');
    let a = {};
    try { a = JSON.parse(sh.getRange(row, COL.answers).getValue() || '{}'); } catch (e) { a = {}; }
    a[me.name] = v;
    sh.getRange(row, COL.answers).setValue(JSON.stringify(a));
  });
  return getData_(clientName);
}

function check_(clientName, id, on) {
  const me = need_(clientName);
  withLock_(() => {
    const sh = sheet_(SHEET_TODO);
    const row = findRow_(sh, id);
    if (row < 0) throw new Error('このTODOは削除されています。');
    // 完了✓は、出した本人か上司が押せる
    if (me.role !== '上司' && String(sh.getRange(row, COL.from).getValue()) !== me.name) throw new Error('完了にできるのは、出した人か「メンバー」の人だけです。');
    sh.getRange(row, COL.checkedBy, 1, 2).setValues([on ? [me.name, new Date()] : ['', '']]);
  });
  return getData_(clientName);
}

function deleteTasks_(clientName, ids) {
  const me = need_(clientName);
  withLock_(() => {
    const sh = sheet_(SHEET_TODO);
    const n = sh.getLastRow() - 1;
    if (n < 1) return;
    const all = sh.getRange(2, 1, n, COL.from).getValues();
    // 上司は全部、部下は自分が出したものだけ削除できる。下の行から消すと行番号がずれない
    for (let i = all.length - 1; i >= 0; i--) {
      if (ids.indexOf(String(all[i][0])) < 0) continue;
      if (me.role !== '上司' && String(all[i][COL.from - 1]) !== me.name) continue;
      sh.deleteRow(i + 2);
    }
  });
  return getData_(clientName);
}

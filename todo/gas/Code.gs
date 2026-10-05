/**
 * 工務部 TODO — Google Apps Script バックエンド
 *
 * ・スプレッドシートの「TODO」シートにタスクを保存（iPhone / iPad / PC で共有）
 * ・doGet  : 画面（Index.html）を返す。?key=合言葉 が必要
 * ・doPost : ① MCPコネクターからのAPI呼び出し ② LINE Webhook
 * ・morningPush : 毎朝、今日のTODOをLINEに送る（トリガーで実行）
 *
 * スクリプトプロパティ
 *   API_KEY                    … 合言葉（必須）
 *   LINE_CHANNEL_ACCESS_TOKEN  … LINE Messaging API のチャネルアクセストークン（任意）
 *   LINE_OWNER_USER_ID         … 自分の LINE userId（初回メッセージで自動登録）
 */

const SHEET_TODO = 'TODO';
const SHEET_LINE = 'LINE_LOG';
const HEADERS = ['id', 'title', 'memo', 'due', 'priority', 'source', 'ref',
  'done', 'doneAt', 'createdAt', 'updatedAt'];
const TZ = 'Asia/Tokyo';

// ───────────────────────── 初期設定 ─────────────────────────

/** 最初に1回だけ手動実行：シート作成・合言葉発行・朝7時のLINE通知トリガー登録 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_TODO);
  if (!sh) sh = ss.insertSheet(SHEET_TODO);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  let log = ss.getSheetByName(SHEET_LINE);
  if (!log) {
    log = ss.insertSheet(SHEET_LINE);
    log.appendRow(['receivedAt', 'userId', 'text']);
    log.setFrozenRows(1);
  }
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_KEY')) {
    props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  }
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'morningPush')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('morningPush').timeBased().atHour(7).everyDays(1)
    .inTimezone(TZ).create();
  Logger.log('合言葉(API_KEY): ' + props.getProperty('API_KEY'));
}

// ───────────────────────── 入口 ─────────────────────────

function doGet(e) {
  if (!checkKey_(e.parameter.key)) {
    return HtmlService.createHtmlOutput('<p style="font:16px sans-serif;padding:24px">URLの合言葉(key)が違います。</p>');
  }
  const t = HtmlService.createTemplateFromFile('Index');
  t.key = e.parameter.key;
  return t.evaluate()
    .setTitle('工務TODO')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: 'bad json' }); }

  // LINE Webhook（URL に ?key=合言葉 を付けて登録する）
  if (Array.isArray(body.events)) {
    if (!checkKey_(e.parameter.key)) return json_({ ok: false });
    body.events.forEach(ev => { try { handleLineEvent_(ev); } catch (err) { console.error(err); } });
    return json_({ ok: true });
  }

  // MCP / 外部API
  if (!checkKey_(body.key)) return json_({ ok: false, error: 'unauthorized' });
  try {
    return json_({ ok: true, result: api_(body.action, body) });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function api_(action, p) {
  switch (action) {
    case 'list': return listTodos_(!!p.includeDone);
    case 'add': return addTodo_(p);
    case 'addMany': return (p.items || []).map(addTodo_);
    case 'update': return updateTodo_(p.id, p.fields || {});
    case 'setDone': return updateTodo_(p.id, { done: p.done !== false });
    case 'delete': return deleteTodo_(p.id);
    case 'deleteMany': return deleteMany_(p.ids || []);
    case 'setDoneMany': return setDoneMany_(p.ids || [], p.done !== false);
    case 'lineLog': return lineLog_(p.limit || 30);
    default: throw new Error('unknown action: ' + action);
  }
}

// ───── 画面（google.script.run）から呼ぶ関数。すべて合言葉チェック付き ─────

function uiList(key, includeDone) { assertKey_(key); return listTodos_(includeDone); }
function uiAdd(key, item) { assertKey_(key); return addTodo_(Object.assign({ source: '手入力' }, item)); }
function uiUpdate(key, id, fields) { assertKey_(key); return updateTodo_(id, fields); }
function uiDelete(key, id) { assertKey_(key); return deleteTodo_(id); }
function uiDeleteMany(key, ids) { assertKey_(key); return deleteMany_(ids); }
function uiSetDoneMany(key, ids, done) { assertKey_(key); return setDoneMany_(ids, done); }

// ───────────────────────── データ操作 ─────────────────────────

function sheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_TODO);
  if (!sh) throw new Error('setup() を先に実行してください');
  return sh;
}

function readAll_() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, HEADERS.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    HEADERS.forEach((h, j) => { o[h] = r[j]; });
    o.done = o.done === true || o.done === 'TRUE';
    o.due = fmtDate_(o.due);
    o.doneAt = fmtTime_(o.doneAt);
    o.createdAt = fmtTime_(o.createdAt);
    o.updatedAt = fmtTime_(o.updatedAt);
    o.id = String(o.id);
    return o;
  });
}

function toRow_(o) {
  return HEADERS.map(h => (o[h] === undefined || o[h] === null) ? '' : o[h]);
}

function clean_(o) { const c = Object.assign({}, o); delete c._row; return c; }

/** 未完了＋直近7日の完了分を返す（includeDone=true なら全件） */
function listTodos_(includeDone) {
  const limit = Date.now() - 7 * 24 * 3600 * 1000;
  return readAll_()
    .filter(t => includeDone || !t.done || !t.doneAt || new Date(t.doneAt.replace(' ', 'T') + '+09:00').getTime() >= limit)
    .map(clean_);
}

function addTodo_(p) {
  const title = String(p.title || '').trim();
  if (!title) throw new Error('title が空です');
  return withLock_(() => {
    // ref（メールID・Plaud ID など）が同じものは二重登録しない
    if (p.ref) {
      const dup = readAll_().find(t => t.ref && String(t.ref) === String(p.ref));
      if (dup) return Object.assign(clean_(dup), { duplicate: true });
    }
    const now = nowStr_();
    const o = {
      id: Utilities.getUuid().slice(0, 8),
      title: title,
      memo: p.memo || '',
      due: normDue_(p.due),
      priority: ['高', '中', '低'].indexOf(p.priority) >= 0 ? p.priority : '中',
      source: p.source || 'API',
      ref: p.ref || '',
      done: false, doneAt: '', createdAt: now, updatedAt: now
    };
    const sh = sheet_();
    sh.appendRow(toRow_(o));
    sh.getRange(sh.getLastRow(), 4).setNumberFormat('@').setValue(o.due); // 日付の自動変換を防ぐ
    return o;
  });
}

function updateTodo_(id, fields) {
  return withLock_(() => {
    const t = readAll_().find(x => x.id === String(id));
    if (!t) throw new Error('見つかりません: ' + id);
    ['title', 'memo', 'priority'].forEach(k => { if (fields[k] !== undefined) t[k] = fields[k]; });
    if (fields.due !== undefined) t.due = normDue_(fields.due);
    if (fields.done !== undefined) {
      const d = fields.done === true || fields.done === 'true';
      if (d !== t.done) t.doneAt = d ? nowStr_() : '';
      t.done = d;
    }
    t.updatedAt = nowStr_();
    const range = sheet_().getRange(t._row, 1, 1, HEADERS.length);
    range.offset(0, 3, 1, 1).setNumberFormat('@');
    range.setValues([toRow_(t)]);
    return clean_(t);
  });
}

function deleteTodo_(id) {
  return withLock_(() => {
    const t = readAll_().find(x => x.id === String(id));
    if (!t) throw new Error('見つかりません: ' + id);
    sheet_().deleteRow(t._row);
    return { deleted: id };
  });
}

/** 選択したものをまとめて削除（下の行から消すので行番号がずれない） */
function deleteMany_(ids) {
  const want = {};
  (ids || []).forEach(id => { want[String(id)] = true; });
  return withLock_(() => {
    const sh = sheet_();
    const rows = readAll_().filter(t => want[t.id]).map(t => t._row).sort((a, b) => b - a);
    rows.forEach(r => sh.deleteRow(r));
    return { deleted: rows.length };
  });
}

/** 選択したものをまとめて完了（または未完了）にする */
function setDoneMany_(ids, done) {
  const want = {};
  (ids || []).forEach(id => { want[String(id)] = true; });
  return withLock_(() => {
    const sh = sheet_();
    const now = nowStr_();
    const changed = [];
    readAll_().filter(t => want[t.id] && t.done !== !!done).forEach(t => {
      t.done = !!done;
      t.doneAt = done ? now : '';
      t.updatedAt = now;
      const range = sh.getRange(t._row, 1, 1, HEADERS.length);
      range.offset(0, 3, 1, 1).setNumberFormat('@');
      range.setValues([toRow_(t)]);
      changed.push(clean_(t));
    });
    return changed;
  });
}

// ───────────────────────── LINE ─────────────────────────

function handleLineEvent_(ev) {
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  const props = PropertiesService.getScriptProperties();
  const userId = ev.source && ev.source.userId;
  const text = String(ev.message.text).trim();
  SpreadsheetApp.getActive().getSheetByName(SHEET_LINE).appendRow([nowStr_(), userId, text]);

  let owner = props.getProperty('LINE_OWNER_USER_ID');
  if (!owner && userId) {           // 最初に話しかけた人を持ち主として登録
    props.setProperty('LINE_OWNER_USER_ID', userId);
    owner = userId;
  }
  if (userId !== owner) return;     // 持ち主以外は記録だけ

  let reply;
  if (/^(一覧|リスト|今日|todo)$/i.test(text)) {
    reply = summaryText_();
  } else {
    const m = text.match(/^(完了|済|done)\s*(\d+)$/i);
    if (m) {
      const open = openSorted_();
      const t = open[Number(m[2]) - 1];
      if (t) { updateTodo_(t.id, { done: true }); reply = '✅ 完了にしました：' + t.title; }
      else reply = 'その番号はありません。「一覧」で確認してください。';
    } else {
      const parsed = parseLineText_(text);
      const o = addTodo_(Object.assign(parsed, { source: 'LINE' }));
      reply = '📝 追加しました：' + o.title + (o.due ? '（期限 ' + o.due + '）' : '');
    }
  }
  lineReply_(ev.replyToken, reply);
}

/** 「明日 見積 A社」「10/3 現場確認」「!至急 電話」などを解釈 */
function parseLineText_(text) {
  let due = '', priority = '中', t = text;
  const today = new Date();
  const dm = t.match(/^(今日|明日|明後日|あさって|(\d{1,2})[\/月](\d{1,2})日?)\s*/);
  if (dm) {
    const d = new Date(today);
    if (dm[1] === '明日') d.setDate(d.getDate() + 1);
    else if (dm[1] === '明後日' || dm[1] === 'あさって') d.setDate(d.getDate() + 2);
    else if (dm[2]) {
      d.setMonth(Number(dm[2]) - 1, Number(dm[3]));
      if (d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) d.setFullYear(d.getFullYear() + 1);
    }
    due = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
    t = t.slice(dm[0].length);
  }
  if (/^[!！]|至急|急ぎ/.test(t)) { priority = '高'; t = t.replace(/^[!！]\s*/, ''); }
  return { title: t || text, due: due, priority: priority };
}

function openSorted_() {
  const pr = { '高': 0, '中': 1, '低': 2 };
  return readAll_().filter(t => !t.done).sort((a, b) =>
    (a.due || '9999') .localeCompare(b.due || '9999') || pr[a.priority] - pr[b.priority]);
}

function summaryText_() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const open = openSorted_();
  if (!open.length) return '🎉 未完了のTODOはありません';
  const lines = open.slice(0, 20).map((t, i) => {
    const mark = t.due && t.due < today ? '⚠️' : t.due === today ? '📌' : '・';
    return (i + 1) + '. ' + mark + t.title + (t.due ? ' (' + t.due.slice(5).replace('-', '/') + ')' : '');
  });
  return '📋 未完了 ' + open.length + '件\n' + lines.join('\n') + '\n\n「完了 番号」で完了にできます';
}

function lineLog_(limit) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_LINE);
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  const start = Math.max(2, sh.getLastRow() - limit + 1);
  return sh.getRange(start, 1, sh.getLastRow() - start + 1, 3).getValues()
    .map(r => ({ receivedAt: fmtTime_(r[0]), userId: r[1], text: r[2] })).reverse();
}

function lineReply_(replyToken, text) {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !replyToken) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    muteHttpExceptions: true
  });
}

/** 毎朝7時：今日のTODOをLINEへプッシュ（トークンと持ち主が設定済みの場合） */
function morningPush() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const owner = props.getProperty('LINE_OWNER_USER_ID');
  if (!token || !owner) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: owner, messages: [{ type: 'text', text: 'おはようございます☀️\n' + summaryText_() }] }),
    muteHttpExceptions: true
  });
}

// ───────────────────────── 共通 ─────────────────────────

function checkKey_(key) {
  const k = PropertiesService.getScriptProperties().getProperty('API_KEY');
  return !!k && key === k;
}
function assertKey_(key) { if (!checkKey_(key)) throw new Error('unauthorized'); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function fmtTime_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : String(v || ''); }
function fmtDate_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || ''); }

function normDue_(v) {
  if (!v) return '';
  if (v instanceof Date) return fmtDate_(v);
  const m = String(v).match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

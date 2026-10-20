/**
 * 現場TODO共有（Googleスプレッドシート版）
 * データはこのスプレッドシートの「TODO」「メンバー」「グループ」シートに保存されます。
 * AIは使っていません。
 *
 * 役割は4つ（「メンバー」シートのC列）
 *   管理者 … 全部できる。上司・管理者を追加できるのは管理者だけ
 *   上司   … 部下・社外の人の追加と招待、TODOを出す・完了にする・削除する（以前の「メンバー」）
 *   部下   … 自分あてのTODOに返事をする。上司へ依頼を出す（以前の「メンバー１」。空欄も部下）
 *   社外   … 自分あてのTODOだけ。有効期限つき。招待URL＋暗証番号で入る
 * プログラムの中では、管理者と上司をまとめて role='上司'、部下と社外を role='部下' と呼ぶ。
 */

// 版（アプリの一番下に出る。貼り付けとデプロイができたかの確認用）
const VERSION = '10/20-A';

// 画面（GitHub Pages）の場所
const PAGES_URL = 'https://ak05080707.github.io/rakugaki-app/genba-todo/';

// ===== 設定（必要なら書き換えてください） =====
const BUKA_CAN_CREATE = true; // 部下もTODO（依頼）を出せる（出せないようにするなら false）
const EXPIRY_WARN_DAYS = 7;   // 社外の人の有効期限が、あと何日で「もうすぐ期限」と出すか

// ===== シート名と見出し =====
const SHEET_TODO = 'TODO';
const SHEET_MEMBER = 'メンバー';
const MEMBER_ALIASES = ['メンバー', 'メンバー１', 'メンバー1']; // どの名前のタブでも読めるようにする
const SHEET_GROUP = 'グループ';
const TODO_HEAD = ['ID', '作成日時', '工事名', '段取り or チェック', '期限', '宛先', 'グループ名', '出した人', '返事', '確認者', '確認日時', '種類'];
const KINDS = ['確認', 'お願い', '質問'];
const LEVELS = ['管理者', '上司', '部下', '社外'];
const MEMBER_HEAD = ['名前', 'メールアドレス（任意）', '役割（管理者/上司/部下/社外）', '一覧に出さない（○を入れる）',
  'チーム（「、」で区切る）', '担当工事（「、」で区切る）', '有効期限（社外の人）', '状態（停止）',
  '追加した人', '追加した日', '招待コード（さわらない）', '暗証番号（さわらない）'];
const GROUP_HEAD = ['グループ名', 'メンバー（名前を「、」で区切る）'];
const COL = { id: 1, created: 2, project: 3, title: 4, due: 5, to: 6, group: 7, from: 8, answers: 9, checkedBy: 10, checkedAt: 11, kind: 12 };
const MCOL = { name: 1, email: 2, level: 3, hidden: 4, teams: 5, projects: 6, expiry: 7, status: 8, addedBy: 9, addedAt: 10, token: 11, pin: 12 };

// このリクエストで、だれが使っているか（doPost の最初に決める）
let AUTH_ = null;

/**
 * 画面は GitHub Pages に引っ越した。このURLを直接開いた人には案内だけ出す
 */
function doGet() {
  const html = '<div style="font-family:sans-serif;padding:24px;line-height:1.8">' +
    '<h2>現場TODO共有は、新しいURLに引っ越しました</h2>' +
    '<p>上司から届いた、新しいURLを開いてください。</p>' +
    '<p>（ホーム画面のアイコンも、新しいURLで作り直してください）</p></div>';
  return HtmlService.createHtmlOutput(html).setTitle('現場TODO共有')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 画面（GitHub Pages）からの読み書きの入口。
 * 本文は {"t":"招待コード","pin":"暗証番号","fn":"getData","args":[...]}
 *     または（管理者が最初に入るとき）{"key":"合言葉","fn":...}
 */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    AUTH_ = auth_(req);
    if (AUTH_.needPin) {
      out = { ok: true, data: { ver: VERSION, needPin: true, pinName: AUTH_.name, wrongPin: AUTH_.wrongPin } };
    } else {
      const fns = {
        getData: getData_, addTask: addTask_, answer: answer_, check: check_, deleteTasks: deleteTasks_,
        addMember: addMember_, inviteLink: inviteLink_, resetLink: resetLink_, setPin: setPin_,
        setExpiry: setExpiry_, setStopped: setStopped_
      };
      const fn = fns[req.fn];
      if (!fn) throw new Error('この操作はできません。');
      out = { ok: true, data: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
    }
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** だれが使っているかを決める。招待コード（個人用）か、合言葉（管理者が最初に入るとき）か */
function auth_(req) {
  if (req.t) {
    const m = members_().find(x => x.token && x.token === String(req.t));
    if (!m) throw new Error('この招待URLは使えなくなっています。上司に新しいURLをもらってください。');
    checkActive_(m);
    if (m.pinHash && hashPin_(String(req.pin || ''), m.token) !== m.pinHash) {
      return { needPin: true, name: m.name, wrongPin: !!req.pin };
    }
    return { mode: 'token', me: m };
  }
  const key = PropertiesService.getScriptProperties().getProperty('GENBA_KEY');
  if (key && req.key === key) return { mode: 'key' };
  throw new Error('URLが正しくありません。上司から届いたURLを開き直してください。');
}

/** 停止中・有効期限切れの人は入れない */
function checkActive_(m) {
  if (m.stopped) throw new Error('このURLは使えなくなっています。上司に連絡してください。');
  if (m.level === '社外' && m.expiry && today_() > m.expiry) {
    throw new Error('有効期限（' + m.expiry.replace(/-/g, '/') + '）が過ぎています。上司に連絡してください。');
  }
}

/** 合言葉を作る（まだなければ）。読みまちがえにくい文字だけ使う */
function key_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('GENBA_KEY');
  if (!key) {
    key = randomCode_(10);
    props.setProperty('GENBA_KEY', key);
  }
  return key;
}

function randomCode_(len) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** 管理者用のURLを実行ログに出す（デプロイしたあとに実行する） */
function showUrl() {
  const key = key_();
  const api = ScriptApp.getService().getUrl();
  Logger.log('合言葉：' + key);
  Logger.log('管理者用のURLづくりのページ（URLと合言葉を入れるとQRコードができる）：' + PAGES_URL + 'setup.html');
  if (!api) {
    Logger.log('まだ公開（デプロイ）されていません。先に「デプロイ」をしてから、もう一度 showUrl を実行してください。');
    return;
  }
  if (!/\/exec$/.test(api)) {
    Logger.log('（注意）ここで分かったURLが /exec で終わっていません：' + api);
    Logger.log('デプロイの画面に出る「ウェブアプリのURL」（/exec で終わるもの）と、上の合言葉を、上のページに入れてください。');
    return;
  }
  Logger.log('管理者用のURL（管理者が最初に入るときに使う。ほかの人には、アプリの「メンバーの追加・招待」から個人用のURLを送る）：');
  Logger.log(PAGES_URL + '#api=' + encodeURIComponent(api) + '&key=' + key);
}

/** 合言葉を作り直す（管理者用のURLが外にもれたとき）。個人用の招待URLはそのまま使える */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('GENBA_KEY');
  showUrl();
}

/** 最初に1回だけ実行：シートと見出しを作る（あとから実行しても、データは消えない） */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const td = ensureSheet_(ss, SHEET_TODO, TODO_HEAD);
  // あとから増えた列（種類）の見出しを足す
  if (!String(td.getRange(1, COL.kind).getValue()).trim()) td.getRange(1, COL.kind).setValue('種類').setFontWeight('bold');
  const m = memberSheet_(ss) || ensureSheet_(ss, SHEET_MEMBER, MEMBER_HEAD);
  if (m.getLastRow() < 2) m.appendRow(['（例）山田 太郎', '', '管理者']);
  // あとから増えた列の見出しを足す（すでに何か書いてある見出しは変えない）
  for (let c = 4; c <= MEMBER_HEAD.length; c++) {
    if (!String(m.getRange(1, c).getValue()).trim()) m.getRange(1, c).setValue(MEMBER_HEAD[c - 1]).setFontWeight('bold');
  }
  // 招待コードと暗証番号の列は、まちがえて書き換えないように隠す
  m.hideColumns(MCOL.token, 2);
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
  return n > 0 ? sh.getRange(2, 1, n, Math.max(sh.getLastColumn(), 1)).getValues() : [];
}

// ===== 読み込み =====
const splitList_ = v => String(v || '').split(/[、,，\n]+/).map(s => s.trim()).filter(Boolean);

function members_() {
  return rows_(SHEET_MEMBER).map((r, i) => {
    const level = levelOf_(r[MCOL.level - 1]);
    return {
      row: i + 2,
      name: String(r[MCOL.name - 1] || '').trim(),
      email: String(r[MCOL.email - 1] || '').trim().toLowerCase(),
      level: level,
      role: (level === '管理者' || level === '上司') ? '上司' : '部下',
      hidden: !!String(r[MCOL.hidden - 1] || '').trim(),
      teams: splitList_(r[MCOL.teams - 1]),
      projects: splitList_(r[MCOL.projects - 1]),
      expiry: fmtDate_(r[MCOL.expiry - 1]),
      stopped: String(r[MCOL.status - 1] || '').indexOf('停止') >= 0,
      addedBy: String(r[MCOL.addedBy - 1] || '').trim(),
      addedAt: fmtDate_(r[MCOL.addedAt - 1]),
      token: String(r[MCOL.token - 1] || '').trim(),
      pinHash: String(r[MCOL.pin - 1] || '').trim()
    };
  }).filter(m => m.name);
}

/** 役割の列の書き方 → 役割。「メンバー」「上司」は上司、空欄やそれ以外は部下 */
function levelOf_(v) {
  const s = String(v || '').replace(/\s/g, '');
  if (s === '管理者') return '管理者';
  if (s === '上司' || s === 'メンバー') return '上司';
  if (s === '社外') return '社外';
  return '部下';
}

function groups_() {
  return rows_(SHEET_GROUP)
    .map(r => ({ name: String(r[0]).trim(), members: splitList_(r[1]) }))
    .filter(g => g.name);
}

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const s = String(v || '').trim().replace(/\//g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : s;
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDays_(ymd, n) {
  const p = ymd.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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

/**
 * 今の利用者を決める。
 * 招待URL（個人用）で入った人は、その人。
 * 合言葉のURLで入った人は、選んだ名前（ただし、まだ個人用の招待URLを持っていない社員だけ。社外の人は不可）
 */
function resolveMe_(clientName) {
  if (AUTH_ && AUTH_.mode === 'token') return { me: AUTH_.me, byToken: true };
  const m = members_().find(x => x.name === clientName);
  if (m && keyLoginOk_(m)) return { me: m, byToken: false };
  return { me: null, byToken: false };
}

/** 合言葉のURLで、名前を選んで入れる人 */
function keyLoginOk_(m) {
  // 管理者は、個人用のURLを持っていても合言葉のURLで入れる（URLをなくしたときのため）
  return !m.stopped && m.level !== '社外' && (!m.token || m.level === '管理者');
}

// ===== 見える範囲（チーム・工事） =====
/**
 * 上司が見られる範囲。管理者は全部。
 * 上司にチームも担当工事も決めていなければ、今までどおり全部見られる。
 */
function scope_(me, ms) {
  if (me.level === '管理者') return { all: true };
  if (me.level === '上司' && !me.teams.length && !me.projects.length) return { all: true };
  const names = {};
  names[me.name] = true;
  if (me.teams.length) ms.forEach(m => { if (m.teams.some(t => me.teams.indexOf(t) >= 0)) names[m.name] = true; });
  if (me.projects.length) ms.forEach(m => { if (m.projects.some(p => me.projects.indexOf(p) >= 0)) names[m.name] = true; });
  const projects = {};
  me.projects.forEach(p => { projects[p] = true; });
  return { all: false, names: names, projects: projects };
}

function isMine_(me, t) {
  const R = t.to === 'all' ? null : t.to;
  if (t.from === me.name) return true;
  if (!R) return me.level !== '社外';   // 以前の「全員」あては、社外の人には見せない
  return R.indexOf(me.name) >= 0;
}

function canSeeTask_(me, sc, t) {
  if (isMine_(me, t)) return true;
  if (me.role !== '上司') return false;          // 部下・社外は、自分に関係するものだけ
  if (sc.all) return true;
  if (t.project && sc.projects[t.project]) return true;
  const people = [t.from].concat(t.to === 'all' ? [] : t.to);
  return people.some(n => sc.names[n]);
}

/** 宛先に選べる人（画面の「人を選ぶ」） */
function visibleMembers_(me, ms, sc) {
  const live = ms.filter(m => !m.stopped);
  if (me.level === '管理者' || (me.level === '上司' && sc.all)) return live;
  const shares = m => m.teams.some(t => me.teams.indexOf(t) >= 0) || m.projects.some(p => me.projects.indexOf(p) >= 0);
  if (me.level === '上司') return live.filter(m => m.name === me.name || m.role === '上司' || sc.names[m.name]);
  if (me.level === '社外') {
    const bosses = live.filter(m => m.role === '上司' && shares(m));
    const list = bosses.length ? bosses : live.filter(m => m.level === '管理者');
    return list.concat(live.filter(m => m.name === me.name));
  }
  // 部下：一覧に出さない人と、関係のない社外の人は出さない
  return live.filter(m => m.name === me.name || (!m.hidden && (m.level !== '社外' || shares(m))));
}

/** 上司が追加・招待・停止できる人 */
function manageable_(me, ms, sc) {
  if (me.level === '管理者') return ms;
  if (me.level !== '上司') return [];
  return ms.filter(m => m.name === me.name ||
    ((m.level === '部下' || m.level === '社外') && (sc.all || sc.names[m.name] || m.addedBy === me.name)));
}

function canEditExpiry_(me, m) {
  return me.level === '管理者' || (me.level === '上司' && m.addedBy === me.name);
}

/** 画面が読む全データ */
function getData_(clientName) {
  const r = resolveMe_(clientName);
  const ms = members_();
  const base = { ver: VERSION, byToken: r.byToken, groups: [], tasks: [] };
  if (!r.me) {
    // まだ名前が決まっていない：合言葉のURLで、名前を選んで入れる人だけ出す
    return Object.assign(base, {
      me: null, canCreate: false,
      members: ms.filter(m => keyLoginOk_(m) && !m.hidden).map(m => ({ name: m.name, role: m.role }))
    });
  }
  const me = r.me;
  const sc = scope_(me, ms);
  const roleOf = {};
  ms.forEach(m => { roleOf[m.name] = m.role; });
  const tasks = tasks_().filter(t => canSeeTask_(me, sc, t)).map(t => Object.assign(t, { fromRole: roleOf[t.from] || '' }));
  const data = Object.assign(base, {
    me: { name: me.name, role: me.role, level: me.level, expiry: me.expiry },
    canCreate: me.role === '上司' || BUKA_CAN_CREATE,
    members: visibleMembers_(me, ms, sc).map(m => ({ name: m.name, role: m.role })),
    groups: me.level === '社外' ? [] : groups_(),
    tasks: tasks
  });
  if (me.role === '上司') {
    const today = today_(), soon = addDays_(today, EXPIRY_WARN_DAYS);
    const list = manageable_(me, ms, sc);
    data.people = list.map(m => ({
      name: m.name, level: m.level, teams: m.teams, projects: m.projects, expiry: m.expiry,
      stopped: m.stopped, addedBy: m.addedBy, hasLink: !!m.token, hasPin: !!m.pinHash,
      canEditExpiry: canEditExpiry_(me, m), isMe: m.name === me.name
    }));
    data.alerts = list.filter(m => m.level === '社外' && !m.stopped && m.expiry && m.expiry <= soon)
      .map(m => ({ name: m.name, expiry: m.expiry, passed: m.expiry < today }));
    data.canAddBoss = me.level === '管理者';
  }
  return data;
}

// ===== 書き込み =====
function need_(clientName) {
  const me = resolveMe_(clientName).me;
  if (!me) throw new Error('メンバー表に名前がありません。上司に追加してもらってください。');
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

function taskAt_(sh, row) {
  const r = sh.getRange(row, 1, 1, COL.kind).getValues()[0];
  const to = String(r[COL.to - 1]);
  return { project: String(r[COL.project - 1] || ''), to: to === '全員' ? 'all' : to.split('、').filter(Boolean), from: String(r[COL.from - 1] || '') };
}

function addTask_(clientName, t) {
  const me = need_(clientName);
  if (me.role !== '上司' && !BUKA_CAN_CREATE) throw new Error('TODOを出せるのは上司だけです。');
  const title = safe_(t.title, 200);
  if (!title) throw new Error('「段取り or チェック」を入れてください。');
  const ms = members_();
  const sc = scope_(me, ms);
  // 宛先にできるのは、自分の画面に出る人と、グループに入っている人（社外の人はグループを使えない）
  const ok = {};
  visibleMembers_(me, ms, sc).forEach(m => { ok[m.name] = true; });
  if (me.level !== '社外') groups_().forEach(g => g.members.forEach(n => { if (ms.some(m => m.name === n && !m.stopped)) ok[n] = true; }));
  const list = (Array.isArray(t.to) ? t.to : []).filter(n => ok[n]);
  if (!list.length) throw new Error('宛先のグループか人を選んでください。');
  if (KINDS.indexOf(t.kind) < 0) throw new Error('種類（確認・お願い・質問）を選んでください。');
  const due = /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? "'" + t.due : '';
  withLock_(() => {
    sheet_(SHEET_TODO).appendRow([
      Utilities.getUuid().slice(0, 8), new Date(), safe_(t.project, 60), title, due,
      list.join('、'), safe_(t.group, 40), me.name, '{}', '', '', t.kind
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
    const forAll = to === '全員' && me.level !== '社外';
    if (!forAll && to.split('、').indexOf(me.name) < 0) throw new Error('このTODOはあなた宛ではありません。');
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
    const t = taskAt_(sh, row);
    // 完了✓は、出した本人か、そのTODOが見えている上司が押せる
    const ok = t.from === me.name || (me.role === '上司' && canSeeTask_(me, scope_(me, members_()), t));
    if (!ok) throw new Error('完了にできるのは、出した人か上司だけです。');
    sh.getRange(row, COL.checkedBy, 1, 2).setValues([on ? [me.name, new Date()] : ['', '']]);
  });
  return getData_(clientName);
}

function deleteTasks_(clientName, ids) {
  const me = need_(clientName);
  const sc = scope_(me, members_());
  withLock_(() => {
    const sh = sheet_(SHEET_TODO);
    const n = sh.getLastRow() - 1;
    if (n < 1) return;
    const all = sh.getRange(2, 1, n, COL.from).getValues();
    // 上司は自分に見えているもの、部下・社外は自分が出したものだけ削除できる。下の行から消すと行番号がずれない
    for (let i = all.length - 1; i >= 0; i--) {
      if (ids.indexOf(String(all[i][0])) < 0) continue;
      const to = String(all[i][COL.to - 1]);
      const t = { project: String(all[i][COL.project - 1] || ''), to: to === '全員' ? 'all' : to.split('、').filter(Boolean), from: String(all[i][COL.from - 1]) };
      if (t.from !== me.name && !(me.role === '上司' && canSeeTask_(me, sc, t))) continue;
      sh.deleteRow(i + 2);
    }
  });
  return getData_(clientName);
}

// ===== メンバーの追加・招待（上司と管理者） =====
function needBoss_(clientName) {
  const me = need_(clientName);
  if (me.role !== '上司') throw new Error('この操作は上司だけができます。');
  return me;
}

/** 操作する相手を探す（自分が扱える人だけ） */
function target_(me, name) {
  const ms = members_();
  const m = ms.find(x => x.name === String(name || '').trim());
  if (!m) throw new Error('「' + name + '」さんはメンバー表にいません。');
  if (!manageable_(me, ms, scope_(me, ms)).some(x => x.name === m.name)) throw new Error('「' + m.name + '」さんの設定は変えられません。');
  return m;
}

function hashPin_(pin, token) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pin + ':' + token, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function newToken_() {
  return randomCode_(20);
}

function validPin_(pin) {
  return /^\d{4}$/.test(String(pin || ''));
}

/** 新しい人を追加する。追加したら、そのまま招待できるように招待コードを作る */
function addMember_(clientName, p) {
  const me = needBoss_(clientName);
  p = p || {};
  const name = String(p.name || '').trim().replace(/^[=+\-@]+/, '').slice(0, 40);
  if (!name) throw new Error('名前を入れてください。');
  const level = LEVELS.indexOf(p.level) >= 0 ? p.level : '部下';
  if ((level === '管理者' || level === '上司') && me.level !== '管理者') throw new Error('上司・管理者を追加できるのは、管理者だけです。');
  let expiry = '';
  if (level === '社外') {
    expiry = fmtDate_(p.expiry);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error('社外の人は、有効期限を入れてください。');
    if (expiry < today_()) throw new Error('有効期限が、今日より前になっています。');
    if (!validPin_(p.pin)) throw new Error('社外の人は、暗証番号（数字4けた）を決めてください。');
  }
  if (p.pin && !validPin_(p.pin)) throw new Error('暗証番号は、数字4けたにしてください。');
  const token = newToken_();
  withLock_(() => {
    if (members_().some(m => m.name === name)) throw new Error('「' + name + '」さんは、もういます。同じ名前の人は「' + name + '（会社名）」のように分けてください。');
    sheet_(SHEET_MEMBER).appendRow([
      name, '', level, '', safe_(p.teams, 100), safe_(p.projects, 200), expiry ? "'" + expiry : '', '',
      me.name, "'" + today_(), token, p.pin ? hashPin_(String(p.pin), token) : ''
    ]);
  });
  const data = getData_(clientName);
  data.invite = { name: name, token: token, hasPin: !!p.pin };
  return data;
}

/** 招待URL用のコードを出す（まだなければ作る） */
function inviteLink_(clientName, name) {
  const me = needBoss_(clientName);
  const m = target_(me, name);
  if (m.stopped) throw new Error('「' + m.name + '」さんは、使えなくしてあります。先に「使えるようにする」を押してください。');
  let token = m.token;
  if (!token) {
    token = newToken_();
    withLock_(() => { sheet_(SHEET_MEMBER).getRange(m.row, MCOL.token).setValue(token); });
  }
  return { name: m.name, token: token, hasPin: !!m.pinHash, level: m.level };
}

/** 招待URLを作り直す（前のURLは使えなくなる。暗証番号も決め直し） */
function resetLink_(clientName, name) {
  const me = needBoss_(clientName);
  const m = target_(me, name);
  const token = newToken_();
  withLock_(() => { sheet_(SHEET_MEMBER).getRange(m.row, MCOL.token, 1, 2).setValues([[token, '']]); });
  return { name: m.name, token: token, hasPin: false, level: m.level };
}

/** 暗証番号を決める（空にすると暗証番号なし。社外の人は必ず必要） */
function setPin_(clientName, name, pin) {
  const me = needBoss_(clientName);
  const m = target_(me, name);
  pin = String(pin || '');
  if (!pin && m.level === '社外') throw new Error('社外の人は、暗証番号が必要です。');
  if (pin && !validPin_(pin)) throw new Error('暗証番号は、数字4けたにしてください。');
  let token = m.token;
  withLock_(() => {
    if (!token) token = newToken_();
    sheet_(SHEET_MEMBER).getRange(m.row, MCOL.token, 1, 2).setValues([[token, pin ? hashPin_(pin, token) : '']]);
  });
  return { name: m.name, token: token, hasPin: !!pin, level: m.level };
}

/** 有効期限を変える（管理者と、その人を追加した上司） */
function setExpiry_(clientName, name, date) {
  const me = needBoss_(clientName);
  const m = target_(me, name);
  if (!canEditExpiry_(me, m)) throw new Error('有効期限を変えられるのは、管理者と、「' + m.name + '」さんを追加した人だけです。');
  const d = fmtDate_(date);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('日付が正しくありません。');
  if (!date && m.level === '社外') throw new Error('社外の人は、有効期限が必要です。');
  withLock_(() => { sheet_(SHEET_MEMBER).getRange(m.row, MCOL.expiry).setValue(d ? "'" + d : ''); });
  return getData_(clientName);
}

/** 使えなくする・使えるようにする */
function setStopped_(clientName, name, stop) {
  const me = needBoss_(clientName);
  const m = target_(me, name);
  if (m.name === me.name) throw new Error('自分を使えなくすることはできません。');
  withLock_(() => { sheet_(SHEET_MEMBER).getRange(m.row, MCOL.status).setValue(stop ? '停止' : ''); });
  return getData_(clientName);
}

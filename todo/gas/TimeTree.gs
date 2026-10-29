/**
 * LINE で「予定 …」と送ると、TimeTree に予定を入れる（非公式）
 *
 * TimeTree の公式APIは2023年に終了しているため、Web版（timetreeapp.com）と同じ内部APIを使う。
 * TimeTree 側の仕様変更で動かなくなる可能性がある。失敗したときは TODO に入れて LINE で知らせる。
 *
 * スクリプトプロパティ
 *   TIMETREE_EMAIL     … TimeTree にログインするメールアドレス
 *   TIMETREE_PASSWORD  … TimeTree のパスワード
 *   TIMETREE_CALENDAR  … 入れるカレンダーの名前（一部でOK。省略すると一番上のカレンダー）
 *
 * 送り方の例
 *   予定 10/30 14:00 A邸 打合せ        … 14:00〜15:00
 *   予定 明日 9時半-11時 B現場 立会い  … 9:30〜11:00
 *   予定 11/3 社内清掃                 … 終日
 */

const TT_BASE = 'https://timetreeapp.com';
const TT_API = TT_BASE + '/api/v1';
const TT_UA = 'web/2.1.0/en';
const TT_CACHE_KEY = 'tt-session';

/** LINE の文が「予定 …」なら true */
function isScheduleText_(text) {
  return /^(予定|📅)[\s　:：]*/.test(text);
}

/** LINE の「予定 …」を処理して、返事の文を返す */
function handleScheduleText_(text) {
  const s = parseScheduleText_(text);
  if (s.error) return s.error;
  try {
    const r = ttCreateEvent_(s);
    return '📅 TimeTree（' + r.calendar + '）に入れました\n' + scheduleLabel_(s);
  } catch (err) {
    // TimeTree に入らなくても、忘れないよう TODO に残す
    addTodo_({ title: s.title, due: s.date, memo: '予定 ' + scheduleLabel_(s) + '（TimeTree に入れられなかった分）', source: 'LINE' });
    return '⚠️ TimeTree に入れられませんでした（' + String(err.message || err).slice(0, 120) + '）\n'
      + 'TODO に入れておきました：' + s.title + '（' + s.date + '）';
  }
}

const SCHEDULE_HELP = '予定の送り方：\n予定 10/30 14:00 A邸 打合せ\n予定 明日 9時半-11時 B現場 立会い\n予定 11/3 社内清掃（時間なし＝終日）';

/**
 * 「予定 10/30 14:00-15:30 A邸 打合せ」を読み取る
 * @return {{date:string, start:string, end:string, allDay:boolean, title:string} | {error:string}}
 */
function parseScheduleText_(text) {
  let t = String(text).replace(/^(予定|📅)[\s　:：]*/, '').replace(/[０-９：／]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ').trim();

  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const [ty, tm, td] = today.split('-').map(Number);
  let date = '';
  const dm = t.match(/^(今日|本日|明日|明後日|あさって|(?:(\d{4})[\/年])?(\d{1,2})[\/月](\d{1,2})日?)(?:\s*[(（][^)）]*[)）])?\s*/);
  if (dm) {
    let y = ty, m = tm, d = td;
    if (dm[1] === '明日') d += 1;
    else if (dm[1] === '明後日' || dm[1] === 'あさって') d += 2;
    else if (dm[3]) {
      m = Number(dm[3]); d = Number(dm[4]);
      if (dm[2]) y = Number(dm[2]);
      else if (m < tm || (m === tm && d < td)) y += 1;   // 過ぎた日付は来年
    }
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dm[3] && (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)) {   // 2/30 など
      return { error: '日付が読み取れませんでした：' + dm[1] + '\n\n' + SCHEDULE_HELP };
    }
    date = dt.toISOString().slice(0, 10);
    t = t.slice(dm[0].length);
  }
  if (!date) return { error: '日付が見つかりませんでした。\n\n' + SCHEDULE_HELP };

  // 時刻：14:00 / 14時 / 14時半 / 14時30分 / 午後2時、範囲は - 〜 ～ ~ から
  const TIME = '(午前|午後)?\\s*(\\d{1,2})(?::(\\d{2})|時(?:(半)|(\\d{1,2})分)?)';
  const tm1 = t.match(new RegExp('^' + TIME + '(?:\\s*[-〜～~]\\s*' + TIME + ')?\\s*'));
  let start = '', end = '';
  if (tm1) {
    const hm = (ampm, h, mm, half, mm2) => {
      let H = Number(h), M = mm ? Number(mm) : half ? 30 : mm2 ? Number(mm2) : 0;
      if (ampm === '午後' && H < 12) H += 12;
      if (ampm === '午前' && H === 12) H = 0;
      return H <= 23 && M <= 59 ? ('0' + H).slice(-2) + ':' + ('0' + M).slice(-2) : '';
    };
    start = hm(tm1[1], tm1[2], tm1[3], tm1[4], tm1[5]);
    if (tm1[7]) end = hm(tm1[6] || tm1[1], tm1[7], tm1[8], tm1[9], tm1[10]);
    if (!start || (tm1[7] && !end)) return { error: '時刻が読み取れませんでした。\n\n' + SCHEDULE_HELP };
    if (!end || end <= start) {           // 終わりがなければ1時間
      const e = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + 60;
      end = e >= 24 * 60 ? '23:59' : ('0' + Math.floor(e / 60)).slice(-2) + ':' + ('0' + e % 60).slice(-2);
    }
    t = t.slice(tm1[0].length);
  }
  const title = t.trim();
  if (!title) return { error: '予定の名前がありません。\n\n' + SCHEDULE_HELP };
  return { date: date, start: start, end: end, allDay: !start, title: title };
}

function scheduleLabel_(s) {
  const w = '日月火水木金土'[new Date(s.date + 'T00:00:00Z').getUTCDay()];
  const d = Number(s.date.slice(5, 7)) + '/' + Number(s.date.slice(8)) + '(' + w + ')';
  return d + ' ' + (s.allDay ? '終日' : s.start + '〜' + s.end) + ' ' + s.title;
}

// ───────────────────────── TimeTree 通信 ─────────────────────────

/** 予定を作る。@return {{calendar:string, id:string}} */
function ttCreateEvent_(s) {
  const cal = ttCalendar_();
  const jst = hm => Date.parse(s.date + 'T' + hm + ':00+09:00');
  const allDayMs = Date.parse(s.date + 'T00:00:00Z');
  const payload = {
    title: s.title,
    all_day: s.allDay,
    start_at: s.allDay ? allDayMs : jst(s.start),
    start_timezone: s.allDay ? 'UTC' : TZ,
    end_at: s.allDay ? allDayMs : jst(s.end),
    end_timezone: s.allDay ? 'UTC' : TZ,
    label_id: 1,
    note: 'LINE から登録',
    location: '',
    attendees: [ttUserId_()],
    recurrences: [],
    alerts: [],
    attachment: { virtual_user_attendees: [] },
    category: 1
  };
  const r = ttRequest_('post', '/calendar/' + cal.id + '/event', payload);
  return { calendar: cal.name, id: r && r.event ? r.event.id : '' };
}

function ttCalendar_() {
  const want = (PropertiesService.getScriptProperties().getProperty('TIMETREE_CALENDAR') || '').trim();
  const cals = ttCalendars_();
  if (!cals.length) throw new Error('カレンダーがありません');
  const hit = want ? cals.find(c => c.name.indexOf(want) >= 0) : cals[0];
  if (!hit) throw new Error('「' + want + '」という名前のカレンダーがありません');
  return hit;
}

function ttCalendars_() {
  const data = ttRequest_('get', '/calendars?since=0');
  return (data.calendars || []).filter(c => c.deactivated_at == null).map(c => ({ id: c.id, name: c.name }));
}

function ttUserId_() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('TIMETREE_USER_ID');
  if (cached) return Number(cached);
  const u = (ttRequest_('get', '/user') || {}).user || {};
  if (!u.id) throw new Error('ユーザー情報が取れませんでした');
  props.setProperty('TIMETREE_USER_ID', String(u.id));
  return u.id;
}

/** ログイン情報（セッションと CSRF トークン）を6時間キャッシュして使い回す */
function ttSession_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get(TT_CACHE_KEY);
    if (hit) return JSON.parse(hit);
  }
  const props = PropertiesService.getScriptProperties();
  // 貼り付けた時に前後に入りがちな空白・改行は取り除く
  const email = (props.getProperty('TIMETREE_EMAIL') || '').trim(), pw = (props.getProperty('TIMETREE_PASSWORD') || '').trim();
  if (!email || !pw) throw new Error('TimeTree のメールアドレス・パスワードが未設定です');
  const res = UrlFetchApp.fetch(TT_API + '/auth/email/signin', {
    method: 'put', contentType: 'application/json', headers: { 'X-Timetreea': TT_UA },
    payload: JSON.stringify({ uid: email, password: pw, uuid: Utilities.getUuid().replace(/-/g, '') }),
    muteHttpExceptions: true, followRedirects: false
  });
  if (res.getResponseCode() !== 200) {
    let code;
    try { code = JSON.parse(res.getContentText()).error.code; } catch (e) { /* 本文なし */ }
    if (code === -702) throw new Error('メールアドレスかパスワードが違います');
    if (code === -495) throw new Error('ログインの回数制限中です。しばらく待ってください');
    throw new Error('ログインに失敗しました（HTTP ' + res.getResponseCode() + '）');
  }
  const sid = ttCookie_(res);
  if (!sid) throw new Error('ログインはできましたがセッションが取れませんでした');
  const s = { sid: sid, csrf: '' };
  // 書き込みには CSRF トークンが要る（Web版の画面の <meta name="csrf-token"> から取る）
  const page = UrlFetchApp.fetch(TT_BASE + '/calendars', {
    headers: { 'X-Timetreea': TT_UA, Cookie: '_session_id=' + sid }, muteHttpExceptions: true, followRedirects: false
  });
  s.sid = ttCookie_(page) || s.sid;
  const m = page.getContentText().match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/)
    || page.getContentText().match(/<meta[^>]+content="([^"]+)"[^>]+name="csrf-token"/);
  if (!m) throw new Error('書き込み用のトークンが取れませんでした（HTTP ' + page.getResponseCode() + '）');
  s.csrf = m[1];
  cache.put(TT_CACHE_KEY, JSON.stringify(s), 6 * 3600);
  return s;
}

function ttCookie_(res) {
  const h = res.getAllHeaders()['Set-Cookie'];
  const m = [].concat(h || []).join(';').match(/_session_id=([^;]+)/);
  return m ? m[1] : '';
}

function ttRequest_(method, path, body) {
  let s = ttSession_(false);
  const send = () => UrlFetchApp.fetch(TT_API + path, {
    method: method,
    headers: Object.assign({ 'X-Timetreea': TT_UA, Cookie: '_session_id=' + s.sid },
      method === 'get' ? {} : { 'X-CSRF-Token': s.csrf }),
    contentType: 'application/json',
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true, followRedirects: false
  });
  let res = send();
  if ([401, 403, 422].indexOf(res.getResponseCode()) >= 0) {   // 期限切れ → ログインし直して1回だけ再送
    s = ttSession_(true);
    res = send();
  }
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('TimeTree の応答 HTTP ' + code + ' ' + path.split('?')[0]);
  const txt = res.getContentText();
  return txt ? JSON.parse(txt) : {};
}

// ───────────────────────── 動作確認（Apps Script で ▷実行） ─────────────────────────

/** ログイン → カレンダー一覧 → 明日 9:00 にテスト予定を作る → すぐ消す。結果は実行ログに出る */
function testTimeTree() {
  CacheService.getScriptCache().remove(TT_CACHE_KEY);
  const cals = ttCalendars_();
  Logger.log('ログインOK。カレンダー：' + cals.map(c => c.name).join(' / '));
  const cal = ttCalendar_();
  Logger.log('入れる先：' + cal.name);
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), TZ, 'yyyy-MM-dd');
  const r = ttCreateEvent_({ date: tomorrow, start: '09:00', end: '09:30', allDay: false, title: '工務TODO 接続テスト（自動で消えます）' });
  Logger.log('テスト予定を作りました（' + tomorrow + ' 9:00）id=' + r.id);
  if (r.id) {
    ttRequest_('delete', '/calendar/' + cal.id + '/event/' + r.id);
    Logger.log('テスト予定を消しました。準備OKです。LINE で「予定 明日 10時 テスト」と送ってみてください');
  }
}

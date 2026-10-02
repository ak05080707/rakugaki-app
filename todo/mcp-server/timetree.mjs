/**
 * TimeTree 読み取り（非公式）
 *
 * TimeTree の公式APIは2023年に終了しているため、Web版（timetreeapp.com）が使っている
 * 内部APIでログインして予定を読む。読み取り専用。仕様変更で動かなくなる可能性がある。
 * 参考: https://github.com/eoleedi/TimeTree-Exporter
 *
 * 環境変数: TIMETREE_EMAIL / TIMETREE_PASSWORD（TimeTree にメールアドレスでログインする情報）
 */
import crypto from 'node:crypto';
import rrulePkg from 'rrule';

const { RRule } = rrulePkg;
const BASE = process.env.TIMETREE_API_BASE || 'https://timetreeapp.com/api/v1';
const HEADERS = { 'Content-Type': 'application/json', 'X-Timetreea': 'web/2.1.0/en' };
const CACHE_MS = 5 * 60 * 1000;
const TZ = 'Asia/Tokyo';

let session = null;
const eventCache = new Map(); // calendarId -> { at, events }

export function timetreeConfigured() {
  return !!(process.env.TIMETREE_EMAIL && process.env.TIMETREE_PASSWORD);
}

async function login() {
  if (!timetreeConfigured()) {
    throw new Error('TimeTree のメールアドレスとパスワードが未設定です（手順ページの「F. TimeTree」を実行してください）');
  }
  const res = await fetch(`${BASE}/auth/email/signin`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({
      uid: process.env.TIMETREE_EMAIL,
      password: process.env.TIMETREE_PASSWORD,
      uuid: crypto.randomUUID().replace(/-/g, '')
    })
  });
  if (res.status !== 200) {
    let code;
    try { code = (await res.json())?.error?.code; } catch { /* 本文なし */ }
    if (code === -702) throw new Error('TimeTree: メールアドレスかパスワードが違います');
    if (code === -495) throw new Error('TimeTree: ログインの回数制限中です。しばらく待ってから試してください');
    throw new Error(`TimeTree: ログインに失敗しました（HTTP ${res.status}）`);
  }
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const m = cookies.join(';').match(/_session_id=([^;]+)/);
  if (!m) throw new Error('TimeTree: ログインはできましたがセッションが取得できませんでした');
  session = m[1];
}

async function api(pathAndQuery, retry = true) {
  if (!session) await login();
  const res = await fetch(BASE + pathAndQuery, { headers: { ...HEADERS, Cookie: `_session_id=${session}` } });
  if ((res.status === 401 || res.status === 403) && retry) {
    session = null;
    return api(pathAndQuery, false);
  }
  if (res.status !== 200) throw new Error(`TimeTree: 読み込みに失敗しました（HTTP ${res.status} ${pathAndQuery.split('?')[0]}）`);
  return res.json();
}

export async function listCalendars() {
  const data = await api('/calendars?since=0');
  return (data.calendars || [])
    .filter(c => c.deactivated_at == null)
    .map(c => ({ id: c.id, name: c.name }));
}

async function fetchEvents(calendarId) {
  const hit = eventCache.get(calendarId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.events;
  const events = [];
  let q = `/calendar/${calendarId}/events/sync`;
  for (let i = 0; i < 100; i++) {
    const data = await api(q);
    events.push(...(data.events || []));
    if (data.chunk !== true) break;
    q = `/calendar/${calendarId}/events/sync?since=${data.since}`;
  }
  eventCache.set(calendarId, { at: Date.now(), events });
  return events;
}

// ── 日時の扱い ──
// 予定は「その予定のタイムゾーンでの時刻をそのまま UTC とみなした値」（＝ずらした値）に直して計算する。
// 時刻付きの予定は日本時間で表示、終日の予定は予定のタイムゾーンでの日付で表示する。
// 終日の予定の end_at は「最終日」（その日を含む）。
const JST_MS = 9 * 3600 * 1000;
const pad = n => String(n).padStart(2, '0');
function tzOffset(tz, ms) {
  if (!tz || tz === 'UTC') return 0;
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const g = k => Number(p.find(x => x.type === k).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
  } catch { return JST_MS; }
}
function fmtShifted(shiftedMs, dateOnly) {
  const d = new Date(shiftedMs);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return dateOnly ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
const eventShift = ev => tzOffset(ev.start_timezone || (ev.all_day ? 'UTC' : TZ), Number(ev.start_at));

// iCal の日時（20261012 / 20261012T080000 / 20261012T230000Z）を「ずらした値」に直す
function icalToShifted(v, shift) {
  const m = String(v).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return { ms: m[7] ? ms + shift : ms, dateOnly: !m[4] };
}

/** RRULE の UNTIL を「ずらした値」の世界に合わせる（日付だけなら、その日の終わりまで含める） */
function fixUntil(rule, shift) {
  return rule.replace(/UNTIL=([0-9TZ]+)/, (_, v) => {
    const u = icalToShifted(v, shift);
    if (!u) return 'UNTIL=' + v;
    const ms = u.dateOnly ? u.ms + 86400000 - 1000 : u.ms;
    return 'UNTIL=' + new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  });
}

/** 1件の予定の開始時刻（ずらした値）を [fromS, toS) の範囲で列挙する。繰り返し予定は回数分 */
function occurrences(ev, fromS, toS) {
  const shift = eventShift(ev);
  const start = Number(ev.start_at) + shift;
  const dur = Math.max(0, Number(ev.end_at ?? ev.start_at) - Number(ev.start_at));
  const lastEnd = s => s + dur + (ev.all_day ? 86400000 : 0); // 終日は最終日の終わりまで
  const inRange = s => s < toS && lastEnd(s) > fromS;
  const lines = (ev.recurrences || []).filter(Boolean).map(r => String(r).trim());
  const ruleLine = lines.find(l => /^RRULE:/i.test(l));
  if (!ruleLine) return inRange(start) ? [start] : [];
  try {
    const opts = RRule.parseString(fixUntil(ruleLine.replace(/^RRULE:/i, ''), shift));
    const rule = new RRule({ ...opts, dtstart: new Date(start) });
    // 除外日（EXDATE）
    const ex = lines.filter(l => /^EXDATE/i.test(l))
      .flatMap(l => l.slice(l.indexOf(':') + 1).split(','))
      .map(v => icalToShifted(v, shift)).filter(Boolean);
    const isExcluded = s => ex.some(e => e.dateOnly
      ? Math.floor(s / 86400000) === Math.floor(e.ms / 86400000)
      : Math.abs(s - e.ms) < 60000);
    return rule.between(new Date(fromS - dur - 86400000), new Date(toS), true)
      .map(d => d.getTime()).filter(s => inRange(s) && !isExcluded(s));
  } catch {
    return inRange(start) ? [start] : [];
  }
}

/**
 * 予定を取得する
 * @param {object} o
 * @param {string} [o.from]  YYYY-MM-DD（既定：今日）
 * @param {number} [o.days]  何日分（既定7）
 * @param {string} [o.calendar] カレンダー名の一部（省略で全部）
 * @param {string} [o.query] タイトル・メモ・場所に含む文字
 */
export async function getEvents({ from, days = 7, calendar, query } = {}) {
  const today = fmtShifted(Date.now() + JST_MS, true);
  const fromDay = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : today;
  const fromS = Date.parse(fromDay + 'T00:00:00Z');                 // ずらした値での期間
  const toS = fromS + Math.max(1, Math.min(Number(days) || 7, 366)) * 86400000;

  let cals = await listCalendars();
  if (calendar) cals = cals.filter(c => c.name.includes(calendar));
  if (!cals.length) throw new Error('TimeTree: 該当するカレンダーがありません');
  const q = query ? query.toLowerCase() : null;

  const out = [];
  for (const cal of cals) {
    for (const ev of await fetchEvents(cal.id)) {
      if (ev.category === 2) continue; // メモ（日付なし）は除外
      if (q && ![ev.title, ev.note, ev.location].some(s => (s || '').toLowerCase().includes(q))) continue;
      const shift = eventShift(ev);
      const dur = Math.max(0, Number(ev.end_at ?? ev.start_at) - Number(ev.start_at));
      for (const s of occurrences(ev, fromS, toS)) {
        // 時刻付きは日本時間で表示し直す
        const show = ms => ev.all_day ? fmtShifted(ms, true) : fmtShifted(ms - shift + JST_MS, false);
        out.push({
          calendar: cal.name,
          title: ev.title || '(無題)',
          start: show(s),
          end: show(s + dur),
          allDay: !!ev.all_day,
          location: ev.location || '',
          note: (ev.note || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          repeat: (ev.recurrences || []).length > 0,
          id: ev.uuid
        });
      }
    }
  }
  return out.sort((x, y) => x.start.slice(0, 10).localeCompare(y.start.slice(0, 10)) || (y.allDay - x.allDay) || x.start.localeCompare(y.start));
}

// テスト用
export const _internal = { occurrences, tzOffset, fetchEvents, setSession: s => { session = s; } };

// 動作確認用：TimeTree の代わりにダミーAPIを立てて、MCP の timetree_* ツールを呼ぶ
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const JST = (y, mo, d, h, mi = 0) => U(y, mo, d, h, mi) - 9 * 3600e3;
const events = [
  { uuid: 'a', title: 'A邸 現場確認', start_at: JST(2026, 10, 5, 9), end_at: JST(2026, 10, 5, 10), start_timezone: 'Asia/Tokyo', all_day: false, category: 1, location: '名古屋市港区' },
  { uuid: 'b', title: '家族で外食', start_at: U(2026, 10, 6), end_at: U(2026, 10, 6), start_timezone: 'UTC', all_day: true, category: 1 },
  { uuid: 'c', title: '出張（東京）', start_at: U(2026, 10, 7), end_at: U(2026, 10, 8), start_timezone: 'UTC', all_day: true, category: 1 },
  { uuid: 'd', title: '朝礼', start_at: JST(2026, 9, 7, 8), end_at: JST(2026, 9, 7, 8, 30), start_timezone: 'Asia/Tokyo', all_day: false, category: 1,
    recurrences: ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE:20261011T230000Z'] },            // 10/12(月)は休み
  { uuid: 'e', title: '定例会議', start_at: JST(2026, 9, 1, 15), end_at: JST(2026, 9, 1, 16), start_timezone: 'Asia/Tokyo', all_day: false, category: 1,
    recurrences: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261008'] },                          // 10/8 まで
  { uuid: 'f', title: 'メモ', start_at: U(2026, 10, 5), end_at: U(2026, 10, 5), all_day: true, category: 2 },
  { uuid: 'g', title: '月末締め', start_at: U(2026, 9, 30), end_at: U(2026, 9, 30), start_timezone: 'UTC', all_day: true, category: 1,
    recurrences: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'] }
];
let logins = 0;
const srv = http.createServer((req, res) => {
  const send = (code, obj, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };
  if (req.method === 'PUT' && req.url === '/auth/email/signin') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const p = JSON.parse(b); logins++;
      if (p.password !== 'pw') return send(401, { error: { code: -702 } });
      send(200, {}, { 'Set-Cookie': '_session_id=S1; path=/; HttpOnly' });
    }); return;
  }
  if (!String(req.headers.cookie).includes('_session_id=S1')) return send(401, {});
  if (req.url === '/calendars?since=0') return send(200, { calendars: [{ id: 11, name: '仕事', deactivated_at: null }, { id: 12, name: '家族', deactivated_at: null }, { id: 13, name: '古い', deactivated_at: 1 }] });
  if (req.url === '/calendar/11/events/sync') return send(200, { events: events.filter(e => e.uuid !== 'b').slice(0, 3), chunk: true, since: 99 });
  if (req.url === '/calendar/11/events/sync?since=99') return send(200, { events: events.filter(e => e.uuid !== 'b').slice(3), chunk: false });
  if (req.url === '/calendar/12/events/sync') return send(200, { events: [events[1]], chunk: false });
  send(404, {});
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;

async function run(password) {
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['index.mjs'],
    env: { ...process.env, TIMETREE_API_BASE: base, TIMETREE_EMAIL: 'a@b', TIMETREE_PASSWORD: password } }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return (r.isError ? 'ERROR ' : '') + r.content[0].text; };
  console.log('# calendars', await call('timetree_calendars', {}));
  const evs = JSON.parse(await call('timetree_events', { from: '2026-10-05', days: 28 }));
  for (const e of evs) console.log(`${e.start.padEnd(16)} ~ ${e.end.padEnd(16)} [${e.calendar}] ${e.title}${e.repeat ? ' 🔁' : ''}`);
  console.log('# 家族 only:', JSON.parse(await call('timetree_events', { from: '2026-10-06', days: 1, calendar: '家族' })).map(e => e.title));
  console.log('# 10/8 query 出張:', JSON.parse(await call('timetree_events', { from: '2026-10-08', days: 1, query: '出張' })).map(e => e.title + ' ' + e.start + '~' + e.end));
  await client.close();
}
await run('pw');
const c2 = new Client({ name: 't', version: '1' });
await c2.connect(new StdioClientTransport({ command: 'node', args: ['index.mjs'], env: { ...process.env, TIMETREE_API_BASE: base, TIMETREE_EMAIL: 'a@b', TIMETREE_PASSWORD: 'bad' } }));
console.log('# wrong password:', (await c2.callTool({ name: 'timetree_calendars', arguments: {} })).content[0].text);
await c2.close();
console.log('logins:', logins); srv.close();

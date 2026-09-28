// 動作確認用：Apps Script の代わりにローカルのダミーAPIを立て、MCPクライアントから全ツールを呼んでみる
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const store = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const p = JSON.parse(b); let r;
    if (p.key !== 'k') r = { ok: false, error: 'unauthorized' };
    else if (p.action === 'add') { const o = { id: String(store.length + 1), done: false, ...p }; delete o.key; delete o.action; store.push(o); r = { ok: true, result: o }; }
    else if (p.action === 'addMany') r = { ok: true, result: p.items.map(i => { const o = { id: String(store.length + 1), done: false, ...i }; store.push(o); return o; }) };
    else if (p.action === 'list') r = { ok: true, result: store };
    else if (p.action === 'setDone') { const t = store.find(x => x.id === p.id); t.done = p.done; r = { ok: true, result: t }; }
    else r = { ok: true, result: { action: p.action } };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(r));
  });
}).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/exec`;

const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['index.mjs'], env: { ...process.env, TODO_API_URL: url, TODO_API_KEY: 'k' } }));
const tools = (await client.listTools()).tools.map(t => t.name);
console.log('tools:', tools.join(', '));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); console.log(`\n# ${name}${r.isError ? ' (error)' : ''}\n` + r.content[0].text.slice(0, 400)); return r; };
await call('todo_add', { title: 'A邸 見積提出', due: '2026-09-29', priority: '高' });
await call('todo_add_many', { items: [{ title: 'Outlook不要メール整理ルールを決める', source: 'Plaud', ref: 'plaud:x:1' }] });
await call('todo_complete', { id: '1' });
await call('todo_list', {});
await call('line_messages', { limit: 5 });
await call('outlook_recent_mails', { days: 1 });
await client.close(); srv.close();

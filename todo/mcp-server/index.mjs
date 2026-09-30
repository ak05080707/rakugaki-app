#!/usr/bin/env node
/**
 * 工務TODO MCPコネクター（自作）
 *
 * Claude Desktop（Windows PC）から次のことができるようになる：
 *   ・TODOの一覧／追加／完了／編集／削除（Google スプレッドシートに保存 → iPhone・iPad でも同じ内容）
 *   ・LINE から届いたメッセージの確認
 *   ・Outlook 2019 の受信メール・フラグ付きメール・予定表・タスクの読み取り
 *   ・不要メールを「削除済みアイテム」へ移動（元に戻せる）
 *
 * 環境変数
 *   TODO_API_URL … Apps Script ウェブアプリの URL（…/exec）
 *   TODO_API_KEY … 合言葉（setup() 実行時にログに出る API_KEY）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API_URL = process.env.TODO_API_URL;
const API_KEY = process.env.TODO_API_KEY;
const PS1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'outlook.ps1');

// ───────────── Apps Script API ─────────────

export async function gas(action, params = {}) {
  if (!API_URL || !API_KEY) throw new Error('TODO_API_URL / TODO_API_KEY が設定されていません（claude_desktop_config.json を確認）');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: API_KEY, action, ...params }),
    redirect: 'follow'
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Apps Script の応答が読めません（HTTP ${res.status}・URL・デプロイ設定を確認）: ` + text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300));
  }
  if (!data.ok) throw new Error(data.error || 'Apps Script エラー');
  return data.result;
}

// ───────────── Outlook（PowerShell + COM） ─────────────

export function outlook(args) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Outlook 連携は Windows（Outlook 2019 がインストールされたPC）でのみ動作します'));
  }
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1],
      { env: { ...process.env, OUTLOOK_ARGS: JSON.stringify(args) }, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        let data = null;
        try { data = JSON.parse(stdout.replace(/^﻿/, '') || 'null'); } catch { /* 下で扱う */ }
        if (data && data.error) return reject(new Error('Outlook: ' + data.error));
        if (err && !data) return reject(new Error('Outlook 呼び出し失敗: ' + (stderr || err.message)));
        resolve(data ?? []);
      });
  });
}

// ───────────── MCP ツール定義 ─────────────

const ok = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const safe = fn => async args => {
  try { return ok(await fn(args)); } catch (e) { return { content: [{ type: 'text', text: 'エラー: ' + e.message }], isError: true }; }
};

const SOURCES = ['手入力', 'LINE', 'Outlook', 'Plaud', 'Claude'];
const todoItem = {
  title: z.string().describe('やること（短く具体的に）'),
  due: z.string().optional().describe('期限 YYYY-MM-DD（なければ省略）'),
  memo: z.string().optional().describe('補足メモ（相手先・メール件名など）'),
  priority: z.enum(['高', '中', '低']).optional().describe('優先度（至急なら 高）'),
  source: z.enum(SOURCES).optional().describe('どこから来たタスクか'),
  ref: z.string().optional().describe('元データのID（Outlook の entryId、Plaud のファイルIDなど）。同じ ref は二重登録されない')
};

export function createServer() {
  const server = new McpServer({ name: 'komu-todo', version: '1.0.0' });

  // ── TODO ──
  server.registerTool('todo_list', {
    title: 'TODO一覧',
    description: '工務TODOの一覧を取得する。未完了＋直近7日の完了分。include_done=true で全件。',
    inputSchema: { include_done: z.boolean().optional() }
  }, safe(({ include_done }) => gas('list', { includeDone: !!include_done })));

  server.registerTool('todo_add', {
    title: 'TODO追加',
    description: 'TODOを1件追加する。iPhone・iPad・PC のTODO画面にすぐ反映される。',
    inputSchema: todoItem
  }, safe(item => gas('add', { source: 'Claude', ...item })));

  server.registerTool('todo_add_many', {
    title: 'TODOまとめて追加',
    description: 'TODOを複数件まとめて追加する。Plaud の議事録のアクションアイテムや、Outlook のフラグ付きメールを取り込むときに使う。ref を付けると二重登録を防げる。',
    inputSchema: { items: z.array(z.object(todoItem)).min(1) }
  }, safe(({ items }) => gas('addMany', { items: items.map(i => ({ source: 'Claude', ...i })) })));

  server.registerTool('todo_complete', {
    title: 'TODO完了',
    description: 'TODOを完了にする（done=false で未完了に戻す）。id は todo_list で確認。',
    inputSchema: { id: z.string(), done: z.boolean().optional() }
  }, safe(({ id, done }) => gas('setDone', { id, done: done !== false })));

  server.registerTool('todo_update', {
    title: 'TODO編集',
    description: 'TODOのタイトル・期限・メモ・優先度を変更する。',
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      due: z.string().optional().describe('YYYY-MM-DD。空文字で期限なし'),
      memo: z.string().optional(),
      priority: z.enum(['高', '中', '低']).optional()
    }
  }, safe(({ id, ...fields }) => gas('update', { id, fields })));

  server.registerTool('todo_delete', {
    title: 'TODO削除',
    description: 'TODOを削除する（元に戻せない。完了なら todo_complete を使う）。',
    inputSchema: { id: z.string() }
  }, safe(({ id }) => gas('delete', { id })));

  // ── LINE ──
  server.registerTool('line_messages', {
    title: 'LINEメッセージ確認',
    description: 'TODO用LINE公式アカウントに届いたメッセージの履歴（新しい順）。LINEから送った内容は自動でTODOにも登録済み。',
    inputSchema: { limit: z.number().int().min(1).max(200).optional() }
  }, safe(({ limit }) => gas('lineLog', { limit: limit || 30 })));

  // ── Outlook 2019 ──
  server.registerTool('outlook_recent_mails', {
    title: 'Outlook 受信メール',
    description: 'Outlook 2019 の受信トレイから直近のメールを新しい順に取得する。',
    inputSchema: {
      days: z.number().min(0.1).max(90).optional().describe('何日前まで（既定7）'),
      unread_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional().describe('最大件数（既定30）'),
      body_chars: z.number().int().min(0).max(5000).optional().describe('本文の抜粋文字数（既定300）')
    }
  }, safe(a => outlook({ action: 'recent', days: a.days, unreadOnly: a.unread_only, limit: a.limit, bodyChars: a.body_chars })));

  server.registerTool('outlook_flagged_mails', {
    title: 'Outlook フラグ付きメール',
    description: 'フラグ（要対応）が付いた受信メールを取得する。TODO取り込み向け。ref に entryId を使うと二重登録されない。',
    inputSchema: { days: z.number().min(1).max(365).optional().describe('何日前まで（既定60）'), limit: z.number().int().min(1).max(200).optional() }
  }, safe(a => outlook({ action: 'flagged', days: a.days || 60, limit: a.limit || 50 })));

  server.registerTool('outlook_search_mails', {
    title: 'Outlook メール検索',
    description: '件名・差出人・本文にキーワードを含むメールを検索する。',
    inputSchema: {
      query: z.string(),
      days: z.number().min(1).max(365).optional().describe('何日前まで（既定30）'),
      limit: z.number().int().min(1).max(200).optional(),
      body_chars: z.number().int().min(0).max(5000).optional()
    }
  }, safe(a => outlook({ action: 'search', query: a.query, days: a.days || 30, limit: a.limit, bodyChars: a.body_chars })));

  server.registerTool('outlook_calendar', {
    title: 'Outlook 予定表',
    description: 'Outlook 2019 の予定表から予定を取得する。',
    inputSchema: {
      offset_days: z.number().int().min(-30).max(365).optional().describe('何日後から（0=今日）'),
      days: z.number().int().min(1).max(60).optional().describe('何日分（既定7）')
    }
  }, safe(a => outlook({ action: 'calendar', offsetDays: a.offset_days || 0, days: a.days || 7, limit: 100 })));

  server.registerTool('outlook_tasks', {
    title: 'Outlook タスク',
    description: 'Outlook 2019 のタスク（未完了）を取得する。',
    inputSchema: { limit: z.number().int().min(1).max(200).optional() }
  }, safe(a => outlook({ action: 'tasks', limit: a.limit || 50 })));

  server.registerTool('outlook_flag_done', {
    title: 'Outlook フラグを完了に',
    description: 'メールのフラグを「完了」にする（TODOを完了にしたとき、元メールも片付ける用）。done=false でフラグを付け直す。',
    inputSchema: { entry_id: z.string(), done: z.boolean().optional() }
  }, safe(a => outlook({ action: 'setFlag', entryId: a.entry_id, done: a.done !== false })));

  server.registerTool('outlook_move_to_deleted', {
    title: 'Outlook メールを削除済みへ',
    description: '指定したメールを「削除済みアイテム」フォルダへ移動する（完全削除ではないので Outlook 上で戻せる）。必ず事前に対象メールの一覧をユーザーに見せて了承を得てから使うこと。',
    inputSchema: { entry_ids: z.array(z.string()).min(1).max(200) }
  }, safe(a => outlook({ action: 'moveToDeleted', entryIds: a.entry_ids })));

  return server;
}

// 直接起動されたときだけ stdio で待ち受け（テストから import した場合は起動しない）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

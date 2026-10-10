#!/usr/bin/env node
/**
 * Claude Desktop の設定（claude_desktop_config.json）に komu-todo を登録する。
 * 通常版（%APPDATA%\Claude）と Microsoft Store 版（%LOCALAPPDATA%\Packages\Claude_*）の両方に書く。
 *
 * 環境変数 TODO_API_URL / TODO_API_KEY / TIMETREE_EMAIL / TIMETREE_PASSWORD があればそれを使い、
 * なければ既存の設定（またはそのバックアップ）から komu-todo の値を引き継いで書き直す。
 * Windows PowerShell 5.1 の ConvertTo-Json で崩れた設定（args が {"value":[…]} になる等）の修復も兼ねる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const targets = [];
if (process.env.APPDATA) targets.push(path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'));
const pkgs = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Packages');
if (pkgs && fs.existsSync(pkgs)) {
  for (const d of fs.readdirSync(pkgs).filter(d => d.startsWith('Claude_'))) {
    targets.push(path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  }
}

function read(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) {
    console.log(`  ⚠ 読めない設定ファイル（壊れています）: ${file}\n    ${e.message}`);
    return undefined;
  }
}
const unwrap = v => Array.isArray(v) ? v : (v && Array.isArray(v.value) ? v.value : v == null ? [] : [v]);

// 既存の komu-todo の設定（環境変数）を拾う
let prevEnv = {};
for (const f of targets.flatMap(t => [t, t + '.bak2', t + '.bak'])) {
  const env = read(f)?.mcpServers?.['komu-todo']?.env;
  if (env?.TODO_API_URL && env?.TODO_API_KEY) { prevEnv = env; break; }
}
const url = process.env.TODO_API_URL || prevEnv.TODO_API_URL;
const key = process.env.TODO_API_KEY || prevEnv.TODO_API_KEY;
if (!url || !key) {
  console.log('NG: URL と合言葉が見つかりません。手順ページのインストール用コマンドを実行し直してください。');
  process.exit(1);
}
// 指定された値で上書き、それ以外（TimeTree のログイン情報など）は前の設定を引き継ぐ
const env = { ...prevEnv, TODO_API_URL: url, TODO_API_KEY: key };
for (const k of ['TIMETREE_EMAIL', 'TIMETREE_PASSWORD']) if (process.env[k]) env[k] = process.env[k];

const entry = {
  command: process.execPath,
  args: [path.join(here, 'index.mjs')],
  env
};

for (const file of targets) {
  let cfg = read(file);
  if (cfg === undefined) cfg = {};                 // 壊れている → 作り直す（元は .bak2 に残す）
  if (cfg === null) cfg = {};                      // ファイルなし
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak2');
  // PowerShell 5.1 で崩れた他のサーバー設定の args も直しておく
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  for (const s of Object.values(servers)) if (s && 'args' in s) s.args = unwrap(s.args);
  cfg.mcpServers = { ...servers, 'komu-todo': entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log(`  OK: ${file}`);
  console.log(`      登録済みのサーバー: ${Object.keys(cfg.mcpServers).join(', ')}`);
}
console.log(`  command: ${entry.command}\n  args:    ${entry.args[0]}\n  URL:     ${url}`);
console.log(`  TimeTree: ${env.TIMETREE_EMAIL ? env.TIMETREE_EMAIL + ' で設定済み' : '未設定'}`);

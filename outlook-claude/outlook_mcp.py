"""Outlookメール返信アシスタント（Claudeデスクトップアプリ版）

Claudeデスクトップアプリから呼び出すMCPサーバー。
アプリのチャットで「山田建設のメールを探して返信の下書きを作って」と頼むと、
Claudeがここの道具を使ってOutlookを操作する。
返信文はアプリのClaude自身が書くので、APIキー・API料金は不要（月額プランの範囲で動く）。
自動送信はしない。下書き保存まで。
"""

from mcp.server.mcpserver import MCPServer

from outlook_claude import (
    BODY_LIMIT,
    load_config,
    save_reply_draft as _save_reply_draft,
    search_mails as _search_mails,
)

cfg = load_config()

INSTRUCTIONS = f"""Outlook 2019（このPC）のメールを探して、返信の下書きを保存する道具です。

使い方の流れ：
1. search_mails でメールを探す（受信トレイと、仕分けルールのサブフォルダも対象）
2. read_mail で本文を読む
3. 返信文を作って、まずチャットに表示し、ユーザーの了承を得る
4. 了承が出たら save_reply_draft で下書きに保存する

返信文のルール：
- 書き手：{cfg['company']} {cfg['dept']} {cfg['title']} {cfg['name']}
- 丁寧なビジネス敬語で簡潔に。書き出しは「相手の会社名 名前 様」、続けて
  「いつもお世話になっております。{cfg['company']}の{cfg['name'].split()[0] if cfg['name'] else ''}です。」
- メールや指示に無い日付・金額・数量は作らない。必要なら【要確認：〜】と空けておく
- 署名は付けない（保存時に自動で付く）

このツールはメールを送信できません。「送信しました」とは絶対に言わず、
「下書きに保存しました。Outlookで確認して送信してください」と伝えてください。"""

server = MCPServer(name="outlook", instructions=INSTRUCTIONS)


def _outlook():
    # 呼び出しごとに別スレッドになることがあるので、毎回COMを初期化して接続する
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    return win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")


@server.tool()
def search_mails(keyword: str, days: int = 30, max_results: int = 20) -> list[dict]:
    """受信トレイ（サブフォルダ含む）から、差出人・件名・本文にキーワードを含むメールを新しい順に探す。

    keyword: 探す言葉（例：会社名、人の名前、現場名）
    days: 何日前まで探すか
    max_results: 最大件数
    """
    hits = _search_mails(_outlook(), keyword, days, max_results)
    return [
        {
            "entry_id": mail.EntryID,
            "received": f"{received:%Y/%m/%d %H:%M}",
            "sender": mail.SenderName,
            "sender_email": mail.SenderEmailAddress,
            "subject": mail.Subject,
            "folder": folder,
            "preview": (mail.Body or "")[:200],
        }
        for received, folder, mail in hits
    ]


@server.tool()
def read_mail(entry_id: str) -> dict:
    """search_mails で見つけたメール1通の本文を読む。entry_id は search_mails の結果の値。"""
    mail = _outlook().GetItemFromID(entry_id)
    body = mail.Body or ""
    return {
        "sender": mail.SenderName,
        "sender_email": mail.SenderEmailAddress,
        "to": mail.To,
        "cc": mail.CC,
        "received": f"{mail.ReceivedTime:%Y/%m/%d %H:%M}",
        "subject": mail.Subject,
        "body": body[:BODY_LIMIT],
        "truncated": len(body) > BODY_LIMIT,
    }


@server.tool()
def save_reply_draft(entry_id: str, body: str, reply_all: bool = False) -> str:
    """メールへの返信をOutlookの「下書き」に保存して、返信画面を開く。送信はしない。

    entry_id: 返信するメールの entry_id
    body: 返信本文（署名なし。署名は自動で付く）
    reply_all: CCの人にも返すなら true
    """
    mail = _outlook().GetItemFromID(entry_id)
    text = body.strip() + ("\n\n" + cfg["signature"] if cfg["signature"] else "")
    _save_reply_draft(mail, text, reply_all, cfg["display_after_save"])
    return "下書きに保存しました（送信はしていません）。Outlookで内容を確認して送信してください。"


if __name__ == "__main__":
    server.run()

"""Outlookメール返信アシスタント

Outlook 2019（Windows）を直接操作して、
  1. 受信トレイ（仕分けルールで振り分けたサブフォルダも含む）からメールを探す
  2. 選んだメールへの返信文をClaudeが作る
  3. Outlookの「下書き」に保存する（自動送信はしない）
ところまでを行う。
"""

import configparser
import datetime
import html
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.ini"

OL_FOLDER_INBOX = 6
OL_MAIL_ITEM = 43
OL_FORMAT_HTML = 2

# メール本文をClaudeに渡すときの上限文字数（長い引用履歴対策）
BODY_LIMIT = 20000


# ------------------------------------------------------------
# 設定
# ------------------------------------------------------------
def load_config():
    cfg = configparser.ConfigParser()
    cfg.read(CONFIG_PATH, encoding="utf-8")
    return {
        "days": cfg.getint("基本", "検索日数", fallback=30),
        "max_results": cfg.getint("基本", "最大表示件数", fallback=30),
        "reply_all": cfg.getboolean("基本", "全員に返信", fallback=False),
        "display_after_save": cfg.getboolean("基本", "保存後に表示", fallback=True),
        "model": cfg.get("Claude", "モデル", fallback="claude-opus-5"),
        "company": cfg.get("差出人", "会社名", fallback=""),
        "dept": cfg.get("差出人", "部署", fallback=""),
        "title": cfg.get("差出人", "役職", fallback=""),
        "name": cfg.get("差出人", "氏名", fallback=""),
        "signature": cfg.get("署名", "内容", fallback="").strip("\n"),
    }


# ------------------------------------------------------------
# Outlook 操作
# ------------------------------------------------------------
def connect_outlook():
    import win32com.client

    app = win32com.client.Dispatch("Outlook.Application")
    return app.GetNamespace("MAPI")


def walk_folders(folder):
    """フォルダとそのサブフォルダを順番に返す。"""
    yield folder
    for sub in folder.Folders:
        yield from walk_folders(sub)


def search_mails(ns, keyword, days, max_results):
    """受信トレイ配下から、キーワードに合うメールを新しい順に返す。"""
    cutoff = datetime.datetime.now() - datetime.timedelta(days=days)
    keyword = keyword.strip().lower()
    inbox = ns.GetDefaultFolder(OL_FOLDER_INBOX)

    hits = []
    for folder in walk_folders(inbox):
        items = folder.Items
        items.Sort("[ReceivedTime]", True)
        for item in items:
            if item.Class != OL_MAIL_ITEM:
                continue
            received = item.ReceivedTime
            received = datetime.datetime(
                received.year, received.month, received.day,
                received.hour, received.minute, received.second,
            )
            if received < cutoff:
                break  # 新しい順に並べているので、ここから先はすべて古い
            if keyword and not _matches(item, keyword):
                continue
            hits.append((received, folder.Name, item))

    hits.sort(key=lambda h: h[0], reverse=True)
    return hits[:max_results]


def _matches(item, keyword):
    fields = (item.Subject, item.SenderName, item.SenderEmailAddress, item.Body)
    return any(keyword in (f or "").lower() for f in fields)


def save_reply_draft(mail, text, reply_all, display):
    """返信の下書きを作って保存する。送信はしない。"""
    reply = mail.ReplyAll() if reply_all else mail.Reply()
    if reply.BodyFormat == OL_FORMAT_HTML:
        reply.HTMLBody = insert_into_html(reply.HTMLBody, text)
    else:
        reply.Body = text + "\n\n" + reply.Body
    reply.Save()
    if display:
        reply.Display()
    return reply


def insert_into_html(html_body, text):
    """HTMLメールの本文の先頭に返信文を差し込む。"""
    block = (
        '<div style="font-family:\'MS Pゴシック\',sans-serif;font-size:11pt">'
        + html.escape(text).replace("\n", "<br>\n")
        + "<br><br></div>"
    )
    match = re.search(r"<body[^>]*>", html_body, flags=re.IGNORECASE)
    if not match:
        return block + html_body
    return html_body[: match.end()] + block + html_body[match.end():]


# ------------------------------------------------------------
# Claude
# ------------------------------------------------------------
SYSTEM_PROMPT = """あなたは建設会社の工務部で働く人の、メール返信の下書き担当です。
渡された受信メールへの返信文を、日本語のビジネスメールとして作成してください。

- 書き手：{company} {dept} {title} {name}
- 丁寧なビジネス敬語で、簡潔に。現場・工事の用語はそのまま使ってよい。
- 書き出しは「{{相手の会社名}} {{相手の名前}} 様」の宛名から始め、「いつもお世話になっております。{company}の{short_name}です。」と続ける。
  相手の会社名・名前がメールから分からない場合は推測せず「〇〇様」とする。
- 日付・金額・数量など、メールや指示に無い事実は作らない。必要なら【要確認：〜】と書いて空けておく。
- 署名は付けない（あとで自動で付ける）。
- 出力は返信本文だけ。件名や前置き・解説は書かない。"""


def build_prompt(mail, instruction):
    body = mail.Body or ""
    truncated = len(body) > BODY_LIMIT
    if truncated:
        body = body[:BODY_LIMIT]
    received = mail.ReceivedTime
    prompt = (
        "【受信メール】\n"
        f"差出人：{mail.SenderName} <{mail.SenderEmailAddress}>\n"
        f"受信日時：{received:%Y/%m/%d %H:%M}\n"
        f"件名：{mail.Subject}\n"
        "本文：\n"
        f"{body}\n\n"
        "【返信の方針（書き手からの指示）】\n"
        f"{instruction or '内容に合わせて適切に返信してください。'}"
    )
    return prompt, truncated


def generate_reply(client, cfg, mail, instruction, previous=None, feedback=None):
    prompt, truncated = build_prompt(mail, instruction)
    if truncated:
        print(f"  ※本文が長いため、先頭{BODY_LIMIT}文字だけをClaudeに渡しました。")

    messages = [{"role": "user", "content": prompt}]
    if previous and feedback:
        messages += [
            {"role": "assistant", "content": previous},
            {"role": "user", "content": f"次の点を直して、返信本文を作り直してください：\n{feedback}"},
        ]

    system = SYSTEM_PROMPT.format(
        company=cfg["company"], dept=cfg["dept"], title=cfg["title"],
        name=cfg["name"], short_name=cfg["name"].split()[0] if cfg["name"] else "",
    )
    response = client.beta.messages.create(
        model=cfg["model"],
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},
        system=system,
        messages=messages,
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("Claudeがこのメールへの返信作成を断りました。内容を確認してください。")
    return "".join(b.text for b in response.content if b.type == "text").strip()


# ------------------------------------------------------------
# 画面（コンソール）
# ------------------------------------------------------------
def ask(prompt, default=""):
    value = input(prompt).strip()
    return value or default


def show_results(hits):
    print()
    for i, (received, folder, mail) in enumerate(hits, 1):
        subject = (mail.Subject or "(件名なし)")[:40]
        sender = (mail.SenderName or "")[:16]
        print(f" {i:>2}. {received:%m/%d %H:%M}  {sender:<16}  {subject}  [{folder}]")
    print()


def draft_loop(client, cfg, mail):
    print(f"\n■ 件名：{mail.Subject}\n■ 差出人：{mail.SenderName}\n")
    print("----- 本文（先頭） -----")
    print((mail.Body or "")[:800])
    print("------------------------\n")

    instruction = ask("返信の方針をひとこと（例：了承。来週火曜に現場確認に伺う）\n> ")
    text = generate_reply(client, cfg, mail, instruction)

    while True:
        full = text + ("\n\n" + cfg["signature"] if cfg["signature"] else "")
        print("\n========== 返信案 ==========")
        print(full)
        print("============================\n")
        choice = ask("[s] 下書きに保存  [r] 直してもらう  [q] やめる > ").lower()
        if choice == "s":
            save_reply_draft(mail, full, cfg["reply_all"], cfg["display_after_save"])
            print("→ Outlookの「下書き」に保存しました（送信はしていません）。")
            return
        if choice == "r":
            feedback = ask("どこを直す？（例：もう少し短く／日程は10/3に変更）\n> ")
            text = generate_reply(client, cfg, mail, instruction, previous=text, feedback=feedback)
        elif choice == "q":
            return


def main():
    if sys.platform != "win32":
        sys.exit("このツールはWindows（Outlookが入っているPC）で動かしてください。")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY が設定されていません。手順書の「APIキーの設定」を見てください。")

    import anthropic

    cfg = load_config()
    client = anthropic.Anthropic()
    ns = connect_outlook()

    print("=== Outlookメール返信アシスタント ===")
    print("（何も入力せずEnterで終了）\n")
    while True:
        keyword = ask("探すキーワード（差出人・件名・本文）> ")
        if not keyword:
            break
        days = ask(f"何日前まで？（Enterで{cfg['days']}日）> ", str(cfg["days"]))
        days = int(days) if days.isdigit() else cfg["days"]

        print("検索中…")
        hits = search_mails(ns, keyword, days, cfg["max_results"])
        if not hits:
            print("見つかりませんでした。\n")
            continue
        show_results(hits)

        pick = ask("返信するメールの番号（Enterで検索に戻る）> ")
        if not pick.isdigit() or not 1 <= int(pick) <= len(hits):
            continue
        try:
            draft_loop(client, cfg, hits[int(pick) - 1][2])
        except anthropic.AuthenticationError:
            print("APIキーが正しくありません。手順書の「APIキーの設定」を見直してください。")
        except anthropic.RateLimitError:
            print("Claudeが混み合っています。少し待ってからもう一度やってください。")
        except anthropic.APIConnectionError:
            print("Claudeにつながりませんでした。ネット接続を確認してください。")
        except anthropic.APIStatusError as e:
            print(f"Claude側でエラーが起きました（{e.status_code}）：{e.message}")
        except RuntimeError as e:
            print(e)
        print()


if __name__ == "__main__":
    main()

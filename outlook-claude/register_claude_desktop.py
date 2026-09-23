"""ClaudeデスクトップアプリにOutlookの道具（outlook_mcp.py）を登録する。"""

import json
import os
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent / "outlook_mcp.py"


def config_paths():
    """Claudeデスクトップアプリの設定ファイルの場所（通常版・ストア版）。"""
    paths = [Path(os.environ["APPDATA"]) / "Claude" / "claude_desktop_config.json"]
    packages = Path(os.environ["LOCALAPPDATA"]) / "Packages"
    if packages.exists():
        for pkg in packages.glob("Claude_*"):
            paths.append(pkg / "LocalCache" / "Roaming" / "Claude" / "claude_desktop_config.json")
    return [p for p in paths if p.parent.exists()]


def register(path):
    config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    config.setdefault("mcpServers", {})["outlook"] = {
        "command": sys.executable,
        "args": [str(SERVER)],
        "env": {"PYTHONUTF8": "1"},
    }
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    paths = config_paths()
    if not paths:
        sys.exit("Claudeデスクトップアプリが見つかりません。先にアプリを入れて、一度起動してください。")
    for path in paths:
        register(path)
        print(f"登録しました：{path}")
    print("\nClaudeデスクトップアプリを完全に終了して（タスクトレイのアイコンも「終了」）、起動し直してください。")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Read ONE message for the Agent Desk bridge without changing it (stdlib only, run with `python3 -I`).

usage: mail_read.py <account> <uid> [--folder INBOX]

Why not `mail_tool.py read`: that command prints at most 4000 characters and lists no attachments. This helper reuses
mail_tool's account loading (accounts.json + the password env var) but opens the folder with EXAMINE (read-only) and
fetches BODY.PEEK[], so the \\Seen flag can never be set. It never prints a password or a header it did not parse.
Output: one JSON object on stdout. Bodies: text/plain preferred, HTML turned into text, attachments listed by name only.
"""
import argparse, email, html, importlib.util, json, os, re, sys
from email.policy import default as _policy

MAX_BODY = 20000
HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.environ.get("MAIL_TOOL_PATH") or os.path.expanduser("~/.agents/skills/email-access/mail_tool.py")


def load_tool():
    spec = importlib.util.spec_from_file_location("mail_tool_ro", TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def html_to_text(s):
    s = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h[1-6])>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def part_text(part):
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        return payload.decode(part.get_content_charset() or "utf-8", "replace")


def split_message(msg):
    text, htm, attachments = "", "", []
    for part in msg.walk():
        if part.is_multipart():
            continue
        name = part.get_filename()
        disp = (part.get_content_disposition() or "").lower()
        if name or disp == "attachment":
            attachments.append(str(name or part.get_content_type()))
            continue
        ctype = part.get_content_type()
        if ctype == "text/plain" and not text:
            text = part_text(part)
        elif ctype == "text/html" and not htm:
            htm = part_text(part)
    return text, htm, attachments


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("account")
    ap.add_argument("uid")
    ap.add_argument("--folder", default="INBOX")
    args = ap.parse_args()
    if not re.fullmatch(r"\d{1,10}", args.uid):
        sys.exit("bad uid")
    tool = load_tool()
    a = tool.acct(args.account)
    M = tool.imap_conn(a)
    try:
        M.select(tool._folder(args.folder), readonly=True)  # EXAMINE: no flag change possible
        typ, data = M.uid("fetch", args.uid, "(BODY.PEEK[])")
        if typ != "OK" or not data or not isinstance(data[0], tuple):
            sys.exit("not found")
        msg = email.message_from_bytes(data[0][1], policy=_policy)
    finally:
        try:
            M.logout()
        except Exception:
            pass
    text, htm, attachments = split_message(msg)
    body = text.strip() or html_to_text(htm)
    out = {
        "from": tool.dh(str(msg.get("From") or "")),
        "to": tool.dh(str(msg.get("To") or "")),
        "date": str(msg.get("Date") or ""),
        "subject": tool.dh(str(msg.get("Subject") or "")),
        "body": body[:MAX_BODY],
        "truncated": len(body) > MAX_BODY,
        "attachments": attachments[:30],
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()

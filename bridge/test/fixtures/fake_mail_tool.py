# Synthetic stand-in for ~/.agents/skills/email-access/mail_tool.py (same function names and output formats). It logs the
# IMAP commands it is asked to run next to itself, so tests can prove that nothing but EXAMINE + BODY.PEEK happens.
import json, os, sys, email.message
HERE = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = json.load(open(os.path.join(HERE, "accounts.json")))
LOG = os.path.join(HERE, "imap.log")

def log(*a):
    with open(LOG, "a") as f:
        f.write(json.dumps(a) + "\n")

def acct(name):
    if name not in ACCOUNTS: sys.exit("unknown account")
    a = dict(ACCOUNTS[name]); a["_name"] = name
    a["_pw"] = os.environ.get(a["pass_env"], "")
    return a

def dh(s): return s or ""
def _folder(n): return '"%s"' % n if " " in n else n

class FakeIMAP:
    def select(self, folder, readonly=False): log("select", folder, readonly); return ("OK", [b"1"])
    def uid(self, cmd, *args): 
        log("uid", cmd, *[str(x) for x in args])
        m = email.message.EmailMessage()
        m["From"] = "Alice Example <alice@example.test>"; m["To"] = "me@example.test"; m["Subject"] = "Hello synthetic"; m["Date"] = "Mon, 01 Jan 2026 10:00:00 +0000"
        m.set_content("Plain body. Your verification code is 482913. Reset: https://example.test/reset?token=abc123def")
        m.add_alternative("<html><body><p>HTML body only</p></body></html>", subtype="html")
        m.add_attachment(b"%PDF", maintype="application", subtype="pdf", filename="invoice.pdf")
        return ("OK", [(b"1 (UID 7 BODY[] {1}", m.as_bytes()), b")"])
    def logout(self): log("logout")

def imap_conn(a):
    log("login", "pw-present" if a["_pw"] else "pw-missing", "token-leaked" if os.environ.get("BRIDGE_TOKEN") else "token-clean")
    return FakeIMAP()

def main():
    cmd = sys.argv[1]; log("cli", *sys.argv[1:])
    rows = [("7", "*", "Mon, 01 Jan 2026 10:00:00 +0000", "Alice Example <alice@example.test>", "Older subject"),
            ("9", "", "Tue, 02 Jan 2026 11:00:00 +0000", "Bob Example <bob@example.test>", "Newer subject, verification code 123456")]
    if cmd == "list":
        for uid, seen, date, frm, subj in rows:
            print(f'{uid:>7} {seen:1} {date[:25]:25} | {frm[:38]:38} | {subj[:60]}')
    elif cmd == "search":
        uid, seen, date, frm, subj = rows[0]
        print(f'{uid:>7} {date[:25]:25} | {frm[:38]:38} | Matching subject')
        print("# 1 match(es)")
    else:
        sys.exit("refused: " + cmd)

if __name__ == "__main__": main()

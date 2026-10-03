"""Local live dashboard for worker jobs: http://127.0.0.1:<port>/ (read-only)."""
import json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

JOBS = Path(__file__).resolve().parent.parent / "jobs"

PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Workers</title><style>
:root{--bg:#f6f7f9;--panel:#fff;--fg:#1d2330;--mute:#6b7385;--line:#e2e5ea;--run:#2f6fde;--ok:#1f8a4c;--bad:#c33b3b}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--panel:#1c1f25;--fg:#e4e7ec;--mute:#8d94a3;--line:#2b2f37;--run:#6e9cf0;--ok:#4cc27e;--bad:#ec6b6b}}
*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{display:grid;grid-template-columns:minmax(220px,320px) 1fr;height:100vh}
@media (max-width:760px){.wrap{grid-template-columns:1fr;height:auto}#log{height:70vh}}
aside{border-right:1px solid var(--line);overflow:auto;background:var(--panel)}
h1{font-size:15px;margin:0;padding:14px 16px;border-bottom:1px solid var(--line)}
.job{padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer}.job.sel{background:var(--bg)}
.job b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.job small{color:var(--mute);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{font-size:12px;font-weight:600}.running{color:var(--run)}.done{color:var(--ok)}.failed,.cancelled{color:var(--bad)}
main{display:flex;flex-direction:column;min-width:0}header{padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
#log{flex:1;margin:0;padding:12px 16px;overflow:auto;font:12.5px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
</style></head><body><div class="wrap"><aside><h1>AI Workers</h1><div id="jobs"></div></aside>
<main><header id="head">Select a job</header><pre id="log"></pre></main></div><script>
let sel=null,pos=0;const $=s=>document.querySelector(s);
const age=t=>{const s=Math.max(0,Math.round(Date.now()/1000-t));return s<90?s+'s':Math.round(s/60)+'m'};
async function jobs(){const r=await fetch('/api/jobs');const js=await r.json();
 if(!sel&&js.length)pick(js[0].id);
 $('#jobs').innerHTML=js.map(j=>`<div class="job ${j.id===sel?'sel':''}" data-id="${j.id}"><b>${esc(j.label||j.id)}</b>
 <span class="st ${j.state}">${j.state}</span> <small>${esc(j.worker)} &middot; ${age(j.started||j.created)} ago</small><small>${esc(j.last_event||'')}</small></div>`).join('');
 document.querySelectorAll('.job').forEach(e=>e.onclick=()=>pick(e.dataset.id));
 const cur=js.find(j=>j.id===sel);if(cur)$('#head').textContent=`${cur.label||cur.id} | ${cur.worker} | ${cur.state} | ${cur.cwd||''}`}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function pick(id){sel=id;pos=0;$('#log').textContent='';jobs()}
async function log(){if(!sel)return;const r=await fetch(`/api/log?id=${sel}&from=${pos}`);const d=await r.json();
 if(d.text){const el=$('#log'),stick=el.scrollTop+el.clientHeight>=el.scrollHeight-40;el.textContent+=d.text;pos=d.next;if(stick)el.scrollTop=el.scrollHeight}}
setInterval(jobs,3000);setInterval(log,1500);jobs();
</script></body></html>"""


def list_jobs(limit=60):
    out = []
    if not JOBS.exists():
        return out
    for d in sorted(JOBS.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        try:
            m = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        except Exception:
            continue
        out.append({k: m.get(k) for k in ("id", "label", "worker", "state", "reason", "cwd",
                                         "created", "started", "ended", "last_event")})
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, body, ctype="application/json"):
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path == "/":
            return self.send(PAGE, "text/html")
        if url.path == "/api/jobs":
            return self.send(json.dumps(list_jobs()))
        if url.path == "/api/log":
            job_id = (q.get("id") or [""])[0]
            if not job_id or "/" in job_id or "\\" in job_id or ".." in job_id:
                return self.send(json.dumps({"text": "", "next": 0}))
            path = JOBS / job_id / "transcript.md"
            start = int((q.get("from") or ["0"])[0] or 0)
            text, nxt = "", start
            if path.exists():
                with open(path, "rb") as f:
                    f.seek(start)
                    raw = f.read(400_000)
                # Only whole lines: never split a multi-byte character (Devanagari).
                cut = raw.rfind(b"\n") + 1
                raw = raw[:cut]
                nxt = start + len(raw)
                text = raw.decode("utf-8", errors="replace")
            return self.send(json.dumps({"text": text, "next": nxt}))
        self.send_response(404)
        self.end_headers()


def serve(port):
    """Starts the dashboard in a daemon thread; returns False if the port is taken."""
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        return False
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return True


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    if serve(port):
        print(f"dashboard on http://127.0.0.1:{port}/")
        while True:
            time.sleep(3600)

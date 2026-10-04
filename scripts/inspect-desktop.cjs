// Local release verification via an explicitly enabled Electron debugging port.
const fs = require('node:fs');
async function main() {
  const [port = '9337', output, expression] = process.argv.slice(2);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(p => p.type === 'page' && p.url.startsWith('file:'));
  if (!page) throw new Error('TEAMYRA local renderer not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  try {
    const result = await send('Runtime.evaluate', {
      expression: expression || `JSON.stringify({url:location.href,ready:document.readyState,bridge:typeof window.teamyra,body:document.body.innerText.slice(0,1800),background:getComputedStyle(document.body).backgroundColor,scripts:[...document.scripts].map(s=>s.src)})`,
      awaitPromise: true, returnByValue: true
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.exceptionDetails) throw new Error('Renderer evaluation failed');
    if (output) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
    }
  } finally { ws.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

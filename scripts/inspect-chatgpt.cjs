// Read-only diagnostics for the app's explicitly enabled localhost CDP endpoint.
const { ChatGPTAutomationAdapter } = require('../apps/desktop/src/chatgpt-automation-adapter');
async function inspect() {
  const targets = await (await fetch('http://127.0.0.1:9341/json/list')).json();
  for (const target of targets.filter(t => t.url.startsWith('https://chatgpt.com/'))) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let serial = 0;
    const pending = new Map();
    socket.onmessage = event => { const data = JSON.parse(event.data); const item = pending.get(data.id); if (item) { pending.delete(data.id); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result); } };
    const evaluate = source => new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve: result => resolve(result.result.value), reject });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: source, returnByValue: true, awaitPromise: true } }));
    });
    const adapter = new ChatGPTAutomationAdapter({ isDestroyed: () => false, executeJavaScript: evaluate });
    console.log(JSON.stringify({ url: target.url, snapshot: await adapter.assistantSnapshot(), dom: await evaluate(`(() => { let n = [...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')].at(-1); const ancestors = []; for(let i=0;n && i<7;i++,n=n.parentElement) ancestors.push({tag:n.tagName,attrs:[...n.attributes].map(a=>[a.name,a.value])}); return {ancestors, prompt: document.querySelector('#prompt-textarea')?.innerText.slice(0,300)}; })()`) }));
    socket.close();
  }
}
inspect().catch(error => { console.error(error); process.exitCode = 1; });

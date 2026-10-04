class MediaBrowserController {
  constructor(webContents) { this.webContents = webContents; }

  async attachDebugger() {
    const debuggerApi = this.webContents.debugger;
    let attachedHere = false;
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3');
      attachedHere = true;
    }
    return { debuggerApi, attachedHere };
  }

  async withDebugger(fn) {
    const { debuggerApi, attachedHere } = await this.attachDebugger();
    try { return await fn(debuggerApi); }
    finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  async evaluate(expression) {
    return this.withDebugger(async d => {
      const result = await d.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return result?.result?.value;
    });
  }

  async query(selector) {
    return this.withDebugger(async d => {
      const { root } = await d.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const found = await d.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      return found?.nodeId || 0;
    });
  }

  async setFiles(selector, files) {
    return this.withDebugger(async d => {
      const { root } = await d.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await d.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('Reference file input was not found');
      await d.sendCommand('DOM.setFileInputFiles', { nodeId, files });
      return { ok: true };
    });
  }

  async clickSelector(selector) {
    return this.withDebugger(async d => {
      const { root } = await d.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await d.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) return false;
      const { model } = await d.sendCommand('DOM.getBoxModel', { nodeId });
      const q = model?.content || model?.border;
      if (!q || q.length < 8) return false;
      const x = (q[0] + q[2] + q[4] + q[6]) / 4;
      const y = (q[1] + q[3] + q[5] + q[7]) / 4;
      await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await d.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return true;
    });
  }

  async insertText(selector, text) {
    return this.withDebugger(async d => {
      const { root } = await d.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await d.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('Prompt input was not found');
      await d.sendCommand('DOM.focus', { nodeId });
      await d.sendCommand('Input.insertText', { text: String(text || '') });
      return { ok: true };
    });
  }
}

module.exports = { MediaBrowserController };

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

  async withActivePage(fn) {
    return this.withDebugger(async d => {
      // Keep Chromium's page lifecycle active even when the embedded view is
      // hidden or the desktop window is occluded. No desktop focus is stolen.
      await d.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      try { return await fn(); }
      finally { await d.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }); }
    });
  }

  async evaluate(expression) {
    return this.withDebugger(async d => {
      const response = await d.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response?.exceptionDetails) {
        const details = response.exceptionDetails;
        const description = details.exception?.description || details.text || 'Runtime.evaluate failed';
        throw new Error(String(description).slice(0, 1600));
      }
      return response?.result?.value;
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

  async pressKeySelector(selector, key = 'Enter') {
    return this.withDebugger(async d => {
      const { root } = await d.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await d.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) return false;
      await d.sendCommand('DOM.focus', { nodeId });
      const isSpace = key === ' ';
      const code = isSpace ? 'Space' : key;
      const virtualKeyCode = isSpace ? 32 : ({ Enter: 13, Escape: 27, Backspace: 8 }[key] || 0);
      const args = {
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode
      };
      await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...args });
      await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...args });
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

  async clearText(selector) {
    return this.withDebugger(async d => {
      const { root } = await d.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await d.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('Prompt input was not found');
      await d.sendCommand('DOM.focus', { nodeId });
      // Native editing updates ProseMirror's document as well as the visible DOM.
      for (const type of ['keyDown', 'keyUp']) {
        await d.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      }
      for (const type of ['keyDown', 'keyUp']) {
        await d.sendCommand('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      }
    });
  }
}

module.exports = { MediaBrowserController };

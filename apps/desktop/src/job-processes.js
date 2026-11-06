const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

// Long-running programs a ChatGPT or Muse job starts and keeps running while
// it works: a dev server, the app itself, a test watcher, an interactive
// program. terminal.run waits for a command to finish, so before this a job
// could not start a server and then test against it.
//
// TEAMYRA Desktop owns the programs (it stays up while its jobs run). Every
// command first passes the core's safety check and audit
// (`chatgpt.process.authorize`), which also gives the working directory and
// an environment without secrets. A job sees only its own sessions, and they
// are stopped when the job ends or the desktop quits.

const MAX_SESSIONS_PER_JOB = 6;
const MAX_BUFFER_CHARS = 1000000;
const MAX_RETURN_CHARS = 20000;
const MAX_WAIT_SECONDS = 120;
const PROCESS_TOOLS = new Set(['process.start', 'process.read', 'process.write', 'process.stop', 'process.list']);

function clampSeconds(value, fallback) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return fallback;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, seconds));
}

function patternOf(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return new RegExp(String(value), 'i');
  } catch (error) {
    throw new Error('wait_for is not a valid regular expression: ' + error.message);
  }
}

function defaultKillTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
      resolve();
    }
  });
}

function shellCommand(command) {
  if (process.platform === 'win32') {
    // UTF-8 output and no progress bars, which only fill the log.
    const prefix = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ";
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prefix + command]];
  }
  return ['sh', ['-c', command]];
}

class JobProcesses {
  constructor({ spawnImpl = spawn, killTree = defaultKillTree } = {}) {
    this.spawnImpl = spawnImpl;
    this.killTree = killTree;
    this.sessions = new Map();
  }

  static handles(tool) {
    return PROCESS_TOOLS.has(String(tool || ''));
  }

  // `ctx.authorize(command, cwd)` resolves to { cwd, env } or throws.
  async call(jobDir, tool, args = {}, ctx = {}) {
    args = args && typeof args === 'object' ? args : {};
    if (tool === 'process.start') return this.start(jobDir, args, ctx);
    if (tool === 'process.list') return { sessions: this.list(jobDir) };
    const session = this.sessionFor(jobDir, args.session_id);
    if (tool === 'process.read') return this.read(session, args);
    if (tool === 'process.write') return this.write(session, args);
    if (tool === 'process.stop') return this.stop(session);
    throw new Error('unsupported process tool: ' + tool);
  }

  sessionFor(jobDir, id) {
    const session = this.sessions.get(String(id || ''));
    if (!session || session.jobDir !== jobDir) {
      throw new Error('no such process session for this job: ' + String(id || '') +
        ' (process.list shows them; sessions end with the job or a TEAMYRA Desktop restart)');
    }
    return session;
  }

  list(jobDir) {
    return [...this.sessions.values()].filter(session => session.jobDir === jobDir).map(session => ({
      session_id: session.id, name: session.name, command: session.command.slice(0, 300), cwd: session.cwd,
      pid: session.pid, running: !session.exited, exit_code: session.exitCode,
      started_at: session.startedAt / 1000, output_chars: session.total
    }));
  }

  async start(jobDir, args, ctx) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('process.start needs "command" (a PowerShell command line)');
    const running = this.list(jobDir).filter(item => item.running).length;
    if (running >= MAX_SESSIONS_PER_JOB) {
      throw new Error(`this job already runs ${running} programs; stop one with process.stop first`);
    }
    const pattern = patternOf(args.wait_for);
    const approved = await ctx.authorize(command, args.cwd || '.');
    const id = 'p' + crypto.randomBytes(4).toString('hex');
    const logDir = path.join(jobDir, 'processes');
    fs.mkdirSync(logDir, { recursive: true });
    const session = {
      id, jobDir, command, name: String(args.name || '').slice(0, 80) || command.slice(0, 60),
      cwd: approved.cwd, startedAt: Date.now(), buffer: '', base: 0, total: 0, cursor: 0,
      exited: false, exitCode: null, waiters: new Set(), logFile: path.join(logDir, id + '.log')
    };
    fs.writeFileSync(session.logFile, `$ ${command}\n(cwd ${approved.cwd})\n\n`, 'utf8');
    const [file, argv] = shellCommand(command);
    const child = this.spawnImpl(file, argv, {
      cwd: approved.cwd, env: approved.env || process.env, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'
    });
    session.child = child;
    session.pid = child.pid || null;
    const onData = chunk => this.append(session, String(chunk));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', error => this.append(session, `\n[TEAMYRA] could not start: ${error.message}\n`));
    child.on('exit', (code, signal) => {
      session.exited = true;
      session.exitCode = code ?? (signal ? -1 : null);
      this.append(session, `\n[TEAMYRA] exited with ${code ?? signal}\n`);
    });
    child.stdin?.on('error', () => {});
    this.sessions.set(id, session);
    const waited = await this.waitFor(session, 0, pattern, clampSeconds(args.wait_seconds, 15));
    return this.view(session, 0, waited);
  }

  append(session, text) {
    if (!text) return;
    session.buffer += text;
    session.total += text.length;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      const drop = session.buffer.length - MAX_BUFFER_CHARS;
      session.buffer = session.buffer.slice(drop);
      session.base += drop;
    }
    try { fs.appendFileSync(session.logFile, text, 'utf8'); } catch {}
    for (const wake of session.waiters) wake();
  }

  textFrom(session, offset) {
    const start = Math.max(offset, session.base);
    return { text: session.buffer.slice(start - session.base), lost: start - offset };
  }

  // Waits until the output since `offset` matches `pattern` (or, without a
  // pattern, for `seconds`), the program exits, or `seconds` pass.
  waitFor(session, offset, pattern, seconds) {
    const check = () => session.exited || (pattern && pattern.test(this.textFrom(session, offset).text));
    if (check() || seconds <= 0) return Promise.resolve({ matched: Boolean(pattern && pattern.test(this.textFrom(session, offset).text)) });
    return new Promise(resolve => {
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        session.waiters.delete(wake);
        resolve({ matched: Boolean(pattern && pattern.test(this.textFrom(session, offset).text)) });
      };
      const wake = () => { if (check()) done(); };
      session.waiters.add(wake);
      timer = setTimeout(done, seconds * 1000);
    });
  }

  view(session, offset, waited = {}) {
    const { text, lost } = this.textFrom(session, offset);
    let output = text;
    let clipped = lost > 0 ? `${lost} earlier characters are only in the log file` : null;
    if (output.length > MAX_RETURN_CHARS) {
      const cut = output.length - MAX_RETURN_CHARS;
      output = output.slice(cut);
      clipped = `showing the last ${MAX_RETURN_CHARS} of ${text.length} new characters; read from "offset" for the rest`;
    }
    session.cursor = session.total;
    return {
      session_id: session.id, pid: session.pid, running: !session.exited, exit_code: session.exitCode,
      ...(waited.matched !== undefined ? { matched: waited.matched } : {}),
      output, offset, next_offset: session.total, ...(clipped ? { clipped } : {}), log_file: session.logFile
    };
  }

  async read(session, args) {
    const offset = Number.isFinite(Number(args.offset)) ? Math.max(0, Number(args.offset)) : session.cursor;
    const pattern = patternOf(args.wait_for);
    // Without a pattern, wait only while nothing new has arrived.
    const seconds = clampSeconds(args.wait_seconds, 0);
    const waited = pattern
      ? await this.waitFor(session, offset, pattern, seconds)
      : session.total > offset ? {} : await this.waitFor(session, offset, /[\s\S]/, seconds);
    return this.view(session, offset, pattern ? waited : {});
  }

  async write(session, args) {
    if (session.exited) throw new Error('the program has exited (exit code ' + session.exitCode + ')');
    const input = String(args.input ?? '');
    const newline = args.enter === false ? '' : (process.platform === 'win32' ? '\r\n' : '\n');
    const offset = session.total;
    await new Promise((resolve, reject) => session.child.stdin.write(input + newline, error => error ? reject(error) : resolve()));
    const pattern = patternOf(args.wait_for);
    const waited = await this.waitFor(session, offset, pattern, clampSeconds(args.wait_seconds, 3));
    return this.view(session, offset, pattern ? waited : {});
  }

  async stop(session) {
    if (!session.exited) {
      await this.killTree(session.pid);
      await this.waitFor(session, session.total, null, 3);
    }
    const result = this.view(session, session.cursor);
    this.sessions.delete(session.id);
    return { ...result, stopped: true };
  }

  async stopJob(jobDir) {
    const own = [...this.sessions.values()].filter(session => session.jobDir === jobDir);
    await Promise.all(own.map(session => this.stop(session).catch(() => {})));
    return own.length;
  }

  async stopAll() {
    await Promise.all([...this.sessions.values()].map(session => this.stop(session).catch(() => {})));
  }
}

// One set for the whole desktop: every tab (lane) of every account shares it.
const jobProcesses = new JobProcesses();

module.exports = { JobProcesses, jobProcesses, PROCESS_TOOLS, MAX_SESSIONS_PER_JOB, MAX_RETURN_CHARS };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobProcesses } = require('../src/job-processes');
const { checkUrl } = require('../src/job-inspect');

// Programs a job starts keep running between tool calls; the job reads their
// output, types into them and stops them. Real PowerShell processes.
async function testProcessSessions(root) {
  const processes = new JobProcesses();
  const jobA = path.join(root, 'job-a');
  const jobB = path.join(root, 'job-b');
  fs.mkdirSync(jobA, { recursive: true });
  fs.mkdirSync(jobB, { recursive: true });
  const authorized = [];
  const ctx = { authorize: async (command, cwd) => { authorized.push({ command, cwd }); return { cwd: root, env: process.env }; } };

  // A "server" that prints a ready line, then keeps running.
  const server = await processes.call(jobA, 'process.start', {
    command: "Write-Output 'booting'; Start-Sleep -Milliseconds 300; Write-Output 'ready on http://localhost:4321'; Start-Sleep -Seconds 60",
    wait_for: 'ready on', wait_seconds: 30, name: 'fake server'
  }, ctx);
  assert.equal(authorized.length, 1, 'every start passes the core safety check');
  assert.equal(server.running, true);
  assert.equal(server.matched, true);
  assert.match(server.output, /booting[\s\S]*ready on http:\/\/localhost:4321/);
  assert.ok(fs.readFileSync(server.log_file, 'utf8').includes('ready on'), 'output is also kept in the job folder');

  // Nothing new yet: a short read returns no output and the program runs on.
  const quiet = await processes.call(jobA, 'process.read', { session_id: server.session_id, wait_seconds: 0.2 }, ctx);
  assert.equal(quiet.output, '');
  assert.equal(quiet.running, true);

  // Another job cannot see or touch it.
  await assert.rejects(processes.call(jobB, 'process.read', { session_id: server.session_id }, ctx), /no such process session/);
  assert.equal((await processes.call(jobB, 'process.list', {}, ctx)).sessions.length, 0);

  // An interactive program: type a line, read the answer.
  const prompt = await processes.call(jobA, 'process.start', {
    command: "Write-Output 'name?'; $line = [Console]::In.ReadLine(); Write-Output ('hello ' + $line)", wait_for: 'name\\?', wait_seconds: 30
  }, ctx);
  const answer = await processes.call(jobA, 'process.write', { session_id: prompt.session_id, input: 'Ojas', wait_for: 'hello Ojas', wait_seconds: 30 }, ctx);
  assert.equal(answer.matched, true);
  assert.match(answer.output, /hello Ojas/);
  const finished = await processes.call(jobA, 'process.read', { session_id: prompt.session_id, wait_for: 'exited', wait_seconds: 30 }, ctx);
  assert.equal(finished.running, false);
  assert.equal(finished.exit_code, 0);

  const listed = (await processes.call(jobA, 'process.list', {}, ctx)).sessions;
  assert.equal(listed.length, 2);

  // A refused command never starts.
  await assert.rejects(processes.call(jobA, 'process.start', { command: 'format C:' },
    { authorize: async () => { throw new Error('command is blocked by TEAMYRA safety policy'); } }), /blocked/);
  assert.equal((await processes.call(jobA, 'process.list', {}, ctx)).sessions.length, 2);

  // The job ends: its programs stop.
  assert.equal(await processes.stopJob(jobA), 2);
  assert.equal((await processes.call(jobA, 'process.list', {}, ctx)).sessions.length, 0);
}

function testPageUrlsStayOnThisPc() {
  const workspace = path.join(os.tmpdir(), 'teamyra-ws');
  assert.equal(checkUrl('http://localhost:5173/', workspace), 'http://localhost:5173/');
  assert.equal(checkUrl('http://127.0.0.1:8080/x', workspace), 'http://127.0.0.1:8080/x');
  assert.equal(checkUrl('http://app.localhost:3000/', workspace), 'http://app.localhost:3000/');
  assert.throws(() => checkUrl('https://example.com/', workspace), /only local pages/);
  assert.throws(() => checkUrl('http://localhost.evil.com/', workspace), /only local pages/);
  assert.throws(() => checkUrl('javascript:alert(1)', workspace), /http\(s\) and file/);
  const inside = 'file:///' + path.join(workspace, 'dist', 'index.html').replace(/\\/g, '/');
  assert.equal(checkUrl(inside, workspace), new URL(inside).href);
  assert.throws(() => checkUrl('file:///C:/Windows/win.ini', workspace), /inside the workspace/);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-job-tools-'));
  try {
    testPageUrlsStayOnThisPc();
    if (process.platform === 'win32') await testProcessSessions(root);
    console.log('job process and page-url tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});

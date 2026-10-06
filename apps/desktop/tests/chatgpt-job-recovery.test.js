const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatGPTWebProvider } = require('../src/chatgpt-web-provider');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-chatgpt-recovery-'));
  try {
    const provider = Object.create(ChatGPTWebProvider.prototype);
    provider.runtimeRoot = root;
    provider.activeProfileId = 'web';
    for (const [id, profile, state] of [['interrupted', 'web', 'running'], ['other', 'account2', 'running'], ['queued', 'web', 'waiting_for_desktop']]) {
      const dir = path.join(root, 'jobs', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ provider: 'chatgpt-web', profile_id: profile, state }));
    }
    provider.recoverInterruptedJobs();
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'jobs/interrupted/meta.json'))).reason, 'desktop_interrupted');
    assert.ok(fs.existsSync(path.join(root, 'jobs/interrupted/DONE')));
    assert.ok(!fs.existsSync(path.join(root, 'jobs/other/DONE')));
    assert.ok(!fs.existsSync(path.join(root, 'jobs/queued/DONE')));
    provider.recoverInterruptedJobs();
    assert.equal(fs.readFileSync(path.join(root, 'jobs/interrupted/events.jsonl'), 'utf8').trim().split('\n').length, 1);

    let scans = 0;
    let release;
    provider.processPendingJobsOnce = async () => { scans += 1; await new Promise(resolve => { release = resolve; }); };
    const a = provider.processPendingJobs();
    const b = provider.processPendingJobs();
    assert.equal(scans, 1, 'overlapping timer ticks must share a single queue scan');
    release();
    await Promise.all([a, b]);
    assert.equal(provider.pendingJobsPromise, null);
    console.log('chatgpt interruption recovery and queue concurrency tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

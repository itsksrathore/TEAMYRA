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
    for (const [id, profile, state] of [['interrupted', 'web', 'running'], ['resumable', 'web', 'running'],
      ['cancelled', 'web', 'running'], ['other', 'account2', 'running'], ['queued', 'web', 'waiting_for_desktop']]) {
      const dir = path.join(root, 'jobs', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ provider: 'chatgpt-web', profile_id: profile, state }));
    }
    // Tools already ran in an unknown conversation: cannot be resumed safely.
    fs.writeFileSync(path.join(root, 'jobs/interrupted/chatgpt-state.json'), JSON.stringify({ phase: 'tool', successful_tools: 2 }));
    fs.writeFileSync(path.join(root, 'jobs/resumable/chatgpt-state.json'),
      JSON.stringify({ phase: 'awaiting', message: 'm', conversation_url: 'https://chatgpt.com/c/x', conversation_id: 'x' }));
    fs.writeFileSync(path.join(root, 'jobs/cancelled/CANCEL'), 'cancel');
    provider.recoverInterruptedJobs();
    const read = id => JSON.parse(fs.readFileSync(path.join(root, 'jobs', id, 'meta.json')));
    const interrupted = read('interrupted');
    assert.equal(interrupted.reason, 'desktop_interrupted');
    assert.equal(interrupted.exit_code, 1);
    assert.ok(fs.existsSync(path.join(root, 'jobs/interrupted/DONE')));
    assert.equal(read('cancelled').reason, 'desktop_interrupted', 'a cancelled job is not resumed');
    const resumable = read('resumable');
    assert.equal(resumable.state, 'waiting_for_desktop');
    assert.equal(resumable.resume_requested, true);
    assert.equal(resumable.desktop_resumes, 1);
    assert.ok(!fs.existsSync(path.join(root, 'jobs/resumable/DONE')));
    assert.ok(!fs.existsSync(path.join(root, 'jobs/other/DONE')));
    assert.ok(!fs.existsSync(path.join(root, 'jobs/queued/DONE')));
    provider.recoverInterruptedJobs();
    assert.equal(fs.readFileSync(path.join(root, 'jobs/interrupted/events.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.equal(read('resumable').desktop_resumes, 1, 'a waiting resumed job is not counted again');

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

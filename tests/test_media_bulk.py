import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import media_engine
import server


class MediaBulkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()

    def request(self, prompt='mountain sunrise', kind='video', **extra):
        return {'type': kind, 'prompt': prompt, 'project_path': str(self.project), **extra}

    def jobs_on_disk(self):
        return list((self.root / 'media' / 'jobs').glob('media-*.json'))

    def test_batch_shares_id_and_parallel_limit(self):
        result = media_engine.create_batch(self.root, [self.request('a'), self.request('b', max_parallel=4)], max_parallel=12)
        self.assertTrue(result['batch_id'].startswith('batch-'))
        self.assertEqual(result['count'], 2)
        stored = media_engine.batch_status(self.root, result['batch_id'])['jobs']
        self.assertEqual({job['batch_id'] for job in stored}, {result['batch_id']})
        self.assertEqual([job['max_parallel'] for job in result['jobs']], [12, 4])
        self.assertEqual(result['jobs'][0]['prompt_preview'], 'a')
        self.assertNotIn('recovery_plan', result['jobs'][0], 'creation rows stay compact for agents')
        self.assertEqual(result['generation_settings']['download_quality'], '1080p')

    def test_invalid_entry_queues_nothing(self):
        with self.assertRaisesRegex(ValueError, r'requests\[1\]'):
            media_engine.create_batch(self.root, [self.request('ok'), self.request('')])
        self.assertEqual(self.jobs_on_disk(), [])

    def test_parallel_limit_is_bounded(self):
        job = media_engine.create_job(self.root, self.request(max_parallel=500))
        self.assertEqual(job['max_parallel'], media_engine.MAX_PARALLEL)
        with self.assertRaises(ValueError):
            media_engine.create_batch(self.root, [self.request()] * (media_engine.MAX_BATCH + 1))

    def test_batch_status_and_cancel(self):
        batch = media_engine.create_batch(self.root, [self.request(str(i)) for i in range(3)])
        first = batch['jobs'][0]['job_id']
        media_engine.update_job_state(self.root, first, 'cancelled')
        status = media_engine.job_status(self.root, batch_id=batch['batch_id'])
        self.assertEqual(status['total'], 3)
        self.assertEqual(status['counts'], {'cancelled': 1, 'queued': 2})
        self.assertFalse(status['done'])
        cancelled = media_engine.cancel_batch(self.root, batch['batch_id'])
        self.assertEqual(cancelled['count'], 2)
        self.assertTrue(media_engine.batch_status(self.root, batch['batch_id'])['done'])
        with self.assertRaises(ValueError):
            media_engine.batch_status(self.root, 'batch-20260101-000000-missing0')

    def test_concurrent_reservations_never_collide(self):
        batch = media_engine.create_batch(self.root, [self.request('same prompt')] * 4)
        paths = [media_engine.prepare_output(self.root, job['job_id'])['path'] for job in batch['jobs']]
        self.assertEqual(len(set(paths)), 4, 'copies of one prompt get distinct files before any exist')
        indices = sorted(int(Path(item).name.split('_')[0]) for item in paths)
        self.assertEqual(indices, [1, 2, 3, 4])
        again = media_engine.prepare_output(self.root, batch['jobs'][0]['job_id'])['path']
        self.assertEqual(again, paths[0], 'a job keeps its own reservation')

    def claimed(self):
        job = media_engine.create_job(self.root, self.request())
        media_engine.claim_next_job(self.root, 'visual', 'test')
        return job['job_id']

    def test_release_requeues_before_submission(self):
        job_id = self.claimed()
        media_engine.append_job_metadata(self.root, job_id, {'submission_phase': 'preparing'})
        media_engine.update_job_state(self.root, job_id, 'submitting')
        released = media_engine.release_job(self.root, job_id, delay=20, reason='Flow busy')
        self.assertEqual(released['status'], 'queued')
        job = media_engine.load_job(self.root, job_id)
        self.assertEqual(job['attempt'], 0, 'backpressure does not consume an attempt')
        self.assertGreater(job['retry_after'], time.time() + 10)
        self.assertEqual(job['recovery']['backpressure_releases'], 1)
        self.assertFalse(media_engine._possible_submission(job), 'release history never reads as a submission')
        self.assertIsNone(media_engine.claim_next_job(self.root, 'visual', 'test'), 'waits for its retry time')

    def test_release_refuses_possible_submission_and_budget(self):
        job_id = self.claimed()
        media_engine.append_job_metadata(self.root, job_id, {
            'submission_phase': 'may_have_submitted',
            'provider_submission': {'submitted_at': 1.0, 'provider_url': 'https://flow.google.com/project/p'}})
        with self.assertRaisesRegex(ValueError, 'submitted'):
            media_engine.release_job(self.root, job_id)
        other = self.claimed()
        media_engine.append_job_metadata(self.root, other, {'recovery': {'backpressure_releases': media_engine.MAX_BACKPRESSURE_RELEASES}})
        with self.assertRaisesRegex(ValueError, 'budget'):
            media_engine.release_job(self.root, other)

    def test_wrong_shape_output_is_not_auto_recovered(self):
        job_id = self.claimed()
        media_engine.update_job_state(self.root, job_id, 'failed',
                                      'output_mismatch: download_failure: output aspect ratio does not match request',
                                      extra={'failure': {'category': 'output_mismatch'},
                                             'provider_submission': {'submitted_at': 1.0, 'provider_url': 'https://flow.google.com/project/p'}})
        plan = media_engine.recovery_plan(media_engine.load_job(self.root, job_id))
        self.assertEqual(plan['action'], 'revise_request')
        self.assertFalse(plan['can_recover'])
        self.assertFalse(media_engine.recover_job(self.root, job_id, automatic=True)['recovered'])

    def test_no_result_is_not_auto_retried(self):
        job_id = self.claimed()
        media_engine.update_job_state(self.root, job_id, 'failed', 'provider_no_result: no result after 400s',
                                      extra={'failure': {'category': 'provider_no_result'},
                                             'provider_submission': {'submitted_at': 1.0, 'provider_url': 'https://flow.google.com/project/p'}})
        plan = media_engine.recovery_plan(media_engine.load_job(self.root, job_id))
        self.assertEqual(plan['action'], 'revise_request')
        self.assertFalse(plan['automatic'], 'silent moderation is not retried automatically')
        self.assertFalse(media_engine.recover_job(self.root, job_id, automatic=True)['recovered'])
        self.assertTrue(media_engine.recover_job(self.root, job_id)['recovered'], 'a caller may still wait on it explicitly')

    def test_folder_keeps_its_flow_project(self):
        def submitted(url, at):
            job = media_engine.create_job(self.root, self.request())
            media_engine.append_job_metadata(self.root, job['job_id'], {
                'provider_submission': {'submitted_at': at, 'provider_url': url + '/edit/x'}})
        main = 'https://flow.google.com/project/aaaa-main'
        submitted(main, 1.0)
        submitted(main, 2.0)
        submitted('https://flow.google.com/project/bbbb-stray', 3.0)
        result = media_engine.flow_project_for(self.root, str(self.project))
        self.assertEqual(result['provider_url'], main, 'the project with most of the folder results wins')
        self.assertEqual(result['jobs'], 2)
        self.assertIsNone(media_engine.flow_project_for(self.root, str(self.root))['provider_url'])

    def edit(self, job_id, **fields):
        job = media_engine.load_job(self.root, job_id)
        job.update(fields)
        media_engine._save_job(self.root, job)

    def test_lanes_share_a_batch_limit(self):
        batch = media_engine.create_batch(self.root, [self.request(str(i)) for i in range(4)], max_parallel=2)
        first = media_engine.claim_next_job(self.root, 'visual', 'tab1', lane=0, lanes=3)
        second = media_engine.claim_next_job(self.root, 'visual', 'tab2', lane=1, lanes=3)
        self.assertEqual({first['batch_id'], second['batch_id']}, {batch['batch_id']})
        self.assertIsNone(media_engine.claim_next_job(self.root, 'visual', 'tab3', lane=2, lanes=3),
                          'max_parallel counts running jobs across every tab')
        media_engine.update_job_state(self.root, first['job_id'], 'completed')
        self.assertIsNotNone(media_engine.claim_next_job(self.root, 'visual', 'tab3', lane=2, lanes=3))

    def test_extra_tabs_take_batch_work_only(self):
        media_engine.create_job(self.root, self.request('single'))
        self.assertIsNone(media_engine.claim_next_job(self.root, 'visual', 'tab2', lane=1, lanes=3),
                          'a single job stays in the main tab and project')
        self.assertIsNotNone(media_engine.claim_next_job(self.root, 'visual', 'tab1', lane=0, lanes=3))

    def test_submitted_job_resumes_in_its_own_tab(self):
        batch = media_engine.create_batch(self.root, [self.request('a')])
        job_id = batch['jobs'][0]['job_id']
        self.edit(job_id, state='waiting_for_browser', reconcile_required=True,
                  provider_submission={'submitted_at': 1.0, 'lane': 2, 'provider_url': 'https://flow.google.com/project/lane3'})
        self.assertIsNone(media_engine.claim_next_job(self.root, 'visual', 'tab1', lane=0, lanes=3))
        self.assertEqual(media_engine.claim_next_job(self.root, 'visual', 'tab3', lane=2, lanes=3)['job_id'], job_id)

    def test_submitted_job_of_a_removed_tab_resumes_anywhere(self):
        batch = media_engine.create_batch(self.root, [self.request('a')])
        job_id = batch['jobs'][0]['job_id']
        self.edit(job_id, state='waiting_for_browser', reconcile_required=True,
                  provider_submission={'submitted_at': 1.0, 'lane': 2, 'provider_url': 'https://flow.google.com/project/lane3'})
        self.assertEqual(media_engine.claim_next_job(self.root, 'visual', 'tab1', lane=0, lanes=1)['job_id'], job_id)

    def test_tab_prefers_jobs_with_its_attached_references(self):
        batch = media_engine.create_batch(self.root, [self.request(str(i)) for i in range(3)])
        ids = [job['job_id'] for job in batch['jobs']]
        refs = [[{'asset_id': 'TYR-IMG-1'}], [{'asset_id': 'TYR-IMG-2'}], [{'asset_id': 'TYR-IMG-1'}]]
        for job_id, items in zip(ids, refs):
            self.edit(job_id, resolved_references=items)
        first = media_engine.claim_next_job(self.root, 'visual', 'tab1')
        self.assertEqual(first['job_id'], ids[0])
        self.assertEqual(first['refs_key'], 'TYR-IMG-1')
        second = media_engine.claim_next_job(self.root, 'visual', 'tab1', refs_key=first['refs_key'])
        self.assertEqual(second['job_id'], ids[2], 'same images skip a slow re-attach')
        self.assertEqual(media_engine.claim_next_job(self.root, 'visual', 'tab1', refs_key='TYR-IMG-1')['job_id'], ids[1])

    def test_each_tab_keeps_its_own_flow_project(self):
        def submitted(url, lane):
            job = media_engine.create_job(self.root, self.request())
            submission = {'submitted_at': 1.0, 'provider_url': url}
            if lane is not None:
                submission['lane'] = lane
            media_engine.append_job_metadata(self.root, job['job_id'], {'provider_submission': submission})
        submitted('https://flow.google.com/project/main', None)
        submitted('https://flow.google.com/project/tab2', 1)
        self.assertEqual(media_engine.flow_project_for(self.root, str(self.project))['provider_url'],
                         'https://flow.google.com/project/main', 'tab projects never become the main one')
        self.assertEqual(media_engine.flow_project_for(self.root, str(self.project), lane=1)['provider_url'],
                         'https://flow.google.com/project/tab2')
        self.assertIsNone(media_engine.flow_project_for(self.root, str(self.project), lane=2)['provider_url'])

    # --- several Google accounts ------------------------------------------------

    def submit(self, job_id, profile=None, lane=0, url="https://flow.google.com/project/p", state="waiting_for_browser"):
        submission = {"submitted_at": 1.0, "lane": lane, "provider_url": url}
        if profile:
            submission["profile_id"] = profile
        self.edit(job_id, state=state, reconcile_required=True, provider_submission=submission)

    def test_each_account_keeps_its_own_flow_project(self):
        first, second = (job["job_id"] for job in media_engine.create_batch(self.root, [self.request("a"), self.request("b")])["jobs"])
        self.submit(first, None, 0, "https://flow.google.com/project/main-google", state="completed")
        self.submit(second, "acct2", 0, "https://flow.google.com/project/main-acct2", state="completed")
        folder = str(self.project)
        self.assertEqual(media_engine.flow_project_for(self.root, folder)["provider_url"],
                         "https://flow.google.com/project/main-google", "jobs from before accounts are the built-in account's")
        self.assertEqual(media_engine.flow_project_for(self.root, folder, 0, "acct2")["provider_url"],
                         "https://flow.google.com/project/main-acct2")
        self.assertIsNone(media_engine.flow_project_for(self.root, folder, 0, "acct3")["provider_url"],
                          "an account never opens another account's project (it would 404)")
        self.assertIsNone(media_engine.flow_project_for(self.root, folder, 1, "acct2")["provider_url"])

    def test_a_project_two_tabs_shared_belongs_to_the_lowest_tab(self):
        jobs = [job["job_id"] for job in media_engine.create_batch(self.root, [self.request(str(i)) for i in range(3)])["jobs"]]
        shared = "https://flow.google.com/project/shared"
        self.submit(jobs[0], "acct4", 0, shared, state="failed")
        self.submit(jobs[1], "acct4", 2, shared, state="failed")
        self.submit(jobs[2], "acct4", 1, "https://flow.google.com/project/tab2", state="completed")
        folder = str(self.project)
        self.assertEqual(media_engine.flow_project_for(self.root, folder, 0, "acct4")["provider_url"], shared)
        third = media_engine.flow_project_for(self.root, folder, 2, "acct4")
        self.assertIsNone(third["provider_url"], "tab 3 gets a project of its own")
        self.assertIn(shared, third["taken"], "and is told not to reuse the shared one")
        self.assertEqual(media_engine.flow_project_for(self.root, folder, 1, "acct4")["provider_url"],
                         "https://flow.google.com/project/tab2")

    def test_submitted_job_resumes_only_in_its_own_account_and_tab(self):
        old, new = (job["job_id"] for job in media_engine.create_batch(self.root, [self.request("a"), self.request("b")])["jobs"])
        self.submit(old, None, 1)
        self.submit(new, "acct2", 1)
        claim = lambda profile, lane, lanes=3: media_engine.claim_next_job(
            self.root, "visual", f"{profile}-{lane}", lane=lane, lanes=lanes, profile_id=profile)
        self.assertIsNone(claim("acct2", 0))
        self.assertIsNone(claim("acct3", 1), "the same tab number in another account cannot see the result")
        self.assertEqual(claim("google", 1)["job_id"], old)
        self.assertEqual(claim("acct2", 1)["job_id"], new)

    def test_submitted_job_of_a_removed_tab_stays_in_its_account(self):
        job_id = media_engine.create_batch(self.root, [self.request("a")])["jobs"][0]["job_id"]
        self.submit(job_id, "acct2", 2)
        self.assertIsNone(media_engine.claim_next_job(self.root, "visual", "g", lane=0, lanes=1, profile_id="google"))
        self.assertEqual(media_engine.claim_next_job(self.root, "visual", "a", lane=0, lanes=1, profile_id="acct2")["job_id"], job_id)

    def test_batch_limit_applies_per_account(self):
        media_engine.create_batch(self.root, [self.request(str(i)) for i in range(4)], max_parallel=1)
        claim = lambda profile, lane=0: media_engine.claim_next_job(
            self.root, "visual", f"{profile}-{lane}", lane=lane, lanes=3, profile_id=profile)
        first = claim("google")
        self.assertIsNotNone(first)
        self.assertIsNone(claim("google", 1), "one account stays within max_parallel")
        second, third = claim("acct2"), claim("acct3")
        self.assertIsNotNone(second, "another account has its own allowance")
        self.assertIsNotNone(third)
        self.assertEqual(len({first["job_id"], second["job_id"], third["job_id"]}), 3)

    def test_single_jobs_go_to_the_main_account_and_edits_to_their_source(self):
        media_engine.create_job(self.root, self.request("single"))
        self.assertIsNone(media_engine.claim_next_job(self.root, "visual", "a", profile_id="acct2", main=False))
        self.assertIsNotNone(media_engine.claim_next_job(self.root, "visual", "a", profile_id="acct2", main=True),
                             "when the built-in account is down another becomes main")
        edit = media_engine.create_job(self.root, self.request("edit"), operation="video_extend",
                                       source_asset={"asset_id": "TYR-VID-000001", "metadata": {"google_profile_id": "acct3"}})
        self.assertEqual(edit and media_engine.load_job(self.root, edit["job_id"])["source_profile_id"], "acct3")
        self.assertIsNone(media_engine.claim_next_job(self.root, "visual", "g", profile_id="google", main=True))
        self.assertIsNone(media_engine.claim_next_job(self.root, "visual", "c", lane=1, lanes=3, profile_id="acct3"))
        self.assertEqual(media_engine.claim_next_job(self.root, "visual", "c", profile_id="acct3")["job_id"], edit["job_id"])

    def test_handoff_moves_unsubmitted_work_to_another_account(self):
        media_engine.create_batch(self.root, [self.request("a")])
        job = media_engine.claim_next_job(self.root, "visual", "acct2-0", profile_id="acct2")
        self.assertEqual(media_engine.public_job(media_engine.load_job(self.root, job["job_id"]))["handled_by"], "acct2 tab 1")
        handed = media_engine.handoff_job(self.root, job["job_id"], "signed out")
        self.assertEqual(handed["status"], "queued")
        self.assertIn("Waiting for a Google account", handed["detail"], "status says why it waits, not 'Submitting'")
        self.assertIsNone(handed["handled_by"])
        stored = media_engine.load_job(self.root, job["job_id"])
        self.assertEqual(stored["attempt"], 0, "a hand-off spends no retry budget")
        self.assertNotIn("backpressure_releases", stored.get("recovery") or {})
        again = media_engine.claim_next_job(self.root, "visual", "google-1", lane=1, lanes=3, profile_id="google")
        self.assertEqual(again["job_id"], job["job_id"])
        self.edit(job["job_id"], submission_phase="may_have_submitted")
        with self.assertRaises(ValueError):
            media_engine.handoff_job(self.root, job["job_id"])

    def test_status_shows_the_account_and_tab_of_each_job(self):
        job_id = media_engine.create_batch(self.root, [self.request("a")])["jobs"][0]["job_id"]
        self.submit(job_id, "acct2", 2, state="generating")
        row = media_engine.job_status(self.root, job_id, compact=True)
        self.assertEqual((row["profile_id"], row["lane"], row["handled_by"]), ("acct2", 2, "acct2 tab 3"))
        batch = media_engine.batch_status(self.root, row["batch_id"])
        self.assertEqual(batch["jobs"][0]["handled_by"], "acct2 tab 3")

    def test_restart_keeps_each_submission_with_its_account(self):
        first, second = (job["job_id"] for job in media_engine.create_batch(self.root, [self.request("a"), self.request("b")])["jobs"])
        self.submit(first, "acct2", 1, state="generating")
        self.edit(second, state="submitting", claimed_profile="acct3", claimed_lane=0)
        report = media_engine.recover_incomplete_jobs(self.root)
        self.assertEqual(report["reconcile_required"], [first])
        self.assertEqual(report["requeued"], [second])
        other = media_engine.claim_next_job(self.root, "visual", "g", lane=1, lanes=3, profile_id="google")
        self.assertEqual(other["job_id"], second, "the same tab of another account takes only the unsubmitted job")
        resumed = media_engine.claim_next_job(self.root, "visual", "a", lane=1, lanes=3, profile_id="acct2")
        self.assertEqual(resumed["job_id"], first, "a submitted job resumes before new work, in its own account")

    def test_claim_sees_changes_made_after_the_index_was_built(self):
        first, second = (job["job_id"] for job in media_engine.create_batch(self.root, [self.request("a"), self.request("b")])["jobs"])
        media_engine._job_summaries(self.root)
        self.assertTrue((self.root / "media" / ".job-index.json").exists())
        media_engine.cancel_job(self.root, first)
        claimed = media_engine.claim_next_job(self.root, "visual", "g")
        self.assertEqual(claimed["job_id"], second, "a job cancelled after indexing is not claimed")
        self.assertIsNone(media_engine.claim_next_job(self.root, "visual", "g"))
        (self.root / "media" / ".job-index.json").write_text("not json", encoding="utf-8")
        self.assertEqual(len(media_engine._job_summaries(self.root)), 2, "a broken index is rebuilt")

    def test_resume_only_claims_finish_submitted_work_only(self):
        fresh, sent = (job["job_id"] for job in media_engine.create_batch(self.root, [self.request("a"), self.request("b")])["jobs"])
        self.assertIsNone(media_engine.claim_next_job(self.root, "visual", "a", profile_id="acct2", resume_only=True),
                          "a disabled or out-of-credits account takes no new work")
        self.submit(sent, "acct2", 0)
        self.assertEqual(media_engine.claim_next_job(self.root, "visual", "a", profile_id="acct2", resume_only=True)["job_id"], sent,
                         "but still downloads what it submitted")
        self.assertEqual(media_engine.load_job(self.root, fresh)["state"], "queued")

    def test_orphaned_claim_returns_to_the_queue(self):
        job_id = media_engine.create_batch(self.root, [self.request("a")])["jobs"][0]["job_id"]
        claimed = media_engine.claim_next_job(self.root, "visual", "lost-worker", profile_id="acct2")
        self.assertEqual(claimed["job_id"], job_id)
        self.assertIsNone(media_engine.claim_next_job(self.root, "visual", "g"), "a fresh claim is left alone")
        self.edit(job_id, claimed_at=time.time() - media_engine.ORPHANED_CLAIM_SECONDS - 5)
        again = media_engine.claim_next_job(self.root, "visual", "g")
        self.assertEqual(again["job_id"], job_id, "nobody picked the claim up, so another tab may")
        self.assertIn("never picked up", " ".join(str(e.get("detail")) for e in again["history"]))
        self.assertEqual(again["claimed_profile"], "google")
        # A possible submission is never reclaimed this way.
        self.edit(job_id, state="preparing", claimed_at=1.0, submission_phase="may_have_submitted",
                  reconcile_required=True)
        self.assertIsNone(media_engine.claim_next_job(self.root, "visual", "g"))

    def test_connection_is_kept_per_account(self):
        media_engine.write_connection_status(self.root, {"connected": True, "flow_ready": True}, "google")
        media_engine.write_connection_status(self.root, {"connected": False, "needs_user_auth": True}, "acct2")
        status = media_engine.connection_status(self.root)
        self.assertTrue(status["connected"], "one signed-out account does not disconnect Flow")
        self.assertFalse(status["profiles"]["acct2"]["connected"])
        media_engine.write_connection_status(self.root, {"connected": True, "challenged": True}, "google")
        self.assertFalse(media_engine.connection_status(self.root)["connected"])

    def test_restart_recovery_leaves_a_live_workers_jobs_alone(self):
        job_id = self.claimed()
        media_engine.append_job_metadata(self.root, job_id, {'submission_phase': 'preparing'})
        media_engine.update_job_state(self.root, job_id, 'submitting')
        report = media_engine.recover_incomplete_jobs(self.root, worker_alive=True)
        self.assertTrue(report['skipped_live_worker'])
        self.assertEqual(media_engine.load_job(self.root, job_id)['state'], 'submitting',
                         'a core restart must not requeue a job the running desktop is submitting')
        media_engine.recover_incomplete_jobs(self.root)
        self.assertEqual(media_engine.load_job(self.root, job_id)['state'], 'queued', "a dead worker's job is requeued")
        import recovery
        with patch('desktop_runtime.desktop_ready', return_value=True),                 patch.object(media_engine, 'recover_incomplete_jobs', wraps=media_engine.recover_incomplete_jobs) as spy:
            recovery.recover_all(self.root, Path(media_engine.__file__).parent, sys.executable)
        self.assertTrue(spy.call_args.kwargs['worker_alive'])

    def test_status_many(self):
        job = media_engine.create_job(self.root, self.request())
        media_engine.cancel_job(self.root, job['job_id'])
        result = media_engine.status_many(self.root, [job['job_id'], 'media-missing-0000'])
        self.assertTrue(result['jobs'][job['job_id']]['cancel_requested'])
        self.assertTrue(result['jobs']['media-missing-0000']['missing'])

    def test_mcp_batch_status_and_cancel(self):
        with patch.object(server, 'ROOT', self.root), patch.object(server, 'desktop_control', return_value={'waking': True}):
            batch = server.tool_call('media_batch', {'requests': [self.request('x'), self.request('y', kind='image')], 'max_parallel': 6})
            self.assertEqual([job['max_parallel'] for job in batch['jobs']], [6, 6])
            status = server.tool_call('media_status', {'batch_id': batch['batch_id']})
            self.assertEqual(status['total'], 2)
            cancelled = server.tool_call('media_cancel', {'batch_id': batch['batch_id']})
            self.assertEqual(cancelled['count'], 2)
            with self.assertRaises(ValueError):
                server.tool_call('media_cancel', {})
        tools = {tool['name']: tool for tool in server.mcp_tools(include_legacy=False)}
        self.assertIn('max_parallel', tools['teamyra.media_batch']['inputSchema']['properties'])
        self.assertIn('batch_id', tools['teamyra.media_status']['inputSchema']['properties'])


if __name__ == '__main__':
    unittest.main()

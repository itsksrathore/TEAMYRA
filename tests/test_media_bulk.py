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

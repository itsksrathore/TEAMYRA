import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import media_engine
import server


class MediaRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()

    def failed_job(self, error='selector_failure: intent: selector_failure: settings panel unavailable', **metadata):
        job = media_engine.create_job(self.root, {
            'type': 'video', 'prompt': 'test scene', 'project_path': str(self.project),
        })
        media_engine.update_job_state(self.root, job['job_id'], 'submitting', extra=metadata)
        media_engine.update_job_state(self.root, job['job_id'], 'failed', error)
        return job['job_id']

    def test_legacy_settings_failure_is_recoverable_without_new_job(self):
        job_id = self.failed_job()
        status = media_engine.job_status(self.root, job_id)
        self.assertEqual(status['recovery_plan']['action'], 'retry_before_submission')
        result = media_engine.recover_job(self.root, job_id)
        self.assertTrue(result['recovered'])
        self.assertEqual(media_engine.claim_next_job(self.root, 'visual', 'google')['job_id'], job_id)

    def test_pre_click_checkpoint_allows_retry_but_unknown_submission_does_not(self):
        safe = self.failed_job('selector_failure: missing control', submission_phase='preparing')
        uncertain = self.failed_job('selector_failure: acknowledgement missing')
        self.assertTrue(media_engine.recover_job(self.root, safe)['recovered'])
        plan = media_engine.recover_job(self.root, uncertain)
        self.assertFalse(plan['recovered'])
        self.assertEqual(plan['recovery_plan']['action'], 'manual_reconciliation')

    def test_acknowledgement_checkpoint_dominates_pre_click_marker(self):
        job_id = self.failed_job('selector_failure: acknowledgement missing', submission_phase='preparing',
                                 reconcile_required=True)
        self.assertFalse(media_engine.recover_job(self.root, job_id)['recovered'])

    def test_submitted_job_preserves_identity_and_download(self):
        submission = {'submitted_at': 123, 'provider_url': 'https://flow.google.com/project/one',
                      'baseline_result_keys': ['old'], 'result_key': 'new', 'acknowledgement_pending': True}
        download = {'path': 'source.mp4', 'completed': True, 'bytes': 123}
        job_id = self.failed_job('download_failure: interrupted', provider_submission=submission, download=download)
        self.assertTrue(media_engine.recover_job(self.root, job_id)['recovered'])
        job = media_engine.claim_next_job(self.root, 'visual', 'google')
        self.assertEqual(job['job_id'], job_id)
        self.assertTrue(job['reconcile_required'])
        self.assertEqual(job['provider_submission'], submission)
        self.assertEqual(job['download'], download)
        self.assertEqual(job['recovery']['action'], 'resume_existing_submission')

    def test_automatic_budget_survives_restart_and_honours_backoff(self):
        job_id = self.failed_job(submission_phase='preparing')
        for attempt in (1, 2):
            result = media_engine.recover_job(self.root, job_id, automatic=True)
            self.assertTrue(result['recovered'])
            self.assertEqual(result['recovery']['auto_attempts'], attempt)
            self.assertIsNone(media_engine.claim_next_job(self.root, 'visual', 'google'))
            with patch.object(media_engine.time, 'time', return_value=result['retry_after'] + 1):
                self.assertEqual(media_engine.claim_next_job(self.root, 'visual', 'google')['job_id'], job_id)
            media_engine.update_job_state(self.root, job_id, 'failed', 'selector_failure: intent: selector_failure: settings')
        result = media_engine.recover_job(self.root, job_id, automatic=True)
        self.assertFalse(result['recovered'])
        self.assertFalse(result['recovery_plan']['automatic'])
        self.assertTrue(media_engine.recover_job(self.root, job_id)['recovered'], 'AI can explicitly recover after a repair')

    def test_permanent_auth_cancel_and_active_jobs_are_not_retried(self):
        for category in ('policy_refusal', 'credits_exhausted', 'human_verification', 'login_required'):
            with self.subTest(category=category):
                job_id = self.failed_job(category, submission_phase='preparing')
                self.assertFalse(media_engine.recover_job(self.root, job_id, automatic=True)['recovered'])
        job_id = self.failed_job()
        media_engine.recover_job(self.root, job_id)
        self.assertFalse(media_engine.recover_job(self.root, job_id)['recovered'], 'queued recovery is idempotent')
        media_engine.claim_next_job(self.root, 'visual', 'google')
        self.assertFalse(media_engine.recover_job(self.root, job_id)['recovered'], 'active ownership cannot be stolen')
        media_engine.cancel_job(self.root, job_id)
        self.assertFalse(media_engine.recover_job(self.root, job_id)['recovered'])

    def test_rate_limit_has_bounded_recovery_and_delay(self):
        job_id = self.failed_job('rate_limited', submission_phase='preparing')
        with patch.object(media_engine.time, 'time', return_value=100):
            result = media_engine.recover_job(self.root, job_id, automatic=True)
            self.assertGreaterEqual(result['retry_after'], 160)
            self.assertIsNone(media_engine.claim_next_job(self.root, 'visual', 'google'))

    def test_restart_and_auth_resume_honour_pre_click_checkpoint(self):
        job_id = self.failed_job(submission_phase='preparing')
        media_engine.recover_job(self.root, job_id)
        media_engine.update_job_state(self.root, job_id, 'submitting')
        report = media_engine.recover_incomplete_jobs(self.root)
        self.assertIn(job_id, report['requeued'])
        media_engine.update_job_state(self.root, job_id, 'needs_user_auth', 'login_required')
        self.assertIn(job_id, media_engine.resume_auth_jobs(self.root)['resumed'])

    def test_mcp_recovery_wakes_only_when_requeued(self):
        tools = {tool['name']: tool for tool in server.mcp_tools(include_legacy=False)}
        self.assertIn('teamyra.media_recover', tools)
        job_id = self.failed_job()
        with patch.object(server, 'ROOT', self.root), patch.object(server, 'wake_media_surface') as wake:
            self.assertTrue(server.tool_call('media_recover', {'job_id': job_id})['recovered'])
            wake.assert_called_once_with('visual')
            wake.reset_mock()
            self.assertFalse(server.tool_call('media_recover', {'job_id': job_id})['recovered'])
            wake.assert_not_called()


if __name__ == '__main__':
    unittest.main()

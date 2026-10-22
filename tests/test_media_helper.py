import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import media_engine
import media_support
import server
import teamyra_cli


class MediaHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()

    def job(self, prompt='babur in his tent', state='failed', category='policy_refusal'):
        job = media_engine.create_job(self.root, {'type': 'video', 'prompt': prompt, 'project_path': str(self.project)})
        if state == 'failed':
            media_engine.update_job_state(self.root, job['job_id'], 'failed', category + ': Flow refused',
                                          extra={'failure': {'category': category}})
        return job['job_id']

    def asset(self, prompt='babur reworded'):
        job_id = self.job(prompt, state='queued')
        planned = media_engine.prepare_output(self.root, job_id)
        Path(planned['path']).write_bytes(b'video')
        return media_engine.register_asset(self.root, job_id, planned['path'])

    def test_failures_are_logged_for_maintenance_once_per_job(self):
        job_id = self.job()
        media_engine.update_job_state(self.root, job_id, 'failed', 'policy_refusal: again',
                                      extra={'failure': {'category': 'policy_refusal'}})
        issues = media_support.list_issues(self.root)
        self.assertEqual(issues['total'], 1)
        self.assertEqual(issues['issues'][0]['occurrences'], 2)
        self.assertEqual(issues['by_category']['policy_refusal']['open'], 1)
        updated = media_support.update_issue(self.root, issues['issues'][0]['issue_id'], status='fixed', note='done')
        self.assertEqual(updated['maintenance']['status'], 'fixed')

    def test_report_hands_jobs_to_helper_and_delivery_completes_them(self):
        job_id = self.job()
        ticket = media_support.create_ticket(self.root, kind='issue', reporter='Maharana teaser agent',
                                             description='S10 refused by policy', job_ids=[job_id],
                                             instructions='keep the English line')
        job = media_engine.load_job(self.root, job_id)
        self.assertEqual(job['state'], 'assisted')
        plan = media_engine.recovery_plan(job)
        self.assertEqual(plan['action'], 'wait_for_helper', 'the reporter is told not to retry')
        self.assertFalse(media_engine.recover_job(self.root, job_id)['recovered'])
        self.assertEqual(media_support.list_issues(self.root, source='agent_report')['total'], 1)

        # A late failure of the original job keeps it with the helper.
        media_engine.update_job_state(self.root, job_id, 'failed', 'generation_failure: late')
        self.assertEqual(media_engine.load_job(self.root, job_id)['state'], 'assisted')

        asset = self.asset()
        media_support.deliver(self.root, ticket['ticket_id'], asset['asset_id'], original_job_id=job_id,
                              note='reworded prompt')
        done = media_engine.job_status(self.root, job_id)
        self.assertEqual(done['status'], 'completed')
        self.assertEqual(done['asset']['asset_id'], asset['asset_id'], 'the waiting agent receives the asset in its own job')
        self.assertEqual(done['fulfilled_by']['ticket_id'], ticket['ticket_id'])
        status = media_support.ticket_status(self.root, ticket['ticket_id'])
        self.assertEqual(status['status'], 'delivered')
        self.assertEqual(status['deliveries'][0]['local_path'], asset['local_path'])

    def test_failed_ticket_returns_jobs_to_their_reporter(self):
        job_id = self.job()
        ticket = media_support.create_ticket(self.root, kind='issue', reporter='a', description='x', job_ids=[job_id])
        media_support.update_ticket(self.root, ticket['ticket_id'], status='failed', summary='Flow keeps refusing')
        job = media_engine.load_job(self.root, job_id)
        self.assertEqual(job['state'], 'failed')
        self.assertIsNone(job['assisted_by'])
        self.assertIn('Flow keeps refusing', job['error'])

    def test_delivery_rules(self):
        job_id = self.job()
        ticket = media_support.create_ticket(self.root, kind='issue', reporter='a', description='x', job_ids=[job_id])
        other = self.job('other', state='queued')
        asset = self.asset()
        with self.assertRaisesRegex(ValueError, 'not part of this ticket'):
            media_support.deliver(self.root, ticket['ticket_id'], asset['asset_id'], original_job_id=other)
        with self.assertRaises(ValueError):
            media_support.create_ticket(self.root, kind='issue', reporter='a', description='x', project_path=str(self.project))
        with self.assertRaisesRegex(ValueError, 'requests or instructions'):
            media_support.create_ticket(self.root, kind='delegate', reporter='a', description='x', project_path=str(self.project))
        delegated = media_support.create_ticket(self.root, kind='delegate', reporter='a', description='teaser shots',
                                                project_path=str(self.project),
                                                requests=[{'type': 'video', 'prompt': 'shot 1'}])
        media_support.deliver(self.root, delegated['ticket_id'], asset['asset_id'], item=0)
        self.assertEqual(media_support.ticket_status(self.root, delegated['ticket_id'])['status'], 'working')

    def test_helper_prompt_carries_workflow_and_shell_fallback(self):
        job_id = self.job()
        ticket = media_support.create_ticket(self.root, kind='issue', reporter='a', description='stuck',
                                             job_ids=[job_id], instructions='keep dialogue word for word')
        text = media_support.helper_task(ticket)
        for needle in ('media_ticket_deliver', 'original_job_id', 'teamyra_cli.py', 'keep dialogue word for word',
                       job_id, 'Never edit TEAMYRA source code'):
            self.assertIn(needle, text)

    def test_helper_order_prefers_codex_then_antigravity_and_claude_last(self):
        registry = {
            'codex1': {'provider': 'codex'}, 'codex2': {'provider': 'codex'},
            'antigravity': {'provider': 'antigravity'}, 'claude1': {'provider': 'claude'},
            'chatgpt-normal': {'provider': 'chatgpt-web'},
        }
        order = ['codex1', 'codex2', 'antigravity', 'claude1']
        busy = {'codex1', 'codex2', 'antigravity'}
        with patch.object(server, 'worker_registry', return_value=registry), \
                patch.object(server, 'worker_auth_status', return_value=(True, 'ok')), \
                patch.object(server, 'running_jobs', side_effect=lambda w: ['x'] if w in busy else []), \
                patch.object(server, 'cooldown_left', return_value=0):
            self.assertEqual(server.helper_worker_order(), order)
            self.assertEqual(server.pick_worker('auto', order=order, last_resort=['claude1']), 'codex1',
                             'a busy Codex is preferred to an idle Claude')
        with patch.object(server, 'worker_registry', return_value=registry), \
                patch.object(server, 'worker_auth_status', side_effect=lambda info: (info['provider'] == 'claude', '')), \
                patch.object(server, 'running_jobs', return_value=[]), \
                patch.object(server, 'cooldown_left', side_effect=lambda w: 300 if w.startswith('codex') else 0):
            self.assertEqual(server.pick_worker('auto', order=order, last_resort=['claude1']), 'claude1',
                             'Claude only when Codex is rate-limited and Antigravity is unavailable')

    def test_codex_helper_gets_teamyra_mcp_in_any_profile(self):
        with patch.object(server, 'codex_launch', return_value=['codex']):
            cmd = server.codex_cmd('task', self.root, True, self.root / 'final.txt', settings={},
                                   extra_config=['mcp_servers.teamyra.url="http://127.0.0.1:8787/mcp"'])
        self.assertIn('mcp_servers.teamyra.url="http://127.0.0.1:8787/mcp"', cmd)
        with patch.object(server, 'codex_launch', return_value=['codex']):
            helper = server.codex_cmd('task', self.root, True, self.root / 'final.txt', settings={}, skip_git_check=True)
            resume = server.codex_cmd('task', self.root, True, self.root / 'final.txt', session_id='s', settings={},
                                      skip_git_check=True)
            normal = server.codex_cmd('task', self.root, True, self.root / 'final.txt', settings={})
        self.assertIn('--skip-git-repo-check', helper, 'media project folders are not Git repositories')
        self.assertIn('--skip-git-repo-check', resume)
        self.assertNotIn('--skip-git-repo-check', normal)

    def test_report_tool_dispatches_helper_with_order(self):
        job_id = self.job()
        started = {}

        def fake_start(worker, task, project_path, **kwargs):
            started.update(worker=worker, task=task, project_path=project_path, **kwargs)
            return 'job-helper-1', 'codex1'

        with patch.object(server, 'ROOT', self.root), patch.object(server, 'start_job', side_effect=fake_start), \
                patch.object(server, 'helper_worker_order', return_value=['codex1', 'codex2', 'antigravity', 'claude1']):
            result = server.tool_call('media_report_issue', {'description': 'S10 refused', 'job_ids': [job_id],
                                                             'reporter': 'teaser agent'})
            self.assertEqual(result['helper']['worker'], 'codex1')
            self.assertEqual(started['worker_order'], ['codex1', 'codex2', 'antigravity', 'claude1'])
            self.assertTrue(started['teamyra_mcp'])
            self.assertTrue(started['auto_failover'])
            self.assertEqual(started['max_failovers'], 3)
            self.assertIn(result['ticket_id'], started['task'])
            with patch.object(server, 'read_meta', return_value={'worker': 'codex1', 'state': 'running'}), \
                    patch.object(server, 'failover_terminal_job_id', side_effect=lambda job: job):
                status = server.tool_call('media_ticket_status', {'ticket_id': result['ticket_id']})
            self.assertEqual(status['status'], 'assigned')
            self.assertEqual(status['helper_job']['state'], 'running')
            logged = server.tool_call('media_report_issue', {'description': 'log only', 'job_ids': [job_id],
                                                             'take_over': False})
            self.assertTrue(logged['logged'])

    def test_helper_can_recover_its_own_assisted_jobs(self):
        job_id = self.job(category='download_failure')
        media_engine.append_job_metadata(self.root, job_id, {'provider_submission': {
            'submitted_at': 1.0, 'provider_url': 'https://flow.google.com/project/p', 'baseline_result_keys': ['a', 'b']}})
        ticket = media_support.create_ticket(self.root, kind='issue', reporter='a', description='x', job_ids=[job_id])
        self.assertFalse(media_engine.recover_job(self.root, job_id)['recovered'], 'others still wait for the helper')
        recovered = media_engine.recover_job(self.root, job_id, helper_ticket=ticket['ticket_id'])
        self.assertTrue(recovered['recovered'])
        job = media_engine.load_job(self.root, job_id)
        self.assertEqual(job['assisted_by'], ticket['ticket_id'], 'the reporter keeps seeing the helper')
        media_engine.update_job_state(self.root, job_id, 'failed', 'download_failure: again')
        self.assertEqual(media_engine.load_job(self.root, job_id)['state'], 'assisted')
        self.assertEqual(media_engine.resume_download_job(self.root, job_id, helper_ticket=ticket['ticket_id'])['status'],
                         'waiting_for_browser')
        compact = media_engine.job_status(self.root, job_id, compact=True)['provider_submission']
        self.assertEqual(compact['baseline_result_keys_count'], 2)
        self.assertNotIn('baseline_result_keys', compact)
        self.assertIn('baseline_result_keys', media_engine.job_status(self.root, job_id)['provider_submission'],
                      'the desktop worker still reads the full baseline')

    def test_sweeper_closes_tickets_whose_helper_ended(self):
        job_id = self.job()
        ticket = media_support.create_ticket(self.root, kind='issue', reporter='a', description='x', job_ids=[job_id])
        media_support.record_dispatch(self.root, ticket['ticket_id'], worker='codex1', job_id='helper-1')
        closed = media_support.sweep_tickets(self.root, lambda t: {'worker': 'codex1', 'state': 'failed', 'reason': 'runner_crash'})
        self.assertEqual(closed[0]['status'], 'failed')
        self.assertIn('runner_crash', closed[0]['reason'])
        job = media_engine.load_job(self.root, job_id)
        self.assertEqual(job['state'], 'failed', 'the reporter is not left waiting on a dead helper')
        self.assertIsNone(job['assisted_by'])
        self.assertEqual(media_support.list_issues(self.root, category='helper_incomplete')['total'], 1)
        running = media_support.create_ticket(self.root, kind='issue', reporter='a', description='y', job_ids=[self.job('z')])
        media_support.record_dispatch(self.root, running['ticket_id'], worker='codex1', job_id='helper-2')
        self.assertEqual(media_support.sweep_tickets(self.root, lambda t: {'worker': 'codex1', 'state': 'running'}), [])

    def test_partially_delivered_ticket_releases_undelivered_jobs(self):
        first, second = self.job('one'), self.job('two')
        ticket = media_support.create_ticket(self.root, kind='issue', reporter='a', description='x', job_ids=[first, second])
        media_support.deliver(self.root, ticket['ticket_id'], self.asset()['asset_id'], original_job_id=first)
        media_support.update_ticket(self.root, ticket['ticket_id'], status='partially_delivered', summary='one left')
        self.assertEqual(media_engine.load_job(self.root, first)['state'], 'completed')
        self.assertEqual(media_engine.load_job(self.root, second)['state'], 'failed')

    def test_any_agent_can_note_a_maintenance_issue(self):
        with patch.object(server, 'ROOT', self.root):
            logged = server.tool_call('maintenance_report', {'summary': 'codex exec rejected non-Git folder', 'area': 'worker',
                                                             'severity': 'high', 'refs': ['1018-160201-codex1-7a7d']})
            self.assertTrue(logged['logged'])
            issues = server.tool_call('maintenance_issues', {'area': 'worker'})
            self.assertEqual(issues['total'], 1)
            self.assertEqual(issues['issues'][0]['severity'], 'high')
            self.assertEqual(server.tool_call('maintenance_issues', {'area': 'media'})['total'], 0)
        names = {tool['name'] for tool in server.mcp_tools(include_legacy=False)}
        self.assertIn('teamyra.maintenance_report', names)

    def test_long_tasks_travel_as_a_file(self):
        jobs = self.root / 'jobs'
        jobs.mkdir()
        registry = {'codex1': {'provider': 'codex', 'home': str(self.root)}}
        with patch.object(server, 'JOBS', jobs), patch.object(server, 'worker_registry', return_value=registry),                 patch.object(server, 'worker_auth_status', return_value=(True, '')),                 patch.object(server, 'cooldown_left', return_value=0), patch.object(server, 'worker_settings', return_value={}),                 patch.object(server, 'codex_launch', return_value=['codex']), patch.object(server, 'git', return_value=''),                 patch.object(server, 'spawn_runner', return_value=1234):
            job_id, _ = server.start_job('codex1', 'x' * 50000, str(self.project))
        spec = json.loads((jobs / job_id / 'spec.json').read_text(encoding='utf-8'))
        self.assertLess(sum(len(part) for part in spec['cmd']), 8000, 'the command line stays far below the Windows limit')
        self.assertIn('task.txt', spec['cmd'][-1])
        self.assertEqual(len((jobs / job_id / 'task.txt').read_text(encoding='utf-8')), 50000)

    def test_cli_tool_command(self):
        output = io.StringIO()
        with patch.object(teamyra_cli, 'call', side_effect=lambda name, args: {'name': name, 'args': args}), \
                redirect_stdout(output):
            teamyra_cli.cmd_tool(SimpleNamespace(name='teamyra.media_status', json='{"job_id": "x"}', file=None))
        self.assertEqual(json.loads(output.getvalue()), {'name': 'media_status', 'args': {'job_id': 'x'}})


if __name__ == '__main__':
    unittest.main()

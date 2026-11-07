'''Adversarial public-action tests for lead.tool (S1-1, S11 supplemental).

Contract: handle('lead.tool', {name, args}) forwards only the exact 16
allowlisted tools, with an optional single lead. prefix, caps lead.job_wait
at 120 s, copies args, never auto-confirms, and audits every attempt in
ROOT/logs/lead-tools.jsonl with only safe metadata. Only the public handle
is exercised, through a fake lazy server module and a temp ROOT: no real
jobs, worktrees, accounts or network. Parent S1-1 is not in this snapshot,
so these tests are expected to fail until it lands (WAITING_PARENT).
'''
import copy
import datetime
import json
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))

import desktop_api

LEAD_TOOLS = ('start_task', 'job_status', 'job_wait', 'job_result', 'job_cancel', 'job_message', 'worker_status', 'team_report', 'queue_list', 'worktree_create', 'worktree_diff', 'worktree_merge', 'worktree_discard', 'test_run', 'memory_search', 'memory_add')
ALLOWED_AUDIT_KEYS = {'time', 'name', 'tool', 'outcome', 'args_count', 'count'}
SECRET_MARKERS = ('secret content', 'private token', 'password', 'hunter2')


class LeadToolAdversarialTests(unittest.TestCase):
	def setUp(self):
		self.real_root = desktop_api.ROOT
		self.calls = []
		self.router_error = [None]
		self.router_result = [None]
		def tool_call(name, args):
			self.calls.append((name, args))
			if self.router_error[0] is not None:
				raise self.router_error[0]
			if self.router_result[0] is not None:
				return self.router_result[0]
			return {'ok': True, 'tool': name}
		fake = types.ModuleType('server')
		fake.tool_call = tool_call
		self.fake = fake
		tmp = tempfile.TemporaryDirectory()
		self.addCleanup(tmp.cleanup)
		self.root = Path(tmp.name)
		self.audit = self.root / 'logs' / 'lead-tools.jsonl'
		self.root_patch = patch.object(desktop_api, 'ROOT', self.root)
		self.root_patch.start()
		self.addCleanup(self.root_patch.stop)
		self.server_patch = patch.dict(sys.modules, {'server': fake})
		self.server_patch.start()
		self.addCleanup(self.server_patch.stop)
	def handle(self, payload):
		return desktop_api.handle('lead.tool', payload)

	def run_tool(self, name, args=None):
		if args is None:
			return self.handle({'name': name})
		return self.handle({'name': name, 'args': args})

	def audit_entries(self):
		self.assertTrue(self.audit.is_file(), 'every lead.tool attempt must be audited in ROOT/logs/lead-tools.jsonl')
		lines = [ln for ln in self.audit.read_text(encoding='utf-8').splitlines() if ln.strip()]
		return [json.loads(ln) for ln in lines]

	def audit_text(self):
		return self.audit.read_text(encoding='utf-8')

	def last_audit(self):
		return self.audit_entries()[-1]

	def tool_key(self, entry):
		if 'name' in entry:
			return entry['name']
		return entry.get('tool')

	def count_key(self, entry):
		if 'args_count' in entry:
			return entry['args_count']
		return entry.get('count')

	def test_exact_16_allowlist_both_prefix_forms_forward(self):
		expected = set(LEAD_TOOLS)
		self.assertEqual(len(expected), 16)
		if hasattr(desktop_api, '_LEAD_TOOLS'):
			self.assertEqual(set(desktop_api._LEAD_TOOLS), expected)
		for tool in sorted(expected):
			for name in ('lead.' + tool, tool):
				with self.subTest(name=name):
					self.calls.clear()
					result = self.run_tool(name, {'probe': 1})
					self.assertEqual(len(self.calls), 1)
					self.assertEqual(self.calls[0][0], tool)
					self.assertEqual(self.calls[0][1], {'probe': 1, 'timeout_seconds': 120} if tool == 'job_wait' else {'probe': 1})
					self.assertEqual(result.get('tool'), tool)
		self.assertEqual(len(self.audit_entries()), 32)

	def test_unknown_useronly_malformed_names_never_dispatch(self):
		bad = ('lead.lead.job_status', 'LEAD.JOB_STATUS', 'Lead.job_status', 'lead.Job_Status', 'lead.job_status ', ' lead.job_status', 'lead..job_status', 'lead.job_status.', 'lead.job_status.x', 'lead./../start_task', 'lead.terminal.run', 'lead.filesystem.write', 'lead.process.start', 'lead.chatgpt.tool.execute-in-workspace', 'lead.worktree.merge', 'lead.worktree.rebase', 'lead.memory.list', 'lead.memory.get', 'lead.memory.add', 'lead.guide', 'lead.state', 'lead.review_start', 'lead.code.map', 'lead.code.symbol', 'lead.job_events', 'lead.graph_start', 'lead.scheduler.dispatch', 'lead.transfer.check', 'lead.task.start', 'filesystem.write', 'terminal.run', 'task.start', 'worktree.merge', 'memory.add', 'media.cancel', 'review_start', '', ' ', 'lead.', 'lead', 'job_status ', ' job_status')
		for name in bad:
			with self.subTest(name=name):
				before = len(self.calls)
				with self.assertRaises(ValueError):
					self.run_tool(name, {})
				self.assertEqual(len(self.calls), before)
				entry = self.last_audit()
				self.assertEqual(entry['outcome'], 'denied')
				self.assertEqual(self.tool_key(entry), 'denied')
		for name in (None, 123, 1.5, True, ['lead.job_status'], {'name': 'lead.job_status'}, b'lead.job_status'):
			with self.subTest(name=name):
				before = len(self.calls)
				with self.assertRaises(ValueError):
					self.run_tool(name, {})
				self.assertEqual(len(self.calls), before)
				self.assertEqual(self.last_audit()['outcome'], 'denied')
		text = self.audit_text()
		for leaked in ('terminal.run', 'filesystem.write', 'process.start', 'chatgpt.tool.execute-in-workspace'):
			self.assertNotIn(leaked, text)
	def test_args_must_be_object_with_string_keys_and_are_copied(self):
		self.handle({'name': 'lead.job_status'})
		self.assertEqual(self.calls[-1], ('job_status', {}))
		args = {'job_id': 'j-1', 'nested': {'x': 1}}
		snapshot = copy.deepcopy(args)
		payload = {'name': 'lead.job_status', 'args': args}
		self.handle(payload)
		self.assertEqual(payload, {'name': 'lead.job_status', 'args': snapshot})
		args['job_id'] = 'changed'
		self.assertEqual(self.calls[-1][1]['job_id'], 'j-1')
		self.assertIsNot(self.calls[-1][1], args)
		for bad in ('not-a-dict', 42, [1, 2], True, None, 3.5, {1: 'bad'}, {'ok': 1, 2: 'bad'}):
			with self.subTest(bad=bad):
				before = len(self.calls)
				with self.assertRaises(ValueError):
					self.handle({'name': 'lead.job_status', 'args': bad})
				self.assertEqual(len(self.calls), before)
				self.assertEqual(self.last_audit()['outcome'], 'denied')
		for broken in (None, 'junk', [], {}, {'args': {}}, {'name': ''}, {'name': None}, {'name': 7}):
			with self.subTest(broken=broken):
				before = len(self.calls)
				with self.assertRaises(ValueError):
					self.handle(broken)
				self.assertEqual(len(self.calls), before)
				self.assertEqual(self.last_audit()['outcome'], 'denied')

	def test_job_wait_default_cap_and_passthrough(self):
		cases = (({}, 120), ({'timeout_seconds': 999999}, 120), ({'timeout_seconds': 121}, 120), ({'timeout_seconds': 120.5}, 120), ({'timeout_seconds': 120}, 120), ({'timeout_seconds': 30}, 30), ({'timeout_seconds': 30.5}, 30.5), ({'timeout_seconds': 1}, 1), ({'timeout_seconds': 0}, 0), ({'timeout_seconds': -1}, -1), ({'timeout_seconds': -999}, -999))
		for extra, expected in cases:
			with self.subTest(extra=extra):
				args = {'job_ids': ['j-1']}
				args.update(extra)
				snapshot = copy.deepcopy(args)
				self.run_tool('lead.job_wait', args)
				self.assertEqual(args, snapshot)
				self.assertEqual(self.calls[-1][0], 'job_wait')
				self.assertEqual(self.calls[-1][1].get('timeout_seconds'), expected)
				self.assertEqual(self.calls[-1][1].get('job_ids'), ['j-1'])

	def test_job_wait_rejects_bool_nan_inf_and_nonnumber(self):
		for bad in (True, False, '999', '120', None, float('nan'), float('inf'), float('-inf'), [120], {'seconds': 120}):
			with self.subTest(bad=bad):
				before = len(self.calls)
				with self.assertRaises(ValueError):
					self.run_tool('job_wait', {'job_ids': ['j-1'], 'timeout_seconds': bad})
				self.assertEqual(len(self.calls), before)
				self.assertEqual(self.last_audit()['outcome'], 'denied')
	def test_confirm_never_autoapproved_and_forwarded_unchanged(self):
		cases = (('lead.worktree_merge', {'worktree_id': 'wt-1', 'confirm': False}), ('lead.worktree_merge', {'worktree_id': 'wt-1', 'confirm': True}), ('lead.worktree_merge', {'worktree_id': 'wt-1'}), ('lead.worktree_discard', {'worktree_id': 'wt-2', 'confirm': False}), ('lead.worktree_discard', {'worktree_id': 'wt-2', 'confirm': True}), ('lead.job_cancel', {'job_id': 'j-9'}), ('lead.job_cancel', {'job_id': 'j-9', 'confirm': False}))
		for name, args in cases:
			with self.subTest(name=name, args=args):
				payload = {'name': name, 'args': copy.deepcopy(args)}
				self.handle(payload)
				forwarded = self.calls[-1][1]
				self.assertEqual(forwarded, args)
				if 'confirm' in args:
					self.assertIs(forwarded.get('confirm'), args['confirm'])
				else:
					self.assertNotIn('confirm', forwarded)

	def test_audit_contains_only_safe_metadata(self):
		self.run_tool('lead.job_status', {'job_id': 'alpha', 'password': 'hunter2', 'content': 'secret content'})
		self.run_tool('lead.memory_add', {'content': 'secret content', 'token': 'private token'})
		with self.assertRaises(ValueError):
			self.run_tool('lead.terminal.run', {'command': 'secret content'})
		self.router_error[0] = RuntimeError('private token abc')
		with self.assertRaises(RuntimeError):
			self.run_tool('lead.team_report', {})
		self.router_error[0] = None
		entries = self.audit_entries()
		self.assertEqual(len(entries), 4)
		self.assertEqual([entry['outcome'] for entry in entries], ['success', 'success', 'denied', 'error'])
		self.assertEqual([self.tool_key(entry) for entry in entries], ['job_status', 'memory_add', 'denied', 'team_report'])
		self.assertEqual([self.count_key(entry) for entry in entries], [3, 2, 0, 0])
		for entry in entries:
			self.assertTrue(set(entry.keys()).issubset(ALLOWED_AUDIT_KEYS))
			self.assertIn('outcome', entry)
			self.assertIn('time', entry)
			self.assertTrue(isinstance(entry['time'], str))
			datetime.datetime.fromisoformat(entry['time'])
			self.assertTrue(('name' in entry) or ('tool' in entry))
			self.assertTrue(('args_count' in entry) or ('count' in entry))
		text = self.audit_text()
		for marker in SECRET_MARKERS:
			self.assertNotIn(marker, text)
		self.assertNotIn('private token abc', text)
		self.assertNotIn('alpha', text)
	def test_outcomes_success_router_error_import_error_ok_false_and_failed_job(self):
		result = self.run_tool('lead.job_status', {'job_id': 'a'})
		self.assertEqual(result, {'ok': True, 'tool': 'job_status'})
		self.assertEqual(self.last_audit()['outcome'], 'success')
		self.router_result[0] = {'ok': False, 'error': 'boom'}
		result = self.run_tool('lead.job_cancel', {'job_id': 'j'})
		self.assertEqual(result, {'ok': False, 'error': 'boom'})
		self.assertEqual(self.last_audit()['outcome'], 'error')
		self.router_result[0] = {'ok': True, 'job': {'state': 'failed'}}
		result = self.run_tool('lead.job_result', {'job_id': 'j'})
		self.assertEqual(result['job']['state'], 'failed')
		self.assertEqual(self.last_audit()['outcome'], 'success')
		self.router_result[0] = None
		self.router_error[0] = RuntimeError('router exploded')
		with self.assertRaisesRegex(RuntimeError, 'router exploded'):
			self.run_tool('lead.team_report', {})
		self.assertEqual(self.last_audit()['outcome'], 'error')
		self.router_error[0] = None
		with patch.dict(sys.modules, {'server': None}):
			with self.assertRaises(ImportError):
				self.run_tool('lead.job_cancel', {'job_id': 'j'})
		self.assertEqual(self.last_audit()['outcome'], 'error')
		self.router_result[0] = 'plain-result'
		result = self.run_tool('lead.job_status', {'job_id': 'a'})
		self.assertEqual(result, 'plain-result')
		self.assertEqual(self.last_audit()['outcome'], 'success')
		self.router_result[0] = None

	def test_repeated_and_concurrent_calls_keep_valid_jsonl_and_temp_root_only(self):
		real_audit = self.real_root / 'logs' / 'lead-tools.jsonl'
		real_existed = real_audit.is_file()
		real_before = real_audit.read_bytes() if real_existed else None
		attempts = (('lead.job_status', {'job_id': 'a'}), ('lead.terminal.run', {}), ('lead.job_wait', {'job_ids': ['b'], 'timeout_seconds': 3000}), ('lead.memory_search', {'query': 'x'}), ('lead./../start_task', {}), ('lead.team_report', {}), ('lead.queue_list', {}), ('lead.job_status', {'job_id': 'c'}))
		for name, args in attempts:
			try:
				self.run_tool(name, args)
			except ValueError:
				pass
		entries = self.audit_entries()
		self.assertGreaterEqual(len(entries), len(attempts))
		before = len(entries)
		def call_one(i):
			try:
				self.run_tool('lead.job_status', {'job_id': 'job-' + str(i)})
			except Exception:
				return False
			return True
		with ThreadPoolExecutor(max_workers=8) as pool:
			results = list(pool.map(call_one, range(40)))
		self.assertTrue(all(results))
		entries = self.audit_entries()
		self.assertEqual(len(entries), before + 40)
		self.assertEqual(len(self.calls), 46)
		if real_existed:
			self.assertEqual(real_audit.read_bytes(), real_before)
		else:
			self.assertFalse(real_audit.is_file())





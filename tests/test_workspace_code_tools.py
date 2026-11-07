'''C3 workspace code.map / code.symbol tests.'''
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path('tests').resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'bridge'))

from bridge.code_intel import code_map as direct_map
from workspace_tools import WorkspaceToolError, WorkspaceToolService, digest_output


class CodeToolsTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory()
		self.addCleanup(self.temp.cleanup)
		self.root = Path(self.temp.name) / 'runtime'
		self.root.mkdir()
		self.outside = Path(self.temp.name) / 'outside'
		self.outside.mkdir()
		self.put_at(self.outside, 'outside.py', 'def outside_fn():', ' pass')
		self.put('main.py', 'import helpers', 'def greet():', ' return helpers.work()')
		self.put('helpers.py', 'def work():', ' return 42')
		self.put('caller.py', 'def call_work():', ' return work()')
		self.put('profiles/codex/secret.py', 'def hidden_secret():', ' work()', ' return 987654321')
		self.put('jobs/job1/hidden.py', 'def hidden_job():', ' work()', ' return 555111')
		self.put('chatgpt/note.py', 'def chatgpt_secret():', ' return 111222')
		self.put('.env', 'TOKEN=abcdef')
		self.service = WorkspaceToolService(self.root)
		self.service.state_root.mkdir(parents=True, exist_ok=True)
		self.service.configure(self.root, trusted=True)

	def put(self, name, *lines):
		return self.put_at(self.root, name, *lines)

	def put_at(self, base, name, *lines):
		file = base / name
		file.parent.mkdir(parents=True, exist_ok=True)
		file.write_text(chr(10).join(lines) + chr(10), encoding='utf-8')
		return file

	def call(self, tool, args):
		return self.service.execute(tool, args, trusted=True)

	def test_search_permission_off_and_on(self):
		self.service.configure(self.root, {'search': False}, trusted=True)
		with self.assertRaises(PermissionError):
			self.call('code.map', {'path': '.'})
		with self.assertRaises(PermissionError):
			self.call('code.symbol', {'path': '.', 'name': 'work'})
		with self.assertRaises(PermissionError):
			self.call('filesystem.search', {'query': 'work'})
		self.service.configure(self.root, {'search': True}, trusted=True)
		self.assertTrue(self.call('code.map', {'path': '.'})['files'])

	def test_outside_protected_and_credential_paths_denied(self):
		for target in ('../outside/outside.py', str(self.outside / 'outside.py'), 'profiles', 'profiles/codex/secret.py', 'jobs/job1/hidden.py', '.env', 'chatgpt/note.py'):
			with self.subTest(target=target):
				with self.assertRaises(PermissionError):
					self.call('code.map', {'path': target})
		with self.assertRaises(PermissionError):
			self.call('code.symbol', {'path': 'profiles/codex/secret.py', 'name': 'hidden_secret'})
		with self.assertRaises(PermissionError):
			self.call('code.symbol', {'path': '.env', 'name': 'TOKEN'})

	def test_map_excludes_protected_descendants(self):
		result = self.call('code.map', {'path': '.'})
		paths = [item['path'] for item in result['files']]
		self.assertIn('main.py', paths)
		self.assertIn('helpers.py', paths)
		for bad in ('profiles/', 'jobs/', 'chatgpt/'):
			self.assertFalse([p for p in paths if p.startswith(bad)], bad)
		blob = result['text'] + str(paths)
		for secret in ('hidden_secret', 'hidden_job', 'chatgpt_secret', '987654321', '555111', '111222'):
			self.assertNotIn(secret, blob)
		self.assertEqual(result['budget_chars'], 8000)
		self.assertEqual(result['total_files'], len(paths))

	def test_symbol_no_leak_in_body_or_references(self):
		cache = self.root / 'cache' / 'code-intel'
		direct_map(self.root / 'profiles', cache_root=cache)
		key = hashlib.sha256(str((self.root / 'profiles' / 'codex' / 'secret.py').resolve()).encode()).hexdigest()
		self.assertTrue((cache / (key + '.json')).is_file())
		found = self.call('code.symbol', {'path': '.', 'name': 'hidden_secret'})
		self.assertFalse(found['found'])
		self.assertIsNone(found['definition'])
		self.assertEqual(found['references'], [])
		work = self.call('code.symbol', {'path': '.', 'name': 'work'})
		self.assertTrue(work['found'])
		self.assertEqual(work['definition']['file'], 'helpers.py')
		self.assertIn('return 42', work['definition']['body'])
		for ref in work['references']:
			self.assertFalse(ref['file'].startswith(('profiles/', 'jobs/', 'chatgpt/')))
		self.assertNotIn('987654321', str(work['references']))

	def test_map_budget_focus_and_single_file(self):
		focused = self.call('code.map', {'path': '.', 'focus': 'helpers'})
		self.assertEqual(focused['files'][0]['path'], 'helpers.py')
		limited = self.call('code.map', {'path': '.', 'budget_chars': 25})
		self.assertLessEqual(len(limited['text']), 25)
		self.assertTrue(limited['truncated'])
		self.assertEqual(self.call('code.map', {'path': '.', 'budget_chars': 0})['files'], [])
		single = self.call('code.map', {'path': 'main.py'})
		self.assertEqual([item['path'] for item in single['files']], ['main.py'])
		self.assertIn('greet', [s['name'] for item in single['files'] for s in item['symbols']])

	def test_symbol_shape_missing_and_untrusted_args(self):
		found = self.call('code.symbol', {'path': 'helpers.py', 'name': 'work'})
		self.assertTrue(found['found'])
		self.assertEqual(found['definition']['start_line'], 1)
		self.assertIn('return 42', found['definition']['body'])
		self.assertLessEqual(found['definition']['body_lines'], 300)
		for ref in found['references']:
			self.assertIn('file', ref)
			self.assertIn('line', ref)
			self.assertIn('text', ref)
		missing = self.call('code.symbol', {'path': '.', 'name': 'no_such_symbol'})
		self.assertFalse(missing['found'])
		self.assertIsNone(missing['definition'])
		self.assertEqual(missing['references'], [])
		with self.assertRaises(WorkspaceToolError):
			self.call('code.symbol', {'path': '.', 'name': ''})
		evil = self.call('code.map', {'path': '.', 'cache_root': str(self.outside), 'root': str(self.outside)})
		self.assertIn('helpers.py', [item['path'] for item in evil['files']])
		self.assertTrue((self.root / 'cache' / 'code-intel').exists())
		self.assertFalse((self.outside / 'cache').exists())

	@unittest.skipUnless(os.name == 'nt', 'Windows junction check')
	def test_junction_is_excluded(self):
		outside = Path(self.temp.name) / 'linked_out'
		outside.mkdir()
		(outside / 'linked.py').write_text(chr(10).join(['def linked_fn():', ' pass']) + chr(10), encoding='utf-8')
		link = self.root / 'linked'
		def _unlink(path):
			try:
				os.rmdir(path)
			except OSError:
				os.unlink(path)
		self.addCleanup(_unlink, link)
		result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)], capture_output=True, text=True)
		if result.returncode != 0:
			raise unittest.SkipTest('no junction support')
		paths = [item['path'] for item in self.call('code.map', {'path': '.'})['files']]
		self.assertNotIn('linked/linked.py', paths)
		self.assertNotIn('linked_fn', self.call('code.map', {'path': '.'})['text'])

	def test_full_access_still_hides_protected(self):
		self.service.set_access({'full_access': True, 'outside_workspace': True}, trusted=True, user_confirmed=True)
		result = self.call('code.map', {'path': '.'})
		paths = [item['path'] for item in result['files']]
		self.assertNotIn('profiles/codex/secret.py', paths)
		self.assertNotIn('hidden_secret', result['text'])
		outside_map = self.call('code.map', {'path': str(self.outside)})
		self.assertIn('outside.py', [item['path'] for item in outside_map['files']])

	def test_digest_regression_unaffected(self):
		long_text = ''.join('line ' + str(i) + chr(10) for i in range(200))
		digested = digest_output(long_text)
		self.assertLess(len(digested), len(long_text))
		self.assertIn('digest stdout', digested)
		self.assertIn('line 199', digested)


"""Independent C-2 safety regressions for the public bridge.code_intel API."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from bridge.code_intel import code_map, find_symbol


def _unlink(path):
    try:
        os.rmdir(path)
    except OSError:
        try:
            os.unlink(path)
        except OSError:
            pass


def _dir_link(link, target):
    try:
        os.symlink(target, link, target_is_directory=True)
        return
    except (OSError, NotImplementedError):
        pass
    if os.name != 'nt':
        raise unittest.SkipTest('directory symlinks unsupported')
    result = subprocess.run('cmd /c mklink /J "%s" "%s"' % (link, target), capture_output=True, text=True)
    if result.returncode != 0:
        raise unittest.SkipTest('no directory symlink or junction support')


def _file_link(link, target):
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        raise unittest.SkipTest('file symlinks unsupported')


class CodeIntelSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.cache = self.root / 'cache'

    def put(self, base, name, content):
        file = Path(base) / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding='utf-8')
        return file

    def map(self, **kwargs):
        return code_map(self.project, cache_root=self.cache, **kwargs)

    def test_ignored_directories_and_oversized_files_are_skipped(self):
        self.put(self.project, 'good.py', 'def good():\n    pass\n')
        for directory in ('node_modules', '.git', 'dist', 'build', '__pycache__'):
            self.put(self.project, directory + '/bad.py', 'def bad():\n    pass\n')
        self.put(self.project, 'huge.py', 'x' * (1024 * 1024 + 1))
        result = self.map()
        self.assertEqual([item['path'] for item in result['files']], ['good.py'])
        self.assertFalse(find_symbol(self.project, 'bad', cache_root=self.cache)['found'])

    def test_external_directory_link_does_not_escape_project(self):
        external = self.root / 'external'
        self.put(external, 'secret.py', 'def secret_marker():\n    return 1\n')
        link = self.project / 'linked'
        _dir_link(link, external)
        self.addCleanup(_unlink, link)
        paths = [item['path'] for item in self.map()['files']]
        self.assertNotIn('linked/secret.py', paths)
        for path in paths:
            self.assertFalse(path.startswith('..'), path)
            self.assertNotIn('external', path)
        self.assertFalse(find_symbol(self.project, 'secret_marker', cache_root=self.cache)['found'])

    def test_external_file_link_does_not_escape_project(self):
        outside_file = self.put(self.root, 'outside.py', 'def external_marker():\n    return 2\n')
        self.put(self.project, 'inside.py', 'def inside():\n    pass\n')
        file_link = self.project / 'ext_file.py'
        _file_link(file_link, outside_file)
        self.addCleanup(_unlink, file_link)
        paths = [item['path'] for item in self.map()['files']]
        self.assertNotIn('ext_file.py', paths)
        self.assertIn('inside.py', paths)
        for path in paths:
            self.assertFalse(path.startswith('..'), path)
        self.assertFalse(find_symbol(self.project, 'external_marker', cache_root=self.cache)['found'])

    def test_corrupted_cache_recovers(self):
        self.put(self.project, 'sample.py', 'def sample():\n    return 1\n')
        self.assertTrue(self.map()['files'])
        records = list(self.cache.glob('*.json'))
        self.assertTrue(records)
        records[0].write_text('{not json', encoding='utf-8')
        self.assertIn('sample', [s['name'] for f in self.map()['files'] for s in f['symbols']])
        records[0].write_text(json.dumps({'symbols': 'broken'}), encoding='utf-8')
        self.assertTrue(find_symbol(self.project, 'sample', cache_root=self.cache)['found'])

    def test_mtime_invalidation_refreshes_symbols(self):
        file = self.put(self.project, 'sample.py', 'def old_name():\n    pass\n')
        self.assertTrue(find_symbol(self.project, 'old_name', cache_root=self.cache)['found'])
        file.write_text('def new_name():\n    return 123\n', encoding='utf-8')
        os.utime(file, ns=(file.stat().st_atime_ns, file.stat().st_mtime_ns + 2000000000))
        self.assertTrue(find_symbol(self.project, 'new_name', cache_root=self.cache)['found'])
        self.assertFalse(find_symbol(self.project, 'old_name', cache_root=self.cache)['found'])

    def test_body_and_reference_caps_on_adversarial_fixture(self):
        self.put(self.project, 'long.py', 'def huge():\n' + '    x = 1\n' * 350)
        self.put(self.project, 'uses.py', 'huge()\n' * 80)
        found = find_symbol(self.project, 'huge', cache_root=self.cache)
        definition = found['definition']
        self.assertTrue(found['found'])
        self.assertLessEqual(len(definition['body'].splitlines()), 300)
        self.assertLessEqual(definition['body_lines'], 300)
        self.assertTrue(definition['truncated'])
        self.assertLessEqual(len(found['references']), 30)
        self.assertTrue(found['references'])

    def test_budget_with_oversized_first_file_stays_bounded(self):
        self.put(self.project, 'big.py', ''.join('def big_%d():\n    pass\n\n' % i for i in range(60)))
        self.put(self.project, 'small.py', 'def small():\n    pass\n')
        result = self.map(budget_chars=120, focus='big')
        self.assertLessEqual(len(result['text']), 120)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['total_files'], 2)
        empty = self.map(budget_chars=0)
        self.assertEqual(empty['files'], [])
        self.assertEqual(empty['text'], '')

    def test_large_import_graph_compact_map(self):
        self.put(self.project, 'hub.py', 'def shared():\n    return 1\n')
        for i in range(12):
            self.put(self.project, 'user_%02d.py' % i, 'import hub\n\ndef use_%d():\n    return hub.shared()\n' % i)
        result = self.map(budget_chars=100000)
        self.assertEqual(result['files'][0]['path'], 'hub.py')
        self.assertGreaterEqual(result['files'][0]['imported_by'], 12)
        self.assertFalse(result['truncated'])
        self.assertLessEqual(len(result['text']), 100000)
        self.assertGreaterEqual(len(result['files']), 13)


if __name__ == '__main__':
    unittest.main()

"""Regression tests for the bounded code-intelligence library."""
import os
from pathlib import Path
import tempfile
import time
import unittest

from bridge.code_intel import code_map, find_symbol


class CodeIntelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.cache = self.root / 'cache'

    def put(self, name, content):
        file = self.project / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding='utf-8')
        return file

    def map(self, **kwargs):
        return code_map(self.project, cache_root=self.cache, **kwargs)

    def symbol(self, name):
        return find_symbol(self.project, name, cache_root=self.cache)

    def test_python_classes_methods_ranges_and_references(self):
        self.put('main.py', 'import helpers\nclass Example:\n    def run(self):\n        return helpers.work()\n\ndef execute():\n    return Example().run()\n')
        self.put('helpers.py', 'def work():\n    return 42\n')
        result = self.map()
        names = {s['name']: s for f in result['files'] for s in f['symbols']}
        self.assertEqual(names['Example']['kind'], 'class')
        self.assertEqual(names['run']['kind'], 'method')
        self.assertEqual(names['execute']['line'], 6)
        found = self.symbol('run')
        self.assertTrue(found['found'])
        self.assertEqual((found['definition']['start_line'], found['definition']['end_line']), (3, 4))
        self.assertIn('return helpers.work()', found['definition']['body'])
        self.assertTrue(found['references'])
        self.assertFalse(self.symbol('missing')['found'])

    def test_javascript_typescript_exports_and_import_ranking(self):
        self.put('z.ts', 'export function shared() {\n return 1;\n}\nexport class Widget {\n method() { return shared(); }\n}\n')
        self.put('a.js', "import { shared } from './z';\nexport const answer = 3;\nshared();\n")
        self.put('b.tsx', "import { Widget } from './z';\nexport function render() { return Widget; }\n")
        result = self.map()
        self.assertEqual(result['files'][0]['path'], 'z.ts')
        self.assertEqual(result['files'][0]['imported_by'], 2)
        self.assertIn('shared', [s['name'] for s in result['files'][0]['symbols']])
        self.assertIn('answer', [s['name'] for f in result['files'] for s in f['symbols']])
        self.assertEqual(self.symbol('shared')['definition']['start_line'], 1)

    def test_focus_and_budget(self):
        self.put('first.py', 'def first():\n    pass\n')
        self.put('target.py', 'def target():\n    pass\n')
        focused = self.map(focus='target')
        self.assertEqual(focused['files'][0]['path'], 'target.py')
        limited = self.map(budget_chars=25)
        self.assertLessEqual(len(limited['text']), 25)
        self.assertTrue(limited['truncated'])
        self.assertEqual(self.map(budget_chars=0)['files'], [])

    def test_ignored_directories_large_files_and_symlinks(self):
        self.put('good.py', 'def good():\n    pass\n')
        for directory in ('node_modules', '.git', 'dist', 'build', '__pycache__'):
            self.put(directory + '/bad.py', 'def bad():\n    pass\n')
        self.put('huge.py', 'x' * (1024 * 1024 + 1))
        paths = [item['path'] for item in self.map()['files']]
        self.assertEqual(paths, ['good.py'])

    def test_cache_invalidation(self):
        file = self.put('sample.py', 'def old():\n    pass\n')
        self.assertTrue(self.symbol('old')['found'])
        self.assertTrue(list(self.cache.glob('*.json')))
        file.write_text('def updated():\n    return 123\n', encoding='utf-8')
        os.utime(file, ns=(file.stat().st_atime_ns, file.stat().st_mtime_ns + 2_000_000_000))
        self.assertTrue(self.symbol('updated')['found'])
        self.assertFalse(self.symbol('old')['found'])

    def test_body_and_reference_caps(self):
        self.put('long.py', 'def huge():\n' + '    x = 1\n' * 350)
        self.put('uses.py', 'huge()\n' * 50)
        found = self.symbol('huge')
        self.assertEqual(found['definition']['body_lines'], 300)
        self.assertTrue(found['definition']['truncated'])
        self.assertEqual(len(found['references']), 30)


if __name__ == '__main__':
    unittest.main()

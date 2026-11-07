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


    def test_language_fallbacks_and_controls(self):
        cases = {'.go': ('func (s *Server) Serve() {\n}\n', 'Serve'), '.rs': ('pub fn compute() {\n}\n', 'compute'), '.java': ('public int calculate() {\n return 1;\n}\n', 'calculate'), '.cs': ('public int Calculate() {\n return 1;\n}\n', 'Calculate'), '.js': ('const run = () => { return 1; };\n', 'run'), '.mjs': ('export function mjs() {}\n', 'mjs'), '.cjs': ('function cjs() {}\n', 'cjs'), '.ts': ('export function typed() {}\n', 'typed'), '.tsx': ('export function component() {}\n', 'component'), '.jsx': ('export function view() {}\n', 'view')}
        for extension, (source, name) in cases.items():
            with self.subTest(extension=extension):
                self.put('case' + extension, source)
                self.assertTrue(self.symbol(name)['found'])
        self.put('controls.js', 'if (ready) {\n}\nfor (x of xs) {\n}\nconst plain = 42;\n')
        names = [s['name'] for f in self.map()['files'] for s in f['symbols']]
        self.assertNotIn('if', names)
        self.assertNotIn('for', names)
        self.assertNotIn('plain', names)

    def test_tree_backend_and_failure_fallback(self):
        from unittest.mock import patch
        from bridge import code_intel
        class Node:
            start_point = type('Point', (), {'row': 0})()
            end_point = type('Point', (), {'row': 0})()
            named_children = []
            def child_by_field_name(self, field):
                return type('Name', (), {'start_byte': 9, 'end_byte': 14})()
        class Pack:
            def get_parser(self, language):
                self.language = language
                return self
            def parse(self, raw):
                return type('Tree', (), {'root_node': type('Root', (), {'has_error': False, 'named_children': [Node()], 'type': 'program'})()})()
        Node.type = 'function_declaration'
        pack = Pack()
        with patch.object(code_intel, '_language_pack', pack):
            self.assertEqual(code_intel._parse(Path('x.js'), 'function hello() {}')[0][0]['name'], 'hello')
            self.assertEqual(pack.language, 'javascript')
        with patch.object(code_intel, '_language_pack', object()):
            self.assertEqual(code_intel._parse(Path('x.go'), 'func work() {}')[0][0]['name'], 'work')

    def test_default_cache_and_oversized_first(self):
        from unittest.mock import patch
        from bridge import code_intel
        self.put('large.py', ''.join('def fn%d():\n    pass\n' % n for n in range(80)))
        self.put('small.py', 'def small():\n    pass\n')
        with patch.dict(os.environ, {'TEAMYRA_ROOT': str(self.root)}):
            result = code_map(self.project, budget_chars=70, focus='large')
            self.assertTrue((self.root / 'cache' / 'code-intel').exists())
        self.assertTrue(result['files'])
        self.assertEqual(result['files'][0]['path'], 'large.py')
        self.assertTrue(result['files'][0]['truncated'])
        self.assertLessEqual(len(result['text']), 70)
        self.assertEqual(result['files'][0]['symbols'][0]['name'], 'fn0')

    def test_explicit_extension_import_centrality(self):
        self.put('shared.js', 'export function shared() {}\n')
        self.put('use.js', "import { shared } from './shared.js';\n")
        self.assertEqual(next(f for f in self.map()['files'] if f['path'] == 'shared.js')['imported_by'], 1)


if __name__ == '__main__':
    unittest.main()

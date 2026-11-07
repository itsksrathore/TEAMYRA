'''
Language-contract regression tests for code_intel.
Target the real public code_map and find_symbol API only.
'''
import os
from pathlib import Path
import tempfile
import unittest
from bridge.code_intel import code_map, find_symbol


class CodeIntelLanguagesTests(unittest.TestCase):
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

	def names(self, result, path):
		for item in result['files']:
			if item['path'] == path:
				return [s['name'] for s in item['symbols']]
		return []

	def kinds(self, result, path):
		for item in result['files']:
			if item['path'] == path:
				return {s['name']: s['kind'] for s in item['symbols']}
		return {}
	def test_python_js_ts_common_definitions(self):
		self.put('animal.py', '''class Animal:
	def speak(self):
		return 'hi'
def make():
	return Animal()
''')
		self.put('app.js', '''class Widget {
	render() {
		return 1;
	}
}
function boot() {
	return new Widget();
}
export const answer = 3;
''')
		self.put('shape.ts', '''export function shared() {
	return 1;
}
export interface Shape {
	name: string;
}
export class Box {
	open() {
		return 1;
	}
}
''')
		result = self.map()
		py = self.kinds(result, 'animal.py')
		self.assertEqual(py['Animal'], 'class')
		self.assertEqual(py['speak'], 'method')
		self.assertEqual(py['make'], 'function')
		js = self.kinds(result, 'app.js')
		self.assertEqual(js['Widget'], 'class')
		self.assertEqual(js['render'], 'method')
		self.assertEqual(js['boot'], 'function')
		self.assertIn('answer', js)
		ts = self.names(result, 'shape.ts')
		self.assertIn('shared', ts)
		self.assertIn('Shape', ts)
		self.assertIn('Box', ts)
		self.assertIn('open', ts)
		found = self.symbol('speak')
		self.assertTrue(found['found'])
		self.assertIn('return', found['definition']['body'])
	def test_mjs_cjs_tsx_jsx_definitions(self):
		self.put('load.mjs', '''export function load() {
	return 1;
}
export const ready = true;
''')
		self.put('load.cjs', '''function loadLocal() {
	return 2;
}
module.exports = { loadLocal };
''')
		self.put('view.tsx', '''export function render() {
	return 1;
}
export class Panel {
	show() {
		return 1;
	}
}
''')
		self.put('view.jsx', '''function renderJsx() {
	return 1;
}
class Card {
	open() {
		return 1;
	}
}
''')
		result = self.map()
		self.assertIn('load', self.names(result, 'load.mjs'))
		self.assertIn('ready', self.names(result, 'load.mjs'))
		self.assertIn('loadLocal', self.names(result, 'load.cjs'))
		tsx = self.names(result, 'view.tsx')
		self.assertIn('render', tsx)
		self.assertIn('Panel', tsx)
		self.assertIn('show', tsx)
		jsx = self.kinds(result, 'view.jsx')
		self.assertEqual(jsx['renderJsx'], 'function')
		self.assertEqual(jsx['Card'], 'class')
		self.assertEqual(jsx['open'], 'method')
	def test_go_rust_java_csharp_typed_methods(self):
		self.put('main.go', '''package main
func greet(name string) string {
	return name;
}
func (s *Server) Serve() {
	return;
}
func main() {
	greet('hi');
}
''')
		self.put('lib.rs', '''struct Thing {
	value: i32,
}
pub fn run() {
	helper();
}
fn helper() {
	return;
}
impl Thing {
	fn greet(&self) {
		return;
	}
}
''')
		self.put('Hello.java', '''public class Hello {
	public String greet(String name) {
		return name;
	}
	private void run() {
	}
}
''')
		self.put('Worker.cs', '''public class Worker {
	public int Add(int a, int b) {
		return a + b;
	}
	private void Reset() {
	}
}
''')
		result = self.map()
		go = self.kinds(result, 'main.go')
		self.assertEqual(go['greet'], 'function')
		self.assertEqual(go['Serve'], 'method')
		self.assertEqual(go['main'], 'function')
		rs = self.names(result, 'lib.rs')
		self.assertIn('Thing', rs)
		self.assertIn('run', rs)
		self.assertIn('helper', rs)
		self.assertIn('greet', rs)
		java = self.kinds(result, 'Hello.java')
		self.assertEqual(java['Hello'], 'class')
		self.assertEqual(java['greet'], 'method')
		self.assertEqual(java['run'], 'method')
		cs = self.kinds(result, 'Worker.cs')
		self.assertEqual(cs['Worker'], 'class')
		self.assertEqual(cs['Add'], 'method')
		self.assertEqual(cs['Reset'], 'method')
	def test_js_ts_arrow_exports_and_plain_const_excluded(self):
		self.put('handlers.js', '''export const handler = async (event) => {
	return 1;
};
export const double = (x) => x * 2;
const local = (x) => x + 1;
const count = 42;
function plain() {
	return 3;
}
''')
		self.put('handlers.ts', '''export const typed = (x: number): number => x + 1;
''')
		result = self.map()
		names = self.names(result, 'handlers.js')
		self.assertIn('handler', names)
		self.assertIn('double', names)
		self.assertIn('local', names)
		self.assertIn('plain', names)
		self.assertNotIn('count', names)
		self.assertIn('typed', self.names(result, 'handlers.ts'))
		found = self.symbol('handler')
		self.assertTrue(found['found'])
		self.assertIn('return 1;', found['definition']['body'])

	def test_control_statements_excluded_from_methods(self):
		self.put('control.js', '''function check(value) {
	if (value) {
		return 1;
	}
	for (let i = 0; i < 3; i++) {
		value += i;
	}
	while (value) {
		value -= 1;
	}
	switch (value) {
		case 1:
			break;
	}
	try {
		check(1);
	} catch (err) {
	}
	return value;
}
''')
		result = self.map()
		self.assertEqual(self.names(result, 'control.js'), ['check'])
		self.assertFalse(self.symbol('if')['found'])
		self.assertFalse(self.symbol('while')['found'])
		self.assertFalse(self.symbol('switch')['found'])
		self.assertFalse(self.symbol('catch')['found'])
	def test_quoted_and_comment_braces_do_not_truncate_body(self):
		self.put('message.js', '''export function message() {
	const text = '}';
	// } closing brace in comment
	/* { */
	return text;
}
export function after() {
	return 2;
}
''')
		found = self.symbol('message')
		self.assertTrue(found['found'])
		self.assertEqual(found['definition']['start_line'], 1)
		self.assertEqual(found['definition']['end_line'], 6)
		self.assertIn('return text;', found['definition']['body'])
		later = self.symbol('after')
		self.assertTrue(later['found'])
		self.assertEqual(later['definition']['start_line'], 7)
		self.assertIn('return 2;', later['definition']['body'])

	def test_imports_resolve_to_actual_target_not_basename(self):
		self.put('left/shared.js', '''export function sharedLeft() {
	return 1;
}
''')
		self.put('right/shared.js', '''export function sharedRight() {
	return 2;
}
''')
		self.put('a.ts', '''import { sharedLeft } from './left/shared.js';
export function useLeft() {
	return sharedLeft();
}
''')
		self.put('b.ts', '''import { sharedRight } from './right/shared.js';
export function useRight() {
	return sharedRight();
}
''')
		result = self.map()
		by_path = {item['path']: item['imported_by'] for item in result['files']}
		self.assertEqual(by_path['left/shared.js'], 1)
		self.assertEqual(by_path['right/shared.js'], 1)
		self.assertIn('sharedLeft', self.names(result, 'left/shared.js'))
		self.assertIn('sharedRight', self.names(result, 'right/shared.js'))
	def test_mtime_and_focus_ranking_is_deterministic(self):
		target = self.put('target.py', '''def target():
	pass
''')
		other = self.put('other.py', '''def other():
	pass
''')
		base = 1600000000000000000
		os.utime(target, ns=(base, base))
		os.utime(other, ns=(base + 3600000000000, base + 3600000000000))
		plain = self.map()
		self.assertEqual(plain['files'][0]['path'], 'other.py')
		self.assertEqual(self.map()['files'][0]['path'], 'other.py')
		focused = self.map(focus='target')
		self.assertEqual(focused['files'][0]['path'], 'target.py')
		self.assertEqual(focused['total_files'], 2)

	def test_budget_includes_partial_first_file(self):
		self.put('solo.py', '''def first():
	pass
def second():
	pass
def third():
	pass
''')
		full = self.map(budget_chars=10000)
		lines = full['text'].splitlines(keepends=True)
		budget = len(lines[0]) + len(lines[1])
		result = self.map(budget_chars=budget)
		self.assertLessEqual(len(result['text']), budget)
		self.assertTrue(result['truncated'])
		self.assertEqual([item['path'] for item in result['files']], ['solo.py'])
		self.assertEqual(self.names(result, 'solo.py'), ['first'])
		self.assertTrue(result['files'][0].get('truncated'))









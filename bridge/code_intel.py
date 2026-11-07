"""Bounded, cached source maps and symbol lookup for local projects."""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import re

try:
    import tree_sitter_language_pack as _language_pack
except ImportError:
    _language_pack = None

LANGUAGES = {'.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'tsx', '.go': 'go', '.rs': 'rust', '.java': 'java', '.cs': 'c_sharp'}

EXTENSIONS = {'.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.cs'}
IGNORED = {'node_modules', '.git', 'dist', 'build', '__pycache__'}
MAX_BYTES = 1024 * 1024
MAX_BODY_LINES = 300
MAX_REFERENCES = 30


def default_cache_root(root=None):
    if root is None:
        root = os.environ.get('TEAMYRA_ROOT')
    return Path(root or Path(__file__).resolve().parent.parent) / 'cache' / 'code-intel'


def _files(path):
    base = Path(path)
    if base.is_file():
        candidates = [base]
    elif base.is_dir():
        candidates = (p for folder, dirs, names in os.walk(base, followlinks=False) for p in _walk(folder, dirs, names))
    else:
        raise FileNotFoundError(str(path))
    for p in candidates:
        try:
            if p.suffix.lower() in EXTENSIONS and not any(part in IGNORED for part in p.parts) and not p.is_symlink() and p.stat().st_size <= MAX_BYTES:
                yield p
        except OSError:
            continue


def _walk(folder, dirs, names):
    dirs[:] = sorted(d for d in dirs if d not in IGNORED and not (Path(folder) / d).is_symlink())
    for name in sorted(names):
        yield Path(folder) / name


def _tree_parse(path, source):
    if _language_pack is None or path.suffix.lower() not in LANGUAGES:
        return None
    try:
        raw = source.encode('utf-8')
        tree = _language_pack.get_parser(LANGUAGES[path.suffix.lower()]).parse(raw)
        if tree.root_node.has_error:
            return None
        kinds = {'class_definition': 'class', 'class_declaration': 'class', 'interface_declaration': 'class', 'struct_item': 'class', 'function_definition': 'function', 'function_declaration': 'function', 'function_item': 'function', 'method_definition': 'method', 'method_declaration': 'method', 'method': 'method'}
        symbols = []
        def visit(node, in_class=False):
            kind = kinds.get(node.type)
            if kind:
                identifier = node.child_by_field_name('name')
                if identifier is None and kind == 'method':
                    identifier = next((c for c in node.children if c.type in ('property_identifier', 'identifier')), None)
                if identifier is not None:
                    name = raw[identifier.start_byte:identifier.end_byte].decode('utf-8', errors='replace')
                    symbols.append({'name': name, 'kind': 'method' if kind == 'function' and in_class else kind, 'line': node.start_point.row + 1, 'end_line': node.end_point.row + 1})
            for child in node.named_children:
                visit(child, in_class or kind == 'class')
        visit(tree.root_node)
        return symbols
    except Exception:
        return None


def _parse(path, source):
    lines = source.splitlines()
    tree_symbols = _tree_parse(path, source)
    symbols = []
    imports = []
    if path.suffix == '.py':
        try:
            tree = ast.parse(source)
            def visit(nodes, parent=None):
                for node in nodes:
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        kind = 'class' if isinstance(node, ast.ClassDef) else ('method' if parent else 'function')
                        symbols.append({'name': node.name, 'kind': kind, 'line': node.lineno, 'end_line': node.end_lineno or node.lineno})
                        if isinstance(node, ast.ClassDef):
                            visit(node.body, node.name)
                    elif parent is None and isinstance(node, ast.Import):
                        imports.extend(alias.name for alias in node.names)
                    elif parent is None and isinstance(node, ast.ImportFrom):
                        if node.module:
                            imports.append(node.module)
            visit(tree.body)
            return (tree_symbols if tree_symbols is not None else symbols), imports
        except SyntaxError:
            pass
    pattern = re.compile(r'^\s*(?:(export)\s+(?:default\s+)?|(?:public|private|protected|static|async|abstract|override)\s+)*(?:(class|interface|enum|struct|trait|impl|func|fn|function|def)\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=|([\w$]+)\s*\([^;]*\)\s*(?::[^{}]+)?\s*\{)')
    typed = re.compile(r'^\s*(?:(?:public|private|protected|internal|static|final|virtual|override|abstract|async|sealed|extern)\s+)*(?:[\w<>\[\],?]+\s+)+([\w$]+)\s*\([^;]*\)\s*(?:\{|$)')
    go_receiver = re.compile(r'^\s*func\s+\([^)]*\)\s+([\w]+)\s*\(')
    rust_pub = re.compile(r'^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+([\w]+)\s*\(')
    arrow = re.compile(r'^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>')
    controls = {'if', 'for', 'while', 'catch', 'switch', 'else', 'try', 'return', 'throw', 'with', 'lock', 'using'}
    for i, line in enumerate(lines):
        match = pattern.match(line)
        if match or go_receiver.match(line) or rust_pub.match(line) or (path.suffix in ('.java', '.cs') and typed.match(line)) or arrow.match(line):
            exported, keyword, named, variable, method = match.groups() if match else (None, None, None, None, None)
            name = named or variable or method
            special = go_receiver.match(line) if path.suffix == '.go' else rust_pub.match(line) if path.suffix == '.rs' else typed.match(line) if path.suffix in ('.java', '.cs') else None
            arrow_match = arrow.match(line) if path.suffix in ('.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx') else None
            if special:
                name, method, variable, keyword = special.group(1), None, None, 'fn'
            if arrow_match:
                name, variable, keyword = arrow_match.group(1), None, 'fn'
            if variable and not exported and not re.search(r'=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)', line):
                name = None
            if name in controls:
                name = None
            kind = 'export' if exported else ('class' if keyword in ('class', 'interface', 'enum', 'struct', 'trait', 'impl') else 'method' if method else 'function')
            start = i + 1
            end = start
            depth = 0
            opened = False
            for j in range(i, len(lines)):
                depth += lines[j].count('{') - lines[j].count('}')
                opened |= '{' in lines[j]
                if opened and depth <= 0:
                    end = j + 1
                    break
                end = j + 1
            if name:
                symbols.append({'name': name, 'kind': kind, 'line': start, 'end_line': end})
        imp = re.search(r'\b(?:from\s+["\']([^"\']+)|require\(["\']([^"\']+)|import\s+["\']([^"\']+)|^\s*import\s+([\w./]+))', line)
        if imp:
            imports.append(next(group for group in imp.groups() if group))
    return (tree_symbols if tree_symbols is not None else symbols), imports


def _extract(path, cache):
    stat = path.stat()
    key = hashlib.sha256(str(path.resolve()).encode()).hexdigest()
    location = cache / (key + '.json') if cache else None
    if location:
        try:
            record = json.loads(location.read_text(encoding='utf-8'))
            if record['mtime_ns'] == stat.st_mtime_ns and record['size'] == stat.st_size:
                return record['symbols'], record['imports']
        except (OSError, ValueError, KeyError, TypeError):
            pass
    symbols, imports = _parse(path, path.read_text(encoding='utf-8', errors='replace'))
    if location:
        try:
            cache.mkdir(parents=True, exist_ok=True)
            location.write_text(json.dumps({'mtime_ns': stat.st_mtime_ns, 'size': stat.st_size, 'symbols': symbols, 'imports': imports}), encoding='utf-8')
        except OSError:
            pass
    return symbols, imports


def _inventory(path, cache, focus):
    base = Path(path).resolve()
    directory = base if base.is_dir() else base.parent
    files = list(_files(base))
    parsed = {}
    for file in files:
        try:
            parsed[file] = _extract(file, cache)
        except OSError:
            continue
    centrality = {file: 0 for file in parsed}
    for file, (_, imports) in parsed.items():
        for other in parsed:
            if other != file and any(other.stem == Path(imp).stem or other.stem == imp.rsplit('/', 1)[-1] for imp in imports):
                centrality[other] += 1
    def rank(file):
        relative = file.relative_to(directory).as_posix()
        try:
            modified = file.stat().st_mtime_ns
        except OSError:
            modified = 0
        match = bool(focus and (str(focus).lower() in relative.lower() or any(str(focus).lower() in s['name'].lower() for s in parsed[file][0])))
        recent = modified >= max((f.stat().st_mtime_ns for f in parsed), default=0) - 86_400_000_000_000
        return (-int(match), -int(recent), -centrality[file], -modified, relative)
    return directory, sorted(parsed, key=rank), parsed, centrality


def code_map(path, budget_chars=8000, focus=None, root=None, cache_root=None):
    """Return {path, files, text, total_files, truncated, budget_chars, focus}."""
    budget = max(0, int(budget_chars))
    cache = Path(cache_root) if cache_root else default_cache_root(root)
    directory, ranked, parsed, centrality = _inventory(path, cache, focus)
    entries, chunks, used = [], [], 0
    cut = False
    for file in ranked:
        relative = file.relative_to(directory).as_posix()
        symbols, _imports = parsed[file]
        header = relative + '\n'
        if len(header) > budget - used:
            cut = True
            continue
        available = budget - used - len(header)
        shown = []
        rows = []
        for symbol in symbols:
            row = '  %s %s @%d\n' % (symbol['kind'], symbol['name'], symbol['line'])
            if len(row) > available:
                cut = True
                break
            rows.append(row)
            available -= len(row)
            shown.append({'name': symbol['name'], 'kind': symbol['kind'], 'line': symbol['line']})
        chunk = header + ''.join(rows)
        chunks.append(chunk)
        used += len(chunk)
        entries.append({'path': relative, 'symbols': shown, 'imported_by': centrality[file], 'truncated': len(shown) < len(symbols)})
    return {'path': str(Path(path).resolve()), 'files': entries, 'text': ''.join(chunks), 'total_files': len(ranked), 'truncated': cut or len(entries) < len(ranked), 'budget_chars': budget, 'focus': focus}



def find_symbol(path, name, root=None, cache_root=None):
    """Return {name, found, definition, references}; definition body <=300 lines."""
    cache = Path(cache_root) if cache_root else default_cache_root(root)
    directory, ranked, parsed, _ = _inventory(path, cache, name)
    definition = None
    for file in ranked:
        for symbol in parsed[file][0]:
            if symbol['name'] != name:
                continue
            lines = file.read_text(encoding='utf-8', errors='replace').splitlines()
            start = symbol['line']
            end = min(symbol['end_line'], len(lines))
            body = lines[start - 1:end]
            definition = {'file': file.relative_to(directory).as_posix(), 'kind': symbol['kind'], 'start_line': start, 'end_line': end, 'body': '\n'.join(body[:MAX_BODY_LINES]), 'truncated': len(body) > MAX_BODY_LINES, 'body_lines': min(len(body), MAX_BODY_LINES)}
            break
        if definition:
            break
    references = []
    if definition:
        word = re.compile(r'\b' + re.escape(name) + r'\b')
        for file in sorted(parsed):
            relative = file.relative_to(directory).as_posix()
            for line_number, line in enumerate(file.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
                if word.search(line) and not (relative == definition['file'] and line_number == definition['start_line']):
                    references.append({'file': relative, 'line': line_number, 'text': line.strip()})
                    if len(references) >= MAX_REFERENCES:
                        break
            if len(references) >= MAX_REFERENCES:
                break
    return {'name': name, 'found': definition is not None, 'definition': definition, 'references': references}

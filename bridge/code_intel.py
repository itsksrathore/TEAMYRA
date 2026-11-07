"""Bounded, cached source maps and symbol lookup for local projects."""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import re

EXTENSIONS = {'.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.cs'}
IGNORED = {'node_modules', '.git', 'dist', 'build', '__pycache__'}
MAX_BYTES = 1024 * 1024
MAX_BODY_LINES = 300
MAX_REFERENCES = 30


def default_cache_root(root=None):
    if root is None:
        root = os.environ.get('TEAMYRA_ROOT')
    return Path(root) / 'cache' / 'code-intel' if root else None


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


def _parse(path, source):
    lines = source.splitlines()
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
            return symbols, imports
        except SyntaxError:
            pass
    pattern = re.compile(r'^\s*(?:(export)\s+(?:default\s+)?|(?:public|private|protected|static|async|abstract|override)\s+)*(?:(class|interface|enum|struct|trait|impl|func|fn|function|def)\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=|([\w$]+)\s*\([^;]*\)\s*(?::[^{}]+)?\s*\{)')
    for i, line in enumerate(lines):
        match = pattern.match(line)
        if match:
            exported, keyword, named, variable, method = match.groups()
            name = named or variable or method
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
            symbols.append({'name': name, 'kind': kind, 'line': start, 'end_line': end})
        imp = re.search(r'\b(?:from\s+["\']([^"\']+)|require\(["\']([^"\']+)|import\s+["\']([^"\']+)|^\s*import\s+([\w./]+))', line)
        if imp:
            imports.append(next(group for group in imp.groups() if group))
    return symbols, imports


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
            if other != file and any(other.stem == imp.rsplit('/', 1)[-1].rsplit('.', 1)[-1] or other.stem == imp.rsplit('/', 1)[-1] for imp in imports):
                centrality[other] += 1
    def rank(file):
        relative = file.relative_to(directory).as_posix()
        try:
            modified = file.stat().st_mtime_ns
        except OSError:
            modified = 0
        match = bool(focus and (str(focus).lower() in relative.lower() or any(str(focus).lower() in s['name'].lower() for s in parsed[file][0])))
        return (-int(match), -centrality[file], -modified, relative)
    return directory, sorted(parsed, key=rank), parsed, centrality


def code_map(path, budget_chars=8000, focus=None, root=None, cache_root=None):
    """Return {path, files, text, total_files, truncated, budget_chars, focus}."""
    budget = max(0, int(budget_chars))
    cache = Path(cache_root) if cache_root else default_cache_root(root)
    directory, ranked, parsed, centrality = _inventory(path, cache, focus)
    entries, chunks, used = [], [], 0
    for file in ranked:
        relative = file.relative_to(directory).as_posix()
        symbols, imports = parsed[file]
        chunk = relative + '\n' + ''.join('  %s %s @%d\n' % (s['kind'], s['name'], s['line']) for s in symbols)
        if len(chunk) > budget - used:
            break
        chunks.append(chunk)
        used += len(chunk)
        entries.append({'path': relative, 'symbols': [{'name': s['name'], 'kind': s['kind'], 'line': s['line']} for s in symbols], 'imports': imports, 'imported_by': centrality[file], 'mtime': file.stat().st_mtime})
    return {'path': str(Path(path).resolve()), 'files': entries, 'text': ''.join(chunks), 'total_files': len(ranked), 'truncated': len(entries) < len(ranked), 'budget_chars': budget, 'focus': focus}


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

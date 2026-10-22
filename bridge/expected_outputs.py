"""Validate relative output-file contracts before a worker reports success."""
from pathlib import Path, PureWindowsPath


def validate_expect_files(project_path, paths):
    if paths is None:
        return []
    if not isinstance(paths, list):
        raise ValueError("expect_files must be a list of paths relative to project_path")
    root = Path(project_path).resolve()
    for value in paths:
        if not isinstance(value, str) or not value.strip() or "\x00" in value:
            raise ValueError("expect_files entries must be non-empty relative paths")
        windows = PureWindowsPath(value)
        relative = Path(value.replace("\\", "/"))
        if windows.drive or windows.root or relative.is_absolute() or ".." in relative.parts:
            raise ValueError("expect_files paths must stay inside project_path")
        try:
            (root / relative).resolve().relative_to(root)
        except ValueError:
            raise ValueError("expect_files paths must stay inside project_path") from None
    return list(paths)


def missing_outputs(project_path, paths):
    """Missing, empty, non-file, inaccessible, or escaped outputs fail closed."""
    missing = []
    root = Path(project_path).resolve()
    for value in paths or []:
        try:
            validate_expect_files(root, [value])
            output = (root / value.replace("\\", "/")).resolve()
            if not output.is_file() or output.stat().st_size == 0:
                missing.append(value)
        except (OSError, ValueError, RuntimeError):
            missing.append(value)
    return missing

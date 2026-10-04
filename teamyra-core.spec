# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

ROOT = Path(SPECPATH).resolve()
BRIDGE = ROOT / "bridge"

hiddenimports = [
    "server",
    "runner",
    "conductor_monitor",
    "review_monitor",
    "failover_monitor",
    "desktop_api",
    "teamyra_cli",
    "worker_registry",
    "runtime_paths",
    "task_graph",
    "test_policy",
    "review_cycle",
    "worktree_manager",
    "observability",
    "project_memory",
    "handoff_store",
    "mcp_pool",
    "recovery",
    "http_mcp",
    "wake_gateway",
    "follow",
]

datas = []
config = BRIDGE / "config.json"
if config.exists():
    datas.append((str(config), "."))

a = Analysis(
    [str(BRIDGE / "teamyra_entry.py")],
    pathex=[str(BRIDGE)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="teamyra-core",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    version=str(ROOT / "scripts" / "windows" / "teamyra-core-version.txt"),
    icon=str(ROOT / "apps" / "desktop" / "assets" / "teamyra-icon.ico"),
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="teamyra-core",
)

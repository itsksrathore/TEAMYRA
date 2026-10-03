"""Single executable entrypoint for packaged TEAMYRA Core."""
import sys


def _run_internal(mode, argv):
    sys.argv = [mode, *argv]
    if mode == "__runner":
        import runner
        return runner.main()
    if mode == "__conductor-monitor":
        import conductor_monitor
        return conductor_monitor.main()
    if mode == "__review-monitor":
        import review_monitor
        return review_monitor.main()
    if mode == "__failover-monitor":
        import failover_monitor
        return failover_monitor.main()
    if mode == "__desktop-api":
        import desktop_api
        return desktop_api.main()
    raise SystemExit(f"unknown internal mode: {mode}")


def main():
    if len(sys.argv) > 1 and sys.argv[1].startswith("__"):
        return _run_internal(sys.argv[1], sys.argv[2:])
    import teamyra_cli
    return teamyra_cli.main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main() or 0)

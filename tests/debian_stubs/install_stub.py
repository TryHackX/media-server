"""Stand-in for ``scripts/install.py --config-only`` in the Debian installer's tests.

The real installer refuses folders that do not exist, and on the machine the
tests run on ``/srv/media/...`` exists only inside the directory that stands for
``/``. Everything else is the real thing: the arguments are parsed by the real
parser and the file is produced by the real ``_build_config`` and written by the
real ``_write_private_config`` — so what the Debian installer goes on to edit is
a configuration exactly as a real installation has it.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    spec = importlib.util.spec_from_file_location("tryhackx_install", PROJECT_ROOT / "scripts" / "install.py")
    assert spec is not None and spec.loader is not None
    install = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(install)

    # `--root id=/srv/x`: the real parser insists on a path that is absolute *here*.
    arguments, roots = [], {}
    pending = iter(sys.argv[1:])
    for argument in pending:
        if argument == "--root":
            identifier, _separator, path = next(pending).partition("=")
            roots[identifier] = path
        else:
            arguments.append(argument)
    args = install._parser().parse_args(arguments)
    password = os.environ.get("MEDIA_SERVER_DB_PASSWORD", "")
    if not args.config_only or not password or not roots:
        print("install_stub: expected --config-only, a password in the environment and at least one --root",
              file=sys.stderr)
        return 1
    config = Path(args.config)
    if config.exists():
        print(f"Konfiguracja już istnieje i nie zostanie nadpisana: {config}")
        return 0
    config.parent.mkdir(parents=True, exist_ok=True)
    text = install._build_config(
        args, {key: Path(value) for key, value in roots.items()}, password,
        install.PROJECT_ROOT / "runtime" / "thumbnails", install.PROJECT_ROOT / "runtime" / "subtitles",
    )
    # A folder is stored the way Debian spells it, whatever the test machine makes of a path.
    for identifier, path in roots.items():
        text = text.replace(f"path = {install._toml_string(str(Path(path)))}", f"path = {install._toml_string(path)}")
    install._write_private_config(config, text)
    print(f"Utworzenie prywatnej konfiguracji: {config}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

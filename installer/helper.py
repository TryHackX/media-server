#!/usr/bin/env python3
"""Entry point of the wizard's helper: ``python -I -X utf8 installer\\helper.py <command>``.

Isolated mode (``-I``) keeps the script's own directory off ``sys.path``, so the
package next to this file is named explicitly — and nothing else is added.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from setup_helper.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())

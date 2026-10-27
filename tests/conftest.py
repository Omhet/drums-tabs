"""Slow tests (``@pytest.mark.slow``) run only when asked for: ``-m slow`` or ``DRUMS_SLOW=1``."""

import os

import pytest


def pytest_collection_modifyitems(config, items):
    if "slow" in (config.getoption("-m") or "") or os.environ.get("DRUMS_SLOW"):
        return
    skip = pytest.mark.skip(reason="slow: run with -m slow or DRUMS_SLOW=1")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)

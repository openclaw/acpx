#!/usr/bin/env python3
"""Run the vendored Autoreview unit tests without importing unrelated skills."""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import sys
import types
import unittest
from collections.abc import Iterator
from pathlib import Path


TEST_PACKAGE = "_acpx_autoreview_tests"


def require_origin(module: types.ModuleType, path: Path) -> None:
    origin = getattr(module, "__file__", None)
    if origin is None or Path(origin).resolve() != path.resolve():
        raise RuntimeError(f"test module {module.__name__} did not load from {path}")


def test_cases(suite: unittest.TestSuite) -> Iterator[unittest.TestCase]:
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from test_cases(test)
        else:
            yield test


def build_suite(vendor: Path) -> unittest.TestSuite:
    directory = vendor / "tests"
    paths = sorted(directory.glob("test_*.py"))
    if not paths:
        raise RuntimeError(f"no Autoreview test modules found in {directory}")

    # A private package keeps relative imports inside the vendored test tree.
    package = types.ModuleType(TEST_PACKAGE)
    package.__path__ = [str(directory)]
    sys.modules[TEST_PACKAGE] = package
    loader = unittest.TestLoader()
    suites = []
    for path in paths:
        module = importlib.import_module(f"{TEST_PACKAGE}.{path.stem}")
        require_origin(module, path)
        suites.append(loader.loadTestsFromModule(module))

    core_path = vendor / "scripts" / "autoreview_test.py"
    spec = importlib.util.spec_from_file_location("_acpx_autoreview_core", core_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load Autoreview core tests from {core_path}")
    core = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = core
    spec.loader.exec_module(core)
    require_origin(core, core_path)
    suites.append(loader.loadTestsFromModule(core))

    if loader.errors:
        raise RuntimeError("; ".join(loader.errors))
    suite = unittest.TestSuite(suites)
    identifiers = [test.id() for test in test_cases(suite)]
    if not identifiers or len(identifiers) != len(set(identifiers)):
        raise RuntimeError("Autoreview discovery returned empty or duplicate test IDs")
    print(f"Autoreview: {len(paths) + 1} modules, {len(identifiers)} tests", flush=True)
    return suite


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()
    vendor = Path(__file__).resolve().parent.parent / ".agents" / "skills" / "autoreview"
    try:
        suite = build_suite(vendor)
    except (Exception, SystemExit) as exc:
        print(f"Autoreview test discovery failed: {exc}", file=sys.stderr)
        return 1
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())

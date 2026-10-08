"""Run backend regression tests in a subprocess without local settings or provider access.

Usage: python -B -m backend.test_isolated [unittest test names ...]
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path


CHILD = r'''
import pathlib
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
exists = pathlib.Path.exists
read_text = pathlib.Path.read_text

def safe_read(path, *args, **kwargs):
    if path.name == ".env":
        raise AssertionError("Tests must not read local .env files")
    return read_text(path, *args, **kwargs)

with mock.patch.object(pathlib.Path, "exists", lambda path: False if path.name == ".env" else exists(path)), \
     mock.patch.object(pathlib.Path, "read_text", safe_read), \
     mock.patch("urllib.request.urlopen", side_effect=AssertionError("External requests are disabled in backend tests")):
    from backend import server
    server.SERPAPI_ARCHIVE_DIR = server.CONFIG.database_path.parent / "archive"
    try:
        suite = unittest.defaultTestLoader.loadTestsFromNames(sys.argv[1:])
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        server.CACHE.close()
    sys.exit(0 if result.wasSuccessful() else 1)
'''


def main() -> int:
    names = sys.argv[1:] or ["backend.test_server", "backend.test_agent_studio", "backend.test_agent_web", "backend.test_agent_population", "backend.test_agent_map_actions", "backend.test_map_geometry", "backend.test_web_sources", "backend.test_raster_sources"]
    with tempfile.TemporaryDirectory(prefix="meridian-backend-tests-") as directory:
        environment = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP") if key in os.environ}
        environment.update({
            "PYTHONDONTWRITEBYTECODE": "1",
            "DATABASE_PATH": str(Path(directory) / "isolated.db"),
            "HOST": "127.0.0.1",
            "ALLOWED_ORIGINS": "*",
            "OPENAI_API_KEY": "",
            "OPENAI_BASE_URL": "",
            "MODEL_NAME": "",
            "SERP_API_KEY": "",
        })
        return subprocess.run([sys.executable, "-B", "-c", CHILD, *names], env=environment, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())

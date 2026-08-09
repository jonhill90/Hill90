import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SUPERVISOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPERVISOR_DIR))

from transport import TmuxTransport  # noqa: E402


class TransportTest(unittest.TestCase):
    def test_tmux_calls_have_a_bounded_timeout(self):
        with patch("transport.subprocess.run", return_value=subprocess.CompletedProcess([], 0, stdout="", stderr="")) as run:
            TmuxTransport("/opt/homebrew/bin/tmux").capture("%19")
        self.assertEqual(10, run.call_args.kwargs["timeout"])


if __name__ == "__main__":
    unittest.main()

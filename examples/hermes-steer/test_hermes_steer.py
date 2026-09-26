"""No Hermes install, model credentials, or network beyond loopback required."""

import http.client
import importlib.util
import json
import os
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("hermes_steer.py")
SPEC = importlib.util.spec_from_file_location("hermes_steer", SCRIPT)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class Runtime:
    def __init__(self):
        self.messages = []
        self.accept = True

    def redirect(self, text):
        if self.accept:
            self.messages.append(text)
        return self.accept

    def prompt(self, *_args, **_kwargs):
        raise AssertionError("Steering must never start or queue a prompt")


class StartupTest(unittest.TestCase):
    def startup_events(self, platform, has_warmup):
        events = []
        entry = SimpleNamespace(__file__=str(SCRIPT), _setup_logging=lambda: None,
                                _load_env=lambda: events.append("env"))
        if has_warmup:
            entry._warm_memory_provider_import = lambda _logger: events.append("warmup")
        modules = {
            "acp_adapter": SimpleNamespace(entry=entry),
            "acp_adapter.server": SimpleNamespace(HermesACPAgent=lambda: object()),
            "acp": SimpleNamespace(run_agent=lambda *_a, **_kw: events.append("acp-reader")),
            "hermes_cli.mcp_startup": SimpleNamespace(
                start_background_mcp_discovery=lambda **_kw: events.append("mcp")),
        }

        @contextmanager
        def control(*_args):
            events.append("control")
            yield

        with (patch.dict(sys.modules, modules), patch.object(sys, "platform", platform),
              patch.object(sys, "path", list(sys.path)),
              patch.dict(os.environ, {"HERMES_ACP_SKIP_CONFIGURED_MCP": "0"}),
              patch.object(bridge, "start_control_server", control),
              patch.object(bridge.asyncio, "run", lambda result: result)):
            bridge.run_agent("unused")
        return events

    def test_windows_warms_provider_before_background_threads(self):
        self.assertEqual(self.startup_events("win32", True),
                         ["env", "warmup", "mcp", "control", "acp-reader"])

    def test_older_windows_and_posix_start_without_warmup(self):
        for platform, has_warmup in (("win32", False), ("linux", True)):
            with self.subTest(platform=platform):
                self.assertEqual(self.startup_events(platform, has_warmup),
                                 ["env", "mcp", "control", "acp-reader"])


class SteeringTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.runtime = Runtime()
        self.state = SimpleNamespace(runtime_lock=threading.RLock(), is_running=True,
                                     cancel_event=threading.Event(), agent=self.runtime, cwd="/repo")
        manager = SimpleNamespace(_lock=threading.RLock(), _sessions={"session-a": self.state})
        self.agent = SimpleNamespace(session_manager=manager)
        self.server = bridge.start_control_server(self.agent, self.temporary.name)
        self.addCleanup(self.server.close)

    def request(self, message="focus on replay", session="session-a"):
        return bridge.control_request(self.server.descriptor, "/steer",
                                      {"session_id": session, "message": message})

    def cli(self, *args, env=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args,
                               "--control-dir", self.temporary.name],
                              text=True, encoding="utf-8", capture_output=True, timeout=10, env=env)

    def assert_rejected(self, code, **kwargs):
        with self.assertRaises(bridge.ControlError) as caught:
            self.request(**kwargs)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.runtime.messages, [])

    def test_cli_list_and_steer_keep_original_turn(self):
        listed = self.cli("list")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        result = json.loads(listed.stdout)
        self.assertEqual(result["owners"][0]["sessions"][0]["session_id"], "session-a")
        self.assertNotIn(self.server.token, listed.stdout + listed.stderr)
        sent = self.cli("steer", "--owner", self.server.owner, "--session-id", "session-a",
                        "--message", "只看验证码重放")
        self.assertEqual(sent.returncode, 0, sent.stderr)
        self.assertTrue(json.loads(sent.stdout)["accepted"])
        self.assertEqual(self.runtime.messages, ["只看验证码重放"])
        self.assertTrue(self.state.is_running)

    def test_cli_file_and_rejection_exit_status(self):
        message_file = Path(self.temporary.name) / "message.txt"
        message_file.write_text("limit scope\nkeep evidence", encoding="utf-8")
        sent = self.cli("steer", "--owner", self.server.owner, "--session-id", "session-a",
                        "--file", str(message_file))
        self.assertEqual(sent.returncode, 0, sent.stderr)
        self.assertEqual(self.runtime.messages, ["limit scope\nkeep evidence"])
        self.state.is_running = False
        rejected = self.cli("steer", "--owner", self.server.owner, "--session-id", "session-a",
                            "--message", "too late")
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(json.loads(rejected.stderr)["error"], "idle")
        self.assertEqual(len(self.runtime.messages), 1)

    def test_cli_json_survives_ascii_stdout_with_unicode_cwd(self):
        self.state.cwd = "C:/工作/🦊"
        result = self.cli("list", env={**os.environ, "PYTHONIOENCODING": "ascii"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.isascii())
        session = json.loads(result.stdout)["owners"][0]["sessions"][0]
        self.assertEqual(session["cwd"], self.state.cwd)

    def test_list_reads_complete_response_larger_than_request_limit(self):
        self.state.cwd = "/repo/" + "x" * 240
        self.agent.session_manager._sessions = {
            "session-" + str(index): self.state for index in range(300)
        }
        listed = self.cli("list")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        result = json.loads(listed.stdout)
        self.assertEqual(result["unavailable"], [])
        self.assertEqual(len(result["owners"][0]["sessions"]), 300)
        self.assertGreater(len(listed.stdout), bridge.MAX_BODY)

    def test_reused_port_does_not_produce_false_control_results(self):
        reply = [200, []]

        class UnrelatedService(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(reply[1]).encode()
                self.send_response(reply[0])
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_POST = do_GET

            def log_message(self, *_args):
                pass

        unrelated = ThreadingHTTPServer(("127.0.0.1", 0), UnrelatedService)
        thread = threading.Thread(target=unrelated.serve_forever, daemon=True)
        thread.start()
        descriptor = {**self.server.descriptor, "port": unrelated.server_port}
        self.server.descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")
        try:
            for status, body in (
                (200, []), (403, []), (200, {"owner": "wrong", "sessions": []}),
                (200, {"owner": self.server.owner, "sessions": "wrong"}),
                (200, {"owner": self.server.owner, "sessions": [{"session_id": "s"}]}),
            ):
                with self.subTest(status=status, body=body):
                    reply[:] = [status, body]
                    listed = self.cli("list")
                    self.assertEqual(listed.returncode, 0, listed.stderr)
                    self.assertEqual(json.loads(listed.stdout),
                                     {"owners": [], "unavailable": [self.server.owner]})
            reply[:] = [200, {"accepted": True, "session_id": "another-session"}]
            steered = self.cli("steer", "--owner", self.server.owner,
                               "--session-id", "session-a", "--message", "guidance")
            self.assertEqual(steered.returncode, 1)
            self.assertEqual(json.loads(steered.stderr)["error"], "unavailable")
        finally:
            unrelated.shutdown()
            unrelated.server_close()
            thread.join()

    def test_idle_never_becomes_a_new_prompt(self):
        self.state.is_running = False
        self.assert_rejected("idle")

    def test_cancelled_turn_rejected(self):
        self.state.cancel_event.set()
        self.assert_rejected("cancelled")

    def test_late_runtime_rejection_is_not_reported_as_accepted(self):
        self.runtime.accept = False
        self.assert_rejected("not_accepted")

    def test_unknown_session_never_restored(self):
        self.assert_rejected("unknown_session", session="not-loaded")
        self.assertEqual(list(self.agent.session_manager._sessions), ["session-a"])

    def test_unsupported_runtime_rejected(self):
        self.state.agent = object()
        self.assert_rejected("unsupported")

    def test_cancellation_and_redirect_share_runtime_lock(self):
        outcome = []
        started = threading.Event()

        def send():
            started.set()
            try:
                self.request()
            except bridge.ControlError as exc:
                outcome.append(exc.code)

        with self.state.runtime_lock:
            thread = threading.Thread(target=send)
            thread.start()
            self.assertTrue(started.wait(2))
            self.state.cancel_event.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(outcome, ["cancelled"])
        self.assertEqual(self.runtime.messages, [])

    def test_auth_and_body_validation(self):
        for token, body, expected in (("wrong", b"{}", 401),
                                      (self.server.token, b"not json", 400),
                                      (self.server.token, b"[]", 400),
                                      (self.server.token, b"x" * (bridge.MAX_BODY + 1), 400)):
            with self.subTest(expected=expected, body_length=len(body)):
                connection = http.client.HTTPConnection("127.0.0.1", self.server.descriptor["port"])
                try:
                    connection.request("POST", "/steer", body,
                                       {"Authorization": "Bearer " + token})
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                finally:
                    connection.close()
        self.assertEqual(self.runtime.messages, [])
        self.assert_rejected("invalid_body", message=" ")

    def test_owner_isolation_and_cleanup(self):
        with bridge.start_control_server(self.agent, self.temporary.name) as other:
            self.assertNotEqual(other.owner, self.server.owner)
            self.assertNotEqual(other.token, self.server.token)
            self.assertEqual(len(bridge.list_owners(self.temporary.name)["owners"]), 2)
            dead_descriptor = dict(other.descriptor)
            dead_path = other.descriptor_path
        self.assertFalse(dead_path.exists())
        self.assertTrue(self.server.descriptor_path.exists())
        # A killed process can leave its descriptor; discovery reports it, without restart.
        dead_path.write_text(json.dumps(dead_descriptor), encoding="utf-8")
        listed = bridge.list_owners(self.temporary.name)
        self.assertEqual(listed["unavailable"], [other.owner])
        self.assertEqual(len(listed["owners"]), 1)

    def test_owner_path_cannot_escape_control_directory(self):
        with self.assertRaises(ValueError):
            bridge.read_descriptor(self.temporary.name, "../outside")

    @unittest.skipIf(os.name == "nt", "Windows uses inherited directory ACLs")
    def test_descriptor_is_private_on_posix(self):
        self.assertEqual(self.server.descriptor_path.stat().st_mode & 0o077, 0)


if __name__ == "__main__":
    unittest.main()

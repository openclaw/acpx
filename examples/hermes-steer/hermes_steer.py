"""Optional Hermes ACP launcher with a local, active-turn-only control channel."""

import argparse
import asyncio
import hmac
import http.client
import json
import logging
import os
from pathlib import Path
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MAX_BODY = 64 * 1024


class ControlError(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code = code
        self.status = status


def redirect_active_session(agent, session_id, message):
    """Never restore a session, enqueue a prompt, or start another turn."""
    manager = agent.session_manager
    with manager._lock:
        state = manager._sessions.get(session_id)
    if state is None:
        raise ControlError("unknown_session", "Session is not loaded in this owner")
    with state.runtime_lock:
        if not state.is_running:
            raise ControlError("idle", "Session has no active turn")
        if state.cancel_event and state.cancel_event.is_set():
            raise ControlError("cancelled", "The active turn is being cancelled")
        redirect = getattr(state.agent, "redirect", None)
        if not callable(redirect):
            raise ControlError("unsupported", "This Hermes runtime has no redirect API")
        if not redirect(message):
            raise ControlError("not_accepted", "The active turn no longer accepts guidance")
    # Acceptance is not proof of consumption: cancellation may still win later.
    return {"accepted": True, "session_id": session_id}


def live_sessions(agent):
    manager = agent.session_manager
    with manager._lock:
        sessions = list(manager._sessions.items())
    result = []
    for session_id, state in sessions:
        with state.runtime_lock:
            result.append({"session_id": session_id, "cwd": state.cwd,
                           "running": state.is_running})
    return result


class ControlServer:
    """A per-launcher endpoint. Its descriptor contains a secret, never a log entry."""

    def __init__(self, agent, control_dir):
        self.owner = secrets.token_hex(16)
        self.token = secrets.token_hex(32)
        control_dir = Path(control_dir).resolve()
        control_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.descriptor_path = control_dir / (self.owner + ".json")
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(5)

            def log_message(self, *_args):
                pass

            def reply(self, status, payload):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def authorized(self):
                actual = self.headers.get("Authorization", "")
                expected = "Bearer " + owner.token
                if not hmac.compare_digest(actual.encode(), expected.encode()):
                    self.reply(401, {"error": "unauthorized"})
                    return False
                return True

            def do_GET(self):
                if not self.authorized():
                    return
                if self.path != "/sessions":
                    self.reply(404, {"error": "not_found"})
                    return
                self.reply(200, {"owner": owner.owner, "sessions": live_sessions(agent)})

            def do_POST(self):
                if not self.authorized():
                    return
                if self.path != "/steer":
                    self.reply(404, {"error": "not_found"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_BODY:
                        raise ControlError("invalid_body", "Body must be 1..65536 bytes", 400)
                    request = json.loads(self.rfile.read(length))
                    if not isinstance(request, dict):
                        raise ValueError("Expected a JSON object")
                    session_id, message = request.get("session_id"), request.get("message")
                    if not isinstance(session_id, str) or not session_id.strip():
                        raise ValueError("session_id must be nonempty text")
                    if not isinstance(message, str) or not message.strip():
                        raise ValueError("message must be nonempty text")
                    result = redirect_active_session(agent, session_id, message)
                except ControlError as exc:
                    self.reply(exc.status, {"error": exc.code, "message": str(exc)})
                except (ValueError, UnicodeError):
                    self.reply(400, {"error": "invalid_body"})
                except Exception:
                    logging.exception("Hermes steering control failed")
                    self.reply(500, {"error": "control_failed"})
                else:
                    self.reply(200, result)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.descriptor = {"owner": self.owner, "port": self.server.server_port,
                           "token": self.token}
        temporary = self.descriptor_path.with_suffix(".tmp")
        try:
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(self.descriptor, stream)
            os.replace(temporary, self.descriptor_path)
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
        except BaseException:
            self.server.server_close()
            temporary.unlink(missing_ok=True)
            self.descriptor_path.unlink(missing_ok=True)
            raise

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.descriptor_path.unlink(missing_ok=True)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def start_control_server(agent, control_dir):
    return ControlServer(agent, control_dir)


def read_descriptor(control_dir, owner):
    if len(owner) != 32 or any(c not in "0123456789abcdef" for c in owner):
        raise ValueError("owner must be an ID returned by list")
    descriptor = json.loads((Path(control_dir) / (owner + ".json")).read_text(encoding="utf-8"))
    if (not isinstance(descriptor, dict) or descriptor.get("owner") != owner
            or type(descriptor.get("port")) is not int or not 0 < descriptor["port"] < 65536
            or not isinstance(descriptor.get("token"), str)):
        raise ValueError("Invalid owner descriptor")
    return descriptor


def control_request(descriptor, path, payload=None):
    # http.client avoids proxies and redirects: credentials stay on loopback.
    connection = http.client.HTTPConnection("127.0.0.1", descriptor["port"], timeout=5)
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    if body is not None and len(body) > MAX_BODY:
        raise ValueError("Message exceeds the 65536-byte request limit")
    try:
        connection.request("GET" if body is None else "POST", path, body=body,
                           headers={"Authorization": "Bearer " + descriptor["token"],
                                    "Content-Type": "application/json"})
        response = connection.getresponse()
        # The request cap must not truncate a valid multi-session listing.
        result = json.loads(response.read())
        if not isinstance(result, dict):
            raise ValueError("Expected a control response object")
        if response.status != 200:
            raise ControlError(result.get("error", "request_failed"),
                               result.get("message", "Control request rejected"), response.status)
        if path == "/sessions":
            sessions = result.get("sessions")
            if (result.get("owner") != descriptor["owner"] or not isinstance(sessions, list)
                    or any(not isinstance(session, dict)
                           or not isinstance(session.get("session_id"), str)
                           or not isinstance(session.get("cwd"), str)
                           or type(session.get("running")) is not bool for session in sessions)):
                raise ValueError("Unexpected owner/session response")
        elif path == "/steer" and (result.get("accepted") is not True
                                  or result.get("session_id") != payload["session_id"]):
            raise ValueError("Unexpected steering response")
        return result
    finally:
        connection.close()


def list_owners(control_dir):
    owners, unavailable = [], []
    for path in sorted(Path(control_dir).glob("*.json")):
        try:
            owners.append(control_request(read_descriptor(control_dir, path.stem), "/sessions"))
        except (OSError, ValueError, ControlError, http.client.HTTPException):
            unavailable.append(path.stem)
    return {"owners": owners, "unavailable": unavailable}


def run_agent(control_dir):
    try:
        # The official entry import applies Hermes' Windows stdio/import bootstrap.
        from acp_adapter import entry
    except ImportError as exc:
        raise RuntimeError("Run with the Python interpreter where Hermes and its ACP extra are installed") from exc
    entry._setup_logging()
    entry._load_env()
    project_root = str(Path(entry.__file__).resolve().parent.parent)
    if project_root not in sys.path:
        sys.path.insert(0, project_root)
    try:
        import acp
        from acp_adapter.server import HermesACPAgent
    except ImportError as exc:
        raise RuntimeError("Install Hermes' ACP dependencies in this Python interpreter") from exc
    # Match newer Hermes startup; older revisions have no memory warm-up hook.
    warm_memory = getattr(entry, "_warm_memory_provider_import", None)
    if sys.platform == "win32" and callable(warm_memory):
        warm_memory(logging.getLogger(__name__))
    if os.environ.get("HERMES_ACP_SKIP_CONFIGURED_MCP", "").strip() != "1":
        try:
            from hermes_cli.mcp_startup import start_background_mcp_discovery
            start_background_mcp_discovery(logger=logging.getLogger(__name__),
                                           thread_name="acp-mcp-discovery")
        except Exception:
            logging.debug("MCP tool discovery failed at ACP startup", exc_info=True)
    agent = HermesACPAgent()
    with start_control_server(agent, control_dir):
        asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("run", "list", "steer"):
        child = commands.add_parser(command)
        child.add_argument("--control-dir", required=True, type=Path)
        if command == "steer":
            child.add_argument("--owner", required=True)
            child.add_argument("--session-id", required=True)
            message = child.add_mutually_exclusive_group(required=True)
            message.add_argument("--message")
            message.add_argument("--file", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "run":
            run_agent(args.control_dir)
            return 0
        if args.command == "list":
            result = list_owners(args.control_dir)
        else:
            message = args.file.read_text(encoding="utf-8") if args.file else args.message
            result = control_request(read_descriptor(args.control_dir, args.owner), "/steer",
                                     {"session_id": args.session_id, "message": message})
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, RuntimeError, ControlError, http.client.HTTPException) as exc:
        print(json.dumps({"error": getattr(exc, "code", "unavailable"), "message": str(exc)}),
              file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())

"""Loopback peer + Host + Origin checks; no forwarded identity or arbitrary process input."""
import hmac
import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader
from starlette.requests import HTTPConnection


@dataclass(frozen=True)
class ApiSettings:
    control_token: str | None = field(default=None, repr=False)
    experiments_enabled: bool = False
    monitor_enabled: bool = True
    poll_seconds: float = 1.0
    observation_timeout: float = 0.3
    origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173",
                               "http://127.0.0.1:8000", "http://localhost:8000")
    artifact_directory: Path = Path("data/measured/stage5")
    persistence_enabled: bool = True
    database_path: Path | None = None

    def __post_init__(self):
        if self.control_token is not None and len(self.control_token) < 32:
            raise ValueError("EXIT_LINK_CONTROL_TOKEN must have at least 32 characters")
        if self.experiments_enabled and not self.control_token:
            raise ValueError("Experiment controls require EXIT_LINK_CONTROL_TOKEN")
        if not 0.1 <= self.poll_seconds <= 60 or not 0.05 <= self.observation_timeout <= 5:
            raise ValueError("Invalid monitor timing")
        for origin in self.origins:
            url = urlsplit(origin)
            if url.scheme != "http" or url.hostname not in {"localhost", "127.0.0.1", "::1"} or url.path or url.query or url.fragment or url.username:
                raise ValueError("Only explicit HTTP loopback origins are allowed")

    @classmethod
    def from_env(cls):
        return cls(control_token=os.environ.get("EXIT_LINK_CONTROL_TOKEN"),
                   experiments_enabled=os.environ.get("EXIT_LINK_ENABLE_EXPERIMENTS") == "1",
                   artifact_directory=Path(os.environ.get("EXIT_LINK_STAGE5_ARTIFACT_DIR", "data/measured/stage5")),
                   persistence_enabled=os.environ.get("EXIT_LINK_PERSISTENCE_ENABLED", "1") != "0",
                   database_path=Path(os.environ["EXIT_LINK_DATABASE_PATH"]) if os.environ.get("EXIT_LINK_DATABASE_PATH") else None)


def fail(code, message, status=400):
    raise HTTPException(status, detail={"code": code, "message": message})


def local_connection(connection: HTTPConnection):
    settings = connection.app.state.backend.settings
    try:
        local = connection.client is not None and ipaddress.ip_address(connection.client.host).is_loopback
        authority = urlsplit("http://" + connection.headers.get("host", ""))
        host = authority.hostname
        if authority.username or authority.password or authority.path or authority.query or authority.fragment:
            host = None
        authority.port  # Reject malformed/non-numeric ports.
    except ValueError:
        local, host = False, None
    origin = connection.headers.get("origin")
    if not local or host not in {"localhost", "127.0.0.1", "::1"}:
        return False
    return origin is None or origin in settings.origins


async def require_local(connection: HTTPConnection):
    if not local_connection(connection):
        fail("local_only", "Loopback peer, local Host and allowed Origin are required", 403)


token_header = APIKeyHeader(name="X-Exit-Link-Token", auto_error=False)


async def require_write(connection: HTTPConnection, token: str | None = Security(token_header)):
    await require_local(connection)
    expected = connection.app.state.backend.settings.control_token
    if expected is None or token is None or not hmac.compare_digest(token.encode(), expected.encode()):
        fail("write_unauthorized", "A configured control token is required for mutations", 403)

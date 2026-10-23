"""One request/response per TCP connection; uint32 BE length + UTF-8 JSON."""
import asyncio
import json
import struct
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from exit_link.fault_detection.models import Advertisement
from exit_link.evacuation.models import Guidance, GuidanceReceipt

MAX_FRAME_BYTES = 65536


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Message(WireModel):
    type: Literal["data"] = "data"
    message_id: UUID = Field(default_factory=uuid4)
    source: str = Field(min_length=1, max_length=64)
    destination: str = Field(min_length=1, max_length=64)
    timestamp: AwareDatetime = Field(default_factory=utc_now)
    payload: str = Field(min_length=1, max_length=4096)
    ttl: int = Field(default=16, ge=0, le=64, strict=True)
    route: list[str] = Field(min_length=2, max_length=64)
    hop_index: int = Field(default=0, ge=0, strict=True)
    from_node: str | None = None

    @model_validator(mode="after")
    def validate_route(self):
        if self.route[0] != self.source or self.route[-1] != self.destination:
            raise ValueError("Route endpoints must match source/destination")
        if len(set(self.route)) != len(self.route):
            raise ValueError("Route must not repeat nodes")
        if self.hop_index >= len(self.route):
            raise ValueError("Invalid hop index")
        expected = self.route[self.hop_index - 1] if self.hop_index else None
        if self.from_node != expected:
            raise ValueError("Sender must match the previous route hop")
        return self


class Ack(WireModel):
    type: Literal["ack"] = "ack"
    message_id: UUID
    source: str
    destination: str
    timestamp: AwareDatetime = Field(default_factory=utc_now)
    route: list[str]
    duplicate: bool = False


class ErrorResponse(WireModel):
    type: Literal["error"] = "error"
    message_id: UUID | None = None
    node: str
    code: str
    detail: str


class Shutdown(WireModel):
    type: Literal["shutdown"] = "shutdown"


class Stopped(WireModel):
    type: Literal["stopped"] = "stopped"
    node: str


class Heartbeat(WireModel):
    type: Literal["heartbeat"] = "heartbeat"
    source: str
    destination: str
    probe_id: UUID = Field(default_factory=uuid4)
    advertisements: list[Advertisement] = Field(default_factory=list, max_length=6)


class HeartbeatReply(WireModel):
    type: Literal["heartbeat_reply"] = "heartbeat_reply"
    source: str
    destination: str
    probe_id: UUID
    advertisements: list[Advertisement] = Field(default_factory=list, max_length=6)


class StatusRequest(WireModel):
    type: Literal["status"] = "status"


class StatusResponse(WireModel):
    type: Literal["status_response"] = "status_response"
    node: str
    enabled: bool
    neighbors: dict = Field(default_factory=dict)
    advertisements: list[Advertisement] = Field(default_factory=list)


class ReliableSend(WireModel):
    type: Literal["reliable_send"] = "reliable_send"
    message_id: UUID = Field(default_factory=uuid4)
    source: str = Field(min_length=1, max_length=64)
    destination: str = Field(min_length=1, max_length=64)
    timestamp: AwareDatetime = Field(default_factory=utc_now)
    payload: str = Field(min_length=1, max_length=4096)
    ttl: int = Field(default=16, ge=0, le=64, strict=True)
    max_retries: int = Field(default=3, ge=0, le=6, strict=True)
    initial_route: list[str] | None = Field(default=None, min_length=2, max_length=64)

    @model_validator(mode="after")
    def distinct_endpoints(self):
        if self.source == self.destination:
            raise ValueError("Source and destination must differ")
        if self.initial_route is not None:
            Message(source=self.source, destination=self.destination, route=self.initial_route, payload=self.payload)
        return self


class Attempt(WireModel):
    number: int
    route: list[str]
    started_at: AwareDatetime
    duration_ms: float
    route_calculation_ms: float
    outcome: str


class DeliveryResult(WireModel):
    type: Literal["delivery_result"] = "delivery_result"
    message_id: UUID
    source: str
    destination: str
    success: bool
    ack: Ack | None = None
    error: ErrorResponse | None = None
    attempts: list[Attempt]
    retries: int
    ttl_remaining: int
    elapsed_ms: float
    route_calculation_ms: float
    recovery_after_first_failure_ms: float | None = None


class GuidanceQuery(WireModel):
    type: Literal["guidance_query"] = "guidance_query"
    message_id: UUID


class GuidanceReply(WireModel):
    type: Literal["guidance_reply"] = "guidance_reply"
    node: str
    queried_message_id: UUID
    receipt: GuidanceReceipt | None = None
    latest: Guidance | None = None


REQUEST = TypeAdapter(Annotated[Message | Shutdown | Heartbeat | StatusRequest | ReliableSend | GuidanceQuery, Field(discriminator="type")])
RESPONSE = TypeAdapter(Annotated[Ack | ErrorResponse | Stopped | HeartbeatReply | StatusResponse | DeliveryResult | GuidanceReply, Field(discriminator="type")])


class ProtocolError(Exception):
    pass


class ConnectionFailed(OSError):
    """No TCP session was established; distinct from a response timeout."""

    def __init__(self, host: str, port: int, cause: OSError):
        self.host, self.port = host, port
        self.reason = "connect_timeout" if isinstance(cause, TimeoutError) else "connect_error"
        self.cause_errno = cause.errno
        self.cause_winerror = getattr(cause, "winerror", None)
        super().__init__(f"TCP connect to {host}:{port} failed ({self.reason})")


def encode_frame(value: WireModel | dict) -> bytes:
    data = value.model_dump(mode="json") if isinstance(value, WireModel) else value
    body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if not 0 < len(body) <= MAX_FRAME_BYTES:
        raise ProtocolError("Frame length outside 1..65536 bytes")
    return struct.pack("!I", len(body)) + body


async def read_frame(reader: asyncio.StreamReader, timeout: float) -> dict:
    async def read():
        size = struct.unpack("!I", await reader.readexactly(4))[0]
        if not 0 < size <= MAX_FRAME_BYTES:
            raise ProtocolError("Frame length outside 1..65536 bytes")
        body = await reader.readexactly(size)
        try:
            value = json.loads(body.decode("utf-8"))
        except (UnicodeError, ValueError, RecursionError) as exc:
            raise ProtocolError("Invalid UTF-8 JSON") from exc
        if not isinstance(value, dict):
            raise ProtocolError("Frame body must be a JSON object")
        return value

    try:
        return await asyncio.wait_for(read(), timeout)
    except asyncio.IncompleteReadError as exc:
        raise ProtocolError("Truncated frame") from exc


async def write_frame(writer: asyncio.StreamWriter, value: WireModel, timeout: float) -> None:
    writer.write(encode_frame(value))
    await asyncio.wait_for(writer.drain(), timeout)


async def close_writer(writer: asyncio.StreamWriter) -> None:
    writer.close()
    try:
        await asyncio.wait_for(writer.wait_closed(), 1)
    except (OSError, TimeoutError):
        pass


async def exchange(host: str, port: int, request: WireModel, timeout: float = 5,
                   on_sent: Callable[[], None] | None = None):
    if host != "127.0.0.1":
        raise ValueError("Only IPv4 loopback is supported")
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    except OSError as exc:
        # Includes TimeoutError from wait_for. Only connection establishment is
        # translated; timeouts after this point remain genuine I/O timeouts.
        raise ConnectionFailed(host, port, exc) from exc
    try:
        await write_frame(writer, request, timeout)
        if on_sent is not None:
            on_sent()
        return RESPONSE.validate_python(await read_frame(reader, timeout))
    finally:
        await close_writer(writer)

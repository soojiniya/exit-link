import asyncio
import struct

import pytest
from pydantic import ValidationError

from exit_link.communication.protocol import MAX_FRAME_BYTES, Message, ProtocolError, encode_frame, read_frame


def test_two_coalesced_frames_are_read_separately():
    async def check():
        reader = asyncio.StreamReader()
        reader.feed_data(encode_frame({"first": 1}) + encode_frame({"second": "대피 안내"}))
        reader.feed_eof()
        assert await read_frame(reader, 1) == {"first": 1}
        assert await read_frame(reader, 1) == {"second": "대피 안내"}
    asyncio.run(check())


@pytest.mark.parametrize("data", [struct.pack("!I", 0), struct.pack("!I", MAX_FRAME_BYTES + 1), b"\x00\x00", struct.pack("!I", 5) + b"{}"])
def test_invalid_or_truncated_frames(data):
    async def check():
        reader = asyncio.StreamReader()
        reader.feed_data(data)
        reader.feed_eof()
        with pytest.raises(ProtocolError):
            await read_frame(reader, 1)
    asyncio.run(check())


@pytest.mark.parametrize("changes", [
    {"ttl": -1}, {"ttl": True}, {"ttl": 65}, {"payload": ""},
    {"route": ["N1", "N2", "N1", "N4"]},
    {"timestamp": "2026-10-20T10:00:00"},
    {"hop_index": 1}, {"unknown": "field"},
])
def test_invalid_message_schema(changes):
    fields = dict(source="N1", destination="N4", route=["N1", "N2", "N4"], payload="test")
    fields.update(changes)
    with pytest.raises(ValidationError):
        Message(**fields)

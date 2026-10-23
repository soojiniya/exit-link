"""Bounded single-process live stream. Overflow requires reconnect + snapshot."""
import asyncio
from collections import deque
from uuid import uuid4

from exit_link.api.contracts import EventPage


class EventBus:
    def __init__(self, history_size=512, queue_size=128, max_clients=32):
        self.stream_id, self.sequence = uuid4(), 0
        self.history = deque(maxlen=history_size)
        self.clients = set()
        self.queue_size, self.max_clients = queue_size, max_clients

    def publish(self, model, payload):
        self.sequence += 1
        event = model(stream_id=self.stream_id, sequence=self.sequence, payload=payload.model_copy(deep=True))
        self.history.append(event)
        for queue in tuple(self.clients):
            if queue.full():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(None)
                self.clients.discard(queue)
            else:
                queue.put_nowait(event)
        return event

    def subscribe(self):
        if len(self.clients) >= self.max_clients:
            raise RuntimeError("WebSocket client limit reached")
        queue = asyncio.Queue(self.queue_size)
        self.clients.add(queue)
        return queue

    def replay(self, stream_id, after):
        oldest = self.history[0].sequence if self.history else self.sequence + 1
        reset = stream_id != self.stream_id or after > self.sequence or after < oldest - 1
        return EventPage(stream_id=self.stream_id, sequence=self.sequence, reset_required=reset,
                         events=[] if reset else [event for event in self.history if event.sequence > after])

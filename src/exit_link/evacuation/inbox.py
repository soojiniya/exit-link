"""Persistent latest-version guard; stale arrivals are ACKed but never applied."""
import hashlib
import json
import os
import tempfile
from collections import OrderedDict
from pathlib import Path

from exit_link.evacuation.models import Guidance, GuidanceReceipt, InboxState


def atomic_save(path, model):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(model.model_dump_json(indent=2))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def parse_guidance(message):
    try:
        raw = json.loads(message.payload)
    except (ValueError, RecursionError):
        return None  # Generic stage 2/3 text remains valid.
    if not isinstance(raw, dict) or raw.get("kind") != "exit_link.evacuation_guidance":
        return None
    guidance = Guidance.model_validate(raw)
    if guidance.guidance_id != message.message_id or guidance.source_node != message.source or guidance.destination_node != message.destination:
        raise ValueError("Guidance and transport identity mismatch")
    return guidance


class GuidanceInbox:
    def __init__(self, node_id, path=None):
        self.node_id, self.path = node_id, Path(path) if path is not None else None
        self.latest, self.receipts = {}, OrderedDict()
        if self.path is not None and self.path.exists():
            state = InboxState.model_validate_json(self.path.read_text(encoding="utf-8"))
            if state.node_id != node_id:
                raise ValueError("Guidance state belongs to another node")
            self.latest = {(item.scenario_id, item.audience_id): item for item in state.latest}
            self.receipts = OrderedDict((item.message_id, item) for item in state.receipts)
            if len(self.latest) != len(state.latest) or len(self.receipts) != len(state.receipts) or any(
                item.destination_node != node_id for item in state.latest
            ):
                raise ValueError("Duplicate or invalid guidance state")
            if any((item.scenario_id, item.audience_id) not in self.latest for item in state.receipts):
                raise ValueError("Receipt has no persistent guidance stream")

    def receive(self, guidance):
        if guidance.destination_node != self.node_id:
            raise ValueError("Guidance delivered to the wrong node")
        key = (guidance.scenario_id, guidance.audience_id)
        previous = self.latest.get(key)
        version = (guidance.scenario_revision, guidance.route_version)
        digest = hashlib.sha256(guidance.model_dump_json().encode()).hexdigest()
        existing_receipt = self.receipts.get(guidance.guidance_id)
        if existing_receipt is not None and existing_receipt.content_digest != digest:
            raise ValueError("Guidance ID reused with changed content")
        fields = {"building_id", "start_location", "source_node", "destination_node", "status", "path", "exit_id", "distance_m"}
        if previous is None:
            if len(self.latest) >= 1024:
                raise OSError("Guidance stream capacity reached; old version guards will not be evicted")
            disposition = "applied"
        elif previous.source_node != guidance.source_node:
            disposition = "publisher_conflict"
        elif previous.building_id != guidance.building_id or previous.start_location != guidance.start_location:
            disposition = "version_conflict"
        elif version < (previous.scenario_revision, previous.route_version):
            disposition = "stale"
        elif version == (previous.scenario_revision, previous.route_version):
            disposition = "duplicate" if guidance.model_dump(include=fields) == previous.model_dump(include=fields) else "version_conflict"
        else:
            disposition = "applied"
        latest = dict(self.latest)
        if disposition == "applied":
            latest[key] = guidance.model_copy(deep=True)
        current = latest[key]
        receipt = GuidanceReceipt(message_id=guidance.guidance_id, scenario_id=guidance.scenario_id,
            audience_id=guidance.audience_id, disposition=disposition,
            received_scenario_revision=guidance.scenario_revision, received_route_version=guidance.route_version,
            latest_scenario_revision=current.scenario_revision, latest_route_version=current.route_version,
            latest_guidance_id=current.guidance_id, content_digest=digest)
        receipts = OrderedDict(self.receipts)
        receipts[receipt.message_id] = receipt
        receipts.move_to_end(receipt.message_id)
        while len(receipts) > 512:
            receipts.popitem(last=False)
        if self.path is not None:
            atomic_save(self.path, InboxState(node_id=self.node_id, latest=list(latest.values()), receipts=list(receipts.values())))
        self.latest, self.receipts = latest, receipts
        return receipt.model_copy(deep=True)

    def query(self, message_id):
        receipt = self.receipts.get(message_id)
        latest = self.latest.get((receipt.scenario_id, receipt.audience_id)) if receipt else None
        return (receipt.model_copy(deep=True) if receipt else None, latest.model_copy(deep=True) if latest else None)

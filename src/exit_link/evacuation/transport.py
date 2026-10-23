"""Guidance is existing ReliableSend.payload JSON; ACK and application status differ."""
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, ValidationError, model_validator

from exit_link.communication.client import send_reliably
from exit_link.communication.protocol import DeliveryResult, GuidanceQuery, GuidanceReply, ProtocolError, ReliableSend, exchange
from exit_link.evacuation.models import Guidance, GuidanceReceipt, Model, now_utc


class GuidanceDelivery(Model):
    schema_version: Literal["1.0"] = "1.0"
    message_id: UUID
    scenario_id: UUID
    scenario_revision: int
    route_version: int
    audience_id: str
    source_node: str
    destination_node: str
    observed_at: AwareDatetime = Field(default_factory=now_utc)
    ack_received: bool
    transport_result: DeliveryResult | None = None
    transport_error: str | None = None
    application_receipt: GuidanceReceipt | None = None
    receipt_query_error: str | None = None
    disaster_origin: Literal["simulation"] = "simulation"
    observation_origin: Literal["real_tcp_observation"] = "real_tcp_observation"
    human_evacuation_verified: Literal[False] = False

    @model_validator(mode="after")
    def evidence_consistency(self):
        result = self.transport_result
        if self.ack_received != (result is not None and result.success):
            raise ValueError("ACK status must match actual transport result")
        if result is None and self.transport_error is None:
            raise ValueError("Missing transport observation")
        if result is not None and (result.message_id != self.message_id or result.source != self.source_node
                                   or result.destination != self.destination_node):
            raise ValueError("Transport result belongs to another guidance")
        if self.application_receipt is not None and (
            self.application_receipt.message_id != self.message_id or self.application_receipt.scenario_id != self.scenario_id
            or self.application_receipt.audience_id != self.audience_id
        ):
            raise ValueError("Application receipt belongs to another guidance")
        return self


async def query_guidance(topology, node_id, message_id, timeout=5):
    node = next((node for node in topology.nodes if node.id == node_id), None)
    if node is None:
        raise ValueError("Unknown guidance receiver")
    response = await exchange(node.host, node.port, GuidanceQuery(message_id=message_id), timeout)
    if not isinstance(response, GuidanceReply) or response.node != node_id or response.queried_message_id != message_id:
        raise ProtocolError("Guidance receipt correlation mismatch")
    if response.receipt is not None and response.receipt.message_id != message_id:
        raise ProtocolError("Received another message's guidance receipt")
    if response.receipt is not None and (response.latest is None
        or response.latest.scenario_id != response.receipt.scenario_id
        or response.latest.audience_id != response.receipt.audience_id or response.latest.destination_node != node_id):
        raise ProtocolError("Guidance latest state and receipt disagree")
    return response


async def send_guidance(topology, guidance: Guidance, ttl=16, max_retries=3, initial_route=None, timeout=30):
    known = {node.id for node in topology.nodes}
    if guidance.source_node not in known or guidance.destination_node not in known:
        raise ValueError("Guidance uses unknown communication node")
    request = ReliableSend(message_id=guidance.guidance_id, source=guidance.source_node,
        destination=guidance.destination_node, timestamp=guidance.issued_at, payload=guidance.model_dump_json(),
        ttl=ttl, max_retries=max_retries, initial_route=initial_route)
    fields = dict(message_id=guidance.guidance_id, scenario_id=guidance.scenario_id,
                  scenario_revision=guidance.scenario_revision, route_version=guidance.route_version,
                  audience_id=guidance.audience_id, source_node=guidance.source_node, destination_node=guidance.destination_node)
    try:
        result = await send_reliably(topology, request, timeout)
    except (OSError, ProtocolError, ValidationError) as exc:
        return GuidanceDelivery(**fields, ack_received=False, transport_error=type(exc).__name__ + ": " + str(exc))
    receipt, query_error = None, None
    if result.success:
        try:
            response = await query_guidance(topology, guidance.destination_node, guidance.guidance_id)
            receipt = response.receipt
            if receipt is not None and (receipt.scenario_id != guidance.scenario_id or receipt.audience_id != guidance.audience_id):
                receipt = None
                raise ProtocolError("Application receipt metadata mismatch")
            if receipt is None:
                query_error = "Receipt unavailable; application disposition is unconfirmed"
        except (OSError, ProtocolError, ValidationError) as exc:
            query_error = type(exc).__name__ + ": " + str(exc)
    return GuidanceDelivery(**fields, ack_received=result.success, transport_result=result,
                            application_receipt=receipt, receipt_query_error=query_error)

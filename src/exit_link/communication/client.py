"""Local control client; injects a message at its source node over real TCP."""
from exit_link.communication.protocol import (
    Ack, DeliveryResult, ErrorResponse, Message, ProtocolError, ReliableSend, Shutdown,
    StatusRequest, StatusResponse, Stopped, exchange,
)
from exit_link.topology.models import CommunicationTopology


async def send_message(topology: CommunicationTopology, message: Message, timeout: float = 5):
    if message.hop_index != 0 or message.from_node is not None:
        raise ValueError("Client must submit at the source hop")
    node = next((node for node in topology.nodes if node.id == message.source), None)
    if node is None:
        raise ValueError("Unknown source node")
    response = await exchange(node.host, node.port, message, timeout)
    if not isinstance(response, (Ack, ErrorResponse)):
        raise ProtocolError("Unexpected response type")
    if response.message_id != message.message_id:
        raise ProtocolError("Response message ID mismatch")
    if isinstance(response, Ack) and (
        response.source != message.destination or response.destination != message.source
        or response.route != message.route
    ):
        raise ProtocolError("ACK route/endpoints mismatch")
    return response


async def get_status(topology: CommunicationTopology, node_id: str, timeout: float = 5) -> StatusResponse:
    node = next((node for node in topology.nodes if node.id == node_id), None)
    if node is None:
        raise ValueError("Unknown status node")
    response = await exchange(node.host, node.port, StatusRequest(), timeout)
    if not isinstance(response, StatusResponse) or response.node != node_id:
        raise ProtocolError("Unexpected status response")
    return response


async def send_reliably(topology: CommunicationTopology, request: ReliableSend, timeout: float = 30) -> DeliveryResult:
    node = next((node for node in topology.nodes if node.id == request.source), None)
    if node is None:
        raise ValueError("Unknown source node")
    response = await exchange(node.host, node.port, request, timeout)
    if not isinstance(response, DeliveryResult) or response.message_id != request.message_id:
        raise ProtocolError("Unexpected reliable delivery response")
    if response.source != request.source or response.destination != request.destination:
        raise ProtocolError("Delivery endpoints mismatch")
    if response.success:
        ack = response.ack
        if ack is None or response.error is not None or (
            ack.message_id != request.message_id or ack.source != request.destination or ack.destination != request.source
            or not response.attempts or ack.route != response.attempts[-1].route
        ):
            raise ProtocolError("Reliable ACK correlation mismatch")
    elif response.ack is not None or response.error is None or response.error.message_id != request.message_id:
        raise ProtocolError("Invalid failed delivery response")
    return response


async def stop_node(topology: CommunicationTopology, node_id: str, timeout: float = 5) -> Stopped:
    node = next((node for node in topology.nodes if node.id == node_id), None)
    if node is None:
        raise ValueError("Unknown node")
    response = await exchange(node.host, node.port, Shutdown(), timeout)
    if not isinstance(response, Stopped) or response.node != node_id:
        raise ProtocolError("Unexpected shutdown response")
    return response

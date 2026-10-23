"""Source-only bounded retries; intermediates never start independent retries."""
import time

from exit_link.communication.protocol import Ack, Attempt, DeliveryResult, ErrorResponse, Message, utc_now
from exit_link.routing.communication import available_graph, choose_route


async def deliver_reliably(node, request):
    started = time.monotonic()
    attempts, excluded = [], set()
    remaining, calculation_ms = request.ttl, 0.0
    first_failure = None

    def error(code, detail):
        node.log("delivery_failed", message_id=str(request.message_id), code=code, detail=detail)
        return ErrorResponse(node=node.node_id, message_id=request.message_id, code=code, detail=detail)

    def finish(ack=None, failure=None):
        now = time.monotonic()
        result = DeliveryResult(
            message_id=request.message_id, source=request.source, destination=request.destination,
            success=ack is not None, ack=ack, error=failure, attempts=attempts,
            retries=max(0, len(attempts) - 1), ttl_remaining=remaining, elapsed_ms=(now - started) * 1000,
            route_calculation_ms=calculation_ms,
            recovery_after_first_failure_ms=(now - first_failure) * 1000 if ack is not None and first_failure is not None else None,
        )
        node.log("delivery_result", message_id=str(request.message_id), success=result.success,
                 retries=result.retries, attempts=[attempt.model_dump(mode="json") for attempt in attempts],
                 ttl_remaining=remaining, elapsed_ms=result.elapsed_ms, route_calculation_ms=calculation_ms,
                 recovery_after_first_failure_ms=result.recovery_after_first_failure_ms)
        return result

    if node.heartbeat is None:
        return finish(failure=error("resilience_disabled", "Start the source with --resilient"))
    if request.source != node.node_id or request.destination not in node.nodes:
        return finish(failure=error("invalid_route", "Unknown destination or wrong source node"))

    for index in range(request.max_retries + 1):
        route_started = time.perf_counter()
        database = node.heartbeat.database
        route = None
        if index == 0 and request.initial_route is not None:
            graph = available_graph(node.topology, database, excluded)
            if all(graph.has_edge(a, b) for a, b in zip(request.initial_route, request.initial_route[1:])):
                route = request.initial_route
        if route is None:
            route = choose_route(node.topology, database, request.source, request.destination, excluded)
        route_ms = (time.perf_counter() - route_started) * 1000
        calculation_ms += route_ms
        if route is None:
            return finish(failure=error("no_route", "No route in fresh bidirectional link state"))
        hops = len(route) - 1
        if hops > remaining:
            return finish(failure=error("ttl_expired", "Total forwarding budget cannot cover another route"))
        node.log("route_selected" if index == 0 else "route_changed", message_id=str(request.message_id),
                 route=route, attempt=index + 1, route_calculation_ms=route_ms,
                 excluded_links=[sorted(edge) for edge in sorted(excluded, key=lambda edge: sorted(edge))])
        message = Message(message_id=request.message_id, source=request.source, destination=request.destination,
                          timestamp=request.timestamp, payload=request.payload, route=route, ttl=remaining)
        # Reserve a full route's hop count before every attempt. This is a
        # conservative global TTL budget, even when a failed hop sent no data.
        remaining -= hops
        attempt_started, attempt_timestamp = time.monotonic(), utc_now()
        response = await node.process(message)
        attempts.append(Attempt(number=index + 1, route=route, started_at=attempt_timestamp,
                                duration_ms=(time.monotonic() - attempt_started) * 1000,
                                route_calculation_ms=route_ms,
                                outcome="ack" if isinstance(response, Ack) else response.code))
        if isinstance(response, Ack):
            return finish(ack=response)
        if first_failure is None:
            first_failure = time.monotonic()
        if response.code not in {"connection_failed", "timeout", "invalid_response"}:
            return finish(failure=response)
        if index == request.max_retries:
            return finish(failure=error("retry_exhausted", f"Attempt limit reached; last error: {response.code}"))
        if response.node not in route[:-1]:
            return finish(failure=response)
        position = route.index(response.node)
        excluded.add(frozenset((route[position], route[position + 1])))
        node.log("retry_scheduled", message_id=str(request.message_id), attempt=index + 2,
                 previous_error=response.code, failed_link=[route[position], route[position + 1]],
                 ttl_remaining=remaining)
    raise AssertionError("Bounded delivery loop must return")

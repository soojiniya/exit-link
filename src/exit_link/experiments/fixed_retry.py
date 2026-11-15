"""Fixed + Retry baseline for the fair_retry_v1 study (experiment launcher only).

Mirrors ``exit_link.communication.reliable.deliver_reliably`` line for line except
for the route policy:

* the route is always ``request.initial_route`` (never recomputed, never excluded);
* no heartbeat state is consulted, so the node runs without ``--resilient``.

Everything else is deliberately identical to EXIT-LINK: retries happen only at the
source node, ``max_retries`` counts retries AFTER the first attempt (attempts =
max_retries + 1), there is no backoff between attempts, the same error codes are
retriable, the same TTL budget is reserved per attempt and the same
``DeliveryResult`` is returned. Production nodes never import this module.
"""
import time

from exit_link.communication.protocol import Ack, Attempt, DeliveryResult, ErrorResponse, Message, utc_now

# Must stay equal to the retriable set in communication/reliable.py (checked by tests).
RETRIABLE = frozenset({"connection_failed", "timeout", "invalid_response"})


async def deliver_fixed_retry(node, request):
    started = time.monotonic()
    attempts = []
    remaining = request.ttl
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
            route_calculation_ms=0.0,
            recovery_after_first_failure_ms=(now - first_failure) * 1000 if ack is not None and first_failure is not None else None,
        )
        node.log("delivery_result", message_id=str(request.message_id), success=result.success,
                 retries=result.retries, attempts=[attempt.model_dump(mode="json") for attempt in attempts],
                 ttl_remaining=remaining, elapsed_ms=result.elapsed_ms, route_calculation_ms=0.0,
                 recovery_after_first_failure_ms=result.recovery_after_first_failure_ms,
                 route_policy="fixed_retry")
        return result

    route = request.initial_route
    if request.source != node.node_id or request.destination not in node.nodes or route is None:
        return finish(failure=error("invalid_route", "Fixed retry needs this source, a known destination and initial_route"))
    if route[0] != request.source or route[-1] != request.destination:
        return finish(failure=error("invalid_route", "initial_route endpoints must match source/destination"))

    hops = len(route) - 1
    for index in range(request.max_retries + 1):
        if hops > remaining:
            return finish(failure=error("ttl_expired", "Total forwarding budget cannot cover another route"))
        node.log("route_selected" if index == 0 else "route_reused", message_id=str(request.message_id),
                 route=route, attempt=index + 1, route_calculation_ms=0.0, excluded_links=[],
                 route_policy="fixed_retry")
        message = Message(message_id=request.message_id, source=request.source, destination=request.destination,
                          timestamp=request.timestamp, payload=request.payload, route=route, ttl=remaining)
        # Same conservative global TTL budget as reliable.py: reserve the route's
        # hop count before every attempt, even when a failed hop sent no data.
        remaining -= hops
        attempt_started, attempt_timestamp = time.monotonic(), utc_now()
        response = await node.process(message)
        attempts.append(Attempt(number=index + 1, route=route, started_at=attempt_timestamp,
                                duration_ms=(time.monotonic() - attempt_started) * 1000,
                                route_calculation_ms=0.0,
                                outcome="ack" if isinstance(response, Ack) else response.code))
        if isinstance(response, Ack):
            return finish(ack=response)
        if first_failure is None:
            first_failure = time.monotonic()
        if response.code not in RETRIABLE:
            return finish(failure=response)
        if index == request.max_retries:
            return finish(failure=error("retry_exhausted", f"Attempt limit reached; last error: {response.code}"))
        if response.node not in route[:-1]:
            return finish(failure=response)
        position = route.index(response.node)
        # Logged for analysis only: the failed link is NOT excluded (fixed route).
        node.log("retry_scheduled", message_id=str(request.message_id), attempt=index + 2,
                 previous_error=response.code, failed_link=[route[position], route[position + 1]],
                 ttl_remaining=remaining, route_policy="fixed_retry")
    raise AssertionError("Bounded delivery loop must return")

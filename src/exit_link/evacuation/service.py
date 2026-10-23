"""In-process synthetic scenario session; explicit snapshots for future API adapters."""
from exit_link.evacuation.models import DisasterEvent, Guidance, HazardUpdate, ScenarioSnapshot, ScenarioState, now_utc
from exit_link.routing.evacuation import calculate_evacuation, validate_hazards


class ScenarioSession:
    def __init__(self, building, snapshot: ScenarioSnapshot | None = None):
        self.building = building.model_copy(deep=True)
        if snapshot is not None:
            if snapshot.state.building_id != building.building_id:
                raise ValueError("Snapshot belongs to another building")
            validate_hazards(building, snapshot.state.hazards)
            self.state = snapshot.state.model_copy(deep=True)
            self.plans = {plan.start_location: plan.model_copy(deep=True) for plan in snapshot.plans}
            if len(self.plans) != len(snapshot.plans) or any(
                plan.scenario_id != self.state.scenario_id or plan.building_id != building.building_id
                or plan.scenario_revision != self.state.revision for plan in self.plans.values()
            ):
                raise ValueError("Snapshot contains inconsistent plans")
            for start, plan in self.plans.items():
                expected = calculate_evacuation(building, self.state, start, plan.route_version)
                if plan.model_dump(exclude={"calculated_at"}) != expected.model_dump(exclude={"calculated_at"}):
                    raise ValueError("Snapshot plan does not match current hazards and building")
            if any(event.scenario_id != self.state.scenario_id or event.scenario_revision > self.state.revision
                   for event in snapshot.events):
                raise ValueError("Snapshot contains inconsistent events")
            self.events = [event.model_copy(deep=True) for event in snapshot.events]
        else:
            self.state = ScenarioState(building_id=building.building_id)
            self.plans, self.events = {}, []
            self._event("scenario_created", "simulation")

    def _event(self, event, origin, **details):
        self.events.append(DisasterEvent(scenario_id=self.state.scenario_id, scenario_revision=self.state.revision,
                                        event=event, origin=origin, details=details))

    def plan(self, start):
        if start not in self.plans:
            result = calculate_evacuation(self.building, self.state, start, 1)
            self.plans[start] = result
            self._event("route_calculated", "computation", plan=result.model_dump(mode="json"))
        return self.plans[start].model_copy(deep=True)

    def update(self, hazards: HazardUpdate):
        validate_hazards(self.building, hazards)
        if hazards == self.state.hazards:
            return self.snapshot()
        previous = self.state.hazards.model_dump(mode="json")
        new_state = self.state.model_copy(update={"hazards": hazards.model_copy(deep=True),
                                                  "revision": self.state.revision + 1, "updated_at": now_utc()})
        new_plans = {start: calculate_evacuation(self.building, new_state, start, old.route_version + 1)
                     for start, old in self.plans.items()}
        self.state, self.plans = new_state, new_plans
        self._event("hazards_changed", "simulation", previous=previous, current=hazards.model_dump(mode="json"))
        for plan in new_plans.values():
            self._event("route_calculated", "computation", plan=plan.model_dump(mode="json"))
        return self.snapshot()

    def guidance(self, start, source_node, destination_node):
        plan = self.plan(start)
        guidance = Guidance(
            scenario_id=plan.scenario_id, building_id=plan.building_id, scenario_revision=plan.scenario_revision,
            route_version=plan.route_version, audience_id=start, start_location=start,
            source_node=source_node, destination_node=destination_node, status=plan.status,
            path=plan.path, exit_id=plan.exit_id, distance_m=plan.distance_m,
        )
        if len(guidance.model_dump_json()) > 4096:
            raise ValueError("Guidance exceeds existing payload character limit")
        self._event("guidance_prepared", "simulation", guidance=guidance.model_dump(mode="json"))
        return guidance

    def record_delivery(self, delivery):
        if delivery.scenario_id != self.state.scenario_id:
            raise ValueError("Delivery belongs to another scenario")
        self._event("guidance_delivery_observed", "real_tcp_observation", delivery=delivery.model_dump(mode="json"))

    def snapshot(self):
        return ScenarioSnapshot(state=self.state.model_copy(deep=True),
                                plans=[plan.model_copy(deep=True) for plan in self.plans.values()],
                                events=[event.model_copy(deep=True) for event in self.events])

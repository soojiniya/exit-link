from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Metadata(StrictModel):
    schema_version: Literal["1.0"]
    data_origin: Literal["simulation"]
    description: str


class Place(StrictModel):
    id: str = Field(min_length=1)
    floor: int = Field(ge=1, le=3)
    kind: Literal["corridor", "stair", "exit"]
    label: str


class WalkEdge(StrictModel):
    source: str
    target: str
    kind: Literal["corridor", "stairs", "exit_access"]
    distance_m: float = Field(gt=0, allow_inf_nan=False)


def validate_edges(ids: list[str], edges: list) -> None:
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate node ID")
    known = set(ids)
    seen = set()
    for edge in edges:
        if edge.source not in known or edge.target not in known:
            raise ValueError("Edge references unknown node")
        if edge.source == edge.target:
            raise ValueError("Self loops are not allowed")
        key = frozenset((edge.source, edge.target))
        if key in seen:
            raise ValueError("Duplicate undirected edge")
        seen.add(key)


class Building(StrictModel):
    metadata: Metadata
    building_id: str
    floors: list[int]
    nodes: list[Place] = Field(min_length=1)
    edges: list[WalkEdge] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_structure(self) -> Self:
        if sorted(self.floors) != [1, 2, 3]:
            raise ValueError("Building must define floors 1, 2, 3")
        validate_edges([node.id for node in self.nodes], self.edges)
        places = {node.id: node for node in self.nodes}
        for floor in self.floors:
            kinds = {node.kind for node in self.nodes if node.floor == floor}
            if not {"corridor", "stair"} <= kinds:
                raise ValueError("Each floor needs corridors and stairs")
        if not any(node.kind == "exit" for node in self.nodes):
            raise ValueError("Building requires an exit")
        for edge in self.edges:
            source, target = places[edge.source], places[edge.target]
            if edge.kind == "stairs":
                if source.kind != "stair" or target.kind != "stair" or abs(source.floor - target.floor) != 1:
                    raise ValueError("Stairs must connect stair landings on adjacent floors")
            elif source.floor != target.floor:
                raise ValueError("Only stairs may connect different floors")
            if edge.kind == "exit_access" and "exit" not in {source.kind, target.kind}:
                raise ValueError("Exit access must connect an exit")
        return self


class CommunicationNode(StrictModel):
    id: str = Field(min_length=1)
    location_id: str
    host: Literal["127.0.0.1"]
    port: int = Field(ge=1024, le=65535)


class CommunicationEdge(StrictModel):
    source: str
    target: str


class CommunicationTopology(StrictModel):
    metadata: Metadata
    topology_id: str
    directed: Literal[False]
    nodes: list[CommunicationNode] = Field(min_length=6, max_length=6)
    edges: list[CommunicationEdge] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_structure(self) -> Self:
        validate_edges([node.id for node in self.nodes], self.edges)
        endpoints = {(node.host, node.port) for node in self.nodes}
        if len(endpoints) != len(self.nodes):
            raise ValueError("Node endpoints must be unique")
        return self

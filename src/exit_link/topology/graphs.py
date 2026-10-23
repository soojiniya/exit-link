import networkx as nx

from exit_link.topology.models import Building, CommunicationTopology


def build_movement_graph(building: Building) -> nx.Graph:
    graph = nx.Graph(graph_type="movement", data_origin="simulation")
    for node in building.nodes:
        graph.add_node(node.id, **node.model_dump(exclude={"id"}))
    for edge in building.edges:
        graph.add_edge(edge.source, edge.target, **edge.model_dump(exclude={"source", "target"}))
    return graph


def build_communication_graph(topology: CommunicationTopology) -> nx.Graph:
    graph = nx.Graph(graph_type="communication", data_origin="simulation")
    for node in topology.nodes:
        graph.add_node(node.id, **node.model_dump(exclude={"id"}))
    for edge in topology.edges:
        graph.add_edge(edge.source, edge.target)
    return graph

"""Conservative communication routing, independent of the building graph."""
import networkx as nx

from exit_link.topology.graphs import build_communication_graph


def available_graph(topology, database, excluded_links=()):
    graph = build_communication_graph(topology)
    fresh = database.fresh()
    graph.remove_nodes_from(set(graph) - set(fresh))
    for source, target in list(graph.edges):
        if fresh[source].links.get(target) != "up" or fresh[target].links.get(source) != "up":
            graph.remove_edge(source, target)
    graph.remove_edges_from(tuple(edge) for edge in excluded_links)
    # A confirmed down/unknown link cannot be used merely because a node's
    # last advertisement is still cached. Isolated remote nodes are excluded.
    graph.remove_nodes_from([node for node in graph if graph.degree(node) == 0 and node != database.local_id])
    return graph


def choose_route(topology, database, source, destination, excluded_links=()):
    graph = available_graph(topology, database, excluded_links)
    try:
        return nx.shortest_path(graph, source, destination)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None

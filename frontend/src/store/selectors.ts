import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp } from './store';
import { linkStates, messageFlows, nodeStates } from '@/domain/network';

export function useActiveScenario() {
  return useApp((s) => (s.activeScenarioId ? s.scenarios[s.activeScenarioId] ?? null : null));
}

export function useNetworkDerived() {
  const { network, experiment, recoverRequested, netEvents } = useApp(
    useShallow((s) => ({ network: s.network, experiment: s.experiment, recoverRequested: s.recoverRequested, netEvents: s.netEvents })),
  );
  const nodes = useMemo(() => nodeStates(network, experiment, recoverRequested), [network, experiment, recoverRequested]);
  const links = useMemo(() => linkStates(network, nodes), [network, nodes]);
  const flows = useMemo(() => messageFlows(netEvents), [netEvents]);
  const latestFlow = flows.at(-1) ?? null;
  return { network, experiment, nodes, links, flows, latestFlow };
}

export function useLatestDelivery(scenarioId?: string | null) {
  return useApp((s) => {
    for (let i = s.deliveryOrder.length - 1; i >= 0; i--) {
      const d = s.deliveries[s.deliveryOrder[i]];
      if (!scenarioId || d.scenario_id === scenarioId) return d;
    }
    return null;
  });
}

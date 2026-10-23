import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp } from './store';
import { useNetworkDerived } from './selectors';
import { deliveryRows, detectionSamples, experimentRows, experimentWindows, nodeFaultRows, recoverySamples, rerouteRows, stats } from '@/domain/analytics';

/** Overview·Analytics 공용 파생 데이터(한 곳에서 계산) */
export function useAnalytics() {
  const { deliveries, order, expMarks } = useApp(useShallow((s) => ({ deliveries: s.deliveries, order: s.deliveryOrder, expMarks: s.expMarks })));
  const net = useNetworkDerived();
  const netEvents = useApp((s) => s.netEvents);
  const derived = useMemo(() => {
    const rows = deliveryRows(order.map((id) => deliveries[id]).filter(Boolean));
    const detections = detectionSamples(netEvents);
    const recoveries = recoverySamples(netEvents);
    const windows = experimentWindows(expMarks, net.experiment);
    return {
      rows,
      detections,
      recoveries,
      reroutes: rerouteRows(net.flows, rows),
      nodeFaults: nodeFaultRows(netEvents, net.nodes.map((n) => n.id)),
      experiments: experimentRows(windows, rows, detections),
      elapsed: stats(rows.map((r) => r.elapsedMs).filter((x): x is number => x !== null)),
      detection: stats(detections.map((d) => d.ms)),
      restartToConfirm: stats(recoveries.map((r) => r.restartToConfirmMs)),
      outage: stats(recoveries.map((r) => r.outageMs).filter((x): x is number => x !== null)),
    };
  }, [deliveries, order, expMarks, net.nodes, net.flows, net.experiment, netEvents]);
  return { ...net, ...derived };
}

// Latency instrumentation panel (plan §2.1) — permanent infrastructure, not
// a temporary spike aid.

import type { ReactElement } from 'react';
import { METRIC_NAMES, useDrillStore } from '../store/drillStore';

function formatMs(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)} ms`;
}

export function DebugPanel(): ReactElement {
  const metrics = useDrillStore((s) => s.metrics);
  const utterances = useDrillStore((s) => s.utterances);
  const coordinatorState = useDrillStore((s) => s.coordinatorState);

  return (
    <section className="debug-panel" aria-label="Debug metrics">
      <table className="debug-table">
        <thead>
          <tr>
            <th scope="col">metric</th>
            <th scope="col">p50</th>
            <th scope="col">p95</th>
            <th scope="col">n</th>
          </tr>
        </thead>
        <tbody>
          {METRIC_NAMES.map((name) => {
            const stats = metrics[name];
            return (
              <tr key={name}>
                <td>{name}</td>
                <td>{formatMs(stats.p50)}</td>
                <td>{formatMs(stats.p95)}</td>
                <td>{stats.count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <dl className="debug-facts">
        <div>
          <dt>utterances</dt>
          <dd>{utterances.length}</dd>
        </div>
        <div>
          <dt>coordinator</dt>
          <dd>{coordinatorState}</dd>
        </div>
      </dl>
    </section>
  );
}

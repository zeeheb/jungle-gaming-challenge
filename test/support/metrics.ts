/**
 * Reads one value out of a Prometheus text exposition: the sum of every
 * sample of `name` whose labels include `labels` (0 when there is none).
 */
export function metricValue(exposition: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of exposition.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!match || match[1] !== name) {
      continue;
    }
    const sampleLabels = Object.fromEntries(
      [...(match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map(([, key, value]) => [key, value]),
    );
    if (Object.entries(labels).every(([key, value]) => sampleLabels[key] === value)) {
      total += Number(match[3]);
    }
  }
  return total;
}

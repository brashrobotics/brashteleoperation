export type MetricLabels = Readonly<Record<string, string>>;

interface MetricDefinition {
  name: string;
  help: string;
  type: "counter" | "gauge";
  values: Map<string, { labels: MetricLabels; value: number }>;
}

export class MetricRegistry {
  private readonly metrics = new Map<string, MetricDefinition>();

  increment(name: string, help: string, labels: MetricLabels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Counter increment must be finite and non-negative.");
    const metric = this.requireMetric(name, help, "counter");
    const key = labelKey(labels);
    const current = metric.values.get(key)?.value ?? 0;
    metric.values.set(key, { labels: { ...labels }, value: current + amount });
  }

  setGauge(name: string, help: string, labels: MetricLabels = {}, value: number): void {
    if (!Number.isFinite(value)) throw new Error("Gauge value must be finite.");
    const metric = this.requireMetric(name, help, "gauge");
    metric.values.set(labelKey(labels), { labels: { ...labels }, value });
  }

  value(name: string, labels: MetricLabels = {}): number | undefined {
    return this.metrics.get(name)?.values.get(labelKey(labels))?.value;
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const metric of [...this.metrics.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(`# HELP ${metric.name} ${metric.help.replaceAll("\\", "\\\\").replaceAll("\n", " ")}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const sample of [...metric.values.values()].sort((left, right) => labelKey(left.labels).localeCompare(labelKey(right.labels)))) {
        const labels = Object.entries(sample.labels).sort(([left], [right]) => left.localeCompare(right));
        const renderedLabels = labels.length === 0 ? "" : `{${labels.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
        lines.push(`${metric.name}${renderedLabels} ${sample.value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private requireMetric(name: string, help: string, type: MetricDefinition["type"]): MetricDefinition {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Metric name ${name} is invalid.`);
    validateLabels({});
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== type || existing.help !== help) throw new Error(`Metric ${name} was registered with another definition.`);
      return existing;
    }
    const metric: MetricDefinition = { name, help, type, values: new Map() };
    this.metrics.set(name, metric);
    return metric;
  }
}

function labelKey(labels: MetricLabels): string {
  validateLabels(labels);
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

function validateLabels(labels: MetricLabels): void {
  for (const [key, value] of Object.entries(labels)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error(`Metric label ${key} is invalid.`);
    if (value.length > 120) throw new Error(`Metric label ${key} is too long.`);
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

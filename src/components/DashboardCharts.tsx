import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { money } from "../lib/format";

export function VatChart({ data }: { data: Array<{ name: string; value: number; color: string }> }) {
  return (
    <ResponsiveContainer width="99%" height={210} maxHeight={210}>
      <PieChart>
        <Pie data={data} innerRadius={58} outerRadius={86} paddingAngle={2} dataKey="value">
          {data.map((item) => <Cell key={item.name} fill={item.color} />)}
        </Pie>
        <Tooltip formatter={(value: unknown) => money(Number(value ?? 0))} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/**
 * Metric sparkline.
 *
 * Drawn as a plain inline SVG with a `viewBox` rather than a measured chart:
 * the element is sized purely by CSS, so it can never round a pixel past its
 * card and push the page into a horizontal scroll at a fractional zoom factor.
 * It is decorative — the figure above it carries the meaning — so it is hidden
 * from assistive technology.
 */
export function MetricSparkline({ data }: { data: Array<{ value: number }> }) {
  const values = data.map((point) => Number(point.value) || 0);
  if (values.length < 2) return null;

  const width = 100;
  const height = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / span) * (height - 2) - 1;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      className="wt-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points={`0,${height} ${points.join(" ")} ${width},${height}`} fill="currentColor" fillOpacity={0.08} />
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

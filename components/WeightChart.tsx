"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export default function WeightChart({
  data,
}: {
  data: { date: string; weight: number }[];
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis domain={["dataMin - 0.5", "dataMax + 0.5"]} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v) => [`${v} kg`, "Peso"]} />
          <Line
            type="monotone"
            dataKey="weight"
            stroke="#059669"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

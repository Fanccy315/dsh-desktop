/**
 * 统计预测与安全库存。
 * 全部为确定性函数，供 scans.ts 调用；LLM 不做任何算术。
 */

/** 移动平均：取序列末尾 window 项的均值（不足取全部）。 */
export function movingAverage(
  series: readonly number[],
  window: number,
): number {
  if (series.length === 0) return 0;
  const tail = series.slice(-window);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

/** 样本标准差（n < 2 或全零波动按 0 处理）。 */
export function stdev(series: readonly number[]): number {
  if (series.length < 2) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance =
    series.reduce((a, b) => a + (b - mean) ** 2, 0) / (series.length - 1);
  return Math.sqrt(variance);
}

/**
 * Holt 线性指数平滑：以水平 + 趋势外推未来 horizon 期，返回合计值（下限 0）。
 * @param series 按期升序的观察值（如逐日出库量）。
 */
export function holtForecastTotal(
  series: readonly number[],
  horizon: number,
  alpha = 0.3,
  beta = 0.1,
): number {
  if (series.length === 0 || horizon <= 0) return 0;
  let level = series[0]!;
  let trend = series.length > 1 ? series[1]! - series[0]! : 0;
  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    level = alpha * series[i]! + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  let total = 0;
  for (let h = 1; h <= horizon; h++) total += level + h * trend;
  return Math.max(0, total);
}

/** 正态分位数查表 + 线性插值（服务水平 → 安全系数 z）。 */
const Z_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0.9, 1.282],
  [0.95, 1.645],
  [0.98, 2.054],
  [0.99, 2.326],
];

/**
 * 服务水平对应的正态分位数（安全库存 z 值）。
 * @param serviceLevel 0–1 之间；表外值按相邻档线性插值。
 */
export function zScore(serviceLevel: number): number {
  const p = Math.min(0.99, Math.max(0.5, serviceLevel));
  for (let i = 0; i < Z_TABLE.length - 1; i++) {
    const [p0, z0] = Z_TABLE[i]!;
    const [p1, z1] = Z_TABLE[i + 1]!;
    if (p <= p1) return z0 + ((z1 - z0) * (p - p0)) / (p1 - p0);
  }
  return Z_TABLE[Z_TABLE.length - 1]![1];
}

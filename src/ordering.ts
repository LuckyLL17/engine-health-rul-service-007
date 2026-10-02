import { IngestRejectionReason, TelemetrySample } from './types.js';

/**
 * 样本唯一键：同一发动机、同一时间戳、同一 cycle 只允许存在一个样本。
 * 重复提交按该键幂等折叠；同键但内容冲突则进入隔离区。
 */
export function telemetryKey(sample: Pick<TelemetrySample, 'engineId' | 'timestamp' | 'cycle'>): string {
  return `${sample.engineId}|${sample.timestamp}|${sample.cycle}`;
}

export function telemetryTime(sample: Pick<TelemetrySample, 'timestamp'>): number {
  return Date.parse(sample.timestamp);
}

/**
 * 规范顺序：先按发动机，再按时间戳，最后按 cycle。
 * 合法序列中 timestamp 与 cycle 必须同时单调不减，二者倒退即乱序。
 */
export function compareTelemetry(a: TelemetrySample, b: TelemetrySample): number {
  const byEngine = a.engineId.localeCompare(b.engineId);
  if (byEngine !== 0) return byEngine;
  const byTime = telemetryTime(a) - telemetryTime(b);
  if (byTime !== 0) return byTime;
  return a.cycle - b.cycle;
}

/**
 * 序列前进判定：时间戳与 cycle 必须都不倒退，且至少一个严格前进。
 * 用于高水位线守卫——元组大小序无法捕获“时间前进但 cycle 倒退”的矛盾样本。
 */
export function advancesSequence(candidate: Pick<TelemetrySample, 'timestamp' | 'cycle'>, hwm: Pick<TelemetrySample, 'timestamp' | 'cycle'>): boolean {
  const timeOk = telemetryTime(candidate) >= telemetryTime(hwm);
  const cycleOk = candidate.cycle >= hwm.cycle;
  const strictlyAhead = telemetryTime(candidate) > telemetryTime(hwm) || candidate.cycle > hwm.cycle;
  return timeOk && cycleOk && strictlyAhead;
}

const measuredFields: Array<keyof TelemetrySample> = [
  'cycle', 'rpm', 'exhaustGasTemp', 'fuelFlow', 'vibration',
  'oilPressure', 'oilTemperature', 'ambientTemperature', 'altitude', 'thrust'
];

/** 结构性校验：缺少身份/时间戳或存在非有限数值的样本无法参与排序，必须在入口隔离。 */
export function isStructurallyValidTelemetry(sample: TelemetrySample | undefined | null): sample is TelemetrySample {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.engineId !== 'string' || !sample.engineId) return false;
  if (typeof sample.timestamp !== 'string' || !Number.isFinite(telemetryTime(sample))) return false;
  return measuredFields.every(field => Number.isFinite(sample[field] as number));
}

/** 测量内容指纹：同一样本重复提交时内容必须一致，否则按冲突隔离而不是静默覆盖。 */
export function telemetryFingerprint(sample: TelemetrySample): string {
  return JSON.stringify([
    sample.flightId, sample.phase, sample.rpm, sample.exhaustGasTemp, sample.fuelFlow,
    sample.vibration, sample.oilPressure, sample.oilTemperature, sample.ambientTemperature,
    sample.altitude, sample.thrust
  ]);
}

export type IngestPlan = {
  accepted: TelemetrySample[];
  duplicates: TelemetrySample[];
  rejected: Array<{ sample: TelemetrySample; reason: IngestRejectionReason; detail: string }>;
};

/**
 * 依据已有存储（保证已按 (engineId,timestamp,cycle) 排序且唯一）规划一次批次导入。
 *
 * - 批次内部允许传输层乱序：先按规范键排序再处理；
 * - 结构非法、键重复但内容冲突、以及落在该发动机高水位线之前的样本，稳定隔离；
 * - 与已存样本完全相同的重复提交幂等折叠，不污染数据也不掩盖缺失区间。
 */
export function planTelemetryIngest(existing: TelemetrySample[], incoming: TelemetrySample[]): IngestPlan {
  const accepted: TelemetrySample[] = [];
  const duplicates: TelemetrySample[] = [];
  const rejected: IngestPlan['rejected'] = [];

  const byEngine = new Map<string, TelemetrySample[]>();
  for (const row of existing) {
    const list = byEngine.get(row.engineId);
    if (list) list.push(row); else byEngine.set(row.engineId, [row]);
  }
  for (const list of byEngine.values()) list.sort(compareTelemetry);

  const incomingByEngine = new Map<string, TelemetrySample[]>();
  for (const raw of incoming) {
    const engineId = isStructurallyValidTelemetry(raw) ? raw.engineId : '__invalid__';
    const list = incomingByEngine.get(engineId);
    if (list) list.push(raw); else incomingByEngine.set(engineId, [raw]);
  }

  for (const [engineId, rawRows] of incomingByEngine) {
    // 高水位线：该发动机已提交序列的最后一个规范键，新样本必须严格晚于它。
    let hwm: TelemetrySample | undefined = byEngine.get(engineId)?.at(-1);
    const keyIndex = new Map<string, TelemetrySample>();
    for (const row of byEngine.get(engineId) ?? []) keyIndex.set(telemetryKey(row), row);

    const seenInBatch = new Map<string, TelemetrySample>();
    if (engineId === '__invalid__') {
      for (const raw of rawRows) {
        rejected.push({ sample: raw, reason: 'invalid_structure', detail: '传感器样本缺少 engineId、时间戳或包含非法数值' });
      }
      continue;
    }

    // 结构非法样本已归入 __invalid__ 分组；这里仅处理可排序的样本，允许批次内部传输乱序。
    const rows = rawRows.sort(compareTelemetry);

    for (const sample of rows) {
      const key = telemetryKey(sample);
      const known = keyIndex.get(key) ?? seenInBatch.get(key);
      if (known) {
        if (telemetryFingerprint(known) === telemetryFingerprint(sample)) {
          duplicates.push(sample);
        } else {
          rejected.push({ sample, reason: 'duplicate_conflict', detail: `键 ${key} 的样本与已提交内容冲突，拒绝静默覆盖` });
        }
        continue;
      }
      if (hwm && !advancesSequence(sample, hwm)) {
        rejected.push({
          sample,
          reason: 'order_violation',
          detail: `样本 ${key} 未前进于该发动机高水位线（timestamp=${hwm.timestamp}, cycle=${hwm.cycle}）：时间戳或 cycle 发生倒退，拒绝乱序写入`
        });
        continue;
      }
      seenInBatch.set(key, sample);
      accepted.push(sample);
      if (!hwm || advancesSequence(sample, hwm)) hwm = sample;
    }
  }

  accepted.sort(compareTelemetry);
  return { accepted, duplicates, rejected };
}

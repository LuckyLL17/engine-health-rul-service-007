import { Anomaly, Component, Engine, EngineStatus, HealthAssessment, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

const limits = { exhaustGasTemp: 760, vibration: 3.2, oilPressureMin: 3.1, fuelFlowMax: 310 };
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const statusFor = (score: number): EngineStatus => score >= 85 ? 'healthy' : score >= 70 ? 'watch' : score >= 50 ? 'degraded' : 'critical';

// 每个发动机的时序由 (timestamp, cycle) 唯一确定；该键同时用于顺序判定与重复提交判定。
export type SeriesKey = { engineId: string; timestamp: string; cycle: number };
export type RejectReason = 'invalid_value' | 'range_violation' | 'out_of_order' | 'duplicate_conflict';
export type RejectedRow = { sample: TelemetrySample; reason: RejectReason; message: string };
export type IngestResult = { accepted: TelemetrySample[]; rejected: RejectedRow[]; anomalies: Anomaly[]; duplicateKeys: number; reorderedInBatch: number };

export const seriesKeyOf = (sample: TelemetrySample): SeriesKey => ({ engineId: sample.engineId, timestamp: sample.timestamp, cycle: sample.cycle });
const keyId = (key: SeriesKey) => `${key.engineId}|${key.timestamp}|${key.cycle}`;
const compareKey = (a: SeriesKey, b: SeriesKey) => keyId(a).localeCompare(keyId(b));
const toTime = (timestamp: string) => Date.parse(timestamp);

const identityFields = ['engineId', 'flightId', 'timestamp', 'cycle', 'phase', 'rpm', 'exhaustGasTemp', 'fuelFlow', 'vibration', 'oilPressure', 'oilTemperature', 'ambientTemperature', 'altitude', 'thrust'] as const;
export function sampleFingerprint(sample: TelemetrySample): string {
  return JSON.stringify(identityFields.map(field => sample[field]));
}

function structureProblem(sample: Partial<TelemetrySample> | undefined): string | undefined {
  if (!sample || typeof sample !== 'object') return '样本不是有效对象';
  if (typeof sample.engineId !== 'string' || !sample.engineId) return '样本缺少 engineId';
  if (typeof sample.timestamp !== 'string' || !Number.isFinite(toTime(sample.timestamp))) return '样本缺少合法时间戳';
  if (typeof sample.cycle !== 'number' || !Number.isFinite(sample.cycle)) return '样本缺少合法 cycle';
  const values = [sample.rpm, sample.exhaustGasTemp, sample.fuelFlow, sample.vibration, sample.oilPressure, sample.oilTemperature, sample.altitude, sample.thrust];
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) return '传感器样本包含非法数值';
  return undefined;
}

function rangeProblem(sample: TelemetrySample): string | undefined {
  if (sample.exhaustGasTemp > limits.exhaustGasTemp || sample.fuelFlow > limits.fuelFlowMax || sample.vibration > 6 || sample.oilPressure < 1) {
    return '样本超出物理安全范围';
  }
  return undefined;
}

const anomalyFactory = () => { let n = 0; return (payload: Omit<Anomaly, 'id'>): Anomaly => ({ id: `AN-${n += 1}`, ...payload }); };

type ExistingState = { fingerprint: Map<string, string>; highWater: Map<string, SeriesKey> };
function stateFrom(existing: TelemetrySample[]): ExistingState {
  // 现有数据必须是规范有序（存储层保证）；高水位取每个发动机的最后一个键。
  const fingerprint = new Map<string, string>();
  const highWater = new Map<string, SeriesKey>();
  for (const sample of existing) {
    const key = seriesKeyOf(sample);
    fingerprint.set(keyId(key), sampleFingerprint(sample));
    const water = highWater.get(sample.engineId);
    if (!water || compareKey(key, water) > 0) highWater.set(sample.engineId, key);
  }
  return { fingerprint, highWater };
}

/**
 * 以 (timestamp, cycle) 为每个发动机的规范顺序，对一批样本做确定性分类：
 * - accepted：通过结构/范围校验、不早于该发动机高水位、不与既有/批内键冲突的样本；
 * - 重复提交（同键同内容）幂等跳过，不计入 rejected、不产生告警；
 * - 同键不同内容标记 duplicate_conflict，迟到样本标记 out_of_order，二者均被拒绝。
 * 结果与批内样本到达顺序无关。
 */
export function ingestTelemetry(rows: TelemetrySample[], existing: TelemetrySample[] = []): IngestResult {
  const accepted: TelemetrySample[] = [];
  const rejected: Array<RejectedRow & { index: number }> = [];
  const anomalies: Anomaly[] = [];
  const state = stateFrom(existing);
  const newAnomaly = anomalyFactory();
  let duplicateKeys = 0;
  let reorderedInBatch = 0;

  // 结构/范围问题属于单样本问题，与顺序无关，先在到达顺序上拦截，保证它们不会借排序“混入”。
  const candidates: Array<{ sample: TelemetrySample; index: number }> = [];
  rows.forEach((sample, index) => {
    const structural = structureProblem(sample);
    if (structural) { rejected.push({ sample, index, reason: 'invalid_value', message: structural }); return; }
    const outOfRange = rangeProblem(sample);
    if (outOfRange) { rejected.push({ sample, index, reason: 'range_violation', message: outOfRange }); return; }
    candidates.push({ sample, index });
  });

  // 合法样本按规范顺序合并判定；每个键在批内只保留首个位置。
  const seenBatchIndex = new Map<string, number>();
  const ordered = [...candidates].sort((a, b) => compareKey(seriesKeyOf(a.sample), seriesKeyOf(b.sample)) || a.index - b.index);
  for (const item of ordered) {
    const key = seriesKeyOf(item.sample); const id = keyId(key);
    const firstIndex = seenBatchIndex.get(id);
    if (firstIndex === undefined) seenBatchIndex.set(id, item.index);
    if (firstIndex !== undefined && firstIndex !== item.index) {
      // 批内重复键：与该键首次出现的内容比对。
      const firstSample = ordered.find(row => row.index === firstIndex)!.sample;
      if (sampleFingerprint(firstSample) === sampleFingerprint(item.sample)) { duplicateKeys += 1; continue; }
      rejected.push({ sample: item.sample, index: item.index, reason: 'duplicate_conflict', message: '相同时刻和 cycle 的样本内容与批内另一条提交冲突' });
      anomalies.push(newAnomaly({ engineId: key.engineId, timestamp: key.timestamp, type: 'duplicate_conflict', severity: 'high', message: '相同时刻和 cycle 的遥测样本内容冲突，已拒绝后到提交', evidence: { cycle: key.cycle, conflictWithIndex: firstIndex } }));
      continue;
    }

    const priorFingerprint = state.fingerprint.get(id);
    if (priorFingerprint !== undefined) {
      if (priorFingerprint === sampleFingerprint(item.sample)) { duplicateKeys += 1; continue; }
      rejected.push({ sample: item.sample, index: item.index, reason: 'duplicate_conflict', message: '相同时刻和 cycle 的样本内容与已存储样本冲突' });
      anomalies.push(newAnomaly({ engineId: key.engineId, timestamp: key.timestamp, type: 'duplicate_conflict', severity: 'high', message: '重复提交的遥测样本内容与既有数据不一致，已拒绝后到提交', evidence: { cycle: key.cycle } }));
      continue;
    }

    const water = state.highWater.get(key.engineId);
    if (water && compareKey(key, water) < 0) {
      rejected.push({ sample: item.sample, index: item.index, reason: 'out_of_order', message: '样本时间戳/cycle 早于该发动机已导入的高水位' });
      anomalies.push(newAnomaly({ engineId: key.engineId, timestamp: key.timestamp, type: 'out_of_order', severity: 'high', message: '遥测批次乱序到达，迟到样本已拒绝，未参与后续评估', evidence: { cycle: key.cycle, highWaterCycle: water.cycle, highWaterTimestamp: water.timestamp } }));
      continue;
    }

    accepted.push(item.sample);
    state.fingerprint.set(id, sampleFingerprint(item.sample));
    state.highWater.set(key.engineId, key);
  }

  // 批内样本的到达顺序与规范顺序不一致（但全部可接受）时做信息性计数，由调用方决定是否审计；
  // 不拒绝样本，也不影响确定性的存储顺序。
  const acceptedIndexSet = new Set(accepted.map(sample => rows.indexOf(sample)));
  let previousIndex = -1;
  for (const item of ordered) {
    if (!acceptedIndexSet.has(item.index)) continue;
    if (item.index < previousIndex) reorderedInBatch += 1;
    previousIndex = item.index;
  }

  rejected.sort((a, b) => a.index - b.index);
  return { accepted, rejected: rejected.map(({ sample, reason, message }) => ({ sample, reason, message })), anomalies, duplicateKeys, reorderedInBatch: Math.min(reorderedInBatch, Number.MAX_SAFE_INTEGER) };
}

const rejectionAnomaly = (newAnomaly: (payload: Omit<Anomaly, 'id'>) => Anomaly, sample: TelemetrySample, reason: RejectReason, message: string): Anomaly => {
  if (reason === 'out_of_order') return newAnomaly({ engineId: sample.engineId, timestamp: sample.timestamp, type: 'out_of_order', severity: 'high', message, evidence: { cycle: sample.cycle } });
  if (reason === 'duplicate_conflict') return newAnomaly({ engineId: sample.engineId, timestamp: sample.timestamp, type: 'duplicate_conflict', severity: 'high', message, evidence: { cycle: sample.cycle } });
  return newAnomaly({ engineId: sample.engineId, timestamp: sample.timestamp, type: 'range_violation', severity: 'high', message, evidence: { cycle: sample.cycle } });
};

/**
 * 评估时的防御性复核：严格按调用方给定的顺序（存储层保证为规范顺序）遍历，
 * 不再重排样本，因此乱序不会被掩盖。重复样本幂等跳过，绝不重复计入斜率和数据质量。
 */
export function validateTelemetry(samples: TelemetrySample[]): { accepted: TelemetrySample[]; rejected: TelemetrySample[]; duplicatesSkipped: TelemetrySample[]; anomalies: Anomaly[] } {
  const accepted: TelemetrySample[] = [], rejected: TelemetrySample[] = [], duplicatesSkipped: TelemetrySample[] = [], anomalies: Anomaly[] = [];
  const newAnomaly = anomalyFactory();
  const seen = new Set<string>();
  let previous: TelemetrySample | undefined;
  for (const sample of samples) {
    const structural = structureProblem(sample);
    if (structural) { rejected.push(sample); anomalies.push(rejectionAnomaly(newAnomaly, sample, 'invalid_value', structural)); continue; }
    const outOfRange = rangeProblem(sample);
    if (outOfRange) { rejected.push(sample); anomalies.push(rejectionAnomaly(newAnomaly, sample, 'range_violation', `${outOfRange}，已从评分中剔除`)); continue; }

    const id = keyId(seriesKeyOf(sample));
    if (seen.has(id)) { duplicatesSkipped.push(sample); continue; }

    if (previous) {
      const gap = toTime(sample.timestamp) - toTime(previous.timestamp);
      if (gap < 0) {
        rejected.push(sample);
        anomalies.push(newAnomaly({ engineId: sample.engineId, timestamp: sample.timestamp, type: 'out_of_order', severity: 'high', message: '遥测样本相对前序样本倒退，已从本次评估中剔除', evidence: { cycle: sample.cycle, previousCycle: previous.cycle, gapMinutes: round(gap / 60_000) } }));
        continue;
      }
      if (gap > 15 * 60_000) anomalies.push(newAnomaly({ engineId: sample.engineId, timestamp: sample.timestamp, type: 'missing_interval', severity: 'medium', message: '传感器时间序列存在采样间隔缺失', evidence: { gapMinutes: round(gap / 60_000) } }));
      if (Math.abs(sample.vibration - previous.vibration) > 0.65) anomalies.push(newAnomaly({ engineId: sample.engineId, timestamp: sample.timestamp, type: 'sensor_spike', severity: 'medium', sensor: 'vibration', message: '振动信号出现突变', evidence: { previous: previous.vibration, current: sample.vibration } }));
    }
    seen.add(id);
    accepted.push(sample); previous = sample;
  }
  return { accepted, rejected, duplicatesSkipped, anomalies };
}

function normalizedTemperature(sample: TelemetrySample): number { return sample.exhaustGasTemp - sample.ambientTemperature * .35 - (sample.phase === 'takeoff' ? 34 : sample.phase === 'climb' ? 20 : 0); }
function slope(values: number[]): number { if (values.length < 2) return 0; const n = values.length; const xMean = (n - 1) / 2; const yMean = values.reduce((a, b) => a + b, 0) / n; const numerator = values.reduce((sum, y, x) => sum + (x - xMean) * (y - yMean), 0); const denominator = values.reduce((sum, _, x) => sum + (x - xMean) ** 2, 0); return denominator ? numerator / denominator : 0; }

export function assessEngine(engine: Engine, samples: TelemetrySample[], model: ModelVersion, maintenanceCount = 0): HealthAssessment {
  const checked = validateTelemetry(samples); const usable = checked.accepted;
  const temps = usable.map(normalizedTemperature); const fuel = usable.map(item => item.fuelFlow / Math.max(item.thrust, 1)); const vibration = usable.map(item => item.vibration); const oil = usable.map(item => item.oilPressure);
  const temperatureRisk = clamp(((Math.max(...temps, 0) - 620) / 105) * 100); const fuelRisk = clamp(((Math.max(...fuel, 0) - 5.6) / 1.1) * 100); const vibrationRisk = clamp(((Math.max(...vibration, 0) - 1.2) / 2.2) * 100); const oilRisk = clamp(((4.6 - Math.min(...oil, 4.6)) / 1.4) * 100); const degradationSlope = slope(usable.map(item => item.vibration)) + Math.max(0, slope(temps) / 50);
  const degradationRisk = clamp(degradationSlope * 42 + maintenanceCount * 2);
  const risk = temperatureRisk * model.weights.temperature + fuelRisk * model.weights.fuel + vibrationRisk * model.weights.vibration + oilRisk * model.weights.oil + degradationRisk * model.weights.degradation;
  const healthScore = round(clamp(100 - risk)); const componentRisks: Array<[Component, number, string[]]> = [
    ['hot_section', temperatureRisk, ['排气温度裕度下降', '高温阶段的温度归一化值偏高']], ['compressor', fuelRisk, ['单位推力燃油流量上升', '工况归一化后的效率指标偏弱']], ['bearing', vibrationRisk, ['振动幅值趋势上升', '存在突变样本需要复核']], ['lubrication', oilRisk, ['滑油压力裕度降低', '建议结合传感器校准记录复核']]
  ];
  const risks = componentRisks.map(([component, componentRisk, drivers]) => ({ component, score: round(componentRisk), status: statusFor(100 - componentRisk), drivers, estimatedCyclesToLimit: Math.max(20, Math.round((100 - componentRisk) * 18)) }));
  const considered = Math.max(samples.length - checked.duplicatesSkipped.length, 1);
  const explanations = [`模型 ${model.label} 使用 ${usable.length} 个有效样本完成评估`, `最高温度风险 ${round(temperatureRisk)}，最高振动风险 ${round(vibrationRisk)}`, `数据质量得分 ${round(usable.length / considered * 100)}，剔除 ${checked.rejected.length} 个异常样本，跳过 ${checked.duplicatesSkipped.length} 个重复样本`];
  const anomalies = [...checked.anomalies];
  if (degradationRisk > 35) anomalies.push({ id: `AN-${anomalies.length + 1}`, engineId: engine.id, timestamp: new Date().toISOString(), type: 'degradation', severity: degradationRisk > 60 ? 'high' : 'medium', message: '关键退化指标超过关注阈值', evidence: { degradationRisk: round(degradationRisk), vibrationSlope: round(slope(vibration), 4) } });
  return { assessmentId: `ASSESS-${Date.now()}`, engineId: engine.id, modelVersion: model.id, createdAt: new Date().toISOString(), sampleCount: samples.length, healthScore, status: statusFor(healthScore), dataQuality: { score: round(usable.length / considered * 100), usableSamples: usable.length, rejectedSamples: checked.rejected.length, duplicatesSkipped: checked.duplicatesSkipped.length, missingIntervals: checked.anomalies.filter(item => item.type === 'missing_interval').length }, indicators: { exhaustTemperatureMargin: round(limits.exhaustGasTemp - Math.max(...temps, 0)), fuelEfficiencyIndex: round(100 - fuelRisk), vibrationRisk: round(vibrationRisk), oilPressureMargin: round(Math.min(...oil, 4.6) - limits.oilPressureMin), degradationSlope: round(degradationSlope, 4) }, componentRisks: risks, anomalies, explanation: explanations };
}

export function predictRul(engine: Engine, assessment: HealthAssessment, horizonCycles: number, model: ModelVersion): RulPrediction {
  const leading = [...assessment.componentRisks].sort((a, b) => a.estimatedCyclesToLimit - b.estimatedCyclesToLimit)[0]; const base = Math.max(24, Math.min(horizonCycles, Math.round(leading.estimatedCyclesToLimit * (.82 + assessment.healthScore / 500)))); const confidence = round(clamp(55 + assessment.dataQuality.score * .35 - assessment.anomalies.length * 2, 15, 96)); const lowerBound = Math.max(1, Math.round(base * (1 - (100 - confidence) / 220))); const upperBound = Math.round(base * (1 + (100 - confidence) / 220)); const riskByHorizon = [0, .25, .5, .75, 1].map((ratio) => ({ cycle: Math.round(base * ratio), healthScore: round(Math.max(0, assessment.healthScore - ratio * (assessment.healthScore - 38))), probabilityOfMaintenance: round(clamp(.08 + ratio * ratio * .82 + (100 - confidence) / 220, 0, .99), 3) })); return { predictionId: `RUL-${Date.now()}`, engineId: engine.id, modelVersion: model.id, createdAt: new Date().toISOString(), horizonCycles, estimatedRemainingCycles: base, confidence, lowerBound, upperBound, limitingComponent: leading.component, riskByHorizon, evidence: [`${leading.component} 为当前最短部件寿命估计`, `健康评分 ${assessment.healthScore}，数据质量 ${assessment.dataQuality.score}`, `模型 ${model.label} 结合退化斜率与维修历史进行估算`] };
}

export function maintenanceWindows(prediction: RulPrediction): Array<{ window: string; startCycle: number; endCycle: number; priority: string; reason: string }> { const start = Math.max(1, prediction.lowerBound - 25); return [{ window: '近期检查窗口', startCycle: start, endCycle: Math.max(start, prediction.lowerBound), priority: 'high', reason: `${prediction.limitingComponent} 的预测寿命下界接近` }, { window: '计划维护窗口', startCycle: prediction.lowerBound, endCycle: prediction.estimatedRemainingCycles, priority: prediction.confidence > 70 ? 'medium' : 'high', reason: '建议在下界前安排拆检或部件更换' }, { window: '延后风险窗口', startCycle: prediction.estimatedRemainingCycles, endCycle: prediction.upperBound, priority: 'critical', reason: '超过预测中位寿命后，维护概率显著上升' }]; }

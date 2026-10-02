import { telemetryFingerprint, telemetryKey } from './ordering.js';
import { Anomaly, Component, Engine, EngineStatus, HealthAssessment, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

const limits = { exhaustGasTemp: 760, vibration: 3.2, oilPressureMin: 3.1, fuelFlowMax: 310 };
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const statusFor = (score: number): EngineStatus => score >= 85 ? 'healthy' : score >= 70 ? 'watch' : score >= 50 ? 'degraded' : 'critical';

export type TelemetryValidation = {
  accepted: TelemetrySample[];
  rejected: TelemetrySample[];
  duplicates: TelemetrySample[];
  anomalies: Anomaly[];
};

/**
 * 按提交顺序逐条校验，绝不静默重排——迟到样本一旦混入，会改写缺失区间和退化趋势，
 * 因此任何时间戳/cycle 倒退都显式标记为 order_violation 并剔除。
 * 完全相同的重复提交幂等折叠：不计入质量，也不会用零间隔掩盖缺失区间。
 */
export function validateTelemetry(samples: TelemetrySample[]): TelemetryValidation {
  const accepted: TelemetrySample[] = [], rejected: TelemetrySample[] = [], duplicates: TelemetrySample[] = [], anomalies: Anomaly[] = [];
  const seen = new Map<string, TelemetrySample>();
  let previous: TelemetrySample | undefined;
  const pushAnomaly = (engineId: string, anomaly: Omit<Anomaly, 'id' | 'engineId'>) => anomalies.push({ ...anomaly, id: `AN-${anomalies.length + 1}`, engineId });

  for (const sample of samples) {
    const values = [sample.rpm, sample.exhaustGasTemp, sample.fuelFlow, sample.vibration, sample.oilPressure, sample.oilTemperature, sample.altitude, sample.thrust];
    if (!sample.timestamp || Number.isNaN(Date.parse(sample.timestamp)) || values.some(value => !Number.isFinite(value))) {
      rejected.push(sample);
      pushAnomaly(sample.engineId, { timestamp: sample.timestamp, type: 'range_violation', severity: 'high', message: '传感器样本包含非法数值', evidence: { cycle: sample.cycle } });
      continue;
    }
    const key = telemetryKey(sample);
    const known = seen.get(key);
    if (known) {
      if (telemetryFingerprint(known) === telemetryFingerprint(sample)) {
        duplicates.push(sample);
      } else {
        rejected.push(sample);
        pushAnomaly(sample.engineId, { timestamp: sample.timestamp, type: 'duplicate_conflict', severity: 'high', message: '同一时间戳与 cycle 存在内容冲突的重复样本，已拒绝', evidence: { cycle: sample.cycle, key } });
      }
      continue;
    }
    if (sample.exhaustGasTemp > limits.exhaustGasTemp || sample.fuelFlow > limits.fuelFlowMax || sample.vibration > 6 || sample.oilPressure < 1) {
      rejected.push(sample);
      pushAnomaly(sample.engineId, { timestamp: sample.timestamp, type: 'range_violation', severity: 'high', sensor: 'multi', message: '样本超出物理安全范围，已从评分中剔除', evidence: { exhaustGasTemp: sample.exhaustGasTemp, vibration: sample.vibration, oilPressure: sample.oilPressure } });
      continue;
    }
    if (previous) {
      const timeDelta = Date.parse(sample.timestamp) - Date.parse(previous.timestamp);
      const cycleDelta = sample.cycle - previous.cycle;
      if (timeDelta < 0 || cycleDelta < 0) {
        rejected.push(sample);
        pushAnomaly(sample.engineId, { timestamp: sample.timestamp, type: 'order_violation', severity: 'high', message: '遥测样本相对前序样本发生时间戳或 cycle 倒退，拒绝乱序样本', evidence: { cycle: sample.cycle, previousCycle: previous.cycle, timeDeltaMinutes: round(timeDelta / 60_000), cycleDelta } });
        continue;
      }
      if (timeDelta > 15 * 60_000) {
        pushAnomaly(sample.engineId, { timestamp: sample.timestamp, type: 'missing_interval', severity: 'medium', message: '传感器时间序列存在采样间隔缺失', evidence: { gapMinutes: round(timeDelta / 60_000) } });
      }
      if (Math.abs(sample.vibration - previous.vibration) > 0.65) {
        pushAnomaly(sample.engineId, { timestamp: sample.timestamp, type: 'sensor_spike', severity: 'medium', sensor: 'vibration', message: '振动信号出现突变', evidence: { previous: previous.vibration, current: sample.vibration } });
      }
    }
    seen.set(key, sample);
    accepted.push(sample);
    previous = sample;
  }
  return { accepted, rejected, duplicates, anomalies };
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
  const uniqueCount = Math.max(samples.length - checked.duplicates.length, 1);
  const explanations = [`模型 ${model.label} 使用 ${usable.length} 个有效样本完成评估`, `最高温度风险 ${round(temperatureRisk)}，最高振动风险 ${round(vibrationRisk)}`, `数据质量得分 ${round(usable.length / uniqueCount * 100)}，剔除 ${checked.rejected.length} 个异常样本，折叠 ${checked.duplicates.length} 个重复提交`];
  const anomalies = [...checked.anomalies];
  if (degradationRisk > 35) anomalies.push({ id: `AN-${anomalies.length + 1}`, engineId: engine.id, timestamp: new Date().toISOString(), type: 'degradation', severity: degradationRisk > 60 ? 'high' : 'medium', message: '关键退化指标超过关注阈值', evidence: { degradationRisk: round(degradationRisk), vibrationSlope: round(slope(vibration), 4) } });
  return { assessmentId: `ASSESS-${Date.now()}`, engineId: engine.id, modelVersion: model.id, createdAt: new Date().toISOString(), sampleCount: samples.length, healthScore, status: statusFor(healthScore), dataQuality: { score: round(usable.length / uniqueCount * 100), usableSamples: usable.length, rejectedSamples: checked.rejected.length, duplicateSamples: checked.duplicates.length, missingIntervals: checked.anomalies.filter(item => item.type === 'missing_interval').length }, indicators: { exhaustTemperatureMargin: round(limits.exhaustGasTemp - Math.max(...temps, 0)), fuelEfficiencyIndex: round(100 - fuelRisk), vibrationRisk: round(vibrationRisk), oilPressureMargin: round(Math.min(...oil, 4.6) - limits.oilPressureMin), degradationSlope: round(degradationSlope, 4) }, componentRisks: risks, anomalies, explanation: explanations };
}

export function predictRul(engine: Engine, assessment: HealthAssessment, horizonCycles: number, model: ModelVersion): RulPrediction {
  const leading = [...assessment.componentRisks].sort((a, b) => a.estimatedCyclesToLimit - b.estimatedCyclesToLimit)[0]; const base = Math.max(24, Math.min(horizonCycles, Math.round(leading.estimatedCyclesToLimit * (.82 + assessment.healthScore / 500)))); const confidence = round(clamp(55 + assessment.dataQuality.score * .35 - assessment.anomalies.length * 2, 15, 96)); const lowerBound = Math.max(1, Math.round(base * (1 - (100 - confidence) / 220))); const upperBound = Math.round(base * (1 + (100 - confidence) / 160)); const riskByHorizon = [0, .25, .5, .75, 1].map((ratio) => ({ cycle: Math.round(base * ratio), healthScore: round(Math.max(0, assessment.healthScore - ratio * (assessment.healthScore - 38))), probabilityOfMaintenance: round(clamp(.08 + ratio * ratio * .82 + (100 - confidence) / 220, 0, .99), 3) })); return { predictionId: `RUL-${Date.now()}`, engineId: engine.id, modelVersion: model.id, createdAt: new Date().toISOString(), horizonCycles, estimatedRemainingCycles: base, confidence, lowerBound, upperBound, limitingComponent: leading.component, riskByHorizon, evidence: [`${leading.component} 为当前最短部件寿命估计`, `健康评分 ${assessment.healthScore}，数据质量 ${assessment.dataQuality.score}`, `模型 ${model.label} 结合退化斜率与维修历史进行估算`] };
}

export function maintenanceWindows(prediction: RulPrediction): Array<{ window: string; startCycle: number; endCycle: number; priority: string; reason: string }> { const start = Math.max(1, prediction.lowerBound - 25); return [{ window: '近期检查窗口', startCycle: start, endCycle: Math.max(start, prediction.lowerBound), priority: 'high', reason: `${prediction.limitingComponent} 的预测寿命下界接近` }, { window: '计划维护窗口', startCycle: prediction.lowerBound, endCycle: prediction.estimatedRemainingCycles, priority: prediction.confidence > 70 ? 'medium' : 'high', reason: '建议在下界前安排拆检或部件更换' }, { window: '延后风险窗口', startCycle: prediction.estimatedRemainingCycles, endCycle: prediction.upperBound, priority: 'critical', reason: '超过预测中位寿命后，维护概率显著上升' }]; }

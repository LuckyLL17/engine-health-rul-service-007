import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { demoEngine, demoMaintenance, demoModels, createDemoTelemetry } from './demo-data.js';
import { advancesSequence, compareTelemetry, planTelemetryIngest, telemetryFingerprint, telemetryKey } from './ordering.js';
import { Engine, HealthAssessment, MaintenanceEvent, ModelVersion, QuarantinedSample, RulPrediction, TelemetrySample } from './types.js';

type State = {
  engines: Engine[];
  telemetry: TelemetrySample[];
  maintenance: MaintenanceEvent[];
  models: ModelVersion[];
  assessments: HealthAssessment[];
  predictions: RulPrediction[];
  audit: Array<Record<string, unknown>>;
  quarantine: QuarantinedSample[];
};

export type IngestResult = {
  imported: TelemetrySample[];
  duplicates: TelemetrySample[];
  quarantined: QuarantinedSample[];
};

const freshState = (): State => ({
  engines: [demoEngine], telemetry: createDemoTelemetry(), maintenance: demoMaintenance,
  models: demoModels, assessments: [], predictions: [], audit: [], quarantine: []
});

/**
 * 启动规范化：任何绕过守卫落盘或历史遗留的数据，在进入内存前先去重、排序，
 * 倒退/冲突样本移入隔离区——保证后续读取永远看到全局有序且唯一的序列。
 */
function normalizeTelemetry(raw: TelemetrySample[]): { telemetry: TelemetrySample[]; quarantine: QuarantinedSample[] } {
  const quarantine: QuarantinedSample[] = [];
  const kept: TelemetrySample[] = [];
  const keyIndex = new Map<string, TelemetrySample>();
  const groups = new Map<string, TelemetrySample[]>();
  for (const sample of raw) {
    if (!sample || typeof sample !== 'object' || typeof sample.engineId !== 'string') continue;
    const list = groups.get(sample.engineId);
    if (list) list.push(sample); else groups.set(sample.engineId, [sample]);
  }
  const receivedAt = new Date().toISOString();
  for (const list of groups.values()) {
    list.sort(compareTelemetry);
    let hwm: TelemetrySample | undefined;
    for (const sample of list) {
      const key = telemetryKey(sample);
      const known = keyIndex.get(key);
      if (known) {
        if (telemetryFingerprint(known) !== telemetryFingerprint(sample)) {
          quarantine.push({ id: `Q-LOAD-${quarantine.length + 1}`, reason: 'duplicate_conflict', receivedAt, engineId: sample.engineId, timestamp: sample.timestamp, cycle: sample.cycle, detail: `加载持久化状态时发现键 ${key} 的冲突副本`, sample });
        }
        continue;
      }
      if (hwm && !advancesSequence(sample, hwm)) {
        quarantine.push({ id: `Q-LOAD-${quarantine.length + 1}`, reason: 'order_violation', receivedAt, engineId: sample.engineId, timestamp: sample.timestamp, cycle: sample.cycle, detail: `加载持久化状态时发现倒退样本 ${key}，高水位线为 timestamp=${hwm.timestamp}, cycle=${hwm.cycle}`, sample });
        continue;
      }
      keyIndex.set(key, sample);
      kept.push(sample);
      hwm = sample;
    }
  }
  kept.sort(compareTelemetry);
  return { telemetry: kept, quarantine };
}

export class LocalStore {
  private state: State = freshState();
  constructor(private readonly file = resolve(process.cwd(), 'data/state.json')) {}

  async init(): Promise<void> {
    try {
      const loaded = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>;
      this.state = { ...freshState(), ...loaded };
      if (!Array.isArray(this.state.quarantine)) this.state.quarantine = [];
      const normalized = normalizeTelemetry(this.state.telemetry);
      this.state.telemetry = normalized.telemetry;
      this.state.quarantine.unshift(...normalized.quarantine);
      if (normalized.quarantine.length > 0) await this.persist();
    } catch {
      await this.persist();
    }
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2));
  }

  get engines() { return this.state.engines; }
  /** 始终为按 (engineId,timestamp,cycle) 排序、键唯一的规范序列。 */
  get telemetry() { return this.state.telemetry; }
  get maintenance() { return this.state.maintenance; }
  get models() { return this.state.models; }
  get assessments() { return this.state.assessments; }
  get predictions() { return this.state.predictions; }
  get audit() { return this.state.audit; }
  get quarantine() { return this.state.quarantine; }

  /**
   * 带顺序守卫的遥测导入：
   * - 合法新样本按规范位置合并，重复提交幂等折叠；
   * - 结构非法、乱序/迟到、同键冲突样本稳定进入持久化隔离区，绝不混入规范序列。
   */
  ingestTelemetry(rows: TelemetrySample[]): IngestResult {
    const plan = planTelemetryIngest(this.state.telemetry, rows);
    const receivedAt = new Date().toISOString();
    const base = this.state.quarantine.length;
    const quarantined: QuarantinedSample[] = plan.rejected.map((item, index) => ({
      id: `Q-${base + index + 1}`,
      reason: item.reason,
      receivedAt,
      engineId: item.sample.engineId,
      timestamp: item.sample.timestamp,
      cycle: item.sample.cycle,
      detail: item.detail,
      sample: item.sample
    }));
    // 守卫已保证新键严格前进且唯一；重排后得到全局有序序列。
    this.state.telemetry.push(...plan.accepted);
    this.state.telemetry.sort(compareTelemetry);
    this.state.quarantine.unshift(...quarantined);
    return { imported: plan.accepted, duplicates: plan.duplicates, quarantined };
  }

  addEngine(engine: Engine) { this.state.engines.push(engine); }
  addMaintenance(event: MaintenanceEvent) { this.state.maintenance.push(event); }
  addAssessment(value: HealthAssessment) { this.state.assessments.unshift(value); }
  addPrediction(value: RulPrediction) { this.state.predictions.unshift(value); }
  log(action: string, engineId: string, detail: Record<string, unknown>) { this.state.audit.unshift({ id: `AUD-${this.state.audit.length + 1}`, action, engineId, at: new Date().toISOString(), detail }); }
}

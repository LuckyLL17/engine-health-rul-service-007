import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { demoEngine, demoMaintenance, demoModels, createDemoTelemetry } from './demo-data.js';
import { ingestTelemetry, sampleFingerprint } from './health.js';
import { Engine, HealthAssessment, MaintenanceEvent, ModelVersion, QuarantinedSample, RulPrediction, TelemetrySample } from './types.js';

type State = { engines: Engine[]; telemetry: TelemetrySample[]; maintenance: MaintenanceEvent[]; models: ModelVersion[]; assessments: HealthAssessment[]; predictions: RulPrediction[]; quarantine: QuarantinedSample[]; audit: Array<Record<string, unknown>> };

const keyId = (sample: TelemetrySample) => `${sample.engineId}|${sample.timestamp}|${sample.cycle}`;

export class LocalStore {
  private state: State = { engines: [demoEngine], telemetry: createDemoTelemetry(), maintenance: demoMaintenance, models: demoModels, assessments: [], predictions: [], quarantine: [], audit: [] };
  private initialized = false;
  constructor(private readonly file = resolve(process.cwd(), 'data/state.json')) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const loaded = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>;
      this.state = {
        engines: loaded.engines ?? [],
        telemetry: [],
        maintenance: loaded.maintenance ?? [],
        models: loaded.models ?? demoModels,
        assessments: loaded.assessments ?? [],
        predictions: loaded.predictions ?? [],
        quarantine: loaded.quarantine ?? [],
        audit: loaded.audit ?? []
      };
      // 旧文件中的行按追加（到达）顺序保存：逐行重放以重建每个发动机的高水位，
      // 迟到/冲突/非法行进隔离区，其余合入规范有序存储。这样重启后读取也不会再被历史乱序污染。
      const legacy = loaded.telemetry ?? [];
      if (legacy.length) {
        let current: TelemetrySample[] = [];
        let duplicateCount = 0; let quarantinedCount = 0;
        for (const sample of legacy) {
          const result = ingestTelemetry([sample], current);
          if (result.accepted.length) current = mergeCanonical(current, result.accepted);
          duplicateCount += result.duplicateKeys;
          for (const row of result.rejected) {
            if (this.addQuarantine(row.reason, row.message, row.sample)) quarantinedCount += 1;
          }
        }
        this.state.telemetry = current;
        if (quarantinedCount || duplicateCount) await this.persist();
      }
    } catch {
      // 文件不存在（首次运行，保留演示数据）或内容损坏（落盘一份可用的默认状态）。
      await this.persist();
    }
  }

  async persist(): Promise<void> { await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(this.state, null, 2)); }
  get engines() { return this.state.engines; }
  get telemetry() { return this.state.telemetry; }
  get maintenance() { return this.state.maintenance; }
  get models() { return this.state.models; }
  get assessments() { return this.state.assessments; }
  get predictions() { return this.state.predictions; }
  get quarantine() { return this.state.quarantine; }
  get audit() { return this.state.audit; }

  /**
   * 唯一的遥测写入入口：合法样本按 (timestamp, cycle) 规范合入并保持全量有序、无重复；
   * 乱序、键冲突、非法/越界样本进入 quarantine，绝不进入 telemetry。
   * 返回被新隔离的条目（重复隔离键幂等忽略）。
   */
  addTelemetry(rows: TelemetrySample[]): { accepted: TelemetrySample[]; quarantined: QuarantinedSample[]; duplicatesSkipped: number; reorderedInBatch: number } {
    const result = ingestTelemetry(rows, this.state.telemetry);
    this.state.telemetry = result.accepted.length ? mergeCanonical(this.state.telemetry, result.accepted) : this.state.telemetry;
    const quarantined: QuarantinedSample[] = [];
    for (const row of result.rejected) {
      const entry = this.addQuarantine(row.reason, row.message, row.sample);
      if (entry) quarantined.push(entry);
    }
    return { accepted: result.accepted, quarantined, duplicatesSkipped: result.duplicateKeys, reorderedInBatch: result.reorderedInBatch };
  }

  /** 隔离区按 样本键+原因+内容指纹 去重，重复提交不会在隔离区制造新条目。 */
  addQuarantine(reason: QuarantinedSample['reason'], message: string, sample: TelemetrySample): QuarantinedSample | undefined {
    const fingerprint = `${keyId(sample)}|${reason}|${sampleFingerprint(sample)}`;
    if (this.state.quarantine.some(item => `${keyId(item.sample)}|${item.reason}|${sampleFingerprint(item.sample)}` === fingerprint)) return undefined;
    const anomalyId = `QUA-${Date.now().toString(36).toUpperCase()}-${(this.state.quarantine.length + 1).toString(36).toUpperCase()}`;
    const entry: QuarantinedSample = {
      reason, message, sample, rejectedAt: new Date().toISOString(),
      anomaly: { id: anomalyId, engineId: sample.engineId, timestamp: sample.timestamp, type: reason === 'invalid_value' ? 'range_violation' : reason, severity: 'high', message, evidence: { cycle: sample.cycle } }
    };
    this.state.quarantine.unshift(entry);
    return entry;
  }

  addEngine(engine: Engine) { this.state.engines.push(engine); }
  /** 维修事件按 id 幂等：重复提交被忽略，冲突 id 拒绝，避免回灌被掩盖或重复计数。 */
  addMaintenance(event: MaintenanceEvent): 'added' | 'duplicate' | 'conflict' {
    const existing = this.state.maintenance.find(item => item.id === event.id);
    if (existing) return JSON.stringify(existing) === JSON.stringify(event) ? 'duplicate' : 'conflict';
    this.state.maintenance.push(event);
    return 'added';
  }
  addAssessment(value: HealthAssessment) { this.state.assessments.unshift(value); }
  addPrediction(value: RulPrediction) { this.state.predictions.unshift(value); }
  log(action: string, engineId: string, detail: Record<string, unknown>) { this.state.audit.unshift({ id: `AUD-${this.state.audit.length + 1}`, action, engineId, at: new Date().toISOString(), detail }); }
}

function mergeCanonical(existing: TelemetrySample[], incoming: TelemetrySample[]): TelemetrySample[] {
  const merged = [...existing, ...incoming];
  merged.sort((a, b) => a.engineId.localeCompare(b.engineId) || a.timestamp.localeCompare(b.timestamp) || a.cycle - b.cycle || sampleFingerprint(a).localeCompare(sampleFingerprint(b)));
  // 防御性去重：正常情况下 ingestTelemetry 已保证无重复键，这里兜底保证存储不变式。
  const deduped: TelemetrySample[] = [];
  for (const sample of merged) {
    const last = deduped[deduped.length - 1];
    if (last && keyId(last) === keyId(sample) && sampleFingerprint(last) === sampleFingerprint(sample)) continue;
    deduped.push(sample);
  }
  return deduped;
}

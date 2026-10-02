import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareTelemetry, planTelemetryIngest, telemetryKey } from '../src/ordering.js';
import { LocalStore } from '../src/store.js';
import { TelemetrySample } from '../src/types.js';
import { validateTelemetry } from '../src/health.js';
import { createApp } from '../src/server.js';
import { FastifyInstance } from 'fastify';

function sample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    engineId: 'ENG-TEST', flightId: 'FLIGHT-1', timestamp: '2026-09-30T08:00:00.000Z', cycle: 1763,
    phase: 'cruise', rpm: 7200, exhaustGasTemp: 620, fuelFlow: 240, vibration: 1.2,
    oilPressure: 4.5, oilTemperature: 86, ambientTemperature: 18, altitude: 9800, thrust: 32,
    ...overrides
  };
}

const s1763 = () => sample();
const s1764 = () => sample({ timestamp: '2026-09-30T08:10:00.000Z', cycle: 1764, vibration: 1.21 });
const s1765 = () => sample({ timestamp: '2026-09-30T08:20:00.000Z', cycle: 1765, vibration: 1.22 });

describe('planTelemetryIngest 顺序守卫', () => {
  it('拒绝先到 1764/08:10 后到 1763/08:00 的迟到批次，合法样本保留', () => {
    const first = planTelemetryIngest([], [s1764()]);
    expect(first.accepted).toHaveLength(1);

    const second = planTelemetryIngest(first.accepted, [s1763()]);
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected).toHaveLength(1);
    expect(second.rejected[0].reason).toBe('order_violation');

    // 第三个合法批次仍可正常使用
    const third = planTelemetryIngest(first.accepted, [s1765()]);
    expect(third.accepted).toHaveLength(1);
  });

  it('批次内部传输乱序会被排序后接受，不制造乱序', () => {
    const plan = planTelemetryIngest([], [s1765(), s1763(), s1764()]);
    expect(plan.accepted.map(item => item.cycle)).toEqual([1763, 1764, 1765]);
    expect(plan.rejected).toHaveLength(0);
  });

  it('完全相同的重复提交幂等折叠，不产生第二条数据', () => {
    const once = planTelemetryIngest([], [s1763(), s1764()]);
    const again = planTelemetryIngest(once.accepted, [s1763(), s1764()]);
    expect(again.accepted).toHaveLength(0);
    expect(again.duplicates).toHaveLength(2);
    expect(again.rejected).toHaveLength(0);
  });

  it('同键但内容冲突的重复提交被隔离而不是静默覆盖', () => {
    const once = planTelemetryIngest([], [s1763()]);
    const conflict = planTelemetryIngest(once.accepted, [sample({ vibration: 2.9 })]);
    expect(conflict.accepted).toHaveLength(0);
    expect(conflict.duplicates).toHaveLength(0);
    expect(conflict.rejected[0].reason).toBe('duplicate_conflict');
  });

  it('时间戳前进但 cycle 倒退也判定为乱序', () => {
    const once = planTelemetryIngest([], [s1763()]);
    const weird = planTelemetryIngest(once.accepted, [sample({ timestamp: '2026-09-30T08:30:00.000Z', cycle: 1762 })]);
    expect(weird.rejected[0].reason).toBe('order_violation');
  });

  it('非法数值样本被隔离，不影响同批合法样本', () => {
    const plan = planTelemetryIngest([], [s1763(), sample({ timestamp: 'not-a-date' }), sample({ vibration: Number.NaN })]);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.rejected.map(item => item.reason)).toEqual(['invalid_structure', 'invalid_structure']);
  });

  it('不同发动机的高水位线互不干扰', () => {
    const other = sample({ engineId: 'ENG-OTHER', timestamp: '2026-09-30T07:00:00.000Z', cycle: 900 });
    const plan = planTelemetryIngest([s1764()], [other]);
    expect(plan.accepted).toHaveLength(1);
  });
});

describe('validateTelemetry 显式乱序标记', () => {
  it('倒退样本产生 order_violation 异常并被剔除，不静默重排', () => {
    const result = validateTelemetry([s1763(), s1765(), s1764()]);
    expect(result.accepted.map(item => item.cycle)).toEqual([1763, 1765]);
    expect(result.rejected.map(item => item.cycle)).toEqual([1764]);
    expect(result.anomalies.some(item => item.type === 'order_violation')).toBe(true);
  });

  it('迟到样本不会改变缺失区间判断：剔除后退化区间只按合法样本计算', () => {
    // 08:00 → 08:30 为 30 分钟缺口（>15 分钟阈值）
    const b = sample({ timestamp: '2026-09-30T08:30:00.000Z', cycle: 1766 });
    const clean = validateTelemetry([s1763(), b]);
    expect(clean.anomalies.filter(item => item.type === 'missing_interval')).toHaveLength(1);

    // 迟到的 08:15 样本若被静默排序插入，会把 30 分钟缺口拆成两个 15 分钟，从而掩盖缺失
    const late = sample({ timestamp: '2026-09-30T08:15:00.000Z', cycle: 1764, flightId: 'FLIGHT-X' });
    const attacked = validateTelemetry([s1763(), b, late]);
    expect(attacked.accepted.some(item => item.flightId === 'FLIGHT-X')).toBe(false);
    expect(attacked.anomalies.some(item => item.type === 'order_violation')).toBe(true);
    expect(attacked.anomalies.filter(item => item.type === 'missing_interval')).toHaveLength(1);
  });

  it('重复提交折叠，不用零间隔掩盖缺失区间', () => {
    const far = sample({ timestamp: '2026-09-30T09:00:00.000Z', cycle: 1770 });
    const result = validateTelemetry([s1763(), far, s1763()]);
    expect(result.duplicates).toHaveLength(1);
    expect(result.anomalies.filter(item => item.type === 'missing_interval')).toHaveLength(1);
  });
});

describe('LocalStore 持久化与重启', () => {
  const dirs: string[] = [];
  async function newStore(): Promise<{ store: LocalStore; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'engstate-'));
    dirs.push(dir);
    const file = join(dir, 'state.json');
    const store = new LocalStore(file);
    await store.init();
    return { store, file };
  }

  afterEach(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); dirs.length = 0; });

  it('乱序样本进入持久化隔离区，存储序列保持全局有序且唯一', async () => {
    const { store } = await newStore();
    const first = store.ingestTelemetry([s1764()]);
    expect(first.imported).toHaveLength(1);
    const late = store.ingestTelemetry([s1763()]);
    expect(late.imported).toHaveLength(0);
    expect(late.quarantined[0].reason).toBe('order_violation');

    const telemetry = store.telemetry.filter(item => item.engineId === 'ENG-TEST');
    expect(telemetry.map(item => item.cycle)).toEqual([1764]);
    const sorted = [...telemetry].sort(compareTelemetry);
    expect(telemetry).toEqual(sorted);
    expect(new Set(telemetry.map(telemetryKey)).size).toBe(telemetry.length);
  });

  it('重复提交不会增加行数，且后续合法样本继续可用', async () => {
    const { store } = await newStore();
    store.ingestTelemetry([s1763(), s1764()]);
    const again = store.ingestTelemetry([s1763(), s1764()]);
    expect(again.imported).toHaveLength(0);
    expect(again.duplicates).toHaveLength(2);
    const later = store.ingestTelemetry([s1765()]);
    expect(later.imported).toHaveLength(1);
    expect(store.telemetry.filter(item => item.engineId === 'ENG-TEST').map(item => item.cycle)).toEqual([1763, 1764, 1765]);
  });

  it('重启加载时规范化历史遗留乱序数据：乱序/冲突入隔离，读取仍有序', async () => {
    const { store, file } = await newStore();
    store.ingestTelemetry([s1763(), s1764()]);
    await store.persist();
    // 模拟旧版本或外部写入：直接向持久化文件塞入乱序、重复数据
    const raw = JSON.parse(await readFile(file, 'utf8'));
    // 合法新样本、时间前进但 cycle 倒退的矛盾样本、同键内容冲突样本
    raw.telemetry.push(
      s1765(),
      sample({ timestamp: '2026-09-30T08:30:00.000Z', cycle: 1764 }),
      { ...s1764(), vibration: 2.8 }
    );
    await writeFile(file, JSON.stringify(raw));

    const reloaded = new LocalStore(file);
    await reloaded.init();
    const rows = reloaded.telemetry.filter(item => item.engineId === 'ENG-TEST').map(item => item.cycle);
    expect(rows).toEqual([1763, 1764, 1765]);
    const reasons = reloaded.quarantine.map(item => item.reason).sort();
    expect(reasons).toContain('order_violation');
    expect(reasons).toContain('duplicate_conflict');
  });
});

describe('HTTP 导入链路', () => {
  const dirs: string[] = [];
  async function newApp(): Promise<{ app: FastifyInstance; store: LocalStore }> {
    const dir = await mkdtemp(join(tmpdir(), 'enghttp-'));
    dirs.push(dir);
    const store = new LocalStore(join(dir, 'state.json'));
    const app = await createApp(store);
    return { app, store };
  }

  const engine = () => ({ id: 'ENG-TEST', serialNumber: 'SN-1', model: 'AeroCore-X90', aircraftId: 'AC-1', installedAt: '2026-09-01', totalCycles: 0, status: 'healthy' as const, currentHealthScore: 90 });

  afterEach(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); dirs.length = 0; });

  it('迟到批次返回 409 异常标记，合法样本落库可读且可评估', async () => {
    const { app } = await newApp();
    const ok = await app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine: engine(), telemetry: [s1764()] } });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine: engine(), telemetry: [s1763()] } });
    expect(bad.statusCode).toBe(409);
    const body = JSON.parse(bad.body);
    expect(body.importedTelemetry).toBe(0);
    expect(body.quarantined[0].reason).toBe('order_violation');

    const rows = await app.inject({ url: '/api/engines/ENG-TEST/telemetry' });
    expect(JSON.parse(rows.body).map((item: TelemetrySample) => item.cycle)).toEqual([1764]);

    const q = await app.inject({ url: '/api/engines/ENG-TEST/quarantine' });
    expect(JSON.parse(q.body)).toHaveLength(1);

    const assessment = await app.inject({ method: 'POST', url: '/api/engines/ENG-TEST/health-assessment' });
    expect(assessment.statusCode).toBe(200);
    const assessed = JSON.parse(assessment.body);
    expect(assessed.dataQuality.usableSamples).toBe(1);
    expect(assessed.anomalies.some((item: { type: string }) => item.type === 'order_violation')).toBe(false);

    await app.close();
  });

  it('混合批次部分成功：合法样本入库，乱序样本隔离', async () => {
    const { app } = await newApp();
    const res = await app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine: engine(), telemetry: [s1764(), s1763()] } });
    // 批次内排序：1763、1764 都是新序列，合法接受
    expect(res.statusCode).toBe(200);
    // 08:05/cycle1763 与已存键不同，但时间戳和 cycle 都落在高水位线之前，属乱序
    const lateDifferentKey = sample({ timestamp: '2026-09-30T08:05:00.000Z', cycle: 1763 });
    const res2 = await app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine: engine(), telemetry: [s1765(), lateDifferentKey] } });
    expect(res2.statusCode).toBe(409);
    const body = JSON.parse(res2.body);
    expect(body.importedTelemetry).toBe(1);
    expect(body.quarantined).toHaveLength(1);
    expect(body.quarantined[0].reason).toBe('order_violation');
    await app.close();
  });
});

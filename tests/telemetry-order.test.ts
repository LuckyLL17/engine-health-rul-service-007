import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessEngine, ingestTelemetry, validateTelemetry } from '../src/health.js';
import { LocalStore } from '../src/store.js';
import { TelemetrySample } from '../src/types.js';
import { createApp } from '../src/server.js';
import { demoModels } from '../src/demo-data.js';

const baseSample = (overrides: Partial<TelemetrySample> = {}): TelemetrySample => ({
  engineId: 'ENG-TEST-001', flightId: 'FLIGHT-0001', timestamp: '2026-09-30T08:00:00.000Z', cycle: 1763, phase: 'taxi',
  rpm: 7200, exhaustGasTemp: 612, fuelFlow: 240, vibration: 1.2, oilPressure: 4.6, oilTemperature: 86,
  ambientTemperature: 18, altitude: 800, thrust: 32, ...overrides
});
const sampleAt = (cycle: number, timestamp: string, overrides: Partial<TelemetrySample> = {}) => baseSample({ cycle, timestamp, ...overrides });

let dirs: string[] = [];
async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'telemetry-order-'));
  dirs.push(dir);
  const store = new LocalStore(join(dir, 'state.json'));
  await store.init();
  // 干净状态：移除演示遥测，避免干扰高水位。
  store.telemetry.splice(0, store.telemetry.length);
  return { store, dir };
}

afterEach(async () => { const cleanup = dirs; dirs = []; await Promise.all(cleanup.map(dir => rm(dir, { recursive: true, force: true }))); });

describe('ingestTelemetry ordering enforcement', () => {
  it('rejects a late cycle 1763 batch after cycle 1764 while keeping the earlier legal samples', () => {
    const first = ingestTelemetry([sampleAt(1764, '2026-09-30T08:10:00.000Z')], []);
    expect(first.accepted).toHaveLength(1);

    const second = ingestTelemetry([sampleAt(1763, '2026-09-30T08:00:00.000Z')], first.accepted);
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected).toHaveLength(1);
    expect(second.rejected[0].reason).toBe('out_of_order');
    expect(second.anomalies[0].type).toBe('out_of_order');
    expect(second.anomalies[0].evidence.highWaterCycle).toBe(1764);
  });

  it('is stable regardless of which order the two batches physically arrive', () => {
    const a = sampleAt(1764, '2026-09-30T08:10:00.000Z');
    const b = sampleAt(1763, '2026-09-30T08:00:00.000Z');

    const lateFirst = ingestTelemetry([b], ingestTelemetry([a], []).accepted);
    const earlyFirst = ingestTelemetry([a], ingestTelemetry([b], []).accepted);

    expect(lateFirst.accepted).toHaveLength(0);
    expect(lateFirst.rejected[0].reason).toBe('out_of_order');
    expect(earlyFirst.accepted.map(s => s.cycle)).toEqual([1764]);
  });

  it('treats an identical resubmission as an idempotent duplicate, not a second sample', () => {
    const sample = sampleAt(1764, '2026-09-30T08:10:00.000Z');
    const first = ingestTelemetry([sample], []);
    const resubmitted = ingestTelemetry([sample], first.accepted);

    expect(resubmitted.accepted).toHaveLength(0);
    expect(resubmitted.rejected).toHaveLength(0);
    expect(resubmitted.duplicateKeys).toBe(1);
    expect(resubmitted.anomalies).toHaveLength(0);
  });

  it('recognizes a duplicate resubmission even once the high-water mark has moved past it', () => {
    const first = ingestTelemetry([sampleAt(1764, '2026-09-30T08:10:00.000Z')], []);
    const stored = [...first.accepted, ...ingestTelemetry([sampleAt(1765, '2026-09-30T08:20:00.000Z')], first.accepted).accepted]
      .sort((a, b) => a.cycle - b.cycle);
    const resubmitted = ingestTelemetry([sampleAt(1764, '2026-09-30T08:10:00.000Z')], stored);

    expect(resubmitted.duplicateKeys).toBe(1);
    expect(resubmitted.rejected).toHaveLength(0);
    expect(resubmitted.accepted).toHaveLength(0);
  });

  it('flags the same key arriving with different payload content as a conflict', () => {
    const sample = sampleAt(1764, '2026-09-30T08:10:00.000Z');
    const first = ingestTelemetry([sample], []);
    const tampered = ingestTelemetry([sampleAt(1764, '2026-09-30T08:10:00.000Z', { vibration: 2.9 })], first.accepted);

    expect(tampered.accepted).toHaveLength(0);
    expect(tampered.rejected[0].reason).toBe('duplicate_conflict');
    expect(tampered.anomalies[0].type).toBe('duplicate_conflict');
  });

  it('accepts legal samples out of a shuffled batch in deterministic canonical order', () => {
    const rows = [
      sampleAt(1765, '2026-09-30T08:20:00.000Z'),
      sampleAt(1763, '2026-09-30T08:00:00.000Z'),
      sampleAt(1764, '2026-09-30T08:10:00.000Z')
    ];
    const result = ingestTelemetry(rows, []);
    expect(result.accepted.map(sample => sample.cycle)).toEqual([1763, 1764, 1765]);
    expect(result.rejected).toHaveLength(0);
    expect(result.reorderedInBatch).toBeGreaterThan(0);

    const reversed = ingestTelemetry([...rows].reverse(), []);
    expect(reversed.accepted.map(sample => sample.cycle)).toEqual([1763, 1764, 1765]);
  });

  it('still rejects invalid and unsafe samples alongside ordering violations', () => {
    const result = ingestTelemetry([
      sampleAt(1764, '2026-09-30T08:10:00.000Z'),
      sampleAt(1765, '2026-09-30T08:20:00.000Z', { exhaustGasTemp: 900 }),
      { ...sampleAt(1766, '2026-09-30T08:30:00.000Z'), vibration: Number.NaN }
    ], []);
    expect(result.accepted.map(sample => sample.cycle)).toEqual([1764]);
    expect(result.rejected.map(row => row.reason).sort()).toEqual(['invalid_value', 'range_violation']);
  });
});

describe('assessment validation does not hide disorder', () => {
  it('validateTelemetry rejects a backwards step instead of sorting it away', () => {
    const rows = [
      sampleAt(1763, '2026-09-30T08:00:00.000Z'),
      sampleAt(1764, '2026-09-30T08:10:00.000Z'),
      sampleAt(1765, '2026-09-30T08:20:00.000Z')
    ];
    const clean = validateTelemetry(rows);
    expect(clean.accepted).toHaveLength(3);
    expect(clean.anomalies.filter(item => item.type === 'out_of_order')).toHaveLength(0);

    const withLateArrival = validateTelemetry([...rows, sampleAt(1762, '2026-09-30T07:50:00.000Z')]);
    expect(withLateArrival.rejected).toHaveLength(1);
    expect(withLateArrival.rejected[0].cycle).toBe(1762);
    expect(withLateArrival.anomalies.some(item => item.type === 'out_of_order')).toBe(true);
  });

  it('duplicate submissions are skipped and cannot change degradation slope or missing intervals', () => {
    const rows = [
      sampleAt(1763, '2026-09-30T08:00:00.000Z'),
      sampleAt(1764, '2026-09-30T08:10:00.000Z', { vibration: 1.3 }),
      sampleAt(1765, '2026-09-30T08:20:00.000Z', { vibration: 1.4 })
    ];
    const once = assessEngine({ id: 'ENG-TEST-001' } as never, rows, demoModels[1]);
    const twice = assessEngine({ id: 'ENG-TEST-001' } as never, [...rows, ...rows], demoModels[1]);

    expect(twice.indicators.degradationSlope).toBe(once.indicators.degradationSlope);
    expect(twice.healthScore).toBe(once.healthScore);
    expect(twice.dataQuality.missingIntervals).toBe(once.dataQuality.missingIntervals);
    expect(twice.dataQuality.usableSamples).toBe(once.dataQuality.usableSamples);
    expect(twice.dataQuality.duplicatesSkipped).toBe(3);
    expect(twice.sampleCount).toBe(6);
  });
});

describe('LocalStore guarded storage', () => {
  it('keeps telemetry canonical and quarantines late batches across separate writes', async () => {
    const { store } = await tempStore();
    store.addTelemetry([sampleAt(1764, '2026-09-30T08:10:00.000Z')]);
    const late = store.addTelemetry([
      sampleAt(1763, '2026-09-30T08:00:00.000Z'),
      sampleAt(1765, '2026-09-30T08:20:00.000Z')
    ]);

    expect(late.accepted.map(sample => sample.cycle)).toEqual([1765]);
    expect(late.quarantined).toHaveLength(1);
    expect(late.quarantined[0].reason).toBe('out_of_order');
    expect(store.telemetry.map(sample => sample.cycle)).toEqual([1764, 1765]);
  });

  it('is idempotent across re-submission and re-replay', async () => {
    const { store } = await tempStore();
    const sample = sampleAt(1764, '2026-09-30T08:10:00.000Z');
    const first = store.addTelemetry([sample]);
    const second = store.addTelemetry([sample]);

    expect(first.accepted).toHaveLength(1);
    expect(second.accepted).toHaveLength(0);
    expect(second.quarantined).toHaveLength(0);
    expect(second.duplicatesSkipped).toBe(1);
    expect(store.telemetry).toHaveLength(1);
  });

  it('recognizes a duplicate of an old key even after the high-water mark has advanced', async () => {
    const { store } = await tempStore();
    store.addTelemetry([sampleAt(1764, '2026-09-30T08:10:00.000Z')]);
    store.addTelemetry([sampleAt(1765, '2026-09-30T08:20:00.000Z')]);
    const resubmitted = store.addTelemetry([sampleAt(1764, '2026-09-30T08:10:00.000Z')]);

    expect(resubmitted.duplicatesSkipped).toBe(1);
    expect(resubmitted.quarantined).toHaveLength(0);
    expect(store.telemetry).toHaveLength(2);
    expect(store.quarantine).toHaveLength(0);
  });

  it('does not create duplicate quarantine entries on repeated late submissions', async () => {
    const { store } = await tempStore();
    store.addTelemetry([sampleAt(1764, '2026-09-30T08:10:00.000Z')]);
    const late = sampleAt(1763, '2026-09-30T08:00:00.000Z');
    store.addTelemetry([late]);
    store.addTelemetry([late]);

    expect(store.quarantine).toHaveLength(1);
  });

  it('canonicalizes and quarantines pre-existing disordered state on startup', async () => {
    const { dir } = await tempStore();
    const file = join(dir, 'state.json');
    const lateSample = sampleAt(1763, '2026-09-30T08:00:00.000Z');
    const highSample = sampleAt(1764, '2026-09-30T08:10:00.000Z');
    await writeFile(file, JSON.stringify({
      engines: [], telemetry: [highSample, lateSample, highSample], maintenance: [], models: [], assessments: [], predictions: [], audit: []
    }));

    const reopened = new LocalStore(file);
    await reopened.init();

    expect(reopened.telemetry.map(sample => sample.cycle)).toEqual([1764]);
    expect(reopened.quarantine).toHaveLength(1);
    expect(reopened.quarantine[0].reason).toBe('out_of_order');
  });
});

describe('import HTTP chain', () => {
  async function boot() {
    const { store, dir } = await tempStore();
    const app = await createApp(store);
    return { app, store, dir };
  }

  const engine = {
    id: 'ENG-HTTP-001', serialNumber: 'SN-1', model: 'AeroCore-X90', aircraftId: 'AC-1',
    installedAt: '2026-04-01', totalCycles: 10, status: 'healthy' as const, currentHealthScore: 90
  };

  it('accepts cycle 1764 then stably rejects the late 1763 batch without losing legal samples', async () => {
    const { app } = await boot();
    const first = await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: { engine, telemetry: [sampleAt(1764, '2026-09-30T08:10:00.000Z', { engineId: engine.id })] }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().telemetry.accepted).toBe(1);

    const late = await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: {
        engine,
        telemetry: [
          sampleAt(1763, '2026-09-30T08:00:00.000Z', { engineId: engine.id }),
          sampleAt(1765, '2026-09-30T08:20:00.000Z', { engineId: engine.id })
        ]
      }
    });
    const body = late.json();
    expect(late.statusCode).toBe(200);
    expect(body.telemetry.accepted).toBe(1);
    expect(body.telemetry.quarantined).toHaveLength(1);
    expect(body.telemetry.quarantined[0].reason).toBe('out_of_order');

    const telemetry = (await app.inject({ method: 'GET', url: `/api/engines/${engine.id}/telemetry` })).json();
    expect(telemetry.map((sample: TelemetrySample) => sample.cycle)).toEqual([1764, 1765]);

    const quarantine = (await app.inject({ method: 'GET', url: `/api/engines/${engine.id}/quarantine` })).json();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0].anomaly.type).toBe('out_of_order');

    await app.close();
  });

  it('duplicate submissions change nothing in storage or reads', async () => {
    const { app } = await boot();
    const payload = { engine, telemetry: [sampleAt(1764, '2026-09-30T08:10:00.000Z', { engineId: engine.id })] };
    await app.inject({ method: 'POST', url: '/api/engines/import', payload });
    const resubmit = await app.inject({ method: 'POST', url: '/api/engines/import', payload });

    expect(resubmit.json().telemetry.duplicatesSkipped).toBe(1);
    expect(resubmit.json().telemetry.accepted).toBe(0);
    const telemetry = (await app.inject({ method: 'GET', url: `/api/engines/${engine.id}/telemetry` })).json();
    expect(telemetry).toHaveLength(1);
    await app.close();
  });

  it('replay follows canonical order and assessment results survive a duplicate resubmission', async () => {
    const { app, store } = await boot();
    await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: {
        engine,
        telemetry: [
          sampleAt(1765, '2026-09-30T08:20:00.000Z', { engineId: engine.id }),
          sampleAt(1763, '2026-09-30T08:00:00.000Z', { engineId: engine.id }),
          sampleAt(1764, '2026-09-30T08:10:00.000Z', { engineId: engine.id })
        ]
      }
    });

    const replay = (await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/replay` })).json();
    expect(replay.next.cycle).toBe(1763);
    expect(replay.eventCount).toBe(3);

    const assessment = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment` });
    const scoreBefore = assessment.json().healthScore;

    // 整批重复提交不得改变任何评估结果。
    await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: {
        engine,
        telemetry: [
          sampleAt(1765, '2026-09-30T08:20:00.000Z', { engineId: engine.id }),
          sampleAt(1763, '2026-09-30T08:00:00.000Z', { engineId: engine.id }),
          sampleAt(1764, '2026-09-30T08:10:00.000Z', { engineId: engine.id })
        ]
      }
    });
    expect(store.telemetry).toHaveLength(3);
    const secondAssessment = (await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment` })).json();
    expect(secondAssessment.healthScore).toBe(scoreBefore);
    expect(secondAssessment.dataQuality.duplicatesSkipped).toBe(0);

    await app.close();
  });
});

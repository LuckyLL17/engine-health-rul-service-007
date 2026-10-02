import Fastify from 'fastify';
import cors from '@fastify/cors';
import { assessEngine, maintenanceWindows, predictRul, validateTelemetry } from './health.js';
import { LocalStore } from './store.js';
import { Engine, HealthAssessment, MaintenanceEvent, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

export async function createApp(store = new LocalStore()) {
  await store.init();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  const findEngine = (id: string) => store.engines.find(item => item.id === id);
  const requireEngine = (id: string): Engine => { const engine = findEngine(id); if (!engine) throw Object.assign(new Error('engine_not_found'), { statusCode: 404 }); return engine; };
  const requireAssessment = (id: string): HealthAssessment => { const assessment = store.assessments.find(item => item.engineId === id); if (!assessment) throw Object.assign(new Error('health_assessment_required'), { statusCode: 422 }); return assessment; };
  const requirePrediction = (id: string): RulPrediction => { const prediction = store.predictions.find(item => item.engineId === id); if (!prediction) throw Object.assign(new Error('rul_prediction_required'), { statusCode: 422 }); return prediction; };
  const findModel = (id?: string): ModelVersion => store.models.find(item => item.id === id) ?? store.models[store.models.length - 1];
  const fail = (message: string, statusCode = 404): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = statusCode; throw error; };

  app.get('/api/health', async () => ({ status: 'ok', service: 'engine-health-rul-service', storage: 'local-json', version: '0.1.0' }));
  app.get('/api/models', async () => store.models);
  app.get('/api/engines', async () => store.engines);
  app.post('/api/engines/import', async request => {
    const body = request.body as { engine: Engine; telemetry?: TelemetrySample[]; maintenance?: MaintenanceEvent[] };
    if (!body?.engine?.id) fail('engine.id is required', 400);
    if (!findEngine(body.engine.id)) store.addEngine(body.engine);
    const telemetryResult = body.telemetry?.length
      ? store.addTelemetry(body.telemetry)
      : { accepted: [], quarantined: [], duplicatesSkipped: 0, reorderedInBatch: 0 };
    const maintenanceResults = (body.maintenance ?? []).map(event => ({ event, outcome: store.addMaintenance(event) }));
    const conflict = maintenanceResults.find(item => item.outcome === 'conflict');
    if (conflict) fail(`maintenance_event_conflict: ${conflict.event.id}`, 409);
    store.log('engine_import', body.engine.id, {
      telemetrySubmitted: body.telemetry?.length ?? 0,
      telemetryAccepted: telemetryResult.accepted.length,
      duplicatesSkipped: telemetryResult.duplicatesSkipped,
      quarantined: telemetryResult.quarantined.map(item => ({ reason: item.reason, cycle: item.sample.cycle, timestamp: item.sample.timestamp })),
      reorderedInBatch: telemetryResult.reorderedInBatch,
      maintenance: maintenanceResults.length
    });
    await store.persist();
    return {
      engine: body.engine,
      telemetry: {
        submitted: body.telemetry?.length ?? 0,
        accepted: telemetryResult.accepted.length,
        duplicatesSkipped: telemetryResult.duplicatesSkipped,
        quarantined: telemetryResult.quarantined.map(item => ({ reason: item.reason, message: item.message, timestamp: item.sample.timestamp, cycle: item.sample.cycle })),
        reorderedInBatch: telemetryResult.reorderedInBatch
      },
      maintenance: { accepted: maintenanceResults.filter(item => item.outcome === 'added').length, duplicatesSkipped: maintenanceResults.filter(item => item.outcome === 'duplicate').length }
    };
  });
  app.get('/api/engines/:id', async request => { const id = (request.params as { id: string }).id; const engine = requireEngine(id); return { engine, latestAssessment: store.assessments.find(item => item.engineId === id), latestPrediction: store.predictions.find(item => item.engineId === id), telemetryCount: store.telemetry.filter(item => item.engineId === id).length, quarantinedCount: store.quarantine.filter(item => item.sample.engineId === id).length }; });
  app.get('/api/engines/:id/telemetry', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const query = request.query as { flightId?: string; limit?: string }; const rows = store.telemetry.filter(item => item.engineId === id && (!query.flightId || item.flightId === query.flightId)); return rows.slice(-(Number(query.limit) || 200)); });
  app.get('/api/engines/:id/quarantine', async request => { const id = (request.params as { id: string }).id; requireEngine(id); return store.quarantine.filter(item => item.sample.engineId === id).map(item => ({ reason: item.reason, message: item.message, rejectedAt: item.rejectedAt, timestamp: item.sample.timestamp, cycle: item.sample.cycle, anomaly: item.anomaly })); });
  app.post('/api/engines/:id/health-assessment', async request => { const id = (request.params as { id: string }).id; const engine = requireEngine(id); const body = (request.body ?? {}) as { modelId?: string; flightId?: string }; const rows = store.telemetry.filter(item => item.engineId === id && (!body.flightId || item.flightId === body.flightId)); if (!rows.length) fail('telemetry_not_found', 422); const assessment = assessEngine(engine, rows, findModel(body.modelId), store.maintenance.filter(item => item.engineId === id).length); engine.currentHealthScore = assessment.healthScore; engine.status = assessment.status; engine.lastAssessmentAt = assessment.createdAt; store.addAssessment(assessment); store.log('health_assessment', id, { assessmentId: assessment.assessmentId, modelVersion: assessment.modelVersion }); await store.persist(); return assessment; });
  app.post('/api/engines/:id/rul-prediction', async request => { const id = (request.params as { id: string }).id; const engine = requireEngine(id); const assessment = requireAssessment(id); const body = (request.body ?? {}) as { horizonCycles?: number; modelId?: string }; const prediction = predictRul(engine, assessment, Math.max(30, Math.min(body.horizonCycles ?? 240, 2000)), findModel(body.modelId)); store.addPrediction(prediction); store.log('rul_prediction', id, { predictionId: prediction.predictionId, estimatedRemainingCycles: prediction.estimatedRemainingCycles }); await store.persist(); return prediction; });
  app.post('/api/engines/:id/replay', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const rows = store.telemetry.filter(item => item.engineId === id); const body = (request.body ?? {}) as { speed?: number; cursor?: number }; return { id: `REPLAY-${Date.now()}`, engineId: id, status: 'ready', speed: body.speed ?? 1, cursor: body.cursor ?? 0, eventCount: rows.length, next: rows[body.cursor ?? 0] }; });
  app.post('/api/engines/:id/maintenance-simulation', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const prediction = requirePrediction(id); const body = (request.body ?? {}) as { delayCycles?: number }; const delay = Math.max(0, body.delayCycles ?? 0); return { engineId: id, delayCycles: delay, windows: maintenanceWindows({ ...prediction, estimatedRemainingCycles: prediction.estimatedRemainingCycles - delay, lowerBound: Math.max(1, prediction.lowerBound - delay), upperBound: Math.max(1, prediction.upperBound - delay) }), impact: { additionalRisk: Math.min(100, Math.round(delay / Math.max(prediction.estimatedRemainingCycles, 1) * 100)), recommendation: delay > prediction.lowerBound ? '延后超过寿命下界，不建议执行' : '当前延后仍在可评估范围内' } }; });
  app.post('/api/models/compare', async request => { const body = request.body as { engineId: string; modelIds?: string[] }; const engine = requireEngine(body.engineId); const rows = store.telemetry.filter(item => item.engineId === body.engineId); return (body.modelIds ?? store.models.map(item => item.id)).map(id => { const model = findModel(id); const result = assessEngine(engine, rows, model, store.maintenance.filter(item => item.engineId === engine.id).length); return { modelId: model.id, label: model.label, healthScore: result.healthScore, status: result.status, dataQuality: result.dataQuality.score, degradationSlope: result.indicators.degradationSlope }; }); });
  app.post('/api/maintenance-events', async request => { const event = request.body as MaintenanceEvent; requireEngine(event.engineId); const outcome = store.addMaintenance(event); if (outcome === 'conflict') fail('maintenance_event_conflict', 409); if (outcome === 'duplicate') return { event, outcome: 'duplicate' as const }; store.log('maintenance_event', event.engineId, { eventId: event.id, component: event.component }); await store.persist(); return { event, outcome: 'added' as const }; });
  app.get('/api/engines/:id/risk-events', async request => { const id = (request.params as { id: string }).id; const fromAssessments = store.assessments.filter(item => item.engineId === id).flatMap(item => item.anomalies); const fromQuarantine = store.quarantine.filter(item => item.sample.engineId === id).map(item => item.anomaly); return [...fromAssessments, ...fromQuarantine]; });
  app.get('/api/audit/:engineId', async request => store.audit.filter(item => item.engineId === (request.params as { engineId: string }).engineId));
  app.setErrorHandler((error: Error, _request, reply) => reply.code((error as Error & { statusCode?: number }).statusCode ?? 500).send({ error: error.message }));
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = await createApp();
  await app.listen({ host: '127.0.0.1', port: 6195 });
}

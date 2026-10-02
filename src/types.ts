export type FlightPhase = 'taxi' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'landing';
export type EngineStatus = 'healthy' | 'watch' | 'degraded' | 'critical';
export type Component = 'hot_section' | 'compressor' | 'bearing' | 'lubrication';

export type TelemetrySample = {
  engineId: string;
  flightId: string;
  timestamp: string;
  cycle: number;
  phase: FlightPhase;
  rpm: number;
  exhaustGasTemp: number;
  fuelFlow: number;
  vibration: number;
  oilPressure: number;
  oilTemperature: number;
  ambientTemperature: number;
  altitude: number;
  thrust: number;
};

export type MaintenanceEvent = {
  id: string;
  engineId: string;
  component: Component;
  occurredAt: string;
  action: 'inspection' | 'replacement' | 'repair' | 'calibration';
  severity: 'routine' | 'important' | 'mandatory';
  note: string;
};

export type Engine = {
  id: string;
  serialNumber: string;
  model: string;
  aircraftId: string;
  installedAt: string;
  totalCycles: number;
  status: EngineStatus;
  currentHealthScore: number;
  lastAssessmentAt?: string;
};

export type Anomaly = {
  id: string;
  engineId: string;
  timestamp: string;
  type: 'range_violation' | 'sensor_spike' | 'sensor_drift' | 'missing_interval' | 'phase_mismatch' | 'degradation' | 'order_violation' | 'duplicate_conflict';
  severity: 'low' | 'medium' | 'high';
  sensor?: string;
  message: string;
  evidence: Record<string, number | string>;
};

export type IngestRejectionReason = 'invalid_structure' | 'order_violation' | 'duplicate_conflict';

export type QuarantinedSample = {
  id: string;
  reason: IngestRejectionReason;
  receivedAt: string;
  engineId: string;
  timestamp: string;
  cycle: number;
  detail: string;
  sample: TelemetrySample;
};

export type ComponentRisk = {
  component: Component;
  score: number;
  status: EngineStatus;
  drivers: string[];
  estimatedCyclesToLimit: number;
};

export type HealthAssessment = {
  assessmentId: string;
  engineId: string;
  modelVersion: string;
  createdAt: string;
  sampleCount: number;
  healthScore: number;
  status: EngineStatus;
  dataQuality: { score: number; usableSamples: number; rejectedSamples: number; duplicateSamples: number; missingIntervals: number };
  indicators: {
    exhaustTemperatureMargin: number;
    fuelEfficiencyIndex: number;
    vibrationRisk: number;
    oilPressureMargin: number;
    degradationSlope: number;
  };
  componentRisks: ComponentRisk[];
  anomalies: Anomaly[];
  explanation: string[];
};

export type RulPrediction = {
  predictionId: string;
  engineId: string;
  modelVersion: string;
  createdAt: string;
  horizonCycles: number;
  estimatedRemainingCycles: number;
  confidence: number;
  lowerBound: number;
  upperBound: number;
  limitingComponent: Component;
  riskByHorizon: Array<{ cycle: number; healthScore: number; probabilityOfMaintenance: number }>;
  evidence: string[];
};

export type ReplayJob = {
  id: string;
  engineId: string;
  cursor: number;
  status: 'ready' | 'running' | 'paused' | 'completed';
  speed: number;
  eventCount: number;
  latest?: TelemetrySample;
};

export type ModelVersion = {
  id: string;
  label: string;
  weights: { temperature: number; fuel: number; vibration: number; oil: number; degradation: number };
  calibratedAt: string;
};

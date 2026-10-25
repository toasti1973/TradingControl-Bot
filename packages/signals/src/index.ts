export type {
  SignalAction, RawSignalPayload, TradeSignal,
  RiskProfile, CapitalSnapshot, MarketLimits,
  LimitingFactor, ScalingDecision, ScalingResult, ValidationResult,
} from './types.js';
export { STANDARD_RISIKOPROFIL } from './types.js';

export { SignalSchema } from './signal-schema.js';
export type { SchemaOptions } from './signal-schema.js';

export { SignalAuthenticator } from './authentication.js';
export type { AuthOptions, AuthResult, AuthFailure } from './authentication.js';

export { PositionScaler, pruefeUnveraendert } from './position-scaler.js';
export type { ScaleInput } from './position-scaler.js';

export { PlanBuilder } from './plan-builder.js';
export type { PlanBuildOptions, SignalHerkunft } from './plan-builder.js';

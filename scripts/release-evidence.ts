export type EvidenceStatus = 'passed' | 'failed' | 'not-verified';
type Placement = { mode: 'native-inline' | 'public-composer-dock'; status: EvidenceStatus };
/** Original design 3.2/15.8 allow a verified public seat when no suffix seat exists. */
export function resolveEtaPlacement(inline: EvidenceStatus, input: unknown): Placement {
  if (inline === 'passed') return { mode: 'native-inline', status: 'passed' };
  if (input == null) return { mode: 'public-composer-dock', status: 'not-verified' };
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid ETA placement evidence');
  const value = input as Record<string, unknown>, status = value.status ?? 'not-verified', spec = value.originalSpec;
  if (value.mode !== 'public-composer-dock' || typeof status !== 'string' || !['passed','failed','not-verified'].includes(status)) throw new TypeError('Invalid ETA placement mode/status');
  if (status === 'passed' && (value.publicSlot !== 'conversation.composer.dock' || value.nativeLineRewritten !== false
    || value.sdkContractVerified !== true || value.actualRenderObserved !== true || !Array.isArray(spec)
    || !['3.2','15.8'].every(section => spec.includes(section)))) throw new TypeError('A public fallback requires verified original-spec, SDK and actual-render evidence');
  return { mode: 'public-composer-dock', status: status as EvidenceStatus };
}

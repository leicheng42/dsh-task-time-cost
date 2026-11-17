export interface CopyableEstimate {
  /** The plain sentence shown to the user, e.g. 大概还要 8–15 分钟. */
  sentence: string;
  /** Completion clock range or single time, when known. */
  finish?: string | null;
  /** Distinct from the completion time: what has already been spent. */
  spent: string;
  cost?: string | null;
  tokens?: string | null;
  done?: boolean;
}

/**
 * The text a user pastes into a chat or a note. It repeats only what the panel
 * already shows, in the same order, so nothing is claimed in the copy that the
 * panel never said.
 */
export function estimateCopyText(input: CopyableEstimate): string {
  const parts = [input.done ? input.sentence : input.sentence];
  if (input.finish) parts.push(input.finish);
  const facts = [input.spent, input.cost, input.tokens].filter((value): value is string => !!value && value.trim().length > 0);
  if (facts.length > 0) parts.push(facts.join(' · '));
  return parts.join(' · ');
}

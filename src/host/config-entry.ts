import { PACKAGE_NAME } from '../shared/wire.ts';

/** Minimal Loader entry surface needed to persist plugin configuration. */
export interface ConfigEntryLike {
  options: { id: string; name?: string; config?: unknown };
  fiber?: unknown;
}

/** Minimal ConfigEditor surface used by the estimator management action. */
export interface ConfigEditorLike {
  entries(): ConfigEntryLike[];
  edit(entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}

/** A configuration save that must reach the user as a failure, not a success. */
export class ConfigSaveError extends Error {}

/**
 * The entry that owns this package. The ambient fiber entry is only a hint: it can
 * address a different plugin, so identity is always re-established by package name.
 */
export function ownerEntry(editor: ConfigEditorLike, ambient?: ConfigEntryLike | null): ConfigEntryLike {
  const owned = [ambient, ...editor.entries()].filter((entry): entry is ConfigEntryLike => !!entry && entry.options?.name === PACKAGE_NAME);
  const active = owned.find(entry => entry.fiber !== undefined) ?? owned[0];
  if (!active) throw new ConfigSaveError('The estimator Loader entry is unavailable, so configuration was not saved.');
  return active;
}

/**
 * Persist the full config through DSH and require the active entry to adopt exactly
 * that config. A file write that the running entry did not adopt is reported as a failure.
 */
export async function persistConfig(
  editor: ConfigEditorLike,
  ambient: ConfigEntryLike | null | undefined,
  config: Record<string, unknown>,
  validate: (value: unknown) => Record<string, unknown>,
): Promise<void> {
  const owner = ownerEntry(editor, ambient);
  await editor.edit(owner, () => ({ ...config }));
  const active = editor.entries().find(entry => entry.options?.name === PACKAGE_NAME);
  let applied: Record<string, unknown> | undefined;
  try { applied = validate(active?.options?.config); } catch { applied = undefined; }
  if (!applied || JSON.stringify(applied) !== JSON.stringify(config)) {
    throw new ConfigSaveError('The configuration file was written, but the active entry did not adopt it. Reopen DSH to apply the saved file.');
  }
}

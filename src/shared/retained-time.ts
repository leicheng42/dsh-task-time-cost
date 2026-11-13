import type { EstimateSnapshot, RetainedTimeForecast } from './wire.ts';
interface ForecastHistory { lastForecast?: RetainedTimeForecast | null; revisions?: readonly EstimateSnapshot[] }
/** Keep a display reference independently of the bounded audit revision list. */
export function retainedTimeForecast(snapshot: EstimateSnapshot, history?: ForecastHistory): RetainedTimeForecast | null {
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.state)) return null;
  if (snapshot.remainingMs && snapshot.remainingMs.high > 0) return { taskKey: snapshot.taskKey,
    remainingMs: { ...snapshot.remainingMs }, ...(snapshot.remainingTypicalMs !== undefined ? { remainingTypicalMs: snapshot.remainingTypicalMs } : {}), estimatedTotalMs: snapshot.estimatedTotalMs ? { ...snapshot.estimatedTotalMs } : null, updatedAt: snapshot.updatedAt };
  const previous = history?.lastForecast;
  if (previous?.taskKey === snapshot.taskKey && previous.remainingMs.high > 0 && previous.updatedAt <= snapshot.updatedAt) return previous;
  const last = history?.revisions?.findLast(item => item.taskKey === snapshot.taskKey && item.endedAt === null
    && item.updatedAt <= snapshot.updatedAt && item.remainingMs !== null && item.remainingMs.high > 0);
  return last?.remainingMs ? { taskKey: last.taskKey, remainingMs: { ...last.remainingMs },
    ...(last.remainingTypicalMs !== undefined ? { remainingTypicalMs: last.remainingTypicalMs } : {}),
    estimatedTotalMs: last.estimatedTotalMs ? { ...last.estimatedTotalMs } : null, updatedAt: last.updatedAt } : null;
}

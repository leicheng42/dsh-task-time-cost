import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-user-approval';

/** Answerers may claim the waterfall without next(); observers must wrap them. */
export function observeHumanWaits(ctx: Context, pause: (agent: Agent) => () => void): void {
  const around = async <T>(agent: Agent | undefined, next: () => Promise<T>): Promise<T> => {
    const resume = agent ? pause(agent) : undefined;
    try { return await next(); } finally { resume?.(); }
  };
  ctx.on('user-questions/request', (request, next) => around(request.agent, next), true);
  ctx.on('approval/request', (request, next) => around(request.agent, next), true);
}

/** The built-in blocking tool's durable lifetime also survives Host remounts. */
export const isBlockingQuestionTool = (name: string): boolean => name.split(/[.:/]/).at(-1) === 'ask_user_question';

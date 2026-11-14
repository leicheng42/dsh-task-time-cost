import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateWorkload } from '../../src/shared/workload.ts';
import { estimateWorkloadTime } from '../../src/shared/time.ts';
import { selectPerformance } from '../../src/shared/performance.ts';
import type { RouteIdentity } from '../../src/shared/types.ts';
import { foldFacts, initialFacts } from '../../src/host/facts.ts';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
const route: RouteIdentity = { providerId:'fast-provider', modelId:'fast-model', endpointFingerprint:'local', requestMode:'tool', reasoningEffort:'none',serviceTier:'standard' };
const objective = '实现完整可运行系统，四端（官网、商户端PC、师傅App、管理后台）共用真实后端和数据；全部页面接真实API，包含实时聊天、文件导出和上传，E2E与像素走查全部通过。可拆10–100个子任务，持续迭代，未达到DoD不得停止。private-value-never-persist';
const event = (type:string,seq:number,data:unknown) => ({type,seq,time:1000+seq,data}) as SessionEvent;
test('first estimate of a multi-app production system remains hour-scale even on a fast route',()=>{
 const plan=estimateWorkload({prompt:objective,currentInputTokens:2000},route);
 assert.equal(plan.kind,'code');
 assert.ok(plan.low.requests.length>=100,'A complete multi-app system must not inherit the short-task count');
 const time=estimateWorkloadTime(plan,()=>selectPerformance(route,[],[],1000,{heuristicTotalCallMs:1000}));
 assert.ok(time.typicalMs!==null&&time.typicalMs>=60*60_000,'An initial full-system reference cannot be seconds');
 assert.ok(plan.reasons.includes('scope-workload:program'));
 assert.equal(plan.origin,'heuristic');
 assert.ok(plan.sourceIds.includes('engineering-scope-program-v1'));
});
test('short stories and a small fix inside a large product do not inherit the program prior',()=>{
 for(const prompt of ['写200字睡前故事','解释一下多端系统是什么','给现有四端系统只修复一个按钮的拼写错误','请写一篇200字文章，介绍如何实现四端完整系统、真实API和E2E']){
  const plan=estimateWorkload({prompt,currentInputTokens:1000},route);
  assert.ok(!plan.reasons.includes('scope-workload:program'),prompt);
 }
});
test('Goal objectives reach the very first turn and its continuations without saving their contents',()=>{
 let state=initialFacts({id:'s',version:4,createdAt:1000,isSeeded:false} as SessionHeader,0);
 state=foldFacts(state,event('goal/change',0,{kind:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective,phase:'active',maxGoalRounds:16},roundsStarted:0,createdAt:1000,updatedAt:1000}),()=> 'unknown');
 state=foldFacts(state,event('turn/start',1,{turn:1}),()=> 'unknown');
 assert.equal(state.tasks['1'].workloadScale,'program','Scope must exist before the first goal round message');
 state=foldFacts(state,event('user/message',2,{role:'user',source:{kind:'goal',goalId:'g',revision:1,round:1},content:[{type:'text',text:'Continue the goal.'}]}),()=> 'unknown');
 assert.equal(state.tasks['1'].taskType,'code');
 assert.equal(state.tasks['1'].userMessages,0,'Automatic continuation is not a new human scope change');
 state=foldFacts(state,event('turn/end',3,{turn:1,reason:{kind:'completed'}}),()=> 'unknown');
 state=foldFacts(state,event('turn/start',4,{turn:2}),()=> 'unknown');
 assert.equal(state.tasks['2'].workloadScale,'program');
 assert.ok(!JSON.stringify(state).includes('private-value-never-persist'));
 const writingGoal = foldFacts(initialFacts({id:'writing',version:4,createdAt:1000,isSeeded:false} as SessionHeader,0), event('goal/change',0,{kind:'goal/change',version:1,operation:'create',goal:{id:'writing-goal',revision:1,objective:'写10000字故事',phase:'active',maxGoalRounds:2},roundsStarted:0,createdAt:1000,updatedAt:1000}),()=> 'writing');
 assert.equal(writingGoal.goal?.features.explicitOutputWords,10000);
 assert.equal(writingGoal.goal?.features.workloadScale,'task');
});

import test from 'node:test';import assert from 'node:assert/strict';
import { resolveEtaPlacement } from '../../scripts/release-evidence.ts';
const fallback = {mode:'public-composer-dock',status:'passed',publicSlot:'conversation.composer.dock',nativeLineRewritten:false,sdkContractVerified:true,actualRenderObserved:true,originalSpec:['3.2','15.8']};
test('release placement accepts the original permitted fallback without claiming native rewriting',()=>{
 assert.deepEqual(resolveEtaPlacement('failed',fallback),{mode:'public-composer-dock',status:'passed'});
 assert.deepEqual(resolveEtaPlacement('passed',null),{mode:'native-inline',status:'passed'});
 assert.equal(resolveEtaPlacement('failed',null).status,'not-verified');
 assert.equal(resolveEtaPlacement('failed',{...fallback,status:null}).status,'not-verified');
});
test('release placement rejects unsupported or unobserved fallback claims',()=>{
 for(const changed of [{actualRenderObserved:false},{sdkContractVerified:false},{nativeLineRewritten:true},{publicSlot:'private-dom'},{originalSpec:[]},{status:'maybe'}]) assert.throws(()=>resolveEtaPlacement('failed',{...fallback,...changed}));
});

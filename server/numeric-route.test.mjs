import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentServer} from './agent-server.mjs';
test('the retired diagnostic crop endpoint cannot read images or start a process',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tinylens-numeric-only-'));
 const bridge=await createAgentServer({stateDirectory:dir,spawnProcess(){assert.fail('The crop route must never start a process.')}});
 t.after(async()=>{await bridge.close();await rm(dir,{recursive:true,force:true})});
 await new Promise((resolve,reject)=>{bridge.server.once('error',reject);bridge.server.listen(0,'127.0.0.1',resolve)});
 const response=await fetch(`http://127.0.0.1:${bridge.server.address().port}/api/agent/panels?updateId=any`);
 assert.equal(response.status,410);assert.match((await response.json()).error,/numerical outputs/);
});

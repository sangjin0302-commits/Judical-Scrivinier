import test from "node:test";
import assert from "node:assert/strict";
import { withDriveSourceHealth } from "../db/drive-source-health.mjs";

const env = { DRIVE_DIAGNOSTIC_ENABLED: "true", DRIVE_DIAGNOSTIC_ADMIN_USER_IDS: "admin",
  VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "integration/civil-exam-only",
  VERCEL_BRANCH_URL: "civil-p1-mcp-test-git-integ-e09f5d-sangjin0302-commits-projects.vercel.app" };
const progress = { ok: true, attempted: 4 };

test("default off, production, wrong branch/host and ordinary users perform no diagnostic I/O", async () => {
  for (const [override, ownerId] of [[{DRIVE_DIAGNOSTIC_ENABLED:undefined},"admin"],
    [{DRIVE_DIAGNOSTIC_ADMIN_USER_IDS:""},"admin"], [{VERCEL_ENV:"production"},"admin"],
    [{VERCEL_GIT_COMMIT_REF:"other"},"admin"], [{VERCEL_BRANCH_URL:"other"},"admin"],
    [{},"ordinary"], [{},undefined]]) {
    assert.equal(await withDriveSourceHealth(progress, { env: {...env,...override}, ownerId,
      tokenProvider: async () => assert.fail("must not acquire token") }), progress);
  }
});

test("explicit Preview admin gets counts only with one read query and no content calls", async () => {
  const sourceHealth = await withDriveSourceHealth(progress, { env, ownerId:"admin",
    tokenProvider: async () => "private-token",
    pool: {query:async (query) => { assert.match(query.text,/^SELECT /); assert.equal(query.query_timeout,8000);
      return {rows:[{folderId:"private-folder",stage:"P1"}]}; }},
    listFiles: async (_folder, token) => {assert.equal(token,"private-token"); return [{documentId:"private-doc"}];},
  });
  assert.deepEqual(sourceHealth, {...progress,sourceHealth:{ok:true,readOnly:true,folders:[{stage:"P1",documentCount:1,ok:true}]}});
  assert.doesNotMatch(JSON.stringify(sourceHealth),/private/);
  assert.deepEqual(progress,{ok:true,attempted:4});
});

test("provider failure preserves progress and suppresses private exception text", async () => {
  const result = await withDriveSourceHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>{throw new Error("private-token");}});
  assert.equal(result.attempted,4);
  assert.equal(result.sourceHealth.code,"GOOGLE_AUTH_FAILED");
  assert.doesNotMatch(JSON.stringify(result),/private-token/);
});

test("slow provider is bounded and fetch receives abort signal", async () => {
  let signal;
  const result = await withDriveSourceHealth(progress,{env,ownerId:"admin",timeoutMs:20,
    fetchImpl:async (_url,options)=>{signal=options.signal;return new Promise(()=>{});},
    tokenProvider:async (_env,fetcher)=>fetcher("https://example.test"),
  });
  assert.equal(result.sourceHealth.code,"TIMEOUT");
  assert.equal(signal.aborted,true);
});

test("folder failures stay aggregate and do not suppress other folder checks", async () => {
  const result = await withDriveSourceHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>"token",
    pool:{query:async()=>({rows:[{folderId:"denied",stage:"P1"},{folderId:"allowed",stage:"P2"}]})},
    listFiles:async(id)=>{if(id==="denied")throw new Error("private-permission-details");return [{},{}];},
  });
  assert.equal(result.sourceHealth.ok,false);
  assert.deepEqual(result.sourceHealth.folders,[{stage:"P1",ok:false,code:"FOLDER_LIST_FAILED"},{stage:"P2",ok:true,documentCount:2}]);
  assert.doesNotMatch(JSON.stringify(result),/private|denied|allowed/);
});

test("registry failures preserve progress and do not attempt Drive listing", async () => {
  const result = await withDriveSourceHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>"token",
    pool:{query:async()=>{throw new Error("private-connection-string");}},
    listFiles:async()=>assert.fail("must not list without folder registry"),
  });
  assert.equal(result.sourceHealth.code,"FOLDER_REGISTRY_FAILED");
  assert.equal(result.attempted,4);
  assert.doesNotMatch(JSON.stringify(result),/private/);
});

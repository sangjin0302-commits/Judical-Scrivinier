import test from "node:test";
import assert from "node:assert/strict";
import { withDriveSourceHealth as actualHealth } from "../db/drive-source-health.mjs";
const withDriveSourceHealth = (progress, options) => actualHealth(progress, {
  checkFolder: async () => ({ mimeType: "application/vnd.google-apps.folder", trashed: false }), ...options,
});

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
  assert.deepEqual(sourceHealth, {...progress,sourceHealth:{ok:true,readOnly:true,folders:[{stage:"P1",documentCount:1,ok:true,folderVerified:true}]}});
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
  assert.deepEqual(result.sourceHealth.folders,[{stage:"P1",ok:false,code:"FOLDER_LIST_FAILED"},{stage:"P2",ok:true,documentCount:2,folderVerified:true}]);
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

test("Drive failures expose status and allowlisted reasons, never identifiers or messages", async () => {
  const result = await withDriveSourceHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>"private-token",
    pool:{query:async()=>({rows:[{folderId:"private-folder-123",stage:"P1"}]})},
    fetchImpl:async()=>new Response(JSON.stringify({error:{message:"private-folder private-token",
      errors:[{reason:"insufficientPermissions",message:"private-message"},{reason:"private-unknown-reason"}],
      details:[{reason:"ACCESS_TOKEN_SCOPE_INSUFFICIENT",metadata:{service:"private-service"}}]}}),{status:403}),
  });
  assert.deepEqual(result.sourceHealth.folders,[{stage:"P1",ok:false,code:"FOLDER_LIST_FAILED",
    httpStatus:403,reasons:["insufficientPermissions","ACCESS_TOKEN_SCOPE_INSUFFICIENT"]}]);
  assert.doesNotMatch(JSON.stringify(result),/private/);
});

test("non-JSON Drive error still exposes only status", async () => {
  const result = await withDriveSourceHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>"token",
    pool:{query:async()=>({rows:[{folderId:"folder-123456",stage:"P2"}]})},
    fetchImpl:async()=>new Response("private-html-error",{status:503}),
  });
  assert.deepEqual(result.sourceHealth.folders,[{stage:"P2",ok:false,code:"FOLDER_LIST_FAILED",httpStatus:503}]);
});

test("invalid registry folder ID gets a safe specific code without HTTP", async () => {
  const result = await withDriveSourceHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>"token",
    pool:{query:async()=>({rows:[{folderId:"bad",stage:"P1"}]})},
    fetchImpl:async()=>assert.fail("invalid folder must not reach provider"),
  });
  assert.deepEqual(result.sourceHealth.folders,[{stage:"P1",ok:false,code:"FOLDER_ID_INVALID"}]);
});

test("disabled Drive project number comes only from validated provider metadata", async () => {
  for (const [metadata, expected] of [
    [{service:"drive.googleapis.com",consumer:"projects/123456789012"},"123456789012"],
    [{service:"other.googleapis.com",consumer:"projects/123456789012"},undefined],
    [{service:"drive.googleapis.com",consumer:"projects/private-project-name"},undefined],
    [{service:"drive.googleapis.com",consumer:"https://private.example/projects/123"},undefined],
  ]) {
    const result = await withDriveSourceHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>"token",
      pool:{query:async()=>({rows:[{folderId:"folder-123456",stage:"P1"}]})},
      fetchImpl:async()=>Response.json({error:{message:"private-message",details:[
        {reason:"SERVICE_DISABLED",metadata:{...metadata,activationUrl:"https://private.example"}},
      ]}},{status:403}),
    });
    assert.equal(result.sourceHealth.folders[0].projectNumber,expected);
    assert.doesNotMatch(JSON.stringify(result),/private|activationUrl|consumer|service/);
  }
});

test("empty listing is accepted only after folder metadata verifies type and nontrashed state", async () => {
  const calls=[];
  const result=await actualHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>"token",
    pool:{query:async()=>({rows:[{folderId:"folder-123456",stage:"P1"}]})},
    fetchImpl:async(url)=>{calls.push(url);return url.includes("/files/folder-")
      ? Response.json({mimeType:"application/vnd.google-apps.folder",trashed:false}) : Response.json({files:[]});},
  });
  assert.equal(calls.length,2);
  assert.match(calls[0],/fields=mimeType%2Ctrashed/);
  assert.deepEqual(result.sourceHealth.folders,[{stage:"P1",documentCount:0,ok:true,folderVerified:true}]);
});

test("inaccessible and nonfolder sources cannot masquerade as empty folders", async () => {
  for(const metadata of [null,{mimeType:"application/vnd.google-apps.document",trashed:false},
    {mimeType:"application/vnd.google-apps.folder",trashed:true}]) {
    const result=await actualHealth(progress,{env,ownerId:"admin",tokenProvider:async()=>"token",
      pool:{query:async()=>({rows:[{folderId:"folder-123456",stage:"P1"}]})},
      fetchImpl:async()=>metadata ? Response.json(metadata) : Response.json({error:{message:"private-id",errors:[{reason:"notFound"}]}},{status:404}),
      listFiles:async()=>assert.fail("must not list inaccessible or invalid folder"),
    });
    assert.equal(result.sourceHealth.ok,false);
    assert.equal(result.sourceHealth.folders[0].code,metadata ? "FOLDER_INVALID_OR_TRASHED":"FOLDER_ACCESS_FAILED");
    assert.doesNotMatch(JSON.stringify(result),/private-id/);
  }
});

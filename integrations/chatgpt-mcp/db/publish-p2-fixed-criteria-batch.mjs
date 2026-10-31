import {publishP2FixedCriteria,p2PublicationDigest} from "./publish-p2-fixed-criteria.mjs";

// Trusted maintenance only. Existing per-source publisher keeps its validation;
// its transaction boundaries become savepoints inside one atomic batch.
export async function publishP2FixedCriteriaBatch(pool,inputs,{
  encryptionKey,encryptionKeyId,dryRun=true,activate=false,invariantSnapshot,
}={}){
  if(!Array.isArray(inputs)||!inputs.length||inputs.length>110||
      typeof dryRun!=="boolean"||typeof activate!=="boolean"||
      (invariantSnapshot!==undefined&&typeof invariantSnapshot!=="function")){
    throw new Error("invalid fixed criteria batch");
  }
  const identities=inputs.map(i=>JSON.stringify([i.subjectId,i.stableKey]));
  if(new Set(identities).size!==inputs.length)throw new Error("duplicate batch source");
  const ordered=inputs.map((input,index)=>({input,index,identity:identities[index]}))
    .sort((a,b)=>a.identity<b.identity?-1:a.identity>b.identity?1:0);
  const client=await pool.connect();
  let savepoint=null,sequence=0;
  const scopedPool={async connect(){return {release(){},async query(sql,values){
    if(sql==="BEGIN"){
      if(savepoint)throw new Error("nested publisher transaction");
      savepoint="fixed_criteria_item_"+(++sequence);
      return client.query("SAVEPOINT "+savepoint);
    }
    if(sql==="COMMIT"){
      if(!savepoint)throw new Error("missing publisher savepoint");
      const name=savepoint;savepoint=null;
      return client.query("RELEASE SAVEPOINT "+name);
    }
    if(sql==="ROLLBACK"){
      if(!savepoint)return {rows:[],rowCount:0};
      const name=savepoint;savepoint=null;
      await client.query("ROLLBACK TO SAVEPOINT "+name);
      return client.query("RELEASE SAVEPOINT "+name);
    }
    return client.query(sql,values);
  }};}};
  try{
    await client.query("BEGIN");
    const before=invariantSnapshot?await invariantSnapshot(client):undefined;
    const results=new Array(inputs.length);
    for(const {input,index} of ordered){
      results[index]=await publishP2FixedCriteria(scopedPool,input,
        {encryptionKey,encryptionKeyId,dryRun,activate});
    }
    if(invariantSnapshot){
      const after=await invariantSnapshot(client);
      if(before===undefined||after===undefined||p2PublicationDigest(before)!==p2PublicationDigest(after)){
        throw new Error("protected batch invariant changed");
      }
    }
    await client.query(dryRun?"ROLLBACK":"COMMIT");
    return {ok:true,dryRun,atomic:true,count:results.length,results,
      inserted:results.filter(r=>r.inserted).length,replayed:results.filter(r=>r.replayed).length,
      invariantVerified:Boolean(invariantSnapshot)};
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{client.release();}
}

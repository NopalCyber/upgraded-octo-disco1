'use strict';
async function run(db, args) {
  const [action,firmValue,waveValue='1',cohort='pilot']=args;
  if(!['view','enable','disable'].includes(action)||!/^\d+$/.test(firmValue||''))throw new Error('Usage: DATABASE_URL=... node scripts/experience-rollout.js view|enable|disable FIRM_ID [WAVE_1_TO_6] [COHORT]');
  const firmId=Number(firmValue),firm=await db.prepare('SELECT id,name FROM firms WHERE id=?').get(firmId);
  if(!firm)throw new Error('Firm not found.');
  if(action==='enable'){
    const wave=Number(waveValue);if(!Number.isInteger(wave)||wave<1||wave>6||cohort.length>100)throw new Error('Choose wave 1–6 and a cohort name of at most 100 characters.');
    await db.prepare(`INSERT INTO experience_rollouts(firm_id,enabled,wave,cohort) VALUES (?,1,?,?) ON CONFLICT(firm_id) DO UPDATE SET enabled=1,wave=excluded.wave,cohort=excluded.cohort,updated_at=utc_now_text()`).run(firmId,wave,cohort);
  }else if(action==='disable'){
    await db.prepare(`INSERT INTO experience_rollouts(firm_id,enabled) VALUES (?,0) ON CONFLICT(firm_id) DO UPDATE SET enabled=0,updated_at=utc_now_text()`).run(firmId);
    await db.prepare('DELETE FROM experience_workspace_overrides WHERE workspace_id IN (SELECT id FROM workspaces WHERE firm_id=?)').run(firmId);
  }
  return {firm,rollout:(await db.prepare('SELECT enabled,wave,cohort,updated_at FROM experience_rollouts WHERE firm_id=?').get(firmId))||null,
    environmentOverride:process.env.EXPERIENCE_ENABLED??null,note:'Presentation only. Canonical decisions, permissions and personal drafts are retained.'};
}
async function main(args){
  if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL explicitly to the intended database.');
  const {createDatabase}=require('../lib/pg');
  const db=createDatabase(process.env.DATABASE_URL,{max:2,applicationName:'iso27001-tool:experience-rollout'});
  try{
    await db.loadCatalog();
    return await db.transaction(async () => await run(db,args))();
  }finally{await db.close();}
}
if(require.main===module){
  main(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result,null,2));},error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={run};

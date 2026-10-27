'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const pg=require('pg');
const {bootApp}=require('./helpers');
const {databaseUrl,runId}=require('./pg-test-databases');
const root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'experience-upgrade-'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));

const unenforcedForeignKeys=`SELECT conrelid::regclass::text AS table_name, conname FROM pg_constraint
  WHERE contype='f' AND NOT convalidated
  UNION ALL
  SELECT tgrelid::regclass::text, tgname FROM pg_trigger WHERE tgenabled='D'
  ORDER BY 1,2`;

test('presentation rollback preserves governed records and personal drafts',async () => {
  const db=(await bootApp()).db;
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{try{const statement=prepare(sql),run=statement.run.bind(statement);statement.run=async (...args)=>{try{return await run(...args);}catch(error){throw new Error(`${error.message}; SQL: ${sql}`);}};return statement;}catch(error){throw new Error(`${error.message}; SQL: ${sql}`);}};
  const firmId=(await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  const user=Number((await db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES ('upgrade@example.test','!test','Upgrade manager',?,'firm','manager',1)").run(firmId)).lastInsertRowid);
  const reviewer=Number((await db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES ('upgrade-reviewer@example.test','!test','Independent reviewer',?,'firm','manager',1)").run(firmId)).lastInsertRowid);
  const client=Number((await db.prepare("INSERT INTO users(email,password_hash,name,user_type,active) VALUES ('upgrade-client@example.test','!test','Upgrade client','client',1)").run()).lastInsertRowid);
  const wsId=Number((await db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks,engagement_outcome) VALUES (?,'Existing governed client','[\"iso27001\"]','gap_assessment_only')").run(firmId)).lastInsertRowid);
  await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(wsId,client);
  const requirement=await db.prepare("SELECT r.* FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' ORDER BY r.id LIMIT 1").get();
  const pass=Number((await db.prepare("INSERT INTO assessment_passes(workspace_id,pass_number,label,status,started_by,completed_by,completed_at) VALUES (?,1,'Issued baseline','completed',?,?,'2026-07-01')").run(wsId,user,reviewer)).lastInsertRowid);
  const control=Number((await db.prepare("INSERT INTO control_instances(workspace_id,requirement_id,status,applicability,maturity,notes,review_status,reviewed_by,reviewed_at) VALUES (?,?,'implemented','applicable',3,'Recorded human conclusion','approved',?,'2026-07-01')").run(wsId,requirement.id,reviewer)).lastInsertRowid);
  await db.prepare("INSERT INTO control_state_history(workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes,assessment_answers,pass_id) VALUES (?,?,?,'Implemented','Applicable',3,'Historical assessment','{\"0\":\"yes\"}',?)").run(wsId,requirement.ref,user,pass);
  const evidence=Number((await db.prepare("INSERT INTO evidence(workspace_id,filename,stored_path,sha256,uploaded_by) VALUES (?,'Original evidence.pdf','fixture-original-evidence',?,?)").run(wsId,hash('original evidence bytes'),user)).lastInsertRowid);
  await db.prepare("INSERT INTO evidence_requirement_links(evidence_id,requirement_id,relevance_note,section_ref) VALUES (?,?,'Relevant sampled procedure','Page 4')").run(evidence,requirement.id);
  await db.prepare("INSERT INTO client_requests(workspace_id,title,request_type,status,created_by,assignee_id,response_note) VALUES (?,'Existing accepted response','evidence','accepted',?,?,'Accepted response bytes')").run(wsId,user,client);
  await db.prepare("INSERT INTO client_requests(workspace_id,title,request_type,status,created_by) VALUES (?,'Existing unreleased preparation','evidence','open',?)").run(wsId,user);
  const notification=Number((await db.prepare("INSERT INTO notifications(workspace_id,user_id,category,title,read_at) VALUES (?,?,'request','Historical update','2026-07-01')").run(wsId,client)).lastInsertRowid);
  await db.prepare("INSERT INTO notification_emails(notification_id,user_id,sent_at) VALUES (?,?,'2026-07-01')").run(notification,client);

  const tables=['control_instances','control_state_history','assessment_passes','evidence','evidence_requirement_links','client_requests','notifications','notification_emails'];
  const preserved=await Promise.all(
    tables.map(async table => {const columns=(await db.prepare(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position`).all(table)).map(row=>`"${row.name}"`);return {table,columns,rows:await db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY id`).all()};})
  );
  const recordVersion=(await db.prepare('SELECT record_version FROM control_instances WHERE id=?').get(control)).record_version;
  const drafts=require('../lib/form-drafts');
  const draft=await drafts.save(db,{workspaceId:wsId,actorId:user,kind:'assessment',recordId:requirement.ref,recordVersion},{payload:{notes:'New personal draft'},generation:0,expectedDraftVersion:0,baseVersion:recordVersion,clientSaveId:'upgrade-save'});
  assert.equal(draft.version,1);assert.equal((await db.prepare('SELECT notes FROM control_instances WHERE id=?').get(control)).notes,'Recorded human conclusion');
  const actor=await db.prepare('SELECT * FROM users WHERE id=?').get(user),ws=await db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const flag=require('../lib/experience-flags'),project=require('../lib/work-projection').listWork;
  const oldEnv=process.env.EXPERIENCE_ENABLED;
  try{
    process.env.EXPERIENCE_ENABLED='1';const enabled=await project({db,actor,workspaces:[ws],scope:'all',filters:{status:'all'}});
    assert.equal(await flag.enabledFor(db,{actor,workspace:ws}),true);
    const clientActor=await db.prepare('SELECT * FROM users WHERE id=?').get(client);
    assert.equal(await flag.enabledFor(db,{actor:clientActor,workspace:ws}),true,'client membership selects the workspace firm even when client firm_id is NULL');
    process.env.EXPERIENCE_ENABLED='0';assert.equal(await flag.enabledFor(db,{actor,workspace:ws}),false);
    assert.deepEqual((await project({db,actor,workspaces:[ws],scope:'all',filters:{status:'all'}})).items,enabled.items,'rollback changes presentation, never authorized work or source decisions');
    assert.equal((await drafts.get(db,{workspaceId:wsId,actorId:user,kind:'assessment',recordId:requirement.ref})).draft.payload.notes,'New personal draft');
  }finally{if(oldEnv===undefined)delete process.env.EXPERIENCE_ENABLED;else process.env.EXPERIENCE_ENABLED=oldEnv;}
  const rolloutCommand=require('../scripts/experience-rollout').run;
  const cohort=await rolloutCommand(db,['enable',String(firmId),'2','isolated-pilot']);
  assert.deepEqual([cohort.rollout.enabled,cohort.rollout.wave,cohort.rollout.cohort],[1,2,'isolated-pilot']);
  await db.prepare('INSERT INTO experience_workspace_overrides(workspace_id,enabled) VALUES (?,1)').run(wsId);
  const rollback=await rolloutCommand(db,['disable',String(firmId)]);
  assert.equal(rollback.rollout.enabled,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM experience_workspace_overrides WHERE workspace_id=?').get(wsId)).n,0);
  assert.equal((await drafts.get(db,{workspaceId:wsId,actorId:user,kind:'assessment',recordId:requirement.ref})).draft.payload.notes,'New personal draft');
  for(const saved of preserved)assert.deepEqual(await db.prepare(`SELECT ${saved.columns.join(',')} FROM ${saved.table} ORDER BY id`).all(),saved.rows,`${saved.table}: cohort rollback must not change governed records`);
  assert.deepEqual(await db.prepare(unenforcedForeignKeys).all(),[]);
});

test('blank install applies the complete pinned migration chain and clean integrity checks',async () => {
  const name=`isms_test_${runId()}_${Math.floor(Date.now()/1000)}_${crypto.randomBytes(4).toString('hex')}`;
  const admin=new pg.Client({connectionString:process.env.PG_TEST_URL,application_name:'isms-test-admin'});
  await admin.connect();
  try{
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'`);
    const script="(async()=>{const core=require('./db');await core.init();const db=core.db;"+
      "const latest=(await db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get()).id;"+
      "const foreignKeys=await db.prepare(process.env.FK_CHECK_SQL).all();"+
      "const pending=(await require('./migrations/run').applyPending(db)).applied;"+
      "console.log('UPGRADE_RESULT '+JSON.stringify({latest,foreignKeys,pending}));await db.close();})()"+
      ".catch(error=>{console.error(error&&error.stack||error);process.exit(1);});";
    const output=execFileSync(process.execPath,['-e',script],{cwd:root,env:{...process.env,DATABASE_URL:databaseUrl(name),
      ISMS_KEY_FILE:path.join(temp,'blank.key'),ISMS_DISABLE_JOBS:'1',PG_POOL_MAX:'2',FK_CHECK_SQL:unenforcedForeignKeys},encoding:'utf8'});
    const result=JSON.parse(output.match(/UPGRADE_RESULT (.+)/)[1]);
    const latestOnDisk=fs.readdirSync(path.join(root,'migrations')).filter(file=>/^\d+.*\.(sql|js)$/.test(file)).sort().pop();
    assert.equal(result.latest,latestOnDisk);assert.deepEqual(result.foreignKeys,[]);assert.equal(result.pending,0);
  }finally{
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(()=>{});
    await admin.end();
  }
});

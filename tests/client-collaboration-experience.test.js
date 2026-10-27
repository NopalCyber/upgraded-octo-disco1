'use strict';
const test=require('node:test');
const { openTestDb } = require('./helpers');
const assert=require('node:assert/strict');
const bcrypt=require('bcrypt');
const {bootClient,makeClient}=require('./helpers');
let env,db,manager,sponsor,contributor,other,workspace,firmId,managerId,sponsorId,contributorId,otherId;
let delivery,policy,drafts;

async function login(client,email){
  const page=await client.get('/login');
  const token=page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/)[1];
  assert.equal((await client.post('/login',{email,password:'client-experience-pass-123',_csrf:token},{csrf:false})).status,302);
  await client.get('/dashboard');
  await client.get(`/workspaces/${workspace.id}/client-portal`);
}
async function request(assignee=contributorId, status='open') {
  return Number((await db.prepare(`INSERT INTO client_requests(workspace_id,request_type,title,status,assignee_id,created_by)
    VALUES (?,'action','Confirm business context',?,?,?)`).run(workspace.id,status,assignee,managerId)).lastInsertRowid);
}
const actor=async id => await db.prepare('SELECT * FROM users WHERE id=?').get(id);
test.before(async()=>{
  env=await bootClient();manager=env.client;db=await openTestDb(env.dbUrl);
  delivery=require('../lib/notification-delivery');policy=require('../lib/client-request-policy');drafts=require('../lib/form-drafts');
  managerId=(await db.prepare("SELECT id FROM users WHERE email='sec-test@example.com'").get()).id;
  firmId=(await actor(managerId)).firm_id;
  const wsId=Number((await db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks,lead_consultant_id) VALUES (?,'Experience client','[]',?)`).run(firmId,managerId)).lastInsertRowid);
  workspace=await db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const hash=bcrypt.hashSync('client-experience-pass-123',4);
  for(const [email,name,role] of [['experience-sponsor@example.com','Client Sponsor','client_owner'],['experience-contributor@example.com','Assigned Contributor','contributor'],['experience-other@example.com','Other Contributor','contributor']]){
    const id=Number((await db.prepare("INSERT INTO users(email,password_hash,name,user_type,active) VALUES (?,?,?,'client',1)").run(email,hash,name)).lastInsertRowid);
    await db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,?)').run(wsId,id,role);
    if(role==='client_owner')sponsorId=id;else if(name==='Assigned Contributor')contributorId=id;else otherId=id;
  }
  sponsor=makeClient(env.app);contributor=makeClient(env.app);other=makeClient(env.app);
  await login(sponsor,'experience-sponsor@example.com');await login(contributor,'experience-contributor@example.com');await login(other,'experience-other@example.com');
});
test.after(async()=>{db?.close();for(const client of [sponsor,contributor,other,manager])await client?.close();});

test('released requests remain recoverable when a coordinator delegates to the unassigned team queue',async()=>{
  const id=await request();
  const release=await db.prepare('SELECT released_at FROM client_requests WHERE id=?').get(id);assert.ok(release.released_at);
  assert.equal((await sponsor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/assign`,{version:1,assignee_id:''})).status,302);
  assert.equal((await sponsor.get(`/workspaces/${workspace.id}/client-portal/requests/${id}`)).status,200);
  assert.equal((await contributor.get(`/workspaces/${workspace.id}/client-portal/requests/${id}`)).status,404);
  const list=await sponsor.get(`/workspaces/${workspace.id}/client-portal?view=actions`);
  assert.match(list.text,/Client coordinator to assign/);
  assert.equal((await sponsor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/assign`,{version:2,assignee_id:contributorId})).status,302);
  assert.equal((await contributor.get(`/workspaces/${workspace.id}/client-portal/requests/${id}`)).status,200);
  const unreleased=await request(null);
  assert.equal((await sponsor.get(`/workspaces/${workspace.id}/client-portal/requests/${unreleased}`)).status,404);
});

test('coordinators respond on behalf with attribution but cannot accept evidence even with a legacy manage override',async()=>{
  const id=await request();
  await db.prepare(`INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted) VALUES (?,?,'client_request.manage',1)`).run(workspace.id,sponsorId);
  const response=await sponsor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/transition`,{version:1,status:'submitted',response_note:'Confirmed with our operations lead.',evidence_quality:'sufficient'});
  assert.equal(response.status,302);
  const row=await db.prepare('SELECT * FROM client_requests WHERE id=?').get(id);
  assert.equal(row.responded_by,sponsorId);assert.equal(row.responded_for,contributorId);assert.equal(row.evidence_quality,'not_reviewed');
  const detail=await sponsor.get(`/workspaces/${workspace.id}/client-portal/requests/${id}`);
  assert.doesNotMatch(detail.text,/Consultant evidence-quality conclusion|name="status" value="accepted"/);
  assert.equal((await sponsor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/transition`,{version:2,status:'accepted',evidence_quality:'sufficient'})).status,403);
  assert.equal((await db.prepare('SELECT status FROM client_requests WHERE id=?').get(id)).status,'submitted');
  assert.equal((await manager.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/transition`,{version:2,status:'accepted'})).status,302);
});

test('event and notification recording roll back together, retry failures, and suppress duplicate deliveries',async()=>{
  const id=await request();
  const data={workspaceId:workspace.id,actorId:managerId,recipientIds:[contributorId],eventKey:'atomic-event',sourceType:'request',sourceId:id,title:'Please respond',body:'Shared context',link:`/workspaces/${workspace.id}/client-portal/requests/${id}`};
  await assert.rejects(db.transaction(async()=>{await delivery.enqueue(db,data);throw new Error('rollback');})(),/rollback/);
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM notification_outbox WHERE event_key='atomic-event'").get()).c,0);
  const [notificationId]=await delivery.enqueue(db,data);assert.deepEqual(await delivery.enqueue(db,data),[notificationId]);
  const now=new Date(Date.now()+1000);
  await delivery.dispatchPending(db,{now,send:async()=>({ok:false,error:'Temporary provider failure'})});
  let pending=await db.prepare('SELECT * FROM notification_outbox WHERE notification_id=?').get(notificationId);
  assert.equal(pending.status,'pending');assert.equal(pending.sent_at,null);assert.match(pending.last_error,/Temporary/);
  const successful=await delivery.dispatchPending(db,{now:new Date(Date.now()+3600000),send:async()=>({ok:true})});assert.ok(successful.sent>=1);
  pending=await db.prepare('SELECT * FROM notification_outbox WHERE notification_id=?').get(notificationId);assert.equal(pending.status,'sent');
  const again=await delivery.dispatchPending(db,{now:new Date(Date.now()+7200000),send:async()=>{throw new Error('Must not resend');}});assert.equal(again.sent,0);
});

test('updates are recipient-scoped and notification dispatch rechecks assignment',async()=>{
  const id=await request();const input={workspaceId:workspace.id,actorId:managerId,eventKey:'recheck-event',recipientIds:[contributorId],sourceType:'request',sourceId:id,title:'Private assigned work',link:`/workspaces/${workspace.id}/client-portal/requests/${id}`};
  const [notificationId]=await delivery.enqueue(db,input);
  assert.equal((await other.post(`/workspaces/${workspace.id}/client-portal/updates/${notificationId}/read`,{})).status,404);
  assert.equal((await contributor.post(`/workspaces/${workspace.id}/client-portal/updates/${notificationId}/read`,{})).status,302);
  assert.equal((await db.prepare('SELECT read_at FROM notifications WHERE id=?').get(notificationId)).read_at,null);
  assert.ok((await db.prepare('SELECT read_at FROM notification_receipts WHERE notification_id=? AND user_id=?').get(notificationId,contributorId)).read_at);
  await db.prepare('UPDATE client_requests SET assignee_id=? WHERE id=?').run(otherId,id);
  assert.equal((await delivery.list(db,{workspaceId:workspace.id,actor:await actor(contributorId)})).some(row=>row.id===notificationId),false);
  let sent=0;await delivery.dispatchPending(db,{now:new Date(Date.now()+1000),send:async()=>{sent++;return{ok:true};}});
  assert.equal((await db.prepare('SELECT status FROM notification_outbox WHERE notification_id=?').get(notificationId)).status,'cancelled');
});

test('request comments commit a private draft once and never notify clients about internal comments',async()=>{
  const id=await request();
  const c={workspaceId:workspace.id,actorId:contributorId,kind:'client-comment',recordId:String(id),contextKey:'',recordVersion:1};
  const saved=await drafts.save(db,c,{payload:{body:'Saved explanation'},generation:0,expectedDraftVersion:0,baseVersion:'1'});
  const body={body:'Old posted text',draft_id:saved.id,draft_version:saved.version,draft_generation:saved.generation,mutation_key:'same-comment'};
  const path=`/workspaces/${workspace.id}/client-portal/requests/${id}/comments`;
  assert.equal((await contributor.post(path,body)).status,302);assert.equal((await contributor.post(path,body)).status,302);
  const comments=await db.prepare("SELECT body FROM comments WHERE workspace_id=? AND parent_type='client_request' AND parent_id=?").all(workspace.id,String(id));
  assert.equal(comments.length,1);assert.equal(require('../lib/encryption').decryptIfNeeded(comments[0].body,workspace.id),'Saved explanation');
  const count=(await db.prepare('SELECT COUNT(*) c FROM notification_outbox WHERE recipient_id=?').get(contributorId)).c;
  assert.equal((await manager.post(path,{body:'Confidential internal reviewer note',internal_only:'1'})).status,302);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM notification_outbox WHERE recipient_id=?').get(contributorId)).c,count);
  const page=await contributor.get(`/workspaces/${workspace.id}/client-portal/requests/${id}`);
  assert.doesNotMatch(page.text,/Confidential internal reviewer note|Internal comment added/);
});

test('non-ISO client action page uses the common projection and has no fabricated engagement percentage',async()=>{
  const page=await sponsor.get(`/workspaces/${workspace.id}/client-portal?view=actions`);
  assert.equal(page.status,200);assert.match(page.text,/id="action-list"/);assert.match(page.text,/Waiting on others/);
  assert.doesNotMatch(page.text,/0 of 0 approved/);assert.match(page.text,/client-portal\/updates/);
});


test('an inline evidence upload rebases only its own current draft and preserves notes through submission',async()=>{
  const id=await request();
  const context={workspaceId:workspace.id,actorId:contributorId,kind:'client-response',recordId:String(id),contextKey:'',recordVersion:1};
  await drafts.save(db,context,{payload:{response_note:'Complete response saved before the upload.'},generation:0,expectedDraftVersion:0,baseVersion:'1'});
  const sponsorContext={...context,actorId:sponsorId};
  await drafts.save(db,sponsorContext,{payload:{response_note:'Independent coordinator draft'},generation:0,expectedDraftVersion:0,baseVersion:'1'});
  const page=await contributor.get(`/workspaces/${workspace.id}/client-portal/requests/${id}`);
  const token=page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/)[1];
  const boundary='client-experience-evidence-boundary';
  const multipart=[`--${boundary}`,'Content-Disposition: form-data; name="_csrf"','',token,`--${boundary}`,'Content-Disposition: form-data; name="file"; filename="business-context.txt"','Content-Type: text/plain','','Confirmed business context for the upload journey.',`--${boundary}--`,''].join('\r\n');
  const response=await contributor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/evidence`,multipart,{headers:{'content-type':`multipart/form-data; boundary=${boundary}`,accept:'application/json','x-csrf-token':token},csrf:false});
  assert.equal(response.status,200,response.text);
  const result=JSON.parse(response.text);assert.equal(result.ok,true);assert.equal(result.requestVersion,2);
  assert.equal(result.draft.draft.baseVersion,'2');assert.equal(result.draft.draft.payload.response_note,'Complete response saved before the upload.');
  assert.equal((await drafts.get(db,sponsorContext)).draft.baseVersion,'1','a different actor cannot be silently rebased');
  const saved=result.draft.draft;
  const submit=await contributor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/transition`,{status:'submitted',version:2,response_note:'stale posted response',draft_id:saved.id,draft_version:saved.version,draft_generation:saved.generation,mutation_key:'upload-then-submit'});
  assert.equal(submit.status,302,submit.text);
  const row=await db.prepare('SELECT response_note,status FROM client_requests WHERE id=?').get(id);
  assert.equal(row.status,'submitted');assert.equal(require('../lib/encryption').decryptIfNeeded(row.response_note,workspace.id),'Complete response saved before the upload.');
  assert.equal((await drafts.get(db,context)).draft,null);
});


test('client home presents a direct next-action link before programme and summary cards',async()=>{
  const id=await request();
  const page=await contributor.get(`/workspaces/${workspace.id}/client-portal`);
  assert.equal(page.status,200);const start=page.text.indexOf('id="client-next-action"');const end=page.text.indexOf('</section>',start);const action=page.text.slice(start,end);
  assert.ok(start>=0&&start<page.text.indexOf('class="cp-home-decisions"'));
  assert.match(action,/Your next action/);assert.match(action,/client-portal\/requests\/\d+/);assert.match(action,/Responsible:/);
  assert.doesNotMatch(action,/Engagement planning|No outstanding deliverable/);
});


test('policy approval recovers inline, enforces the current chain, and commits the version-specific note once',async()=>{
  const docId=Number((await db.prepare("INSERT INTO generated_docs(workspace_id,name,category,content,status,version,created_by) VALUES (?,'Client approval policy','Policy','<p>Mutable author draft</p>','in_review',1,?)").run(workspace.id,managerId)).lastInsertRowid);
  const versionId=Number((await db.prepare("INSERT INTO doc_versions(workspace_id,document_id,version,name,content,content_hash,status,created_by) VALUES (?,?,1,'Client approval policy','<p>Frozen policy for approval</p>','client-policy-hash','in_review',?)").run(workspace.id,docId,managerId)).lastInsertRowid);
  await db.prepare('UPDATE generated_docs SET current_version_id=? WHERE id=?').run(versionId,docId);
  const insert=db.prepare('INSERT INTO doc_approvers(workspace_id,document_id,version_id,sequence,user_id) VALUES (?,?,?,?,?)');
  await insert.run(workspace.id,docId,versionId,1,managerId);await insert.run(workspace.id,docId,versionId,2,sponsorId);
  const path=`/workspaces/${workspace.id}/documents/${docId}/decide`;
  let response=await sponsor.post(path,{decision:'approve',reason:'Review note to retain',expected_version_id:versionId});
  assert.equal(response.status,400);assert.match(response.text,/Approver #1 must decide first/);assert.match(response.text,/Review note to retain/);
  assert.match(response.text,/Frozen policy for approval/);assert.doesNotMatch(response.text,/Mutable author draft/);
  assert.equal((await db.prepare('SELECT decision FROM doc_approvers WHERE version_id=? AND user_id=?').get(versionId,sponsorId)).decision,null);
  assert.equal((await manager.post(path,{decision:'approve',expected_version_id:versionId})).status,302);
  response=await sponsor.post(path,{decision:'reject',reason:'',expected_version_id:versionId});assert.equal(response.status,422);assert.match(response.text,/Explain what must change/);
  const context={workspaceId:workspace.id,actorId:sponsorId,kind:'policy-decision',recordId:String(docId),contextKey:String(versionId),recordVersion:versionId};
  const saved=await drafts.save(db,context,{payload:{reason:'Clarify the policy owner and annual review procedure.'},generation:0,expectedDraftVersion:0,baseVersion:String(versionId)});
  const body={decision:'reject',reason:'Old posted reason',expected_version_id:versionId,draft_id:saved.id,draft_version:saved.version,draft_generation:saved.generation,mutation_key:'policy-changes'};
  response=await sponsor.post(path,body);assert.equal(response.status,302);assert.match(decodeURIComponent(response.location),/Changes requested/);
  assert.equal((await sponsor.post(path,body)).status,302);
  assert.equal((await db.prepare('SELECT decision_reason FROM doc_approvers WHERE version_id=? AND user_id=?').get(versionId,sponsorId)).decision_reason,'Clarify the policy owner and annual review procedure.');
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity_type='document' AND entity_id=? AND action='reject_document'").get(String(docId))).c,1);
  assert.equal((await db.prepare('SELECT status FROM generated_docs WHERE id=?').get(docId)).status,'draft');assert.equal((await drafts.get(db,context)).draft,null);
});

test('deliverable decisions preserve private notes, show every file, and remain idempotent across review handoffs',async()=>{
  await db.prepare('UPDATE workspaces SET frameworks=?,engagement_outcome=? WHERE id=?').run('["iso27001"]','certification_support',workspace.id);
  const ws={...(await db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspace.id)),frameworks:['iso27001']};
  await require('../lib/engagement-delivery').ensurePlan(db,ws,managerId);
  const parent=await db.prepare('SELECT plan_id,milestone_id FROM engagement_delivery_deliverables WHERE workspace_id=? ORDER BY id LIMIT 1').get(workspace.id);
  const id=Number((await db.prepare("INSERT INTO engagement_delivery_deliverables(workspace_id,plan_id,milestone_id,title,client_title,status,client_visible,owner_id,approver_id,requires_evidence) VALUES (?,?,?,'Complete client package','Complete client package','draft',1,?,?,1)").run(workspace.id,parent.plan_id,parent.milestone_id,contributorId,sponsorId)).lastInsertRowid);
  for(let n=1;n<=4;n++){const evidenceId=Number((await db.prepare('INSERT INTO evidence(workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description) VALUES (?,?,?,?,1,?,?)').run(workspace.id,`Complete-file-${n}.pdf`,`fixture-${n}`,`complete-hash-${n}`,contributorId,`File ${n} purpose`)).lastInsertRowid);await db.prepare('INSERT INTO engagement_delivery_evidence(workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)').run(workspace.id,id,evidenceId,contributorId);}
  const detail=`/workspaces/${workspace.id}/client-portal/deliverables/${id}`;
  let page=await contributor.get(detail);assert.equal(page.status,200);for(let n=1;n<=4;n++)assert.match(page.text,new RegExp(`Complete-file-${n}.pdf`));
  const version=(await db.prepare('SELECT row_version FROM engagement_delivery_deliverables WHERE id=?').get(id)).row_version;
  let context={workspaceId:workspace.id,actorId:contributorId,kind:'deliverable-decision',recordId:String(id),contextKey:'',recordVersion:version};
  let saved=await drafts.save(db,context,{payload:{note:'All four supporting files are ready for your review.'},generation:0,expectedDraftVersion:0,baseVersion:String(version)});
  const submit={row_version:version,note:'Old submission note',draft_id:saved.id,draft_version:saved.version,draft_generation:saved.generation,mutation_key:'deliverable-submit'};
  assert.equal((await contributor.post(detail+'/submit',submit)).status,302);assert.equal((await contributor.post(detail+'/submit',submit)).status,302);
  const row=await db.prepare('SELECT * FROM engagement_delivery_deliverables WHERE id=?').get(id);assert.equal(row.status,'submitted');assert.equal((await drafts.get(db,context)).draft,null);
  const stale=await sponsor.post(detail+'/changes',{row_version:version,note:'My feedback must remain available.'});assert.equal(stale.status,409);assert.match(stale.text,/My feedback must remain available/);assert.match(stale.text,/data-draft-recovery="true"/);
  context={...context,actorId:sponsorId,recordVersion:row.row_version};saved=await drafts.save(db,context,{payload:{note:'Please add the missing owner acknowledgement.'},generation:0,expectedDraftVersion:0,baseVersion:String(row.row_version)});
  const changes={row_version:row.row_version,note:'Old decision note',draft_id:saved.id,draft_version:saved.version,draft_generation:saved.generation,mutation_key:'deliverable-changes'};
  assert.equal((await sponsor.post(detail+'/changes',changes)).status,302);assert.equal((await sponsor.post(detail+'/changes',changes)).status,302);
  const updated=await db.prepare('SELECT status,decision_note FROM engagement_delivery_deliverables WHERE id=?').get(id);assert.equal(updated.status,'changes_requested');assert.equal(updated.decision_note,'Please add the missing owner acknowledgement.');
  await db.prepare('UPDATE workspaces SET frameworks=? WHERE id=?').run('[]',workspace.id);
});


test('presentation rollback restores the previous portal layout while preserving released-work and decision authority',async()=>{
  const previous=process.env.EXPERIENCE_ENABLED;process.env.EXPERIENCE_ENABLED='0';
  try{
    const id=await request(contributorId,'submitted');
    const page=await sponsor.get(`/workspaces/${workspace.id}/client-portal?view=actions`);
    assert.equal(page.status,200);assert.match(page.text,/id="requests"/);assert.doesNotMatch(page.text,/id="action-list"/);
    const detail=await sponsor.get(`/workspaces/${workspace.id}/client-portal/requests/${id}`);
    assert.equal(detail.status,200);assert.doesNotMatch(detail.text,/name="status" value="accepted"/);
    assert.equal((await sponsor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/transition`,{version:1,status:'accepted'})).status,403);
    assert.equal((await db.prepare('SELECT status FROM client_requests WHERE id=?').get(id)).status,'submitted');
  }finally{if(previous===undefined)delete process.env.EXPERIENCE_ENABLED;else process.env.EXPERIENCE_ENABLED=previous;}
});

test('failed request and comment transitions retain effective saved text for no-JavaScript recovery',async()=>{
  const id=await request();const ctx={workspaceId:workspace.id,actorId:contributorId,kind:'client-response',recordId:String(id),contextKey:'',recordVersion:1};
  const saved=await drafts.save(db,ctx,{payload:{response_note:'The full saved response must survive a stale record.'},generation:0,expectedDraftVersion:0,baseVersion:'1'});
  await db.prepare('UPDATE client_requests SET version=version+1 WHERE id=?').run(id);
  const page=await contributor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/transition`,{version:1,status:'submitted',response_note:'Outdated posted note',draft_id:saved.id,draft_version:saved.version,draft_generation:saved.generation});
  assert.equal(page.status,409);assert.match(page.text,/The full saved response must survive a stale record/);
  const c={...ctx,kind:'client-comment',recordVersion:2};const comment=await drafts.save(db,c,{payload:{body:'A retained saved discussion note.'},generation:0,expectedDraftVersion:0,baseVersion:'2'});
  await db.prepare('UPDATE client_requests SET version=version+1 WHERE id=?').run(id);
  const failure=await contributor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/comments`,{body:'Old comment',draft_id:comment.id,draft_version:comment.version,draft_generation:comment.generation});
  assert.equal(failure.status,409);assert.match(failure.text,/A retained saved discussion note/);
});


test('email retries reuse a stable recipient-channel idempotency key and Resend receives it',async()=>{
  const id=await request();const [notificationId]=await delivery.enqueue(db,{workspaceId:workspace.id,actorId:managerId,recipientIds:[contributorId],eventKey:'provider-retry-key',sourceType:'request',sourceId:id,title:'Retry stable key',link:`/workspaces/${workspace.id}/client-portal/requests/${id}`});
  const keys=[];await delivery.dispatchPending(db,{now:new Date(Date.now()+1000),send:async input=>{if(input.title==='Retry stable key')keys.push(input.idempotencyKey);return{ok:false,error:'Fixture retry'};}});
  await delivery.dispatchPending(db,{now:new Date(Date.now()+3600000),send:async input=>{if(input.title==='Retry stable key')keys.push(input.idempotencyKey);return{ok:true};}});
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.match(keys[0],/^outbox:[a-f0-9]{64}$/);
  const names=['EMAIL_DELIVERY_DISABLED','BREVO_API_KEY','GMAIL_USER','GMAIL_APP_PASSWORD','RESEND_API_KEY'];const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));const oldFetch=global.fetch;let header;
  try{
    names.forEach(name=>delete process.env[name]);process.env.RESEND_API_KEY='mock-provider-key';
    global.fetch=async(url,input)=>{assert.equal(url,'https://api.resend.com/emails');header=input.headers['Idempotency-Key'];return{ok:true,json:async()=>({id:'mock-message'})};};
    const result=await require('../lib/email').sendNotificationEmail({toEmail:'fixture@example.com',title:'Fixture only',body:'No email sent',firmId,workspaceId:workspace.id,idempotencyKey:keys[0]});
    assert.equal(result.ok,true);assert.equal(header,keys[0]);
  }finally{global.fetch=oldFetch;for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}
});

test('a same-firm lead without workspace membership cannot read work or receive its notifications',async () => {
  const id=await request();
  const unaffiliatedId=Number((await db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES ('unaffiliated-lead@example.com','fixture-only','Unassigned lead',?,'firm','consultant',1)").run(firmId)).lastInsertRowid);
  const previous=(await db.prepare('SELECT lead_consultant_id FROM workspaces WHERE id=?').get(workspace.id)).lead_consultant_id;
  await db.prepare('UPDATE workspaces SET lead_consultant_id=? WHERE id=?').run(unaffiliatedId,workspace.id);
  try{
    const ws=await db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspace.id),person=await actor(unaffiliatedId),row=await db.prepare('SELECT * FROM client_requests WHERE id=?').get(id);
    assert.equal((await policy.requestPolicy({db,workspace:ws,actor:person,row})).visible,false);
    assert.equal(await delivery.canRead(db,person,{workspace_id:workspace.id,user_id:unaffiliatedId,source_type:'request',source_id:id}),false);
    assert.deepEqual(await delivery.enqueue(db,{workspaceId:workspace.id,actorId:managerId,recipientIds:[unaffiliatedId],eventKey:'unaffiliated-lead',sourceType:'request',sourceId:id,title:'Must remain scoped',link:`/workspaces/${workspace.id}/client-portal/requests/${id}`}),[]);
  }finally{await db.prepare('UPDATE workspaces SET lead_consultant_id=? WHERE id=?').run(previous,workspace.id);}
});

test('cached role and activity values cannot preserve revoked notification or work authority',async () => {
  const cachedManager=await actor(managerId),cachedContributor=await actor(contributorId),id=await request();
  const row=await db.prepare('SELECT * FROM client_requests WHERE id=?').get(id);
  try{
    await db.prepare("UPDATE users SET firm_role='consultant' WHERE id=?").run(managerId);
    assert.equal((await policy.requestPolicy({db,workspace,actor:cachedManager,row})).visible,false);
    assert.equal(await delivery.canRead(db,cachedManager,{workspace_id:workspace.id,user_id:managerId,source_type:'request',source_id:id}),false);
    await db.prepare('UPDATE users SET active=0 WHERE id=?').run(contributorId);
    assert.equal((await policy.requestPolicy({db,workspace,actor:cachedContributor,row})).visible,false);
  }finally{await db.prepare('UPDATE users SET firm_role=? WHERE id=?').run(cachedManager.firm_role,managerId);await db.prepare('UPDATE users SET active=1 WHERE id=?').run(contributorId);}
});

test('draft endpoints are private, read-only on GET, and deny revoked response authority or membership',async()=>{
  const id=await request(),path=`/workspaces/${workspace.id}/client-portal/form-drafts/client-response/${id}`;
  const before=(await db.prepare('SELECT COUNT(*) c FROM form_drafts').get()).c;
  assert.equal((await contributor.get(path)).status,200);assert.equal((await db.prepare('SELECT COUNT(*) c FROM form_drafts').get()).c,before);
  const saved=await contributor.put(path,{payload:{response_note:'Private response owned by this actor'},generation:0,expectedDraftVersion:0,baseVersion:'1'},{json:true,csrf:true});assert.equal(saved.status,200,saved.text);
  const hidden=await other.get(path);assert.equal(hidden.status,403);assert.doesNotMatch(hidden.text,/Private response owned by this actor/);
  await db.prepare("INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted) VALUES (?,?,'client_request.respond',0)").run(workspace.id,contributorId);
  try{assert.equal((await contributor.get(path)).status,403);assert.equal((await contributor.put(path,{payload:{response_note:'Must not update'},generation:0,expectedDraftVersion:1,baseVersion:'1'},{json:true,csrf:true})).status,403);}
  finally{await db.prepare("DELETE FROM workspace_role_overrides WHERE workspace_id=? AND user_id=? AND permission='client_request.respond'").run(workspace.id,contributorId);}
  await db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(workspace.id,contributorId);
  try{assert.ok([403,404].includes((await contributor.get(path)).status));}
  finally{await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'contributor')").run(workspace.id,contributorId);}
  assert.equal((await drafts.get(db,{workspaceId:workspace.id,actorId:contributorId,kind:'client-response',recordId:String(id),contextKey:''})).draft.payload.response_note,'Private response owned by this actor');
});

test('deliverable draft access respects outcome scope and revoked decision permission',async()=>{
  const original=await db.prepare('SELECT frameworks,engagement_outcome FROM workspaces WHERE id=?').get(workspace.id);
  const row=await db.prepare("SELECT d.id FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones m ON m.id=d.milestone_id JOIN engagement_delivery_phases p ON p.id=m.phase_id WHERE d.workspace_id=? AND p.phase_key!='gap_assessment' LIMIT 1").get(workspace.id);assert.ok(row);
  await db.prepare('UPDATE workspaces SET frameworks=?,engagement_outcome=? WHERE id=?').run('["iso27001"]','certification_support',workspace.id);
  await db.prepare("UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,client_visible=1,status='submitted' WHERE id=?").run(contributorId,sponsorId,row.id);
  const endpoint=`/workspaces/${workspace.id}/client-portal/form-drafts`;
  try{
    assert.equal((await sponsor.get(`${endpoint}/deliverable-decision/${row.id}`)).status,200);
    await db.prepare("INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted) VALUES (?,?,'client_request.respond',0)").run(workspace.id,sponsorId);
    assert.equal((await sponsor.get(`${endpoint}/deliverable-decision/${row.id}`)).status,403);
    await db.prepare("UPDATE workspaces SET engagement_outcome='gap_assessment_only' WHERE id=?").run(workspace.id);
    assert.equal((await contributor.get(`${endpoint}/deliverable-comment/${row.id}`)).status,403);
  }finally{await db.prepare("DELETE FROM workspace_role_overrides WHERE workspace_id=? AND user_id=? AND permission='client_request.respond'").run(workspace.id,sponsorId);await db.prepare('UPDATE workspaces SET frameworks=?,engagement_outcome=? WHERE id=?').run(original.frameworks,original.engagement_outcome,workspace.id);}
});

test('a released policy request cannot bypass revoked client portal notification access',async () => {
  const doc=await db.prepare('SELECT id FROM generated_docs WHERE workspace_id=? LIMIT 1').get(workspace.id);assert.ok(doc);
  const id=await request();await db.prepare('UPDATE client_requests SET document_id=? WHERE id=?').run(doc.id,id);
  const notification={workspace_id:workspace.id,user_id:contributorId,source_type:'policy',source_id:doc.id};
  assert.equal(await delivery.canRead(db,await actor(contributorId),notification),true);
  await db.prepare("INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted) VALUES (?,?,'client_portal.view',0)").run(workspace.id,contributorId);
  try{assert.equal(await delivery.canRead(db,await actor(contributorId),notification),false);}
  finally{await db.prepare("DELETE FROM workspace_role_overrides WHERE workspace_id=? AND user_id=? AND permission='client_portal.view'").run(workspace.id,contributorId);}
});

test('create-only and cancel-only firm permissions remain independent across lists, drafts and commands',async()=>{
  const clients=[];
  try{
    for(const capability of ['create','cancel']){
      const email=`request-${capability}@experience.example.test`;
      const id=Number((await db.prepare("INSERT INTO users(email,password_hash,name,user_type,firm_id,firm_role,active) VALUES (?,?,?,'firm',?,'consultant',1)").run(email,bcrypt.hashSync('client-experience-pass-123',4),`Request ${capability}`,firmId)).lastInsertRowid);
      await db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')").run(workspace.id,id);
      for(const permission of ['manage','respond','review','coordinate'])await db.prepare('INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted) VALUES (?,?,?,0)').run(workspace.id,id,`client_request.${permission}`);
      await db.prepare('INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted) VALUES (?,?,?,1)').run(workspace.id,id,`client_request.${capability}`);
      const client=makeClient(env.app);clients.push(client);await login(client,email);
      const portal=await client.get(`/workspaces/${workspace.id}/client-portal?view=actions`);assert.equal(portal.status,200);
      assert.equal(portal.text.includes('id="new-request"'),capability==='create');
      const rowId=await request();const detail=`/workspaces/${workspace.id}/client-portal/requests/${rowId}`;
      const row=await db.prepare('SELECT * FROM client_requests WHERE id=?').get(rowId);
      const commands=(await policy.requestPolicy({db,workspace,actor:await actor(id),row})).commands;
      assert.deepEqual(commands,capability==='cancel'?['cancelled']:[]);
      const page=await client.get(detail);assert.equal(page.status,200);assert.equal(page.text.includes('value="cancelled"'),capability==='cancel');
      const create=await client.post(`/workspaces/${workspace.id}/client-portal/requests`,{request_type:'action',title:`Created with ${capability} permission`});assert.equal(create.status,capability==='create'?302:403);
      const draft=await client.get(`/workspaces/${workspace.id}/client-portal/form-drafts/client-response/${rowId}`);assert.equal(draft.status,capability==='cancel'?200:403);
      const cancel=await client.post(detail+'/transition',{version:row.version,status:'cancelled',response_note:'Client no longer needs this request.'});assert.equal(cancel.status,capability==='cancel'?302:403);
      assert.equal((await db.prepare('SELECT status FROM client_requests WHERE id=?').get(rowId)).status,capability==='cancel'?'cancelled':'open');
      const pending=await request(null);const version=(await db.prepare('SELECT version FROM client_requests WHERE id=?').get(pending)).version;
      const pendingPage=await client.get(`/workspaces/${workspace.id}/client-portal/requests/${pending}`);assert.equal(pendingPage.status,200);assert.equal(pendingPage.text.includes('Share with client team'),capability==='create');
      const release=await client.post(`/workspaces/${workspace.id}/client-portal/requests/${pending}/release`,{version});assert.equal(release.status,capability==='create'?302:403);
    }
    const id=await request();const row=await db.prepare('SELECT * FROM client_requests WHERE id=?').get(id);
    assert.equal((await policy.requestCapabilities({db,workspace,actor:await actor(sponsorId)})).canCreate,false);
    assert.ok(!(await policy.requestPolicy({db,workspace,actor:await actor(sponsorId),row})).commands.includes('cancelled'));
    assert.equal((await sponsor.post(`/workspaces/${workspace.id}/client-portal/requests`,{request_type:'action',title:'Client legacy manage cannot create'})).status,403);
    assert.equal((await sponsor.post(`/workspaces/${workspace.id}/client-portal/requests/${id}/transition`,{version:row.version,status:'cancelled'})).status,403);
  }finally{for(const client of clients)await client.close();}
});

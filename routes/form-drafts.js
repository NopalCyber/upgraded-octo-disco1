'use strict';
const drafts = require('../lib/form-drafts');
const rbac = require('../lib/rbac');

function register(app, deps) {
  const {db,requireAuth,requireWorkspace} = deps;
  async function target(req, res) {
    const kind=req.params.kind,recordId=String(req.params.recordId);
    const ws=req.workspace,actor=req.user;
    const authority=await require('../lib/client-work-policy').actorContext(db,ws,actor);
    if(!authority.active)throw drafts.failure('This workspace is no longer available to your account.',403);
    const perms=authority.permissions;
    const can=p=>rbac.hasPermission(perms,p);
    let record, contextKey='';
    if (kind==='assessment' && authority.firm && can('control.view') && can('control.update')) {
      record=await db.prepare(`SELECT i.id,COALESCE(c.record_version,0) version FROM iso_items i
        LEFT JOIN v_control_states c ON c.workspace_id=? AND c.iso_item_id=i.id
        WHERE i.id=? AND i.type IN ('clause','control')`).get(ws.id,recordId);
      contextKey=String((await db.prepare("SELECT id FROM assessment_passes WHERE workspace_id=? AND status='in_progress' ORDER BY pass_number DESC LIMIT 1").get(ws.id))?.id || '');
    } else if (['client-response','client-comment'].includes(kind)) {
      record=await db.prepare('SELECT * FROM client_requests WHERE workspace_id=? AND id=?').get(ws.id,recordId);
      if (record) {
        const policy=await require('../lib/client-request-policy').requestPolicy({db,workspace:ws,actor,row:record});
        if (!policy.visible || (kind==='client-response' ? !policy.canRespond && !policy.commands.length : !can('client_request.respond'))) record=null;
      }
    } else if (kind==='policy-decision' && can('document.review')) {
      record=await db.prepare('SELECT id,current_version_id version FROM generated_docs WHERE workspace_id=? AND id=?').get(ws.id,recordId);
      if (record) {
        const policy=await require('../lib/client-work-policy').clientWorkPolicy({db,workspace:ws,actor,sourceType:'document_approval',row:{id:record.id,workspace_id:ws.id}});
        if (!policy.commands.some(c=>['approve','changes'].includes(c))) record=null;
        else contextKey=String(record.version);
      }
    } else if ((kind==='deliverable-comment' && can('comment.create') && can('client_request.respond')) || kind==='deliverable-decision') {
      record=await db.prepare(`SELECT d.*,p.workspace_id FROM engagement_delivery_deliverables d
        JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
        JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
        JOIN engagement_delivery_plans p ON p.id=ph.plan_id WHERE p.workspace_id=? AND d.id=?`).get(ws.id,recordId);
      if (record) {
        const policy=await require('../lib/client-work-policy').clientWorkPolicy({db,workspace:ws,actor,sourceType:'deliverable',row:record});
        if (!(await require('../lib/engagement-delivery').isDeliverableInOutcomeScope(db,ws,record.id)) || !policy.visible || (kind==='deliverable-decision' && !policy.commands.some(c=>['submit','accept','changes'].includes(c)))) record=null;
      }
    }
    if (!record) throw drafts.failure('This draft is not available to your account.',403);
    return {workspaceId:ws.id,actorId:actor.id,kind,recordId,contextKey,recordVersion:record.version ?? record.row_version ?? 0,encryptionEnabled:!!ws.encryption_enabled};
  }
  async function assessmentContext(c, key) {
    if (c.kind!=='assessment') throw drafts.failure('Historical draft contexts are unavailable for this form.',422);
    const value=String(key ?? '');
    if (value!=='' && (!/^\d+$/.test(value) || !(await db.prepare('SELECT 1 FROM assessment_passes WHERE workspace_id=? AND id=?').get(c.workspaceId,value)))) throw drafts.failure('This assessment context is unavailable.',403);
    return value;
  }
  async function priorDrafts(c) {
    if (c.kind!=='assessment') return [];
    return (await Promise.all((await drafts.previous(db,c)).map(async d => {
      if(d.contextKey==='')return [{...d,label:'Before an assessment pass was started'}];
      const pass=await db.prepare('SELECT pass_number,status FROM assessment_passes WHERE workspace_id=? AND id=?').get(c.workspaceId,d.contextKey);
      return pass?[{...d,label:`Pass ${pass.pass_number} (${pass.status.replaceAll('_',' ')})`}]:[];
    }))).flat();
  }
  function handler(action) { return async (req, res) => {
    try {
      const c=await target(req,res);
      if (req.body?.contextKey != null && String(req.body.contextKey)!==c.contextKey) throw drafts.failure('The assessment pass changed. Your previous draft is retained; reopen it in its original pass.');
      let value;
      if (action==='get') { const selected=req.query.contextKey===undefined?c:{...c,contextKey:await assessmentContext(c,req.query.contextKey)};value={...(await drafts.get(db,selected)),selectedContextKey:selected.contextKey,previousDrafts:await priorDrafts(c)}; }
      else if (action==='recover') {await assessmentContext(c,req.body.sourceContextKey);value={draft:await drafts.recover(db,c,req.body)};}
      else if (action==='save') value={draft:await drafts.save(db,c,req.body)};
      else value=await drafts.discard(db,c,req.body);
      res.set('Cache-Control','no-store').json({...value,contextKey:c.contextKey,recordVersion:c.recordVersion});
    } catch(e) { res.status(e.status||500).json({error:e.status?e.message:'The draft could not be saved. Your edits are still on this screen.',code:e.code||'draft_error'}); }
  }; }
  for (const prefix of ['/workspaces/:wsId/form-drafts','/workspaces/:wsId/client-portal/form-drafts']) {
    app.get(prefix+'/:kind/:recordId',requireAuth,requireWorkspace,handler('get'));
    app.post(prefix+'/:kind/:recordId/recover',requireAuth,requireWorkspace,handler('recover'));
    app.put(prefix+'/:kind/:recordId',requireAuth,requireWorkspace,handler('save'));
    app.delete(prefix+'/:kind/:recordId',requireAuth,requireWorkspace,handler('discard'));
  }
}
module.exports={register};

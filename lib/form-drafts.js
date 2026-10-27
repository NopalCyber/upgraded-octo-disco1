'use strict';
const crypto = require('crypto');
const enc = require('./encryption');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fields = {
  assessment: ['applicability','status','maturity','inclusion_justification','exclusion_justification','notes','scope_pct','diagnostic_set_id'],
  'client-response': ['response_note'],
  'client-comment': ['body','internal_only'],
  'deliverable-comment': ['body'],
  'deliverable-decision': ['note'],
  'policy-decision': ['reason'],
};
function failure(message, status = 409) { const e = new Error(message); e.status = status; e.code = 'draft_conflict'; return e; }
function scope(c) { return [c.workspaceId, c.actorId, c.kind, String(c.recordId), String(c.contextKey || '')]; }
function cleanPayload(kind, payload) {
  if (!fields[kind] || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('Unsupported draft form.', 422);
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!fields[kind].includes(key) && !(kind === 'assessment' && /^q_\d{1,3}$/.test(key))) continue;
    if (value != null && !['string','number','boolean'].includes(typeof value)) throw failure('Draft fields must contain text.', 422);
    const text = value == null ? '' : String(value);
    if (text.length > 40000) throw failure('A draft field is too long.', 422);
    out[key] = text;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > 250000) throw failure('This draft exceeds the supported size.', 422);
  return out;
}
async function row(db, c) { return await db.prepare('SELECT * FROM form_drafts WHERE workspace_id=? AND actor_id=? AND kind=? AND record_id=? AND context_key=?').get(...scope(c)); }
function present(r) {
  return r ? { id:r.id, generation:r.generation, version:r.draft_version, baseVersion:r.base_version, state:r.state,
    savedAt:r.saved_at, payload:r.state === 'active' ? JSON.parse(enc.decryptIfNeeded(r.payload, r.workspace_id)) : null } : null;
}
async function get(db, c) { const r = await row(db,c); return { draft:r && r.state === 'active' ? present(r) : null, generation:r ? r.generation : 0 }; }
async function previous(db, c) {
  return await db.prepare(`SELECT id,context_key "contextKey",generation,draft_version version,base_version "baseVersion",saved_at "savedAt" FROM form_drafts WHERE workspace_id=? AND actor_id=? AND kind=? AND record_id=? AND context_key!=? AND state='active' ORDER BY saved_at DESC`)
    .all(...scope(c));
}
async function recover(db, c, input) {
  return await db.transaction(async () => {
    if (c.kind !== 'assessment' || String(input.sourceContextKey ?? '') === String(c.contextKey || '')) throw failure('Choose a draft from an earlier assessment context.',422);
    const source=await row(db,{...c,contextKey:String(input.sourceContextKey ?? '')});
    if(!source || source.state!=='active' || source.id!==input.sourceDraftId || source.generation!==Number(input.sourceGeneration) || source.draft_version!==Number(input.sourceVersion)) throw failure('The earlier draft changed. Preview it again before recovering it.');
    const destination=await row(db,c);
    if(destination?.state==='active') throw failure('A draft already exists in this assessment pass. Compare or discard it before recovering an earlier draft.');
    return await save(db,c,{payload:JSON.parse(enc.decryptIfNeeded(source.payload,c.workspaceId)),baseVersion:source.base_version,generation:Number(input.generation),expectedDraftVersion:0,clientSaveId:crypto.randomUUID()});
  })();
}
async function save(db, c, input) {
  const payload = cleanPayload(c.kind,input.payload), json = JSON.stringify(payload), payloadHash = hash(json);
  return await db.transaction(async () => {
    const old=await row(db,c), generation=Number(input.generation), expected=Number(input.expectedDraftVersion);
    const saveId=String(input.clientSaveId || '').slice(0,160);
    if (old && old.state === 'active' && saveId && old.last_save_id === saveId && old.payload_hash === payloadHash) return present(old);
    if (!Number.isInteger(generation) || !Number.isInteger(expected) || generation !== (old ? old.generation : 0) || expected !== (old && old.state === 'active' ? old.draft_version : 0)) {
      throw failure('This draft changed in another tab. Your current edits are still on this screen. Reload the saved draft or retry after comparing it.');
    }
    const baseVersion=String(input.baseVersion ?? c.recordVersion ?? '');
    if (old && old.state === 'active' && baseVersion !== old.base_version && !(input.rebase === true && baseVersion === String(c.recordVersion))) throw failure('Compare your draft with the newer recorded version before continuing.');
    const encrypted=enc.encryptIfNeeded(json,c.workspaceId,!!c.encryptionEnabled);
    if (!old) await db.prepare(`INSERT INTO form_drafts(id,workspace_id,actor_id,kind,record_id,context_key,base_version,payload,payload_hash,last_save_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(),...scope(c),baseVersion,encrypted,payloadHash,saveId || null);
    else await db.prepare(`UPDATE form_drafts SET state='active',draft_version=?,payload=?,payload_hash=?,base_version=?,last_save_id=?,saved_at=to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id=?`)
      .run(old.state === 'active' ? old.draft_version+1 : 1,encrypted,payloadHash,baseVersion,saveId || null,old.id);
    return present(await row(db,c));
  })();
}
async function discard(db, c, input) {
  return await db.transaction(async () => {
    const r=await row(db,c);
    if (!r) return { draft:null,generation:0 };
    if (Number(input.generation)!==r.generation || (r.state==='active' && Number(input.expectedDraftVersion)!==r.draft_version)) throw failure('The draft changed. Compare it before discarding.');
    await db.prepare("UPDATE form_drafts SET state='discarded',payload='{}',generation=generation+1,draft_version=draft_version+1 WHERE id=?").run(r.id);
    return await get(db,c);
  })();
}
async function commit(db, c, body, apply) {
  return await db.transaction(async () => {
    const key=String(body.mutation_key || '').slice(0,160);
    const requestHash=hash(JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k])=>k!=='_csrf').sort(([a],[b])=>a.localeCompare(b)))));
    if (key) {
      const previous=await db.prepare('SELECT request_hash,result_json FROM form_mutations WHERE workspace_id=? AND actor_id=? AND kind=? AND record_id=? AND mutation_key=?').get(c.workspaceId,c.actorId,c.kind,String(c.recordId),key);
      if (previous) {
        if (previous.request_hash!==requestHash) throw failure('This action was already used for different edits. Refresh before submitting again.');
        return JSON.parse(enc.decryptIfNeeded(previous.result_json,c.workspaceId));
      }
    }
    let effective={...body}, draft=null;
    if (body.draft_id) {
      draft=await row(db,c);
      if (!draft || draft.id!==body.draft_id || draft.state!=='active' || draft.draft_version!==Number(body.draft_version) || draft.generation!==Number(body.draft_generation)) throw failure('Your draft changed before submission. Compare the saved draft and try again.');
      effective={...body,...JSON.parse(enc.decryptIfNeeded(draft.payload,c.workspaceId)),expected_record_version:draft.base_version};
    } else if (body.private_draft_generation !== undefined) {
      const current=await row(db,c), generation=Number(body.private_draft_generation), version=Number(body.private_draft_version);
      if (!Number.isInteger(generation) || !Number.isInteger(version) || generation !== (current ? current.generation : 0) || version !== (current?.state === 'active' ? current.draft_version : 0)) {
        throw failure('Your private draft changed in another tab. Compare both versions before recording your entered values.');
      }
      if (current?.state === 'active') draft=current;
    }
    const result=await apply(effective);
    if (!db.inTransaction) throw new Error('Draft commit must run inside its transaction.');
    if (draft) await db.prepare("UPDATE form_drafts SET state='consumed',payload='{}',generation=generation+1,draft_version=draft_version+1 WHERE id=?").run(draft.id);
    if (key) await db.prepare('INSERT INTO form_mutations(workspace_id,actor_id,kind,record_id,mutation_key,request_hash,result_json) VALUES(?,?,?,?,?,?,?)')
      .run(c.workspaceId,c.actorId,c.kind,String(c.recordId),key,requestHash,enc.encryptIfNeeded(JSON.stringify(result ?? null),c.workspaceId,!!c.encryptionEnabled));
    return result;
  })();
}
module.exports={fields,cleanPayload,get,previous,recover,save,discard,commit,failure};

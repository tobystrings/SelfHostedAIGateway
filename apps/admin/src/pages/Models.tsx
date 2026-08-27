import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {Button,Card} from '../components/Ui';

const costs=['free','paid','local','unknown'];
export function Models(){
  const [rows,setRows]=useState<any[]>([]),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const load=()=>api<any[]>('/api/admin/models').then(setRows);
  useEffect(()=>{load()},[]);
  const patch=async(id:string,value:any)=>{setError('');try{const updated=await api<any>(`/api/admin/models/${id}`,{method:'PATCH',body:JSON.stringify(value)});setRows(rows.map(row=>row.id===id?{...row,...updated}:row))}catch(e){setError(e instanceof Error?e.message:'Update failed')}};
  const verify=async(id:string)=>{setBusy(id);setError('');try{await api(`/api/admin/models/${id}/verify`,{method:'POST'});await load()}catch(e){setError(e instanceof Error?e.message:'Verification failed')}finally{setBusy('')}};
  return <><h1>Models</h1>{error&&<Card>{error}</Card>}<div className="stack">{rows.length?rows.map(m=><Card key={m.id}><div className="row"><div><b>{m.provider_slug}/{m.upstream_id}</b><small>{m.alias||'No alias'} · priority {m.routing_priority}</small><small>Capabilities: {Object.entries(m.capabilities??{}).filter(([,v])=>v===true).map(([k])=>k).join(', ')||'none declared'}</small><small>Verification: {m.verification_status} {m.callable===true?'· callable':m.callable===false?'· unavailable':''}{m.verification_error_category?` · ${m.verification_error_category}`:''}{m.verified_at?` · ${new Date(m.verified_at).toLocaleString()}`:''}</small></div><div><label>Cost <select value={m.cost_classification} onChange={e=>patch(m.id,{costClassification:e.target.value})}>{costs.map(x=><option key={x}>{x}</option>)}</select></label> <label>Priority <input type="number" style={{width:70}} value={m.routing_priority} onChange={e=>patch(m.id,{routingPriority:Number(e.target.value)})}/></label> <label><input type="checkbox" checked={m.enabled} onChange={e=>patch(m.id,{enabled:e.target.checked})}/> enabled</label> <Button disabled={busy===m.id} onClick={()=>verify(m.id)}>{busy===m.id?'Verifying…':'Verify'}</Button></div></div></Card>):<Card>No models discovered yet. Use Providers → Discover.</Card>}</div></>;
}

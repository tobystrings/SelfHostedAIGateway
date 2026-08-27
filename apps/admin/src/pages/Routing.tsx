import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {Card} from '../components/Ui';

const modes=['NORMAL','FREE_ONLY','LOCAL_ONLY','CHEAPEST'];
const descriptions:Record<string,string>={NORMAL:'Use normal policy and priority routing.',FREE_ONLY:'Only free or local models; paid and unknown fallback is prohibited.',LOCAL_ONLY:'Only local models such as Ollama.',CHEAPEST:'Choose the lowest known cost after capability filtering.'};
export function Routing(){
  const [d,setD]=useState<any>({policies:[],budgets:[],rateLimits:[],defaultMode:'NORMAL'}),[error,setError]=useState('');
  useEffect(()=>{api('/api/admin/routing').then(setD)},[]);
  const setMode=async(mode:string)=>{setError('');try{const result=await api<any>('/api/admin/routing/default-mode',{method:'PATCH',body:JSON.stringify({mode})});setD({...d,defaultMode:result.defaultMode})}catch(e){setError(e instanceof Error?e.message:'Update failed')}};
  return <><h1>Routing & Controls</h1><Card><h2>Default routing mode</h2><select value={d.defaultMode} onChange={e=>setMode(e.target.value)}>{modes.map(mode=><option key={mode}>{mode}</option>)}</select><p>{descriptions[d.defaultMode]}</p>{error&&<small>{error}</small>}</Card><Card><h2>Policies</h2><pre>{JSON.stringify(d.policies,null,2)}</pre></Card><Card><h2>Budgets</h2><pre>{JSON.stringify(d.budgets,null,2)}</pre></Card><Card><h2>Rate limits</h2><pre>{JSON.stringify(d.rateLimits,null,2)}</pre></Card></>;
}

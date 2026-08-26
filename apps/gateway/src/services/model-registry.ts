import type {GatewayModel} from '../core/types.js';
export class ModelRegistry{private models:GatewayModel[]=[];setMany(m:GatewayModel[]){this.models=m}list(){return this.models}get(provider:string,id:string){return this.models.find(m=>m.provider===provider&&(m.id===id||m.metadata?.alias===id))}}

import type { Pricing,Usage } from './types.js';
export function estimateCost(u:Usage,p?:Pricing):number{if(!p)return 0;const cached=u.cachedInputTokens??0;const normal=Math.max(0,u.inputTokens-cached);return normal/1e6*p.inputPerMillionUsd+cached/1e6*(p.cachedInputPerMillionUsd??p.inputPerMillionUsd)+u.outputTokens/1e6*p.outputPerMillionUsd;}

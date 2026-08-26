import crypto from 'node:crypto';
export interface SessionClaims{sub:string;email:string;roles:string[];csrf:string;exp:number}
const enc=(s:string)=>Buffer.from(s).toString('base64url');
export function signSession(c:SessionClaims,secret:string){const body=enc(JSON.stringify(c));const sig=crypto.createHmac('sha256',secret).update(body).digest('base64url');return `${body}.${sig}`}
export async function verifySession(token:string,secret:string):Promise<SessionClaims>{const [body,sig]=token.split('.');if(!body||!sig)throw new Error('invalid session');const expected=crypto.createHmac('sha256',secret).update(body).digest();const actual=Buffer.from(sig,'base64url');if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))throw new Error('invalid session');const c=JSON.parse(Buffer.from(body,'base64url').toString()) as SessionClaims;if(c.exp<Date.now())throw new Error('expired session');return c}

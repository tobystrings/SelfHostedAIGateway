import crypto from 'node:crypto';
export const apiKeyHash=(key:string)=>crypto.createHash('sha256').update(key).digest();
export function newApiKey(){const secret=crypto.randomBytes(32).toString('base64url');return `gw_${secret}`;}
function master(key:string){const raw=Buffer.from(key,'base64');if(raw.length!==32)throw new Error('MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes');return raw}
export function encryptSecret(v:unknown,key:string){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',master(key),iv);const body=Buffer.concat([cipher.update(JSON.stringify(v),'utf8'),cipher.final()]);const tag=cipher.getAuthTag();return [iv,tag,body].map(x=>x.toString('base64url')).join('.')}
export function decryptSecret<T>(value:string,key:string):T{const [ivs,tags,bodys]=value.split('.');const d=crypto.createDecipheriv('aes-256-gcm',master(key),Buffer.from(ivs!,'base64url'));d.setAuthTag(Buffer.from(tags!,'base64url'));return JSON.parse(Buffer.concat([d.update(Buffer.from(bodys!,'base64url')),d.final()]).toString('utf8'))}
export function passwordHash(password:string,salt=crypto.randomBytes(16)){const hash=crypto.scryptSync(password,salt,64);return `${salt.toString('base64url')}.${hash.toString('base64url')}`}
export function passwordVerify(password:string,stored:string){const [s,h]=stored.split('.');const got=crypto.scryptSync(password,Buffer.from(s!,'base64url'),64);return crypto.timingSafeEqual(got,Buffer.from(h!,'base64url'))}
export function redact(v:unknown){if(v instanceof Error)return {name:v.name,message:v.message};return v}

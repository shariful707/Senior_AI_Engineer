import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {isIP} from 'node:net';
import {lookup} from 'node:dns/promises';
import {config} from '../config.js';
import {decode} from '../db/index.js';

export class AIError extends Error {
  constructor(message,status=400,code='AI_ERROR',retryable=false){super(message);this.status=status;this.code=code;this.retryable=retryable;}
}
export function environmentAI(){
  const provider=config.extractionMode;
  return {provider,model:provider==='ollama'?config.ollamaModel:config.model,baseUrl:provider==='ollama'?config.ollamaUrl:config.baseUrl,apiKey:provider==='ollama'?'':config.apiKey,responseFormat:'strict',verifiedAt:null,source:'environment'};
}
async function masterKey(){
  if(process.env.AI_SETTINGS_ENCRYPTION_KEY)return createHash('sha256').update(process.env.AI_SETTINGS_ENCRYPTION_KEY).digest();
  await mkdir(config.dataDir,{recursive:true});const file=path.join(config.dataDir,'.ai-master-key');
  try{await writeFile(file,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  const key=await readFile(file);if(key.length!==32)throw new AIError('AI credential storage is invalid. Restore its encryption key or enter a new provider key.',503);
  return key;
}
export async function protectSettings(settings){
  const {apiKey='',...safe}=settings;
  if(!apiKey)return {...safe,encryptedKey:null};
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await masterKey(),iv);
  const encrypted=Buffer.concat([cipher.update(apiKey,'utf8'),cipher.final()]);
  return {...safe,encryptedKey:[iv,cipher.getAuthTag(),encrypted].map(value=>value.toString('base64')).join('.')};
}
export async function revealSettings(stored){
  const {encryptedKey,...settings}=stored;
  if(!encryptedKey)return {...settings,apiKey:''};
  try{
    const [iv,tag,encrypted]=encryptedKey.split('.').map(value=>Buffer.from(value,'base64'));
    const decipher=createDecipheriv('aes-256-gcm',await masterKey(),iv);decipher.setAuthTag(tag);
    return {...settings,apiKey:Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8')};
  }catch{throw new AIError('The stored AI key could not be opened. Enter the key again in AI settings.',503);}
}
export async function getAISettings(db){
  const row=(await db.query("SELECT data FROM workspace_settings WHERE id='ai'")).rows[0];
  return row?revealSettings({...decode(row.data),source:'database'}):environmentAI();
}
export async function saveAISettings(db,settings){
  await db.query("INSERT INTO workspace_settings(id,data,updated_at) VALUES('ai',$1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",[JSON.stringify(await protectSettings(settings)),new Date().toISOString()]);
}
export async function getAIStatus(db){
  const settings=await getAISettings(db),enabled=settings.provider!=='offline';
  return {enabled,provider:settings.provider,model:enabled?settings.model:'',base_url:enabled?settings.baseUrl:'',has_key:Boolean(settings.apiKey),verified_at:settings.verifiedAt,source:settings.source,defaults:{ollama_url:config.ollamaUrl,ollama_model:config.ollamaModel},features:{extraction:enabled,assistant:enabled}};
}
const localHost=host=>['localhost','127.0.0.1','[::1]','::1','host.docker.internal'].includes(host);
const privateAddress=address=>/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)||address==='::1'||/^(fc|fd|fe[89ab])/i.test(address)||address.toLowerCase().startsWith('::ffff:');
export async function validateProviderURL(provider,value){
  let url;try{url=new URL(value);}catch{throw new AIError('Enter a valid provider URL.');}
  if(url.username||url.password||url.search||url.hash)throw new AIError('Provider URL cannot contain credentials, query parameters or fragments.');
  if(provider==='openai'&&url.href.replace(/\/$/,'')!=='https://api.openai.com/v1')throw new AIError('OpenAI uses https://api.openai.com/v1. Choose a compatible provider for another endpoint.');
  if(provider==='ollama'&&!localHost(url.hostname))throw new AIError('Ollama must use localhost, 127.0.0.1 or host.docker.internal.');
  if(!['http:','https:'].includes(url.protocol)||!localHost(url.hostname)&&url.protocol!=='https:')throw new AIError('Remote providers require HTTPS.');
  if(!localHost(url.hostname)){
    if(isIP(url.hostname))throw new AIError('Use a public provider hostname.');
    let addresses;try{addresses=await lookup(url.hostname,{all:true});}catch{throw new AIError('The provider hostname could not be resolved.');}
    if(addresses.some(item=>privateAddress(item.address)))throw new AIError('This provider address is not allowed.');
  }
  return url.href.replace(/\/$/,'');
}
export async function candidateSettings(body,existing){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['provider','model','base_url','api_key','response_format'].includes(key)))throw new AIError('Invalid AI settings fields.');
  const {provider,model}=body;
  if(!['openai','compatible','ollama'].includes(provider))throw new AIError('Choose OpenAI, a compatible provider or local Ollama.');
  if(typeof model!=='string'||model.length>128||!model.trim()||!/^[-\w./:@]+$/.test(model))throw new AIError('Enter a valid model name.');
  if(body.api_key!=null&&(typeof body.api_key!=='string'||body.api_key.length>1024))throw new AIError('Invalid provider API key.');
  const defaultURL=provider==='openai'?'https://api.openai.com/v1':provider==='ollama'?config.ollamaUrl:'';
  const baseUrl=await validateProviderURL(provider,body.base_url||defaultURL);
  const apiKey=provider==='ollama'?'':body.api_key?.trim()|| (existing?.provider===provider&&existing.baseUrl===baseUrl?existing.apiKey:'');
  if(provider!=='ollama'&&!apiKey&&!localHost(new URL(baseUrl).hostname))throw new AIError('Enter the provider API key. It is different from the workspace access token.');
  const responseFormat=body.response_format|| (provider==='compatible'?'json':'strict');
  if(!['strict','json'].includes(responseFormat))throw new AIError('Invalid provider response format.');
  return {provider,model:model.trim(),baseUrl,apiKey,responseFormat,verifiedAt:null};
}

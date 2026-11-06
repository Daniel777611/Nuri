import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
const walk=dir=>existsSync(dir)?readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(`${dir}/${e.name}`):e.isFile()?[`${dir}/${e.name}`]:[]):[];
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function fileManifest(paths){return [...new Set(paths)].filter(existsSync).sort().map(path=>({path,bytes:readFileSync(path).length,sha256:sha256(readFileSync(path))}));}
export function manifestHash(manifest){return sha256(JSON.stringify(manifest));}
/** Local web evidence only. Deliberately excludes dotenv, accounts, build output and dependencies. */
export function sourceSnapshot(){const files=fileManifest([...walk('app'),...walk('src'),...walk('assets'),...walk('locales'),'app.json','package.json','tsconfig.json','metro.config.js','babel.config.js']);return {sha256:manifestHash(files),file_count:files.length,files};}
export function scriptSnapshot(){const files=fileManifest(walk('scripts').filter(p=>p.endsWith('.mjs')));return {sha256:manifestHash(files),file_count:files.length,files};}
export function lockSnapshot(){return fileManifest(['pnpm-lock.yaml','../pnpm-lock.yaml']);}

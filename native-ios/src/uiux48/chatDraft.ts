import { auth } from "@/src/api";
// Ephemeral UI-only drafts. Never a URL, log, capsule or persisted credential.
// Every read/write is scoped to the current account session epoch.
let epoch = -1;
const drafts = new Map<string,string>();
export function readChatDraft(id:string) { const current=auth.getSessionGeneration();if(epoch!==current){drafts.clear();epoch=current;}return drafts.get(id)??""; }
export function writeChatDraft(id:string,value:string,owner:number) { if(owner!==auth.getSessionGeneration())return;if(epoch!==owner){drafts.clear();epoch=owner;}if(value)drafts.set(id,value);else drafts.delete(id); }

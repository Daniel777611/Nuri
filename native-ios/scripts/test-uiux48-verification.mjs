import {spawn} from "node:child_process";
import {mkdir,writeFile} from "node:fs/promises";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const source_snapshot=sourceSnapshot();
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48/test-results";
await mkdir(out,{recursive:true});
const scripts=["test-uiux48-collection-contract","test-uiux48-child-dates","test-uiux48-components","test-uiux48-assets","test-uiux48-continuation","test-uiux48-icon-integration","test-session-isolation","test-account-deletion","test-ai-consent","test-ai-permission-navigation","test-expired-session-recovery","test-native-google-signin","test-chat-entry","test-chat-client-context-contract","test-chat-image-input-contract","test-chat-response-feedback-contract","test-main-sync-api","test-native-voice-and-platform","test-request-failure","test-daily-post-nuri-guide","test-youtube-nuri-guide","test-daily-video","test-resource-summary","test-external-content","test-nuri-resource-guide"];
const results=[];
async function one(name){const command=["--test",`scripts/${name}.mjs`];let output="";
const result=await new Promise(resolve=>{const p=spawn(process.execPath,command,{cwd:process.cwd(),env:process.env});p.stdout.on("data",x=>output+=x);p.stderr.on("data",x=>output+=x);p.on("close",exit=>resolve(exit));});
const log=`${out}/${name}.log`;await writeFile(log,output);
const entry={suite:name,exit:result,log,summary:output.split("\n").filter(s=>/^ℹ (tests|pass|fail)|^✖|unexpected (dependency|import)|AssertionError/.test(s)).slice(0,12)};
results.push(entry);console.log(JSON.stringify(entry));
}
const queue=[...scripts];await Promise.all(Array.from({length:3},async()=>{while(queue.length)await one(queue.shift());}));
await writeFile(out+"/summary.json",JSON.stringify({checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,real_accounts_used:false,results},null,2));
process.exitCode=results.some(r=>r.exit!==0)?1:0;

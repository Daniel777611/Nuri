import {spawn} from "node:child_process";
import {mkdir,writeFile} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {sourceSnapshot as snapshot} from "./uiux48-source-snapshot.mjs";
const previewMode=process.env.UIUX48_VERIFICATION_PREVIEW_MODE??"1";
if(!["0","1"].includes(previewMode))throw Error("UIUX48_VERIFICATION_PREVIEW_MODE must be 0 or 1");
const fixtureMode=previewMode==="1";
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48/"+(fixtureMode?"build-results":"real-api-build-results");
await mkdir(out,{recursive:true});
const env={...process.env,PATH:process.execPath.slice(0,process.execPath.lastIndexOf("/"))+":"+process.env.PATH,EXPO_PUBLIC_PREVIEW_MODE:previewMode,EXPO_PUBLIC_UIUX48_GALLERY:"0",EXPO_NO_DOTENV:"1",NODE_BINARY:process.execPath,CI:"1"};
const commands=[
 {name:"simulator-release",binary:"xcodebuild",args:["-quiet","-workspace","ios/NURINativeLab.xcworkspace","-scheme","NURINativeLab","-configuration","Release","-sdk","iphonesimulator","-destination","generic/platform=iOS Simulator","-derivedDataPath",fixtureMode?"build/uiux48-derived":"build/uiux48-real-api-derived","CODE_SIGNING_ALLOWED=NO","ONLY_ACTIVE_ARCH=YES","ARCHS=arm64","build"]},
 {name:"web-export",binary:process.execPath,args:["node_modules/expo/bin/cli","export","--platform","web","--output-dir",fixtureMode?"build/uiux48-web":"build/uiux48-real-api-web"]}
];
if(!fixtureMode)commands.unshift({name:"device-release",binary:"xcodebuild",args:["-quiet","-workspace","ios/NURINativeLab.xcworkspace","-scheme","NURINativeLab","-configuration","Release","-sdk","iphoneos","-destination","generic/platform=iOS","-derivedDataPath","build/uiux48-real-api-derived","CODE_SIGNING_ALLOWED=NO","ONLY_ACTIVE_ARCH=YES","ARCHS=arm64","build"]});
const results=[];
for(const command of commands){let output="";const source_snapshot=snapshot();const started_at=new Date().toISOString();const exit=await new Promise(resolve=>{const child=spawn(command.binary,command.args,{cwd:process.cwd(),env});child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>output+=x);child.on("close",resolve);});
 const log=out+"/"+command.name+".log";await writeFile(log,output);
 let pre_hermes_preview_guard=null;
 if(!fixtureMode&&exit===0&&command.name.endsWith("release")){
  const platform=command.name==="device-release"?"iphoneos":"iphonesimulator";
  const path=`build/uiux48-real-api-derived/Build/Products/Release-${platform}/main.jsbundle`;
  const definitions=readFileSync(path,"utf8").match(/\b(?:var|const|let) isPreviewMode\s*=\s*(?:true|false|![01])/g)??[];
  pre_hermes_preview_guard={path,definitions,disabled_verified:definitions.length===1&&/\bfalse$|!1$/.test(definitions[0]),native_runtime_verified:false};
 }
 const result={name:command.name,command:[command.binary,...command.args],started_at,finished_at:new Date().toISOString(),exit,log,source_snapshot,source_unchanged_during_build:snapshot().sha256===source_snapshot.sha256,fixture_mode:fixtureMode,build_env_preview_mode:previewMode,pre_hermes_preview_guard,native_runtime_flag_verified:false,uploaded:false,installed_or_launched:false};
 results.push(result);console.log(JSON.stringify(result));
 if(exit!==0||pre_hermes_preview_guard?.disabled_verified===false)break;
}
await writeFile(out+"/summary.json",JSON.stringify({results,publication:false,native_runtime_verified:false},null,2));
process.exitCode=results.some(x=>x.exit!==0||x.pre_hermes_preview_guard?.disabled_verified===false)?1:0;

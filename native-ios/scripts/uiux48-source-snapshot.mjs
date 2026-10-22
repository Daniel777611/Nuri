import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";
/** Build/QA evidence only; no env files, account storage, or credentials. */
export function sourceSnapshot(){
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+"/"+e.name):[dir+"/"+e.name]);
 const files=[...walk("app"),...walk("src"),...walk("assets/uiux48"),...walk("assets/community-redesign"),...walk("locales"),...walk("ios/NURINativeLab"),"ios/NURINativeLab.xcodeproj/project.pbxproj","app.json","package.json","tsconfig.json","metro.config.js"].filter(p=>/\.(ts|tsx|js|json|png|svg|swift|m|mm|h|plist|strings|entitlements|storyboard|xcprivacy|pbxproj)$/.test(p)).sort();
 const hash=createHash("sha256");for(const path of files){hash.update(path+"\0");hash.update(readFileSync(path));}
 return {sha256:hash.digest("hex"),file_count:files.length};
}

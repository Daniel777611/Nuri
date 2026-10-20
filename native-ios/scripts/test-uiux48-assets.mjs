import assert from "node:assert/strict";
import {readFileSync,readdirSync,statSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {basename,join} from "node:path";
const destination="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48";
const manifest=JSON.parse(readFileSync(destination+"/implementation/asset-manifest.json","utf8"));
const copied=manifest.map(asset=>{const path=join(process.cwd(),"assets/uiux48",basename(asset.file));const b=readFileSync(path);const hash=createHash("sha256").update(b).digest("hex");assert.equal(hash,asset.sha256.toLowerCase(),path);return{path,bytes:b.length,sha256:hash};});
const approved=[];
for(const [directory,manifestName,target] of [["approved-icon-assets-ecd4df22","icon-manifest.json","approved-icons"],["approved-shadow-assets-ef01abd3","shadow-manifest.json","approved-shadows"]]){
 const source=JSON.parse(readFileSync(join(destination,directory,manifestName),"utf8"));
 for(const asset of source.assets){
  const path=join(process.cwd(),"assets/uiux48",target,asset.file),bytes=readFileSync(path);
  const sha256=createHash("sha256").update(bytes).digest("hex");assert.equal(sha256,asset.sha256,path);
  if(target==="approved-shadows"){
   assert.equal(bytes.readUInt32BE(16),asset.pixelWidth);assert.equal(bytes.readUInt32BE(20),asset.pixelHeight);
   assert.ok(Math.abs(asset.pixelWidth/source.assets.find(x=>x.file===asset.file).logicalPlacement.width-3)<.01);
  }
  approved.push({path,sha256,bytes:bytes.length,logical_placement:asset.logicalPlacement});
 }
}
const sourcePaths=["src/uiux48/Scene.tsx","src/uiux48/Primitives.tsx","src/components/GoogleSignInButton.tsx","app/(tabs)/index.tsx"];
const used=new Set(sourcePaths.flatMap(path=>[...readFileSync(path,"utf8").matchAll(/require\("@\/assets\/uiux48\/([^"]+)"\)/g)].map(m=>m[1])));
const assets=[...used].map(name=>{const path=join(process.cwd(),"assets/uiux48",name);const b=readFileSync(path);assert.ok(b.length>0);let width,height;
 if(name.endsWith(".png")){assert.equal(b.toString("ascii",1,4),"PNG");width=b.readUInt32BE(16);height=b.readUInt32BE(20);}
 else{const root=b.toString("utf8",0,1024).match(/<svg\b[^>]*>/)?.[0];assert.ok(root,name);width=Number(root.match(/\bwidth="([^"]+)"/)?.[1]);height=Number(root.match(/\bheight="([^"]+)"/)?.[1]);assert.ok(width>0&&height>0,name);}
 return{path,bytes:b.length,intrinsic_width:width,intrinsic_height:height};
});
const report={checked_at:new Date().toISOString(),package_assets_verified:copied.length,package_all_hashes_match:true,coordinator_approved_assets_verified:approved.length,approved_all_hashes_match:true,static_callsite_assets_verified:assets.length,metadata_only_inspection:true,rendered_geometry_and_native_fidelity:"NOT_FINAL_ACCEPTED",copied,approved,assets};
writeFileSync(destination+"/asset-verification.json",JSON.stringify(report,null,2));console.log(JSON.stringify({package_assets:copied.length,static_callsite_assets:assets.length,pass:true}));

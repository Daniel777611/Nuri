import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {test} from "node:test";
import ts from "typescript";
import {fixture,page,runner} from "./test-daily-home-failure.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const jsx=(type,props)=>({type,props}),runtime={jsx,jsxs:jsx};
const walk=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(walk):[n,...walk(n.props?.children)];
const expand=n=>!n||typeof n!=="object"?n:Array.isArray(n)?n.map(expand):typeof n.type==="function"?expand(n.type(n.props)):{...n,props:{...n.props,children:expand(n.props?.children)}};
const find=(tree,id)=>walk(tree).find(n=>n.props?.testID===id);
const flatten=s=>Array.isArray(s)?Object.assign({},...s.filter(Boolean).map(flatten)):s??{};
function load(path,deps){const m={exports:{}};new Function("require","module","exports",ts.transpileModule(readFileSync(path,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>{if(name.startsWith("@/assets/"))return name;if(name==="./ReadingMedia")return load("src/uiuxfinal/ReadingMedia.tsx",deps);assert.ok(name in deps,"Unexpected dependency "+name);return deps[name];},m,m.exports);return m.exports;}
function reading(width=402,locale="en",fontScale=1,react={useState:v=>[typeof v==="function"?v():v,()=>{}]},os="ios"){
 const deps={react,"react/jsx-runtime":runtime,"react-native":{View:"View",Pressable:"Pressable",ScrollView:"Scroll",ActivityIndicator:"Loading",Platform:{OS:os},useWindowDimensions:()=>({width,fontScale})},"expo-image":{Image:"Image"},"expo-blur":{BlurView:"Blur"},"react-native-safe-area-context":{useSafeAreaInsets:()=>({bottom:34})},"@/src/i18n":{useT:()=>({locale}),translate:(_l,s)=>s},"./Primitives":{FinalText:"Text",FinalSurface:"Surface",FINAL_COLOR:{accent:"#735C84"}}};
 return {...load("src/uiuxfinal/Reading.tsx",deps),...load("src/uiuxfinal/ReadingMedia.tsx",deps)};
}
test("both reading pages use one tappable cover, original controls and a separate original purple chat dock",()=>{
 for(const width of [320,390,402])for(const kind of ["post","video"]){
  const c=reading(width),calls=[],tree=expand(c.FinalReadingPage({kind,title:"Supplied title",source:"Supplied source",onSource:()=>calls.push("source"),onTalk:()=>calls.push("chat"),talkLabel:"Talk about your family with Nuri",busy:false,children:"Supplied body"}));
  assert.deepEqual(calls,[]);
  const cover=find(tree,`daily-${kind}-source`),chat=find(tree,`daily-${kind}-chat`),dock=find(tree,"final-reading-talk-dock"),surface=walk(tree).find(n=>n.type==="Surface");
  assert.equal(cover.props.accessibilityRole,"link");assert.equal(cover.props.style.height,188);assert.equal(cover.props.style.borderRadius,24);assert.equal(surface.props.material,"reading");
  assert.equal(walk(tree).filter(n=>n.props?.accessibilityRole==="button").length,1,"No old source/chat bottom button pair");
  assert.equal(dock.props.style.width,width);assert.ok(Math.abs(dock.props.style.height-89*width/402)<1e-9);assert.equal(chat.props.style.left,95);assert.equal(chat.props.style.width,296);assert.equal(chat.props.style.minHeight,68);
  const art=walk(chat).find(n=>n.type==="Image");assert.ok(art.props.source.endsWith("reading-talk-bubble.svg"));assert.deepEqual([art.props.style.width,art.props.style.height,art.props.style.left,art.props.style.top],[326,98,-15,-14]);
  const icon=walk(cover).find(n=>n.type==="Image"&&n.props.source.endsWith(kind==="video"?"reading-play.svg":"reading-source-arrow.svg"));assert.deepEqual([icon.props.style.width,icon.props.style.height],[24,24]);
  const scroll=walk(surface).find(n=>n.type==="Scroll");assert.ok(scroll);assert.equal(walk(scroll).includes(chat),false,"Chat action is outside the reading scroll");
  cover.props.onPress();chat.props.onPress();assert.deepEqual(calls,["source","chat"]);
 }
});
test("original Figma reading assets retain export dimensions and content hashes",()=>{
 const original={
  "reading-avatar-background.svg":[70,70,"a6490129430f1cf744fcf35966f04ff4a96b0d59bb87ce19672712f3cd01ece8"],
  "reading-talk-bubble.svg":[326,98,"64b6b47607792486bec11fd86a6fae4031a8d6c9849289db198afca232658d81"],
  "reading-play.svg":[24,24,"4b561321fe2a7cf9bf53c78da495d03ecdef2684684c6a29c9729a2a78874da8"],
  "reading-source-arrow.svg":[24,24,"bc07122534c5d004732012a96bb0fe7b652f2816d525f0fb11e8ec22759c2b2c"]};
 for(const [name,[width,height,hash]] of Object.entries(original)){const bytes=readFileSync(`assets/final-flow-20261101/${name}`),root=bytes.toString().match(/<svg\b[^>]*>/)?.[0];assert.equal(createHash("sha256").update(bytes).digest("hex"),hash);assert.match(root,new RegExp(`width="${width}"`));assert.match(root,new RegExp(`height="${height}"`));}
});
test("numbered reading copy is flexible and cannot force the card wider than a small phone",()=>{
 const c=reading(320),tree=c.ReadingStep({index:0,children:"Supplied summary"}),copy=tree.props.children[1];assert.equal(copy.props.style.flex,1);assert.equal(copy.props.style.minWidth,0);assert.equal(tree.props.style.gap,16);assert.equal(tree.props.children[0].props.style.width,36);
});
test("large type reserves matching CTA artwork and dock space without disabling text scaling or jumping during busy state",()=>{
 for(const width of [320,390])for(const fontScale of [1,1.5,2,2.8])for(const locale of ["zh-CN","en"])for(const busy of [false,true]){
  const tree=reading(width,locale,fontScale).ReadingTalkAction({label:locale==="en"?"Shall we talk about your family with Nuri?":"和 Nuri 聊聊你家的情况好吗？",busy,onPress:()=>{},testID:"chat"}),action=find(tree,"chat"),art=walk(action).find(n=>n.type==="Image"),height=action.props.style.minHeight;
  assert.ok(height>=48*fontScale+20);assert.ok(tree.props.style.height>=(12+height)*width/402);assert.equal(art.props.style.height,height+30);assert.equal(action.props.accessibilityState.busy,busy);assert.equal(action.props.disabled,busy);
  const text=walk(action).find(n=>n.type==="Text");if(!busy){assert.equal(text.props.numberOfLines,2);assert.notEqual(text.props.allowFontScaling,false);assert.equal(action.props.accessibilityLabel,text.props.children);}
 }
});
for(const kind of ["daily","video"])test(`${kind} cover opens source directly once while held, with no native success interstitial`,async()=>{
 const f=fixture(),held=deferred();let p;
 try{await f.login("A");await f.permit();f.externalOpen=()=>held.promise;p=page(f,kind);p.render();await tick();p.render();await tick();p.render();
  const id=kind==="daily"?"post":"video",tap=p.find(`daily-${id}-source`).props.onPress;
  tap();tap();p.render();assert.equal(p.external.length,1);assert.equal(p.find(`daily-${id}-source`).props.disabled,true);assert.deepEqual(p.routes,[]);
  held.resolve();await tick();p.render();assert.equal(p.find(`daily-${id}-source`).props.disabled,false);assert.deepEqual(p.routes,[],"Source opens directly; no source-preview/content-unavailable page");
  assert.equal(f.calls.filter(c=>c.path.endsWith("/events")&&JSON.parse(c.init.body).event==="source_click").length,1);
 }finally{held.resolve();p?.unmount();f.restore();}
});
for(const kind of ["daily","video"])test(`${kind} late source failure after blur/refocus cannot clobber the new attempt`,async()=>{
 const f=fixture(),old=deferred(),fresh=deferred();let p,count=0;
 try{await f.login("A");await f.permit();f.externalOpen=()=>++count===1?old.promise:fresh.promise;p=page(f,kind);p.render();await tick();p.render();await tick();p.render();
  const id=kind==="daily"?"post":"video";p.find(`daily-${id}-source`).props.onPress();p.blur();p.focus();await tick();p.render();p.find(`daily-${id}-source`).props.onPress();p.render();assert.equal(count,2);
  old.reject(new Error("old OS launch failed"));await tick();p.render();assert.equal(p.find(`daily-${id}-source-error`),undefined);assert.equal(p.find(`daily-${id}-source`).props.disabled,true);assert.deepEqual(p.routes,[]);
  fresh.resolve();await tick();p.render();assert.equal(p.find(`daily-${id}-source`).props.disabled,false);assert.deepEqual(p.routes,[]);
 }finally{old.resolve();fresh.resolve();p?.unmount();f.restore();}
});
test("reading backdrop and material retain separate original blur/veil, bounded border, and unclipped soft shadow",()=>{
 const rn={View:"View",Text:"Text",Pressable:"Pressable",ScrollView:"Scroll",Platform:{OS:"web"},StyleSheet:{absoluteFill:{position:"absolute",top:0,right:0,bottom:0,left:0}},useWindowDimensions:()=>({width:402,height:874})};
 const tree=load("src/uiuxfinal/Primitives.tsx",{"react/jsx-runtime":runtime,"react-native":rn,"expo-blur":{BlurView:"Blur"},"@/src/i18n":{useT:()=>({locale:"en"})}}).FinalSurface({material:"reading",fill:true,children:"fixture"});
 assert.equal(flatten(tree.props.style).boxShadow,"0px 1px 10px rgba(0,0,0,.1)");assert.notEqual(flatten(tree.props.style).overflow,"hidden");assert.ok(walk(tree).some(n=>flatten(n.props?.style).backdropFilter==="blur(10px)"));assert.ok(walk(tree).some(n=>flatten(n.props?.style).borderWidth===1));
 const back=load("src/uiuxfinal/ReadingBackdrop.tsx",{"react/jsx-runtime":runtime,"react-native":{...rn,StyleSheet:{...rn.StyleSheet,absoluteFillObject:rn.StyleSheet.absoluteFill}},"expo-image":{Image:"Image"}}).FinalReadingBackdrop();
 const image=walk(back).find(n=>n.type==="Image");assert.ok(image.props.source.endsWith("reading-background.png"));assert.equal(image.props.blurRadius,12);assert.ok(walk(back).some(n=>flatten(n.props?.style).backgroundColor==="rgba(255,250,242,.62)"));
});
const mediaPolicy=load("src/recommendationMedia.ts",{"./externalContent":load("src/externalContent.ts",{})});
test("video thumbnail is derived only from this video's validated ID, never arbitrary URLs or metadata",()=>{
 assert.equal(mediaPolicy.youtubeVideoThumbnail("ScMzIvxBSi4"),"https://i.ytimg.com/vi/ScMzIvxBSi4/hqdefault.jpg");
 for(const id of [null,undefined,{},"","../secret","ScMzIvxBSi4?token=secret","https://evil.invalid","ScMzIvxBSi4\n","short"])assert.equal(mediaPolicy.youtubeVideoThumbnail(id),null);
});
test("optional social thumbnails accept public image CDN media only; unsafe source or thumbnail is rejected",()=>{
 const source="https://www.facebook.com/groups/public/posts/42/";
 for(const image of ["https://scontent-sea1-1.xx.fbcdn.net/image.jpg?oh=public-signature","https://scontent.cdninstagram.com/preview.webp"])assert.equal(mediaPolicy.socialPostThumbnail(image,source),image);
 for(const image of ["http://scontent.fbcdn.net/image.jpg","https://scontent.fbcdn.net.evil.invalid/image.jpg","https://user:secret@scontent.fbcdn.net/image.jpg","https://scontent.fbcdn.net:444/image.jpg","https://127.0.0.1/private.jpg","https://image.local/private.jpg","https://scontent.fbcdn.net/embed.html","https://scontent.fbcdn.net/image.svg","https://scontent.fbcdn.net/image.jpg?access_token=secret","data:image/png;base64,aaaa","file:///private/image.jpg",null])assert.equal(mediaPolicy.socialPostThumbnail(image,source),null);
 assert.equal(mediaPolicy.socialPostThumbnail("https://scontent.fbcdn.net/image.jpg","http://www.facebook.com/post/42"),null);
});
test("post action follows the 48pt Figma blur/fill/shadow and one white NE arrow, not expand",()=>{
 for(const os of ["ios","web"]){const C=reading(402,"en",1,undefined,os).ReadingMedia,tree=C({kind:"post",source:"Facebook",uri:"https://scontent.fbcdn.net/image.jpg",onPress:()=>{}}),control=find(tree,"daily-post-media-control"),blur=find(tree,"daily-post-media-blur"),fill=find(tree,"daily-post-media-fill"),icon=find(tree,"daily-post-media-icon"),style=flatten(control.props.style);
  assert.deepEqual([style.width,style.height,style.right,style.top],[48,48,6,6]);assert.equal(style.boxShadow,"0px 0px 8px rgba(0,0,0,.2)");assert.notEqual(style.overflow,"hidden");assert.equal(fill.props.style.backgroundColor,"rgba(255,255,255,.3)");
  if(os==="web")assert.equal(blur.props.style.backdropFilter,"blur(7.5px)");else{assert.equal(blur.type,"Blur");assert.equal(blur.props.intensity,15);}
  assert.equal(icon.props.tintColor,"#FFFFFF");assert.deepEqual(icon.props.style.transform,[{rotate:"45deg"}]);assert.deepEqual([icon.props.style.width,icon.props.style.height],[24,24]);assert.ok(icon.props.source.endsWith("reading-source-arrow.svg"));assert.doesNotMatch(JSON.stringify(tree),/expand|article-illustration|reading-video-cover/);
 }
});
test("missing and failed media show honest clickable source state, never the Figma example image",()=>{
 for(const kind of ["post","video"]){const r=runner(),C=reading(390,"en",1,r.react).ReadingMedia,calls=[],props={kind,source:kind==="post"?"Facebook":"YouTube",onPress:()=>calls.push("source")};
  let tree=r.render(()=>C(props));assert.ok(find(tree,`daily-${kind}-thumbnail-unavailable`));assert.equal(find(tree,`daily-${kind}-thumbnail`),undefined);assert.doesNotMatch(JSON.stringify(tree),/article-illustration|reading-video-cover/);assert.deepEqual(calls,[]);
  props.uri=kind==="post"?"https://scontent.fbcdn.net/current.jpg":"https://i.ytimg.com/vi/ScMzIvxBSi4/hqdefault.jpg";tree=r.render(()=>C(props));const image=find(tree,`daily-${kind}-thumbnail`);assert.deepEqual(image.props.source,{uri:props.uri});assert.equal(image.props.recyclingKey,props.uri);assert.equal(image.props.cachePolicy,"memory");assert.equal(image.props.transition,0);assert.equal(image.props.source.headers,undefined);
  image.props.onError();tree=r.render(()=>C(props));assert.ok(find(tree,`daily-${kind}-thumbnail-unavailable`));assert.equal(find(tree,`daily-${kind}-thumbnail`),undefined);assert.deepEqual(calls,[]);tree.props.onPress();assert.deepEqual(calls,["source"]);r.unmount();
 }
});
test("late image errors cannot restore a wrong cover or clear the current image failure",()=>{
 const r=runner(),C=reading(390,"en",1,r.react).ReadingMedia,props={kind:"post",source:"Facebook",onPress:()=>{},uri:"https://scontent.fbcdn.net/A.jpg"};
 let tree=r.render(()=>C(props));const oldError=find(tree,"daily-post-thumbnail").props.onError;
 props.uri="https://scontent.fbcdn.net/B.jpg";tree=r.render(()=>C(props));find(tree,"daily-post-thumbnail").props.onError();oldError();tree=r.render(()=>C(props));assert.ok(find(tree,"daily-post-thumbnail-unavailable"));assert.equal(find(tree,"daily-post-thumbnail"),undefined);
 props.uri="https://scontent.fbcdn.net/C.jpg";tree=r.render(()=>C(props));oldError();tree=r.render(()=>C(props));assert.deepEqual(find(tree,"daily-post-thumbnail").props.source,{uri:props.uri});r.unmount();
});
test("current post contract without image fields stays an honest no-image original-source link",async()=>{
 const f=fixture();let p;try{await f.login("A");await f.permit();p=page(f);p.render();await tick();p.render();assert.ok(p.find("daily-post-thumbnail-unavailable"));assert.equal(p.find("daily-post-thumbnail"),undefined);assert.doesNotMatch(p.visible(),/article-illustration|reading-video-cover/);assert.deepEqual(p.external,[]);assert.equal(f.calls.filter(c=>c.path==="/chat/sessions").length,0);}finally{p?.unmount();f.restore();}
});
test("post controller can bind optional feed media without copying the source body or adding scraper/API calls",async()=>{
 const f=fixture();let p;try{await f.login("A");await f.permit();f.responder=path=>path.startsWith("/feed/daily-post")?{ok:true,status:200,json:async()=>({state:"ready",card:{id:"daily-A",card_id:"source-A",platform:"facebook",summary_source:"post",source_url:"https://www.facebook.com/post/42",image_url:"https://scontent.fbcdn.net/current.jpg",headline:"Supplied preview",situation:"Supplied short summary",takeaways:[],excerpt:"RAW_EXCERPT_DO_NOT_COPY"}})}:null;
  p=page(f);p.render();await tick();p.render();assert.deepEqual(p.find("daily-post-thumbnail").props.source,{uri:"https://scontent.fbcdn.net/current.jpg"});assert.doesNotMatch(p.visible(),/RAW_EXCERPT_DO_NOT_COPY|article-illustration/);assert.deepEqual(p.external,[]);const before=f.calls.length;p.find("daily-post-thumbnail").props.onError();p.render();assert.ok(p.find("daily-post-thumbnail-unavailable"));assert.equal(f.calls.length,before,"Image failure never triggers a fetch, summary or chat");p.find("daily-post-source").props.onPress();await tick();assert.deepEqual(p.external,["https://www.facebook.com/post/42"]);assert.deepEqual(p.routes,[]);
 }finally{p?.unmount();f.restore();}
});
test("video controller renders only its own cover even if the thumbnail URL is poisoned",async()=>{
 const f=fixture();let p;try{await f.login("A");await f.permit();f.responder=path=>path==="/feed/daily-video"?{ok:true,status:200,json:async()=>({state:"ready",card:{id:"video-A",card_id:"dailyvideo:video-A",video_id:"ScMzIvxBSi4",thumbnail_url:"https://evil.invalid/private.jpg",summary:"Saved summary",locale:"en"}})}:null;
  p=page(f,"video");p.render();await tick();p.render();await tick();p.render();assert.deepEqual(p.find("daily-video-thumbnail").props.source,{uri:"https://i.ytimg.com/vi/ScMzIvxBSi4/hqdefault.jpg"});assert.doesNotMatch(p.visible(),/evil\.invalid|reading-video-cover/);assert.deepEqual(p.external,[]);assert.equal(f.calls.filter(c=>c.path==="/chat/sessions"||c.path.endsWith("/summary")).length,0);
 }finally{p?.unmount();f.restore();}
});

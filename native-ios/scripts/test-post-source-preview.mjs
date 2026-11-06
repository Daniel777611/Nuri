import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import ts from "typescript";

// No DOM, WebKit, network or customer data. Functional children have their own
// keyed hook instance so URL changes, hiding and retries really run cleanups.
const walk=node=>!node||typeof node!=="object"?[]:Array.isArray(node)?node.flatMap(walk):[node,...walk(node.props?.children)];
const find=(tree,id)=>walk(tree).find(node=>node.props?.testID===id||node.props?.["data-testid"]===id);
function hooks(){
 const fibers=new Map();let current,cursor,pending=[],seen=new Set(),alive=true,tree;
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 const cleanup=fiber=>{fiber.mounted=false;for(const slot of fiber.slots)slot?.cleanup?.();};
 const react={
  useState(initial){const fiber=current,index=cursor++,slot=fiber.slots[index]??={value:typeof initial==="function"?initial():initial};slot.set??=next=>{if(fiber.mounted)slot.value=typeof next==="function"?next(slot.value):next;};return[slot.value,slot.set];},
  useRef(initial){const index=cursor++;return current.slots[index]??={current:initial};},
  useMemo(fn,deps){const index=cursor++;if(!current.slots[index]||!same(current.slots[index].deps,deps))current.slots[index]={value:fn(),deps};return current.slots[index].value;},
  useCallback(fn,deps){return react.useMemo(()=>fn,deps);},
  useEffect(fn,deps){const fiber=current,index=cursor++,prior=fiber.slots[index];if(!prior||!same(prior.deps,deps))pending.push(()=>{if(!fiber.mounted)return;prior?.cleanup?.();fiber.slots[index]={deps,setup:fn,cleanup:fn()};});},
 };
 react.useLayoutEffect=react.useEffect;
 const jsx=(type,props,key)=>({type,props:props??{},key});
 function resolve(node,path){
  if(!node||typeof node!=="object")return node;
  if(Array.isArray(node))return node.map((child,index)=>resolve(child,`${path}.${child?.key??index}`));
  if(typeof node.type==="function"){
   const id=`${path}:${node.key??""}`,prior=fibers.get(id);let fiber=prior;
   if(!fiber||fiber.type!==node.type){if(prior)cleanup(prior);fiber={type:node.type,slots:[],mounted:true};fibers.set(id,fiber);}
   seen.add(id);const saved=current,savedCursor=cursor;current=fiber;cursor=0;
   const output=node.type(node.props);current=saved;cursor=savedCursor;return resolve(output,`${id}.child`);
  }
  return{...node,props:{...node.props,children:resolve(node.props?.children,`${path}.children`)}};
 }
 return{react,runtime:{jsx,jsxs:jsx,Fragment:"Fragment"},render(Component,props){assert.equal(alive,true);seen=new Set();pending=[];tree=resolve(jsx(Component,props),"root");for(const[id,fiber]of fibers)if(!seen.has(id)){cleanup(fiber);fibers.delete(id);}pending.forEach(effect=>effect());return tree;},replayEffects(){for(const fiber of fibers.values())for(const slot of fiber.slots)slot?.cleanup?.();for(const fiber of fibers.values())for(const slot of fiber.slots)if(slot?.setup)slot.cleanup=slot.setup();},unmount(){if(!alive)return;alive=false;for(const fiber of fibers.values())cleanup(fiber);fibers.clear();},tree:()=>tree};
}
function load(path,deps){const module={exports:{}};new Function("require","module","exports",ts.transpileModule(readFileSync(path,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>{assert.ok(name in deps,"Unexpected dependency "+name);return deps[name];},module,module.exports);return module.exports;}
const policy=load("src/externalContent.ts",{});
function preview(platform="native",initial={},locale="en"){
 const r=hooks(),listeners=new Set(),opens=[],props={sourceUrl:"https://www.facebook.com/groups/public/posts/42/",active:true,busy:false,onOpenSource:()=>opens.push("explicit"),...initial};
 const native={View:"View",Pressable:"Pressable",Text:"Text",ActivityIndicator:"ActivityIndicator",Platform:{OS:platform==="web"?"web":"ios"},StyleSheet:{create:value=>value,absoluteFillObject:{position:"absolute",top:0,left:0,right:0,bottom:0}},AppState:{currentState:"active",addEventListener:(event,callback)=>{assert.equal(event,"change");listeners.add(callback);return{remove:()=>listeners.delete(callback)};}}};
 const deps={react:r.react,"react/jsx-runtime":r.runtime,"react-native":native,"react-native-webview":{WebView:"WebView"},"@/src/i18n":{useT:()=>({locale,t:value=>value}),translate:(_locale,value)=>value},"./Primitives":{FinalText:"FinalText"},"@/src/externalContent":policy};
 const Component=load(`src/uiuxfinal/PostSourcePreview${platform==="web"?".web":""}.tsx`,deps).PostSourcePreview;
 let tree;return{props,opens,render:()=>tree=r.render(Component,props),find:id=>find(tree,id),all:()=>walk(tree),visible:()=>JSON.stringify(tree),appState:state=>{native.AppState.currentState=state;for(const listener of listeners)listener(state);},listenerCount:()=>listeners.size,replayEffects:r.replayEffects,unmount:r.unmount,allowTopNavigation:load("src/uiuxfinal/PostSourcePreview.tsx",deps).allowPostSourceTopNavigation};
}

for(const platform of ["native","web"]){
 const frameId=platform==="web"?"post-source-iframe":"post-source-webview";
 test(`${platform} all3 locales remove the permanent extra hint but retain truthful load/error/retry/source controls`,()=>{
  const removed=["原站可能要求登录或不允许嵌入，可从右上角打开。","原站可能要求登入或不允許嵌入，可從右上角開啟。","The site may require sign-in or block previews. Open it with the top-right arrow.","The site may require sign-in or block embedding. Open it with the top-right arrow."];
  for(const locale of ["zh-CN","zh-TW","en"]){const p=preview(platform,{},locale);try{
   p.render();assert.ok(p.find(frameId));assert.ok(p.find("post-source-loading"));const noHint=()=>{assert.equal(p.find("post-source-hint"),undefined);for(const phrase of removed)assert.ok(!p.visible().includes(phrase));};noHint();assert.deepEqual(p.opens,[]);
   const frame=p.find(frameId),event=platform==="native"?{nativeEvent:{url:p.props.sourceUrl}}:undefined;frame.props.onLoad(event);p.render();noHint();assert.equal(p.find("post-source-loading"),undefined);assert.equal(p.find("post-source-error"),undefined);assert.doesNotMatch(p.visible(),/successfully|verified|加载成功|驗證成功|验证成功/i);
   frame.props.onError(event);p.render();noHint();assert.ok(p.find("post-source-error"));assert.ok(p.find("post-source-retry"));assert.ok(p.find("post-source-open"));assert.equal(p.find(frameId),undefined);assert.deepEqual(p.opens,[]);
  }finally{p.unmount();}}
 });
 test(`${platform} original source preview mounts only the current safe URL, without external dispatch or app transport`,()=>{
  const p=preview(platform);try{p.render();const frame=p.find(frameId);assert.ok(frame);assert.ok(p.find("post-source-preview"));assert.equal(p.find("post-source-hint"),undefined);assert.deepEqual(p.opens,[]);assert.doesNotMatch(p.visible(),/Bearer|Authorization|account-|source_click|copied-excerpt|article-illustration|reading-video-cover/);
   if(platform==="native"){assert.deepEqual(frame.props.source,{uri:p.props.sourceUrl});assert.equal(frame.props.source.headers,undefined);assert.equal(frame.props.injectedJavaScript,undefined);assert.equal(frame.props.injectedJavaScriptBeforeContentLoaded,undefined);assert.equal(frame.props.sharedCookiesEnabled,false);assert.equal(frame.props.thirdPartyCookiesEnabled,false);}
   else{assert.equal(frame.props.src,p.props.sourceUrl);assert.equal(frame.props.srcDoc,undefined);assert.equal(frame.props.referrerPolicy,"no-referrer");assert.doesNotMatch(frame.props.sandbox,/allow-(?:same-origin|forms|popups|top-navigation|downloads|presentation)/);assert.match(frame.props.sandbox,/allow-scripts/);}
  }finally{p.unmount();}
 });
 test(`${platform} invalid URLs never mount a browsing context or automatically dispatch`,()=>{
  for(const sourceUrl of [undefined,null,"","http://www.facebook.com/post/42","javascript:alert(1)","data:text/html,<script>alert(1)</script>","file:///private/secret","https://user:password@source.invalid/post","https://source.invalid:444/post","https://localhost/post","https://127.0.0.1/post","https://[::1]/post","https://host.internal/post","https://source.invalid/post?access_token=private","https://source.invalid\\@evil.invalid/post","https://source.invalid/post\n"]){const p=preview(platform,{sourceUrl});try{p.render();assert.equal(p.find(frameId),undefined,String(sourceUrl));assert.ok(p.find("post-source-unavailable"));assert.deepEqual(p.opens,[]);}finally{p.unmount();}}
 });
 test(`${platform} inactive and background previews unmount, resume with a fresh session and clean AppState subscriptions`,()=>{
  const p=preview(platform);try{p.render();assert.ok(p.find(frameId));assert.equal(p.listenerCount(),1);p.props.active=false;p.render();assert.equal(p.find(frameId),undefined);assert.ok(p.find("post-source-paused"));p.props.active=true;p.render();assert.ok(p.find(frameId));p.appState("background");p.render();assert.equal(p.find(frameId),undefined);p.appState("active");p.render();assert.ok(p.find(frameId));assert.deepEqual(p.opens,[]);}finally{p.unmount();}assert.equal(p.listenerCount(),0);
 });
 test(`${platform} original source controls call only the explicit supplied action and honor busy state`,()=>{
  const p=preview(platform);try{p.render();assert.equal(p.find("post-source-open"),undefined);p.find(frameId).props.onError(platform==="native"?{nativeEvent:{url:p.props.sourceUrl}}:undefined);p.render();const open=p.find("post-source-open");assert.ok(open);assert.equal(open.props.disabled,false);assert.deepEqual(p.opens,[]);open.props.onPress();assert.deepEqual(p.opens,["explicit"]);p.props.busy=true;p.render();assert.equal(p.find("post-source-open").props.disabled,true);open.props.onPress();assert.deepEqual(p.opens,["explicit"],"A saved enabled handler must still honor the current busy state");}finally{p.unmount();}
 });
 test(`${platform} load events do not fabricate source verification, and errors require an explicit retry`,()=>{
  const p=preview(platform),event=()=>platform==="native"?{nativeEvent:{url:p.props.sourceUrl}}:undefined;try{p.render();assert.ok(p.find("post-source-loading"));const frame=p.find(frameId);frame.props.onLoad(event());p.render();assert.equal(p.find("post-source-loading"),undefined);assert.equal(p.find("post-source-hint"),undefined);assert.doesNotMatch(p.visible(),/successfully|verified|source verified|加载成功|驗證成功|验证成功/i);assert.deepEqual(p.opens,[]);
   frame.props.onError(event());p.render();assert.ok(p.find("post-source-error"));assert.equal(p.find(frameId),undefined);assert.equal(p.find("post-source-loading"),undefined);frame.props.onLoad(event());p.render();assert.ok(p.find("post-source-error"),"Late load never clears a real failure");
   const retry=p.find("post-source-retry").props.onPress;p.props.busy=true;p.render();assert.equal(p.find("post-source-retry").props.disabled,true);retry();p.render();assert.ok(p.find("post-source-error"));p.props.busy=false;p.render();p.find("post-source-retry").props.onPress();p.render();assert.ok(p.find(frameId));assert.ok(p.find("post-source-loading"));assert.deepEqual(p.opens,[]);
  }finally{p.unmount();}
 });
 test(`${platform} retry callbacks from the previous browsing attempt cannot fail or complete the new attempt`,()=>{
  const p=preview(platform),event=()=>platform==="native"?{nativeEvent:{url:p.props.sourceUrl}}:undefined;try{p.render();const old=p.find(frameId).props;old.onError(event());p.render();p.find("post-source-retry").props.onPress();p.render();const fresh=p.find(frameId).props;old.onError(event());old.onLoad(event());p.render();assert.ok(p.find("post-source-loading"));assert.equal(p.find("post-source-error"),undefined);fresh.onLoad(event());p.render();assert.equal(p.find("post-source-loading"),undefined);assert.equal(p.find("post-source-error"),undefined);assert.deepEqual(p.opens,[]);}finally{p.unmount();}
 });
 test(`${platform} a batched background-active transition invalidates the old session before the next render`,()=>{
  const p=preview(platform);try{p.render();const old=p.find(frameId),event=platform==="native"?{nativeEvent:{url:p.props.sourceUrl}}:undefined;old.props.onLoad(event);p.render();assert.equal(p.find("post-source-loading"),undefined);p.appState("background");p.appState("active");old.props.onLoad(event);old.props.onError(event);p.render();assert.ok(p.find("post-source-loading"),"A previously completed child session must really remount, even though its inner browser key can repeat");assert.equal(p.find("post-source-error"),undefined);const fresh=p.find(frameId);old.props.onError(event);old.props.onLoad(event);p.render();assert.ok(p.find("post-source-loading"));fresh.props.onLoad(event);p.render();assert.equal(p.find("post-source-loading"),undefined);assert.deepEqual(p.opens,[]);}finally{p.unmount();}
 });
 test(`${platform} StrictMode effect cleanup-setup replay retains one subscription and a usable current browser`,()=>{
  const p=preview(platform);try{p.render();p.replayEffects();assert.equal(p.listenerCount(),1);p.render();const frame=p.find(frameId),event=platform==="native"?{nativeEvent:{url:p.props.sourceUrl}}:undefined;assert.ok(frame);frame.props.onLoad(event);p.render();assert.equal(p.find("post-source-loading"),undefined);frame.props.onError(event);p.render();assert.ok(p.find("post-source-error"));p.find("post-source-retry").props.onPress();p.render();assert.ok(p.find(frameId));assert.deepEqual(p.opens,[]);}finally{p.unmount();}assert.equal(p.listenerCount(),0);
 });
 for(const change of ["url","inactive","background","unmount"])test(`${platform} old-session callbacks cannot mutate or open the current preview after ${change}`,()=>{
  const p=preview(platform);let oldOpen;try{p.render();const oldFrame=p.find(frameId).props,oldEvent=platform==="native"?{nativeEvent:{url:p.props.sourceUrl}}:undefined;oldFrame.onError(oldEvent);p.render();oldOpen=p.find("post-source-open").props.onPress;
   if(change==="url")p.props.sourceUrl="https://www.instagram.com/p/NEWPOST/";else if(change==="inactive")p.props.active=false;else if(change==="background")p.appState("background");else p.unmount();
   if(change!=="unmount")p.render();oldFrame.onLoad(oldEvent);oldFrame.onError(oldEvent);oldOpen();assert.deepEqual(p.opens,[]);
   if(change==="url"){p.render();assert.ok(p.find("post-source-loading"));assert.equal(p.find("post-source-error"),undefined);const frame=p.find(frameId);assert.equal(platform==="native"?frame.props.source.uri:frame.props.src,p.props.sourceUrl);}
   else if(change!=="unmount"){p.render();assert.equal(p.find(frameId),undefined);assert.ok(p.find("post-source-paused"));p.props.active=true;p.appState("active");p.render();assert.ok(p.find(frameId));assert.ok(p.find("post-source-loading"));assert.equal(p.find("post-source-error"),undefined);}
  }finally{p.unmount();}
 });
}
test("native browser cancels unsafe navigation and unrequested windows, and keeps app privileges out of the page",()=>{
 const p=preview();try{p.render();const frame=p.find("post-source-webview").props;
  for(const url of ["http://source.invalid/","javascript:alert(1)","file:///private/secret","data:text/html,private","https://secret@source.invalid/","https://host.local/","https://127.0.0.1/","https://source.invalid:444/","https://source.invalid/?authorization=secret"]){assert.equal(frame.onShouldStartLoadWithRequest({url,isTopFrame:true}),false,url);}
  assert.equal(frame.onShouldStartLoadWithRequest({url:"https://www.facebook.com/login/",isTopFrame:true}),true);frame.onOpenWindow({nativeEvent:{targetUrl:"https://source.invalid/window"}});assert.deepEqual(p.opens,[]);
  for(const flag of ["sharedCookiesEnabled","thirdPartyCookiesEnabled","useSharedProcessPool","cacheEnabled","allowFileAccess","allowFileAccessFromFileURLs","allowUniversalAccessFromFileURLs","allowsPictureInPictureMediaPlayback","allowsAirPlayForMediaPlayback","allowsFullscreenVideo","geolocationEnabled","javaScriptCanOpenWindowsAutomatically","paymentRequestEnabled","enableApplePay","webviewDebuggingEnabled"])assert.equal(frame[flag],false,flag);
  for(const flag of ["incognito","saveFormDataDisabled","mediaPlaybackRequiresUserAction","scrollEnabled","nestedScrollEnabled"])assert.equal(frame[flag],true,flag);
  assert.equal(frame.mediaCapturePermissionGrantType,"deny");assert.equal(frame.mixedContentMode,"never");assert.equal(frame.onMessage,undefined);assert.equal(frame.source.headers,undefined);
 }finally{p.unmount();}
});
test("native HTTP errors affect only the current top page; downloads and terminated processes cannot appear successful",()=>{
 for(const kind of ["http","download","content-process","render-process"]){const p=preview();try{p.render();const frame=p.find("post-source-webview").props;frame.onHttpError({nativeEvent:{url:"https://third-party.invalid/tracker",statusCode:503}});p.render();assert.equal(p.find("post-source-error"),undefined);if(kind==="http")frame.onHttpError({nativeEvent:{url:p.props.sourceUrl,statusCode:403}});else if(kind==="download")frame.onFileDownload();else if(kind==="content-process")frame.onContentProcessDidTerminate();else frame.onRenderProcessGone();p.render();assert.ok(p.find("post-source-error"),kind);assert.equal(p.find("post-source-webview"),undefined);assert.deepEqual(p.opens,[]);}finally{p.unmount();}}
});
test("native unsafe top navigation stays in error despite late load-start/load, while unsafe subframes only cancel",()=>{
 const p=preview();try{p.render();const frame=p.find("post-source-webview").props;assert.equal(frame.onShouldStartLoadWithRequest({url:"javascript:alert(1)",isTopFrame:false}),false);p.render();assert.equal(p.find("post-source-error"),undefined);assert.ok(p.find("post-source-webview"));assert.equal(frame.onShouldStartLoadWithRequest({url:"file:///private/secret",isTopFrame:true}),false);const event={nativeEvent:{url:p.props.sourceUrl}};frame.onLoadStart(event);frame.onLoad(event);p.render();assert.ok(p.find("post-source-error"));assert.equal(p.find("post-source-webview"),undefined);assert.deepEqual(p.opens,[]);}finally{p.unmount();}
});
test("native top-page policy permits only the source host aliases or its own explicit social root, never another public origin",()=>{
 const p=preview();try{const allow=p.allowTopNavigation;assert.equal(typeof allow,"function");
  for(const root of ["facebook.com","instagram.com","threads.net","threads.com","x.com","twitter.com"]){const source=`https://www.${root}/original/42`;for(const target of [`https://${root}/login`,`https://m.${root}/post/42`,`https://accounts.${root}/login`])assert.equal(allow(source,target),true,`${source} -> ${target}`);for(const other of ["facebook.com","instagram.com","threads.net","threads.com","x.com","twitter.com"].filter(value=>value!==root))assert.equal(allow(source,`https://${other}/login`),false);for(const target of [`https://${root}.evil.invalid/login`,"https://unrelated.invalid/login","https://accounts.google.com/login","https://evil.invalid/"])assert.equal(allow(source,target),false);}
  const source="https://publisher.invalid/post/42";for(const target of ["https://publisher.invalid/next","https://www.publisher.invalid/next","https://m.publisher.invalid/next","https://PUBLISHER.invalid./next"])assert.equal(allow(source,target),true,target);for(const target of ["https://static.publisher.invalid/next","https://publisher.invalid.evil.invalid/next","http://publisher.invalid/next","https://user@publisher.invalid/next","https://publisher.invalid:444/next","https://publisher.invalid/next?api_key=secret"])assert.equal(allow(source,target),false,target);
  assert.equal(allow("javascript:alert(1)","https://publisher.invalid/next"),false);assert.equal(allow(null,"https://publisher.invalid/next"),false);
 }finally{p.unmount();}
});
test("native unrelated top-frame redirects fail honestly without auto-opening or replacing the original-source action",()=>{
 for(const url of ["https://facebook.com.evil.invalid/login","https://unrelated.invalid/newpost","https://accounts.google.com/login","https://instagram.com/login"]){const p=preview();try{p.render();const frame=p.find("post-source-webview").props;assert.equal(frame.onShouldStartLoadWithRequest({url:"https://public-cdn.invalid/frame",isTopFrame:false}),true,"Safe third-party subframes are not top-page replacements");assert.equal(frame.onShouldStartLoadWithRequest({url:"https://m.facebook.com/login",isTopFrame:true}),true);assert.equal(frame.onShouldStartLoadWithRequest({url,isTopFrame:true}),false,url);frame.onLoadStart({nativeEvent:{url:"https://m.facebook.com/login"}});frame.onLoad({nativeEvent:{url:"https://m.facebook.com/login"}});p.render();assert.ok(p.find("post-source-error"));assert.equal(p.find("post-source-webview"),undefined);assert.deepEqual(p.opens,[]);assert.equal(p.props.sourceUrl,"https://www.facebook.com/groups/public/posts/42/");p.find("post-source-open").props.onPress();assert.deepEqual(p.opens,["explicit"]);}finally{p.unmount();}}
});
test("web sandbox denies device privileges, page escape and credential propagation without claiming universal cookie isolation",()=>{
 const p=preview("web");try{p.render();const frame=p.find("post-source-iframe").props;assert.equal(frame.sandbox,"allow-scripts");assert.equal(frame.credentialless,"");for(const privilege of ["camera","microphone","geolocation","autoplay","fullscreen","payment","clipboard-read","clipboard-write"])assert.ok(frame.allow.includes(`${privilege} 'none'`));assert.equal(frame.onMessage,undefined);assert.equal(frame.dangerouslySetInnerHTML,undefined);assert.deepEqual(p.opens,[]);}finally{p.unmount();}
});
test("preview sources contain no scraper, app API, success navigation or automatic external launch",()=>{
 for(const path of ["src/uiuxfinal/PostSourcePreview.tsx","src/uiuxfinal/PostSourcePreview.web.tsx"]){const source=readFileSync(path,"utf8");assert.doesNotMatch(source,/\bfetch\s*\(|XMLHttpRequest|@\/src\/api|Linking\.|openBrowserAsync|router\.(?:push|replace)|injectedJavaScript|srcDoc\s*=/);}
});

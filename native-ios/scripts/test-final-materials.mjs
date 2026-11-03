import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {test} from 'node:test';
import ts from 'typescript';
const jsx=(type,props)=>({type,props}),runtime={jsx,jsxs:jsx};
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
const flatten=s=>Array.isArray(s)?Object.assign({},...s.filter(Boolean).map(flatten)):s??{};
const rn={View:'View',Text:'Text',Pressable:'Pressable',StyleSheet:{create:x=>x,absoluteFill:{position:'absolute',top:0,right:0,bottom:0,left:0}},Platform:{OS:'ios'}};
function load(path,deps){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>{if(name.startsWith('@/assets/'))return name;assert.ok(name in deps,'Unexpected dependency '+name);return deps[name];},m,m.exports);return m.exports;}
// Decode actual pixels, not just IHDR's misleading "has alpha" flag.
function alpha(path){const png=readFileSync(path),idat=[];let w,h;for(let o=8;o<png.length;){const length=png.readUInt32BE(o),kind=png.toString('ascii',o+4,o+8),data=png.subarray(o+8,o+8+length);if(kind==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);assert.equal(data[8],8);assert.equal(data[9],6);assert.equal(data[12],0);}if(kind==='IDAT')idat.push(data);o+=length+12;}
 const raw=inflateSync(Buffer.concat(idat)),stride=w*4,out=Buffer.alloc(stride*h);let p=0;
 const paeth=(a,b,c)=>{const v=a+b-c,A=Math.abs(v-a),B=Math.abs(v-b),C=Math.abs(v-c);return A<=B&&A<=C?a:B<=C?b:c;};
 for(let y=0;y<h;y++){const f=raw[p++];assert.ok(f<=4);for(let x=0;x<stride;x++){const i=y*stride+x,a=x>=4?out[i-4]:0,b=y?out[i-stride]:0,c=y&&x>=4?out[i-stride-4]:0;out[i]=(raw[p++]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][f])&255;}}
 let clear=0,opaque=0,max=0;for(let i=3;i<out.length;i+=4){const a=out[i];clear+=a===0;opaque+=a===255;max=Math.max(max,a);}return{w,h,clear:clear/(w*h),opaque,max,corners:[out[3],out[stride-1],out[(h-1)*stride+3],out.at(-1)]};}
test('home uses real transparent original Figma shadow, not an opaque white canvas with an alpha channel',()=>{
 const a=alpha('assets/final-flow-20261101/home-shadow-alpha.png');assert.deepEqual([a.w,a.h],[1185,996]);assert.ok(a.clear>.95);assert.equal(a.opaque,0);assert.ok(a.max>0&&a.max<200);assert.deepEqual(a.corners,[0,0,0,0]);
 const legacy=alpha('assets/final-flow-20261101/home-shadow.png');assert.equal(legacy.opaque,395*332,'negative control reproduces the reported bug');
 const scene=readFileSync('src/uiux48/Scene.tsx','utf8');assert.match(scene,/home-shadow-alpha\.png/);assert.doesNotMatch(scene,/require\([^\n]*\/home-shadow\.png/);assert.match(scene,/left:7,top:333,width:395,height:332/);
});
const surfaces=os=>load('src/uiuxfinal/Primitives.tsx',{'react/jsx-runtime':runtime,'react-native':{...rn,Platform:{OS:os}},'expo-blur':{BlurView:'Blur'},'@/src/i18n':{useT:()=>({locale:'en'})}});
test('Figma card/navigation materials preserve independent soft shadow, rounded clip, white half-fill and no invented rim',()=>{
 for(const os of ['ios','web'])for(const material of ['card','navigation']){const tree=surfaces(os).FinalSurface({material,children:'fixture'}),all=nodes(tree),outer=flatten(tree.props.style),clip=tree.props.children;
  assert.equal(outer.borderRadius,28);assert.notEqual(outer.overflow,'hidden');assert.equal(clip.props.style.overflow,'hidden');assert.equal(outer.boxShadow,material==='navigation'?'0px 4px 10px rgba(0,0,0,.125)':'0px 1px 15px rgba(92,86,98,.18)');
  assert.ok(all.some(n=>flatten(n.props?.style).backgroundColor==='rgba(255,255,255,.5)'));assert.equal(all.some(n=>flatten(n.props?.style).borderWidth>0),false);
  if(os==='web')assert.ok(all.some(n=>flatten(n.props?.style).backdropFilter===`blur(${material==='navigation'?10:20}px)`));else assert.equal(all.find(n=>n.type==='Blur').props.intensity,material==='navigation'?20:40);
 }
});
test('chat bubbles keep role fills, 18pt corners and blurred border-box shadows rather than glass-card material',()=>{
 for(const incoming of [true,false]){const child={fixture:'message/action'},tree=surfaces('ios').FinalChatBubble({incoming,children:child,testID:'bubble'}),s=flatten(tree.props.style);assert.equal(tree.props.children,child);assert.equal(s.borderRadius,18);assert.equal(s.backgroundColor,incoming?'#FFFAF2':'rgba(235,129,131,.15)');assert.equal(s.boxShadow,'0px 0px 8px rgba(0,0,0,.1)');assert.equal(nodes(tree).some(n=>n.type==='Blur'),false);}
});
test('chat uses its own original background image with actual point-radius blur and a separate veil; keyboard does not rescale it',()=>{
 const ref={current:null};let dimensions={width:402,height:874};const C=load('src/uiuxfinal/ChatBackdrop.tsx',{react:{useRef:v=>(ref.current??=v,ref)},'react/jsx-runtime':runtime,'react-native':{...rn,useWindowDimensions:()=>dimensions},'expo-image':{Image:'Image'}}).FinalChatBackdrop;
 const one=C(),pattern=nodes(one).find(n=>n.props?.testID==='final-chat-background-pattern');assert.equal(pattern.props.source,'@/assets/final-flow-20261101/chat-background-source.png');assert.equal(pattern.props.blurRadius,20);assert.equal(one.props.pointerEvents,'none');assert.equal(flatten(nodes(one).find(n=>n.props?.testID==='final-chat-background-veil').props.style).backgroundColor,'rgba(255,255,255,.5)');
 dimensions={width:402,height:500};assert.equal(flatten(C().props.style).height,874);dimensions={width:390,height:844};assert.equal(flatten(C().props.style).height,844);
});
test('actual three-tab navigation highlights only active icon coral, keeps white capsule, and guards draft navigation without side effects on render',()=>{
 for(const path of ['/','/chats','/community']){const calls=[],theme={ink:'#4A454D'},sur=surfaces('ios');const C=load('src/uiux48/Shell.tsx',{react:{},'react/jsx-runtime':runtime,'react-native':rn,'expo-router':{usePathname:()=>path,useRouter:()=>({navigate:r=>calls.push(r)})},'react-native-safe-area-context':{useSafeAreaInsets:()=>({bottom:34})},'expo-status-bar':{},'expo-image':{},'expo-linear-gradient':{},'expo-blur':{},'@/src/i18n':{useT:()=>({locale:'en'}),translate:(_l,s)=>s},'@/src/components/NativePageControls':{},'@/src/components/nativeNavigation':{requestGuardedNativeNavigation:()=>true},'./Scene':{},'./Theme':{useNuriTheme:()=>theme},'./Primitives':{NuriIcon:'Icon'},'@/src/uiuxfinal/Primitives':{...sur,FinalSurface:'Surface'},'@/src/uiuxfinal/ChatBackdrop':{},'@/src/uiuxfinal/ReadingBackdrop':{},'./keyboard':{}}).NuriTabBar;
  const all=nodes(C()),tabs=all.filter(n=>n.props?.accessibilityRole==='tab');assert.equal(tabs.length,3);assert.deepEqual(calls,[]);assert.equal(all.find(n=>n.type==='Surface').props.material,path==='/community'?'community-navigation':'navigation');
  assert.equal(tabs.filter(n=>n.props.accessibilityState.selected).length,1);
  assert.equal(tabs.find(n=>n.props.accessibilityState.selected).props.testID,path==='/'?'nuri-tab-home':path==='/chats'?'nuri-tab-chat':'nuri-tab-community');
  for(const tab of tabs){const selected=tab.props.accessibilityState.selected;assert.equal((tab.props.children.props.color??tab.props.children.props.tintColor),selected?'#EB8183':'#4A454D');assert.equal(flatten(tab.props.style).backgroundColor,selected?'rgba(255,255,255,.4)':'transparent');assert.equal(flatten(tab.props.style).height,44);tab.props.onPress();}assert.deepEqual(calls,[]);
 }
});
test('filled card and custom radius preserve all scrolling layers and the independent outer shadow',()=>{
 const tree=surfaces('ios').FinalSurface({fill:true,radius:18,children:'scroll fixture'}),inner=tree.props.children,content=inner.props.children.at(-1);
 for(const node of [tree,inner,content]){assert.equal(flatten(node.props.style).flex,1);assert.equal(flatten(node.props.style).minHeight,0);}
 assert.equal(flatten(tree.props.style).borderRadius,18);assert.equal(flatten(inner.props.style).borderRadius,18);assert.notEqual(flatten(tree.props.style).overflow,'hidden');
});

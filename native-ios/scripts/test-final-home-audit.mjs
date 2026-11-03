import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import ts from 'typescript';
const jsx=(type,props)=>({type,props}),flatten=s=>Array.isArray(s)?Object.assign({},...s.filter(Boolean).map(flatten)):s??{};
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
function load(path,deps){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(n=>{if(n==='./ButtonMaterial')return {FrostedPressable:deps['react-native']?.Pressable??'Pressable',ButtonBackdrop:'ButtonBackdrop'};if(n.startsWith('@/assets/'))return n;assert.ok(n in deps,n);return deps[n]},m,m.exports);return m.exports;}
const base={'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{Text:'Text',View:'View',StyleSheet:{flatten,absoluteFill:{}},Platform:{OS:'web'}},'expo-blur':{BlurView:'Blur'},'@/src/i18n':{useT:()=>({locale:'zh-CN'})}};
test('FinalText uses the registered font face for each requested weight and honors explicit font family',()=>{
 const {FinalText}=load('src/uiuxfinal/Primitives.tsx',base);
 for(const [weight,face] of [['400','400Regular'],['500','500Medium'],['600','600SemiBold'],['700','700Bold'],['bold','700Bold']])assert.equal(flatten(FinalText({style:{fontWeight:weight},children:'测试'}).props.style).fontFamily,'NotoSansSC_'+face);
 assert.equal(flatten(FinalText({style:{fontFamily:'Explicit'},children:'X'}).props.style).fontFamily,'Explicit');
});
test('home video slot derives only current video cover, with a separate URI failure state and original 20pt play asset',()=>{
 let value=null;const ref={current:null};const C=load('src/uiuxfinal/HomeVideoThumbnail.tsx',{'react/jsx-runtime':base['react/jsx-runtime'],react:{useRef:()=>ref,useState:()=>[value,v=>{value=v}]},'react-native':{View:'View'},'expo-image':{Image:'Image'},'@/src/recommendationMedia':{youtubeVideoThumbnail:id=>['fixture-id','fixture-b'].includes(id)?`https://i.ytimg.com/vi/${id}/hqdefault.jpg`:null}}).HomeVideoThumbnail;
 let tree=C({videoId:'fixture-id'}),all=nodes(tree),cover=all.find(n=>n.props?.source?.uri);assert.equal(cover.props.recyclingKey,cover.props.source.uri);assert.equal(cover.props.cachePolicy,'memory');cover.props.onError();assert.equal(nodes(C({videoId:'fixture-id'})).some(n=>n.props?.source?.uri),false);assert.equal(nodes(C({videoId:'other'})).some(n=>n.props?.source?.uri),false);
 const play=all.find(n=>typeof n.props?.source==='string');assert.match(play.props.source,/home-video-play\.svg$/);assert.deepEqual(play.props.style,{width:20,height:20});assert.deepEqual(tree.props.style,{width:72,height:80,borderRadius:16,overflow:'hidden',backgroundColor:'#746B7E'});
 const current=nodes(C({videoId:'fixture-b'})).find(n=>n.props?.source?.uri);current.props.onError();cover.props.onError();assert.equal(nodes(C({videoId:'fixture-b'})).some(n=>n.props?.source?.uri),false,'late A failure must not resurrect failed B');
});
test('Home layout retains real controllers while matching source card/header slots and no illustrative video cover',()=>{
 const source=readFileSync('app/(tabs)/index.tsx','utf8');assert.match(source,/paddingLeft:16,paddingRight:32/);assert.match(source,/HomeVideoThumbnail videoId=\{dailyVideo\?\.video_id\}/);assert.doesNotMatch(source,/imgThumbnailAfternoonScene/);assert.match(source,/FinalSurface bordered contentStyle=\{\{minHeight:169/);assert.match(source,/paddingTop:16,paddingBottom:46,gap:7/);assert.match(source,/openDailyPost\(dailyPost\)/);assert.match(source,/openDailyVideo\(dailyVideo\)/);assert.match(source,/onPress=\{openNuriChat\}/);
});
test('scoped materials do not force community appearance onto Home or reading',()=>{
 const {FinalSurface}=load('src/uiuxfinal/Primitives.tsx',base);
 for(const [material,color,shadow] of [['navigation','rgba(255,255,255,.5)','0px 4px 10px rgba(0,0,0,.125)'],['community-navigation','rgba(255,255,255,.4)','0px 0px 8px rgba(0,0,0,.12)']]){const tree=FinalSurface({material,children:'X'});assert.equal(flatten(tree.props.style).boxShadow,shadow);assert.ok(nodes(tree).some(n=>flatten(n.props?.style).backgroundColor===color));}
 const card=FinalSurface({surfaceColor:'rgba(235,223,216,.75)',bordered:true,children:'X'});assert.ok(nodes(card).some(n=>flatten(n.props?.style).backgroundColor==='rgba(235,223,216,.75)'));assert.ok(nodes(card).some(n=>flatten(n.props?.style).borderWidth===1));
});
test('all bottom tabs use unchanged original32pt community SVGs; legacy20pt artwork is not enlarged or rewritten',()=>{
 const expected={home:'16bd6fb0f8a1e25cdf6a99f441827d5bbbb873edbc1814b2682510f8ed774b7c',chat:'91727a3e5069f1c36fc87af7af60d91e240a31808690a4a568fc86bf29791e13',community:'7436c31f3339e5f1f6c63f89f589455a44ae29dc7509bc7d7927c3bbe3435016'};
 for(const icon of ['home','chat','community']){const bytes=readFileSync(`assets/final-flow-20261101/${icon}.svg`);assert.ok(bytes.length>0);assert.equal(createHash('sha256').update(bytes).digest('hex'),expected[icon]);const root=bytes.toString('utf8').match(/<svg\b[^>]*>/)?.[0];assert.ok(root);assert.match(root,/width="32"/);assert.match(root,/height="32"/);assert.match(root,/viewBox="0 0 32 32"/);
  const legacyRoot=readFileSync(`assets/final-flow-20261101/home-tab-${icon}.svg`,'utf8').match(/<svg\b[^>]*>/)?.[0];assert.ok(legacyRoot);assert.match(legacyRoot,/width="20"/);assert.match(legacyRoot,/height="20"/);
 }
 const shell=readFileSync('src/uiux48/Shell.tsx','utf8');assert.match(shell,/paddingBottom:Math\.max\(21,safe\.bottom-13\)/);assert.match(shell,/paddingTop:18/);assert.match(shell,/material=\{community\?"community-navigation":"navigation"\}/);assert.match(shell,/<NuriIcon name=\{tab\.name\} color=\{active===tab\.name\?FINAL_COLOR\.coral:FINAL_COLOR\.ink\} size=\{32\}\/>/);assert.doesNotMatch(shell,/homeIcons|home-tab-(?:home|chat|community)\.svg/);
});

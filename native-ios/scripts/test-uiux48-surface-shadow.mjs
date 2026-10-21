import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';

const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
function load(path,deps={}){
 const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const module={exports:{}};
 new Function('require','module','exports',code)(name=>{
  if(name.startsWith('@/assets/'))return name;
  assert.ok(name in deps,'Unexpected import '+name);return deps[name];
 },module,module.exports);return module.exports;
}
const materials=load('src/uiux48/materials.ts');
const flatten=s=>!s?{}:Array.isArray(s)?Object.assign({},...s.map(flatten)):s;
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
function primitives(mode){
 const jsx=(type,props)=>({type,props});
 const theme={mode,night:mode==='Night',ink:'#49404f',glass:'rgba(255,248,242,.44)',message:'rgba(255,248,241,.76)',userMessage:'rgba(251,221,224,.6)',composer:'rgba(255,248,241,.92)',coral:'rgba(240,142,150,.7)',token:()=>mode==='Night'?'rgba(166,125,153,.26)':'rgba(242,171,179,.35)'};
 return load('src/uiux48/Primitives.tsx',{
  react:{forwardRef:x=>x},'react/jsx-runtime':{jsx,jsxs:jsx},
  'react-native':{ActivityIndicator:'Activity',KeyboardAvoidingView:'KAV',Platform:{OS:'ios'},Pressable:'Pressable',ScrollView:'Scroll',Switch:'Switch',Text:'Text',TextInput:'Input',View:'View',StyleSheet:{create:x=>x,flatten,absoluteFill:{position:'absolute',left:0,right:0,top:0,bottom:0}}},
  'expo-blur':{BlurView:'Blur'},'expo-image':{Image:'Image'},'expo-linear-gradient':{LinearGradient:'Gradient'},'@/src/i18n':{useT:()=>({locale:'en'})},'expo-router':{},'./Theme':{useNuriTheme:()=>theme},'./materials':materials,'./GlassLighting':{GlassLighting:'GlassLighting'},'@/src/uiux49/spec':load('src/uiux49/spec.ts'),
 });
}
test('shared transparent glass never uses content-pixel legacy shadows; all roles keep independent rounded blur clipping',()=>{
 for(const mode of ['Morning','Afternoon','Night'])for(const kind of ['card','message','user','composer','pill']){
  const p=primitives(mode),tree=p.GlassSurface({kind,children:'fixture'}),style=flatten(tree.props.style);
  assert.equal(style.boxShadow,kind==='pill'?materials.GLASS_SHADOW48.floating:materials.GLASS_SHADOW48.surface);
  for(const name of ['shadowColor','shadowOffset','shadowRadius','shadowOpacity','elevation'])assert.equal(style[name],undefined);
  assert.notEqual(style.overflow,'hidden','The outward-fading shadow must not clip');
  const inner=tree.props.children,blur=nodes(tree).find(x=>x.type==='Blur'),clip=flatten(inner.props.style),blurClip=flatten(blur.props.style);
  assert.equal(clip.overflow,'hidden');assert.equal(clip.borderRadius,style.borderRadius);
  assert.equal(blurClip.overflow,'hidden');assert.equal(blurClip.borderRadius,style.borderRadius);
  assert.equal(blur.props.intensity,materials.GLASS_BLUR48[mode][kind]);
 }
});
test('all nested choice chips, including all three languages, are flat without losing selection or callbacks',()=>{
 for(const mode of ['Morning','Afternoon','Night'])for(const label of ['简体中文','繁體中文','English'])for(const selected of [false,true]){
  let calls=0;const p=primitives(mode),tree=p.ChoiceChip({label,selected,onPress:()=>calls++}),surface=tree.props.children;
  assert.equal(surface.props.shadow,false);assert.equal(flatten(p.GlassSurface(surface.props).props.style).boxShadow,undefined);
  assert.equal(tree.props.accessibilityRole,'checkbox');assert.equal(tree.props.accessibilityState.checked,selected);
  assert.equal(calls,0);tree.props.onPress();assert.equal(calls,1);
  assert.equal(surface.props.contentStyle.minHeight,50);assert.equal(surface.props.contentStyle.borderRadius,999);
  assert.equal(surface.props.contentStyle.backgroundColor==='transparent',!selected);
 }
 const disabled=primitives('Night').ChoiceChip({label:'fixture',selected:true,disabled:true,onPress:()=>{}});
 assert.equal(disabled.props.disabled,true);assert.equal(disabled.props.accessibilityState.disabled,true);
});
test('floating CTAs retain soft border-box shadows, full pill clipping and existing busy/disabled semantics',()=>{
 for(const mode of ['Morning','Afternoon','Night'])for(const secondary of [false,true])for(const busy of [false,true]){
  let calls=0;const p=primitives(mode),tree=p.NuriButton({label:'fixture',secondary,busy,disabled:true,onPress:()=>calls++}),style=flatten(tree.props.style),press=tree.props.children;
  assert.equal(style.boxShadow,materials.GLASS_SHADOW48.button);assert.equal(style.borderRadius,999);
  assert.equal(style.shadowOpacity,undefined);assert.equal(press.props.disabled,true);assert.equal(press.props.accessibilityState.busy,busy);assert.equal(calls,0);
  const blur=nodes(press).find(x=>x.type==='Blur'),clip=flatten(blur.props.style);assert.equal(clip.borderRadius,999);assert.equal(clip.overflow,'hidden');
 }
 for(const shadow of Object.values(materials.GLASS_SHADOW48)){
  const match=shadow.match(/^0px (\d+)px (\d+)px (-\d+)px rgba\(58,43,83,([\d.]+)\)$/);assert.ok(match);
  assert.ok(Number(match[2])>=2*Number(match[1]));assert.ok(Number(match[3])<0);assert.ok(Number(match[4])<=.1);
 }
});

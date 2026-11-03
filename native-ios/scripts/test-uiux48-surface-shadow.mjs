import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';

const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
function load(path,deps={}){
 deps={...deps,'@/src/uiuxfinal/ButtonMaterial':{FrostedPressable:deps['react-native']?.Pressable??'Pressable',ButtonBackdrop:'ButtonBackdrop'}};
 const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const module={exports:{}};
 new Function('require','module','exports',code)(name=>{
  if(name==='@/src/keyboard/AppKeyboard')return {NuriTextInput:deps['react-native']?.TextInput??'Input',useAppKeyboardVisible:()=>false,useAppKeyboard:()=>({visible:false,height:0,activeHostId:null,dismiss:()=>{}}),AppKeyboardScope:({children})=>children,AppKeyboardHost:'AppKeyboardHost'};
  if(name.startsWith('@/assets/'))return name;
  if(name==='./inputLayout')return load('src/uiux48/inputLayout.ts');
  assert.ok(name in deps,'Unexpected import '+name);return deps[name];
 },module,module.exports);return module.exports;
}
const materials=load('src/uiux48/materials.ts');
const flatten=s=>!s?{}:Array.isArray(s)?Object.assign({},...s.map(flatten)):s;
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
function primitives(mode){
 const jsx=(type,props)=>({type,props});
 const theme={mode,night:mode==='Night',keyboard:{appearance:mode==='Night'?'dark':'light'},ink:'#49404f',glass:'rgba(255,248,242,.44)',message:'rgba(255,248,241,.76)',userMessage:'rgba(251,221,224,.6)',composer:'rgba(255,248,241,.92)',coral:'rgba(240,142,150,.7)',token:()=>mode==='Night'?'rgba(166,125,153,.26)':'rgba(242,171,179,.35)'};
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
  const inner=tree.props.children,clip=flatten(inner.props.style);
  assert.equal(clip.overflow,'hidden');assert.equal(clip.borderRadius,style.borderRadius);
  if(kind==='pill'){const material=nodes(tree).find(x=>x.type==='ButtonBackdrop');assert.ok(material);assert.equal(material.props.radius,style.borderRadius);assert.equal(material.props.blurRadius,40);assert.equal(material.props.opacity,1);}
  else{const blur=nodes(tree).find(x=>x.type==='Blur'),blurClip=flatten(blur.props.style);assert.equal(blurClip.overflow,'hidden');assert.equal(blurClip.borderRadius,style.borderRadius);assert.equal(blur.props.intensity,materials.GLASS_BLUR48[mode][kind]);}
 }
});
test('shared fields vertically center one-line content without centering multiline notes',()=>{
 const p=primitives('Morning'),onChangeText=()=>{},ref={current:null};
 for(const multiline of [false,true]){
  const tree=p.NuriField({value:'fixture',multiline,onChangeText,style:multiline?{height:96,paddingTop:14}:undefined},ref),input=nodes(tree).find(n=>n.type==='Input'),style=flatten(input.props.style);
  assert.equal(style.textAlignVertical,multiline?'top':'center');assert.equal(style.paddingVertical,multiline?14:0);assert.equal(style.includeFontPadding,false);
  assert.equal(input.props.onChangeText,onChangeText);assert.equal(input.props.ref,ref);assert.equal(input.props.value,'fixture');
 }
});
test('all nested choice chips, including all three languages, are flat without losing selection or callbacks',()=>{
 for(const mode of ['Morning','Afternoon','Night'])for(const label of ['简体中文','繁體中文','English'])for(const selected of [false,true]){
  let calls=0;const p=primitives(mode),tree=p.ChoiceChip({label,selected,onPress:()=>calls++}),surface=tree.props.children;
  assert.equal(surface.props.shadow,false);assert.equal(flatten(p.GlassSurface(surface.props).props.style).boxShadow,undefined);
  assert.equal(tree.props.accessibilityRole,'checkbox');assert.equal(tree.props.accessibilityState.checked,selected);
  assert.equal(calls,0);tree.props.onPress();assert.equal(calls,1);
  assert.equal(surface.props.contentStyle.minHeight,50);assert.equal(surface.props.contentStyle.borderRadius,999);
  const selectedFill=surface.props.children[0],labelNode=surface.props.children[1];
  assert.equal(surface.props.contentStyle.backgroundColor,undefined);assert.equal(flatten(selectedFill.props.style).backgroundColor==='transparent',!selected);assert.equal(flatten(selectedFill.props.style).opacity,1);assert.equal(surface.props.controlOpacity,1);assert.equal(tree.props.style.opacity,undefined);assert.equal(flatten(labelNode.props.style).opacity,undefined);
 }
 const disabled=primitives('Night').ChoiceChip({label:'fixture',selected:true,disabled:true,onPress:()=>{}});
 assert.equal(disabled.props.disabled,true);assert.equal(disabled.props.accessibilityState.disabled,true);
 assert.equal(disabled.props.style.opacity,undefined);assert.equal(disabled.props.children.props.controlOpacity,.45);assert.equal(flatten(disabled.props.children.props.children[0].props.style).opacity,.45);assert.equal(flatten(disabled.props.children.props.children[1].props.style).opacity,undefined);
});
test('filled glass stretches every clipping/content layer without clipping the outer shadow or changing default cards',()=>{
 for(const mode of ['Morning','Afternoon','Night']){
  const p=primitives(mode),filled=p.GlassSurface({fill:true,children:'fixture',style:{flex:1}}),normal=p.GlassSurface({children:'fixture'});
  const clip=filled.props.children,content=clip.props.children.at(-1);
  assert.equal(flatten(clip.props.style).flex,1);assert.equal(flatten(clip.props.style).minHeight,0);
  assert.equal(flatten(content.props.style).flex,1);assert.equal(flatten(content.props.style).minHeight,0);
  assert.notEqual(flatten(filled.props.style).overflow,'hidden');assert.equal(flatten(normal.props.children.props.style).flex,undefined);
 }
});
test('floating CTAs retain soft border-box shadows, full pill clipping and existing busy/disabled semantics',()=>{
 for(const mode of ['Morning','Afternoon','Night'])for(const secondary of [false,true])for(const busy of [false,true]){
  let calls=0;const p=primitives(mode),tree=p.NuriButton({label:'fixture',secondary,busy,disabled:true,onPress:()=>calls++}),style=flatten(tree.props.style),press=tree.props.children;
  assert.equal(style.boxShadow,materials.GLASS_SHADOW48.button);assert.equal(style.borderRadius,999);
  assert.equal(style.shadowOpacity,undefined);assert.equal(press.props.disabled,true);assert.equal(press.props.accessibilityState.busy,busy);assert.equal(calls,0);
  assert.equal(typeof press.props.children,'function');const rendered=press.props.children({pressed:true}),material=nodes(rendered).find(x=>x.type==='ButtonBackdrop');assert.ok(material);assert.equal(material.props.radius,999);assert.equal(material.props.blurRadius,40);assert.equal(material.props.opacity,.5);assert.equal(flatten(press.props.style).opacity,undefined);assert.equal(style.opacity,undefined);assert.equal(nodes(material).some(x=>x.type==='Text'||x.type==='Activity'),false);
  const foreground=nodes(rendered).find(x=>x.type===(busy?'Activity':'Text'));assert.ok(foreground);assert.equal(flatten(foreground.props.style).opacity,undefined);
 }
 for(const shadow of Object.values(materials.GLASS_SHADOW48)){
  const match=shadow.match(/^0px (\d+)px (\d+)px (-\d+)px rgba\(58,43,83,([\d.]+)\)$/);assert.ok(match);
  assert.ok(Number(match[2])>=2*Number(match[1]));assert.ok(Number(match[3])<0);assert.ok(Number(match[4])<=.1);
 }
});

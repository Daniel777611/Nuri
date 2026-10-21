import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
function load(path,deps={}){const m={exports:{}};const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;}
const paint=load('src/uiux48/glassLightPaint.ts');
test('glass paints smooth directional rim, radial fog and feathered internal haze at actual card/pill sizes',()=>{
 for(const night of [false,true])for(const control of [false,true])for(const [w,h,r]of [[342,212,28],[342,48,24],[342,64,999],[278,50,999],[290,500,28]]){
  const svg=paint.glassLightingSvg(w,h,r,night,control);assert.match(svg,/<svg[^>]+viewBox=/);assert.match(svg,/radialGradient id="light"/);assert.match(svg,/radialGradient id="shade"/);assert.match(svg,/linearGradient id="mist"/);assert.match(svg,/stroke="url\(#rim\)"/);
  assert.doesNotMatch(svg,/<image|https?:\/\/[^w]|<script|<animate|<foreignObject|filter=|NaN|undefined/);
  const alpha=[...svg.matchAll(/stop-opacity="([\d.]+)"/g)].map(m=>Number(m[1]));assert.ok(alpha.every(a=>a>=0&&a<.7));assert.ok(alpha.includes(0));assert.ok(new Set(alpha).size>8,'Gradients must fade, not use solid border colors');
  const radii=[...svg.matchAll(/rx="([\d.]+)"/g)].map(m=>Number(m[1]));assert.ok(radii.every(v=>v>=0&&v<=Math.min(w,h)/2));
 }
 assert.notEqual(paint.glassLightingSvg(342,212,28,true),paint.glassLightingSvg(342,212,28,false));
});
test('lighting is clipped decoration with no touches, accessibility nodes or layout-driven loop',()=>{
 let current={width:0,height:0};const jsx=(type,props)=>({type,props});
 const C=load('src/uiux48/GlassLighting.tsx',{react:{useState:()=>[current,fn=>{current=fn(current);}],useMemo:fn=>fn()},'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{StyleSheet:{absoluteFill:{position:'absolute',left:0,right:0,top:0,bottom:0}},View:'View'},'expo-image':{Image:'Image'},'./glassLightPaint':paint}).GlassLighting;
 let tree=C({radius:28,night:true});assert.equal(tree.props.pointerEvents,'none');assert.equal(tree.props.accessible,false);assert.equal(tree.props.importantForAccessibility,'no-hide-descendants');assert.equal(tree.props.style[1].overflow,'hidden');assert.equal(tree.props.children,null);
 tree.props.onLayout({nativeEvent:{layout:{width:342.1,height:212.1}}});const before=current;tree.props.onLayout({nativeEvent:{layout:{width:342.1,height:212.1}}});assert.equal(current,before);
 tree=C({radius:28,night:true});assert.match(tree.props.children.props.source.uri,/^data:image\/svg\+xml;utf8,/);assert.equal(tree.props.children.props.transition,0);assert.equal(tree.props.style[1].boxShadow,paint.GLASS_INNER_LIGHT.night);
});
test('every shared card, input, tab pill and CTA reuses full material instead of two hard white lines',()=>{
 const source=read('src/uiux48/Primitives.tsx'),material=source.slice(source.indexOf('export function GlassSurface'),source.indexOf('export const NuriField'));assert.match(material,/<GlassLighting radius=\{radius\}/);assert.match(material,/<GlassLighting radius=\{999\}/);assert.doesNotMatch(material,/borderTopColor|borderBottomColor|height:1\}/);assert.match(material,/<BlurView intensity=\{GLASS_BLUR48\[t.mode\]\[kind\]\}/);assert.match(material,/boxShadow: shadow \?/);
});

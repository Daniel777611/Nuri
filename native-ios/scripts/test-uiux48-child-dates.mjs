import {translate as _translateForI18nFixture} from './i18n-test-utils.mjs';
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {test} from "node:test";
import ts from "typescript";
// Pin only the isolated controller/helper clock; never patch the app or host.
class FixtureDate extends Date {constructor(...args){super(...(args.length?args:[2026,9,19,12]));}}
function load(path,deps={},extra="") {deps={...deps,"@/src/textFonts":{TEXT_FONTS:{}}};const m={exports:{}};new Function("require","module","exports","Date","setTimeout","clearTimeout",ts.transpileModule(readFileSync(path,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText+extra)(name=>{if(name==="@/src/uiuxfinal/ButtonMaterial")return {FrostedPressable:deps["react-native"]?.Pressable??"Pressable",ButtonBackdrop:"ButtonBackdrop"};if(name==="@/src/keyboard/AppKeyboard")return {NuriTextInput:deps["react-native"]?.TextInput??"TextInput",useAppKeyboardVisible:()=>false,useAppKeyboard:()=>({visible:false,height:0,activeHostId:null,dismiss:()=>{}}),AppKeyboardScope:({children})=>children,AppKeyboardHost:"AppKeyboardHost"};if(name.startsWith("@/assets/"))return "fixture-image";if(name==="@/src/uiuxfinal/ChildDateDialog")return {ChildDateDialog:"ChildDateDialog"};if(name==="@/src/uiuxfinal/Settings")return Object.fromEntries(Object.entries({SettingsPage:"CardList",SettingsButton:"NuriButton",SettingsField:"NuriField",SettingsChoice:"ChoiceChip",SettingsChoices:"Choices",SettingsRow:"MenuRow",SettingsSpacer:"Spacer",SettingsFormFooter:"Footer",SettingsAction:"Action"}));assert.ok(name in deps,"unexpected import "+name);return deps[name];},m,m.exports,FixtureDate,deps["fixture/timers"]?.set??setTimeout,deps["fixture/timers"]?.clear??clearTimeout);return m.exports;}
const dates=load("src/child-age.ts"),tick=()=>new Promise(r=>setImmediate(r));
const today={year:2026,month:10,day:19};
test("birthdays and due dates are distinct: exact 280/281-day, today, invalid and month-end boundaries",()=>{
 assert.equal(dates.isValidDueDate("2027-07-26",today),true);assert.equal(dates.isValidDueDate("2027-07-27",today),false);
 assert.equal(dates.pregnancyWeeks("2027-07-26",today),0);assert.equal(dates.pregnancyWeeks("2026-10-20",today),39);
 assert.equal(dates.isValidDueDate("2026-10-19",today),false);assert.equal(dates.isValidBirthDate("2026-10-19",today),true);
 assert.equal(dates.completedAgeMonths("2026-10-20",today),null);assert.equal(dates.pregnancyWeeks("2027-02-29",today),null);
 assert.equal(dates.parseDateOnly("2024-02-29")?.day,29);assert.equal(dates.parseDateOnly("2025-02-29"),null);
 assert.equal(dates.completedAgeMonths("2024-01-31",{year:2024,month:2,day:29}),1);assert.equal(dates.completedAgeMonths("2024-02-29",{year:2025,month:2,day:28}),12);
 assert.equal(dates.isValidDueDate("2027-01-01",{year:2026,month:12,day:31}),true);
});
test("calendar-day limit and estimated weeks do not change across DST or host time zones",()=>{
 const source=ts.transpileModule(readFileSync("src/child-age.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const results=["America/Chicago","Pacific/Auckland","UTC"].map(TZ=>{const r=spawnSync(process.execPath,["-e",`const exports={};${source}; console.log(JSON.stringify([exports.isValidDueDate('2027-07-26',${JSON.stringify(today)}),exports.pregnancyWeeks('2026-11-02',${JSON.stringify(today)}),exports.completedAgeMonths('2024-01-31',{year:2024,month:2,day:29})]));`],{env:{...process.env,TZ},encoding:"utf8"});assert.equal(r.status,0,r.stderr);return r.stdout;});assert.equal(new Set(results).size,1);
});
function harness(){let cursor=0,tree;const slots=[],effects=[],pending=[],scrolls=[];const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));const state=initial=>{const i=cursor++;slots[i]??={value:typeof initial==="function"?initial():initial};slots[i].set??=v=>{slots[i].value=typeof v==="function"?v(slots[i].value):v;};return[slots[i].value,slots[i].set];};const react={useState:state,useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},useMemo:(fn,deps)=>{const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value;},useEffect:(fn,deps)=>{const i=cursor++;if(!same(effects[i]?.deps,deps))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});}};const nodes=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];return{react,state,scrolls,render(Component,props){cursor=0;tree=Component(props);for(const node of nodes(tree))if(node.type==="ScrollView"&&node.props.ref)node.props.ref.current={scrollTo:value=>scrolls.push(value)};pending.splice(0).forEach(fn=>fn());return tree;},find:id=>nodes(tree).find(n=>n.props?.testID===id),nodes:()=>nodes(tree),tree:()=>tree,unmount:()=>effects.forEach(effect=>effect?.cleanup?.())};}
const jsx=(type,props)=>({type,props});
function childFixture({stored="2027-01-19",fail=false}={}) {const h=harness(),calls=[],routes=[];let owner=1,params={id:"fixture-child",uiState:"detail"};const capture=()=>owner===1?1:null,current=t=>owner===t;const router={canGoBack:()=>false,replace:p=>routes.push(p),setParams:p=>{params={...params,...p};}};const t=(key,vars)=>key.replace(/\{(\w+)\}/g,(m,k)=>vars?.[k]??m);const Component=load("app/child/[id].tsx",{react:h.react,"react/jsx-runtime":{jsx,jsxs:jsx},"@/src/useAccountState":{useAccountState:h.state,useAccountScope:()=>({capture,current})},"react-native":{View:"View",KeyboardAvoidingView:"KAV",StyleSheet:{create:x=>x},Platform:{OS:"ios"}},"@/src/components/NativeSafeAreaView":{SafeAreaView:"Safe"},"@react-navigation/elements":{useHeaderHeight:()=>0},"expo-router":{useRouter:()=>router,useLocalSearchParams:()=>params},"@expo/vector-icons":{Ionicons:"Icon"},"@/src/api":{auth:{getToken:async()=>"isolated-fixture-token"},isAuthError:()=>false,api:{listChildren:async()=>[{id:"fixture-child",nickname:"Fixture",birth_date:stored,gender:"other"}],updateChild:async(id,b)=>{calls.push(["update",id,b]);if(fail)throw Error("fixture offline");return b;},deleteChild:async()=>calls.push(["delete"])}},"@/src/authExpiredRecovery":{useExpiredSessionRecovery:()=>({blocked:false,recover:()=>{}})},"@/src/child-age":dates,"@/src/uiux48/Primitives":Object.fromEntries(["CardList","NuriButton","NuriField","NuriText","ChoiceChip","MenuRow"].map(n=>[n,n])),"@/src/uiux48/StateCard":{StateCard:"StateCard"},"@/src/components/ConfirmDialog":{default:"ConfirmDialog",__esModule:true},"@/src/theme":{},"@/src/i18n":{translate:_translateForI18nFixture,useT:()=>({t,locale:"en"})}}).default;return{...h,calls,routes,render:()=>h.render(Component),replaceOwner:()=>owner++,params:p=>params={...params,...p}};}
test("actual child due-date detail/edit uses the existing save handler; navigation/render never delete or save",async()=>{
 const f=childFixture();f.render();await tick();f.render();assert.match(f.find("child-detail-date").props.label,/预产期/);assert.match(f.find("child-detail-date").props.detail,/尚未出生/);assert.deepEqual(f.calls,[]);
 f.find("child-detail-edit").props.onPress();f.render();assert.equal(f.find("child-expecting"),undefined,"Additional child details stay collapsed until requested");assert.deepEqual(f.calls,[]);f.find("child-more").props.onPress();f.render();assert.equal(f.find("child-expecting").props.selected,true);assert.equal(f.find("child-save-btn").props.disabled,false);f.find("child-save-btn").props.onPress();f.find("child-save-btn").props.onPress();await tick();f.render();assert.equal(f.calls.length,1);assert.equal(f.calls[0][2].birth_date,"2027-01-19");assert.ok(f.find("child-saved"));
});
test("actual child born/due switches clear mismatched dates; >280 days cannot save; failure/stale callbacks never report success",async()=>{
 const f=childFixture();f.render();await tick();f.render();f.find("child-detail-edit").props.onPress();f.render();assert.equal(f.find("child-born"),undefined);f.find("child-more").props.onPress();f.render();assert.deepEqual(f.calls,[]);f.find("child-born").props.onPress();f.render();assert.equal(f.find("child-birth-date").props.value,"");assert.equal(f.find("child-save-btn").props.disabled,true);f.find("child-expecting").props.onPress();f.render();f.find("child-birth-date").props.onChangeText("2099-12-31");f.render();f.find("child-save-btn").props.onPress();await tick();assert.deepEqual(f.calls,[]);
 const g=childFixture({fail:true});g.render();await tick();g.render();g.find("child-detail-edit").props.onPress();g.render();g.find("child-save-btn").props.onPress();await tick();g.render();assert.equal(g.find("child-saved"),undefined);assert.equal(g.calls.length,1);
 const old=g.find("child-save-btn").props.onPress;g.replaceOwner();old();await tick();assert.equal(g.calls.length,1);
});
const inlineModel=load("src/onboardingInlineDate.ts",{"./child-age":dates});
const childRow=(birth_date="",expecting=false)=>({key:"fixture-child",nickname:"Fixture",birth_date,gender:"other",allergies:[],notes:"",expecting});
function inlineDependencies(h,timers,locale="en",os="ios"){
 return {react:h.react,"react/jsx-runtime":{jsx,jsxs:jsx},"fixture/timers":timers,
  "react-native":{View:"View",Text:"Text",ScrollView:"ScrollView",Platform:{OS:os},StyleSheet:{create:value=>value},AccessibilityInfo:{isReduceMotionEnabled:async()=>false,addEventListener:()=>({remove(){}})}},
  "@/src/uiux48/Primitives":{NuriText:"NuriText"},"@/src/uiux48/Theme":{useNuriTheme:()=>({outline:"fixture",ink:"fixture",secondary:"fixture"})},
  "@/src/i18n":{useT:()=>({locale}),translate:_translateForI18nFixture},"@/src/onboardingInlineDate":inlineModel,"@/src/child-age":dates};
}
function inlineFixture(row=childRow(),locale="en"){
 const h=harness(),changes=[],props={row,disabled:false,onChange:next=>{changes.push(structuredClone(next));props.row=next;}};
 const module=load("src/uiuxfinal/InlineChildDate.tsx",inlineDependencies(h,undefined,locale));
 return {...h,changes,props,module,render:()=>h.render(module.InlineChildDate,props),column:part=>h.nodes().find(node=>node.type===module.InlineDateWheel&&node.props.part===part),disable:()=>{props.disabled=true;}};
}
function wheelFixture(initial={},os="ios"){
 const h=harness(),changes=[],timers=new Map();let sequence=0;
 const props={part:"year",label:"Year",values:Array.from({length:2026},(_,i)=>i+1),value:2026,disabled:false,reducedMotion:true,testID:"onboarding-wheel-fixture-child-year",onSelect:value=>changes.push(value),...initial};
 const timerApi={set:(callback,delay)=>{const id=++sequence;timers.set(id,{callback,delay});return id;},clear:id=>timers.delete(id)};
 const module=load("src/uiuxfinal/InlineChildDate.tsx",inlineDependencies(h,timerApi,"en",os));
 const f={...h,props,changes,timers,render:()=>h.render(module.InlineDateWheel,props),view:()=>h.find(props.testID),
  flush:()=>{const callbacks=[...timers.values()];timers.clear();callbacks.forEach(timer=>timer.callback());},
  offset:value=>{const index=props.values.indexOf(value);assert.notEqual(index,-1,"test selection must be offered by the actual numeric column");return index*34;},
  event:y=>({nativeEvent:{contentOffset:{x:0,y}}})};
 f.snap=value=>{const y=f.offset(value);f.view().props.onScrollBeginDrag();f.view().props.onScroll(f.event(y));f.render();f.view().props.onMomentumScrollEnd(f.event(y));};
 return f;
}

test("actual inline wheels preserve incomplete legacy data on mount and ordinary scrolling; deliberate snaps repair only the local draft",()=>{
 const f=inlineFixture();try{
  f.render();assert.ok(f.find("onboarding-inline-date-fixture-child"));assert.deepEqual(f.changes,[]);
  assert.equal(f.find("onboarding-date-overlay"),undefined);assert.ok(!f.nodes().some(node=>node.props?.accessibilityViewIsModal||node.type==="TextInput"||node.type==="NuriField"));
  for(const [part,value] of [["month",2],["year",2017],["day",18]]){
   const wheel=wheelFixture(f.column(part).props);try{
    wheel.render();const before=f.changes.length,y=wheel.offset(value);
    wheel.view().props.onScroll(wheel.event(y));wheel.render();assert.equal(f.changes.length,before,"scroll is a preview, not a committed selection");
    wheel.view().props.onMomentumScrollEnd(wheel.event(y));f.render();assert.equal(f.changes.length,before+1);
    assert.equal(f.props.row.birth_date,part==="month"?"2026-02-19":part==="year"?"2017-02-19":"2017-02-18");
   }finally{wheel.unmount();}
  }
  assert.deepEqual(f.props.row.date_parts,{year:2017,month:2,day:18});
  assert.ok(f.changes.slice(0,2).every(row=>dates.parseDateOnly(row.birth_date)));
 }finally{f.unmount();}
});

test("native drag snaps to34pt, virtualizes all historical years and exposes year0001 without any text input",()=>{
 const f=wheelFixture();try{
  f.render();const wheel=f.view();assert.equal(wheel.type,"ScrollView");assert.equal(wheel.props.snapToInterval,34);assert.equal(wheel.props.nestedScrollEnabled,true);assert.equal(wheel.props.accessibilityRole,"adjustable");assert.equal(wheel.props.scrollEnabled,true);
  assert.ok(f.nodes().filter(node=>node.props?.testID?.includes("-option-")).length<=9);assert.equal(f.find("birth-picker-year-input"),undefined);
  const offset=f.offset(1)+11;wheel.props.onScrollBeginDrag();wheel.props.onScroll(f.event(offset));f.render();
  assert.ok(f.find("onboarding-wheel-fixture-child-year-option-1"));assert.deepEqual(f.changes,[]);
  f.view().props.onMomentumScrollEnd(f.event(offset));assert.deepEqual(f.changes,[1]);assert.deepEqual(f.scrolls.at(-1),{y:f.offset(1),animated:false});
  f.props.value=1;f.render();assert.equal(f.view().props.accessibilityValue.text,"0001");
  assert.equal(f.props.values.includes(0),false);assert.equal(f.props.values.includes(2099),false);
 }finally{f.unmount();}
});

test("short-stop timers follow the last offset, momentum cancels them and a final snap commits exactly once",()=>{
 const f=wheelFixture({part:"month",values:[1,2,3,4,5],value:1,anchor:3,testID:"onboarding-wheel-fixture-child-month"});try{
  f.render();f.view().props.onScrollBeginDrag();f.view().props.onScrollEndDrag(f.event(f.offset(2)));assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,140);assert.deepEqual(f.changes,[]);
  f.view().props.onScroll(f.event(f.offset(4)));f.render();f.flush();assert.deepEqual(f.changes,[4],"a no-momentum stop settles at the last physical position");
  f.view().props.onScrollBeginDrag();f.view().props.onScrollEndDrag(f.event(f.offset(2)));f.view().props.onMomentumScrollBegin();assert.equal(f.timers.size,0);
  f.view().props.onMomentumScrollEnd(f.event(f.offset(5)));f.flush();assert.deepEqual(f.changes,[4,5]);
 }finally{f.unmount();}
});

test("disabled, unmounted and replaced-props wheel closures/timers cannot forward stale selections",()=>{
 for(const boundary of ["disabled","unmount","props"]){
  const f=wheelFixture({values:[2017,2018,2019],value:2017,anchor:2019});f.render();const old=f.view().props;
  old.onScrollEndDrag(f.event(f.offset(2018)));assert.equal(f.timers.size,1);
  if(boundary==="disabled"){f.props.disabled=true;f.render();assert.equal(f.view().props.scrollEnabled,false);assert.deepEqual(f.view().props.accessibilityActions,[]);}
  else if(boundary==="props"){f.props.onSelect=()=>assert.fail("old event must not call the replacement account/card callback");f.render();}
  else f.unmount();
  assert.equal(f.timers.size,0);old.onMomentumScrollEnd(f.event(34));old.onAccessibilityAction({nativeEvent:{actionName:"increment"}});old.onScrollEndDrag(f.event(34));f.flush();assert.deepEqual(f.changes,[]);
  if(boundary!=="unmount")f.unmount();
 }
});

test("actual adjustable wheels support consecutive numeric increment/decrement without a null placeholder and respect reduced motion",()=>{
 const f=wheelFixture({part:"day",label:"Day",values:[1,2,3],value:1,anchor:2,testID:"onboarding-wheel-fixture-child-day"});try{
  f.render();assert.deepEqual(f.view().props.accessibilityActions,[{name:"increment"},{name:"decrement"}]);
  f.view().props.onAccessibilityAction({nativeEvent:{actionName:"increment"}});assert.deepEqual(f.changes,[2]);assert.equal(f.scrolls.at(-1).animated,false);
  f.props.value=2;f.render();assert.equal(f.view().props.accessibilityValue.text,"02");
  f.view().props.onAccessibilityAction({nativeEvent:{actionName:"increment"}});assert.deepEqual(f.changes,[2,3]);
  f.props.value=3;f.render();f.view().props.onAccessibilityAction({nativeEvent:{actionName:"decrement"}});assert.deepEqual(f.changes,[2,3,2]);
 }finally{f.unmount();}
});

test("web mouse/touch/scroll-key input settles once, while initial and props-sync scrolls never select a date",()=>{
 for(const input of ["mouse","touch","key"]){
  const f=wheelFixture({part:"month",values:[1,2,3,4],value:3,testID:"onboarding-wheel-fixture-child-month"},"web");try{
   f.render();const y=f.offset(2);f.view().props.onScroll(f.event(y));f.render();f.flush();assert.deepEqual(f.changes,[]);assert.equal(f.timers.size,0);
   if(input==="mouse"){let stopped=0;f.view().props.onWheel({stopPropagation:()=>stopped++});assert.equal(stopped,1);}
   else if(input==="touch")f.view().props.onTouchMove();
   else {f.view().props.onKeyDown({key:"x"});f.view().props.onScroll(f.event(y));assert.equal(f.timers.size,0);f.view().props.onKeyDown({key:"ArrowDown"});}
   f.view().props.onScroll(f.event(y));f.render();assert.equal(f.timers.size,1);assert.deepEqual(f.changes,[]);
   f.flush();assert.deepEqual(f.changes,[2]);f.view().props.onScroll(f.event(y));f.flush();assert.deepEqual(f.changes,[2],"programmatic final scroll tick cannot rearm a settled gesture");
   f.props.value=2;f.render();f.view().props.onScroll(f.event(f.offset(3)));f.flush();assert.deepEqual(f.changes,[2],"controlled props sync is not new user input");
  }finally{f.unmount();}
 }
});

test("the first wheel render after a dependency clamp cannot flash old calendar rows or announce an invalid selected day",()=>{
 const f=wheelFixture({part:"day",values:Array.from({length:31},(_,i)=>i+1),value:31,anchor:19,testID:"onboarding-wheel-fixture-child-day"});try{
  f.render();assert.ok(f.find("onboarding-wheel-fixture-child-day-option-31"));
  f.props.values=Array.from({length:28},(_,i)=>i+1);f.props.value=28;f.render();
  assert.equal(f.find("onboarding-wheel-fixture-child-day-option-31"),undefined);assert.ok(f.find("onboarding-wheel-fixture-child-day-option-28"));assert.equal(f.view().props.accessibilityValue.text,"28");assert.deepEqual(f.changes,[]);
  f.props.value=31;f.render();assert.equal(f.view().props.accessibilityValue.text,"28");assert.equal(f.find("onboarding-wheel-fixture-child-day-option-31"),undefined);assert.deepEqual(f.changes,[]);
 }finally{f.unmount();}
});

test("inline due-date columns expose only tomorrow through280days, retain next-year selection and reject out-of-window events",()=>{
 const f=inlineFixture(childRow("",true));try{
  f.render();assert.deepEqual(f.column("year").props.values,[2026,2027]);
  f.column("year").props.onSelect(2027);f.render();f.column("month").props.onSelect(7);f.render();
  assert.equal(f.props.row.birth_date,"2027-07-20");assert.equal(f.column("day").props.values.at(-1),26);
  f.column("day").props.onSelect(26);f.render();assert.equal(f.props.row.birth_date,"2027-07-26");
  const before=f.changes.length;f.column("day").props.onSelect(27);f.column("year").props.onSelect(2099);assert.equal(f.changes.length,before);
  f.column("year").props.onSelect(2026);f.render();assert.deepEqual(f.props.row.date_parts,{year:2026,month:10,day:26});assert.equal(f.column("day").props.values[0],20);
  f.column("day").props.onSelect(20);f.render();assert.equal(f.props.row.birth_date,"2026-10-20");
  f.disable();f.render();f.column("day").props.onSelect(21);assert.equal(f.props.row.birth_date,"2026-10-20");
 }finally{f.unmount();}
});

test("inline leap/month-end repair stays Gregorian and malformed stored dates require deliberate confirmation, never silent mutation",()=>{
 const invalid=inlineFixture(childRow("2026-02-29"));try{
  invalid.render();assert.deepEqual(invalid.changes,[]);assert.ok(["year","month","day"].every(part=>Number.isInteger(invalid.column(part).props.value)));assert.equal(invalid.props.row.birth_date,"2026-02-29");assert.ok(invalid.find("onboarding-date-needs-confirmation-fixture-child"));
  invalid.column("day").props.onSelect(18);invalid.render();assert.equal(invalid.props.row.birth_date,"2026-10-18");assert.deepEqual(invalid.props.row.date_parts,{year:2026,month:10,day:18});
 }finally{invalid.unmount();}
 for(const [start,part,value,expected] of [["2024-02-29","year",2025,"2025-02-28"],["2000-02-29","year",1900,"1900-02-28"],["2017-01-31","month",4,"2017-04-30"],["0099-12-31","year",1,"0001-12-31"]]){
  const f=inlineFixture(childRow(start));try{f.render();f.column(part).props.onSelect(value);f.render();assert.equal(f.props.row.birth_date,expected);assert.ok(dates.parseDateOnly(expected));}finally{f.unmount();}
 }
});

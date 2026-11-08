import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
class FixtureDate extends Date {constructor(...args){super(...(args.length?args:[2026,9,21,12]));}}
function load(path,deps={},extra='') {
  deps={...deps,'@/src/textFonts':{TEXT_FONTS:{}},'@/src/uiuxfinal/ButtonMaterial':{FrostedPressable:deps['react-native']?.Pressable??'Pressable',ButtonBackdrop:'ButtonBackdrop'}};
  const module={exports:{}};
  const baseline=process.env.NURI_ONBOARDING_BASELINE_REF;
  if(baseline&&!/^[0-9a-f]{40}$/.test(baseline))throw Error('An exact baseline commit is required');
  const source=baseline?execFileSync('git',['show',baseline+':native-ios/'+path],{encoding:'utf8'}):readFileSync(path,'utf8');
  new Function('require','module','exports','Date','requestAnimationFrame','cancelAnimationFrame',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText+extra)(name=>{
  if(name==='@/src/keyboard/AppKeyboard')return {NuriTextInput:deps['react-native']?.TextInput??'TextInput',useAppKeyboardVisible:()=>false,useAppKeyboard:()=>({visible:false,height:0,activeHostId:null,dismiss:()=>{}}),AppKeyboardScope:({children})=>children,AppKeyboardHost:'AppKeyboardHost'};
  if(name.startsWith('@/assets/'))return 'fixture-image';
  assert.ok(name in deps,'unexpected dependency '+name);return deps[name];
 },module,module.exports,FixtureDate,deps['fixture/animation']?.request,deps['fixture/animation']?.cancel);return module.exports;
}
const dates=load('src/child-age.ts'),helper=load('src/onboardingChildren.ts',{'./child-age':dates});
const inlineModel=load('src/onboardingInlineDate.ts',{'./child-age':dates});
const tick=()=>new Promise(r=>setImmediate(r));
const draft=(key,birth='2010-05-06')=>({key,nickname:'Fixture '+key,birth_date:birth,gender:'other',allergies:[],notes:'',expecting:false});
function service() {
 const f={rows:[],calls:[],owner:true,failCreate:false,ambiguous:false,loseResponse:false,validation:false};
 const api={listChildren:async()=>{f.calls.push(['GET']);return structuredClone(f.rows);},
  addChild:async payload=>{f.calls.push(['POST',payload]);if(f.validation)throw Object.assign(Error('fixture validation'),{status:422});if(f.failCreate)throw Error('fixture offline');const row={...structuredClone(payload),id:'server-'+(f.rows.length+1)};f.rows.push(row);if(f.ambiguous)f.rows.push({...row,id:'server-extra'});if(f.loseResponse)throw Error('fixture lost response');return row;},
  updateChild:async(id,payload)=>{f.calls.push(['PUT',id,payload]);const row={...structuredClone(payload),id};f.rows=f.rows.map(x=>x.id===id?row:x);return row;},
  deleteChild:async id=>{f.calls.push(['DELETE',id]);if(f.failDelete)throw Error('fixture delete unavailable');f.rows=f.rows.filter(x=>x.id!==id);if(f.loseDeleteResponse)throw Error('fixture delete response lost');return{ok:true};}};
 const progress=helper.newChildSaveProgress(),confirmed=[];
 return Object.assign(f,{api,progress,confirmed,run:rows=>helper.persistOnboardingChildren(rows,{api,progress,owns:async()=>f.owner,onConfirmed:(key,id)=>confirmed.push([key,id])})});
}
test('all historical Gregorian years, not only 2018 onward; leap and due-date rules preserved',()=>{
 for(const birth of ['0001-01-01','0099-12-31','1900-02-28','2000-02-29','2010-05-06','2017-12-31'])assert.equal(helper.validChildDraft(draft('a',birth)),true,birth);
 for(const birth of ['0000-01-01','1900-02-29','2019-02-29','2026-10-22','10000-01-01'])assert.equal(helper.validChildDraft(draft('a',birth)),false,birth);
 assert.equal(helper.validChildDraft({...draft('due','2027-01-01'),expecting:true}),true);
 assert.equal(helper.validChildDraft({...draft('due','2099-01-01'),expecting:true}),false);
});
test('year instructions omit the repair-report suffix in all3 locales without restricting historical date entry',()=>{
 for(const[locale,hint]of [['zh-CN','可直接输入年份，也可滚动选择。'],['zh-TW','可直接輸入年份，也可捲動選擇。'],['en','Type a year directly, or scroll.']]){
  assert.equal(helper.onboardingChildCopy(locale).yearHint,hint);
  for(const suffix of ['不再只限最近几年','不再只限最近幾年','There is no recent-years-only limit.'])assert.ok(!helper.onboardingChildCopy(locale).yearHint.includes(suffix));
  for(const birth of ['0001-01-01','1900-02-28','2010-05-06','2017-12-31'])assert.equal(helper.validChildDraft(draft('historical',birth)),true,`${locale}/${birth}`);
 }
});
test('reads every existing child without dropping siblings, allergies or notes; malformed/duplicate identities fail closed',()=>{
 const rows=[{...draft('a'),id:'a',allergies:['fixture allergy'],notes:'fixture note'},{...draft('b','2017-03-04'),id:'b'}];
 const actual=helper.childDraftsFromServer(rows);assert.equal(actual.length,2);assert.deepEqual(actual[0].allergies,rows[0].allergies);assert.equal(actual[0].notes,rows[0].notes);
 for(const bad of [null,{},[{}],[rows[0],rows[0]]])assert.throws(()=>helper.childDraftsFromServer(bad),{code:'read-failed'});
});
test('three children use real existing GET/POST contracts, retaining confirmed IDs for retries',async()=>{
 const f=service(),rows=[draft('a'),draft('b','2017-01-02'),draft('c','2024-02-29')];await f.run(rows);await f.run(rows);
 assert.equal(f.rows.length,3);assert.equal(f.calls.filter(x=>x[0]==='POST').length,3);assert.equal(f.progress.confirmed.size,3);
});
test('a lost POST response reconciles exactly one newly visible matching row, never creates it twice',async()=>{
 const f=service();f.loseResponse=true;await f.run([draft('a'),draft('b')]);await f.run([draft('a'),draft('b')]);
 assert.equal(f.rows.length,2);assert.equal(f.calls.filter(x=>x[0]==='POST').length,2);assert.equal(f.progress.pending,null);
});
test('unconfirmed/ambiguous create never blindly POSTs again on retry',async()=>{
 for(const mode of ['failCreate','ambiguous']){const f=service();f[mode]=true;if(mode==='ambiguous')f.loseResponse=true;
  await assert.rejects(f.run([draft('a')]),{code:'unconfirmed'});await assert.rejects(f.run([draft('a')]),{code:'unconfirmed'});
  assert.equal(f.calls.filter(x=>x[0]==='POST').length,1);assert.equal(f.confirmed.length,0);
 }
});
test('definitive validation errors allow a corrected retry, not false completion',async()=>{
 const f=service();f.validation=true;await assert.rejects(f.run([draft('a')]),{status:422});assert.equal(f.progress.pending,null);
 f.validation=false;await f.run([draft('a')]);assert.equal(f.rows.length,1);
});
test('editing an already confirmed new child uses its server ID, not another create',async()=>{
 const f=service();await f.run([draft('a')]);await f.run([{...draft('a'),nickname:'Corrected fixture name'}]);
 assert.equal(f.rows.length,1);assert.equal(f.calls.filter(x=>x[0]==='POST').length,1);assert.equal(f.calls.filter(x=>x[0]==='PUT').length,1);
});
test('invalid rows and stale owners initiate no write; save never invokes deletion',async()=>{
 const f=service();await assert.rejects(f.run([draft('a','2099-01-01')]),{code:'invalid'});await assert.rejects(f.run([draft('a'),draft('a')]),{code:'invalid'});
 f.owner=false;await assert.rejects(f.run([draft('a')]),{code:'stale'});assert.deepEqual(f.calls,[]);
});
test('unchanged incomplete cloud child bypasses repair only with its exact confirmed ID/fingerprint, without any child request',async()=>{
 const f=service(),[row]=helper.childDraftsFromServer([{id:'legacy',nickname:'Fixture incomplete',birth_date:null,allergies:['fixture allergy'],notes:'fixture private note'}]);
 assert.equal(helper.validChildDraft(row),false);f.progress.confirmed.set(row.key,{id:row.id,fingerprint:helper.childFingerprint(row)});await f.run([row]);await f.run([row]);
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.confirmed,[]);assert.equal(row.birth_date,'');assert.deepEqual(row.allergies,['fixture allergy']);assert.equal(row.notes,'fixture private note');
 f.owner=false;await assert.rejects(f.run([row]),{code:'stale'});assert.deepEqual(f.calls,[]);
});
test('new/edited incomplete children and mismatched checkpoints still reject before any request',async()=>{
 const [original]=helper.childDraftsFromServer([{id:'legacy',nickname:'Fixture incomplete',birth_date:null}]);
 for(const mode of ['missing-checkpoint','wrong-id','changed-name','changed-date','new-draft']){
  const f=service();let row={...original,allergies:[...original.allergies]};if(mode!=='missing-checkpoint')f.progress.confirmed.set(row.key,{id:mode==='wrong-id'?'another-id':original.id,fingerprint:helper.childFingerprint(original)});
  if(mode==='changed-name')row.nickname='Edited but still incomplete';if(mode==='changed-date')row.birth_date='2099-01-01';if(mode==='new-draft')delete row.id;
  await assert.rejects(f.run([row]),{code:'invalid'},mode);assert.deepEqual(f.calls,[],mode);
 }
});

function harness(){let cursor=0,tree;const slots=[],effects=[],pending=[];const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const state=initial=>{const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};slots[i].set??=value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;};return[slots[i].value,slots[i].set];};
 const react={useState:state,useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},useCallback:(fn,deps)=>{const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn;},useMemo:(fn,deps)=>{const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value;},useEffect:(fn,deps)=>{const i=cursor++;if(!same(effects[i]?.deps,deps))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});},useSyncExternalStore:(_subscribe,snapshot)=>{cursor++;return snapshot();}};
 const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
 const scrolls=[];
 return{react,state,scrolls,render(Component,props){cursor=0;tree=Component(props);for(const node of nodes(tree))if(node.type==='ScrollView'&&node.props.ref)node.props.ref.current={scrollTo:value=>scrolls.push(value)};pending.splice(0).forEach(fn=>fn());return tree;},find:id=>nodes(tree).find(n=>n.props?.testID===id),nodes:()=>nodes(tree),unmount(){for(const effect of effects)effect?.cleanup?.();}};
}
const jsx=(type,props,key)=>({type,props,key});
const simplified=load('src/simplifiedOnboarding.ts',{'./onboardingChildren':helper,'./child-age':dates,'./onboardingInlineDate':inlineModel});
function componentFixture({kids=[],locale='en',loadFails=false,genderReadFails=false,accountId='account-A'}={}){
 const h=harness(),f=service(),routes=[],frames=new Map();f.rows=structuredClone(kids);let owner=1,mounted=true,token='fixture-A',profileFails=false,profileConfirmed=true,localConfirmed=true,genderWriteFails=false,createBarrier=null,profileBarrier=null,localBarrier=null,frameSequence=0,navigationGuard,reduceMotion;
 const capture=()=>mounted&&owner===1?1:null,current=ticket=>mounted&&owner===ticket,t=(key,vars)=>key.replace(/\{(\w+)\}/g,(m,key)=>vars?.[key]??m);
 const recoveries=[],recover=async(...args)=>{recoveries.push(args);},router={replace:route=>routes.push(route)},profileCalls=[],localCompletion=[],genderReads=[],genderWrites=[],dismissals=[];
 const add=f.api.addChild;f.api.addChild=async payload=>{if(createBarrier)await createBarrier;return add(payload);};
 const api={...f.api,me:async()=>{if(loadFails)throw Error('fixture read failed');return{id:accountId,nickname:'Fixture caregiver',city:'Fixture city',parent_role:'mom'};},updateMe:async body=>{profileCalls.push(body);if(profileBarrier)await profileBarrier;if(profileFails)throw Error('fixture profile failed');return{...body,onboarding_completed:profileConfirmed};}};
 const deps={react:h.react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'fixture/animation':{request:fn=>{const id=++frameSequence;frames.set(id,fn);return id;},cancel:id=>frames.delete(id)},'@/src/useAccountState':{useAccountState:h.state,useAccountScope:()=>({capture,current})},
  'react-native':Object.assign(Object.fromEntries(['View','Pressable','ActivityIndicator','ScrollView'].map(x=>[x,x])),{StyleSheet:{create:x=>x},Keyboard:{dismiss:()=>dismissals.push(true)},AccessibilityInfo:{isReduceMotionEnabled:async()=>false,addEventListener:(_event,listener)=>{reduceMotion=listener;return{remove:()=>{reduceMotion=undefined;}};}}}),
  'expo-router':{useRouter:()=>router,useFocusEffect:fn=>h.react.useEffect(fn,[fn])},'@/src/components/nativeNavigation':{registerNativeNavigationGuard:(_path,guard)=>{navigationGuard=guard;return()=>{if(navigationGuard===guard)navigationGuard=undefined;};}},
  '@/src/api':{api,auth:{getToken:async()=>token,setOnboarded:async(...args)=>{localCompletion.push(args);if(localBarrier)await localBarrier;return localConfirmed&&current(args[1]?.expectedGeneration)&&token===args[1]?.expectedToken;}},isAuthError:e=>e?.status===401},
  '@/src/authExpiredRecovery':{ExpiredSessionRecoveryNotice:'ExpiredSessionRecoveryNotice',useExpiredSessionRecovery:()=>({blocked:false,recover})},'@/src/i18n':{useT:()=>({t,locale}),translate:(_locale,text)=>text},'@/src/onboardingChildren':helper,'@/src/simplifiedOnboarding':simplified,
  '@/src/onboardingParentGender':{readParentGender:async(id,owns)=>{genderReads.push(id);if(!await owns())throw Error('fixture stale');if(genderReadFails)throw Error('fixture secure read failed');if(!await owns())throw Error('fixture stale');return'hidden';},saveParentGender:async(id,value,owns)=>{if(!await owns())throw Error('fixture stale');genderWrites.push([id,value]);if(genderWriteFails)throw Error('fixture secure write failed');if(!await owns())throw Error('fixture stale');}},
  '@/src/uiuxfinal/OnboardingForm':Object.fromEntries(['ChildProfileCard','ParentProfileCard','OnboardingPrompt','ChildReviewCard'].map(x=>[x,x])),
  '@/src/uiuxfinal/OnboardingKeyboardFooter':{OnboardingKeyboardFooter:'OnboardingKeyboardFooter',useOnboardingKeyboardVisible:()=>false},
  '@/src/components/ConfirmDialog':{default:'ConfirmDialog',__esModule:true},
  '@/src/uiux48/Primitives':Object.fromEntries(['NuriKeyboardFrame','NuriIcon','NuriText','NuriButton'].map(x=>[x,x])),
  '@/src/uiux48/Theme':{useNuriTheme:()=>({night:false,composer:'fixture',outline:'fixture',ink:'fixture'})}};
 const Component=load('app/onboarding.tsx',deps).default;
 const kind=type=>h.nodes().filter(node=>node.type===type),render=()=>h.render(Component);
 return Object.assign(f,h,{deps,routes,profileCalls,localCompletion,recoveries,genderReads,genderWrites,dismissals,render,kind,cards:()=>kind('ChildProfileCard'),reviews:()=>kind('ChildReviewCard'),parent:()=>kind('ParentProfileCard')[0],unmount:()=>{mounted=false;h.unmount();},
  settle:async()=>{for(let i=0;i<8;i++){await tick();render();}},setProfileFails:value=>profileFails=value,setProfileConfirmed:value=>profileConfirmed=value,setLocalConfirmed:value=>localConfirmed=value,setGenderWriteFails:value=>genderWriteFails=value,
  replaceOwner:()=>{owner++;token='fixture-B';f.owner=false;},replaceToken:()=>token='fixture-rotated',holdCreate:promise=>createBarrier=promise,holdProfile:promise=>profileBarrier=promise,holdLocal:promise=>localBarrier=promise,
  press:id=>{const node=h.find(id);assert.ok(node,'missing '+id);assert.notEqual(node.props.disabled,true,'disabled '+id);node.props.onPress();render();},
  change:(key,patch)=>{const card=kind('ChildProfileCard').find(node=>node.props.row.key===key);assert.ok(card,'missing editor '+key);card.props.onChange({...card.props.row,...patch});render();},
  date:(key,date)=>{const editor=kind('ChildProfileCard').find(node=>node.props.row.key===key);assert.equal(editor.props.onDate,undefined);const date_parts=dates.parseDateOnly(date);assert.ok(date_parts,'fixture date must be a complete Gregorian ISO value');editor.props.onChange({...editor.props.row,date_parts,birth_date:date});render();},
  back:()=>{assert.ok(navigationGuard);navigationGuard('back');render();},
  flushRaf:()=>{const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback();},
  layout:(key,y)=>{const node=h.nodes().find(node=>node.props?.onLayout&&node.props.children?.props?.row?.key===key);assert.ok(node,'missing layout '+key);node.props.onLayout({nativeEvent:{layout:{y}}});},
  setReducedMotion:value=>{assert.ok(reduceMotion);reduceMotion(value);render();}});
}
async function loaded(f){f.render();await f.settle();assert.ok(f.parent());}
async function ready(f){await loaded(f);f.press('onboarding-next-btn');assert.ok(f.find('onboarding-born'));}
function fillChild(f,name,year=2010){const key=f.cards().at(-1).props.row.key;f.change(key,{nickname:name});f.date(key,`${year}-05-06`);return key;}
function edit(f,key){const card=f.reviews().find(node=>node.props.row.key===key);assert.ok(card);card.props.onEdit();f.render();}
test('actual route is parent -> child profiles -> review -> explicit confirmed home, with guarded local completion',async()=>{
 const f=componentFixture();await ready(f);fillChild(f,'Older fixture child',2010);f.press('onboarding-add-another');fillChild(f,'Younger fixture child',2017);f.press('onboarding-next-btn');
 assert.equal(f.reviews().length,2);assert.equal(f.find('onboarding-next-btn').props.label,'Confirm');assert.ok(f.find('onboarding-fixed-footer'));assert.deepEqual(f.calls.filter(x=>x[0]!=='GET'),[]);
 const confirm=f.find('onboarding-next-btn').props.onPress;confirm();confirm();await f.settle();
 assert.deepEqual(f.calls.filter(x=>x[0]==='POST').map(x=>x[1].birth_date),['2010-05-06','2017-05-06']);assert.equal(f.profileCalls.length,1);assert.equal(f.localCompletion.length,1);
 for(const[,payload]of f.calls.filter(call=>call[0]==='POST'))assert.equal('date_parts'in payload,false,'partial wheel columns are UI-only; API receives the existing complete ISO contract');
 assert.deepEqual(f.localCompletion[0],[true,{expectedToken:'fixture-A',expectedGeneration:1}]);assert.deepEqual(f.routes,['/(tabs)']);
});
test('parent changes stay local until Confirm; gender is local, never inferred as parenting role',async()=>{
 const f=componentFixture();await loaded(f);f.parent().props.onChange({nickname:' New name ',city:' New city ',gender:'female'});f.render();f.press('onboarding-next-btn');f.press('onboarding-next-btn');
 assert.ok(f.find('onboarding-empty-review'));assert.deepEqual(f.genderWrites,[]);assert.deepEqual(f.profileCalls,[]);f.press('onboarding-next-btn');await f.settle();
 assert.deepEqual(f.genderReads,['account-A']);assert.deepEqual(f.genderWrites,[['account-A','female']]);assert.deepEqual(f.profileCalls,[{nickname:'New name',city:'New city',onboarding_completed:true}]);assert.ok(!('parent_role' in f.profileCalls[0]));
});
test('Skip only skips its current step: no phantom child, no parent overwrite, and no premature home',async()=>{
 const f=componentFixture();await loaded(f);f.parent().props.onChange({nickname:'Discard parent edit',city:'Discard city',gender:'male'});f.render();f.press('onboarding-skip');
 assert.ok(f.find('onboarding-born'));assert.equal(f.cards().length,1);assert.deepEqual(f.routes,[]);fillChild(f,'Discarded child');f.press('onboarding-skip');
 assert.ok(f.find('onboarding-empty-review'));assert.equal(f.cards().length,0);assert.deepEqual(f.profileCalls,[]);assert.deepEqual(f.routes,[]);f.press('onboarding-next-btn');await f.settle();
 assert.deepEqual(f.calls.filter(c=>c[0]==='POST'),[]);assert.deepEqual(f.profileCalls,[{onboarding_completed:true}]);assert.deepEqual(f.genderWrites,[]);assert.deepEqual(f.routes,['/(tabs)']);
});
test('skipping child edits preserves existing siblings, rather than silently deleting or saving drafts',async()=>{
 const f=componentFixture({kids:[{...draft('one'),id:'one'},{...draft('two'),id:'two'}]});await ready(f);f.change('one',{nickname:'Discard edit'});f.press('onboarding-add-another');fillChild(f,'Discard new');f.press('onboarding-skip');
 assert.deepEqual(f.reviews().map(n=>n.props.row.nickname),['Fixture one','Fixture two']);f.press('onboarding-next-btn');await f.settle();assert.deepEqual(f.calls.filter(c=>['POST','PUT','DELETE'].includes(c[0])),[]);assert.equal(f.rows.length,2);
});
test('actual route Skip -> Confirm preserves unchanged birth_date:null legacy child and completes onboarding without child writes',async()=>{
 const kids=[{id:'legacy',nickname:'Fixture incomplete',birth_date:null,allergies:['fixture allergy'],notes:'fixture private note'},{...draft('sibling'),id:'sibling'}];const f=componentFixture({kids});await ready(f);assert.equal(f.cards().find(n=>n.props.row.id==='legacy').props.row.birth_date,'');
 f.press('onboarding-skip');assert.deepEqual(f.reviews().map(n=>n.props.row.id),['legacy','sibling']);assert.deepEqual(f.profileCalls,[]);assert.deepEqual(f.routes,[]);f.press('onboarding-next-btn');await f.settle();
 assert.deepEqual(f.calls.filter(c=>['POST','PUT','DELETE'].includes(c[0])),[]);assert.deepEqual(f.rows,kids);assert.equal(f.profileCalls.length,1);assert.equal(f.profileCalls[0].onboarding_completed,true);assert.equal(f.localCompletion.length,1);assert.deepEqual(f.routes,['/(tabs)']);
});
test('actual route blocks edited incomplete legacy child on Continue and review Save; Cancel restores the unchanged row',async()=>{
 const f=componentFixture({kids:[{id:'legacy',nickname:'Fixture incomplete',birth_date:null}]});await ready(f);f.change('legacy',{nickname:'Edited incomplete'});f.press('onboarding-next-btn');assert.ok(f.find('onboarding-born'));assert.ok(f.find('onboarding-error'));assert.equal(f.find('onboarding-review'),undefined);
 f.press('onboarding-skip');assert.equal(f.reviews()[0].props.row.nickname,'Fixture incomplete');edit(f,'legacy');f.change('legacy',{nickname:'Edited review incomplete'});f.press('onboarding-next-btn');assert.equal(f.find('onboarding-next-btn').props.label,'Save');assert.equal(f.cards()[0].props.row.nickname,'Edited review incomplete');assert.ok(f.find('onboarding-error'));assert.deepEqual(f.profileCalls,[]);assert.deepEqual(f.routes,[]);assert.deepEqual(f.calls.filter(c=>['POST','PUT','DELETE'].includes(c[0])),[]);
 f.back();assert.equal(f.reviews()[0].props.row.nickname,'Fixture incomplete');f.press('onboarding-next-btn');await f.settle();assert.deepEqual(f.calls.filter(c=>['POST','PUT','DELETE'].includes(c[0])),[]);assert.deepEqual(f.routes,['/(tabs)']);
});
test('born and unborn arrays independently accept ten cards and retain their category/date values',async()=>{
 const f=componentFixture();await ready(f);const born=[];for(let i=0;i<10;i++){if(i)f.press('onboarding-add-another');born.push(fillChild(f,'Born '+i,2010));}
 assert.equal(f.cards().length,10);assert.ok(f.cards().every(n=>!n.props.row.expecting));f.press('onboarding-expecting');const unborn=[];
 for(let i=0;i<10;i++){if(i)f.press('onboarding-add-another');const key=f.cards().at(-1).props.row.key;f.change(key,{nickname:'Expected '+i});f.date(key,'2027-01-01');unborn.push(key);}
 assert.equal(f.cards().length,10);assert.ok(f.cards().every(n=>n.props.row.expecting&&n.props.row.birth_date==='2027-01-01'));assert.equal(new Set([...born,...unborn]).size,20);
 f.press('onboarding-born');assert.deepEqual(f.cards().map(n=>n.props.row.key),born);assert.ok(f.cards().every(n=>n.props.row.birth_date==='2010-05-06'));f.press('onboarding-next-btn');assert.equal(f.reviews().length,20);assert.deepEqual(f.calls.filter(c=>c[0]!=='GET'),[]);
});
test('new-card scrolling waits for layout, respects reduced motion and rejects stale-account callbacks',async()=>{
 const f=componentFixture();await ready(f);f.press('onboarding-add-another');assert.deepEqual(f.scrolls,[]);const key=f.cards().at(-1).props.row.key;f.layout(key,480);f.flushRaf();assert.deepEqual(f.scrolls,[{y:472,animated:true}]);
 f.setReducedMotion(true);f.press('onboarding-add-another');f.layout(f.cards().at(-1).props.row.key,640);f.flushRaf();assert.deepEqual(f.scrolls.at(-1),{y:632,animated:false});
 f.press('onboarding-add-another');f.layout(f.cards().at(-1).props.row.key,800);const count=f.scrolls.length;f.replaceOwner();f.flushRaf();assert.equal(f.scrolls.length,count);
});
test('inline date patches only the selected local card; historical year0001 and sibling dates survive without an overlay',async()=>{
 const f=componentFixture();await ready(f);const key=fillChild(f,'First',2010);f.press('onboarding-add-another');const other=fillChild(f,'Second',2017);
 assert.ok(f.cards().every(node=>node.props.onDate===undefined));assert.equal(f.kind('BirthPicker').length,0);assert.equal(f.find('onboarding-date-overlay'),undefined);
 f.date(key,'0001-02-28');assert.equal(f.cards()[0].props.row.birth_date,'0001-02-28');assert.deepEqual(f.cards()[0].props.row.date_parts,{year:1,month:2,day:28});assert.equal(f.cards().find(n=>n.props.row.key===other).props.row.birth_date,'2017-05-06');assert.deepEqual(f.calls.filter(c=>c[0]!=='GET'),[]);
});
function formFixture(){
 const f=componentFixture(),h=harness();let generation=1;
 const auth={getSessionGeneration:()=>generation,subscribeSessionBoundary:()=>()=>{}};
 const deps={...f.deps,react:h.react,'@/src/useAccountState':load('src/useAccountState.ts',{react:h.react,'./api':{auth}}),'react-native':{...f.deps['react-native'],Text:'Text',Platform:{OS:'ios'}},'expo-image':{Image:'Image'},'expo-blur':{BlurView:'BlurView'},'@/src/child-age':dates,'@/src/onboardingInlineDate':inlineModel,'../onboardingInlineDate':inlineModel,'@/src/uiux48/Primitives':Object.fromEntries(['AuthFrame','NuriButton','NuriField','NuriText'].map(x=>[x,x]))};
 const inline=load('src/uiuxfinal/InlineChildDate.tsx',deps);deps['./InlineChildDate']=inline;
 return{...h,inline,form:load('src/uiuxfinal/OnboardingForm.tsx',deps),replaceOwner:()=>generation++};
}
test('real child card embeds the date control directly without onDate, BirthPicker, overlay or a year text field',()=>{
 const f=formFixture(),row=draft('child'),changes=[];
 try{
  f.render(f.form.ChildProfileCard,{row,ordinal:1,onChange:value=>changes.push(value),onRemove:()=>{},disabled:false});
  const inline=f.nodes().find(node=>node.type===f.inline.InlineChildDate);assert.ok(inline);assert.equal(inline.props.row,row);assert.equal(inline.props.disabled,false);
  assert.equal(f.form.BirthPicker,undefined);assert.equal(f.find('onboarding-date-overlay'),undefined);assert.equal(f.find('birth-picker-year-input'),undefined);
  assert.equal(f.find('onboarding-date-child'),undefined);assert.deepEqual(changes,[]);
  const dateOnly=formFixture();try{dateOnly.render(dateOnly.inline.InlineChildDate,{row,onChange:()=>{},disabled:false});assert.ok(dateOnly.find('onboarding-inline-date-child'));assert.ok(!dateOnly.nodes().some(node=>node.type==='NuriField'||node.type==='TextInput'||node.props?.accessibilityViewIsModal));}finally{dateOnly.unmount();}
 }finally{f.unmount();}
});
test('real inline columns retain year0001 and clamp already selected leap/month-end days without allowing year0 or future birthdays',()=>{
 const f=formFixture();let row=draft('child','2024-02-29');const changes=[],render=()=>f.render(f.inline.InlineChildDate,{row,onChange:next=>{changes.push(next);row=next;},disabled:false});
 const column=part=>f.nodes().find(node=>node.type===f.inline.InlineDateWheel&&node.props.part===part);
 try{
  render();assert.equal(column('year').props.values[0],1);assert.equal(column('year').props.values.at(-1),2026);assert.equal(column('year').props.values.includes(0),false);assert.equal(column('year').props.values.includes(2099),false);
  column('year').props.onSelect(1900);render();assert.equal(row.birth_date,'1900-02-28');
  column('year').props.onSelect(1);render();assert.equal(row.birth_date,'0001-02-28');assert.deepEqual(row.date_parts,{year:1,month:2,day:28});
  row={...row,birth_date:'2017-01-31',date_parts:{year:2017,month:1,day:31}};render();column('month').props.onSelect(4);render();assert.equal(row.birth_date,'2017-04-30');
  assert.ok(changes.every(value=>value.birth_date&&dates.parseDateOnly(value.birth_date)));
 }finally{f.unmount();}
});
test('real inline unborn columns begin at tomorrow without mount changes and obey the exact due-date range',()=>{
 const f=formFixture();let row=simplified.blankChildDraft('empty',true);const changes=[],render=()=>f.render(f.inline.InlineChildDate,{row,onChange:next=>{changes.push(next);row=next;},disabled:false});
 const column=part=>f.nodes().find(node=>node.type===f.inline.InlineDateWheel&&node.props.part===part);
 try{
  render();assert.deepEqual(changes,[]);assert.equal(row.birth_date,'2026-10-22');assert.deepEqual(column('year').props.values,[2026,2027]);
  column('year').props.onSelect(2027);render();assert.equal(row.birth_date,'2027-07-22');assert.deepEqual(row.date_parts,{year:2027,month:7,day:22});
  column('month').props.onSelect(1);render();assert.equal(row.birth_date,'2027-01-22');assert.deepEqual(row.date_parts,{year:2027,month:1,day:22});
  column('day').props.onSelect(1);render();assert.equal(row.birth_date,'2027-01-01');assert.equal(helper.validChildDraft({...row,nickname:'Due fixture'}),true);
  column('month').props.onSelect(7);render();assert.equal(column('day').props.values.at(-1),28,'October21 +280 calendar days is July28');
  column('day').props.onSelect(28);render();assert.equal(row.birth_date,'2027-07-28');
  column('year').props.onSelect(2026);render();assert.deepEqual(row.date_parts,{year:2026,month:10,day:28});assert.equal(column('day').props.values[0],22,'today itself cannot be an expected date');
 }finally{f.unmount();}
});

test('partial inline dates are not blank placeholders; category switches preserve them and review Back discards a detached partial edit',async()=>{
 const f=componentFixture();try{
  await ready(f);const key=f.cards()[0].props.row.key;
  f.change(key,{birth_date:'',date_parts:{year:2017,month:null,day:null}});f.press('onboarding-next-btn');
  assert.ok(f.find('onboarding-born'));assert.ok(f.find('onboarding-error'));assert.equal(f.find('onboarding-review'),undefined);
  f.press('onboarding-expecting');f.press('onboarding-born');assert.deepEqual(f.cards()[0].props.row.date_parts,{year:2017,month:null,day:null});
  f.change(key,{nickname:'Historical fixture'});f.date(key,'0001-02-28');f.press('onboarding-next-btn');edit(f,key);
  f.change(key,{birth_date:'',date_parts:{year:2024,month:2,day:null}});f.press('onboarding-next-btn');assert.equal(f.find('onboarding-next-btn').props.label,'Save');assert.ok(f.find('onboarding-error'));
  f.back();assert.equal(f.reviews()[0].props.row.birth_date,'0001-02-28');assert.deepEqual(f.reviews()[0].props.row.date_parts,{year:1,month:2,day:28});assert.deepEqual(f.calls.filter(call=>call[0]!=='GET'),[]);
 }finally{f.unmount();}
});

test('late inline card changes after account replacement or unmount cannot mutate a child or initiate a save',async()=>{
 for(const boundary of ['account','unmount']){
  const f=componentFixture();await ready(f);const editor=f.cards()[0],oldChange=editor.props.onChange,row=editor.props.row;
  if(boundary==='account')f.replaceOwner();else f.unmount();
  oldChange({...row,nickname:'Late private child',date_parts:{year:2017,month:1,day:18},birth_date:'2017-01-18'});f.render();
  assert.equal(f.cards()[0].props.row.birth_date,'2026-10-21');assert.equal(f.cards()[0].props.row.nickname,'');assert.deepEqual(f.calls.filter(call=>call[0]!=='GET'),[]);assert.deepEqual(f.routes,[]);f.unmount();
 }
});
test('review editing is a detached draft: Back/Skip cancel, Save changes only local review, Confirm persists it',async()=>{
 const kids=[{...draft('one'),id:'one',allergies:['fixture allergy'],notes:'fixture note'},{...draft('two','2017-02-01'),id:'two'}];const f=componentFixture({kids});await ready(f);f.press('onboarding-next-btn');
 edit(f,'one');f.change('one',{nickname:'Discard Back'});f.back();assert.equal(f.reviews()[0].props.row.nickname,'Fixture one');
 edit(f,'one');f.change('one',{nickname:'Discard Skip'});f.press('onboarding-skip');assert.equal(f.reviews()[0].props.row.nickname,'Fixture one');assert.deepEqual(f.profileCalls,[]);
 edit(f,'one');f.change('one',{nickname:'Edited fixture'});assert.equal(f.find('onboarding-next-btn').props.label,'Save');f.press('onboarding-next-btn');assert.equal(f.reviews()[0].props.row.nickname,'Edited fixture');assert.equal(f.reviews()[1].props.row.nickname,'Fixture two');assert.deepEqual(f.calls.filter(c=>c[0]!=='GET'),[]);
 f.press('onboarding-next-btn');await f.settle();const writes=f.calls.filter(c=>['PUT','POST'].includes(c[0]));assert.equal(writes.length,1);assert.equal(writes[0][0],'PUT');assert.equal(writes[0][1],'one');assert.deepEqual(writes[0][2].allergies,['fixture allergy']);assert.equal(writes[0][2].notes,'fixture note');assert.equal(f.rows.find(x=>x.id==='two').birth_date,'2017-02-01');
});
test('empty placeholders are omitted but partially completed or invalid cards cannot silently advance',async()=>{
 const f=componentFixture();await ready(f);f.change(f.cards()[0].props.row.key,{nickname:'Incomplete',birth_date:'',date_parts:{year:2020,month:null,day:1}});f.press('onboarding-next-btn');assert.ok(f.find('onboarding-born'));assert.ok(f.find('onboarding-error'));assert.equal(f.find('onboarding-review'),undefined);assert.deepEqual(f.calls.filter(c=>c[0]!=='GET'),[]);
 f.cards()[0].props.onRemove();f.render();f.press('onboarding-next-btn');assert.ok(f.find('onboarding-empty-review'));assert.deepEqual(f.profileCalls,[]);
 const g=componentFixture();await loaded(g);g.parent().props.onChange({nickname:' ',city:'',gender:'hidden'});g.render();g.press('onboarding-next-btn');assert.ok(g.parent());assert.ok(g.find('onboarding-error'));
});
test('a named new card can Continue with its displayed local default without touching any date column, and writes only at Confirm',async()=>{
 const f=componentFixture();try{await ready(f);const row=f.cards()[0].props.row;assert.equal(row.birth_date,'2026-10-21');assert.equal(simplified.isBlankChildDraft(row),true);
 f.change(row.key,{nickname:'Named default'});f.press('onboarding-next-btn');assert.equal(f.reviews()[0].props.row.birth_date,'2026-10-21');assert.equal('date_default'in f.reviews()[0].props.row,false);assert.deepEqual(f.calls.filter(c=>c[0]!=='GET'),[]);
 f.press('onboarding-next-btn');await f.settle();const writes=f.calls.filter(c=>c[0]==='POST');assert.equal(writes.length,1);assert.equal(writes[0][1].birth_date,'2026-10-21');assert.equal('date_default'in writes[0][1],false);assert.equal('date_parts'in writes[0][1],false);assert.deepEqual(f.routes,['/(tabs)']);}finally{f.unmount();}
});
test('profile failure after child creation retries only the profile, never another child POST',async()=>{
 const f=componentFixture();await ready(f);fillChild(f,'Fixture');f.press('onboarding-next-btn');f.setProfileFails(true);f.press('onboarding-next-btn');await f.settle();assert.deepEqual(f.routes,[]);assert.equal(f.localCompletion.length,0);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
 f.setProfileFails(false);f.press('onboarding-next-btn');await f.settle();assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);assert.deepEqual(f.routes,['/(tabs)']);
});
test('server completion and local guarded completion both must be confirmed before home',async()=>{
 const f=componentFixture();await ready(f);f.press('onboarding-next-btn');f.setProfileConfirmed(false);f.press('onboarding-next-btn');await f.settle();assert.deepEqual(f.localCompletion,[]);assert.deepEqual(f.routes,[]);
 f.setProfileConfirmed(true);f.setLocalConfirmed(false);f.press('onboarding-next-btn');await f.settle();assert.equal(f.localCompletion.length,1);assert.deepEqual(f.routes,[]);f.setLocalConfirmed(true);f.press('onboarding-next-btn');await f.settle();assert.deepEqual(f.routes,['/(tabs)']);
});
test('local gender failure is not accepted as a save and can be retried without a duplicate child',async()=>{
 const f=componentFixture();await loaded(f);f.parent().props.onChange({...f.parent().props.value,gender:'male'});f.render();f.press('onboarding-next-btn');fillChild(f,'Fixture');f.press('onboarding-next-btn');f.setGenderWriteFails(true);f.press('onboarding-next-btn');await f.settle();assert.deepEqual(f.profileCalls,[]);assert.deepEqual(f.routes,[]);assert.ok(f.find('onboarding-error'));
 f.setGenderWriteFails(false);f.press('onboarding-next-btn');await f.settle();assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);assert.deepEqual(f.routes,['/(tabs)']);
});
test('late child/profile/local results after account switch cannot complete another account',async()=>{
 for(const boundary of ['Create','Profile','Local']){const f=componentFixture();await ready(f);fillChild(f,'Fixture');f.press('onboarding-next-btn');let release;f['hold'+boundary](new Promise(r=>release=r));f.press('onboarding-next-btn');await tick();f.replaceOwner();release();await f.settle();assert.deepEqual(f.routes,[],boundary);if(boundary==='Create')assert.deepEqual(f.profileCalls,[]);if(boundary!=='Local')assert.deepEqual(f.localCompletion,[]);}
});
test('same-generation token rotation also blocks final profile/local completion',async()=>{
 const f=componentFixture();await ready(f);fillChild(f,'Fixture');f.press('onboarding-next-btn');let release;f.holdCreate(new Promise(r=>release=r));f.press('onboarding-next-btn');await tick();f.replaceToken();release();await f.settle();assert.deepEqual(f.profileCalls,[]);assert.deepEqual(f.localCompletion,[]);assert.deepEqual(f.routes,[]);
});
test('failed cloud/secure reads and invalid account identity block setup writes',async()=>{
 for(const options of [{loadFails:true},{genderReadFails:true},{accountId:''}]){const f=componentFixture(options);f.render();await f.settle();assert.equal(f.find('onboarding-next-btn').props.disabled,true);assert.equal(f.find('onboarding-skip').props.disabled,true);assert.ok(f.find('onboarding-reload'));f.find('onboarding-next-btn').props.onPress();f.find('onboarding-skip').props.onPress();await f.settle();assert.deepEqual(f.calls.filter(c=>c[0]!=='GET'),[]);assert.deepEqual(f.profileCalls,[]);assert.deepEqual(f.routes,[]);}
});
for(const locale of ['zh-CN','zh-TW','en'])test(locale+' route exposes accessible step-local navigation and no fake saved result',async()=>{
 const f=componentFixture({locale});await ready(f);assert.equal(f.find('onboarding-born').props.accessibilityRole,'tab');assert.equal(f.find('onboarding-born').props.accessibilityState.selected,true);assert.equal(f.find('onboarding-expecting').props.accessibilityState.selected,false);assert.equal(f.find('onboarding-skip').props.accessibilityRole,'button');assert.equal(f.find('onboarding-add-another').props.accessibilityRole,'button');assert.ok(f.kind('OnboardingPrompt')[0].props.label);assert.deepEqual(f.calls.filter(c=>c[0]!=='GET'),[]);assert.deepEqual(f.routes,[]);
});
test('unconfirmed save leaves review editing/local removal reachable without guessing a cloud deletion',async()=>{
 const f=componentFixture();await ready(f);const key=fillChild(f,'Fixture recovery',2017);f.press('onboarding-next-btn');f.failCreate=true;f.press('onboarding-next-btn');await f.settle();assert.deepEqual(f.routes,[]);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
 edit(f,key);assert.equal(f.cards()[0].props.disabled,false);f.change(key,{nickname:'Corrected draft'});f.press('onboarding-next-btn');edit(f,key);f.cards()[0].props.onRemove();f.render();assert.ok(f.find('onboarding-empty-review'));f.press('onboarding-next-btn');await f.settle();assert.deepEqual(f.routes,['/(tabs)']);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,0);assert.equal(f.rows.length,0,'no child success is fabricated');
});

test('read-only reconciliation attaches a delayed saved ID while preserving unsaved corrections and siblings',async()=>{
 const f=service(),row=draft('a');f.failCreate=true;
 await assert.rejects(f.run([row]),{code:'unconfirmed'});
 f.rows.push({...row,id:'delayed-child'}, {...draft('sibling'),id:'sibling'});
 const corrected={...row,nickname:'Corrected local name'};
 const rows=await helper.refreshOnboardingChildren([corrected],{api:f.api,progress:f.progress,owns:async()=>f.owner,onConfirmed:()=>{}});
 assert.equal(rows.length,2);assert.equal(rows[0].id,'delayed-child');assert.equal(rows[0].nickname,'Corrected local name');
 assert.equal(f.progress.pending,null);f.failCreate=false;await f.run(rows);
 assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);assert.equal(f.rows.find(c=>c.id==='delayed-child').nickname,'Corrected local name');
});

test('removed unknown draft cannot silently POST the same payload again',async()=>{
 const f=service();f.failCreate=true;await assert.rejects(f.run([draft('a')]),{code:'unconfirmed'});
 helper.removeOnboardingDraft('a',f.progress);assert.equal(f.progress.pending,null);
 f.failCreate=false;await assert.rejects(f.run([{...draft('a'),key:'new-key'}]),{code:'unconfirmed'});
 assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
 await f.run([{...draft('different'),nickname:'A different child'}]);assert.equal(f.rows.length,1);
});

test('legacy incomplete cloud child remains directly editable and explicit deletion requires confirmation, leaving siblings intact',async()=>{
 const f=componentFixture({kids:[{id:'broken',nickname:'Fixture incomplete',birth_date:null},{...draft('sibling'),id:'sibling'}]});
 await ready(f);const broken=()=>f.cards().find(n=>n.props.row.id==='broken');assert.equal(broken().props.row.nickname,'Fixture incomplete');assert.equal(broken().props.onDate,undefined);assert.equal(typeof broken().props.onChange,'function');
 broken().props.onRemove();f.render();
 assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,0,'opening confirmation is not deletion');
 const dialog=f.nodes().find(n=>n.type==='ConfirmDialog');assert.equal(dialog.props.visible,true);
 dialog.props.onCancel();f.render();assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,0);
 broken().props.onRemove();f.render();
 f.nodes().find(n=>n.type==='ConfirmDialog').props.onConfirm();await f.settle();
 assert.deepEqual(f.calls.filter(c=>c[0]==='DELETE'),[['DELETE','broken']]);
 assert.deepEqual(f.rows.map(c=>c.id),['sibling']);assert.deepEqual(f.cards().map(n=>n.props.row.id),['sibling']);
});

test('lost delete response is checked by known ID; failed deletion and stale owners retain honest state',async()=>{
 for(const mode of ['loseDeleteResponse','failDelete']){
  const f=service();f.rows=[{...draft('a'),id:'a'},{...draft('b'),id:'b'}];f[mode]=true;
  const options={api:f.api,progress:f.progress,owns:async()=>f.owner,onConfirmed:()=>{}};
  if(mode==='failDelete')await assert.rejects(helper.deleteOnboardingChild('a',options));
  else await helper.deleteOnboardingChild('a',options);
  assert.ok(f.rows.some(c=>c.id==='b'));assert.equal(f.rows.some(c=>c.id==='a'),mode==='failDelete');
  f.owner=false;const before=f.calls.length;await assert.rejects(helper.deleteOnboardingChild('b',options),{code:'stale'});assert.equal(f.calls.length,before);
 }
});

test('new refresh/delete callbacks use guarded 401 recovery and cannot operate after an account switch',async()=>{
 const f=componentFixture();await ready(f);fillChild(f,'Fixture',2017);
 f.press('onboarding-next-btn');f.failCreate=true;
 f.press('onboarding-next-btn');await f.settle();
 const client=f.deps['@/src/api'].api;
 client.listChildren=async()=>{throw{status:401};};
 f.find('onboarding-reconcile-children').props.onPress();await f.settle();
 assert.equal(f.recoveries.length,1);assert.equal(f.recoveries[0][0].status,401);
 const oldRefresh=f.find('onboarding-reconcile-children').props.onPress;f.replaceOwner();oldRefresh();await f.settle();assert.equal(f.recoveries.length,1);
 const g=componentFixture({kids:[{...draft('a'),id:'a'}]});await ready(g);
 g.deps['@/src/api'].api.deleteChild=async()=>{throw{status:401};};
 g.cards()[0].props.onRemove();g.render();g.nodes().find(n=>n.type==='ConfirmDialog').props.onConfirm();await g.settle();
 assert.equal(g.recoveries.length,1);assert.ok(g.cards().some(n=>n.props.row.id==='a'));assert.deepEqual(g.routes,[]);
});

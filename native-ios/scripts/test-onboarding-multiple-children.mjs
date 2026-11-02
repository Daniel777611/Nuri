import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
class FixtureDate extends Date {constructor(...args){super(...(args.length?args:[2026,9,21,12]));}}
function load(path,deps={},extra='') {
  const module={exports:{}};
  const baseline=process.env.NURI_ONBOARDING_BASELINE_REF;
  if(baseline&&!/^[0-9a-f]{40}$/.test(baseline))throw Error('An exact baseline commit is required');
  const source=baseline?execFileSync('git',['show',baseline+':native-ios/'+path],{encoding:'utf8'}):readFileSync(path,'utf8');
  new Function('require','module','exports','Date',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText+extra)(name=>{
  if(name.startsWith('@/assets/'))return 'fixture-image';
  assert.ok(name in deps,'unexpected dependency '+name);return deps[name];
 },module,module.exports,FixtureDate);return module.exports;
}
const dates=load('src/child-age.ts'),helper=load('src/onboardingChildren.ts',{'./child-age':dates});
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

function harness(){let cursor=0,tree;const slots=[],effects=[],pending=[];const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const state=initial=>{const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};slots[i].set??=value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;};return[slots[i].value,slots[i].set];};
 const react={useState:state,useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},useCallback:(fn,deps)=>{const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn;},useEffect:(fn,deps)=>{const i=cursor++;if(!same(effects[i]?.deps,deps))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});}};
 const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
 return{react,state,render(Component,props){cursor=0;tree=Component(props);pending.splice(0).forEach(fn=>fn());return tree;},find:id=>nodes(tree).find(n=>n.props?.testID===id),nodes:()=>nodes(tree)};
}
const jsx=(type,props)=>({type,props});
function componentFixture({kids=[],locale='en',loadFails=false}={}){
 const h=harness(),f=service(),routes=[];f.rows=structuredClone(kids);let owner=1,profileFails=false,createBarrier=null;
 const capture=()=>owner===1?1:null,current=ticket=>owner===ticket,t=(key,vars)=>key.replace(/\{(\w+)\}/g,(m,key)=>vars?.[key]??m);
 const recoveries=[],recover=async(...args)=>{recoveries.push(args);},router={setParams:()=>{},replace:route=>routes.push(route)},profileCalls=[],localCompletion=[];
 const add=f.api.addChild;f.api.addChild=async payload=>{if(createBarrier)await createBarrier;return add(payload);};
 const api={...f.api,me:async()=>{if(loadFails)throw Error('fixture read failed');return{nickname:'Fixture caregiver',parent_role:'mom'};},updateMe:async body=>{profileCalls.push(body);if(profileFails)throw Error('fixture profile failed');return body;}};
 const deps={react:h.react,'react/jsx-runtime':{jsx,jsxs:jsx},'@/src/useAccountState':{useAccountState:h.state,useAccountScope:()=>({capture,current})},
  'react-native':Object.assign(Object.fromEntries(['View','Text','Image','Pressable','TextInput','ActivityIndicator','KeyboardAvoidingView','ScrollView'].map(x=>[x,x])),{StyleSheet:{create:x=>x,absoluteFill:{}},Platform:{OS:'ios'},useWindowDimensions:()=>({width:390,height:844})}),
  'expo-router':{useRouter:()=>router,useFocusEffect:()=>{}},'@/src/components/nativeNavigation':{registerNativeNavigationGuard:()=>()=>{}},'@/src/components/NativeSafeAreaView':{},'@react-navigation/elements':{useHeaderHeight:()=>0},'expo-linear-gradient':{},'@expo/vector-icons':{},'expo-font':{useFonts:()=>[true]},'@expo-google-fonts/noto-sans-sc/400Regular':{},'@expo-google-fonts/noto-sans-sc/900Black':{},
  '@/src/api':{api,auth:{getToken:async()=>owner===1?'fixture-A':'fixture-B',setOnboarded:async(...args)=>{localCompletion.push(args);return true;}},isAuthError:e=>e?.status===401},
  '@/src/authExpiredRecovery':{useExpiredSessionRecovery:()=>({blocked:false,recover})},'@/src/i18n':{useT:()=>({t,locale}),translate:(_locale,text)=>text},'@/src/child-age':dates,'@/src/onboardingChildren':helper,
  '@/src/components/ConfirmDialog':{default:'ConfirmDialog',__esModule:true},
  '@/src/uiux48/Primitives':Object.fromEntries(['AuthFrame','ChoiceChip','GlassSurface','MenuRow','NuriField','NuriText','NuriButton'].map(x=>[x,x])),
  '@/src/uiux48/Theme':{useNuriTheme:()=>({night:false,composer:'fixture'})}};
 const loaded=load('app/onboarding.tsx',deps,'\nexports.Picker=BirthPicker;'),Component=loaded.default;
 return Object.assign(f,h,{deps,Picker:loaded.Picker,routes,profileCalls,localCompletion,recoveries,render:()=>h.render(Component),settle:async()=>{for(let i=0;i<5;i++)await tick();h.render(Component);},setProfileFails:value=>profileFails=value,replaceOwner:()=>{owner++;f.owner=false;},holdCreate:promise=>createBarrier=promise,
  date:(year,month,day)=>{h.find('onboarding-birth-picker').props.onPress();h.render(Component);h.nodes().find(n=>n.type===loaded.Picker).props.confirm(year,month,day);h.render(Component);}});
}
async function ready(f){f.render();await f.settle();f.find('onboarding-next-btn').props.onPress();f.render();}
test('date trigger is a single accessible button, not a readonly text input intercepting taps',async()=>{
 const f=componentFixture();await ready(f);const button=f.find('onboarding-birth-picker');
 assert.equal(button.props.accessibilityRole,'button');assert.equal(button.props.children.type,'NuriText');
 button.props.onPress();f.render();assert.ok(f.nodes().some(n=>n.type===f.Picker));
});
function fillChild(f,name,year){f.find('onboarding-child-name').props.onChangeText(name);f.render();f.date(year,5,6);}
test('actual onboarding: add two children older than 2018, review both, then write each once on explicit completion',async()=>{
 const f=componentFixture();await ready(f);assert.ok(f.find('onboarding-children-guide'));fillChild(f,'Older fixture child',2010);
 f.find('onboarding-add-another').props.onPress();f.render();assert.match(JSON.stringify(f.find('onboarding-editor-title')),/2/);
 fillChild(f,'Younger fixture child',2017);f.find('onboarding-next-btn').props.onPress();f.render();assert.match(JSON.stringify(f.find('onboarding-children-summary')),/2/);
 assert.deepEqual(f.calls.filter(x=>x[0]!=='GET'),[],'render, navigation and local draft additions do not write');
 f.find('onboarding-next-btn').props.onPress();f.find('onboarding-next-btn').props.onPress();await f.settle();
 assert.deepEqual(f.calls.filter(x=>x[0]==='POST').map(x=>x[1].birth_date),['2010-05-06','2017-05-06']);
 assert.equal(f.profileCalls.length,1);assert.equal(f.profileCalls[0].onboarding_completed,true);assert.equal(f.localCompletion.length,1);assert.deepEqual(f.routes,['/(tabs)']);
});
test('actual onboarding loads all existing children; editing one preserves its siblings and private fields',async()=>{
 const kids=[{...draft('one'),id:'one',allergies:['fixture allergy'],notes:'fixture note'},{...draft('two','2017-02-01'),id:'two'}];
 const f=componentFixture({kids});await ready(f);assert.ok(f.find('onboarding-child-row-one'));assert.ok(f.find('onboarding-child-row-two'));assert.equal(f.find('onboarding-child-name'),undefined);
 f.find('onboarding-child-row-one').props.onPress();f.render();f.find('onboarding-child-name').props.onChangeText('Edited fixture');f.render();f.find('onboarding-next-btn').props.onPress();f.render();f.find('onboarding-next-btn').props.onPress();await f.settle();
 const writes=f.calls.filter(x=>x[0]==='PUT'||x[0]==='POST');assert.equal(writes.length,1);assert.equal(writes[0][0],'PUT');assert.equal(writes[0][1],'one');assert.deepEqual(writes[0][2].allergies,['fixture allergy']);assert.equal(writes[0][2].notes,'fixture note');assert.equal(f.rows.find(x=>x.id==='two').birth_date,'2017-02-01');
});
test('profile failure after child creation retries only the profile; no repeated child POST',async()=>{
 const f=componentFixture();await ready(f);fillChild(f,'Fixture',2010);f.find('onboarding-next-btn').props.onPress();f.render();f.setProfileFails(true);f.find('onboarding-next-btn').props.onPress();await f.settle();
 assert.deepEqual(f.routes,[]);assert.equal(f.localCompletion.length,0);assert.equal(f.calls.filter(x=>x[0]==='POST').length,1);
 f.setProfileFails(false);f.find('onboarding-next-btn').props.onPress();await f.settle();assert.equal(f.calls.filter(x=>x[0]==='POST').length,1);assert.deepEqual(f.routes,['/(tabs)']);
});
test('late child result after account switch cannot complete another account onboarding',async()=>{
 const f=componentFixture();await ready(f);fillChild(f,'Fixture',2010);f.find('onboarding-next-btn').props.onPress();f.render();let release;f.holdCreate(new Promise(r=>release=r));f.find('onboarding-next-btn').props.onPress();await tick();f.replaceOwner();release();await f.settle();assert.equal(f.profileCalls.length,0);assert.equal(f.localCompletion.length,0);assert.deepEqual(f.routes,[]);
});
test('read failure blocks setup writes, and empty/invalid forms cannot create a child',async()=>{
 const f=componentFixture({loadFails:true});f.render();await f.settle();assert.equal(f.find('onboarding-next-btn').props.disabled,true);assert.ok(f.find('onboarding-reload'));f.find('onboarding-next-btn').props.onPress();await f.settle();assert.deepEqual(f.calls.filter(x=>x[0]!=='GET'),[]);
 const g=componentFixture();await ready(g);assert.equal(g.find('onboarding-next-btn').props.disabled,true);g.find('onboarding-next-btn').props.onPress();assert.deepEqual(g.calls.filter(x=>x[0]!=='GET'),[]);
});
test('calendar direct input reaches year0001 and older pages, clamps leap days and never confirms an impossible/future birthday',()=>{
 const f=componentFixture(),h=harness();f.deps.react=h.react;f.deps['@/src/useAccountState']={useAccountState:h.state};const Picker=load('app/onboarding.tsx',f.deps,'\nexports.Picker=BirthPicker;').Picker;
 const props={expecting:false,year:2024,month:2,day:29,close:()=>{},confirm:()=>{}};h.render(Picker,props);assert.ok(h.find('birth-picker-year-2010'));
 h.find('birth-picker-year-input').props.onChangeText('1900');h.render(Picker,props);assert.equal(h.find('birth-picker-selection').props.children,'1900-02-28');assert.equal(h.find('birth-picker-confirm').props.disabled,false);
 h.find('birth-picker-year-input').props.onChangeText('0001');h.render(Picker,props);assert.equal(h.find('birth-picker-selection').props.children,'0001-02-28');assert.equal(h.find('birth-picker-confirm').props.disabled,false);
 h.find('birth-picker-year-input').props.onChangeText('0000');h.render(Picker,props);assert.equal(h.find('birth-picker-confirm').props.disabled,true);
 h.find('birth-picker-year-input').props.onChangeText('2099');h.render(Picker,props);assert.equal(h.find('birth-picker-confirm').props.disabled,true);
});
for(const locale of ['zh-CN','zh-TW','en'])test(locale+' has explicit multi-child/year guidance, later management and no fake saved result',async()=>{
 const f=componentFixture({locale});await ready(f);const copy=helper.onboardingChildCopy(locale);assert.equal(f.find('onboarding-children-guide').props.children,copy.guide);assert.equal(f.find('onboarding-manage-children-later').props.children,copy.manageLater);assert.ok(copy.earlierYears&&copy.year);assert.deepEqual(f.calls.filter(x=>x[0]!=='GET'),[]);
});

test('unconfirmed save leaves the actual child editor and local removal reachable',async()=>{
 const f=componentFixture();await ready(f);fillChild(f,'Fixture recovery',2017);
 f.find('onboarding-next-btn').props.onPress();f.render();f.failCreate=true;
 f.find('onboarding-next-btn').props.onPress();await f.settle();
 assert.deepEqual(f.routes,[]);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
 f.find('onboarding-review-children').props.onPress();f.render();
 const row=f.find('onboarding-child-row-new-1');assert.equal(row.props.disabled,false);
 assert.equal(f.find('onboarding-remove-draft-new-1').props.disabled,false);
 row.props.onPress();f.render();assert.equal(f.find('onboarding-child-name').props.value,'Fixture recovery');
 f.find('onboarding-child-name').props.onChangeText('Corrected draft');f.render();
 f.find('onboarding-next-btn').props.onPress();f.render();
 f.find('onboarding-review-children').props.onPress();f.render();
 f.find('onboarding-remove-draft-new-1').props.onPress();f.render();
 assert.equal(f.find('onboarding-child-row-new-1'),undefined);
 assert.equal(f.find('onboarding-next-btn').props.disabled,false);
 f.find('onboarding-next-btn').props.onPress();f.render();
 f.find('onboarding-next-btn').props.onPress();await f.settle();
 assert.deepEqual(f.routes,['/(tabs)']);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
 assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,0,'unknown local draft removal never guesses a cloud deletion');
});

test('a pending child can be explicitly deferred while onboarding completion is confirmed on the server',async()=>{
 const f=componentFixture();await ready(f);fillChild(f,'Fixture deferred',2017);
 f.find('onboarding-next-btn').props.onPress();f.render();f.failCreate=true;
 f.find('onboarding-next-btn').props.onPress();await f.settle();
 assert.ok(f.find('onboarding-reconcile-children'));assert.equal(f.find('onboarding-defer-children').props.disabled,false);
 f.find('onboarding-defer-children').props.onPress();await f.settle();
 assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
 assert.deepEqual(f.routes,['/(tabs)']);assert.equal(f.profileCalls[0].onboarding_completed,true);
 assert.equal(f.localCompletion.length,1);assert.equal(f.rows.length,0,'no child success is fabricated');
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

test('legacy incomplete cloud child remains editable and explicit deletion requires confirmation, leaving siblings intact',async()=>{
 const f=componentFixture({kids:[{id:'broken',nickname:'Fixture incomplete',birth_date:null},{...draft('sibling'),id:'sibling'}]});
 await ready(f);assert.ok(f.find('onboarding-child-row-broken'));
 f.find('onboarding-child-row-broken').props.onPress();f.render();
 assert.equal(f.find('onboarding-child-name').props.value,'Fixture incomplete');assert.ok(f.find('onboarding-birth-picker'));
 f.find('onboarding-delete-child-broken').props.onPress();f.render();
 assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,0,'opening confirmation is not deletion');
 const dialog=f.nodes().find(n=>n.type==='ConfirmDialog');assert.equal(dialog.props.visible,true);
 dialog.props.onCancel();f.render();assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,0);
 f.find('onboarding-delete-child-broken').props.onPress();f.render();
 f.nodes().find(n=>n.type==='ConfirmDialog').props.onConfirm();await f.settle();
 assert.deepEqual(f.calls.filter(c=>c[0]==='DELETE'),[['DELETE','broken']]);
 assert.deepEqual(f.rows.map(c=>c.id),['sibling']);assert.ok(f.find('onboarding-child-row-sibling'));
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
 f.find('onboarding-next-btn').props.onPress();f.render();f.failCreate=true;
 f.find('onboarding-next-btn').props.onPress();await f.settle();
 const client=f.deps['@/src/api'].api;
 client.listChildren=async()=>{throw{status:401};};
 f.find('onboarding-reconcile-children').props.onPress();await f.settle();
 assert.equal(f.recoveries.length,1);assert.equal(f.recoveries[0][0].status,401);
 const oldRefresh=f.find('onboarding-reconcile-children').props.onPress;f.replaceOwner();oldRefresh();await f.settle();assert.equal(f.recoveries.length,1);
 const g=componentFixture({kids:[{...draft('a'),id:'a'}]});await ready(g);
 g.deps['@/src/api'].api.deleteChild=async()=>{throw{status:401};};
 g.find('onboarding-delete-child-a').props.onPress();g.render();g.nodes().find(n=>n.type==='ConfirmDialog').props.onConfirm();await g.settle();
 assert.equal(g.recoveries.length,1);assert.ok(g.find('onboarding-child-row-a'));assert.deepEqual(g.routes,[]);
});

import { useCallback, useRef } from "react";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, auth } from "@/src/api";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { useT, translate } from "@/src/i18n";
import { AuthFrame, MenuRow, NuriButton, NuriField, NuriText } from "@/src/uiux48/Primitives";
import { StateCard } from "@/src/uiux48/StateCard";
import { readChatDraft, writeChatDraft } from "@/src/uiux48/chatDraft";
import { assignFavoriteCollection, removeSavedFavorite, validCollectionName } from "@/src/collectionActions";

export default function SavedDetail() {
  const {id,uiState}=useLocalSearchParams<{id:string;uiState?:string}>();
  const router=useRouter();const {locale}=useT();const en=locale==="en";
  const {capture,current}=useAccountScope();
  const [item,setItem]=useAccountState<any>(null);
  const [collections,setCollections]=useAccountState<any[]>([]);
  const [loaded,setLoaded]=useAccountState(false);
  const [error,setError]=useAccountState("");const [busy,setBusy]=useAccountState(false);
  const [name,setName]=useAccountState("");const [creating,setCreating]=useAccountState(false);
  const [saved,setSaved]=useAccountState(false);const [selected,setSelected]=useAccountState<string|null>(null);
  const pending=useRef(false);
  const load=useCallback(async()=>{
    const ticket=capture();if(ticket===null)return;setLoaded(false);setError("");
    try{const token=await auth.getToken();if(!token||!current(ticket))return;
      const [items,groups]=await Promise.all([api.listFavorites(),api.listCollections()]);
      if(!current(ticket)||await auth.getToken()!==token)return;
      setItem(items.find((f:any)=>f.id===id)??null);setCollections(groups);setLoaded(true);
    }catch{if(current(ticket))setError(en?"Saved content could not be loaded. No empty result is assumed.":translate(locale, "收藏内容未能读取，不能将它视为空。"));}
  },[id,en,capture,current,setLoaded,setError,setItem,setCollections]);
  useFocusEffect(useCallback(()=>{void load();},[load]));
  const mutate=async(work:(isCurrent:()=>boolean)=>Promise<unknown>,done:()=>void)=>{
    const ticket=capture();if(ticket===null||pending.current||!item||!loaded)return;
    pending.current=true;setBusy(true);setError("");
    try{await work(()=>current(ticket));if(current(ticket))done();}catch{if(current(ticket))setError(en?"The change was not confirmed. Check the current saved content before trying again.":translate(locale, "此次修改未确认成功，请先核对当前收藏再操作。"));}
    finally{pending.current=false;if(current(ticket))setBusy(false);}
  };
  const back=()=>router.replace({pathname:"/(tabs)/profile",params:{section:"favorites"}} as never);
  const discuss=()=>{const ticket=capture();if(ticket===null)return;void mutate(async()=>{
    const session=await api.startSession({card_id:item.id});
    if(!current(ticket)||!session?.id)return;
    if(!readChatDraft(session.id).trim())writeChatDraft(session.id,item.title,ticket);
    router.push(`/chat/${session.id}`);
  },()=>{});};
  const saveCollection=()=>{if(selected)void mutate(isCurrent=>assignFavoriteCollection(item.id,selected,api,isCurrent),()=>setSaved(true));};
  const createCollection=()=>{const normalized=validCollectionName(name);if(normalized)void mutate(()=>api.createCollection(normalized),()=>{setName("");setCreating(false);void load();});};
  if(saved)return <StateCard testID="saved-content-result" message={en?"Changes saved.":translate(locale, "修改已保存。")} primary={{label:en?"Done":translate(locale, "完成"),onPress:()=>{setSaved(false);router.setParams({uiState:"detail"});void load();}}} />;
  if(!loaded||!item)return <StateCard testID="saved-content-load" message={error||(!loaded?(en?"Loading…":translate(locale, "正在读取…")):(en?"This item is no longer in your saved content.":translate(locale, "这项内容已不在你的收藏中。")))} primary={{label:en?"Back to saved content":translate(locale, "返回收藏"),onPress:back}} secondary={{label:en?"Retry":translate(locale, "重试"),onPress:()=>void load()}} />;
  if(uiState==="choose")return <AuthFrame testID="collection-choose-card" contentGap={24}>
    <NuriText style={{fontSize:20,lineHeight:26,fontWeight:"500"}}>{en?"Choose a collection":translate(locale, "选择收藏分类")}</NuriText>
    {collections.map(c=><MenuRow key={c.id} label={c.name} detail={selected===c.id?(en?"Selected":translate(locale, "已选择")):undefined} disabled={busy} onPress={()=>setSelected(c.id)} testID={`choose-collection-${c.id}`} />)}
    {!collections.length?<NuriText secondary>{en?"No collections yet. Create one below.":translate(locale, "还没有分类，可以在下面新建。")}</NuriText>:null}
    <MenuRow label={en?"New collection":translate(locale, "新建分类")} onPress={()=>setCreating(true)} disabled={busy} testID="collection-choose-new" />
    {creating?<><NuriField label={en?"Collection name":translate(locale, "分类名称")} value={name} onChangeText={setName} editable={!busy} testID="collection-new-name" /><NuriText secondary style={{fontSize:12,lineHeight:16}} testID="collection-name-limit">{en?"Collection names can contain up to 20 characters.":translate(locale, "分类名称最多 20 个字符。")}</NuriText><NuriButton secondary label={en?"Create collection":translate(locale, "创建分类")} disabled={busy||!validCollectionName(name)} onPress={createCollection} testID="collection-create" /></>:null}
    {error?<NuriText accessibilityLiveRegion="assertive">{error}</NuriText>:null}
    <NuriButton label={en?"Done":translate(locale, "完成")} busy={busy} disabled={!selected||busy} onPress={saveCollection} testID="collection-choose-save" />
    <NuriButton secondary label={en?"Cancel":translate(locale, "取消")} disabled={busy} onPress={()=>router.setParams({uiState:"detail"})} />
  </AuthFrame>;
  return <AuthFrame testID="saved-detail-card" contentGap={24}>
    <NuriText style={{fontSize:20,lineHeight:26,fontWeight:"500"}}>{item.title}</NuriText>
    <NuriText style={{fontSize:16,lineHeight:22}}>{item.summary||item.description||item.core_idea||item.body||""}</NuriText>
    <MenuRow label={en?"Put in a collection":translate(locale, "放入收藏分类")} onPress={()=>router.setParams({uiState:"choose"})} testID="saved-detail-choose" />
    {error?<NuriText accessibilityLiveRegion="assertive">{error}</NuriText>:null}
    <NuriButton label={en?"Talk with Nuri":translate(locale, "和 Nuri 聊聊")} disabled={busy} onPress={discuss} testID="saved-detail-chat" />
    <NuriButton secondary label={en?"Remove from saved":translate(locale, "取消收藏")} disabled={busy} busy={busy} onPress={()=>void mutate(isCurrent=>removeSavedFavorite(item.id,api,isCurrent),back)} testID="saved-detail-remove" />
  </AuthFrame>;
}

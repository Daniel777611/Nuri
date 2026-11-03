import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { useT } from "@/src/i18n";
import { requestGuardedNativeNavigation } from "@/src/components/nativeNavigation";
import { NuriIcon } from "@/src/uiux48/Primitives";
import { userInitial, userPhotoURL } from "./avatar";
export function UserAvatar({ displayName, photoURL, size = 32 }: {
    displayName?: string;
    photoURL?: string | null;
    size?: number;
}) {
    const {locale}=useT();
    const uri = userPhotoURL(photoURL);
    const [loaded, setLoaded] = useState<string | null>(null);
    const initial = userInitial(displayName);
    return <View style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden", backgroundColor: "#735C84", alignItems: "center", justifyContent: "center" }} testID="user-avatar">
    {initial ? <Text style={{ color: "white", fontSize: size === 32 ? 18 : 24, lineHeight: size === 32 ? 26 : 32, fontWeight: "500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined }}>{initial}</Text> : <NuriIcon name="person"/>}
    {uri ? <Image key={uri} source={{ uri }} onLoad={() => setLoaded(uri)} onError={() => setLoaded(null)} contentFit="cover" style={[StyleSheet.absoluteFill, { opacity: loaded === uri ? 1 : 0 }]} accessibilityIgnoresInvertColors/> : null}
  </View>;
}
/** Read-only identity refresh. Session tickets prevent stale A → B photos. */
export function CurrentUserAvatarAction({ path, displayName, photoURL, testID }: {
    path: string;
    displayName?: string;
    photoURL?: string | null;
    testID?: string;
}) {
    const scope = useAccountScope();
    const router = useRouter();
    const { locale } = useT();
    const [identity, setIdentity] = useAccountState<{
        name: string;
        photo: string | null;
    }>({ name: "", photo: null });
    const { capture, current } = scope;
    useFocusEffect(useCallback(() => {
        if (displayName !== undefined)
            return;
        const ticket = capture();
        if (ticket === null)
            return;
        let active = true;
        void api.me().then(me => { if (active && current(ticket))
            setIdentity({ name: me.nickname ?? "", photo: userPhotoURL(me.avatar_url ?? me.photo_url ?? me.picture) }); }).catch(() => { });
        return () => { active = false; };
    }, [capture, current, displayName, setIdentity]));
    return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={locale === "en" ? "Open settings" : locale === "zh-TW" ? "開啟設定" : "打开设置"} onPress={() => { if (!requestGuardedNativeNavigation(path, "profile"))
        router.push("/(tabs)/profile"); }} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
    <UserAvatar displayName={displayName ?? identity.name} photoURL={displayName !== undefined ? photoURL : identity.photo}/>
  </Pressable>;
}

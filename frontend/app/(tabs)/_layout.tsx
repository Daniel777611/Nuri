import { Stack } from "expo-router";

// 全产品无底部导航栏：所有跳转通过主页模块卡片和按钮触发
export default function MainLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
